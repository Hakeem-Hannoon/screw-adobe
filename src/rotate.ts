import { degrees, PDFDocument } from "pdf-lib";
import { buildPdfs } from "./combine";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const norm = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * A copy of the PDF with pages turned. `turns[i]` is how far to turn page i
 * clockwise, in degrees. Built like a merge (brand-new file, no metadata),
 * then each page's rotation is changed, which doesn't touch its contents.
 */
export async function rotatePdf(
  src: PdfSource,
  turns: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; flattened: number }> {
  const [built] = await buildPdfs([src.sizes.map((_, index) => ({ src, index }))], onProgress);
  const doc = await PDFDocument.load(built.bytes, { updateMetadata: false });
  doc.getPages().forEach((page, i) => {
    const turn = norm(turns[i] ?? 0);
    if (turn) page.setRotation(degrees(norm(page.getRotation().angle + turn)));
  });
  return { bytes: await doc.save({ useObjectStreams: true }), flattened: built.flattened };
}

/** Turn some or all pages of a PDF. Click a page to turn it a quarter turn clockwise. */
export class RotateTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private turns: number[] = [];
  private figures: HTMLElement[] = [];
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private grid: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private box: number;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "rotate-tool";
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
        <p class="opt-hint">Click a page to turn it. Or turn them all:</p>
        <div class="pair">
          <button type="button" class="btn" data-all="-90" title="Turn every page left">${icons.rotateLeft}<span class="lbl">Left</span></button>
          <button type="button" class="btn" data-all="90" title="Turn every page right">${icons.rotate}<span class="lbl">Right</span></button>
        </div>
        <button type="button" class="btn" data-reset>Reset</button>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Rotate</h1>
          <p class="tool-sub">Turn the pages of a PDF, all of them or just the ones that are sideways.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.rotate}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="rot-grid" data-grid hidden></div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.grid = q("[data-grid]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    const small = window.matchMedia("(max-width: 520px)").matches;
    this.box = small ? 132 : 168;
    this.thumbs = new Thumbs(this.scroller, { w: this.box, h: this.box });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.root.querySelectorAll<HTMLButtonElement>("[data-all]").forEach((b) =>
      b.addEventListener("click", () => {
        const by = Number(b.dataset.all);
        this.turns = this.turns.map((t) => t + by);
        this.render();
      }),
    );
    q("[data-reset]").addEventListener("click", () => {
      this.turns = this.turns.map(() => 0);
      this.render();
    });
    this.grid.addEventListener("click", (e) => {
      const page = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
      if (!page) return;
      const i = Number(page.dataset.page);
      // Shift-click turns the other way.
      this.turns[i] += e.shiftKey ? -90 : 90;
      this.render();
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
    document.title = this.src ? `Rotate ${this.src.name} - HackerPDF` : "Rotate - HackerPDF";
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
    this.turns = src.sizes.map(() => 0);
    this.figures = src.sizes.map((_, i) => {
      const fig = document.createElement("figure");
      fig.className = "rot-fig";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rot-page";
      btn.dataset.page = String(i);
      btn.style.width = btn.style.height = `${this.box}px`;
      const turn = document.createElement("div");
      turn.className = "rot-turn";
      turn.append(this.thumbs.sheet(src, i));
      const badge = document.createElement("span");
      badge.className = "rot-badge";
      badge.innerHTML = icons.rotate;
      btn.append(turn, badge);
      const cap = document.createElement("figcaption");
      fig.append(btn, cap);
      return fig;
    });
    this.grid.replaceChildren(...this.figures);
    document.title = `Rotate ${src.name} - HackerPDF`;
    this.render();
    this.scroller.scrollTop = 0;
  }

  async download(): Promise<void> {
    const src = this.src;
    if (!src || this.goBtn.disabled) return;
    const name = `${baseName(src.name)}-rotated.pdf`;
    showBusy("Rotating");
    try {
      const res = await rotatePdf(src, this.turns, (done, total) => showBusy(`Preparing page ${done} of ${total}`));
      saveFile(new Blob([res.bytes as BlobPart], { type: "application/pdf" }), name);
      const flat = res.flattened ? " Pages became images because the file is password-protected." : "";
      toast(`Downloaded ${name}`, `${plural(this.changed(), "page")} turned.${flat} Metadata removed.`);
    } catch (err) {
      console.error(err);
      toast("The rotated PDF couldn't be made.", "The file may be damaged. Try opening it again.");
    } finally {
      showBusy(null);
    }
  }

  // ------------------------------------------------------------- internals

  private changed(): number {
    return this.turns.filter((t) => norm(t) !== 0).length;
  }

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.turns = [];
    this.figures = [];
    this.thumbs.clear();
    this.grid.replaceChildren();
    this.sync();
  }

  private render(): void {
    this.figures.forEach((fig, i) => {
      const t = this.turns[i];
      // Keep the running total (not 0-359) so the animation always turns the short way round.
      fig.querySelector<HTMLElement>(".rot-turn")!.style.transform = `rotate(${t}deg)`;
      const deg = norm(t);
      fig.classList.toggle("turned", deg !== 0);
      const btn = fig.querySelector<HTMLElement>(".rot-page")!;
      btn.setAttribute("aria-label", `Page ${i + 1}${deg ? `, turned ${deg}°` : ""}. Click to turn right.`);
      fig.querySelector("figcaption")!.textContent = deg ? `${i + 1} · ${deg}°` : String(i + 1);
    });
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    q("[data-empty]").hidden = src !== null;
    this.grid.hidden = src === null;
    q("[data-opts]").hidden = src === null;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "Rotate";
    nameEl.title = src?.name ?? "";
    const n = this.changed();
    q("[data-status]").textContent = src ? (n ? `${plural(n, "page")} turned` : plural(src.sizes.length, "page")) : "";
    (q("[data-reset]") as HTMLButtonElement).disabled = n === 0;
    this.goBtn.disabled = !src || n === 0;
    this.goBtn.title = !src ? "Choose a PDF first" : n === 0 ? "Turn a page first" : "Download (Ctrl S)";
  }
}
