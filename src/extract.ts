import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

/** A stretch of a line in one font style. */
export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface Line {
  text: string;
  runs: Run[];
  /** Baseline position, measured perpendicular to the text. */
  across: number;
  /** Where the line starts and ends, measured along the text. */
  start: number;
  end: number;
  size: number;
  ux: number;
  uy: number;
  /** A paragraph break comes before this line. */
  paraBreak: boolean;
  /** The line split at wide gaps, like columns of a table. One cell for ordinary text. */
  cells: string[];
}

export type FontStyle = (fontName: string) => { bold: boolean; italic: boolean };
const PLAIN: FontStyle = () => ({ bold: false, italic: false });

/**
 * Turn one page's pdf.js text items into lines, with paragraph breaks marked.
 *
 * pdf.js hands back runs of text with positions but not much structure, so
 * lines, spaces and paragraph breaks are rebuilt from where each run sits.
 * Everything is measured along the text's own direction, so rotated text
 * and rotated pages come out the same as upright ones.
 */
export function layoutPage(items: ReadonlyArray<TextItem | TextMarkedContent>, style: FontStyle = PLAIN): Line[] {
  const lines = toLines(items, style);

  // Typical distance from one line to the next on this page: the most common
  // drop is the body text's line spacing. Judging gaps against it (not a fixed
  // number) keeps double-spaced pages from turning every line into a paragraph.
  const counts = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const drop = lineDrop(lines[i - 1], lines[i]);
    if (drop === null) continue;
    const bin = Math.round(drop * 2) / 2;
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  let usual = Infinity;
  let best = 0;
  for (const [drop, n] of counts) {
    if (n > best || (n === best && drop < usual)) {
      usual = drop;
      best = n;
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const drop = lineDrop(lines[i - 1], lines[i]);
    // A bigger-than-usual drop to the next line starts a new paragraph.
    lines[i].paraBreak =
      drop !== null && drop > Math.max(usual * 1.4, Math.min(lines[i].size, lines[i - 1].size) * 1.6);
  }
  return lines;
}

/** Plain text of a laid-out page. */
export function layoutText(lines: Line[]): string {
  return tidy(lines.map((l, i) => (i > 0 && l.paraBreak ? "\n" : "") + l.text).join("\n"));
}

/** Plain text of one page's items. */
export function itemsToText(items: ReadonlyArray<TextItem | TextMarkedContent>): string {
  return layoutText(layoutPage(items));
}

/** Distance down to the next line, or null when they aren't comparable (different direction, or moving up). */
function lineDrop(a: Line, b: Line): number | null {
  if (Math.abs(a.ux - b.ux) > 0.01 || Math.abs(a.uy - b.uy) > 0.01) return null;
  const drop = a.across - b.across;
  return drop > Math.min(a.size, b.size) * 0.5 ? drop : null;
}

/** Group text runs into lines, adding the spaces the PDF left implicit. */
function toLines(items: ReadonlyArray<TextItem | TextMarkedContent>, style: FontStyle): Line[] {
  const lines: Line[] = [];
  const sizes = new Map<Line, Map<number, number>>();
  let line: Line | null = null;
  let forceBreak = false;

  const append = (l: Line, text: string, fontName: string) => {
    const { bold, italic } = style(fontName);
    const last = l.runs[l.runs.length - 1];
    if (last && last.bold === bold && last.italic === italic) last.text += text;
    else l.runs.push({ text, bold, italic });
    l.text += text;
    l.cells[l.cells.length - 1] += text;
  };
  const count = (l: Line, size: number, n: number) => {
    const m = sizes.get(l)!;
    const k = Math.round(size * 2) / 2;
    m.set(k, (m.get(k) ?? 0) + n);
  };

  for (const raw of items) {
    if (!("str" in raw)) continue;
    const item = raw;
    if (!item.str) {
      if (item.hasEOL) forceBreak = true;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || Math.abs(item.height) || 10;
    // Unit vector along the text; "across" is the position perpendicular to it.
    const ulen = Math.hypot(a, b) || 1;
    const ux = a / ulen;
    const uy = b / ulen;
    const along = e * ux + f * uy;
    const across = -e * uy + f * ux;

    const sameLine =
      line !== null &&
      !forceBreak &&
      Math.abs(ux - line.ux) < 0.01 &&
      Math.abs(uy - line.uy) < 0.01 &&
      Math.abs(across - line.across) < Math.min(size, line.size) * 0.5;

    if (line && sameLine) {
      // A visible gap between runs is a space the PDF didn't write out.
      const gap = along - line.end;
      if (gap > Math.min(size, line.size) * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) {
        append(line, " ", item.fontName);
      }
      // A wide gap separates columns.
      if (gap > Math.min(size, line.size) && item.str.trim()) line.cells.push("");
      append(line, item.str, item.fontName);
    } else {
      line = { text: "", runs: [], across, start: along, end: along, size, ux, uy, paraBreak: false, cells: [""] };
      sizes.set(line, new Map());
      append(line, item.str, item.fontName);
      lines.push(line);
    }
    count(line, size, item.str.trim().length);
    // pdf.js fills gaps with space items as wide as the gap; they don't count
    // as where the text ends, or columns would look joined up.
    if (item.str.trim()) line.end = Math.max(line.end, along + Math.abs(item.width));
    forceBreak = item.hasEOL;
  }
  for (const l of lines) {
    // A line's size is the one most of its characters are set in, so a big
    // bullet or drop cap doesn't make it look like a heading.
    let most = -1;
    for (const [size, n] of sizes.get(l)!) {
      if (n > most) {
        l.size = size;
        most = n;
      }
    }
    l.cells = l.cells.map((c) => c.trim()).filter((c) => c);
    if (!l.cells.length) l.cells = [""];
    l.text = l.text.replace(/[ \t]+$/, "");
    const last = l.runs[l.runs.length - 1];
    if (last) last.text = last.text.replace(/[ \t]+$/, "");
  }
  return lines.filter((l) => l.text.trim());
}

/** Trim line ends, drop stray control characters, and cap blank runs at one line. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lay out every page, in order. Pages without a text layer come back empty.
 * With `fonts`, bold and italic are picked up from font names (which costs
 * parsing each page's drawing commands, so only Markdown asks for it).
 */
export async function extractPages(
  doc: PDFDocumentProxy,
  opts: {
    fonts?: boolean;
    onProgress?: (done: number, total: number) => void;
    /**
     * A look at each page's text items before they're laid out, to take
     * some out or swap some in (the handwriting tool lifts equations and
     * figures out this way). Gets the page, its items, a lookup from an
     * item's font id to the font's real name, and the page's index.
     */
    prepare?: (
      page: PDFPageProxy,
      items: ReadonlyArray<TextItem | TextMarkedContent>,
      nameOf: (fontId: string) => string,
      index: number,
    ) => Promise<ReadonlyArray<TextItem | TextMarkedContent>>;
  } = {},
): Promise<Line[][]> {
  const pages: Line[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let style = PLAIN;
    const nameOf = (id: string) => fontName(page.commonObjs, id);
    if ((opts.fonts || opts.prepare) && content.items.some((it) => "str" in it && it.str.trim())) {
      try {
        // Loads the page's fonts, so their real names can be looked up.
        await page.getOperatorList();
        style = (name) => fontStyle(nameOf(name));
      } catch {
        // No styles, then.
      }
    }
    const items = opts.prepare ? await opts.prepare(page, content.items, nameOf, i - 1) : content.items;
    pages.push(layoutPage(items, style));
    page.cleanup();
    opts.onProgress?.(i, doc.numPages);
  }
  return pages;
}

export function fontName(objs: { has(id: string): boolean; get(id: string): unknown }, id: string): string {
  try {
    if (!objs.has(id)) return "";
    const font = objs.get(id) as { name?: unknown } | null;
    return typeof font?.name === "string" ? font.name : "";
  } catch {
    return "";
  }
}

const styleCache = new Map<string, { bold: boolean; italic: boolean }>();

/** "ABCDEF+Calibri-BoldItalic" -> bold and italic. */
export function fontStyle(name: string): { bold: boolean; italic: boolean } {
  let s = styleCache.get(name);
  if (!s) {
    const n = name.replace(/^[A-Z]{6}\+/, "");
    s = {
      bold: /bold|black|heavy|semibold|demi|extrab|ultrab|[-,_ ](bd|sb)\b/i.test(n),
      italic: /italic|oblique|[-,_ ](it|obl)\b/i.test(n),
    };
    styleCache.set(name, s);
  }
  return s;
}

export interface JoinOptions {
  /** Put a "Page N" heading above each page. */
  labels: boolean;
  /** Join the lines of each paragraph into one, so the text reflows. */
  reflow: boolean;
}

/** One text file from per-page text. */
export function joinPages(pages: string[], opts: JoinOptions): string {
  const body = opts.reflow ? pages.map(reflow) : pages;
  if (!opts.labels) return body.filter((p) => p).join("\n\n") + "\n";
  return body.map((p, i) => `--- Page ${i + 1} ---\n\n${p}`.trimEnd()).join("\n\n") + "\n";
}

/**
 * Undo the PDF's line wrapping: lines in a paragraph become one line. A line
 * ending in a hyphen joins the next without a space ("well-" + "known" stays
 * "well-known"). The hyphen is kept because there's no telling a word broken
 * to fit the line from one that's always hyphenated.
 */
function reflow(page: string): string {
  return page
    .split("\n\n")
    .map((para) => para.replace(/(\p{L})-[ \t]*\n\s*(?=\p{L})/gu, "$1-").replace(/\s*\n\s*/g, " "))
    .join("\n\n");
}

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}
