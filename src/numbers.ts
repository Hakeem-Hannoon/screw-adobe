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

function drawLabel(
  page: PDFPage,
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  opts: NumberOptions,
) {
  const box = page.getCropBox();
  const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const sideways = r === 90 || r === 270;
  // The page as it's seen, which for a rotated page isn't how it's stored.
  const VW = sideways ? box.height : box.width;
  const VH = sideways ? box.width : box.height;

  const w = font.widthOfTextAtSize(text, opts.size);
  const capHeight = font.heightAtSize(opts.size, { descender: false });
  const c = anchor(opts.fx, opts.fy, VW, VH, w, capHeight, opts.size * 0.4);

  // Where the label's start sits, as seen: left edge, baseline.
  const vx = c.x - w / 2;
  const vy = c.y + capHeight / 2;

  // Seen coordinates (from the top-left, y down) to the page's own (from the
  // bottom-left, y up), undoing the page's rotation.
  let x: number;
  let y: number;
  if (r === 0) {
    x = box.x + vx;
    y = box.y + box.height - vy;
  } else if (r === 90) {
    x = box.x + vy;
    y = box.y + vx;
  } else if (r === 180) {
    x = box.x + box.width - vx;
    y = box.y + vy;
  } else {
    x = box.x + box.width - vy;
    y = box.y + box.height - vx;
  }
  // Turned by the page's rotation so it reads upright once the page is shown.
  page.drawText(text, { x, y, size: opts.size, font, color: rgb(0, 0, 0), rotate: degrees(r) });
}
