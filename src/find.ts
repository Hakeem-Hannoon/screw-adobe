import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import { pdfjs } from "./pdf";
import type { Rect } from "./types";

interface Span {
  start: number;
  end: number;
  item: TextItem;
  tx: number[]; // item transform in page-point space
  style: TextStyle | undefined;
}

interface PageText {
  text: string;
  spans: Span[];
}

export interface Match {
  page: number;
  rects: Rect[];
}

export type Preset = "email" | "phone" | "number";

export const PRESETS: Record<Preset, { label: string; pattern: RegExp }> = {
  email: {
    label: "Emails",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi,
  },
  phone: {
    label: "Phone numbers",
    pattern: /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g,
  },
  number: {
    // Account, card, SIN/SSN-style numbers: 6+ digits, optionally grouped.
    label: "Long numbers",
    pattern: /(?<![\w.])\d(?:[\s-]?\d){5,}(?![\w])/g,
  },
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turn what someone typed into a forgiving pattern: case-insensitive, any run of whitespace matches. */
export function queryPattern(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const source = q.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(source, "gi");
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, family: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length;
  measureCtx.font = `100px ${family}`;
  return measureCtx.measureText(text).width;
}

/** Text index for a whole document, built lazily and cached. */
export class TextIndex {
  private pages = new Map<number, Promise<PageText>>();

  constructor(private doc: PDFDocumentProxy) {}

  private load(index: number): Promise<PageText> {
    let p = this.pages.get(index);
    if (!p) {
      p = this.build(index);
      this.pages.set(index, p);
    }
    return p;
  }

  private async build(index: number): Promise<PageText> {
    const page = await this.doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let text = "";
    const spans: Span[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as TextItem;
      if (item.str) {
        const tx = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        spans.push({
          start: text.length,
          end: text.length + item.str.length,
          item,
          tx,
          style: content.styles[item.fontName],
        });
        text += item.str;
      }
      if (item.hasEOL) text += "\n";
    }
    return { text, spans };
  }

  async search(pattern: RegExp, pageIndices: number[]): Promise<Match[]> {
    const out: Match[] = [];
    for (const index of pageIndices) {
      const pt = await this.load(index);
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      for (const m of pt.text.matchAll(re)) {
        if (!m[0] || !m[0].trim()) continue;
        const start = m.index ?? 0;
        const rects = rectsFor(pt, start, start + m[0].length);
        if (rects.length) out.push({ page: index, rects });
      }
    }
    return out;
  }
}

function rectsFor(pt: PageText, start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  for (const span of pt.spans) {
    if (span.end <= start || span.start >= end) continue;
    const ls = Math.max(start, span.start) - span.start;
    const le = Math.min(end, span.end) - span.start;
    const str = span.item.str;
    // Skip pieces that are only whitespace (e.g. the gap between two words).
    if (!str.slice(ls, le).trim()) continue;
    rects.push(spanRect(span, ls, le));
  }
  return rects;
}

/**
 * Box around characters [ls, le) of a text item. Works for rotated text and
 * rotated pages by transforming the glyph box corners and taking their bounds.
 */
function spanRect(span: Span, ls: number, le: number): Rect {
  const { item, tx, style } = span;
  const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 10;
  const ascent = style?.ascent && style.ascent > 0 ? style.ascent : 0.8;
  const descent = style?.descent && style.descent < 0 ? -style.descent : 0.2;
  const ox = tx[4];
  const oy = tx[5];

  if (style?.vertical) {
    // Vertical writing: just cover the whole run.
    return pad({ x: ox - fontHeight / 2, y: oy, w: fontHeight, h: Math.abs(item.height) || fontHeight });
  }

  const ulen = Math.hypot(tx[0], tx[1]) || 1;
  const ux = tx[0] / ulen;
  const uy = tx[1] / ulen;
  const vlen = Math.hypot(tx[2], tx[3]) || 1;
  // Screen direction of the text's "up".
  const vx = tx[2] / vlen;
  const vy = tx[3] / vlen;

  // pdf.js only reports where a whole run of text starts and ends, so the
  // characters inside are located by measuring. Prefer the PDF's own font
  // (registered by pdf.js once the page has rendered), then its generic family.
  const family = `"${item.fontName}", ${style?.fontFamily || "sans-serif"}`;
  const total = measure(item.str, family);
  const runLength = Math.abs(item.width);
  const r0 = total ? measure(item.str.slice(0, ls), family) / total : ls / item.str.length;
  const r1 = total ? measure(item.str.slice(0, le), family) / total : le / item.str.length;
  // Measuring can be off by part of a character, so err on the side of covering
  // a little extra rather than leaving a sliver of a secret showing.
  const slack = fontHeight * 0.28;
  const a = Math.max(0, runLength * r0 - (ls > 0 ? slack : 0));
  const b = Math.min(runLength, runLength * r1 + (le < item.str.length ? slack : 0));
  const up = ascent * fontHeight;
  const down = descent * fontHeight;

  const corners = [
    [ox + ux * a + vx * up, oy + uy * a + vy * up],
    [ox + ux * b + vx * up, oy + uy * b + vy * up],
    [ox + ux * a - vx * down, oy + uy * a - vy * down],
    [ox + ux * b - vx * down, oy + uy * b - vy * down],
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return pad({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
}

function pad(r: Rect): Rect {
  const p = Math.max(0.75, Math.min(r.h * 0.08, 2));
  return { x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 };
}

/** True if `outer` already covers nearly all of `inner` (avoids stacking duplicate boxes). */
export function covers(outer: Rect, inner: Rect): boolean {
  const ix = Math.max(0, Math.min(outer.x + outer.w, inner.x + inner.w) - Math.max(outer.x, inner.x));
  const iy = Math.max(0, Math.min(outer.y + outer.h, inner.y + inner.h) - Math.max(outer.y, inner.y));
  return ix * iy >= inner.w * inner.h * 0.9;
}
