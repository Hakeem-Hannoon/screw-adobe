import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  beginText,
  endText,
  PDFDocument,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode,
  type PDFFont,
} from "pdf-lib";
import type { Worker } from "tesseract.js";
import { buildPdfs } from "./combine";
import type { Line } from "./extract";
import { visualToUser } from "./numbers";
import type { PdfSource } from "./source";

/** A word OCR found, with its box in points on the page as seen (from the top-left). */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Baseline height at the word, in points from the top. */
  base: number;
}

export interface OcrLine {
  words: OcrWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: number;
  /** First line of a paragraph. */
  paraStart: boolean;
}

export interface OcrPage {
  lines: OcrLine[];
  /** Average confidence, 0-100. */
  confidence: number;
  /**
   * Quarter turns (clockwise) the page needed to read upright: 0 for a normal
   * page, 1 for one whose text runs bottom to top, and so on. Word positions
   * are given on the page turned that way.
   */
  turn: 0 | 1 | 2 | 3;
  /** The page's size as seen, in points (before any turning). */
  w: number;
  h: number;
}

const assets = new URL("./tesseract/", document.baseURI).href;
let worker: Promise<Worker> | null = null;

/**
 * The OCR engine, started on first use. It and its English model (about
 * 7 MB together) are served from this site and cached by the browser.
 */
function engine(onLoad?: (text: string) => void): Promise<Worker> {
  if (!worker) {
    onLoad?.("Loading the text recognizer (first time only)");
    worker = import("tesseract.js")
      .then(({ createWorker, OEM }) =>
        createWorker("eng", OEM.LSTM_ONLY, {
          workerPath: `${assets}worker.min.js`,
          corePath: `${assets}core/`,
          langPath: `${assets}lang/`,
          workerBlobURL: false,
          gzip: true,
        }),
      )
      .catch((err) => {
        worker = null;
        throw err;
      });
  }
  return worker;
}

/** Stop the engine to free its memory (it's started again when needed). */
export async function stopEngine(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate().catch(() => {});
}

/** True when a page has (almost) no text of its own, like a scan. */
export async function needsOcr(doc: PDFDocumentProxy, index: number): Promise<boolean> {
  const page = await doc.getPage(index + 1);
  const content = await page.getTextContent();
  let chars = 0;
  for (const item of content.items) if ("str" in item) chars += item.str.replace(/\s/g, "").length;
  return chars < 20;
}

/**
 * Read one page: render it at about 300 dpi and recognize the text on it. If
 * it reads badly, the page may be sideways or upside down, so the other three
 * orientations are tried and the best reading kept.
 */
export async function ocrPage(doc: PDFDocumentProxy, index: number, onLoad?: (t: string) => void): Promise<OcrPage> {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  // ~300 dpi, but no side over 4200 px so huge pages stay manageable.
  const scale = Math.min(300 / 72, 4200 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();

  const w = await engine(onLoad);
  let best = await read(w, canvas, 0, scale, base.width, base.height);
  if (best.confidence < 60 || best.lines.length < 2) {
    for (const turn of [1, 2, 3] as const) {
      const turned = await read(w, rotated(canvas, turn), turn, scale, base.width, base.height);
      if (turned.confidence > best.confidence + 10 && turned.lines.length) best = turned;
    }
  }
  canvas.width = canvas.height = 0;
  return best;
}

/** A copy of the canvas turned clockwise by quarter turns. */
function rotated(src: HTMLCanvasElement, turn: 1 | 2 | 3): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const side = turn !== 2;
  c.width = side ? src.height : src.width;
  c.height = side ? src.width : src.height;
  const g = c.getContext("2d")!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((turn * Math.PI) / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

async function read(
  w: Worker,
  canvas: HTMLCanvasElement,
  turn: 0 | 1 | 2 | 3,
  scale: number,
  pw: number,
  ph: number,
): Promise<OcrPage> {
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  const pt = (v: number) => v / scale;
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      para.lines.forEach((line, k) => {
        const bl = line.baseline;
        const slope = bl.x1 !== bl.x0 ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : 0;
        const baseAt = (x: number, fallback: number) => {
          const v = bl.y0 + slope * (x - bl.x0);
          return Number.isFinite(v) && v > 0 ? v : fallback;
        };
        const words = line.words
          .filter((wd) => wd.text.trim() && wd.confidence > 20)
          .map((wd) => ({
            text: wd.text.trim(),
            x0: pt(wd.bbox.x0),
            y0: pt(wd.bbox.y0),
            x1: pt(wd.bbox.x1),
            y1: pt(wd.bbox.y1),
            base: pt(baseAt(wd.bbox.x0, wd.bbox.y1)),
          }));
        if (!words.length) return;
        lines.push({
          words,
          x0: pt(line.bbox.x0),
          y0: pt(line.bbox.y0),
          x1: pt(line.bbox.x1),
          y1: pt(line.bbox.y1),
          base: pt(baseAt(line.bbox.x0, line.bbox.y1)),
          paraStart: k === 0,
        });
      });
    }
  }
  return { lines, confidence: lines.length ? data.confidence : 0, turn, w: pw, h: ph };
}

/** A point on the turned page back to the page as seen. */
function unturn(page: OcrPage, x: number, y: number): { x: number; y: number } {
  const { w, h } = page;
  if (page.turn === 1) return { x: y, y: h - x };
  if (page.turn === 2) return { x: w - x, y: h - y };
  if (page.turn === 3) return { x: w - y, y: x };
  return { x, y };
}

/**
 * OCR'd lines in the same shape the text extractor produces, so PDF to text
 * (plain or Markdown) treats a scanned page like any other.
 */
export function ocrToLines(page: OcrPage): Line[] {
  return page.lines.map((l) => {
    const text = l.words.map((w) => w.text).join(" ");
    const size = Math.max(4, (l.base - l.y0) * 1.25);
    // A gap wider than about two letters' height between words separates columns.
    const cells: string[] = [];
    l.words.forEach((w, k) => {
      if (k === 0 || w.x0 - l.words[k - 1].x1 > size * 1.6) cells.push(w.text);
      else cells[cells.length - 1] += ` ${w.text}`;
    });
    return {
      text,
      runs: [{ text, bold: false, italic: false }],
      across: -l.base,
      start: l.x0,
      end: l.x1,
      size: Math.round(size * 2) / 2,
      ux: 1,
      uy: 0,
      paraBreak: l.paraStart,
      cells,
    };
  });
}

export interface SearchableResult {
  bytes: Uint8Array;
  /** Pages that were read with OCR. */
  read: number;
  /** Pages that already had text and were left alone. */
  skipped: number;
  /** Everything OCR found, page by page, for showing. */
  text: string[];
  confidence: number;
}

/**
 * Make a scanned PDF searchable: each page without text is read with OCR,
 * and the words are laid over it as invisible text, sized and stretched to
 * sit exactly on the words in the picture. The page looks the same, but its
 * text can be selected, searched and copied. Pages that already have text
 * are left alone.
 */
export async function makeSearchable(src: PdfSource, onStatus: (text: string) => void): Promise<SearchableResult> {
  const total = src.sizes.length;
  const pages: (OcrPage | null)[] = [];
  for (let i = 0; i < total; i++) {
    if (!(await needsOcr(src.doc, i))) {
      pages.push(null);
      continue;
    }
    onStatus(`Reading page ${i + 1} of ${total}`);
    pages.push(await ocrPage(src.doc, i, onStatus));
  }

  onStatus("Adding the text layer");
  const [built] = await buildPdfs([src.sizes.map((_, index) => ({ src, index }))]);
  const doc = await PDFDocument.load(built.bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  doc.getPages().forEach((page, i) => {
    const ocr = pages[i];
    if (ocr) addTextLayer(page, ocr, font, charset);
  });
  const bytes = await doc.save({ useObjectStreams: true });

  const read = pages.filter(Boolean) as OcrPage[];
  const confidence = read.length ? read.reduce((s, p) => s + p.confidence, 0) / read.length : 100;
  return {
    bytes,
    read: read.length,
    skipped: total - read.length,
    text: pages.map((p) => (p ? p.lines.map((l) => l.words.map((w) => w.text).join(" ")).join("\n") : "")),
    confidence,
  };
}

function addTextLayer(
  page: ReturnType<PDFDocument["getPages"]>[number],
  ocr: OcrPage,
  font: PDFFont,
  charset: Set<number>,
): void {
  const key = page.node.newFontDictionary("OCR", font.ref);
  const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const line of ocr.lines) {
    for (const word of line.words) {
      // Helvetica's encoding can't hold every character; unknown ones become "?".
      const text = [...word.text].map((ch) => (charset.has(ch.codePointAt(0)!) ? ch : "?")).join("");
      const height = Math.max(1, word.base - word.y0);
      const size = height * 1.35; // cap height to font size, roughly
      const natural = font.widthOfTextAtSize(text, size);
      const width = word.x1 - word.x0;
      if (natural <= 0 || width <= 0) continue;
      // The word's start on its baseline, on the page as seen; then to the page's own coordinates.
      const p = unturn(ocr, word.x0, word.base);
      const at = visualToUser(page, p.x, p.y);
      // Text on a page that had to be turned to read runs that many quarter turns the other way.
      const rad = ((at.angle + ocr.turn * 90) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      ops.push(
        setFontAndSize(key, size),
        // Stretch so the invisible word covers exactly the word in the picture.
        PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of((width / natural) * 100)]),
        setTextMatrix(cos, sin, -sin, cos, at.x, at.y),
        showText(font.encodeText(text)),
      );
    }
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
