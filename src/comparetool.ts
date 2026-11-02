import type { PDFDocumentProxy } from "pdfjs-dist";
import { alignPages, changedRegions, diffWords, type Box, type Op, type PagePair } from "./diff";
import { extractPages, layoutText } from "./extract";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { isPdf, showBusy, toast } from "./ui";

type Side = "a" | "b";
type View = "pages" | "text";
type State = "pending" | "same" | "changed" | "added" | "removed";

interface Row {
  pair: PagePair;
  ops: Op[] | null;
  textChanged: boolean;
  state: State;
  el: HTMLElement;
  boxes: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Compare two versions of a PDF: changed regions highlighted on each pair of
 * pages, and a word-by-word text diff. Pages are matched by their text first,
 * so an added or removed page doesn't throw off everything after it.
 */
export class CompareTool {
  readonly root: HTMLElement;
  private files: Record<Side, PdfSource | null> = { a: null, b: null };
  private texts: Record<Side, string[]> = { a: [], b: [] };
  private rows: Row[] = [];
  private view: View = "pages";
  private run = 0;
  private checked = 0;
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private textEl: HTMLElement;
  private onlyChanges: HTMLInputElement;
  private inputs: Record<Side, HTMLInputElement>;
  private width: number;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "compare-tool";
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
          <button type="button" class="btn" data-again hidden>${icons.back}<span class="lbl">Other files</span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <div class="seg" role="radiogroup" aria-label="What to compare">
          <button type="button" role="radio" data-view="pages">Pages</button>
          <button type="button" role="radio" data-view="text">Text</button>
        </div>
        <label class="check inline">
          <input type="checkbox" data-only checked />
          <span><strong>Only changes</strong></span>
        </label>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Compare</h1>
          <p class="tool-sub">Find every difference between two versions of a PDF, highlighted on the pages and word by word.</p>
          <div class="cmpr-picks">
            <button type="button" class="drop-card" data-pick="a">${icons.file}<span><strong data-label="a">Original</strong><small data-file="a">Choose the older version</small></span></button>
            <button type="button" class="drop-card" data-pick="b">${icons.file}<span><strong data-label="b">Changed</strong><small data-file="b">Choose the newer version</small></span></button>
          </div>
          <p class="hint cmpr-hint">Or drop both PDFs on this page.</p>
        </div>
        <div class="cmpr-pages" data-pages hidden></div>
        <div class="tool-body wide cmpr-text" data-text hidden></div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden data-input="a" />
      <input type="file" accept="application/pdf,.pdf" hidden data-input="b" />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.pagesEl = q("[data-pages]");
    this.textEl = q("[data-text]");
    this.onlyChanges = q<HTMLInputElement>("[data-only]");
    this.inputs = { a: q<HTMLInputElement>('[data-input="a"]'), b: q<HTMLInputElement>('[data-input="b"]') };
    const small = window.matchMedia("(max-width: 520px)").matches;
    this.width = small ? 170 : 380;
    this.thumbs = new Thumbs(this.scroller, { w: this.width, h: this.width * 1.42 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-again]").addEventListener("click", () => this.reset());
    for (const side of ["a", "b"] as Side[]) {
      q(`[data-pick="${side}"]`).addEventListener("click", () => this.inputs[side].click());
      this.inputs[side].addEventListener("change", () => {
        const f = this.inputs[side].files?.[0];
        this.inputs[side].value = "";
        if (f) void this.set(side, f);
      });
    }
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        this.view = b.dataset.view as View;
        this.sync();
      }),
    );
    this.onlyChanges.addEventListener("change", () => this.sync());
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = "Compare - HackerPDF";
  }

  close(): void {
    this.active = false;
    this.reset();
  }

  pick(): void {
    this.inputs[this.files.a ? "b" : "a"].click();
  }

  /** A PDF dropped or picked without a side: it fills whichever side is free. */
  async load(file: File): Promise<void> {
    await this.set(this.files.a && !this.files.b ? "b" : "a", file);
  }

  /** Several PDFs dropped at once: the first two become original and changed. */
  async add(files: File[]): Promise<void> {
    const pdfs = files.filter(isPdf);
    if (pdfs.length >= 2) {
      this.reset();
      await this.set("a", pdfs[0], false);
      await this.set("b", pdfs[1]);
    } else if (pdfs[0]) await this.load(pdfs[0]);
    else toast("That file isn't a PDF.", "Choose a file that ends in .pdf.");
  }

  download(): void {
    // Nothing to download: the comparison is the result.
  }

  // ------------------------------------------------------------- internals

  private async set(side: Side, file: File, start = true): Promise<void> {
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
    if (this.rows.length) this.reset();
    const old = this.files[side];
    if (old) closeSource(old);
    this.files[side] = src;
    this.sync();
    if (start && this.files.a && this.files.b) await this.compare();
  }

  private async compare(): Promise<void> {
    const a = this.files.a!;
    const b = this.files.b!;
    const run = ++this.run;
    showBusy("Reading both files");
    try {
      const [la, lb] = [await extractPages(a.doc), await extractPages(b.doc)];
      this.texts = { a: la.map(layoutText), b: lb.map(layoutText) };
    } catch (err) {
      console.error(err);
      toast("The files couldn't be read.", "One of them may be damaged.");
      return;
    } finally {
      showBusy(null);
    }
    if (run !== this.run) return;

    const pairs = alignPages(this.texts.a, this.texts.b);
    this.rows = pairs.map((pair) => {
      const ta = pair.a === null ? "" : this.texts.a[pair.a];
      const tb = pair.b === null ? "" : this.texts.b[pair.b];
      const ops = pair.a !== null && pair.b !== null ? diffWords(ta, tb) : null;
      const textChanged = ops ? ops.some((o) => o.kind !== "same" && o.text.trim()) : true;
      const state: State = pair.a === null ? "added" : pair.b === null ? "removed" : "pending";
      return { pair, ops, textChanged, state, el: this.rowEl(pair, state), boxes: 0 };
    });
    this.pagesEl.replaceChildren(...this.rows.map((r) => r.el));
    this.checked = 0;
    this.renderText();
    this.scroller.scrollTop = 0;
    this.sync();

    // Check each pair of pages visually, one at a time.
    for (const row of this.rows) {
      if (run !== this.run) return;
      await this.check(row);
      this.checked += 1;
      this.sync();
    }
  }

  private rowEl(pair: PagePair, state: State): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "cmpr-row";
    const head = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent =
      pair.a === null
        ? `Page ${pair.b! + 1} added`
        : pair.b === null
          ? `Page ${pair.a + 1} removed`
          : pair.a === pair.b
            ? `Page ${pair.a + 1}`
            : `Page ${pair.a + 1} → ${pair.b + 1}`;
    const badge = document.createElement("span");
    badge.className = "cmpr-badge";
    head.append(title, badge);
    const sides = document.createElement("div");
    sides.className = "cmpr-pair";
    for (const side of ["a", "b"] as Side[]) {
      const cell = document.createElement("div");
      cell.className = "cmpr-side";
      cell.dataset.side = side;
      sides.append(cell);
    }
    sec.append(head, sides);
    sec.dataset.state = state;
    return sec;
  }

  /** Render both pages at the same width, mark where they differ, and keep the pictures only if they do. */
  private async check(row: Row): Promise<void> {
    const { a, b } = row.pair;
    const dpr = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
    const px = Math.round(this.width * dpr);
    const ca = a === null ? null : await render(this.files.a!.doc, a, px);
    const cb = b === null ? null : await render(this.files.b!.doc, b, px);

    let boxes: Box[] = [];
    let sizeChanged = false;
    if (ca && cb) {
      sizeChanged = Math.abs(ca.height - cb.height) > 2;
      const ga = ca.getContext("2d", { willReadFrequently: true })!;
      const gb = cb.getContext("2d", { willReadFrequently: true })!;
      const h = Math.min(ca.height, cb.height);
      boxes = changedRegions(ga.getImageData(0, 0, ca.width, h), gb.getImageData(0, 0, cb.width, h));
    }
    row.boxes = boxes.length;
    if (row.state === "pending") row.state = boxes.length || row.textChanged || sizeChanged ? "changed" : "same";
    row.el.dataset.state = row.state;
    const badge = row.el.querySelector(".cmpr-badge")!;
    badge.textContent =
      row.state === "same"
        ? "Same"
        : row.state === "added"
          ? "Only in changed"
          : row.state === "removed"
            ? "Only in original"
            : sizeChanged
              ? "Page size changed"
              : boxes.length
                ? plural(boxes.length, "change")
                : "Text changed";

    const cells = row.el.querySelectorAll<HTMLElement>(".cmpr-side");
    if (row.state === "same") {
      // Identical: drop the full-size renders and show light thumbnails if asked to.
      for (const [k, side] of (["a", "b"] as Side[]).entries()) {
        cells[k].replaceChildren(this.thumbs.sheet(this.files[side]!, (side === "a" ? a : b)!));
      }
      return;
    }
    for (const [k, canvas] of [ca, cb].entries()) {
      const cell = cells[k];
      if (!canvas) {
        cell.classList.add("missing");
        continue;
      }
      const g = canvas.getContext("2d")!;
      g.lineWidth = Math.max(2, dpr * 1.5);
      for (const box of boxes) {
        g.fillStyle = "rgba(255, 59, 48, 0.12)";
        g.fillRect(box.x, box.y, box.w, box.h);
        g.strokeStyle = "rgba(255, 59, 48, 0.9)";
        g.strokeRect(box.x, box.y, box.w, box.h);
      }
      canvas.className = "cmpr-canvas";
      cell.replaceChildren(canvas);
    }
  }

  private renderText(): void {
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const row of this.rows) {
      const { a, b } = row.pair;
      const ops: Op[] =
        row.ops ?? (a === null ? [{ kind: "ins", text: this.texts.b[b!] }] : [{ kind: "del", text: this.texts.a[a] }]);
      if (!ops.some((o) => o.kind !== "same" && o.text.trim())) continue;
      shown += 1;
      const sec = document.createElement("section");
      sec.className = "cmpr-tblock";
      const h = document.createElement("h3");
      h.textContent = row.el.querySelector("header strong")!.textContent;
      const body = document.createElement("p");
      body.className = "cmpr-diff";
      ops.forEach((op, i) => body.append(opNode(op, i === 0, i === ops.length - 1)));
      sec.append(h, body);
      frag.append(sec);
    }
    if (!shown) {
      const p = document.createElement("p");
      p.className = "notice";
      p.textContent = "The text is the same in both files. Any differences are in images or layout: see Pages.";
      frag.append(p);
    }
    this.textEl.replaceChildren(frag);
  }

  private reset(): void {
    this.run += 1;
    for (const side of ["a", "b"] as Side[]) {
      const f = this.files[side];
      if (f) closeSource(f);
      this.files[side] = null;
    }
    this.texts = { a: [], b: [] };
    this.rows = [];
    this.checked = 0;
    this.thumbs.clear();
    this.pagesEl.replaceChildren();
    this.textEl.replaceChildren();
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const ready = this.rows.length > 0;
    q("[data-empty]").hidden = ready;
    q("[data-opts]").hidden = !ready;
    q("[data-again]").hidden = !ready;
    this.pagesEl.hidden = !ready || this.view !== "pages";
    this.textEl.hidden = !ready || this.view !== "text";
    this.pagesEl.classList.toggle("only-changes", this.onlyChanges.checked);
    q("[data-only]").closest("label")!.hidden = this.view !== "pages";
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.view === this.view));
    });
    for (const side of ["a", "b"] as Side[]) {
      const f = this.files[side];
      q(`[data-file="${side}"]`).textContent = f
        ? f.name
        : side === "a"
          ? "Choose the older version"
          : "Choose the newer version";
      q(`[data-pick="${side}"]`).classList.toggle("chosen", !!f);
    }
    const { a, b } = this.files;
    q("[data-name]").textContent = a && b ? `${a.name}  ↔  ${b.name}` : "Compare";

    let status = "";
    if (ready) {
      const changed = this.rows.filter((r) => r.state === "changed").length;
      const added = this.rows.filter((r) => r.state === "added").length;
      const removed = this.rows.filter((r) => r.state === "removed").length;
      if (this.checked < this.rows.length) status = `Checking page ${this.checked + 1} of ${this.rows.length}…`;
      else if (!changed && !added && !removed) status = "No differences found";
      else {
        const parts = [
          changed && `${plural(changed, "page")} changed`,
          added && `${added} added`,
          removed && `${removed} removed`,
        ];
        status = parts.filter(Boolean).join(", ");
      }
    }
    q("[data-status]").textContent = status;
  }
}

async function render(doc: PDFDocumentProxy, index: number, width: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/** One diff run as text, with long unchanged stretches cut down to a little context. */
function opNode(op: Op, first: boolean, last: boolean): Node {
  if (op.kind === "same") {
    const t = op.text.replace(/\s+/g, " ");
    const keep = 70;
    if (t.length <= keep * 2 + 20) return document.createTextNode(t);
    const head = first ? "" : t.slice(0, keep).replace(/\S*$/, "");
    const tail = last ? "" : t.slice(-keep).replace(/^\S*/, "");
    const span = document.createElement("span");
    span.append(head);
    const gap = document.createElement("span");
    gap.className = "cmpr-gap";
    gap.textContent = " … ";
    span.append(gap, tail);
    return span;
  }
  const el = document.createElement(op.kind === "del" ? "del" : "ins");
  el.textContent = op.text.replace(/\s+/g, " ");
  return el;
}
