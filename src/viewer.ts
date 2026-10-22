import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { pdfjs } from "./pdf";
import type { Store } from "./store";
import {
  INK,
  TEXT_FONT,
  TEXT_LINE_HEIGHT,
  uid,
  type BoxShape,
  type Color,
  type DocState,
  type PageSize,
  type Rect,
  type Shape,
  type TextShape,
  type Tool,
} from "./types";
import { icons } from "./icons";

/** Screen pixels per page point at "100%" (actual size on a 96 dpi screen). */
export const ACTUAL_SIZE = 96 / 72;
const MAX_CANVAS_PIXELS = 16_000_000;
const MIN_BOX = 3; // points

export interface ViewerSettings {
  tool: Tool;
  color: Color;
  textSize: number;
}

interface PageView {
  index: number;
  size: PageSize;
  root: HTMLElement;
  sheet: HTMLElement;
  overlay: HTMLElement;
  highlights: HTMLElement;
  label: HTMLElement;
  deleteBtn: HTMLButtonElement;
  canvas: HTMLCanvasElement | null;
  renderedZoom: number;
  task: RenderTask | null;
  visible: boolean;
  shapeEls: Map<string, HTMLElement>;
}

type Handle = "nw" | "ne" | "sw" | "se";

type Drag =
  | { type: "draw"; pv: PageView; id: string; ox: number; oy: number; before: DocState }
  | {
      type: "move";
      pv: PageView;
      id: string;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      before: DocState;
      moved: boolean;
      wasSelected: boolean;
    }
  | { type: "resize"; pv: PageView; id: string; handle: Handle; orig: Rect; before: DocState };

interface Editing {
  id: string;
  isNew: boolean;
  before: DocState;
  el: HTMLElement;
}

export class Viewer {
  zoom = ACTUAL_SIZE;
  selectedId: string | null = null;
  onSelectionChange: (shape: Shape | undefined) => void = () => {};
  onPageDeleted: (pageNumber: number) => void = () => {};

  private pages: PageView[] = [];
  private drag: Drag | null = null;
  private editing: Editing | null = null;
  private highlightRects = new Map<number, Rect[]>();
  private io: IntersectionObserver;
  private queue: PageView[] = [];
  private rendering = false;
  private unsubscribe: () => void;
  private column: HTMLElement;

  constructor(
    private scroller: HTMLElement,
    private doc: PDFDocumentProxy,
    sizes: PageSize[],
    private store: Store,
    private settings: ViewerSettings,
  ) {
    this.column = document.createElement("div");
    this.column.className = "pages";
    scroller.replaceChildren(this.column);

    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pv = this.pages.find((p) => p.root === entry.target);
          if (!pv) continue;
          pv.visible = entry.isIntersecting;
          if (pv.visible) this.schedule(pv);
        }
      },
      { root: scroller, rootMargin: "1200px 0px" },
    );

    sizes.forEach((size, index) => this.pages.push(this.createPage(index, size)));
    this.zoom = this.fitZoom();
    this.layout();

    this.unsubscribe = store.subscribe(() => {
      if (this.selectedId && !this.liveShape(this.selectedId)) this.select(null);
      this.layoutDeleted();
      this.renderAllOverlays();
    });

    scroller.addEventListener("wheel", this.onWheel, { passive: false });
  }

  destroy(): void {
    this.unsubscribe();
    this.io.disconnect();
    for (const pv of this.pages) pv.task?.cancel();
    this.scroller.removeEventListener("wheel", this.onWheel);
    this.scroller.replaceChildren();
  }

  // ---------------------------------------------------------------- layout

  private createPage(index: number, size: PageSize): PageView {
    const root = document.createElement("section");
    root.className = "page";
    root.setAttribute("aria-label", `Page ${index + 1}`);

    const sheet = document.createElement("div");
    sheet.className = "sheet";

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const highlights = document.createElement("div");
    highlights.className = "highlights";
    overlay.append(highlights);
    sheet.append(overlay);

    const meta = document.createElement("div");
    meta.className = "page-meta";
    const label = document.createElement("span");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "quiet-btn";
    deleteBtn.innerHTML = `${icons.trash}<span>Delete page</span>`;
    meta.append(label, deleteBtn);

    root.append(sheet, meta);
    this.column.append(root);

    const pv: PageView = {
      index,
      size,
      root,
      sheet,
      overlay,
      highlights,
      label,
      deleteBtn,
      canvas: null,
      renderedZoom: 0,
      task: null,
      visible: false,
      shapeEls: new Map(),
    };

    overlay.addEventListener("pointerdown", (e) => this.onPointerDown(e, pv));
    overlay.addEventListener("pointermove", (e) => this.onPointerMove(e, pv));
    overlay.addEventListener("pointerup", (e) => this.onPointerUp(e));
    overlay.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    overlay.addEventListener("dblclick", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-shape]");
      const shape = el ? this.store.find(el.dataset.shape ?? null) : undefined;
      if (shape?.kind === "text") this.editText(shape.id, false);
    });
    deleteBtn.addEventListener("click", () => this.deletePage(pv));

    this.io.observe(root);
    return pv;
  }

  private fitZoom(): number {
    const available = Math.max(200, this.scroller.clientWidth - 48);
    const widest = Math.max(...this.pages.map((p) => p.size.w), 1);
    return Math.min(ACTUAL_SIZE, available / widest);
  }

  fitWidth(): void {
    this.setZoom(this.fitZoom());
  }

  setZoom(zoom: number): void {
    const z = Math.min(5 * ACTUAL_SIZE, Math.max(0.2 * ACTUAL_SIZE, zoom));
    if (Math.abs(z - this.zoom) < 1e-4) return;
    const s = this.scroller;
    const cx = (s.scrollLeft + s.clientWidth / 2) / Math.max(1, s.scrollWidth);
    const cy = (s.scrollTop + s.clientHeight / 2) / Math.max(1, s.scrollHeight);
    this.zoom = z;
    this.layout();
    s.scrollLeft = cx * s.scrollWidth - s.clientWidth / 2;
    s.scrollTop = cy * s.scrollHeight - s.clientHeight / 2;
  }

  private layout(): void {
    for (const pv of this.pages) {
      pv.sheet.style.width = `${pv.size.w * this.zoom}px`;
      pv.sheet.style.height = `${pv.size.h * this.zoom}px`;
      if (pv.visible) this.schedule(pv);
    }
    this.layoutDeleted();
    this.renderAllOverlays();
  }

  private layoutDeleted(): void {
    const deleted = new Set(this.store.state.deleted);
    const live = this.pages.filter((p) => !deleted.has(p.index));
    let n = 0;
    for (const pv of this.pages) {
      const gone = deleted.has(pv.index);
      pv.root.hidden = gone;
      if (gone) continue;
      n += 1;
      pv.label.textContent = `Page ${n} of ${live.length}`;
      pv.deleteBtn.disabled = live.length <= 1;
    }
  }

  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01));
  };

  // ------------------------------------------------------------- rendering

  private schedule(pv: PageView): void {
    if (pv.renderedZoom === this.zoom && pv.canvas) return;
    if (!this.queue.includes(pv)) this.queue.push(pv);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.queue.length) {
        // Prefer pages that are on screen right now.
        this.queue.sort((a, b) => Number(b.visible) - Number(a.visible));
        const pv = this.queue.shift()!;
        if (!pv.visible || (pv.renderedZoom === this.zoom && pv.canvas)) continue;
        await this.renderPage(pv);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async renderPage(pv: PageView): Promise<void> {
    const zoom = this.zoom;
    const page = await this.doc.getPage(pv.index + 1);
    const dpr = window.devicePixelRatio || 1;
    let scale = zoom * dpr;
    const pixels = pv.size.w * pv.size.h * scale * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = page.render({ canvas, viewport });
    pv.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err instanceof pdfjs.RenderingCancelledException) return;
      console.error(err);
      return;
    } finally {
      pv.task = null;
    }
    pv.canvas?.remove();
    pv.canvas = canvas;
    pv.sheet.prepend(canvas);
    pv.renderedZoom = zoom;
    if (zoom !== this.zoom) this.schedule(pv);
  }

  // -------------------------------------------------------------- overlays

  private liveShape(id: string): Shape | undefined {
    const shape = this.store.find(id);
    if (!shape || this.store.state.deleted.includes(shape.page)) return undefined;
    return shape;
  }

  private renderAllOverlays(): void {
    for (const pv of this.pages) this.renderOverlay(pv);
  }

  private renderOverlay(pv: PageView): void {
    const z = this.zoom;
    const shapes = this.store.state.shapes.filter((s) => s.page === pv.index);
    const seen = new Set<string>();

    for (const shape of shapes) {
      seen.add(shape.id);
      let el = pv.shapeEls.get(shape.id);
      if (!el || el.dataset.kind !== shape.kind) {
        el?.remove();
        el = this.createShapeEl(shape);
        pv.shapeEls.set(shape.id, el);
        pv.overlay.append(el);
      }
      const selected = shape.id === this.selectedId;
      el.classList.toggle("selected", selected);
      el.classList.toggle("is-white", shape.color === "white");
      el.style.left = `${shape.x * z}px`;
      el.style.top = `${shape.y * z}px`;

      if (shape.kind === "box") {
        el.style.width = `${shape.w * z}px`;
        el.style.height = `${shape.h * z}px`;
        el.style.background = INK[shape.color];
      } else {
        const content = el.querySelector<HTMLElement>(".text-content")!;
        content.style.fontSize = `${shape.size * z}px`;
        content.style.color = INK[shape.color];
        if (this.editing?.id !== shape.id && content.textContent !== shape.text) {
          content.textContent = shape.text;
        }
      }
    }

    for (const [id, el] of pv.shapeEls) {
      if (!seen.has(id)) {
        el.remove();
        pv.shapeEls.delete(id);
      }
    }

    const rects = this.highlightRects.get(pv.index) ?? [];
    pv.highlights.replaceChildren(
      ...rects.map((r) => {
        const d = document.createElement("div");
        d.className = "hit";
        d.style.left = `${r.x * z}px`;
        d.style.top = `${r.y * z}px`;
        d.style.width = `${r.w * z}px`;
        d.style.height = `${r.h * z}px`;
        return d;
      }),
    );
  }

  private createShapeEl(shape: Shape): HTMLElement {
    const el = document.createElement("div");
    el.className = `shape ${shape.kind}`;
    el.dataset.shape = shape.id;
    el.dataset.kind = shape.kind;
    if (shape.kind === "text") {
      const content = document.createElement("div");
      content.className = "text-content";
      content.style.fontFamily = TEXT_FONT;
      content.style.lineHeight = String(TEXT_LINE_HEIGHT);
      content.spellcheck = false;
      el.append(content);
    } else {
      for (const h of ["nw", "ne", "sw", "se"] as const) {
        const handle = document.createElement("div");
        handle.className = `handle ${h}`;
        handle.dataset.handle = h;
        el.append(handle);
      }
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "shape-delete";
    del.dataset.action = "delete";
    del.setAttribute("aria-label", "Remove");
    del.innerHTML = icons.close;
    el.append(del);
    return el;
  }

  setHighlights(map: Map<number, Rect[]>): void {
    this.highlightRects = map;
    this.renderAllOverlays();
  }

  scrollToRect(page: number, rect: Rect): void {
    const pv = this.pages[page];
    if (!pv) return;
    const top = pv.root.offsetTop + rect.y * this.zoom - this.scroller.clientHeight / 3;
    this.scroller.scrollTo({ top, behavior: "smooth" });
  }

  // ------------------------------------------------------------- selection

  select(id: string | null): void {
    if (this.selectedId === id) return;
    if (this.editing && this.editing.id !== id) this.finishEditing();
    this.selectedId = id;
    this.renderAllOverlays();
    this.onSelectionChange(this.store.find(id));
  }

  get selected(): Shape | undefined {
    return this.liveShape(this.selectedId ?? "");
  }

  deleteSelected(): void {
    const id = this.selectedId;
    if (!id) return;
    this.finishEditing();
    if (!this.store.find(id)) return;
    this.store.commit((s) => {
      s.shapes = s.shapes.filter((sh) => sh.id !== id);
    });
    this.select(null);
  }

  nudge(dx: number, dy: number): void {
    const id = this.selectedId;
    if (!id || this.editing) return;
    this.store.commit((s) => {
      const sh = s.shapes.find((x) => x.id === id);
      if (sh) {
        sh.x += dx;
        sh.y += dy;
      }
    });
  }

  setSelectionColor(color: Color): void {
    const id = this.selectedId;
    if (!id) return;
    this.store.commit((s) => {
      const sh = s.shapes.find((x) => x.id === id);
      if (sh) sh.color = color;
    });
  }

  setSelectionTextSize(size: number): void {
    const shape = this.selected;
    if (shape?.kind !== "text") return;
    this.store.commit((s) => {
      const sh = s.shapes.find((x) => x.id === shape.id);
      if (sh?.kind === "text") sh.size = size;
    });
  }

  get isEditingText(): boolean {
    return this.editing !== null;
  }

  // -------------------------------------------------------------- pointers

  private toPage(e: PointerEvent, pv: PageView): { x: number; y: number } {
    const r = pv.overlay.getBoundingClientRect();
    return {
      x: Math.min(pv.size.w, Math.max(0, (e.clientX - r.left) / this.zoom)),
      y: Math.min(pv.size.h, Math.max(0, (e.clientY - r.top) / this.zoom)),
    };
  }

  private onPointerDown(e: PointerEvent, pv: PageView): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".text-content[contenteditable='plaintext-only'], .text-content[contenteditable='true']")) {
      return; // clicking inside the text being edited: let the caret move
    }
    this.finishEditing();
    e.preventDefault();

    const action = target.closest<HTMLElement>("[data-action]");
    const handle = target.closest<HTMLElement>("[data-handle]");
    let shapeEl = target.closest<HTMLElement>("[data-shape]");
    // In Text mode boxes are click-through, so you can type on top of a white-out.
    if (shapeEl && this.settings.tool === "text" && shapeEl.dataset.kind === "box" && !action && !handle) {
      shapeEl = null;
    }
    if (action && shapeEl) {
      this.select(shapeEl.dataset.shape ?? null);
      this.deleteSelected();
      return;
    }

    const pt = this.toPage(e, pv);
    pv.overlay.setPointerCapture(e.pointerId);

    if (handle && shapeEl) {
      const shape = this.store.find(shapeEl.dataset.shape ?? null);
      if (shape?.kind === "box") {
        this.drag = {
          type: "resize",
          pv,
          id: shape.id,
          handle: handle.dataset.handle as Handle,
          orig: { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
          before: this.store.snapshot(),
        };
      }
      return;
    }

    if (shapeEl) {
      const shape = this.store.find(shapeEl.dataset.shape ?? null);
      if (!shape) return;
      const wasSelected = this.selectedId === shape.id;
      this.select(shape.id);
      this.drag = {
        type: "move",
        pv,
        id: shape.id,
        sx: pt.x,
        sy: pt.y,
        ox: shape.x,
        oy: shape.y,
        before: this.store.snapshot(),
        moved: false,
        wasSelected,
      };
      return;
    }

    if (this.settings.tool === "box") {
      const before = this.store.snapshot();
      const shape: BoxShape = {
        id: uid(),
        kind: "box",
        page: pv.index,
        x: pt.x,
        y: pt.y,
        w: 0,
        h: 0,
        color: this.settings.color,
      };
      this.store.state.shapes.push(shape);
      this.drag = { type: "draw", pv, id: shape.id, ox: pt.x, oy: pt.y, before };
      this.selectedId = null;
      this.onSelectionChange(undefined);
      this.renderOverlay(pv);
      return;
    }

    // Text tool: drop a text box where they clicked and start typing.
    const size = this.settings.textSize;
    const shape: TextShape = {
      id: uid(),
      kind: "text",
      page: pv.index,
      x: pt.x,
      y: Math.max(0, pt.y - (size * TEXT_LINE_HEIGHT) / 2),
      text: "",
      size,
      color: this.settings.color,
    };
    this.store.commit((s) => {
      s.shapes.push(shape);
    });
    this.select(shape.id);
    this.editText(shape.id, true);
  }

  private onPointerMove(e: PointerEvent, pv: PageView): void {
    const d = this.drag;
    if (!d || d.pv !== pv) return;
    const pt = this.toPage(e, pv);
    const shape = this.store.find(d.id);
    if (!shape) return;

    if (d.type === "draw" && shape.kind === "box") {
      shape.x = Math.min(d.ox, pt.x);
      shape.y = Math.min(d.oy, pt.y);
      shape.w = Math.abs(pt.x - d.ox);
      shape.h = Math.abs(pt.y - d.oy);
    } else if (d.type === "move") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      if (!d.moved && Math.hypot(dx, dy) * this.zoom < 3) return;
      d.moved = true;
      shape.x = d.ox + dx;
      shape.y = d.oy + dy;
    } else if (d.type === "resize" && shape.kind === "box") {
      const o = d.orig;
      let x0 = o.x;
      let y0 = o.y;
      let x1 = o.x + o.w;
      let y1 = o.y + o.h;
      if (d.handle.includes("w")) x0 = pt.x;
      if (d.handle.includes("e")) x1 = pt.x;
      if (d.handle.includes("n")) y0 = pt.y;
      if (d.handle.includes("s")) y1 = pt.y;
      shape.x = Math.min(x0, x1);
      shape.y = Math.min(y0, y1);
      shape.w = Math.max(MIN_BOX, Math.abs(x1 - x0));
      shape.h = Math.max(MIN_BOX, Math.abs(y1 - y0));
    }
    this.renderOverlay(pv);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.pv.overlay.hasPointerCapture(e.pointerId)) d.pv.overlay.releasePointerCapture(e.pointerId);
    const shape = this.store.find(d.id);

    if (d.type === "draw") {
      if (!shape || shape.kind !== "box" || shape.w < MIN_BOX || shape.h < MIN_BOX) {
        this.store.revert(d.before); // a click, not a drag: nothing to keep
        return;
      }
      this.store.record(d.before);
      this.select(shape.id);
      return;
    }

    if (d.type === "move" && !d.moved) {
      if (d.wasSelected && shape?.kind === "text") this.editText(shape.id, false);
      return;
    }

    this.store.record(d.before);
  }

  // ----------------------------------------------------------- text editing

  editText(id: string, isNew: boolean): void {
    const shape = this.store.find(id);
    if (shape?.kind !== "text") return;
    if (this.editing?.id === id) return;
    this.finishEditing();
    this.select(id);
    const pv = this.pages[shape.page];
    const el = pv?.shapeEls.get(id)?.querySelector<HTMLElement>(".text-content");
    if (!el) return;

    // When the text was just created, its creation is already one undo step.
    this.editing = { id, isNew, before: this.store.snapshot(), el };
    el.contentEditable = supportsPlaintextOnly() ? "plaintext-only" : "true";
    el.parentElement?.classList.add("editing");
    el.addEventListener("input", this.onTextInput);
    el.addEventListener("blur", this.onTextBlur);
    el.addEventListener("keydown", this.onTextKey);
    if (!supportsPlaintextOnly()) el.addEventListener("paste", pastePlain);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (isNew) range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private onTextInput = () => {
    const ed = this.editing;
    if (!ed) return;
    const shape = this.store.find(ed.id);
    if (shape?.kind === "text") shape.text = readText(ed.el);
  };

  private onTextBlur = () => {
    this.finishEditing();
  };

  private onTextKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finishEditing();
    }
  };

  finishEditing(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.el.removeEventListener("input", this.onTextInput);
    ed.el.removeEventListener("blur", this.onTextBlur);
    ed.el.removeEventListener("keydown", this.onTextKey);
    ed.el.removeEventListener("paste", pastePlain);
    ed.el.contentEditable = "false";
    ed.el.parentElement?.classList.remove("editing");
    window.getSelection()?.removeAllRanges();

    const shape = this.store.find(ed.id);
    if (shape?.kind !== "text") return;
    shape.text = readText(ed.el).replace(/\s+$/, "");

    if (!shape.text.trim()) {
      if (ed.isNew) {
        this.store.rollbackLast(); // never typed anything: leave no trace in history
      } else {
        this.store.state.shapes = this.store.state.shapes.filter((s) => s.id !== ed.id);
        this.store.record(ed.before);
      }
      return;
    }
    if (ed.isNew) this.store.notify();
    else this.store.record(ed.before);
  }

  // ----------------------------------------------------------------- pages

  private deletePage(pv: PageView): void {
    const deleted = new Set(this.store.state.deleted);
    const live = this.pages.filter((p) => !deleted.has(p.index));
    if (live.length <= 1) return;
    const number = live.indexOf(pv) + 1;
    this.finishEditing();
    this.store.commit((s) => {
      s.deleted.push(pv.index);
    });
    this.onPageDeleted(number);
  }
}

let plaintextOnly: boolean | null = null;
function supportsPlaintextOnly(): boolean {
  if (plaintextOnly === null) {
    const d = document.createElement("div");
    try {
      d.contentEditable = "plaintext-only";
      plaintextOnly = d.contentEditable === "plaintext-only";
    } catch {
      plaintextOnly = false;
    }
  }
  return plaintextOnly;
}

function readText(el: HTMLElement): string {
  return el.innerText.replace(/ /g, " ");
}

function pastePlain(e: ClipboardEvent): void {
  e.preventDefault();
  const text = e.clipboardData?.getData("text/plain") ?? "";
  document.execCommand("insertText", false, text);
}
