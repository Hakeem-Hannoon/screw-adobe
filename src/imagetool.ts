import { handoffButton, type HandoffTarget } from "./handoff";
import { icons } from "./icons";
import { imageBaseName, imagesToPdf, isImage, loadImage, type LoadedImage, type Paper } from "./images";
import type { ToolHost } from "./merge";
import { makeSortable } from "./reorder";
import { saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Turn one or more images into a PDF, one image per page, in an order you set by dragging. */
export class ImageTool {
  readonly root: HTMLElement;
  private images: LoadedImage[] = [];
  private urls = new Map<string, string>();
  private paper: Paper = "letter";
  private list: HTMLOListElement;
  private scroller: HTMLElement;
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private margin: HTMLInputElement;
  private loading: Promise<void> = Promise.resolve();
  private active = false;

  constructor(container: HTMLElement, private host: ToolHost) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "image-tool";
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="toolbar">
        <div class="tb-group tb-file">
          <button type="button" class="mini-mark" data-home title="Back to start">
            <span>Hacker</span><span class="mini-bar"></span>
          </button>
          <span class="filename" data-summary></span>
        </div>
        <div class="tb-group tb-right" data-actions>
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl"> PDF</span></span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <div class="seg" role="radiogroup" aria-label="Page size">
          <button type="button" role="radio" data-paper="letter">Letter</button>
          <button type="button" role="radio" data-paper="a4">A4</button>
          <button type="button" role="radio" data-paper="fit" title="Each page is exactly the size of its image">Fit image</button>
        </div>
        <label class="check inline">
          <input type="checkbox" data-margin checked />
          <span><strong>Margins</strong></span>
        </label>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body">
          <h1 class="tool-title">Images to PDF</h1>
          <p class="tool-sub" data-sub></p>
          <ol class="file-list" data-list aria-label="Images, in page order"></ol>
          <button type="button" class="drop-card" data-add>
            ${icons.image}
            <span><strong data-add-label></strong><small>or drop them anywhere on this page</small></span>
          </button>
        </div>
      </div>
      <input type="file" accept="image/*,.heic,.heif" multiple hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.list = q<HTMLOListElement>("[data-list]");
    this.scroller = q("[data-scroller]");
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.addBtn = q<HTMLButtonElement>("[data-add]");
    this.margin = q<HTMLInputElement>("[data-margin]");

    q("[data-actions]").prepend(
      handoffButton({ label: "Continue with", count: () => 1, pick: (t) => void this.handoff(t) }),
    );
    q("[data-home]").addEventListener("click", () => this.host.goHome());
    this.addBtn.addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => void this.download());
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) =>
      b.addEventListener("click", () => {
        this.paper = b.dataset.paper as Paper;
        this.sync();
      }),
    );
    this.input.addEventListener("change", () => {
      const files = Array.from(this.input.files ?? []);
      this.input.value = "";
      if (files.length) void this.add(files);
    });
    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = "Images to PDF - HackerPDF";
    this.sync();
  }

  close(): void {
    this.active = false;
    this.images = [];
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.list.replaceChildren();
    this.sync();
  }

  /** Open the file picker. Call from a click so the browser allows it. */
  pick(): void {
    this.input.click();
  }

  add(files: File[]): Promise<void> {
    // Queue behind any load in progress so images land in the order they came.
    this.loading = this.loading.then(() => this.load(files));
    return this.loading;
  }

  private async load(list: File[]): Promise<void> {
    const picked = list.filter(isImage);
    const skipped = list.length - picked.length;
    const failed: string[] = [];
    for (const file of picked) {
      if (!this.active) break;
      showBusy(`Reading ${file.name}`);
      try {
        const image = await loadImage(file);
        if (!this.active) break;
        this.images.push(image);
        this.list.append(this.row(image));
      } catch {
        failed.push(file.name);
      }
    }
    showBusy(null);
    this.sync();
    this.addBtn.scrollIntoView({ block: "nearest" });

    if (failed.length) {
      const heic = failed.some((n) => /\.hei[cf]$/i.test(n));
      toast(
        failed.length === 1 ? `${failed[0]} couldn't be read.` : `${failed.length} images couldn't be read.`,
        heic
          ? "This browser can't open HEIC photos. Try Safari, or export them as JPEG first."
          : "They may be damaged, or in a format this browser can't open.",
      );
    } else if (skipped) {
      toast(`Skipped ${plural(skipped, "file")} that ${skipped === 1 ? "isn't an image" : "aren't images"}.`);
    }
  }

  async download(): Promise<void> {
    if (!this.images.length) return;
    const images = [...this.images];
    const name = `${imageBaseName(images[0].file.name)}.pdf`;
    showBusy("Making your PDF");
    try {
      const bytes = await imagesToPdf(images, { paper: this.paper, margin: this.margin.checked }, (done, total) =>
        showBusy(`Adding image ${done} of ${total}`),
      );
      saveFile(new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
      toast(`Downloaded ${name}`, `${plural(images.length, "page")}. Photo metadata like location removed.`);
    } catch (err) {
      console.error(err);
      toast("The PDF couldn't be made.", "One of the images may be damaged. Try removing it and downloading again.");
    } finally {
      showBusy(null);
    }
  }

  /** Make the PDF, then open it in another tool instead of downloading it. */
  private async handoff(target: HandoffTarget): Promise<void> {
    if (!this.images.length) return;
    const images = [...this.images];
    showBusy("Making your PDF");
    try {
      const bytes = await imagesToPdf(images, { paper: this.paper, margin: this.margin.checked }, (done, total) =>
        showBusy(`Adding image ${done} of ${total}`),
      );
      showBusy(null);
      const name = `${imageBaseName(images[0].file.name)}.pdf`;
      this.host.openIn(target, [new File([bytes as BlobPart], name, { type: "application/pdf" })]);
    } catch (err) {
      console.error(err);
      showBusy(null);
      toast("The PDF couldn't be made.", "One of the images may be damaged. Try removing it.");
    }
  }

  // ---------------------------------------------------------------- rows

  private row(image: LoadedImage): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "file-row";
    li.dataset.id = image.id;

    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "grip";
    grip.title = "Drag to reorder";
    grip.setAttribute("aria-label", `Move ${image.file.name}. Use the up and down arrow keys.`);
    grip.innerHTML = icons.grip;

    const thumb = document.createElement("div");
    thumb.className = "row-thumb";
    const img = document.createElement("img");
    const url = URL.createObjectURL(image.file);
    this.urls.set(image.id, url);
    img.src = url;
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    thumb.append(img);

    const info = document.createElement("div");
    info.className = "row-info";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = image.file.name;
    name.title = image.file.name;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = `${image.w} × ${image.h}`;
    info.append(name, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${image.file.name}`);
    remove.innerHTML = icons.close;

    li.append(grip, thumb, info, remove);
    remove.addEventListener("click", () => this.remove(image, li));
    makeSortable(li, grip, this.scroller, () => this.syncOrder());
    return li;
  }

  private remove(image: LoadedImage, li: HTMLLIElement): void {
    const next = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null;
    li.remove();
    const url = this.urls.get(image.id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(image.id);
    this.images = this.images.filter((i) => i !== image);
    this.sync();
    (next?.querySelector<HTMLElement>("[aria-label^='Remove']") ?? this.addBtn).focus();
  }

  private syncOrder(): void {
    const byId = new Map(this.images.map((i) => [i.id, i]));
    this.images = [...this.list.children].map((li) => byId.get((li as HTMLElement).dataset.id!)!).filter(Boolean);
  }

  private sync(): void {
    const n = this.images.length;
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    q("[data-summary]").textContent = n ? plural(n, "image") : "Images to PDF";
    q("[data-sub]").textContent =
      n === 0
        ? "Turn photos, scans or screenshots into one PDF, one image per page."
        : n === 1
          ? "Add more images, or download this one as a PDF."
          : "Each image becomes a page, from top to bottom. Drag the handles to change the order.";
    q("[data-add-label]").textContent = n ? "Add more images" : "Choose images";
    q("[data-opts]").hidden = n === 0;
    q("[data-status]").textContent = n ? plural(n, "page") : "";
    this.root.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.paper === this.paper));
    });
    this.addBtn.classList.toggle("lg", n === 0);
    this.goBtn.disabled = n === 0;
    this.goBtn.title = n === 0 ? "Add an image first" : "Download (Ctrl S)";
    this.root.querySelector<HTMLElement>(".handoff")!.hidden = n === 0;
  }
}
