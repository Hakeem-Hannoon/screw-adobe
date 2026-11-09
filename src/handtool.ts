import type { PDFDocumentProxy } from "pdfjs-dist";
import { faceBytes } from "./docfonts";
import { extractPages, type Line } from "./extract";
import { handFontBytes } from "./handfonts";
import { handoffButton } from "./handoff";
import { handwrite, type HwBlock, type HwResult, type Paper } from "./handwriting";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { ocrPage, ocrToLines } from "./ocr";
import { openPdf, pageSizes } from "./pdf";
import { INKS, STYLES, type Ink } from "./signature";
import { closeSource, loadSource, type PdfSource } from "./source";
import { joinPages, measure, pageBlocks, runningLines } from "./structure";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Easy to read at body size, so it's the one to start with. */
const DEFAULT_FONT = "Nothing You Could Do";

/**
 * The document's text in reading order, as headings, paragraphs, list items
 * and tables. Running headers and footers are left out, and paragraphs split
 * by a page break are joined back up, since the handwritten pages break in
 * different places.
 */
function documentBlocks(layouts: Line[][]): HwBlock[] {
  const running = runningLines(layouts);
  const body = layouts.map((lines, i) => lines.filter((l) => !running.skip[i].has(l)));
  const stats = measure(body);
  return joinPages(body.map((lines) => pageBlocks(lines, stats))).map((b): HwBlock => {
    if (b.kind === "h") return { kind: "h", level: b.level, text: b.text };
    if (b.kind === "li") return { kind: "li", number: b.number, runs: b.runs };
    if (b.kind === "table") return { kind: "table", rows: b.rows };
    return { kind: "p", runs: b.runs };
  });
}

/**
 * PDF to handwriting: write a PDF's text out by hand, in one of the Sign
 * tool's handwriting fonts, on plain or lined paper. The result is a new PDF;
 * the preview is that PDF itself, so what's shown is what downloads.
 */
export class HandTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private layouts: Line[][] = [];
  private blocks: HwBlock[] = [];
  private font = DEFAULT_FONT;
  private ink: Ink = "blue";
  private paper: Paper = "lined";
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
  private select: HTMLSelectElement;
  private input: HTMLInputElement;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    const groups = { showpiece: "Showpiece", natural: "Natural", fancy: "Fancy" } as const;
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
      <div class="findbar optbar" data-opts hidden>
        <label class="every hw-font">
          Font
          <select data-font>
            ${(Object.keys(groups) as (keyof typeof groups)[])
              .map(
                (g) =>
                  `<optgroup label="${groups[g]}">${STYLES.filter((s) => s.group === g)
                    .map((s) => `<option value="${s.family}" style="font-family: '${s.family}'">${s.family}</option>`)
                    .join("")}</optgroup>`,
              )
              .join("")}
          </select>
        </label>
        <div class="seg swatches" role="radiogroup" aria-label="Ink">
          ${(Object.keys(INKS) as Ink[])
            .map(
              (k) =>
                `<button type="button" role="radio" data-ink="${k}" title="${INKS[k].label} ink" aria-label="${INKS[k].label}"><i class="sw" style="background: rgb(${INKS[k].color.join(",")})"></i></button>`,
            )
            .join("")}
        </div>
        <div class="seg" role="radiogroup" aria-label="Paper">
          <button type="button" role="radio" data-paper="lined" title="Notebook paper with ruled lines">Lined</button>
          <button type="button" role="radio" data-paper="plain">Plain</button>
        </div>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">PDF to handwriting</h1>
          <p class="tool-sub">Write a PDF's text out by hand, in one of the signature fonts, on lined or plain paper. You get a new PDF. Pictures and the original layout aren't kept.</p>
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
    this.select = q<HTMLSelectElement>("[data-font]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.select.value = this.font;
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
    this.select.addEventListener("change", () => {
      this.font = this.select.value;
      this.rebuild();
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this.ink === b.dataset.ink) return;
        this.ink = b.dataset.ink as Ink;
        this.rebuild();
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this.paper === b.dataset.paper) return;
        this.paper = b.dataset.paper as Paper;
        this.rebuild();
      }),
    );
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
    let layouts: Line[][];
    try {
      layouts = await extractPages(src.doc, {
        fonts: true,
        onProgress: (done, total) => showBusy(`Reading page ${done} of ${total}`),
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
    this.layouts = layouts;
    this.blocks = documentBlocks(layouts);
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

  private async build(first: boolean): Promise<void> {
    const src = this.src;
    if (!src) return;
    const run = ++this.run;
    this.writing = true;
    this.sync();
    if (first) showBusy("Writing it out");
    try {
      const [hand, fallback] = await Promise.all([
        handFontBytes(this.font),
        // A plain font for letters the handwriting lacks (Greek, Cyrillic, bullets). Optional.
        faceBytes({ family: "Carlito", bold: false, italic: false }).catch(() => undefined),
      ]);
      const page = src.sizes[0] ?? { w: 612, h: 792 };
      const result = await handwrite(this.blocks, { hand, fallback }, { paper: this.paper, ink: INKS[this.ink].color, page });
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
    this.blocks = documentBlocks(this.layouts);
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
    this.root.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.ink === this.ink));
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.paper === this.paper));
    });
    this.select.style.fontFamily = `'${this.font}', var(--font)`;
    const ready = src !== null && this.result !== null && !this.writing;
    this.goBtn.disabled = !ready;
    this.goBtn.title = !src ? "Choose a PDF first" : !this.blocks.length ? "This PDF has no text to write out" : "Download (Ctrl S)";
    this.status.textContent = this.writing ? "Writing…" : ready ? plural(this.result!.pages, "page") : "";
  }
}
