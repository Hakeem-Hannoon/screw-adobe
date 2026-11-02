import { countWords, extractPages, joinPages } from "./extract";
import { icons } from "./icons";
import type { ToolHost } from "./merge";
import { closeSource, loadSource, type PdfSource } from "./source";
import { baseName, isPdf, saveFile, showBusy, toast } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Pull the text out of a PDF and save it as a plain .txt file. */
export class TextTool {
  readonly root: HTMLElement;
  private src: PdfSource | null = null;
  private pages: string[] = [];
  private input: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private labels: HTMLInputElement;
  private reflow: HTMLInputElement;
  private output: HTMLElement;
  private notice: HTMLElement;
  private active = false;

  constructor(
    container: HTMLElement,
    private host: ToolHost,
  ) {
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.id = "text-tool";
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
          <button type="button" class="btn" data-copy title="Copy all the text">${icons.copy}<span class="lbl">Copy</span></button>
          <button type="button" class="btn primary" data-go title="Download (Ctrl S)">${icons.download}<span>Download<span class="lbl"> .txt</span></span></button>
        </div>
      </header>
      <div class="findbar optbar" data-opts hidden>
        <label class="check inline">
          <input type="checkbox" data-labels />
          <span><strong>Mark each page</strong></span>
        </label>
        <label class="check inline" title="Turns each paragraph into one line, so the text rewraps wherever you paste it. Leave it off for tables and addresses.">
          <input type="checkbox" data-reflow />
          <span><strong>Join wrapped lines</strong></span>
        </label>
        <span class="find-count" data-status aria-live="polite"></span>
      </div>
      <div class="scroller" data-scroller>
        <div class="tool-body" data-empty>
          <h1 class="tool-title">PDF to text</h1>
          <p class="tool-sub">Pull all the text out of a PDF and save it as a plain .txt file.</p>
          <button type="button" class="drop-card lg" data-pick>
            ${icons.fileText}
            <span><strong>Choose a PDF</strong><small>or drop one anywhere on this page</small></span>
          </button>
        </div>
        <div class="tool-body wide" data-result hidden>
          <p class="notice" data-notice hidden></p>
          <pre class="text-out" data-output tabindex="0" aria-label="Extracted text"></pre>
        </div>
      </div>
      <input type="file" accept="application/pdf,.pdf" hidden />
    `;
    container.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.input = q<HTMLInputElement>("input[type=file]");
    this.goBtn = q<HTMLButtonElement>("[data-go]");
    this.copyBtn = q<HTMLButtonElement>("[data-copy]");
    this.labels = q<HTMLInputElement>("[data-labels]");
    this.reflow = q<HTMLInputElement>("[data-reflow]");
    this.output = q("[data-output]");
    this.notice = q("[data-notice]");

    q("[data-home]").addEventListener("click", () => this.host.goHome());
    q("[data-pick]").addEventListener("click", () => this.pick());
    this.goBtn.addEventListener("click", () => this.download());
    this.copyBtn.addEventListener("click", () => void this.copy());
    this.labels.addEventListener("change", () => this.render());
    this.reflow.addEventListener("change", () => this.render());
    this.input.addEventListener("change", () => {
      const f = this.input.files?.[0];
      this.input.value = "";
      if (f) void this.load(f);
    });

    this.sync();
  }

  open(): void {
    this.active = true;
    document.title = this.src ? `${this.src.name} as text - screw adobe` : "PDF to text - screw adobe";
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
    if (!src) {
      showBusy(null);
      return;
    }

    let pages: string[];
    try {
      pages = await extractPages(src.doc, (done, total) => showBusy(`Reading page ${done} of ${total}`));
    } catch (err) {
      console.error(err);
      closeSource(src);
      toast("The text couldn't be read.", "The file may be damaged. Try opening it again.");
      return;
    } finally {
      showBusy(null);
    }
    if (!this.active) {
      closeSource(src);
      return;
    }

    this.reset();
    this.src = src;
    this.pages = pages;
    document.title = `${src.name} as text - screw adobe`;
    this.render();
    this.root.querySelector<HTMLElement>("[data-scroller]")!.scrollTop = 0;
  }

  download(): void {
    if (!this.src || this.goBtn.disabled) return;
    const name = `${baseName(this.src.name)}.txt`;
    const text = this.text();
    saveFile(new Blob([text], { type: "text/plain;charset=utf-8" }), name);
    toast(`Downloaded ${name}`, `${plural(countWords(text), "word")} from ${plural(this.pages.length, "page")}.`);
  }

  // ------------------------------------------------------------- internals

  private text(): string {
    return joinPages(this.pages, { labels: this.labels.checked, reflow: this.reflow.checked });
  }

  private async copy(): Promise<void> {
    if (!this.src || this.copyBtn.disabled) return;
    try {
      await navigator.clipboard.writeText(this.text());
      toast("Copied all the text.");
    } catch {
      // Clipboard access can be blocked; fall back to selecting it for them.
      const range = document.createRange();
      range.selectNodeContents(this.output);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      toast("The text is selected.", "Press Ctrl C (or ⌘ C) to copy it.");
    }
  }

  private reset(): void {
    if (this.src) closeSource(this.src);
    this.src = null;
    this.pages = [];
    this.output.textContent = "";
    this.sync();
  }

  private render(): void {
    const empty = this.pages.filter((p) => !p).length;
    const total = this.pages.length;
    const hasText = empty < total;

    if (!hasText) {
      this.notice.textContent =
        "No text found. This PDF is probably scanned pages or images, so there are no letters to pull out, only pictures of them.";
    } else if (empty) {
      this.notice.textContent = `${plural(empty, "page")} had no text, probably because ${empty === 1 ? "it's a scan or an image" : "they're scans or images"}.`;
    } else {
      this.notice.textContent = "";
    }
    this.notice.hidden = !this.notice.textContent;
    this.output.hidden = !hasText;
    this.output.textContent = hasText ? this.text() : "";
    this.sync();
  }

  private sync(): void {
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    const src = this.src;
    q("[data-empty]").hidden = src !== null;
    q("[data-result]").hidden = src === null;
    const hasText = this.pages.some((p) => p);
    q("[data-opts]").hidden = !hasText;
    const nameEl = q("[data-name]");
    nameEl.textContent = src ? src.name : "PDF to text";
    nameEl.title = src?.name ?? "";

    q("[data-status]").textContent =
      src && hasText
        ? `${plural(countWords(this.pages.join(" ")), "word")} · ${plural(this.pages.length, "page")}`
        : "";
    for (const b of [this.goBtn, this.copyBtn]) b.disabled = !src || !hasText;
    this.goBtn.title = !src ? "Choose a PDF first" : !hasText ? "This PDF has no text to save" : "Download (Ctrl S)";
  }
}
