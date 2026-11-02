import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { makeSearchable, needsOcr, type SearchableResult } from "./ocr";
import { closeSource, loadSource, type PdfSource } from "./source";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Make a scanned PDF searchable with OCR: invisible text laid over each scanned page. */
export class OcrTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private scans = 0;
  private result: SearchableResult | null = null;
  private goBtn: HTMLButtonElement;
  private input: HTMLInputElement;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "ocr-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-name></span>
        </div>
        <div class="tb-group tb-right">
          <button type="button" class="btn primary" data-go></button>
        </div>
      </header>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Make searchable</h1>
          <p class="tool-sub">Turn scanned pages into text you can select, search and copy (OCR). Reads English, right on this device.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.scan}
            <span><strong>Choose a scanned PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="tool-body wide" data-body hidden>
          <div class="cmp-card ocr-card">
            <p class="ocr-headline" data-headline></p>
            <p class="cmp-note" data-note></p>
          </div>
          <pre class="text-out" data-output hidden tabindex="0" aria-label="Text that was read"></pre>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.input = q<HTMLInputElement>("input[type=file]");
    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => {
      if (this.result) this.download();
      else void this.read();
    });
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `Make ${this.src.name} searchable - HackerPDF` : "Make searchable - HackerPDF";
  }

  close(): void {
    this.active = false;
    this.reset();
  }

  pick(): void {
    this.input.click();
  }

  async load(file: File): Promise<void> {
    if (!isPdf(file)) {
      toast("That file isn't a PDF.", "Choose a file that ends in .pdf.");
      return;
    }
    showBusy(`Opening ${file.name}`);
    let src: PdfSource | null;
    let scans = 0;
    try {
      src = await loadSource(file);
      if (src) for (let i = 0; i < src.sizes.length; i++) if (await needsOcr(src.doc, i)) scans += 1;
    } catch {
      showBusy(null);
      toast("This PDF couldn't be opened.", "The file may be damaged or not really a PDF.");
      return;
    }
    showBusy(null);
    if (!src) return;
    if (!this.active) {
      closeSource(src);
      return;
    }
    this.reset();
    this.src = src;
    this.scans = scans;
    document.title = `Make ${src.name} searchable - HackerPDF`;
    this.sync();
  }

  download(): void {
    if (!this.src || !this.result) return;
    const name = `${baseName(this.src.name)}-searchable.pdf`;
    saveFile(new Blob([this.result.bytes as BlobPart], { type: "application/pdf" }), name);
    toast(`Downloaded ${name}`, "Its text can now be selected, searched and copied. Metadata removed.");
  }

  // ------------------------------------------------------------- internals

  private async read(): Promise<void> {
    const src = this.src;
    if (!src || !this.scans) return;
    try {
      const res = await makeSearchable(src, (t) => showBusy(t));
      if (this.src !== src) return;
      this.result = res;
    } catch (err) {
      console.error(err);
      toast("The pages couldn't be read.", "Try again. If it keeps failing, the file may be damaged.");
    } finally {
      showBusy(null);
    }
    this.sync();
  }

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.scans = 0;
    this.result = null;
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    const res = this.result;
    q("[data-empty]").hidden = src !== null;
    q("[data-body]").hidden = src === null;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "Make searchable";
    nameEl.title = src?.name ?? "";

    const total = src?.sizes.length ?? 0;
    let headline = "";
    let note = "";
    if (src && res) {
      headline = `Read ${plural(res.read, "page")}.`;
      const conf = Math.round(res.confidence);
      note = `The recognizer was ${conf}% confident on average${conf < 80 ? ", so expect some mistakes (a sharper scan helps)" : ""}. ${
        res.skipped
          ? `${plural(res.skipped, "page")} already had text and ${res.skipped === 1 ? "was" : "were"} left as is. `
          : ""
      }The pages look exactly the same; the text sits invisibly on top.`;
    } else if (src && this.scans) {
      headline =
        this.scans === total
          ? `${plural(total, "page")} to read.`
          : `${this.scans} of ${total} pages are scans and need reading.`;
      note = `The others already have text and are left as they are. Reading takes a few seconds a page.`;
    } else if (src) {
      headline = "This PDF already has text on every page.";
      note =
        "There's nothing to read: its text can already be selected and searched. To get the text out, use PDF to text.";
    }
    q("[data-headline]").textContent = headline;
    q("[data-note]").textContent = note;
    const out = q("[data-output]");
    out.hidden = !res;
    out.textContent = res
      ? res.text
          .map((t, i) => (t ? `--- Page ${i + 1} ---\n\n${t}` : ""))
          .filter(Boolean)
          .join("\n\n")
      : "";

    if (res) {
      this.goBtn.innerHTML = `${icons.download}<span>Download<span class="lbl"> PDF</span></span>`;
      this.goBtn.disabled = false;
      this.goBtn.title = "Download (Ctrl S)";
    } else {
      this.goBtn.innerHTML = `${icons.scan}<span>Read ${this.scans > 1 ? `${this.scans} pages` : "page"}</span>`;
      this.goBtn.disabled = !src || !this.scans;
      this.goBtn.title = !src ? "Choose a PDF first" : this.scans ? "Run OCR" : "Nothing to read";
    }
  }
}
