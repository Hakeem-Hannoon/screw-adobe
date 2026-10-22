import { buildPdfs } from "./combine";
import { icons } from "./icons";
import { closeSource, loadSource, type PdfSource } from "./source";
import { Thumbs } from "./thumbs";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

export interface ToolHost {
  goHome(): void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Combine several PDFs into one, in an order you set by dragging. */
export class MergeTool {
  readonly root: HTMLElement;
  private files: PdfSource[] = [];
  private list: HTMLOListElement;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private thumbs: Thumbs;
  private loading: Promise<void> = Promise.resolve();
  private active = false;

  constructor(container: HTMLElement, private host: ToolHost) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "merge";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>screw</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-summary></span>
        </div>
        <div class="tb-group tb-right">
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download merged PDF</span></button>
        </div>
      </header>
      <div class="scroller" data-scroller>
        <div class="tool-body">
          <h1 class="tool-title">Merge PDFs</h1>
          <p class="tool-sub" data-sub></p>
          <ol class="file-list" data-list aria-label="Files to merge, in order"></ol>
          <button type="button" class="drop-card" data-add>
            ${icons.plus}
            <span><strong data-add-label></strong><small>or drop them anywhere on this page</small></span>
          </button>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" multiple hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.list = q<HTMLOListElement>("[data-list]");
    this.scroller = q("[data-scroller]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.addBtn = q<HTMLButtonElement>("[data-add]");
    this.thumbs = new Thumbs(this.scroller, { w: 44, h: 56 });

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    this.addBtn.addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.input.addEventListener("change", () => {
      const files = Array.from(this.input.files ?? []);
      this.input.value = "";
      if (files.length) void this.add(files);
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = "Merge PDFs - screw adobe";
    this.sync();
  }

  close(): void {
    this.active = false;
    for (const f of this.files) closeSource(f);
    this.files = [];
    this.thumbs.clear();
    this.list.replaceChildren();
    this.sync();
  }

  /** Open the file picker. Call from a click so the browser allows it. */
  pick(): void {
    this.input.click();
  }

  add(files: File[]): Promise<void> {
    // Queue behind any load in progress so files land in the order they came.
    this.loading = this.loading.then(() => this.load(files));
    return this.loading;
  }

  private async load(list: File[]): Promise<void> {
    const pdfs = list.filter(isPdf);
    const skipped = list.length - pdfs.length;
    const failed: string[] = [];
    for (const file of pdfs) {
      if (!this.active) break;
      showBusy(`Opening ${file.name}`);
      try {
        const src = await loadSource(file);
        if (!src) continue;
        if (!this.active) {
          closeSource(src);
          break;
        }
        this.files.push(src);
        this.list.append(this.row(src));
      } catch {
        failed.push(file.name);
      }
    }
    showBusy(null);
    this.sync();
    this.addBtn.scrollIntoView({ block: "nearest" });

    if (failed.length) {
      toast(
        failed.length === 1 ? `${failed[0]} couldn't be opened.` : `${failed.length} files couldn't be opened.`,
        "They may be damaged or not really PDFs.",
      );
    } else if (skipped) {
      toast(`Skipped ${plural(skipped, "file")} that ${skipped === 1 ? "isn't a PDF" : "aren't PDFs"}.`);
    }
  }

  async download(): Promise<void> {
    if (this.files.length < 2) return;
    const files = [...this.files];
    const name = `${baseName(files[0].name)}-merged.pdf`;
    const pages = files.flatMap((src) => src.sizes.map((_, index) => ({ src, index })));
    showBusy("Merging");
    try {
      const [res] = await buildPdfs([pages], (done, total) => showBusy(`Adding page ${done} of ${total}`));
      saveFile(new Blob([res.bytes as BlobPart], { type: "application/pdf" }), name);
      const flat = res.flattened
        ? ` ${plural(res.flattened, "page")} from password-protected files became images.`
        : "";
      toast(`Downloaded ${name}`, `${plural(files.length, "file")}, ${plural(res.pages, "page")}.${flat} Metadata removed.`);
    } catch (err) {
      console.error(err);
      toast("The merged PDF couldn't be made.", "One of the files may be damaged. Try removing it and merging again.");
    } finally {
      showBusy(null);
    }
  }

  // ---------------------------------------------------------------- rows

  private row(src: PdfSource): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "file-row";
    li.dataset.id = src.id;

    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "grip";
    grip.title = "Drag to reorder";
    grip.setAttribute("aria-label", `Move ${src.name}. Use the up and down arrow keys.`);
    grip.innerHTML = icons.grip;

    const thumb = document.createElement("div");
    thumb.className = "row-thumb";
    thumb.append(this.thumbs.sheet(src, 0));

    const info = document.createElement("div");
    info.className = "row-info";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = src.name;
    name.title = src.name;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = plural(src.sizes.length, "page");
    info.append(name, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${src.name}`);
    remove.innerHTML = icons.close;

    li.append(grip, thumb, info, remove);

    remove.addEventListener("click", () => this.remove(src, li));
    grip.addEventListener("pointerdown", (e) => this.drag(e, li, grip));
    grip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const sib = e.key === "ArrowUp" ? li.previousElementSibling : li.nextElementSibling;
      if (!sib) return;
      if (e.key === "ArrowUp") this.list.insertBefore(li, sib);
      else this.list.insertBefore(sib, li);
      grip.focus();
      this.syncOrder();
    });
    return li;
  }

  private remove(src: PdfSource, li: HTMLLIElement): void {
    const next = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null;
    const sheet = li.querySelector<HTMLElement>(".thumb-sheet");
    if (sheet) this.thumbs.forget(sheet);
    li.remove();
    closeSource(src);
    this.files = this.files.filter((f) => f !== src);
    this.sync();
    (next?.querySelector<HTMLElement>("[aria-label^='Remove']") ?? this.addBtn).focus();
  }

  /** Pointer drag on the grip: the row follows the pointer, swapping past neighbors' midpoints. */
  private drag(e: PointerEvent, li: HTMLLIElement, grip: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    li.classList.add("lifted");
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const move = (ev: PointerEvent) => {
      let prev = li.previousElementSibling;
      while (prev && ev.clientY < mid(prev)) {
        this.list.insertBefore(li, prev);
        prev = li.previousElementSibling;
      }
      let next = li.nextElementSibling;
      while (next && ev.clientY > mid(next)) {
        this.list.insertBefore(next, li);
        next = li.nextElementSibling;
      }
      // Scroll when dragging near the top or bottom edge.
      const box = this.scroller.getBoundingClientRect();
      if (ev.clientY < box.top + 48) this.scroller.scrollBy(0, -12);
      else if (ev.clientY > box.bottom - 48) this.scroller.scrollBy(0, 12);
    };
    const up = () => {
      li.classList.remove("lifted");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      this.syncOrder();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  private syncOrder(): void {
    const byId = new Map(this.files.map((f) => [f.id, f]));
    this.files = [...this.list.children].map((li) => byId.get((li as HTMLElement).dataset.id!)!).filter(Boolean);
  }

  private sync(): void {
    const n = this.files.length;
    const pages = this.files.reduce((sum, f) => sum + f.sizes.length, 0);
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    q("[data-summary]").textContent = n ? `${plural(n, "file")} · ${plural(pages, "page")}` : "Merge PDFs";
    q("[data-sub]").textContent =
      n === 0
        ? "Combine several PDFs into one file."
        : n === 1
          ? "Add at least one more PDF to merge with."
          : "They'll be joined from top to bottom. Drag the handles to change the order.";
    q("[data-add-label]").textContent = n ? "Add more PDFs" : "Choose PDFs";
    this.addBtn.classList.toggle("lg", n === 0);
    this.goBtn.disabled = n < 2;
    this.goBtn.title = n < 2 ? "Add at least two PDFs" : "Download (Ctrl S)";
  }
}
