import { icons } from "./icons";
import type { ToolHost } from "./merge";
import {
  drawnSignature,
  drawStrokes,
  INKS,
  signPdf,
  STYLES,
  typedSignature,
  type Ink,
  type Placement,
  type Signature,
  type Stroke,
} from "./signature";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

type Step = "setup" | "place";
type Style = number | "draw";

/**
 * Sign a PDF: pick a colour, pick a style (a typed name in a handwriting
 * font, or draw it), then click where it goes. Signatures can be dragged
 * and resized; the same signature can go in several places.
 */
export class SignTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private step: Step = "setup";
  private ink: Ink = "blue";
  private style: Style = 0;
  private name = "";
  private strokes: Stroke[] = [];
  private sig: Signature | null = null;
  private previews: (Signature | null)[] = [];
  private places: Placement[] = [];
  private selected: number | null = null;
  private nextId = 1;
  private previewRun = 0;
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private pad: HTMLCanvasElement;
  private nameInput: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private input: HTMLInputElement;
  private width: number;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "sign-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-file></span>
        </div>
        <div class="tb-group tb-right">
          <button type="button" class="btn" data-back hidden>${icons.back}<span class="lbl">Change signature</span></button>
          <button type="button" class="btn primary" data-go></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <p class="opt-hint" data-hint></p>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Sign</h1>
          <p class="tool-sub">Add a handwritten-looking signature to a PDF. Pick a colour and a style, then click where it goes.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.pen}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="tool-body sg-setup" data-setup hidden>
          <h1 class="tool-title">Your signature</h1>
          <div class="sg-section">
            <span class="sg-label" id="sg-ink-label">Colour</span>
            <div class="sg-inks" role="radiogroup" aria-labelledby="sg-ink-label">
              ${(Object.keys(INKS) as Ink[])
                .map(
                  (k) =>
                    `<button type="button" role="radio" class="sg-ink" data-ink="${k}"><i style="background: rgb(${INKS[k].color.join(",")})"></i><span>${INKS[k].label}</span></button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="sg-section">
            <label class="sg-label" for="sg-name">Your name</label>
            <input id="sg-name" class="sg-input" type="text" autocomplete="name" spellcheck="false" placeholder="Type your name" data-name />
          </div>
          <div class="sg-section">
            <span class="sg-label" id="sg-style-label">Style</span>
            <div role="radiogroup" aria-labelledby="sg-style-label">
              ${(["natural", "fancy"] as const)
                .map(
                  (group) => `
                <p class="sg-group">${group === "natural" ? "Natural" : "Fancy"}</p>
                <div class="sg-styles">
                  ${STYLES.map((s, i) =>
                    s.group !== group
                      ? ""
                      : `<button type="button" role="radio" class="sg-style" data-style="${i}" aria-label="${s.family}"><img alt="" data-preview="${i}" hidden /><span class="sg-sample" style="font-family: '${s.family}'">Signature</span></button>`,
                  ).join("")}
                </div>`,
                )
                .join("")}
              <p class="sg-group">Your own</p>
              <div class="sg-styles">
                <button type="button" role="radio" class="sg-style sg-draw" data-style="draw">${icons.pen}<span>Draw it</span></button>
              </div>
            </div>
          </div>
          <div class="sg-section" data-pad-wrap hidden>
            <div class="sg-pad-box">
              <canvas class="sg-pad" data-pad aria-label="Signature pad: sign here with your mouse or finger"></canvas>
              <span class="sg-pad-line" aria-hidden="true"></span>
            </div>
            <div class="sg-pad-bar">
              <span class="hint" data-pad-hint>Sign above with your mouse, trackpad or finger.</span>
              <button type="button" class="quiet-btn" data-undo>Undo</button>
              <button type="button" class="quiet-btn" data-clear>Clear</button>
            </div>
          </div>
        </div>
        <div class="sg-pages" data-pages hidden></div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.pagesEl = q("[data-pages]");
    this.pad = q<HTMLCanvasElement>("[data-pad]");
    this.nameInput = q<HTMLInputElement>("[data-name]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.backBtn = q<HTMLButtonElement>("[data-back]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.width = Math.min(760, window.innerWidth - 32);
    this.thumbs = new Thumbs(this.scroller, { w: this.width, h: this.width * 2 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => {
      if (this.step === "setup") void this.toPlace();
      else void this.download();
    });
    this.backBtn.addEventListener("click", () => this.setStep("setup"));
    this.root.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ink = b.dataset.ink as Ink;
        this.redrawPad();
        void this.renderPreviews();
        this.sync();
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((b) =>
      b.addEventListener("click", () => {
        const v = b.dataset.style!;
        this.style = v === "draw" ? "draw" : Number(v);
        this.sync();
        if (this.style === "draw") {
          this.sizePad();
          this.pad.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else if (!this.name) this.nameInput.focus();
      }),
    );
    let timer = 0;
    this.nameInput.addEventListener("input", () => {
      this.name = this.nameInput.value.trim();
      this.sync();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.renderPreviews(), 120);
    });
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.goBtn.disabled) void this.toPlace();
    });
    q("[data-clear]").addEventListener("click", () => {
      this.strokes = [];
      this.redrawPad();
      this.sync();
    });
    q("[data-undo]").addEventListener("click", () => {
      this.strokes.pop();
      this.redrawPad();
      this.sync();
    });
    this.setupPad();
    this.setupPlacing();
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });
    document.addEventListener("keydown", (e) => {
      if (!this.active || this.root.hidden || this.step !== "place" || this.selected === null) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.remove(this.selected);
      }
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `Sign ${this.src.name} - HackerPDF` : "Sign - HackerPDF";
  }

  close(): void {
    this.active = false;
    // The signature itself is kept (in memory only) so the next file can be signed straight away.
    this.reset(true);
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
    const keepSig = this.sig !== null;
    this.reset(true);
    this.src = src;
    document.title = `Sign ${src.name} - HackerPDF`;
    // Already made a signature this visit? Go straight to placing it.
    this.setStep(keepSig ? "place" : "setup");
    if (!keepSig) {
      void this.renderPreviews();
      this.nameInput.focus();
    }
  }

  async download(): Promise<void> {
    const src = this.src;
    if (!src || !this.sig || !this.places.length) return;
    const name = `${baseName(src.name)}-signed.pdf`;
    showBusy("Signing");
    try {
      const bytes = await signPdf(src, this.sig, this.places);
      saveFile(new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
      const n = this.places.length;
      toast(`Downloaded ${name}`, `${n === 1 ? "Signed in 1 place" : `Signed in ${n} places`}.`);
    } catch (err) {
      console.error(err);
      toast("The signed PDF couldn't be made.", "The file may be damaged. Try opening it again.");
    } finally {
      showBusy(null);
    }
  }

  // ---------------------------------------------------------------- setup

  private ready(): boolean {
    return this.style === "draw" ? this.strokes.length > 0 : this.name.length > 0;
  }

  private async renderPreviews(): Promise<void> {
    const run = ++this.previewRun;
    const name = this.name;
    const ink = this.ink;
    for (const [i, s] of STYLES.entries()) {
      const img = this.root.querySelector<HTMLImageElement>(`[data-preview="${i}"]`)!;
      const sample = img.nextElementSibling as HTMLElement;
      if (!name) {
        img.hidden = true;
        sample.hidden = false;
        sample.style.color = `rgb(${INKS[ink].color.join(",")})`;
        continue;
      }
      const sig = await typedSignature(name, s.family, ink);
      if (run !== this.previewRun) return;
      this.previews[i] = sig;
      img.src = sig.url;
      img.hidden = false;
      sample.hidden = true;
    }
  }

  private async toPlace(): Promise<void> {
    if (!this.ready()) return;
    const sig =
      this.style === "draw"
        ? drawnSignature(this.strokes, this.ink)
        : await typedSignature(this.name, STYLES[this.style].family, this.ink);
    if (!sig) return;
    this.sig = sig;
    this.setStep("place");
  }

  private sizePad(): void {
    const box = this.pad.getBoundingClientRect();
    if (!box.width) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.pad.width = Math.round(box.width * dpr);
    this.pad.height = Math.round(box.height * dpr);
    this.redrawPad();
  }

  private redrawPad(): void {
    const g = this.pad.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.pad.width, this.pad.height);
    const scale = this.pad.width / (this.pad.getBoundingClientRect().width || 1);
    drawStrokes(g, this.strokes, scale, this.ink);
  }

  private setupPad(): void {
    let stroke: Stroke | null = null;
    let frame = 0;
    const point = (e: PointerEvent) => {
      const r = this.pad.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
    };
    this.pad.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!this.pad.width) this.sizePad();
      this.pad.setPointerCapture(e.pointerId);
      stroke = [point(e)];
      this.strokes.push(stroke);
      this.redrawPad();
    });
    this.pad.addEventListener("pointermove", (e) => {
      if (!stroke) return;
      // Use every sample the browser has, for smooth curves.
      for (const ev of e.getCoalescedEvents?.() ?? [e]) stroke.push(point(ev));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          this.redrawPad();
        });
      }
    });
    const end = () => {
      if (!stroke) return;
      stroke = null;
      this.redrawPad();
      this.sync();
    };
    this.pad.addEventListener("pointerup", end);
    this.pad.addEventListener("pointercancel", end);
    new ResizeObserver(() => {
      if (!this.pad.closest("[hidden]")) this.sizePad();
    }).observe(this.pad);
  }

  // -------------------------------------------------------------- placing

  private renderPages(): void {
    const src = this.src;
    if (!src) return;
    this.thumbs.clear();
    const frag = document.createDocumentFragment();
    src.sizes.forEach((size, i) => {
      const fig = document.createElement("figure");
      fig.className = "sg-fig";
      const wrap = document.createElement("div");
      wrap.className = "sg-page";
      const sheet = this.thumbs.sheet(src, i);
      wrap.style.width = sheet.style.width;
      wrap.style.height = sheet.style.height;
      wrap.dataset.page = String(i);
      wrap.dataset.ptw = String(size.w);
      const layer = document.createElement("div");
      layer.className = "sg-layer";
      wrap.append(sheet, layer);
      const cap = document.createElement("figcaption");
      cap.textContent = `Page ${i + 1} of ${src.sizes.length}`;
      fig.append(wrap, cap);
      frag.append(fig);
    });
    this.pagesEl.replaceChildren(frag);
    this.drawPlacements();
  }

  private drawPlacements(): void {
    if (!this.sig) return;
    for (const layer of this.pagesEl.querySelectorAll<HTMLElement>(".sg-layer")) layer.replaceChildren();
    for (const p of this.places) {
      const layer = this.pagesEl.querySelector<HTMLElement>(`.sg-page[data-page="${p.page}"] .sg-layer`);
      if (!layer) continue;
      const el = document.createElement("div");
      el.className = "sg-place";
      el.classList.toggle("selected", p.id === this.selected);
      el.dataset.id = String(p.id);
      el.tabIndex = 0;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "Signature. Drag to move; Delete to remove.");
      el.style.left = `${p.fx * 100}%`;
      el.style.top = `${p.fy * 100}%`;
      el.style.width = `${p.fw * 100}%`;
      const img = document.createElement("img");
      img.src = this.sig.url;
      img.alt = "";
      img.draggable = false;
      const handle = document.createElement("span");
      handle.className = "sg-handle";
      handle.title = "Drag to resize";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sg-del";
      del.title = "Remove";
      del.setAttribute("aria-label", "Remove this signature");
      del.innerHTML = icons.close;
      el.append(img, handle, del);
      layer.append(el);
    }
    this.sync();
  }

  private setupPlacing(): void {
    this.pagesEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const del = t.closest(".sg-del");
      if (del) return;
      const placed = t.closest<HTMLElement>(".sg-place");
      const page = t.closest<HTMLElement>(".sg-page");
      if (!page) {
        this.select(null);
        return;
      }
      const rect = page.getBoundingClientRect();
      if (!placed) {
        // A click on the page: put a signature there, about 2.2 inches wide.
        const ptw = Number(page.dataset.ptw);
        const fw = Math.min(0.6, 160 / ptw);
        const p: Placement = {
          id: this.nextId++,
          page: Number(page.dataset.page),
          fx: (e.clientX - rect.left) / rect.width,
          fy: (e.clientY - rect.top) / rect.height,
          fw,
        };
        this.clampInto(p, rect);
        this.places.push(p);
        this.drawPlacements();
        this.select(p.id);
        return;
      }
      e.preventDefault();
      const id = Number(placed.dataset.id);
      const p = this.places.find((x) => x.id === id)!;
      this.select(id);
      const el = this.pagesEl.querySelector<HTMLElement>(`.sg-place[data-id="${id}"]`)!;
      const resizing = !!t.closest(".sg-handle");
      const start = { x: e.clientX, y: e.clientY, fx: p.fx, fy: p.fy, fw: p.fw };
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (resizing) {
          // The center stays put; the corner follows the pointer.
          const cx = rect.left + p.fx * rect.width;
          p.fw = Math.max(0.05, Math.min(1, (2 * Math.abs(ev.clientX - cx)) / rect.width));
        } else {
          p.fx = start.fx + (ev.clientX - start.x) / rect.width;
          p.fy = start.fy + (ev.clientY - start.y) / rect.height;
        }
        this.clampInto(p, rect);
        el.style.left = `${p.fx * 100}%`;
        el.style.top = `${p.fy * 100}%`;
        el.style.width = `${p.fw * 100}%`;
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    this.pagesEl.addEventListener("click", (e) => {
      const del = (e.target as HTMLElement).closest<HTMLElement>(".sg-del");
      if (del) this.remove(Number(del.closest<HTMLElement>(".sg-place")!.dataset.id));
    });
  }

  /** Keep a signature fully on its page. */
  private clampInto(p: Placement, rect: DOMRect): void {
    if (!this.sig) return;
    const halfW = p.fw / 2;
    const halfH = (p.fw * rect.width * (this.sig.h / this.sig.w)) / rect.height / 2;
    p.fx = Math.min(1 - halfW, Math.max(halfW, p.fx));
    p.fy = Math.min(1 - halfH, Math.max(halfH, p.fy));
  }

  private select(id: number | null): void {
    this.selected = id;
    for (const el of this.pagesEl.querySelectorAll<HTMLElement>(".sg-place")) {
      el.classList.toggle("selected", Number(el.dataset.id) === id);
    }
    if (id !== null)
      this.pagesEl.querySelector<HTMLElement>(`.sg-place[data-id="${id}"]`)?.focus({ preventScroll: true });
  }

  private remove(id: number): void {
    this.places = this.places.filter((p) => p.id !== id);
    if (this.selected === id) this.selected = null;
    this.drawPlacements();
  }

  // ---------------------------------------------------------------- shared

  private setStep(step: Step): void {
    this.step = step;
    this.sync();
    if (step === "place") this.renderPages();
    else {
      this.thumbs.clear();
      this.pagesEl.replaceChildren();
      if (this.style === "draw") requestAnimationFrame(() => this.sizePad());
    }
    this.scroller.scrollTop = 0;
  }

  private reset(keepSignature = false): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.places = [];
    this.selected = null;
    if (!keepSignature) this.sig = null;
    this.thumbs.clear();
    this.pagesEl.replaceChildren();
    this.step = "setup";
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    const placing = src !== null && this.step === "place";
    q("[data-empty]").hidden = src !== null;
    q("[data-setup]").hidden = !src || placing;
    this.pagesEl.hidden = !placing;
    q("[data-opts]").hidden = !placing;
    this.backBtn.hidden = !placing;
    const nameEl = q("[data-file]");
    nameEl.textContent = src ? src.name : "Sign";
    nameEl.title = src?.name ?? "";

    this.root.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.ink === this.ink));
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((b) => {
      const v = b.dataset.style === "draw" ? "draw" : Number(b.dataset.style);
      b.setAttribute("aria-checked", String(v === this.style));
    });
    q("[data-pad-wrap]").hidden = this.style !== "draw";
    q("[data-undo]").hidden = q("[data-clear]").hidden = !this.strokes.length;

    const n = this.places.length;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    q("[data-hint]").textContent = n
      ? `${touch ? "Tap" : "Click"} elsewhere to sign again. Drag to move, pull the corner to resize.`
      : `${touch ? "Tap" : "Click"} where your signature should go.`;
    q("[data-status]").textContent = n ? (n === 1 ? "1 signature" : `${n} signatures`) : "";

    if (placing) {
      this.goBtn.innerHTML = `${icons.download}<span>Download<span class="lbl"> PDF</span></span>`;
      this.goBtn.disabled = n === 0;
      this.goBtn.title = n ? "Download (Ctrl S)" : "Place your signature first";
    } else {
      this.goBtn.innerHTML = `<span>Place it</span>${icons.arrow}`;
      this.goBtn.disabled = !src || !this.ready();
      this.goBtn.title = this.ready()
        ? "Choose where it goes"
        : this.style === "draw"
          ? "Draw your signature first"
          : "Type your name first";
    }
  }
}
