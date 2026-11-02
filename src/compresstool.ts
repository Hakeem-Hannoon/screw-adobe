import { compressPdf, compressToSize, countImages, LEVELS, type CompressResult, type LevelName } from "./compress";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { openPdf, pageSizes } from "./pdf";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

type Mode = LevelName | "target";

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Make a PDF smaller by re-compressing its photos, with a before/after look at page 1. */
export class CompressTool {
  readonly root: HTMLElement;
  private file: File | null = null;
  private bytes: Uint8Array | null = null;
  private src: PdfSource | null = null;
  private out: PdfSource | null = null;
  private result: (CompressResult & { fits?: boolean }) | null = null;
  private images = 0;
  private mode: Mode = "strong";
  private run = 0;
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private target: HTMLInputElement;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "compress-tool";
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
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl"> PDF</span></span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <div class="seg" role="radiogroup" aria-label="How much to compress">
          <button type="button" role="radio" data-mode="light" title="Photos stay sharp; smaller savings">Light</button>
          <button type="button" role="radio" data-mode="strong" title="Good balance for sharing and uploads">Strong</button>
          <button type="button" role="radio" data-mode="smallest" title="Smallest file; photos get softer">Smallest</button>
          <button type="button" role="radio" data-mode="target" title="Pick the lightest setting that fits under a size">Fit a size</button>
        </div>
        <div class="every" data-target-row hidden>
          <label for="cmp-target">Under</label>
          <input id="cmp-target" type="number" min="0.1" step="0.1" value="2" inputmode="decimal" data-target />
          <span>MB</span>
          <button type="button" class="btn" data-target-go>Apply</button>
        </div>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Compress</h1>
          <p class="tool-sub">Make a PDF smaller by shrinking the photos and scans inside it. Text stays sharp and selectable.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.compress}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="tool-body wide" data-result hidden>
          <div class="cmp-card">
            <div class="cmp-size"><small>Before</small><strong data-before></strong></div>
            <span class="cmp-arrow" aria-hidden="true">${icons.arrow}</span>
            <div class="cmp-size"><small>After</small><strong data-after></strong></div>
            <p class="cmp-note" data-note></p>
          </div>
          <div class="cmp-previews" data-previews></div>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.target = q<HTMLInputElement>("[data-target]");
    const small = window.matchMedia("(max-width: 520px)").matches;
    this.thumbs = new Thumbs(this.scroller, small ? { w: 165, h: 220 } : { w: 380, h: 500 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => this.download());
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        const mode = b.dataset.mode as Mode;
        if (mode === this.mode) return;
        this.mode = mode;
        this.sync();
        if (mode === "target") this.target.focus();
        void this.compress();
      }),
    );
    q("[data-target-go]").addEventListener("click", () => void this.compress());
    this.target.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.compress();
      }
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
    document.title = this.file ? `Compress ${this.file.name} - HackerPDF` : "Compress - HackerPDF";
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    let images: number;
    try {
      images = await countImages(bytes);
    } catch (err) {
      showBusy(null);
      if (/encrypt/i.test(String(err))) {
        toast("Password-protected PDFs can't be compressed.", "Remove the password first, then try again.");
      } else {
        toast("This PDF couldn't be opened.", "The file may be damaged or not really a PDF.");
      }
      return;
    }
    let src: PdfSource | null;
    try {
      src = await loadSource(file);
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
    this.file = file;
    this.bytes = bytes;
    this.src = src;
    this.images = images;
    document.title = `Compress ${file.name} - HackerPDF`;
    this.sync();
    await this.compress();
  }

  download(): void {
    if (!this.file || !this.result || this.goBtn.disabled) return;
    const name = `${baseName(this.file.name)}-compressed.pdf`;
    saveFile(new Blob([this.result.bytes as BlobPart], { type: "application/pdf" }), name);
    toast(
      `Downloaded ${name}`,
      `${formatSize(this.result.bytes.length)}, down from ${formatSize(this.bytes!.length)}.`,
    );
  }

  // ------------------------------------------------------------- internals

  private async compress(): Promise<void> {
    const bytes = this.bytes;
    if (!bytes) return;
    const run = ++this.run;
    this.result = null;
    this.sync();
    let result: CompressResult & { fits?: boolean };
    try {
      if (this.mode === "target") {
        const mb = Number(this.target.value);
        if (!Number.isFinite(mb) || mb <= 0) {
          toast("Enter a size in MB, like 2.");
          return;
        }
        result = await compressToSize(bytes, mb * 1024 * 1024, (step, steps) =>
          showBusy(`Trying setting ${step} of ${steps}`),
        );
      } else {
        result = await compressPdf(bytes, LEVELS[this.mode], (done, total) =>
          showBusy(`Compressing image ${done} of ${total}`),
        );
      }
    } catch (err) {
      console.error(err);
      if (run === this.run) toast("This PDF couldn't be compressed.", "The file may be damaged.");
      return;
    } finally {
      if (run === this.run) showBusy(null);
    }
    if (run !== this.run || !this.active) return;
    this.result = result;
    await this.showPreview();
    this.sync();
  }

  /** Page 1, before and after, side by side. */
  private async showPreview(): Promise<void> {
    const box = this.root.querySelector<HTMLElement>("[data-previews]")!;
    this.thumbs.clear();
    if (this.out) closeSource(this.out);
    this.out = null;
    box.replaceChildren();
    if (!this.src || !this.result) return;
    const changed = this.result.bytes !== this.bytes;
    if (changed) {
      const { doc } = await openPdf(this.result.bytes, async () => null);
      this.out = { id: "compressed", name: "compressed", bytes: this.result.bytes, doc, sizes: await pageSizes(doc) };
    }
    const fig = (src: PdfSource, label: string) => {
      const f = document.createElement("figure");
      f.className = "np-fig";
      f.append(this.thumbs.sheet(src, 0));
      const cap = document.createElement("figcaption");
      cap.textContent = label;
      f.append(cap);
      return f;
    };
    box.append(fig(this.src, "Before, page 1"));
    if (this.out) box.append(fig(this.out, "After, page 1"));
  }

  private reset(): void {
    this.run += 1;
    if (this.src) closeSource(this.src);
    if (this.out) closeSource(this.out);
    this.src = this.out = null;
    this.file = null;
    this.bytes = null;
    this.result = null;
    this.thumbs.clear();
    this.root.querySelector("[data-previews]")!.replaceChildren();
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const file = this.file;
    q("[data-empty]").hidden = file !== null;
    q("[data-result]").hidden = file === null;
    q("[data-opts]").hidden = file === null;
    q("[data-target-row]").hidden = this.mode !== "target";
    const nameEl = q("[data-name]");
    nameEl.textContent = file ? file.name : "Compress";
    nameEl.title = file?.name ?? "";
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.mode === this.mode));
    });

    const before = this.bytes?.length ?? 0;
    const res = this.result;
    const smaller = !!res && res.bytes !== this.bytes;
    q("[data-before]").textContent = before ? formatSize(before) : "";
    q("[data-after]").textContent = res ? formatSize(res.bytes.length) : "…";
    const pct = smaller ? Math.round((1 - res.bytes.length / before) * 100) : 0;
    q("[data-status]").textContent = smaller ? `${pct}% smaller` : "";

    let note = "";
    if (!res) note = "";
    else if (!smaller && this.images === 0)
      note = "There are no photos or scans in this PDF to shrink, and it's already stored compactly.";
    else if (!smaller) note = "This PDF is already about as small as this setting can make it. Try a stronger one.";
    else {
      note =
        res.images === 0
          ? `${pct}% smaller, from packing the file more tightly. There are no photos in it to shrink.`
          : `${pct}% smaller. ${res.changed} of ${res.images} ${res.images === 1 ? "image" : "images"} shrunk; text, fonts, links and form fields are untouched.`;
      if (res.fits === false)
        note = `Couldn't get it under ${this.target.value} MB; this is the smallest it goes. ${note}`;
      if (res.fits === true) note = `Fits under ${this.target.value} MB. ${note}`;
    }
    q("[data-note]").textContent = note;
    this.goBtn.disabled = !smaller;
    this.goBtn.title = smaller ? "Download (Ctrl S)" : "Nothing smaller to download yet";
  }
}
