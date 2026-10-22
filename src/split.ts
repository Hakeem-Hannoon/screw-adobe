import { buildPdfs } from "./combine";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";
import { zip } from "./zip";

interface Part {
  start: number; // first page index
  end: number; // last page index (inclusive)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Cut one PDF into several. Click between pages to cut; each part downloads as its own PDF. */
export class SplitTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  /** Cut after page i (0-based). */
  private cuts = new Set<number>();
  /** Parts left out of the download, keyed by their first page. */
  private skipped = new Set<number>();
  private figures: HTMLElement[] = [];
  private thumbs: Thumbs;
  private scroller: HTMLElement;
  private partsEl: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private everyInput: HTMLInputElement;
  private active = false;

  constructor(container: HTMLElement, private host: ToolHost) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "split-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>screw</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-name></span>
        </div>
        <div class="tb-group tb-right">
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span data-go-label>Download</span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <p class="opt-hint">Click between two pages to cut there. Untick a part to leave it out.</p>
        <div class="every">
          <label for="every-n">Cut every</label>
          <input id="every-n" type="number" min="1" step="1" value="1" inputmode="numeric" data-every />
          <span data-every-unit>page</span>
          <button type="button" class="btn" data-every-apply>Apply</button>
        </div>
        <button type="button" class="btn" data-clear>Clear cuts</button>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Split a PDF</h1>
          <p class="tool-sub">Cut one PDF into smaller ones. You'll choose where to cut on the next screen.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.scissors}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="parts" data-parts hidden></div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.scroller = q("[data-scroller]");
    this.partsEl = q("[data-parts]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.everyInput = q<HTMLInputElement>("[data-every]");
    const small = window.matchMedia("(max-width: 520px)").matches;
    this.thumbs = new Thumbs(this.scroller, small ? { w: 72, h: 94 } : { w: 96, h: 124 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    q("[data-clear]").addEventListener("click", () => {
      this.cuts.clear();
      this.skipped.clear();
      this.render();
    });
    q("[data-every-apply]").addEventListener("click", () => this.cutEvery());
    this.everyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.cutEvery();
      }
    });
    this.everyInput.addEventListener("input", () => {
      q("[data-every-unit]").textContent = Number(this.everyInput.value) === 1 ? "page" : "pages";
    });
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });

    this.partsEl.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const cut = t.closest<HTMLElement>("[data-cut]");
      const join = t.closest<HTMLElement>("[data-join]");
      if (cut) {
        const i = Number(cut.dataset.cut);
        this.cuts.add(i);
        this.render();
        this.focus(`[data-join="${i + 1}"]`);
      } else if (join) {
        const start = Number(join.dataset.join);
        this.cuts.delete(start - 1);
        this.skipped.delete(start);
        this.render();
        this.focus(`[data-cut="${start - 1}"]`);
      }
    });
    this.partsEl.addEventListener("change", (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>("[data-include]");
      if (!box) return;
      const start = Number(box.dataset.include);
      if (box.checked) this.skipped.delete(start);
      else this.skipped.add(start);
      box.closest(".part")?.classList.toggle("skipped", !box.checked);
      this.sync();
    });

    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `Split ${this.src.name} - screw adobe` : "Split a PDF - screw adobe";
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
    this.figures = src.sizes.map((_, i) => {
      const fig = document.createElement("figure");
      fig.className = "pthumb";
      const box = document.createElement("div");
      box.className = "pthumb-box";
      box.append(this.thumbs.sheet(src, i));
      const cap = document.createElement("figcaption");
      cap.textContent = String(i + 1);
      fig.append(box, cap);
      return fig;
    });
    this.everyInput.max = String(src.sizes.length);
    document.title = `Split ${src.name} - screw adobe`;
    this.render();
    this.scroller.scrollTop = 0;
    if (src.sizes.length === 1) toast("This PDF has only one page.", "There's nothing to split. Try a longer file.");
  }

  async download(): Promise<void> {
    const src = this.src;
    if (!src || this.goBtn.disabled) return;
    const parts = this.parts().filter((p) => !this.skipped.has(p.start));
    if (!parts.length) return;
    const base = baseName(src.name);
    const fileName = (p: Part) =>
      p.start === p.end ? `${base}-page-${p.start + 1}.pdf` : `${base}-pages-${p.start + 1}-${p.end + 1}.pdf`;

    showBusy("Splitting");
    try {
      const outputs = parts.map((p) =>
        Array.from({ length: p.end - p.start + 1 }, (_, k) => ({ src, index: p.start + k })),
      );
      const res = await buildPdfs(outputs, (done, total) => showBusy(`Preparing page ${done} of ${total}`));
      const flattened = res.reduce((n, r) => n + r.flattened, 0);
      const flat = flattened ? " Pages became images because the file is password-protected." : "";
      if (res.length === 1) {
        const name = fileName(parts[0]);
        saveFile(new Blob([res[0].bytes as BlobPart], { type: "application/pdf" }), name);
        toast(`Downloaded ${name}`, `${plural(res[0].pages, "page")}.${flat} Metadata removed.`);
      } else {
        const name = `${base}-split.zip`;
        saveFile(zip(res.map((r, k) => ({ name: fileName(parts[k]), data: r.bytes }))), name);
        toast(`Downloaded ${name}`, `${res.length} PDFs inside.${flat} Metadata removed.`);
      }
    } catch (err) {
      console.error(err);
      toast("The split couldn't be made.", "The file may be damaged. Try opening it again.");
    } finally {
      showBusy(null);
    }
  }

  // ------------------------------------------------------------- internals

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.cuts.clear();
    this.skipped.clear();
    this.thumbs.clear();
    this.figures = [];
    this.partsEl.replaceChildren();
    this.sync();
  }

  private parts(): Part[] {
    const n = this.src?.sizes.length ?? 0;
    const out: Part[] = [];
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (i === n - 1 || this.cuts.has(i)) {
        out.push({ start, end: i });
        start = i + 1;
      }
    }
    return out;
  }

  private cutEvery(): void {
    const n = this.src?.sizes.length ?? 0;
    const every = Math.floor(Number(this.everyInput.value));
    if (!n || !Number.isFinite(every) || every < 1) {
      this.everyInput.value = "1";
      return;
    }
    this.cuts.clear();
    this.skipped.clear();
    for (let i = every - 1; i < n - 1; i += every) this.cuts.add(i);
    this.render();
  }

  private render(): void {
    const parts = this.parts();
    const frag = document.createDocumentFragment();
    parts.forEach((p, k) => {
      const sec = document.createElement("section");
      sec.className = "part";
      sec.classList.toggle("skipped", this.skipped.has(p.start));
      sec.setAttribute("aria-label", `Part ${k + 1}`);

      const head = document.createElement("div");
      head.className = "part-head";
      const label = document.createElement("label");
      label.className = "part-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !this.skipped.has(p.start);
      box.dataset.include = String(p.start);
      const title = document.createElement("strong");
      title.textContent = `Part ${k + 1}`;
      const range = document.createElement("span");
      range.className = "part-range";
      range.textContent = p.start === p.end ? `Page ${p.start + 1}` : `Pages ${p.start + 1}–${p.end + 1}`;
      label.append(box, title, range);
      head.append(label);
      if (k > 0) {
        const join = document.createElement("button");
        join.type = "button";
        join.className = "quiet-btn";
        join.dataset.join = String(p.start);
        join.title = `Join with part ${k}`;
        join.textContent = "Join";
        head.append(join);
      }

      const pages = document.createElement("div");
      pages.className = "part-pages";
      for (let i = p.start; i <= p.end; i++) {
        pages.append(this.figures[i]);
        if (i < p.end) {
          const cut = document.createElement("button");
          cut.type = "button";
          cut.className = "cut";
          cut.dataset.cut = String(i);
          cut.title = "Cut here";
          cut.setAttribute("aria-label", `Cut between pages ${i + 1} and ${i + 2}`);
          cut.innerHTML = icons.scissors;
          pages.append(cut);
        }
      }
      sec.append(head, pages);
      frag.append(sec);
    });
    this.partsEl.replaceChildren(frag);
    this.sync();
  }

  private focus(sel: string): void {
    this.partsEl.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    q("[data-empty]").hidden = src !== null;
    this.partsEl.hidden = src === null;
    q("[data-opts]").hidden = src === null;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "Split a PDF";
    nameEl.title = src?.name ?? "";

    const parts = this.parts();
    const included = parts.filter((p) => !this.skipped.has(p.start)).length;
    const left = parts.length - included;
    q("[data-status]").textContent = src
      ? `${plural(parts.length, "part")}${left ? `, ${left} left out` : ""}`
      : "";
    q("[data-go-label]").textContent = included > 1 ? `Download ${included} PDFs` : "Download PDF";
    const nothingToDo = !src || parts.length < 2 || included === 0;
    this.goBtn.disabled = nothingToDo;
    this.goBtn.title = !src
      ? "Choose a PDF first"
      : parts.length < 2
        ? "Cut the PDF somewhere first"
        : included === 0
          ? "Tick at least one part"
          : "Download (Ctrl S)";
  }
}
