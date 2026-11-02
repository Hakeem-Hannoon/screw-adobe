import { buildPdfs } from "./combine";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Reorder, delete and pull out pages of one PDF. Pages are tiles in a grid:
 * drag a tile by its handle to move it, click a tile to select it.
 */
export class OrganizeTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  /** Original page indices, in their current order. Deleted pages are left out. */
  private order: number[] = [];
  private selected = new Set<number>();
  /** Where shift-click ranges start. */
  private anchor: number | null = null;
  private tiles = new Map<number, HTMLElement>();
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
    this.root.id = "organize-tool";
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
        <p class="opt-hint" data-hint></p>
        <button type="button" class="btn" data-extract>${icons.file}<span>Extract</span></button>
        <button type="button" class="btn" data-delete>${icons.trash}<span>Delete</span></button>
        <button type="button" class="btn" data-clear>Clear selection</button>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">Organize pages</h1>
          <p class="tool-sub">Put pages in a new order, delete the ones you don't need, or pull some out into their own PDF.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.grid}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="org-grid" data-grid hidden></div>
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
    this.box = small ? 120 : 150;
    this.thumbs = new Thumbs(this.scroller, { w: this.box, h: this.box });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    q("[data-extract]").addEventListener("click", () => void this.extract());
    q("[data-delete]").addEventListener("click", () => this.deleteSelected());
    q("[data-clear]").addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });
    this.grid.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".org-grip")) return;
      const tile = t.closest<HTMLElement>("[data-page]");
      if (tile) this.toggle(Number(tile.dataset.page), e.shiftKey);
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
    document.title = this.src ? `Organize ${this.src.name} - HackerPDF` : "Organize pages - HackerPDF";
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
    this.order = src.sizes.map((_, i) => i);
    for (const i of this.order) this.tiles.set(i, this.tile(src, i));
    document.title = `Organize ${src.name} - HackerPDF`;
    this.render();
    this.scroller.scrollTop = 0;
  }

  async download(): Promise<void> {
    const src = this.src;
    if (!src || this.goBtn.disabled) return;
    await this.save(this.order, `${baseName(src.name)}-organized.pdf`);
  }

  // ------------------------------------------------------------- internals

  private async extract(): Promise<void> {
    const src = this.src;
    if (!src || !this.selected.size) return;
    const pages = this.order.filter((i) => this.selected.has(i));
    await this.save(pages, `${baseName(src.name)}-extract.pdf`);
  }

  private async save(pages: number[], name: string): Promise<void> {
    const src = this.src!;
    showBusy("Preparing your PDF");
    try {
      const [res] = await buildPdfs([pages.map((index) => ({ src, index }))], (done, total) =>
        showBusy(`Preparing page ${done} of ${total}`),
      );
      saveFile(new Blob([res.bytes as BlobPart], { type: "application/pdf" }), name);
      const flat = res.flattened ? " Pages became images because the file is password-protected." : "";
      toast(`Downloaded ${name}`, `${plural(res.pages, "page")}.${flat} Metadata removed.`);
    } catch (err) {
      console.error(err);
      toast("The PDF couldn't be made.", "The file may be damaged. Try opening it again.");
    } finally {
      showBusy(null);
    }
  }

  private deleteSelected(): void {
    if (!this.selected.size) return;
    if (this.selected.size >= this.order.length) {
      toast("A PDF needs at least one page.", "Leave at least one page unselected.");
      return;
    }
    const before = [...this.order];
    const gone = this.selected.size;
    this.order = this.order.filter((i) => !this.selected.has(i));
    this.selected.clear();
    this.render();
    toast(`Deleted ${plural(gone, "page")}.`, undefined, {
      label: "Undo",
      run: () => {
        this.order = before;
        this.render();
      },
    });
  }

  private toggle(page: number, range: boolean): void {
    if (range && this.anchor !== null && this.order.includes(this.anchor)) {
      const a = this.order.indexOf(this.anchor);
      const b = this.order.indexOf(page);
      for (const i of this.order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(i);
    } else if (this.selected.has(page)) {
      this.selected.delete(page);
    } else {
      this.selected.add(page);
    }
    this.anchor = page;
    this.render();
  }

  private tile(src: PdfSource, i: number): HTMLElement {
    const fig = document.createElement("figure");
    fig.className = "org-fig";
    fig.dataset.page = String(i);
    const page = document.createElement("button");
    page.type = "button";
    page.className = "org-page";
    page.style.width = page.style.height = `${this.box}px`;
    page.append(this.thumbs.sheet(src, i));
    const check = document.createElement("span");
    check.className = "org-check";
    check.innerHTML = icons.check;
    page.append(check);
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "org-grip";
    grip.title = "Drag to move";
    grip.setAttribute("aria-label", `Move page ${i + 1}. Use the arrow keys.`);
    grip.innerHTML = icons.grip;
    const cap = document.createElement("figcaption");
    cap.textContent = String(i + 1);
    fig.append(page, grip, cap);
    this.sortable(fig, grip);
    return fig;
  }

  /**
   * Drag a tile around the grid by its handle (or move it with the arrow
   * keys). The tiles it passes are what move in the DOM, never the dragged
   * one, so its pointer capture holds.
   */
  private sortable(fig: HTMLElement, grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      fig.classList.add("lifted");
      const move = (ev: PointerEvent) => {
        const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".org-fig");
        if (hit && hit !== fig && hit.parentElement === this.grid) {
          const r = hit.getBoundingClientRect();
          const after = ev.clientX > r.left + r.width / 2;
          const tiles = [...this.grid.children];
          const from = tiles.indexOf(fig);
          const to = tiles.indexOf(hit);
          if (to > from) {
            // Tiles between move in front of the dragged one.
            const moving = tiles.slice(from + 1, after ? to + 1 : to);
            if (moving.length) fig.before(...moving);
          } else {
            const moving = tiles.slice(after ? to + 1 : to, from);
            if (moving.length) fig.after(...moving);
          }
        }
        const box = this.scroller.getBoundingClientRect();
        if (ev.clientY < box.top + 48) this.scroller.scrollBy(0, -14);
        else if (ev.clientY > box.bottom - 48) this.scroller.scrollBy(0, 14);
      };
      const up = () => {
        fig.classList.remove("lifted");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        grip.removeEventListener("lostpointercapture", up);
        this.syncOrder();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      grip.addEventListener("lostpointercapture", up);
    });
    grip.addEventListener("keydown", (e) => {
      const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      if (!back && !fwd) return;
      e.preventDefault();
      const sib = back ? fig.previousElementSibling : fig.nextElementSibling;
      if (!sib) return;
      if (back) fig.after(sib);
      else fig.before(sib);
      this.syncOrder();
    });
  }

  private syncOrder(): void {
    this.order = [...this.grid.children].map((el) => Number((el as HTMLElement).dataset.page));
    this.sync();
  }

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.order = [];
    this.selected.clear();
    this.anchor = null;
    this.tiles.clear();
    this.thumbs.clear();
    this.grid.replaceChildren();
    this.sync();
  }

  private render(): void {
    const tiles = this.order.map((i) => this.tiles.get(i)!);
    // Only touch the DOM if the order changed, so thumbnails don't flicker.
    const current = [...this.grid.children];
    if (current.length !== tiles.length || current.some((el, k) => el !== tiles[k]))
      this.grid.replaceChildren(...tiles);
    for (const [i, el] of this.tiles) {
      const on = this.selected.has(i);
      el.classList.toggle("selected", on);
      el.querySelector(".org-page")!.setAttribute("aria-pressed", String(on));
      el.querySelector(".org-page")!.setAttribute("aria-label", `Page ${i + 1}${on ? ", selected" : ""}`);
    }
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    q("[data-empty]").hidden = src !== null;
    this.grid.hidden = src === null;
    q("[data-opts]").hidden = src === null;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "Organize pages";
    nameEl.title = src?.name ?? "";

    const n = this.selected.size;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    q("[data-hint]").textContent = n
      ? `${plural(n, "page")} selected.`
      : `Drag the handles to reorder. ${touch ? "Tap" : "Click"} pages to select them${touch ? "" : " (Shift for a range)"}.`;
    for (const sel of ["[data-extract]", "[data-delete]", "[data-clear]"]) q(sel).hidden = n === 0;
    const total = src?.sizes.length ?? 0;
    const deleted = total - this.order.length;
    const moved = this.order.some((p, k) => p !== k) || deleted > 0;
    q("[data-status]").textContent = src
      ? `${plural(this.order.length, "page")}${deleted ? `, ${deleted} deleted` : ""}`
      : "";
    this.goBtn.disabled = !src || !moved;
    this.goBtn.title = !src ? "Choose a PDF first" : moved ? "Download (Ctrl S)" : "Move or delete a page first";
  }
}
