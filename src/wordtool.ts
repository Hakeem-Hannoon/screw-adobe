import type { DocxBlock, DocxModel } from "./docx";
import type { Run } from "./extract";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { analyze, editableDocx, ocrScanned, pictureDocx, wordModel, type Analysis, type Summary } from "./pdf2word";
import { fileRow, plural, uniqueNames, type Row } from "./rows";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";
import { zip } from "./zip";

type Layout = "editable" | "exact";

interface Entry {
  src: PdfSource;
  analysis: Analysis;
  row: Row;
}

/** Turn PDFs into Word documents, one or many at a time. */
export class WordTool {
  readonly root: HTMLElement;
  private entries: Entry[] = [];
  private selected: Entry | null = null;
  private layout: Layout = "editable";
  private list: HTMLOListElement;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private breaks: HTMLInputElement;
  private preview: HTMLElement;
  private notice: HTMLElement;
  private thumbs: Thumbs;
  private pageThumbs: Thumbs;
  private urls: string[] = [];
  private loading: Promise<void> = Promise.resolve();
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "word-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-summary></span>
        </div>
        <div class="tb-group tb-right">
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl" data-go-label></span></span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <div class="seg" role="radiogroup" aria-label="Layout">
          <button type="button" role="radio" data-layout="editable" title="Text you can edit, with headings, lists, tables and pictures">Editable</button>
          <button type="button" role="radio" data-layout="exact" title="Each page as a picture: looks exactly the same, but can't be edited">Exact look</button>
        </div>
        <label class="check inline" data-breaks-opt title="Start each PDF page on a new page in Word">
          <input type="checkbox" data-breaks />
          <span><strong>Keep page breaks</strong></span>
        </label>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body wide">
          <h1 class="tool-title">PDF to Word</h1>
          <p class="tool-sub" data-sub></p>
          <ol class="file-list" data-list aria-label="PDFs to convert"></ol>
          <button type="button" class="drop-card" data-add>
            ${icons.fileText}
            <span><strong data-add-label></strong><small>or drop them anywhere on this page</small></span>
          </button>
          <p class="notice" data-notice hidden></p>
          <section class="doc-preview" data-preview aria-label="Preview" hidden></section>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" multiple hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.list = q<HTMLOListElement>("[data-list]");
    this.scroller = q("[data-scroller]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.addBtn = q<HTMLButtonElement>("[data-add]");
    this.breaks = q<HTMLInputElement>("[data-breaks]");
    this.preview = q("[data-preview]");
    this.notice = q("[data-notice]");
    this.thumbs = new Thumbs(this.scroller, { w: 44, h: 56 });
    this.pageThumbs = new Thumbs(this.scroller, { w: 150, h: 194 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    this.addBtn.addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.breaks.addEventListener("change", () => this.render());
    this.root.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((b) =>
      b.addEventListener("click", () => {
        this.layout = b.dataset.layout as Layout;
        this.render();
      }),
    );
    this.input.addEventListener("change", () => {
      const files = Array.from(this.input.files ?? []);
      this.input.value = "";
      if (files.length) void this.add(files);
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = "PDF to Word - HackerPDF";
    this.sync();
  }

  close(): void {
    this.active = false;
    for (const e of this.entries) closeSource(e.src);
    this.entries = [];
    this.selected = null;
    this.thumbs.clear();
    this.pageThumbs.clear();
    this.list.replaceChildren();
    this.clearPreview();
    this.render();
  }

  pick(): void {
    this.input.click();
  }

  /** Same as add(): this tool takes any number of files. */
  load(file: File): Promise<void> {
    return this.add([file]);
  }

  add(files: File[]): Promise<void> {
    this.loading = this.loading.then(() => this.read(files));
    return this.loading;
  }

  private async read(files: File[]): Promise<void> {
    const pdfs = files.filter(isPdf);
    const skipped = files.length - pdfs.length;
    const failed: string[] = [];
    for (const file of pdfs) {
      if (!this.active) break;
      showBusy(`Opening ${file.name}`);
      let src: PdfSource | null = null;
      try {
        src = await loadSource(file, { fontNames: true });
        if (!src) continue;
        const s = src;
        const analysis = await analyze(s, (done, total) => showBusy(`Reading ${file.name}: page ${done} of ${total}`));
        if (!this.active) {
          closeSource(s);
          break;
        }
        const entry: Entry = {
          src: s,
          analysis,
          row: fileRow({
            name: file.name,
            meta: "",
            actions: [{ icon: icons.download, label: "Download this one", run: () => void this.downloadOne(entry) }],
            onSelect: () => this.select(entry),
            onRemove: () => this.remove(entry),
          }),
        };
        entry.row.thumb.append(this.thumbs.sheet(s, 0));
        this.entries.push(entry);
        this.list.append(entry.row.li);
        if (!this.selected) this.selected = entry;
      } catch (err) {
        console.error(err);
        if (src) closeSource(src);
        failed.push(file.name);
      }
    }
    showBusy(null);
    this.render();
    if (failed.length) {
      toast(
        failed.length === 1 ? `${failed[0]} couldn't be opened.` : `${failed.length} PDFs couldn't be opened.`,
        "The file may be damaged or not really a PDF.",
      );
    } else if (skipped) {
      toast(`Skipped ${plural(skipped, "file")} that ${skipped === 1 ? "isn't a PDF" : "aren't PDFs"}.`);
    }
  }

  async download(): Promise<void> {
    const entries = [...this.entries];
    if (!entries.length) return;
    if (entries.length === 1) return this.downloadOne(entries[0]);
    try {
      const files = [];
      for (const [i, e] of entries.entries()) {
        showBusy(`Making ${i + 1} of ${entries.length}: ${e.src.name}`);
        files.push({ name: `${baseName(e.src.name)}.docx`, blob: await this.build(e) });
      }
      showBusy("Packing the ZIP");
      const names = uniqueNames(files.map((f) => f.name));
      const entriesZip = await Promise.all(
        files.map(async (f, i) => ({ name: names[i], data: new Uint8Array(await f.blob.arrayBuffer()) })),
      );
      const name = "Word documents.zip";
      saveFile(zip(entriesZip), name);
      toast(`Downloaded ${name}`, `${plural(files.length, "Word document")}.`);
    } catch (err) {
      console.error(err);
      toast("The Word documents couldn't be made.", "One of the PDFs may be damaged. Try removing it.");
    } finally {
      showBusy(null);
    }
  }

  // ------------------------------------------------------------- internals

  private async downloadOne(e: Entry): Promise<void> {
    const name = `${baseName(e.src.name)}.docx`;
    showBusy(`Making ${name}`);
    try {
      saveFile(await this.build(e), name);
      toast(
        `Downloaded ${name}`,
        this.layout === "exact"
          ? `${plural(e.src.doc.numPages, "page")}, each a picture of the PDF page.`
          : "Headings, lists, tables and pictures are rebuilt as real Word ones. Give it a quick look over.",
      );
    } catch (err) {
      console.error(err);
      toast("The Word document couldn't be made.", "The PDF may be damaged.");
    } finally {
      showBusy(null);
    }
  }

  private build(e: Entry): Promise<Blob> {
    if (this.layout === "exact") {
      return pictureDocx(e.src, (done, total) => showBusy(`Drawing ${e.src.name}: page ${done} of ${total}`));
    }
    return Promise.resolve(editableDocx(e.src, e.analysis, { keepBreaks: this.breaks.checked }));
  }

  private select(e: Entry): void {
    this.selected = e;
    this.render();
  }

  private remove(e: Entry): void {
    const i = this.entries.indexOf(e);
    this.entries.splice(i, 1);
    e.row.li.querySelectorAll<HTMLElement>(".thumb-sheet").forEach((el) => this.thumbs.forget(el));
    e.row.li.remove();
    closeSource(e.src);
    if (this.selected === e) this.selected = this.entries[Math.min(i, this.entries.length - 1)] ?? null;
    this.render();
    (
      this.entries[Math.min(i, this.entries.length - 1)]?.row.li.querySelector<HTMLElement>("[aria-label^='Remove']") ??
      this.addBtn
    ).focus();
  }

  private async runOcr(): Promise<void> {
    try {
      for (const e of this.entries) {
        if (e.analysis.scanned.length > e.analysis.ocred.length) {
          await ocrScanned(e.src, e.analysis, (t) => showBusy(`${e.src.name}: ${t}`));
        }
      }
    } catch (err) {
      console.error(err);
      toast("The scanned pages couldn't be read.", "Try again. If it keeps failing, the file may be damaged.");
    } finally {
      showBusy(null);
    }
    this.render();
  }

  private render(): void {
    for (const e of this.entries) {
      const { summary } = wordModel(e.src, e.analysis, { keepBreaks: this.breaks.checked });
      e.row.setMeta(this.layout === "exact" ? plural(summary.pages, "page") : describe(summary, e.analysis));
      e.row.setSelected(e === this.selected && this.entries.length > 1);
    }

    // Scanned pages: offer OCR, or say how it went.
    const unread = this.entries.reduce((n, e) => n + e.analysis.scanned.length - e.analysis.ocred.length, 0);
    const read = this.entries.reduce((n, e) => n + e.analysis.ocred.length, 0);
    this.notice.replaceChildren();
    if (unread && this.layout === "editable") {
      this.notice.append(
        `${plural(unread, "page")} ${unread === 1 ? "is a scan" : "are scans"}, so ${unread === 1 ? "it comes" : "they come"} out as ${unread === 1 ? "a picture" : "pictures"}. OCR can turn ${unread === 1 ? "it" : "them"} into text you can edit.`,
      );
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn notice-btn";
      b.innerHTML = `${icons.scan}<span>Read with OCR</span>`;
      b.addEventListener("click", () => void this.runOcr());
      this.notice.append(b);
    } else if (read && this.layout === "editable") {
      this.notice.append(
        `${plural(read, "scanned page")} read with OCR. Check names and numbers before relying on them.`,
      );
    }
    this.notice.hidden = !this.notice.firstChild;

    this.renderPreview();
    this.sync();
  }

  private clearPreview(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.preview.querySelectorAll<HTMLElement>(".thumb-sheet").forEach((el) => this.pageThumbs.forget(el));
    this.preview.replaceChildren();
  }

  private renderPreview(): void {
    this.clearPreview();
    const e = this.selected;
    this.preview.hidden = !e;
    if (!e) return;
    const head = document.createElement("p");
    head.className = "preview-head";
    head.textContent = this.entries.length > 1 ? `Preview: ${e.src.name}` : "Preview";
    this.preview.append(head);

    if (this.layout === "exact") {
      const grid = document.createElement("div");
      grid.className = "page-grid";
      for (let i = 0; i < e.src.doc.numPages; i++) grid.append(this.pageThumbs.sheet(e.src, i));
      this.preview.append(grid);
      return;
    }
    const { model } = wordModel(e.src, e.analysis, { keepBreaks: this.breaks.checked });
    this.preview.append(this.paper(model));
  }

  /** The Word document's content, drawn roughly as Word would show it. */
  private paper(model: DocxModel): HTMLElement {
    const paper = document.createElement("article");
    paper.className = "doc-paper";
    paper.style.setProperty("--body", `${model.body}px`);
    const band = (lines: DocxModel["header"], cls: string) => {
      if (!lines.length) return;
      const el = document.createElement("div");
      el.className = cls;
      for (const l of lines) {
        const p = document.createElement("p");
        p.style.textAlign = l.align;
        p.textContent = l.text.replace(/#/g, "1");
        el.append(p);
      }
      paper.append(el);
    };
    band(model.header, "doc-band");

    let list = null as HTMLElement | null;
    for (const b of model.blocks) {
      if (b.kind !== "li") {
        list = null;
        paper.append(this.block(b));
        continue;
      }
      const tag = b.number === null ? "UL" : "OL";
      if (list?.tagName !== tag) {
        list = document.createElement(tag.toLowerCase());
        if (b.number !== null && b.number !== 1) list.setAttribute("start", String(b.number));
        paper.append(list);
      }
      const li = document.createElement("li");
      li.append(...runs(b.runs));
      list.append(li);
    }
    band(model.footer, "doc-band foot");
    return paper;
  }

  private block(b: Exclude<DocxBlock, { kind: "li" }>): HTMLElement {
    switch (b.kind) {
      case "h": {
        const h = document.createElement(`h${b.level + 1}`);
        h.textContent = b.text;
        return h;
      }
      case "p": {
        const p = document.createElement("p");
        p.append(...runs(b.runs));
        return p;
      }
      case "table": {
        const table = document.createElement("table");
        for (const row of b.rows) {
          const tr = table.insertRow();
          for (const c of row) tr.insertCell().textContent = c;
        }
        return table;
      }
      case "img": {
        const fig = document.createElement("figure");
        const img = document.createElement("img");
        const url = URL.createObjectURL(new Blob([b.image.data as BlobPart], { type: `image/${b.image.type}` }));
        this.urls.push(url);
        img.src = url;
        img.alt = "";
        img.style.width = `min(100%, ${Math.round(b.image.w)}px)`;
        fig.append(img);
        return fig;
      }
      case "break": {
        const hr = document.createElement("hr");
        hr.className = "page-break";
        hr.title = "Page break";
        return hr;
      }
    }
  }

  private sync(): void {
    const n = this.entries.length;
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const pages = this.entries.reduce((s, e) => s + e.src.doc.numPages, 0);
    q("[data-summary]").textContent = n === 0 ? "PDF to Word" : n === 1 ? this.entries[0].src.name : plural(n, "PDF");
    q("[data-sub]").textContent =
      n === 0
        ? "Turn PDFs into Word documents you can edit. Add one, or a whole batch."
        : this.layout === "exact"
          ? "Each page becomes a picture of itself: it looks exactly the same, but nothing can be edited."
          : "Headings, paragraphs, lists, tables and pictures are rebuilt as real Word ones, so the text reflows as you edit.";
    q("[data-add-label]").textContent = n ? "Add more PDFs" : "Choose PDFs";
    q("[data-opts]").hidden = n === 0;
    q("[data-breaks-opt]").hidden = this.layout === "exact";
    q("[data-status]").textContent = n ? `${plural(n, "file")} · ${plural(pages, "page")}` : "";
    q("[data-go-label]").textContent = n > 1 ? " all (.zip)" : " .docx";
    this.root.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.layout === this.layout));
    });
    this.addBtn.classList.toggle("lg", n === 0);
    this.goBtn.disabled = n === 0;
    this.goBtn.title = n === 0 ? "Add a PDF first" : "Download (Ctrl S)";
    this.list.classList.toggle("single", n === 1);
  }
}

function describe(s: Summary, a: Analysis): string {
  const parts = [plural(s.pages, "page")];
  if (s.headings) parts.push(plural(s.headings, "heading"));
  if (s.tables) parts.push(plural(s.tables, "table"));
  if (s.pictures) parts.push(plural(s.pictures, "picture"));
  if (s.header || s.footer) parts.push(s.header && s.footer ? "header and footer" : s.header ? "header" : "footer");
  const unread = a.scanned.length - a.ocred.length;
  if (unread === s.pages) return `${plural(s.pages, "page")} · scanned, no text`;
  if (unread) parts.push(`${unread} scanned`);
  return parts.join(" · ");
}

/** Runs as inline elements: bold, italic, and line breaks. */
function runs(list: Run[]): Node[] {
  const out: Node[] = [];
  for (const r of list) {
    r.text.split("\n").forEach((part, i) => {
      if (i > 0) out.push(document.createElement("br"));
      if (!part) return;
      let node: Node = document.createTextNode(part);
      if (r.italic) {
        const em = document.createElement("em");
        em.append(node);
        node = em;
      }
      if (r.bold) {
        const strong = document.createElement("strong");
        strong.append(node);
        node = strong;
      }
      out.push(node);
    });
  }
  return out;
}
