import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { addPageNumbers, anchor, FORMATS, label, type NumberFormat, type NumberOptions } from "./numbers";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const SIZES = { small: 9, medium: 11, large: 14 } as const;
type Size = keyof typeof SIZES;
type Step = "place" | "preview";

/**
 * Add page numbers. First you click where the number goes on a blank page,
 * then you see your real pages with the numbers on before downloading.
 */
export class NumberTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private step: Step = "place";
  private spot: { fx: number; fy: number } | null = null;
  private format: NumberFormat = "n";
  private size: Size = "medium";
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private blank: HTMLElement;
  private marker: HTMLElement;
  private previewEl: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private skipFirst: HTMLInputElement;
  private resize: ResizeObserver;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "number-tool";
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
          <button type="button" class="btn" data-back hidden>${icons.back}<span class="lbl">Change position</span></button>
          <button type="button" class="btn primary" data-go></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <div class="seg" role="radiogroup" aria-label="Number style">
          ${Object.entries(FORMATS)
            .map(([k, v]) => `<button type="button" role="radio" data-format="${k}">${v}</button>`)
            .join("")}
        </div>
        <div class="seg" role="radiogroup" aria-label="Text size">
          <button type="button" role="radio" data-size="small" aria-label="Small">S</button>
          <button type="button" role="radio" data-size="medium" aria-label="Medium">M</button>
          <button type="button" role="radio" data-size="large" aria-label="Large">L</button>
        </div>
        <label class="check inline">
          <input type="checkbox" data-skip />
          <span><strong>Skip the first page</strong></span>
        </label>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Page numbers</h1>
          <p class="tool-sub">Add a number to every page. You'll choose where it goes on the next screen.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.hash}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="np-place" data-place hidden>
          <p class="np-prompt" data-prompt></p>
          <div class="np-blank" data-blank role="button" tabindex="0" aria-label="Blank page. Click where the page number should go.">
            <span class="np-num" data-marker hidden></span>
          </div>
        </div>
        <div class="np-preview" data-preview hidden></div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.blank = q("[data-blank]");
    this.marker = q("[data-marker]");
    this.previewEl = q("[data-preview]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.backBtn = q<HTMLButtonElement>("[data-back]");
    this.skipFirst = q<HTMLInputElement>("[data-skip]");
    const small = window.matchMedia("(max-width: 520px)").matches;
    this.thumbs = new Thumbs(this.scroller, small ? { w: 160, h: 214 } : { w: 300, h: 400 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => {
      if (this.step === "place") this.setStep("preview");
      else void this.download();
    });
    this.backBtn.addEventListener("click", () => this.setStep("place"));
    this.blank.addEventListener("click", (e) => this.placeAt(e.clientX, e.clientY));
    this.blank.addEventListener("keydown", (e) => this.nudge(e));
    this.root.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((b) =>
      b.addEventListener("click", () => {
        this.format = b.dataset.format as NumberFormat;
        this.refresh();
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
      b.addEventListener("click", () => {
        this.size = b.dataset.size as Size;
        this.refresh();
      }),
    );
    this.skipFirst.addEventListener("change", () => this.refresh());
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });
    this.resize = new ResizeObserver(() => this.drawMarker());
    this.resize.observe(this.blank);

    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `Number ${this.src.name} - HackerPDF` : "Page numbers - HackerPDF";
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
    this.src = src;
    document.title = `Number ${src.name} - HackerPDF`;
    // The blank page has the first page's shape.
    const first = src.sizes[0];
    this.blank.style.setProperty("--ar", String(first.w / first.h));
    this.setStep("place");
  }

  async download(): Promise<void> {
    const src = this.src;
    if (!src || !this.spot || this.goBtn.disabled) return;
    const name = `${baseName(src.name)}-numbered.pdf`;
    showBusy("Adding page numbers");
    try {
      const res = await addPageNumbers(src, this.options(), (done, total) =>
        showBusy(`Preparing page ${done} of ${total}`),
      );
      saveFile(new Blob([res.bytes as BlobPart], { type: "application/pdf" }), name);
      const flat = res.flattened ? " Pages became images because the file is password-protected." : "";
      toast(
        `Downloaded ${name}`,
        `${src.sizes.length} ${src.sizes.length === 1 ? "page" : "pages"}.${flat} Metadata removed.`,
      );
    } catch (err) {
      console.error(err);
      toast("Page numbers couldn't be added.", "The file may be damaged. Try opening it again.");
    } finally {
      showBusy(null);
    }
  }

  // ------------------------------------------------------------- internals

  private options(): NumberOptions {
    return {
      fx: this.spot?.fx ?? 0.5,
      fy: this.spot?.fy ?? 0.95,
      format: this.format,
      size: SIZES[this.size],
      skipFirst: this.skipFirst.checked,
    };
  }

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    // this.spot stays: handy when numbering several files the same way.
    this.thumbs.clear();
    this.previewEl.replaceChildren();
    this.step = "place";
    this.sync();
  }

  private setStep(step: Step): void {
    if (step === "preview" && !this.spot) return;
    this.step = step;
    this.sync(); // show the step first: numbers are measured, which needs them on screen
    if (step === "preview") this.renderPreview();
    else {
      this.thumbs.clear();
      this.previewEl.replaceChildren();
    }
    this.scroller.scrollTop = 0;
    if (step === "place") this.blank.focus({ preventScroll: true });
  }

  private placeAt(clientX: number, clientY: number): void {
    const r = this.blank.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    this.spot = { fx: clamp((clientX - r.left) / r.width), fy: clamp((clientY - r.top) / r.height) };
    this.sync();
  }

  /** Arrow keys move the spot (and place one in the bottom center if there isn't one yet). */
  private nudge(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (e.key === "Enter" && this.spot) {
      e.preventDefault();
      this.setStep("preview");
      return;
    }
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const s = this.spot ?? { fx: 0.5, fy: 0.95 };
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    this.spot = { fx: clamp(s.fx + m[0]), fy: clamp(s.fy + m[1]) };
    this.sync();
  }

  /** The sample number on the blank page, at the size it'll really be. */
  private drawMarker(): void {
    const src = this.src;
    this.marker.hidden = !src || !this.spot;
    if (!src || !this.spot) return;
    const first = src.sizes[0];
    const total = src.sizes.length;
    this.marker.textContent = label(this.format, 1, total);
    this.position(this.marker, this.blank.clientWidth / first.w, first.w, first.h);
  }

  /** Put a number overlay where it'll be drawn, at `scale` pixels per point on a w x h point page. */
  private position(el: HTMLElement, scale: number, w: number, h: number): void {
    const opts = this.options();
    el.style.fontSize = `${opts.size * scale}px`;
    const c = anchor(
      opts.fx,
      opts.fy,
      w * scale,
      h * scale,
      el.offsetWidth,
      opts.size * 0.72 * scale,
      opts.size * 0.4 * scale,
    );
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
  }

  private renderPreview(): void {
    const src = this.src;
    if (!src) return;
    this.thumbs.clear();
    const frag = document.createDocumentFragment();
    src.sizes.forEach((_, i) => {
      const fig = document.createElement("figure");
      fig.className = "np-fig";
      const wrap = document.createElement("div");
      wrap.className = "np-page";
      const sheet = this.thumbs.sheet(src, i);
      wrap.style.width = sheet.style.width;
      wrap.style.height = sheet.style.height;
      const num = document.createElement("span");
      num.className = "np-num";
      num.dataset.page = String(i);
      wrap.append(sheet, num);
      const cap = document.createElement("figcaption");
      cap.textContent = `Page ${i + 1}`;
      fig.append(wrap, cap);
      frag.append(fig);
    });
    this.previewEl.replaceChildren(frag);
    this.drawPreviewNumbers();
  }

  private drawPreviewNumbers(): void {
    const src = this.src;
    if (!src) return;
    const opts = this.options();
    const total = src.sizes.length;
    this.previewEl.querySelectorAll<HTMLElement>(".np-num").forEach((num) => {
      const i = Number(num.dataset.page);
      const size = src.sizes[i];
      const skip = opts.skipFirst && i === 0;
      num.hidden = skip;
      if (skip) return;
      num.textContent = label(opts.format, i + 1, total);
      const wrap = num.parentElement!;
      this.position(num, parseFloat(wrap.style.width) / size.w, size.w, size.h);
    });
  }

  /** Options changed: update whatever is showing. */
  private refresh(): void {
    this.sync();
    if (this.step === "preview") this.drawPreviewNumbers();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    const placing = src !== null && this.step === "place";
    const previewing = src !== null && this.step === "preview";
    q("[data-empty]").hidden = src !== null;
    q("[data-place]").hidden = !placing;
    this.previewEl.hidden = !previewing;
    q("[data-opts]").hidden = src === null;
    this.backBtn.hidden = !previewing;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "Page numbers";
    nameEl.title = src?.name ?? "";
    const touch = window.matchMedia("(pointer: coarse)").matches;
    q("[data-prompt]").textContent = this.spot
      ? touch
        ? "Tap again to move it. Then preview your PDF."
        : "Click again to move it, or use the arrow keys. Then preview your PDF."
      : `${touch ? "Tap" : "Click"} where you want the page numbers to go.`;
    q("[data-status]").textContent = src ? `${src.sizes.length} ${src.sizes.length === 1 ? "page" : "pages"}` : "";

    this.root.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.format === this.format));
      // Show the styles with this file's real page count.
      if (src) b.textContent = label(b.dataset.format as NumberFormat, 1, src.sizes.length);
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.size === this.size));
    });

    if (previewing) {
      this.goBtn.innerHTML = `${icons.download}<span>Download<span class="lbl"> PDF</span></span>`;
      this.goBtn.disabled = false;
      this.goBtn.title = "Download (Ctrl S)";
    } else {
      this.goBtn.innerHTML = `<span>Preview</span>${icons.arrow}`;
      this.goBtn.disabled = !this.spot;
      this.goBtn.title = this.spot ? "See your pages with numbers on" : "Click on the page first";
    }
    this.drawMarker();
  }
}
