import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

/**
 * Turn one page's pdf.js text items into plain text.
 *
 * pdf.js hands back runs of text with positions but not much structure, so
 * lines, spaces and paragraph breaks are rebuilt from where each run sits.
 * Everything is measured along the text's own direction, so rotated text
 * and rotated pages come out the same as upright ones.
 */
export function itemsToText(items: ReadonlyArray<TextItem | TextMarkedContent>): string {
  const lines = toLines(items);

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

  let out = "";
  lines.forEach((line, i) => {
    if (i > 0) {
      out += "\n";
      const drop = lineDrop(lines[i - 1], line);
      // A bigger-than-usual drop to the next line starts a new paragraph.
      if (drop !== null && drop > Math.max(usual * 1.4, Math.min(line.size, lines[i - 1].size) * 1.6)) out += "\n";
    }
    out += line.text;
  });
  return tidy(out);
}

interface Line {
  text: string;
  across: number; // baseline position, measured perpendicular to the text
  size: number;
  ux: number;
  uy: number;
}

/** Distance down to the next line, or null when they aren't comparable (different direction, or moving up). */
function lineDrop(a: Line, b: Line): number | null {
  if (Math.abs(a.ux - b.ux) > 0.01 || Math.abs(a.uy - b.uy) > 0.01) return null;
  const drop = a.across - b.across;
  return drop > Math.min(a.size, b.size) * 0.5 ? drop : null;
}

/** Group text runs into lines, adding the spaces the PDF left implicit. */
function toLines(items: ReadonlyArray<TextItem | TextMarkedContent>): Line[] {
  const lines: Line[] = [];
  let line: Line | null = null;
  let end = 0; // where the previous run stopped, along the text
  let forceBreak = false;

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
      const gap = along - end;
      if (gap > Math.min(size, line.size) * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) line.text += " ";
      line.text += item.str;
      line.size = Math.max(line.size, size);
    } else {
      line = { text: item.str, across, size, ux, uy };
      lines.push(line);
    }
    end = along + Math.abs(item.width);
    forceBreak = item.hasEOL;
  }
  for (const l of lines) l.text = l.text.replace(/[ \t]+$/, "");
  return lines;
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

/** Text of every page, in order. Pages without a text layer come back as "". */
export async function extractPages(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items));
    page.cleanup();
    onProgress?.(i, doc.numPages);
  }
  return pages;
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
