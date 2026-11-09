import type { PDFDocumentProxy } from "pdfjs-dist";
import { faceBytes } from "./docfonts";
import { extractPages, type Line, type Run } from "./extract";
import { HAND_STYLES, handFontBytes, type HandGroup } from "./handfonts";
import { handoffButton } from "./handoff";
import { handwrite, type HwArt, type HwBlock, type HwResult, type HwRun, type Paper } from "./handwriting";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { ocrPage, ocrToLines } from "./ocr";
import { openPdf, pageSizes } from "./pdf";
import { ArtShelf, scanPage, tint, type Art } from "./scan";
import { INKS, type Ink } from "./signature";
import { closeSource, loadSource, type PdfSource } from "./source";
import { joinPages, measure, pageBlocks, runningLines } from "./structure";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Neat and easy to read, so it's the one to start with. */
const DEFAULT_FONT = "Patrick Hand";

type Size = "same" | "a4" | "letter";
const SIZES: Record<Exclude<Size, "same">, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};
const GROUPS: Record<HandGroup, string> = { clear: "Clear", natural: "Natural", fancy: "Fancy", showpiece: "Showpiece" };

/**
 * The document's text in reading order, as headings, paragraphs, list items
 * and tables, with display equations and figures as blocks of their own.
 * Running headers and footers are left out, and paragraphs split by a page
 * break are joined back up, since the handwritten pages break elsewhere.
 */
function documentBlocks(layouts: Line[][], arts: Map<string, Art>): HwBlock[] {
  const running = runningLines(layouts);
  const body = layouts.map((lines, i) => lines.filter((l) => !running.skip[i].has(l)));
  const stats = measure(body);
  const own = (ch: string) => {
    const a = arts.get(ch);
    return a !== undefined && a.kind !== "inline";
  };
  const out: HwBlock[] = [];
  /** Text with display equations and figures in it, split around them. */
  const split = (runs: Run[], make: (runs: HwRun[], first: boolean) => HwBlock) => {
    let cur: HwRun[] = [];
    let first = true;
    const flush = () => {
      const text = cur.map((r) => r.text).join("");
      if (text.trim()) {
        // No stray spaces where an equation was lifted out.
        cur[0] = { ...cur[0], text: cur[0].text.replace(/^\s+/, "") };
        const last = cur.length - 1;
        cur[last] = { ...cur[last], text: cur[last].text.replace(/\s+$/, "") };
        out.push(make(cur, first));
        first = false;
      }
      cur = [];
    };
    for (const run of runs) {
      let text = "";
      for (const ch of run.text) {
        if (own(ch)) {
          if (text) cur.push({ ...run, text });
          text = "";
          flush();
          out.push({ kind: "art", id: ch });
        } else text += ch;
      }
      if (text) cur.push({ ...run, text });
    }
    flush();
  };
  for (const b of joinPages(body.map((lines) => pageBlocks(lines, stats)))) {
    if (b.kind === "h") split([{ text: b.text, bold: false, italic: false }], (runs) => ({ kind: "h", level: b.level, text: runs.map((r) => r.text).join("") }));
    else if (b.kind === "li") split(b.runs, (runs, first) => (first ? { kind: "li", number: b.number, runs } : { kind: "p", runs }));
    else if (b.kind === "table") out.push({ kind: "table", rows: b.rows });
    else split(b.runs, (runs) => ({ kind: "p", runs }));
  }
  return out;
}

/**
 * PDF to handwriting: write a PDF's text out by hand, in a handwriting font,
 * on lined, squared, dotted or blank paper at the size you pick. Equations
 * keep their look, redrawn in the pen's colour; figures are copied over as
 * they are. The result is a new PDF; the preview is that PDF itself, so
 * what's shown is what downloads.
 */
export class HandTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private layouts: Line[][] = [];
  private blocks: HwBlock[] = [];
  private shelf = new ArtShelf();
  /** Equations in each ink, made once. */
  private tinted = new Map<string, Promise<Uint8Array>>();
  private font = DEFAULT_FONT;
  private ink: Ink = "blue";
  private paper: Paper = "lined";
  private size: Size = "same";
  private result: HwResult | null = null;
  /** The finished PDF, opened for the preview. */
  private shown: PDFDocumentProxy | null = null;
  private ocred: number[] = [];
  private run = 0;
  private writing = false;
  private timer = 0;
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private notice: HTMLElement;
  private status: HTMLElement;
  private goBtn: HTMLButtonElement;
  private fontBtn: HTMLButtonElement;
  private fontList: HTMLElement;
  private input: HTMLInputElement;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "hand-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-name></span>
        </div>
        <div class="tb-group tb-right" data-actions>
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl"> PDF</span></span></button>
        </div>
      </header>
      <div class="findbar optbar hw-opts" data-opts hidden>
        <div class="hw-picker">
          <button type="button" class="hw-pick" data-font-btn aria-haspopup="listbox" aria-expanded="false">
            <span class="hw-pick-name" data-font-name></span>${icons.chevron}
          </button>
          <div class="menu hw-fonts" role="listbox" tabindex="-1" aria-label="Font" data-font-list hidden>
            ${(Object.keys(GROUPS) as HandGroup[])
              .map(
                (g) =>
                  `<p class="menu-head" role="presentation">${GROUPS[g]}</p>` +
                  HAND_STYLES.filter((s) => s.group === g)
                    .map(
                      (s) =>
                        `<button type="button" role="option" class="hw-opt" data-family="${s.family}" style="font-family: '${s.family}'" aria-selected="false">${s.family}</button>`,
                    )
                    .join(""),
              )
              .join("")}
          </div>
        </div>
        <div class="seg swatches" role="radiogroup" aria-label="Ink">
          ${(Object.keys(INKS) as Ink[])
            .map(
              (k) =>
                `<button type="button" role="radio" data-ink="${k}" title="${INKS[k].label} ink" aria-label="${INKS[k].label} ink"><i class="sw" style="background: rgb(${INKS[k].color.join(",")})"></i></button>`,
            )
            .join("")}
        </div>
        <div class="seg" role="radiogroup" aria-label="Paper">
          <button type="button" role="radio" data-paper="lined" title="Notebook paper with ruled lines">Lined</button>
          <button type="button" role="radio" data-paper="grid" title="Squared paper">Grid</button>
          <button type="button" role="radio" data-paper="dots" title="Dot grid">Dots</button>
          <button type="button" role="radio" data-paper="blank" title="Plain white paper">Blank</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="Page size">
          <button type="button" role="radio" data-size="same" title="The same size as the original PDF's pages">Same size</button>
          <button type="button" role="radio" data-size="a4">A4</button>
          <button type="button" role="radio" data-size="letter">Letter</button>
        </div>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">PDF to handwriting</h1>
          <p class="tool-sub">Write a PDF out by hand as a new PDF: pick a handwriting, an ink, and lined, squared, dotted or blank paper. Equations keep their look in your ink, and figures come across as they are.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.handwriting}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="hw-result" data-result hidden>
          <p class="notice" data-notice hidden></p>
          <div class="hw-pages" data-pages></div>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.pagesEl = q("[data-pages]");
    this.notice = q("[data-notice]");
    this.status = q("[data-status]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.fontBtn = q<HTMLButtonElement>("[data-font-btn]");
    this.fontList = q("[data-font-list]");
    this.input = q<HTMLInputElement>("input[type=file]");
    const width = Math.min(760, window.innerWidth - 32);
    this.thumbs = new Thumbs(this.scroller, { w: width, h: width * 2 });

    q("[data-actions]").prepend(
      handoffButton({
        label: "Continue with",
        count: () => 1,
        pick: (t) => {
          const file = this.file();
          if (file) this.host.openIn(t, [file]);
        },
      }),
    );
    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => this.download());
    this.setupFontPicker();
    const choose = <K extends "ink" | "paper" | "size">(attr: K, set: (v: string) => void) =>
      this.root.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`).forEach((b) =>
        b.addEventListener("click", () => {
          set(b.dataset[attr]!);
          this.rebuild();
        }),
      );
    choose("ink", (v) => (this.ink = v as Ink));
    choose("paper", (v) => (this.paper = v as Paper));
    choose("size", (v) => (this.size = v as Size));
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `${this.src.name} by hand - HackerPDF` : "PDF to handwriting - HackerPDF";
  }

  close(): void {
    this.active = false;
    this.closeFonts(false);
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
      src = await loadSource(file, { fontNames: true });
    } catch {
      showBusy(null);
      toast("This PDF couldn't be opened.", "The file may be damaged or not really a PDF.");
      return;
    }
    if (!src) {
      showBusy(null);
      return;
    }
    const shelf = new ArtShelf();
    let layouts: Line[][];
    try {
      layouts = await extractPages(src.doc, {
        fonts: true,
        onProgress: (done, total) => showBusy(`Reading page ${done} of ${total}`),
        // Equations and figures come out of the text here, kept as they look.
        prepare: (page, items, nameOf, index) => scanPage(page, items, nameOf, index, shelf),
      });
    } catch (err) {
      console.error(err);
      closeSource(src);
      showBusy(null);
      toast("The text couldn't be read.", "The file may be damaged. Try opening it again.");
      return;
    }
    if (!this.active) {
      closeSource(src);
      showBusy(null);
      return;
    }
    this.reset();
    this.src = src;
    this.shelf = shelf;
    this.layouts = layouts;
    this.blocks = documentBlocks(layouts, shelf.arts);
    document.title = `${src.name} by hand - HackerPDF`;
    this.sync();
    this.scroller.scrollTop = 0;
    if (this.blocks.length) await this.build(true);
    else showBusy(null);
    this.renderNotice();
  }

  download(): void {
    const file = this.file();
    if (!file || this.goBtn.disabled) return;
    saveFile(file, file.name);
    toast(`Downloaded ${file.name}`, `${plural(this.result!.pages, "page")} in ${this.font}.`);
  }

  // ------------------------------------------------------------- font picker

  private setupFontPicker(): void {
    const options = () => [...this.fontList.querySelectorAll<HTMLButtonElement>("[role=option]")];
    this.fontBtn.addEventListener("click", () => (this.fontList.hidden ? this.openFonts() : this.closeFonts(true)));
    this.fontBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.openFonts();
      }
    });
    this.fontList.addEventListener("click", (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=option]");
      if (!opt) return;
      this.font = opt.dataset.family!;
      this.closeFonts(true);
      this.rebuild();
    });
    this.fontList.addEventListener("keydown", (e) => {
      const list = options();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const go = (i: number) => {
        e.preventDefault();
        list[Math.max(0, Math.min(list.length - 1, i))]?.focus();
      };
      if (e.key === "ArrowDown") go(at + 1);
      else if (e.key === "ArrowUp") go(at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(list.length - 1);
      else if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") e.preventDefault();
        this.closeFonts(e.key === "Escape");
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.fontList.hidden && !(e.target as HTMLElement).closest(".hw-picker")) this.closeFonts(false);
    });
  }

  private openFonts(): void {
    this.fontList.hidden = false;
    this.fontBtn.setAttribute("aria-expanded", "true");
    const current = this.fontList.querySelector<HTMLButtonElement>(`[data-family="${this.font}"]`);
    current?.focus();
    current?.scrollIntoView({ block: "center" });
  }

  private closeFonts(refocus: boolean): void {
    if (this.fontList.hidden) return;
    this.fontList.hidden = true;
    this.fontBtn.setAttribute("aria-expanded", "false");
    if (refocus) this.fontBtn.focus();
  }

  // ------------------------------------------------------------- internals

  private file(): File | null {
    if (!this.src || !this.result) return null;
    const name = `${baseName(this.src.name)}-handwritten.pdf`;
    return new File([this.result.bytes as BlobPart], name, { type: "application/pdf" });
  }

  /** Write it out again after a setting changes; quick changes in a row make one rebuild. */
  private rebuild(): void {
    this.sync();
    if (!this.src || !this.blocks.length) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.build(false), 120);
  }

  /** The equations and figures in the form the writer takes, equations in the current ink. */
  private async arts(): Promise<Map<string, HwArt>> {
    const out = new Map<string, HwArt>();
    const color = INKS[this.ink].color;
    await Promise.all(
      [...this.shelf.arts].map(async ([ch, a]) => {
        const w = a.box[2] - a.box[0];
        const h = a.box[3] - a.box[1];
        if (a.kind === "figure") {
          out.set(ch, { kind: "figure", page: a.page, pdfBox: a.pdfBox, png: a.png ?? new Uint8Array(), w, h });
          return;
        }
        const key = `${this.ink}:${ch}`;
        let png = this.tinted.get(key);
        if (!png) {
          png = tint(a, color);
          this.tinted.set(key, png);
        }
        out.set(ch, { kind: a.kind, png: await png, w, h, base: a.base, size: a.size });
      }),
    );
    return out;
  }

  private async build(first: boolean): Promise<void> {
    const src = this.src;
    if (!src) return;
    const run = ++this.run;
    this.writing = true;
    this.sync();
    if (first) showBusy("Writing it out");
    try {
      const [hand, fallback, arts] = await Promise.all([
        handFontBytes(this.font),
        // A plain font for letters the handwriting lacks (bullets, other alphabets). Optional.
        faceBytes({ family: "Carlito", bold: false, italic: false }).catch(() => undefined),
        this.arts(),
      ]);
      const page = this.size === "same" ? (src.sizes[0] ?? SIZES.a4) : SIZES[this.size];
      const result = await handwrite(
        this.blocks,
        { hand: hand.regular, bold: hand.bold, fallback },
        { paper: this.paper, ink: INKS[this.ink].color, page },
        { arts, source: src.bytes },
      );
      if (run !== this.run || this.src !== src) return;
      const { doc } = await openPdf(result.bytes, async () => null);
      if (run !== this.run || this.src !== src) {
        void doc.loadingTask.destroy();
        return;
      }
      this.result = result;
      this.show(doc, await pageSizes(doc));
    } catch (err) {
      console.error(err);
      if (run === this.run) toast("It couldn't be written out.", "Try another font, or open the file again.");
    } finally {
      if (run === this.run) {
        this.writing = false;
        if (first) showBusy(null);
        this.renderNotice();
        this.sync();
      }
    }
  }

  /** Swap the preview for the new pages, keeping the scroll position. */
  private show(doc: PDFDocumentProxy, sizes: { w: number; h: number }[]): void {
    const top = this.scroller.scrollTop;
    this.thumbs.clear();
    if (this.shown) void this.shown.loadingTask.destroy();
    this.shown = doc;
    const shown: PdfSource = { id: "hw", name: "", bytes: new Uint8Array(), doc, sizes };
    this.pagesEl.replaceChildren(...sizes.map((_, i) => this.thumbs.sheet(shown, i)));
    this.scroller.scrollTop = top;
  }

  private renderNotice(): void {
    this.notice.replaceChildren();
    const empty = this.layouts.flatMap((l, i) => (l.length || this.ocred.includes(i) ? [] : [i]));
    if (!this.blocks.length) {
      this.notice.append(
        "No text found. This PDF is probably scanned pages or images: pictures of letters rather than letters. OCR can read them.",
      );
    } else if (empty.length) {
      this.notice.append(
        `${plural(empty.length, "page")} had no text to write out, probably because ${empty.length === 1 ? "it's a scan" : "they're scans"}. OCR can read ${empty.length === 1 ? "it" : "them"}.`,
      );
    }
    if (empty.length) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn notice-btn";
      b.innerHTML = `${icons.scan}<span>Read with OCR</span>`;
      b.addEventListener("click", () => void this.runOcr(empty));
      this.notice.append(b);
    }
    const missing = this.result?.missing ?? [];
    if (missing.length && this.blocks.length) {
      const p = document.createElement("span");
      p.className = "hw-missing";
      const shown = missing.slice(0, 12).join(" ");
      p.textContent = `Some characters aren't in any of the fonts, so they were left out: ${shown}${missing.length > 12 ? " …" : ""}`;
      this.notice.append(p);
    }
    this.notice.hidden = !this.notice.firstChild;
  }

  /** Read the pages with no text with OCR, then write the document out again. */
  private async runOcr(pages: number[]): Promise<void> {
    const src = this.src;
    if (!src) return;
    try {
      for (const [k, i] of pages.entries()) {
        showBusy(`Reading page ${i + 1} (${k + 1} of ${pages.length})`);
        const res = await ocrPage(src.doc, i, (t) => showBusy(t));
        if (this.src !== src) return;
        this.layouts[i] = ocrToLines(res);
        this.ocred.push(i);
      }
    } catch (err) {
      console.error(err);
      toast("The scanned pages couldn't be read.", "Try again. If it keeps failing, the file may be damaged.");
    } finally {
      showBusy(null);
    }
    this.blocks = documentBlocks(this.layouts, this.shelf.arts);
    this.sync();
    if (this.blocks.length) await this.build(true);
    else this.renderNotice();
  }

  private reset(): void {
    this.run += 1;
    this.writing = false;
    window.clearTimeout(this.timer);
    this.thumbs.clear();
    this.pagesEl.replaceChildren();
    if (this.shown) void this.shown.loadingTask.destroy();
    this.shown = null;
    if (this.src) closeSource(this.src);
    this.src = null;
    this.layouts = [];
    this.blocks = [];
    this.shelf = new ArtShelf();
    this.tinted.clear();
    this.result = null;
    this.ocred = [];
    this.notice.hidden = true;
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    q("[data-empty]").hidden = src !== null;
    q("[data-result]").hidden = src === null;
    q("[data-opts]").hidden = !src || !this.blocks.length;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "PDF to handwriting";
    nameEl.title = src?.name ?? "";
    for (const attr of ["ink", "paper", "size"] as const) {
      const value = this[attr];
      this.root.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`).forEach((b) => {
        b.setAttribute("aria-checked", String(b.dataset[attr] === value));
      });
    }
    // The font's name, written in the font.
    const name = q("[data-font-name]");
    name.textContent = this.font;
    name.style.fontFamily = `'${this.font}', var(--font)`;
    this.fontBtn.setAttribute("aria-label", `Font: ${this.font}`);
    this.fontList.querySelectorAll<HTMLElement>("[role=option]").forEach((o) => {
      o.setAttribute("aria-selected", String(o.dataset.family === this.font));
    });
    const ready = src !== null && this.result !== null && !this.writing;
    this.goBtn.disabled = !ready;
    this.goBtn.title = !src ? "Choose a PDF first" : !this.blocks.length ? "This PDF has no text to write out" : "Download (Ctrl S)";
    this.status.textContent = this.writing ? "Writing…" : ready ? plural(this.result!.pages, "page") : "";
  }
}
