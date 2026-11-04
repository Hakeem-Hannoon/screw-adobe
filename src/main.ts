import "@fontsource-variable/public-sans/wght.css";
import "./style.css";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { isCancelled, openPdf, pageSizes } from "./pdf";
import { Store } from "./store";
import { ACTUAL_SIZE, Viewer, type ViewerSettings } from "./viewer";
import { PRESETS, TextIndex, covers, queryPattern, type Match, type Preset } from "./find";
import { exportPdf } from "./export";
import { icons } from "./icons";
import { askPassword, baseName, isPdf, saveFile, showBusy, toast } from "./ui";
import { MergeTool } from "./merge";
import { SplitTool } from "./split";
import { TextTool } from "./text";
import { ImageTool } from "./imagetool";
import { isImage } from "./images";
import { NumberTool } from "./numbertool";
import { RotateTool } from "./rotate";
import { OrganizeTool } from "./organize";
import { CompressTool } from "./compresstool";
import { CompareTool } from "./comparetool";
import { OcrTool } from "./ocrtool";
import { stopEngine } from "./ocr";
import { SignTool } from "./signtool";
import { WordTool } from "./wordtool";
import { ToPdfTool } from "./topdftool";
import { documentKind } from "./docsource";
import type { HandoffTarget } from "./handoff";
import { uid, type Color, type PageSize, type Rect, type Tool } from "./types";

// ------------------------------------------------------------------ markup

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<main class="home" id="home">
  <div class="home-inner">
    <h1 class="wordmark" aria-label="HackerPDF">
      <span aria-hidden="true">Hacker</span>
      <span class="redacted" aria-hidden="true"><span class="redacted-word">PDF</span><span class="redacted-bar"></span></span>
    </h1>
    <nav class="tools" aria-label="Tools">
      <button type="button" class="tool-link primary" id="choose">${icons.box}<span>Redact</span></button>
      <button type="button" class="tool-link" id="go-sign">${icons.pen}<span>Sign</span></button>
      <button type="button" class="tool-link" id="go-merge">${icons.merge}<span>Merge</span></button>
      <button type="button" class="tool-link" id="go-split">${icons.scissors}<span>Split</span></button>
      <button type="button" class="tool-link" id="go-organize">${icons.grid}<span>Organize pages</span></button>
      <button type="button" class="tool-link" id="go-rotate">${icons.rotate}<span>Rotate</span></button>
      <button type="button" class="tool-link" id="go-compress">${icons.compress}<span>Compress</span></button>
      <button type="button" class="tool-link" id="go-numbers">${icons.hash}<span>Page numbers</span></button>
      <button type="button" class="tool-link" id="go-compare">${icons.compare}<span>Compare</span></button>
      <button type="button" class="tool-link" id="go-word">${icons.word}<span>PDF to Word</span></button>
      <button type="button" class="tool-link" id="go-topdf">${icons.toPdf}<span>Word to PDF</span></button>
      <button type="button" class="tool-link" id="go-images">${icons.image}<span>Images to PDF</span></button>
      <button type="button" class="tool-link" id="go-text">${icons.fileText}<span>PDF to text</span></button>
      <button type="button" class="tool-link" id="go-ocr">${icons.scan}<span>Make searchable</span></button>
    </nav>
  </div>
  <input type="file" id="file-input" accept="application/pdf,.pdf" hidden />
</main>

<div class="editor" id="editor" hidden>
  <header class="toolbar">
    <div class="tb-group tb-file">
      <button type="button" class="mini-mark" id="close-file" title="Close this file">
        <span>Hacker</span><span class="mini-bar"></span>
      </button>
      <span class="filename" id="filename"></span>
    </div>

    <div class="tb-group tb-tools" role="toolbar" aria-label="Editing tools">
      <div class="seg" role="radiogroup" aria-label="Tool">
        <button type="button" role="radio" data-tool="box" title="Box (B)">${icons.box}<span class="lbl">Box</span></button>
        <button type="button" role="radio" data-tool="text" title="Text (T)">${icons.text}<span class="lbl">Text</span></button>
      </div>
      <div class="seg swatches" role="radiogroup" aria-label="Color">
        <button type="button" role="radio" data-color="black" title="Black (X switches)" aria-label="Black"><i class="sw sw-black"></i></button>
        <button type="button" role="radio" data-color="white" title="White (X switches)" aria-label="White"><i class="sw sw-white"></i></button>
      </div>
      <div class="stepper" id="size-ctl" hidden>
        <button type="button" class="icon-btn" data-size="-1" aria-label="Smaller text">${icons.minus}</button>
        <span class="stepper-val" id="size-val" title="Text size">12 pt</span>
        <button type="button" class="icon-btn" data-size="1" aria-label="Larger text">${icons.plus}</button>
      </div>
      <button type="button" class="tb-btn" id="find-toggle" title="Find text (Ctrl F)" aria-expanded="false">${icons.find}<span class="lbl">Find</span></button>
    </div>

    <div class="tb-group tb-right">
      <div class="pair">
        <button type="button" class="icon-btn" id="undo" title="Undo (Ctrl Z)" aria-label="Undo">${icons.undo}</button>
        <button type="button" class="icon-btn" id="redo" title="Redo (Ctrl Shift Z)" aria-label="Redo">${icons.redo}</button>
      </div>
      <div class="pair zoom">
        <button type="button" class="icon-btn" id="zoom-out" title="Zoom out (Ctrl −)" aria-label="Zoom out">${icons.minus}</button>
        <button type="button" class="zoom-val" id="zoom-val" title="Fit to width (Ctrl 0)">100%</button>
        <button type="button" class="icon-btn" id="zoom-in" title="Zoom in (Ctrl +)" aria-label="Zoom in">${icons.plus}</button>
      </div>
      <div class="split" id="split">
        <button type="button" class="btn primary" id="download" title="Download (Ctrl S)">${icons.download}<span class="lbl">Download</span></button>
        <button type="button" class="btn primary caret" id="menu-toggle" aria-label="Download options" aria-expanded="false" aria-controls="download-menu">${icons.chevron}</button>
        <div class="menu" id="download-menu" hidden>
          <label class="check">
            <input type="checkbox" id="flatten-all" />
            <span><strong>Flatten every page</strong><small>Turns every page into an image, not just the ones you edited. Strongest option, but no text in the file will be selectable.</small></span>
          </label>
        </div>
      </div>
    </div>
  </header>

  <div class="findbar" id="findbar" hidden>
    <div class="find-field">
      ${icons.find}
      <input id="find-input" type="search" placeholder="Find text to cover, like a name or account number" autocomplete="off" spellcheck="false" />
    </div>
    <div class="chips" id="chips">
      ${Object.entries(PRESETS)
        .map(([key, p]) => `<button type="button" class="chip" data-preset="${key}" aria-pressed="false">${p.label}</button>`)
        .join("")}
    </div>
    <span class="find-count" id="find-count" aria-live="polite"></span>
    <button type="button" class="btn" id="find-apply" disabled>Cover all</button>
    <button type="button" class="icon-btn" id="find-close" aria-label="Close find">${icons.close}</button>
  </div>

  <div class="scroller" id="scroller"></div>
</div>

<div class="dropzone" id="dropzone" hidden><p id="drop-text">Drop your PDF to open it</p></div>
<div class="busy" id="busy" hidden><p id="busy-text">Working</p></div>
<div class="toasts" id="toasts" aria-live="polite"></div>

<dialog class="dialog" id="pw-dialog" aria-labelledby="pw-title">
  <h2 id="pw-title">This PDF has a password</h2>
  <p id="pw-msg">Enter it to open the file. It stays on this device.</p>
  <input type="password" id="pw-input" autocomplete="off" aria-label="Password" />
  <div class="dialog-actions">
    <button type="button" class="btn" id="pw-cancel">Cancel</button>
    <button type="button" class="btn primary" id="pw-ok">Open</button>
  </div>
</dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const home = $("#home");
const editor = $("#editor");
const fileInput = $<HTMLInputElement>("#file-input");
const scroller = $("#scroller");
const filenameEl = $("#filename");
const undoBtn = $<HTMLButtonElement>("#undo");
const redoBtn = $<HTMLButtonElement>("#redo");
const zoomVal = $<HTMLButtonElement>("#zoom-val");
const sizeCtl = $("#size-ctl");
const sizeVal = $("#size-val");
const findbar = $("#findbar");
const findToggle = $<HTMLButtonElement>("#find-toggle");
const findInput = $<HTMLInputElement>("#find-input");
const findCount = $("#find-count");
const findApply = $<HTMLButtonElement>("#find-apply");
const menu = $("#download-menu");
const menuToggle = $<HTMLButtonElement>("#menu-toggle");
const flattenAll = $<HTMLInputElement>("#flatten-all");
const dropzone = $("#dropzone");
const dropText = $("#drop-text");

// ------------------------------------------------------------------- state

const store = new Store();
const settings: ViewerSettings = { tool: "box", color: "black", textSize: 12 };
const TEXT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96];
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

interface OpenDoc {
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  index: TextIndex;
}

let current: OpenDoc | null = null;
let viewer: Viewer | null = null;
let savedRevision = 0;
let findMatches: Match[] = [];
let findCursor = -1;
let activePreset: Preset | null = null;

type Mode =
  | "home"
  | "editor"
  | "merge"
  | "split"
  | "text"
  | "images"
  | "numbers"
  | "rotate"
  | "organize"
  | "compress"
  | "compare"
  | "ocr"
  | "sign"
  | "word"
  | "topdf";
type ToolMode = Exclude<Mode, "home" | "editor">;
let mode: Mode = "home";
const HOME_TITLE = "HackerPDF: redact, merge, split and convert PDFs";
const host = { goHome, openIn };
const merge = new MergeTool(app, host);
const split = new SplitTool(app, host);
const text = new TextTool(app, host);
const images = new ImageTool(app, host);
const numbers = new NumberTool(app, host);
const rotate = new RotateTool(app, host);
const organize = new OrganizeTool(app, host);
const compress = new CompressTool(app, host);
const compare = new CompareTool(app, host);
const ocr = new OcrTool(app, host);
const sign = new SignTool(app, host);
const word = new WordTool(app, host);
const topdf = new ToPdfTool(app, host);
const tools = { merge, split, text, images, numbers, rotate, organize, compress, compare, ocr, sign, word, topdf } satisfies Record<
  ToolMode,
  unknown
>;
/** Tools that take several files at once; the rest take one. */
const MULTI = new Set<ToolMode>(["merge", "images", "compare", "word", "topdf"]);
const isMulti = (m: Mode): m is "merge" | "images" | "compare" | "word" | "topdf" => MULTI.has(m as ToolMode);

// ----------------------------------------------------------------- helpers

const unsaved = () => current !== null && store.hasEdits && store.revision !== savedRevision;

function outputName(name: string): string {
  return `${baseName(name)}-redacted.pdf`;
}

// --------------------------------------------------------------- passwords

const pwDialog = $<HTMLDialogElement>("#pw-dialog");

// ------------------------------------------------------------ open / close

async function openFile(file: File): Promise<void> {
  if (!isPdf(file)) {
    toast("That file isn't a PDF.", "Choose a file that ends in .pdf.");
    return;
  }
  if (unsaved() && !window.confirm(`Discard your changes to ${current!.name}?`)) return;

  showBusy(`Opening ${file.name}`);
  let opened: { doc: PDFDocumentProxy };
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    opened = await openPdf(bytes, (wrong) => askPassword(wrong));
  } catch (err) {
    showBusy(null);
    if (pwDialog.open) pwDialog.close();
    if (!isCancelled(err)) toast("This PDF couldn't be opened.", "The file may be damaged or not really a PDF.");
    return;
  }

  try {
    const { doc } = opened;
    const sizes = await pageSizes(doc);
    closeFile(true);
    current = { name: file.name, bytes, doc, sizes, index: new TextIndex(doc) };
    store.reset();
    savedRevision = store.revision;

    setMode("editor");
    filenameEl.textContent = file.name;
    filenameEl.title = file.name;
    document.title = `${file.name} - HackerPDF`;

    viewer = new Viewer(scroller, doc, sizes, store, settings);
    viewer.onSelectionChange = (shape) => {
      if (shape) setColor(shape.color, false);
      if (shape?.kind === "text") settings.textSize = shape.size;
      syncToolbar();
    };
    viewer.onPageDeleted = (n) => {
      toast(`Page ${n} deleted.`, undefined, { label: "Undo", run: () => store.undo() });
    };
    syncToolbar();
  } finally {
    showBusy(null);
  }
}

function closeFile(force = false): void {
  if (!current) return;
  if (!force && unsaved() && !window.confirm(`Discard your changes to ${current.name}?`)) return;
  viewer?.destroy();
  viewer = null;
  void current.doc.loadingTask.destroy();
  current = null;
  store.reset();
  closeFind();
  if (!force) setMode("home");
}

// ------------------------------------------------------------- views / tools

function setMode(next: Mode): void {
  mode = next;
  home.hidden = next !== "home";
  editor.hidden = next !== "editor";
  for (const [name, tool] of Object.entries(tools)) tool.root.hidden = next !== name;
  if (next === "home") document.title = HOME_TITLE;
}

function goHome(): void {
  for (const tool of Object.values(tools)) tool.close();
  void stopEngine();
  setMode("home");
}

/** Hand finished PDFs straight to another tool, no download and upload in between. */
function openIn(target: HandoffTarget, files: File[]): void {
  goHome();
  if (target === "editor") void openFile(files[0]);
  else startTool(target, target === "merge" ? files : files.slice(0, 1));
}

/** Switch to one of the tools. With no files, opens the file picker (call from a click). */
function startTool(tool: ToolMode, files?: File[]): void {
  if (unsaved() && !window.confirm(`Discard your changes to ${current!.name}?`)) return;
  closeFile(true);
  const t = tools[tool];
  t.open();
  setMode(tool);
  if (!files) t.pick();
  else if (isMulti(tool)) void tools[tool].add(files);
  else void tools[tool].load(files[0]);
}

// ----------------------------------------------------------------- toolbar

function setTool(tool: Tool): void {
  settings.tool = tool;
  syncToolbar();
}

function setColor(color: Color, applyToSelection = true): void {
  settings.color = color;
  if (applyToSelection) viewer?.setSelectionColor(color);
  syncToolbar();
}

function stepTextSize(dir: number): void {
  const cur = settings.textSize;
  const next =
    dir > 0 ? (TEXT_SIZES.find((s) => s > cur) ?? cur) : ([...TEXT_SIZES].reverse().find((s) => s < cur) ?? cur);
  settings.textSize = next;
  viewer?.setSelectionTextSize(next);
  syncToolbar();
}

function stepZoom(dir: number): void {
  if (!viewer) return;
  const pct = viewer.zoom / ACTUAL_SIZE;
  const next =
    dir > 0 ? (ZOOM_STEPS.find((z) => z > pct + 0.001) ?? pct) : ([...ZOOM_STEPS].reverse().find((z) => z < pct - 0.001) ?? pct);
  viewer.setZoom(next * ACTUAL_SIZE);
  syncToolbar();
}

function syncToolbar(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.tool === settings.tool));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.color === settings.color));
  });
  const selected = viewer?.selected;
  sizeCtl.hidden = !(settings.tool === "text" || selected?.kind === "text");
  sizeVal.textContent = `${settings.textSize} pt`;
  undoBtn.disabled = !store.canUndo;
  redoBtn.disabled = !store.canRedo;
  if (viewer) zoomVal.textContent = `${Math.round((viewer.zoom / ACTUAL_SIZE) * 100)}%`;
  editor.classList.toggle("tool-box", settings.tool === "box");
  editor.classList.toggle("tool-text", settings.tool === "text");
  findApply.textContent = findMatches.length
    ? `${settings.color === "black" ? "Black out" : "White out"} all ${findMatches.length}`
    : "Cover all";
}

store.subscribe(() => {
  syncToolbar();
  if (!findbar.hidden && findMatches.length) void runFind();
});

// -------------------------------------------------------------------- find

function openFind(): void {
  findbar.hidden = false;
  findToggle.setAttribute("aria-expanded", "true");
  findInput.focus();
  findInput.select();
}

function closeFind(): void {
  findbar.hidden = true;
  findToggle.setAttribute("aria-expanded", "false");
  findInput.value = "";
  setPreset(null);
  findMatches = [];
  findCount.textContent = "";
  findApply.disabled = true;
  viewer?.setHighlights(new Map());
  syncToolbar();
}

function setPreset(p: Preset | null): void {
  activePreset = p;
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.preset === p));
  });
}

let findToken = 0;
async function runFind(): Promise<void> {
  if (!current || !viewer) return;
  const token = ++findToken;
  const pattern = activePreset ? PRESETS[activePreset].pattern : queryPattern(findInput.value);
  if (!pattern) {
    findMatches = [];
    findCount.textContent = "";
    findApply.disabled = true;
    viewer.setHighlights(new Map());
    syncToolbar();
    return;
  }
  const deleted = new Set(store.state.deleted);
  const pages = current.sizes.map((_, i) => i).filter((i) => !deleted.has(i));
  const all = await current.index.search(pattern, pages);
  if (token !== findToken) return;

  // Only count matches that aren't already fully covered by a box.
  const boxes = store.state.shapes.filter((s) => s.kind === "box");
  const open = all.filter((m) => m.rects.some((r) => !boxes.some((b) => b.page === m.page && covers(b, r))));
  findMatches = open;
  findCursor = -1;

  const hl = new Map<number, Rect[]>();
  for (const m of open) hl.set(m.page, [...(hl.get(m.page) ?? []), ...m.rects]);
  viewer.setHighlights(hl);

  if (!all.length) findCount.textContent = "No matches";
  else if (!open.length) findCount.textContent = `All ${all.length} covered`;
  else findCount.textContent = `${open.length} ${open.length === 1 ? "match" : "matches"}`;
  findApply.disabled = open.length === 0;
  syncToolbar();
}

function nextMatch(): void {
  if (!findMatches.length || !viewer) return;
  findCursor = (findCursor + 1) % findMatches.length;
  const m = findMatches[findCursor];
  viewer.scrollToRect(m.page, m.rects[0]);
}

function coverAll(): void {
  if (!findMatches.length || !viewer) return;
  const color = settings.color;
  const count = findMatches.length;
  store.commit((s) => {
    for (const m of findMatches) {
      for (const r of m.rects) {
        if (s.shapes.some((b) => b.kind === "box" && b.page === m.page && covers(b, r))) continue;
        s.shapes.push({ id: uid(), kind: "box", page: m.page, color, ...r });
      }
    }
  });
  toast(`${color === "black" ? "Blacked" : "Whited"} out ${count} ${count === 1 ? "match" : "matches"}.`, undefined, {
    label: "Undo",
    run: () => store.undo(),
  });
}

let findTimer = 0;
findInput.addEventListener("input", () => {
  setPreset(null);
  window.clearTimeout(findTimer);
  findTimer = window.setTimeout(() => void runFind(), 160);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nextMatch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
$("#chips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-preset]");
  if (!b) return;
  const p = b.dataset.preset as Preset;
  findInput.value = "";
  setPreset(activePreset === p ? null : p);
  void runFind();
});
findApply.addEventListener("click", coverAll);
$("#find-close").addEventListener("click", closeFind);
findToggle.addEventListener("click", () => (findbar.hidden ? openFind() : closeFind()));

// ---------------------------------------------------------------- download

async function download(): Promise<void> {
  if (!current) return;
  viewer?.finishEditing();
  menu.hidden = true;
  menuToggle.setAttribute("aria-expanded", "false");
  const name = outputName(current.name);
  showBusy("Preparing your PDF");
  try {
    const res = await exportPdf({
      bytes: current.bytes,
      doc: current.doc,
      sizes: current.sizes,
      state: store.snapshot(),
      flattenAll: flattenAll.checked,
      onProgress: (done, total) => showBusy(`Preparing page ${done} of ${total}`),
    });
    saveFile(new Blob([res.bytes as BlobPart], { type: "application/pdf" }), name);
    savedRevision = store.revision;

    let detail: string;
    if (res.forcedFlatten) {
      detail = "Every page was flattened because the original couldn't be copied directly. Metadata removed.";
    } else if (res.flattened === 0) {
      detail = "No pages needed flattening. Metadata removed.";
    } else {
      detail = `${res.flattened} of ${res.pages} ${res.pages === 1 ? "page" : "pages"} flattened, so covered text is gone for good. Metadata removed.`;
    }
    toast(`Downloaded ${name}`, detail);
  } catch (err) {
    console.error(err);
    toast("The download couldn't be prepared.", "Try again, or turn on Flatten every page in the download options.");
  } finally {
    showBusy(null);
  }
}

$("#download").addEventListener("click", () => void download());
menuToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  menuToggle.setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", (e) => {
  if (!menu.hidden && !(e.target as HTMLElement).closest("#split")) {
    menu.hidden = true;
    menuToggle.setAttribute("aria-expanded", "false");
  }
});

// ------------------------------------------------------------ wire buttons

$("#choose").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f) void openFile(f);
});
$("#close-file").addEventListener("click", () => closeFile());
$("#go-merge").addEventListener("click", () => startTool("merge"));
$("#go-split").addEventListener("click", () => startTool("split"));
$("#go-text").addEventListener("click", () => startTool("text"));
$("#go-images").addEventListener("click", () => startTool("images"));
$("#go-numbers").addEventListener("click", () => startTool("numbers"));
$("#go-rotate").addEventListener("click", () => startTool("rotate"));
$("#go-organize").addEventListener("click", () => startTool("organize"));
$("#go-compress").addEventListener("click", () => startTool("compress"));
$("#go-compare").addEventListener("click", () => startTool("compare"));
$("#go-ocr").addEventListener("click", () => startTool("ocr"));
$("#go-sign").addEventListener("click", () => startTool("sign"));
$("#go-word").addEventListener("click", () => startTool("word"));
$("#go-topdf").addEventListener("click", () => startTool("topdf"));
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool)),
);
document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) =>
  b.addEventListener("click", () => setColor(b.dataset.color as Color)),
);
sizeCtl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-size]");
  if (b) stepTextSize(Number(b.dataset.size));
});
undoBtn.addEventListener("click", () => store.undo());
redoBtn.addEventListener("click", () => store.redo());
$("#zoom-in").addEventListener("click", () => stepZoom(1));
$("#zoom-out").addEventListener("click", () => stepZoom(-1));
zoomVal.addEventListener("click", () => {
  viewer?.fitWidth();
  syncToolbar();
});
scroller.addEventListener("wheel", () => requestAnimationFrame(syncToolbar), { passive: true });

// --------------------------------------------------------------- keyboard

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

document.addEventListener("keydown", (e) => {
  if (pwDialog.open) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mode !== "home" && mode !== "editor" && mod && key === "s") {
    e.preventDefault();
    void tools[mode].download();
    return;
  }
  if (!current || !viewer) return;

  if (mod && key === "f") {
    e.preventDefault();
    openFind();
    return;
  }
  if (mod && key === "s") {
    e.preventDefault();
    void download();
    return;
  }
  if (isTyping(e.target)) return;

  if (mod && key === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && key === "y") {
    e.preventDefault();
    store.redo();
  } else if (mod && (key === "=" || key === "+")) {
    e.preventDefault();
    stepZoom(1);
  } else if (mod && key === "-") {
    e.preventDefault();
    stepZoom(-1);
  } else if (mod && key === "0") {
    e.preventDefault();
    viewer.fitWidth();
    syncToolbar();
  } else if (mod) {
    return;
  } else if (key === "b") {
    setTool("box");
  } else if (key === "t") {
    setTool("text");
  } else if (key === "x") {
    setColor(settings.color === "black" ? "white" : "black");
  } else if (key === "delete" || key === "backspace") {
    if (viewer.selectedId) {
      e.preventDefault();
      viewer.deleteSelected();
    }
  } else if (key === "escape") {
    if (!menu.hidden) menu.hidden = true;
    else if (viewer.selectedId) viewer.select(null);
    else if (!findbar.hidden) closeFind();
  } else if (key === "enter" && viewer.selected?.kind === "text") {
    e.preventDefault();
    viewer.editText(viewer.selected.id, false);
  } else if (key.startsWith("arrow") && viewer.selectedId) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
    const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
    viewer.nudge(dx, dy);
  }
});

// ------------------------------------------------------------ drag & drop

let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  const items = Array.from(e.dataTransfer?.items ?? []);
  const many = items.length > 1;
  const onlyImages = items.length > 0 && items.every((it) => it.type.startsWith("image/"));
  const docs = items.length > 0 && items.every((it) => /wordprocessingml|^text\/(markdown|plain)$/.test(it.type));
  const labels: Record<Mode, string> = {
    merge: "Drop PDFs to add them",
    split: "Drop a PDF to split it",
    text: "Drop a PDF to get its text",
    images: "Drop images to add them",
    numbers: "Drop a PDF to number its pages",
    rotate: "Drop a PDF to rotate it",
    organize: "Drop a PDF to organize it",
    compress: "Drop a PDF to compress it",
    compare: "Drop one or both PDFs to compare",
    ocr: "Drop a scanned PDF to read it",
    sign: "Drop a PDF to sign it",
    word: "Drop PDFs to turn them into Word documents",
    topdf: "Drop Word files to turn them into PDFs",
    editor: "Drop your PDF to open it",
    home: docs
      ? `Drop to turn ${many ? "these" : "this"} into ${many ? "PDFs" : "a PDF"}`
      : onlyImages
      ? many
        ? "Drop to make a PDF from these images"
        : "Drop to turn this image into a PDF"
      : many
        ? "Drop to merge these PDFs"
        : "Drop your PDF to open it",
  };
  dropText.textContent = labels[mode];
  dropzone.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  if (isMulti(mode)) void tools[mode].add(files);
  else if (mode !== "home" && mode !== "editor") void tools[mode].load(files.find(isPdf) ?? files[0]);
  else if (files.filter(isPdf).length > 1) startTool("merge", files);
  else if (!files.some(isPdf) && files.some(isImage)) startTool("images", files);
  else if (!files.some(isPdf) && files.some((f) => documentKind(f))) startTool("topdf", files);
  else void openFile(files.find(isPdf) ?? files[0]);
});

window.addEventListener("beforeunload", (e) => {
  if (unsaved()) e.preventDefault();
});

window.addEventListener("resize", () => requestAnimationFrame(syncToolbar));

syncToolbar();
