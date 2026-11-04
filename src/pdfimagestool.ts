import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { fileRow, plural, uniqueNames, type Row } from "./rows";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";
import { zip, type ZipEntry } from "./zip";

type Format = "png" | "jpeg";
type Resolution = 96 | 150 | 300;

interface Entry {
  src: PdfSource;
  row: Row;
}

/** Biggest canvas side and area browsers reliably allow. */
const MAX_SIDE = 12000;
const MAX_AREA = 60_000_000;

/** Save each page of one or more PDFs as a PNG or JPEG. */
export class PdfImagesTool {
  readonly root: HTMLElement;
  private entries: Entry[] = [];
  private selected: Entry | null = null;
  private format: Format = "png";
  private dpi: Resolution = 150;
  private list: HTMLOListElement;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private preview: HTMLElement;
  private thumbs: Thumbs;
  private pageThumbs: Thumbs;
  private loading: Promise<void> = Promise.resolve();
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "pdfimages-tool";
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
        <div class="seg" role="radiogroup" aria-label="Format">
          <button type="button" role="radio" data-format="png" title="Sharp text and lines; bigger files">PNG</button>
          <button type="button" role="radio" data-format="jpeg" title="Smaller files; best for photos and scans">JPG</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="Resolution">
          <button type="button" role="radio" data-dpi="96" title="96 dpi: for screens, email and chat">Screen</button>
          <button type="button" role="radio" data-dpi="150" title="150 dpi: a good all-rounder">Standard</button>
          <button type="button" role="radio" data-dpi="300" title="300 dpi: for printing">Print</button>
        </div>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body wide">
          <h1 class="tool-title">PDF to images</h1>
          <p class="tool-sub" data-sub></p>
          <ol class="file-list" data-list aria-label="PDFs"></ol>
          <button type="button" class="drop-card" data-add>
            ${icons.images}
            <span><strong data-add-label></strong><small>or drop them anywhere on this page</small></span>
          </button>
          <section class="doc-preview" data-preview aria-label="Pages" hidden></section>
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
    this.preview = q("[data-preview]");
    this.thumbs = new Thumbs(this.scroller, { w: 44, h: 56 });
    this.pageThumbs = new Thumbs(this.scroller, { w: 150, h: 194 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    this.addBtn.addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.root.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((b) =>
      b.addEventListener("click", () => {
        this.format = b.dataset.format as Format;
        this.sync();
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>("[data-dpi]").forEach((b) =>
      b.addEventListener("click", () => {
        this.dpi = Number(b.dataset.dpi) as Resolution;
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
    document.title = "PDF to images - HackerPDF";
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
    this.preview.replaceChildren();
    this.sync();
  }

  pick(): void {
    this.input.click();
  }

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
      try {
        const src = await loadSource(file);
        if (!src) continue;
        if (!this.active) {
          closeSource(src);
          break;
        }
        const entry: Entry = {
          src,
          row: fileRow({
            name: file.name,
            meta: plural(src.doc.numPages, "page"),
            actions: [{ icon: icons.download, label: "Download this one's pages", run: () => void this.save([entry]) }],
            onSelect: () => this.select(entry),
            onRemove: () => this.remove(entry),
          }),
        };
        entry.row.thumb.append(this.thumbs.sheet(src, 0));
        this.entries.push(entry);
        this.list.append(entry.row.li);
        if (!this.selected) {
          this.selected = entry;
          this.renderPreview();
        }
      } catch (err) {
        console.error(err);
        failed.push(file.name);
      }
    }
    showBusy(null);
    this.sync();
    if (failed.length) {
      toast(
        failed.length === 1 ? `${failed[0]} couldn't be opened.` : `${failed.length} PDFs couldn't be opened.`,
        "The file may be damaged or not really a PDF.",
      );
    } else if (skipped) {
      toast(`Skipped ${plural(skipped, "file")} that ${skipped === 1 ? "isn't a PDF" : "aren't PDFs"}.`);
    }
  }

  download(): Promise<void> {
    return this.save(this.entries);
  }

  // ------------------------------------------------------------- internals

  private ext(): string {
    return this.format === "png" ? "png" : "jpg";
  }

  /** Every page of these files: one image on its own, otherwise a ZIP (a folder per PDF when there are several). */
  private async save(entries: Entry[]): Promise<void> {
    if (!entries.length) return;
    const total = entries.reduce((n, e) => n + e.src.doc.numPages, 0);
    if (total === 1) return this.saveOne(entries[0], 0);
    const folders = uniqueNames(entries.map((e) => baseName(e.src.name)));
    const files: ZipEntry[] = [];
    let done = 0;
    try {
      for (const [k, e] of entries.entries()) {
        const n = e.src.doc.numPages;
        const width = String(n).length;
        for (let i = 0; i < n; i++) {
          showBusy(`Drawing page ${++done} of ${total}`);
          const blob = await this.render(e.src, i);
          const name = `${baseName(e.src.name)}-page-${String(i + 1).padStart(Math.max(2, width), "0")}.${this.ext()}`;
          files.push({
            name: entries.length > 1 ? `${folders[k]}/${name}` : name,
            data: new Uint8Array(await blob.arrayBuffer()),
          });
        }
      }
      const zipName = entries.length === 1 ? `${baseName(entries[0].src.name)} images.zip` : "PDF images.zip";
      saveFile(zip(files), zipName);
      toast(`Downloaded ${zipName}`, `${plural(files.length, "image")} at ${this.dpi} dpi.`);
    } catch (err) {
      console.error(err);
      toast(
        "The images couldn't be made.",
        "The PDF may be damaged, or a page too big to draw. Try a lower resolution.",
      );
    } finally {
      showBusy(null);
    }
  }

  private async saveOne(e: Entry, index: number): Promise<void> {
    const n = e.src.doc.numPages;
    const name =
      n === 1
        ? `${baseName(e.src.name)}.${this.ext()}`
        : `${baseName(e.src.name)}-page-${String(index + 1).padStart(Math.max(2, String(n).length), "0")}.${this.ext()}`;
    showBusy(`Drawing page ${index + 1}`);
    try {
      saveFile(await this.render(e.src, index), name);
      toast(`Downloaded ${name}`, `At ${this.dpi} dpi.`);
    } catch (err) {
      console.error(err);
      toast("The image couldn't be made.", "The page may be too big to draw. Try a lower resolution.");
    } finally {
      showBusy(null);
    }
  }

  private async render(src: PdfSource, index: number): Promise<Blob> {
    const page = await src.doc.getPage(index + 1);
    try {
      const base = page.getViewport({ scale: 1 });
      let scale = this.dpi / 72;
      scale = Math.min(
        scale,
        MAX_SIDE / base.width,
        MAX_SIDE / base.height,
        Math.sqrt(MAX_AREA / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, `image/${this.format}`, 0.9));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Couldn't encode the page");
      return blob;
    } finally {
      page.cleanup();
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
    closeSource(e.src);
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
    this.preview.hidden = !e;
    if (!e) return;
    const head = document.createElement("p");
    head.className = "preview-head";
    head.textContent =
      this.entries.length > 1
        ? `${e.src.name}: click a page to download just that one`
        : "Click a page to download just that one";
    const grid = document.createElement("div");
    grid.className = "page-grid";
    for (let i = 0; i < e.src.doc.numPages; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "page-pick";
      b.title = `Download page ${i + 1} as an image`;
      b.setAttribute("aria-label", `Download page ${i + 1} as an image`);
      const label = document.createElement("span");
      label.textContent = String(i + 1);
      b.append(this.pageThumbs.sheet(e.src, i), label);
      b.addEventListener("click", () => void this.saveOne(e, i));
      grid.append(b);
    }
    this.preview.append(head, grid);
  }

  private sync(): void {
    const n = this.entries.length;
    const pages = this.entries.reduce((s, e) => s + e.src.doc.numPages, 0);
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    q("[data-summary]").textContent = n === 0 ? "PDF to images" : n === 1 ? this.entries[0].src.name : plural(n, "PDF");
    q("[data-sub]").textContent =
      n === 0
        ? "Save every page of a PDF as a PNG or JPG. Add one PDF, or a whole batch."
        : "Each page becomes its own image. Pick a format and resolution, then download.";
    q("[data-add-label]").textContent = n ? "Add more PDFs" : "Choose PDFs";
    q("[data-opts]").hidden = n === 0;
    q("[data-status]").textContent = n ? plural(pages, "image") : "";
    q("[data-go-label]").textContent = pages === 1 ? ` .${this.ext()}` : " all (.zip)";
    this.root.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.format === this.format));
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-dpi]").forEach((b) => {
      b.setAttribute("aria-checked", String(Number(b.dataset.dpi) === this.dpi));
    });
    for (const e of this.entries) e.row.setSelected(e === this.selected && n > 1);
    this.addBtn.classList.toggle("lg", n === 0);
    this.goBtn.disabled = n === 0;
    this.goBtn.title = n === 0 ? "Add a PDF first" : "Download (Ctrl S)";
  }
}
