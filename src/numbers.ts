import { degrees, PDFDocument, rgb, StandardFonts, type PDFPage } from "pdf-lib";
import { buildPdfs } from "./combine";
import type { PdfSource } from "./source";

export type NumberFormat = "n" | "page" | "n-of" | "page-of";

export interface NumberOptions {
  /** Where the number's center goes, as a fraction of the page from its top-left corner (as the page is seen). */
  fx: number;
  fy: number;
  format: NumberFormat;
  /** Text size in points. */
  size: number;
  /** Leave the first page (a cover, say) without a number. The count still includes it. */
  skipFirst: boolean;
}

export const FORMATS: Record<NumberFormat, string> = {
  n: "1",
  page: "Page 1",
  "n-of": "1 / 9",
  "page-of": "Page 1 of 9",
};

export function label(format: NumberFormat, n: number, total: number): string {
  switch (format) {
    case "n":
      return `${n}`;
    case "page":
      return `Page ${n}`;
    case "n-of":
      return `${n} / ${total}`;
    case "page-of":
      return `Page ${n} of ${total}`;
  }
}

/**
 * Center of a w x h label meant to sit at (fx, fy) on a W x H page, nudged
 * inward so it never runs off an edge. Works in any unit.
 */
export function anchor(fx: number, fy: number, W: number, H: number, w: number, h: number, pad: number) {
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return {
    x: clamp(fx * W, w / 2 + pad, W - w / 2 - pad),
    y: clamp(fy * H, h / 2 + pad, H - h / 2 - pad),
  };
}

/**
 * A copy of the PDF with page numbers drawn on. It's built like a merge or
 * split (a brand-new file, metadata and links between pages left out,
 * password-protected pages turned into images), then numbered.
 */
export async function addPageNumbers(
  src: PdfSource,
  opts: NumberOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; flattened: number }> {
  const all = src.sizes.map((_, index) => ({ src, index }));
  const [built] = await buildPdfs([all], onProgress);
  const doc = await PDFDocument.load(built.bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    if (opts.skipFirst && i === 0) return;
    const text = label(opts.format, i + 1, pages.length);
    drawLabel(page, text, font, opts);
  });
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, flattened: built.flattened };
}

/**
 * A point given as seen (from the top-left, y down, in points) converted to
 * the page's own coordinates (from the bottom-left, y up), undoing the
 * page's rotation. `angle` is how far to turn text drawn there so it reads
 * upright once the page is shown.
 */
export function visualToUser(
  page: PDFPage,
  vx: number,
  vy: number,
): { x: number; y: number; angle: 0 | 90 | 180 | 270 } {
  const box = page.getCropBox();
  const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  if (r === 0) return { x: box.x + vx, y: box.y + box.height - vy, angle: r };
  if (r === 90) return { x: box.x + vy, y: box.y + vx, angle: r };
  if (r === 180) return { x: box.x + box.width - vx, y: box.y + vy, angle: r };
  return { x: box.x + box.width - vy, y: box.y + box.height - vx, angle: r };
}

/** The page's size as seen, which for a rotated page isn't how it's stored. */
export function visualSize(page: PDFPage): { w: number; h: number } {
  const box = page.getCropBox();
  const r = (((page.getRotation().angle % 360) + 360) % 360) as number;
  return r === 90 || r === 270 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
}

function drawLabel(
  page: PDFPage,
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  opts: NumberOptions,
) {
  const { w: VW, h: VH } = visualSize(page);
  const w = font.widthOfTextAtSize(text, opts.size);
  const capHeight = font.heightAtSize(opts.size, { descender: false });
  const c = anchor(opts.fx, opts.fy, VW, VH, w, capHeight, opts.size * 0.4);
  // Where the label's start sits, as seen: left edge, baseline.
  const at = visualToUser(page, c.x - w / 2, c.y + capHeight / 2);
  // Turned by the page's rotation so it reads upright once the page is shown.
  page.drawText(text, { x: at.x, y: at.y, size: opts.size, font, color: rgb(0, 0, 0), rotate: degrees(at.angle) });
}
