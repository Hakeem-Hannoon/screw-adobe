import { buildPdfs } from "./combine";
import { renderPdf } from "./docrender";
import { documentKind, layOut, unsupportedReason, UnsupportedFile, type Kind, type Paper } from "./docsource";
import { handoffButton, type HandoffTarget } from "./handoff";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { fileRow, plural, uniqueNames, type Row } from "./rows";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { saveFile, showBusy, toast } from "./ui";
import { zip } from "./zip";

interface Entry {
  file: File;
  kind: Kind;
  /** The PDF made from it, opened for previews. Null while converting or if it failed. */
  src: PdfSource | null;
  bytes: Uint8Array | null;
  notes: string[];
  row: Row;
}

/** Word, Markdown and text files to PDF: one or a batch, with a way to keep working on the result. */
export class ToPdfTool {
  readonly root: HTMLElement;
  private entries: Entry[] = [];
  private selected: Entry | null = null;
  private paper: Paper = "letter";
  private list: HTMLOListElement;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private combine: HTMLInputElement;
  private preview: HTMLElement;
  private thumbs: Thumbs;
  private pageThumbs: Thumbs;
  private queue: Promise<void> = Promise.resolve();
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "topdf-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-summary></span>
        </div>
        <div class="tb-group tb-right" data-actions>
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl" data-go-label></span></span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <label class="check inline" data-combine-opt title="Put every file into one PDF, in this order">
          <input type="checkbox" data-combine />
          <span><strong>Combine into one PDF</strong></span>
        </label>
        <div class="seg" role="radiogroup" aria-label="Page size for Markdown and text files" data-paper-opt>
          <button type="button" role="radio" data-paper="letter">Letter</button>
          <button type="button" role="radio" data-paper="a4">A4</button>
        </div>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body wide">
          <h1 class="tool-title">Word to PDF</h1>
          <p class="tool-sub" data-sub></p>
          <ol class="file-list" data-list aria-label="Files to turn into PDFs"></ol>
          <button type="button" class="drop-card" data-add>
            ${icons.toPdf}
            <span><strong data-add-label></strong><small>or drop them anywhere on this page</small></span>
          </button>
          <section class="doc-preview" data-preview aria-label="Preview" hidden></section>
        </div>
      </div>
      <input type="file" accept=".docx,.docm,.dotx,.md,.markdown,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" multiple hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.list = q<HTMLOListElement>("[data-list]");
    this.scroller = q("[data-scroller]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.addBtn = q<HTMLButtonElement>("[data-add]");
    this.combine = q<HTMLInputElement>("[data-combine]");
    this.preview = q("[data-preview]");
    this.thumbs = new Thumbs(this.scroller, { w: 44, h: 56 });
    this.pageThumbs = new Thumbs(this.scroller, { w: 150, h: 194 });

    // Keep working on the result without downloading it.
    q("[data-actions]").prepend(
      handoffButton({
        label: "Continue with",
        count: () => (this.combine.checked ? 1 : this.ready().length),
        pick: (t) => void this.handoff(t, this.ready()),
      }),
    );

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    this.addBtn.addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.combine.addEventListener("change", () => this.sync());
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this.paper === b.dataset.paper) return;
        this.paper = b.dataset.paper as Paper;
        // Word files carry their own page size; only Markdown and text change.
        for (const e of this.entries) if (e.kind !== "docx") this.convert(e);
        this.sync();
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
    document.title = "Word to PDF - HackerPDF";
    this.sync();
  }

  close(): void {
    this.active = false;
    for (const e of this.entries) if (e.src) closeSource(e.src);
    this.entries = [];
    this.selected = null;
    this.thumbs.clear();
    this.pageThumbs.clear();
    this.list.replaceChildren();
    this.preview.replaceChildren();
    this.combine.checked = false;
    this.sync();
  }

  pick(): void {
    this.input.click();
  }

  load(file: File): Promise<void> {
    return this.add([file]);
  }

  async add(files: File[]): Promise<void> {
    const rejected: File[] = [];
    for (const file of files) {
      const kind = documentKind(file);
      if (!kind) {
        rejected.push(file);
        continue;
      }
      const entry: Entry = {
        file,
        kind,
        src: null,
        bytes: null,
        notes: [],
        row: fileRow({
          name: file.name,
          meta: "Waiting",
          actions: [{ icon: icons.download, label: "Download this one", run: () => void this.downloadOne(entry) }],
          onSelect: () => this.select(entry),
          onRemove: () => this.remove(entry),
        }),
      };
      entry.row.slot.prepend(
        handoffButton({
          label: "Continue with this one",
          compact: true,
          count: () => 1,
          pick: (t) => void this.handoff(t, [entry]),
        }),
      );
      this.entries.push(entry);
      this.list.append(entry.row.li);
      this.selected ??= entry;
      this.convert(entry);
    }
    this.sync();
    if (rejected.length) {
      toast(
        rejected.length === 1
          ? `${rejected[0].name} can't be turned into a PDF here.`
          : `Skipped ${plural(rejected.length, "file")}.`,
        unsupportedReason(rejected[0]),
      );
    }
    await this.queue;
  }

  async download(): Promise<void> {
    const ready = this.ready();
    if (!ready.length) return;
    await this.queue;
    try {
      if (ready.length === 1) return this.downloadOne(ready[0]);
      if (this.combine.checked) {
        const file = await this.combined(ready);
        saveFile(file, file.name);
        toast(`Downloaded ${file.name}`, `${plural(ready.length, "file")} in one PDF.`);
        return;
      }
      const names = uniqueNames(ready.map((e) => pdfName(e.file.name)));
      saveFile(zip(ready.map((e, i) => ({ name: names[i], data: e.bytes! }))), "PDFs.zip");
      toast("Downloaded PDFs.zip", `${plural(ready.length, "PDF")}.`);
    } catch (err) {
      console.error(err);
      toast("The PDFs couldn't be saved.", "Try again.");
    } finally {
      showBusy(null);
    }
  }

  // ------------------------------------------------------------- internals

  private ready(): Entry[] {
    return this.entries.filter((e) => e.bytes && e.src);
  }

  /** Convert in the background, one file at a time, in the order they were added. */
  private convert(e: Entry): void {
    e.row.setMeta("Waiting");
    this.queue = this.queue.then(async () => {
      if (!this.entries.includes(e) || !this.active) return;
      e.row.setMeta("Making the PDF");
      showBusy(`Making ${pdfName(e.file.name)}`);
      try {
        const laid = await layOut(e.file, e.kind, this.paper);
        let result;
        try {
          result = await renderPdf(laid, (n) => showBusy(`Making ${pdfName(e.file.name)}: page ${n}`));
        } finally {
          laid.dispose();
        }
        if (!this.entries.includes(e)) return;
        const src = await loadSource(
          new File([result.bytes as BlobPart], pdfName(e.file.name), { type: "application/pdf" }),
        );
        if (!src) throw new Error("Couldn't open the result");
        if (e.src) {
          e.row.thumb.querySelectorAll<HTMLElement>(".thumb-sheet").forEach((el) => this.thumbs.forget(el));
          closeSource(e.src);
        }
        e.src = src;
        e.bytes = result.bytes;
        e.notes = [];
        if (result.missing) {
          e.notes.push(
            `${plural(result.missing, "character")} left out (only Latin, Greek and Cyrillic text and common symbols can be drawn)`,
          );
        }
        if (result.skippedImages)
          e.notes.push(`${plural(result.skippedImages, "picture")} left out (format not supported)`);
        e.row.thumb.replaceChildren(this.thumbs.sheet(src, 0));
        e.row.setMeta([plural(result.pages, "page"), ...e.notes].join(" · "));
      } catch (err) {
        console.error(err);
        e.row.setMeta(
          err instanceof UnsupportedFile ? err.message : "Couldn't be converted. The file may be damaged.",
          true,
        );
      } finally {
        showBusy(null);
      }
      if (e === this.selected) this.renderPreview();
      this.sync();
    });
  }

  private async downloadOne(e: Entry): Promise<void> {
    await this.queue;
    if (!e.bytes) return;
    const name = pdfName(e.file.name);
    saveFile(new Blob([e.bytes as BlobPart], { type: "application/pdf" }), name);
    toast(
      `Downloaded ${name}`,
      e.notes.length
        ? e.notes.join(". ") + "."
        : `${plural(e.src?.doc.numPages ?? 0, "page")}, with text you can select and search.`,
    );
  }

  private async combined(list: Entry[]): Promise<File> {
    showBusy("Combining");
    const [out] = await buildPdfs([list.flatMap((e) => e.src!.sizes.map((_, index) => ({ src: e.src!, index })))]);
    const name = list.length === 1 ? pdfName(list[0].file.name) : "Combined.pdf";
    return new File([out.bytes as BlobPart], name, { type: "application/pdf" });
  }

  private async handoff(target: HandoffTarget, list: Entry[]): Promise<void> {
    await this.queue;
    list = list.filter((e) => e.bytes);
    if (!list.length) return;
    try {
      const files =
        this.combine.checked && list.length > 1
          ? [await this.combined(list)]
          : list.map((e) => new File([e.bytes as BlobPart], pdfName(e.file.name), { type: "application/pdf" }));
      showBusy(null);
      this.host.openIn(target, files);
    } catch (err) {
      console.error(err);
      showBusy(null);
      toast("The PDF couldn't be opened there.", "Try downloading it instead.");
    }
  }

  private select(e: Entry): void {
    this.selected = e;
    this.renderPreview();
    this.sync();
  }

  private remove(e: Entry): void {
    const i = this.entries.indexOf(e);
    this.entries.splice(i, 1);
    e.row.li.querySelectorAll<HTMLElement>(".thumb-sheet").forEach((el) => this.thumbs.forget(el));
    e.row.li.remove();
    if (e.src) closeSource(e.src);
    if (this.selected === e) {
      this.selected = this.entries[Math.min(i, this.entries.length - 1)] ?? null;
      this.renderPreview();
    }
    this.sync();
    (
      this.entries[Math.min(i, this.entries.length - 1)]?.row.li.querySelector<HTMLElement>("[aria-label^='Remove']") ??
      this.addBtn
    ).focus();
  }

  private renderPreview(): void {
    this.preview.querySelectorAll<HTMLElement>(".thumb-sheet").forEach((el) => this.pageThumbs.forget(el));
    this.preview.replaceChildren();
    const e = this.selected;
    this.preview.hidden = !e?.src;
    if (!e?.src) return;
    const head = document.createElement("p");
    head.className = "preview-head";
    head.textContent = this.entries.length > 1 ? `Preview: ${pdfName(e.file.name)}` : "Preview";
    const grid = document.createElement("div");
    grid.className = "page-grid";
    for (let i = 0; i < e.src.doc.numPages; i++) grid.append(this.pageThumbs.sheet(e.src, i));
    this.preview.append(head, grid);
  }

  private sync(): void {
    const n = this.entries.length;
    const ready = this.ready().length;
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    q("[data-summary]").textContent = n === 0 ? "Word to PDF" : n === 1 ? this.entries[0].file.name : plural(n, "file");
    q("[data-sub]").textContent =
      n === 0
        ? "Turn Word documents into PDFs, one or a whole batch. Markdown and text files work too."
        : "Laid out as in Word, with text you can select and search. Keep going in another tool, or download.";
    q("[data-add-label]").textContent = n ? "Add more files" : "Choose Word files";
    q("[data-opts]").hidden = n === 0;
    q("[data-combine-opt]").hidden = n < 2;
    q("[data-paper-opt]").hidden = !this.entries.some((e) => e.kind !== "docx");
    const pages = this.ready().reduce((s, e) => s + (e.src?.doc.numPages ?? 0), 0);
    q("[data-status]").textContent = ready ? `${plural(ready, "PDF")} · ${plural(pages, "page")}` : "";
    q("[data-go-label]").textContent = ready > 1 ? (this.combine.checked ? " combined PDF" : " all (.zip)") : " PDF";
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.paper === this.paper));
    });
    for (const e of this.entries) e.row.setSelected(e === this.selected && n > 1);
    this.root.querySelector<HTMLElement>(".handoff")!.hidden = ready === 0;
    this.addBtn.classList.toggle("lg", n === 0);
    this.goBtn.disabled = ready === 0;
    this.goBtn.title = ready === 0 ? "Add a file first" : "Download (Ctrl S)";
  }
}

const pdfName = (name: string) =>
  `${name.replace(/\.(docx|docm|dotx|md|markdown|mdown|mkd|txt|text|log|csv)$/i, "").trim() || "document"}.pdf`;
