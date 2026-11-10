import { handoffButton, type HandoffTarget } from "./handoff";
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
/** A placed signature. Copies placed on several pages at once share a group and move together. */
type Placed = Placement & { group?: number };

/**
 * Sign a PDF: pick a colour, pick a style (a typed name in a handwriting
 * font, or draw it), then click where it goes. Signatures can be dragged
 * and resized; the same signature can go in several places. With "Multiple
 * pages?", the pages are laid out side by side so they all fit on screen,
 * one placement goes on every chosen page, and moving or resizing any copy
 * moves them all, live, on every page.
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
  private places: Placed[] = [];
  private multi = false;
  /** Pages (0-based) a new signature goes on in multiple-page mode. */
  private chosen = new Set<number>();
  private nextGroup = 1;
  private lastGroup: number | null = null;
  private pageList: HTMLInputElement;
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
  private handoffEl: HTMLElement;
  private input: HTMLInputElement;
  private width: number;
  /** Width the pages are drawn at right now. */
  private tile: number;
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
        <label class="check inline" title="Put the same signature on several pages at once">
          <input type="checkbox" data-multi />
          <span><strong>Multiple pages?</strong></span>
        </label>
        <label class="every" data-pages-opt hidden>
          Pages
          <input type="text" class="sg-page-list" data-page-list inputmode="text" spellcheck="false" autocomplete="off" placeholder="1-3, 7" aria-describedby="sg-pages-help" />
        </label>
        <span class="sr-only" id="sg-pages-help">Page numbers and ranges, like 1-3, 7. Or "all".</span>
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
              ${(["showpiece", "natural", "fancy"] as const)
                .map(
                  (group) => `
                <p class="sg-group">${{ showpiece: "Showpiece", natural: "Natural", fancy: "Fancy" }[group]}</p>
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
    this.pageList = q<HTMLInputElement>("[data-page-list]");
    // Sign, then keep editing the signed PDF in another tool: no download and upload in between.
    this.handoffEl = handoffButton({
      label: "Continue with",
      count: () => 1,
      exclude: ["sign"],
      pick: (t) => void this.handoff(t),
    });
    this.goBtn.before(this.handoffEl);
    this.width = Math.min(760, window.innerWidth - 32);
    this.tile = this.width;
    this.thumbs = new Thumbs(this.scroller, { w: this.width, h: this.width * 2 });
    // Keep the side-by-side pages fitting the window.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (this.active && this.multi && this.step === "place" && this.tileWidth() !== this.tile) this.renderPages();
      }, 150);
    });

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
    q<HTMLInputElement>("[data-multi]").addEventListener("change", (e) => {
      this.multi = (e.target as HTMLInputElement).checked;
      if (this.multi && !this.chosen.size && this.src) this.chosen = new Set(this.src.sizes.map((_, i) => i));
      this.syncChosen();
      // Side by side for several pages, one big page at a time otherwise.
      this.renderPages();
      if (this.multi) this.applyChosen();
      this.scroller.scrollTop = 0;
      this.sync();
    });
    this.pageList.addEventListener("input", () => {
      const pages = this.src ? parsePages(this.pageList.value, this.src.sizes.length) : null;
      this.pageList.setAttribute("aria-invalid", String(pages === null));
      if (!pages) return;
      this.chosen = pages;
      this.syncChosen(false);
      this.applyChosen();
    });
    this.pageList.addEventListener("blur", () => this.syncChosen());
    this.pagesEl.addEventListener("change", (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>(".sg-check");
      if (!box) return;
      const i = Number(box.dataset.page);
      if (box.checked) this.chosen.add(i);
      else this.chosen.delete(i);
      this.syncChosen();
      this.applyChosen();
    });
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

  /** Sign, then open the signed PDF in another tool instead of downloading it. */
  private async handoff(target: HandoffTarget): Promise<void> {
    const src = this.src;
    if (!src || !this.sig || !this.places.length) return;
    showBusy("Signing");
    try {
      const bytes = await signPdf(src, this.sig, this.places);
      showBusy(null);
      const name = `${baseName(src.name)}-signed.pdf`;
      this.host.openIn(target, [new File([bytes as BlobPart], name, { type: "application/pdf" })]);
    } catch (err) {
      console.error(err);
      showBusy(null);
      toast("The signed PDF couldn't be made.", "The file may be damaged. Try opening it again.");
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
      const sig = await typedSignature(name, s.family, ink, s.flourish);
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
        : await typedSignature(this.name, STYLES[this.style].family, this.ink, STYLES[this.style].flourish);
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
    const w = this.multi ? this.tileWidth() : this.width;
    if (w !== this.tile) {
      this.tile = w;
      this.thumbs = new Thumbs(this.scroller, { w, h: w * 2 });
    }
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
      const label = document.createElement("label");
      label.className = "sg-cap";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "sg-check";
      box.dataset.page = String(i);
      box.checked = this.chosen.has(i);
      box.setAttribute("aria-label", `Sign page ${i + 1}`);
      label.append(box, `Page ${i + 1} of ${src.sizes.length}`);
      cap.append(label);
      fig.append(wrap, cap);
      frag.append(fig);
    });
    this.pagesEl.replaceChildren(frag);
    this.pagesEl.classList.toggle("multi", this.multi);
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
      el.classList.toggle(
        "selected",
        this.linked(this.selected).some((x) => x.id === p.id),
      );
      el.dataset.id = String(p.id);
      el.tabIndex = 0;
      el.setAttribute("role", "img");
      const copies = this.linked(p.id).length;
      el.setAttribute(
        "aria-label",
        copies > 1
          ? `Signature on ${copies} pages. Drag to move them all; Delete to remove them all.`
          : "Signature. Drag to move; Delete to remove.",
      );
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
      del.setAttribute(
        "aria-label",
        copies > 1 ? `Remove this signature from all ${copies} pages` : "Remove this signature",
      );
      if (copies > 1) del.title = `Remove from all ${copies} pages`;
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
        const at = Number(page.dataset.page);
        const p: Placed = {
          id: this.nextId++,
          page: at,
          fx: (e.clientX - rect.left) / rect.width,
          fy: (e.clientY - rect.top) / rect.height,
          fw,
        };
        this.clampInto(p, rect);
        this.places.push(p);
        if (this.multi) {
          // The same spot on every chosen page (and this one).
          this.chosen.add(at);
          p.group = this.nextGroup++;
          this.lastGroup = p.group;
          this.syncChosen();
          this.spread(p);
        }
        this.drawPlacements();
        this.select(p.id);
        return;
      }
      e.preventDefault();
      const id = Number(placed.dataset.id);
      const p = this.places.find((x) => x.id === id)!;
      this.select(id);
      const el = this.pagesEl.querySelector<HTMLElement>(`.sg-place[data-id="${id}"]`)!;
      const others = this.linked(id).filter((x) => x !== p);
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
        // Copies on other pages follow.
        for (const o of others) {
          Object.assign(o, { fx: p.fx, fy: p.fy, fw: p.fw });
          const r = this.pageRect(o.page);
          if (r) this.clampInto(o, r);
          const oel = this.pagesEl.querySelector<HTMLElement>(`.sg-place[data-id="${o.id}"]`);
          if (oel) {
            oel.style.left = `${o.fx * 100}%`;
            oel.style.top = `${o.fy * 100}%`;
            oel.style.width = `${o.fw * 100}%`;
          }
        }
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
    const group = new Set(this.linked(id).map((p) => p.id));
    for (const el of this.pagesEl.querySelectorAll<HTMLElement>(".sg-place")) {
      el.classList.toggle("selected", group.has(Number(el.dataset.id)));
    }
    const g = id === null ? undefined : this.places.find((p) => p.id === id)?.group;
    if (g !== undefined) this.lastGroup = g;
    if (id !== null)
      this.pagesEl.querySelector<HTMLElement>(`.sg-place[data-id="${id}"]`)?.focus({ preventScroll: true });
  }

  /** Remove a signature, and its copies on other pages. */
  private remove(id: number): void {
    const gone = new Set(this.linked(id).map((p) => p.id));
    this.places = this.places.filter((p) => !gone.has(p.id));
    if (this.selected !== null && gone.has(this.selected)) this.selected = null;
    this.drawPlacements();
  }

  /**
   * How wide to draw each page so that, side by side, they all fit in the
   * window: the widest that does, trying every number of columns. Very
   * long documents scroll rather than shrink past legibility.
   */
  private tileWidth(): number {
    const src = this.src;
    if (!src) return this.width;
    const n = src.sizes.length;
    const aspect = Math.max(...src.sizes.map((s) => s.h / s.w));
    const W = Math.max(200, this.scroller.clientWidth - 32);
    const H = Math.max(200, this.scroller.clientHeight - 48);
    const gap = 16;
    const caption = 26;
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const byWidth = (W - gap * (cols - 1)) / cols;
      const byHeight = (H - rows * (caption + gap)) / rows / aspect;
      best = Math.max(best, Math.min(byWidth, byHeight));
    }
    const smallest = Math.min(170, (W - gap) / 2);
    return Math.round(Math.max(smallest, Math.min(this.width, best)));
  }

  /** A placement and the copies linked to it. */
  private linked(id: number | null): Placed[] {
    if (id === null) return [];
    const p = this.places.find((x) => x.id === id);
    if (!p) return [];
    return p.group === undefined ? [p] : this.places.filter((x) => x.group === p.group);
  }

  private pageRect(page: number): DOMRect | null {
    return this.pagesEl.querySelector<HTMLElement>(`.sg-page[data-page="${page}"]`)?.getBoundingClientRect() ?? null;
  }

  /** Copy a grouped placement onto every chosen page that doesn't have it yet. */
  private spread(p: Placed): void {
    const have = new Set(this.places.filter((x) => x.group === p.group).map((x) => x.page));
    for (const page of [...this.chosen].sort((a, b) => a - b)) {
      if (have.has(page)) continue;
      const copy: Placed = { ...p, id: this.nextId++, page };
      const r = this.pageRect(page);
      if (r) this.clampInto(copy, r);
      this.places.push(copy);
    }
  }

  /**
   * After the chosen pages change: the selected signature (or the last one
   * placed on several pages) gets copies on newly chosen pages and loses
   * them on pages no longer chosen.
   */
  private applyChosen(): void {
    if (!this.multi) return;
    let master = this.selected !== null ? this.places.find((p) => p.id === this.selected) : undefined;
    if (!master && this.lastGroup !== null) master = this.places.find((p) => p.group === this.lastGroup);
    if (!master) return;
    if (master.group === undefined) {
      master.group = this.nextGroup++;
      this.lastGroup = master.group;
    }
    const g = master.group;
    this.places = this.places.filter((p) => p.group !== g || this.chosen.has(p.page));
    const left = this.places.filter((p) => p.group === g);
    if (left.length) this.spread(left.includes(master) ? master : left[0]);
    else if (this.chosen.size) {
      this.places.push(master);
      this.spread(master);
      this.places = this.places.filter((p) => p.group !== g || this.chosen.has(p.page));
    }
    if (this.selected !== null && !this.places.some((p) => p.id === this.selected)) this.selected = null;
    this.drawPlacements();
  }

  /** Show the chosen pages in the page boxes and (unless they're typing there) the page list. */
  private syncChosen(list = true): void {
    for (const box of this.pagesEl.querySelectorAll<HTMLInputElement>(".sg-check")) {
      box.checked = this.chosen.has(Number(box.dataset.page));
    }
    if (list && this.src) {
      this.pageList.value = formatPages(this.chosen, this.src.sizes.length);
      this.pageList.setAttribute("aria-invalid", "false");
    }
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
    this.chosen.clear();
    this.lastGroup = null;
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
    q("[data-pages-opt]").hidden = !this.multi;
    this.root.querySelector<HTMLInputElement>("[data-multi]")!.checked = this.multi;
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
    const pagesSigned = new Set(this.places.map((p) => p.page)).size;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const tap = touch ? "Tap" : "Click";
    q("[data-hint]").textContent = this.multi
      ? n
        ? "Drag any copy to move them all. Tick or untick pages to add or remove it."
        : `Tick the pages to sign, then ${tap.toLowerCase()} where it goes on any of them.`
      : n
        ? `${tap} elsewhere to sign again. Drag to move, pull the corner to resize.`
        : `${tap} where your signature should go.`;
    q("[data-status]").textContent = n
      ? `${n === 1 ? "1 signature" : `${n} signatures`}${pagesSigned > 1 ? ` on ${pagesSigned} pages` : ""}`
      : "";

    this.handoffEl.hidden = !placing || n === 0;
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

/** "1-3, 7, 10-" as a set of 0-based pages; "all" for every page. Null if it doesn't make sense. */
export function parsePages(text: string, count: number): Set<number> | null {
  const t = text.trim().toLowerCase();
  if (t === "all" || t === "*") return new Set(Array.from({ length: count }, (_, i) => i));
  const out = new Set<number>();
  if (!t) return out;
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?\s*(?:(-|\u2013|to)\s*(\d+)?)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return null;
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : count) : a;
    if (a < 1 || b < a || b > count) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return out;
}

/** The other way: {0, 1, 2, 6} as "1-3, 7", or "all". */
export function formatPages(pages: Set<number>, count: number): string {
  if (count > 1 && pages.size === count) return "all";
  const list = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    parts.push(j > i ? `${list[i] + 1}-${list[j] + 1}` : String(list[i] + 1));
    i = j + 1;
  }
  return parts.join(", ");
}
