import type { PDFPageProxy } from "pdfjs-dist";
import { pdfjs } from "./pdf";

/** A picture found on a page, cut out of a render of it. */
export interface PageImage {
  /** PNG or JPEG bytes. */
  data: Uint8Array;
  type: "png" | "jpeg";
  /** Pixel size of the cut-out. */
  px: { w: number; h: number };
  /** Size on the page, in points. */
  w: number;
  h: number;
  /** Bounding box in PDF user space (y up). */
  box: Box;
}

export type Box = [x0: number, y0: number, x1: number, y1: number];
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Where each image on a page is drawn, in PDF user space. */
export async function imageBoxes(page: PDFPageProxy): Promise<Box[]> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const boxes: Box[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = mul(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const m = args?.[0] as Matrix | null | undefined;
        if (m && m.length === 6) ctm = mul(ctm, [...m] as Matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.beginGroup: {
        stack.push(ctm);
        const m = (args?.[0] as { matrix?: Matrix } | undefined)?.matrix;
        if (m && m.length === 6) ctm = mul(ctm, [...m] as Matrix);
        break;
      }
      case OPS.endGroup:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        // An image fills the unit square of the current transform.
        const pts = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        break;
      }
    }
  }
  return boxes;
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Box, b: Box) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

/**
 * The pictures on a page, worth keeping in a Word version of it. Tiny ones
 * (bullets, rules, tracking pixels) are dropped, overlapping ones merged, and
 * when the page has text, an image filling the page is taken to be a
 * background or a scan under its OCR text, and left out.
 */
export async function pageImages(page: PDFPageProxy, opts: { hasText: boolean; scale?: number }): Promise<PageImage[]> {
  const view = page.view as Box; // the page's visible area in user space
  const pageArea = area(view);
  let boxes = (await imageBoxes(page))
    .map((b): Box => [
      Math.max(b[0], view[0]),
      Math.max(b[1], view[1]),
      Math.min(b[2], view[2]),
      Math.min(b[3], view[3]),
    ])
    .filter((b) => b[2] - b[0] >= 12 && b[3] - b[1] >= 12)
    .filter((b) => !opts.hasText || area(b) < pageArea * 0.85);

  // Pieces of one picture (some PDFs draw a photo as strips) become one.
  const merged: Box[] = [];
  for (const b of boxes.sort((a, c) => area(c) - area(a))) {
    const host = merged.find((m) => overlap(m, b) > area(b) * 0.5 || touching(m, b));
    if (host) {
      host[0] = Math.min(host[0], b[0]);
      host[1] = Math.min(host[1], b[1]);
      host[2] = Math.max(host[2], b[2]);
      host[3] = Math.max(host[3], b[3]);
    } else {
      merged.push([...b]);
    }
  }
  boxes = merged;
  if (!boxes.length) return [];

  const scale = opts.scale ?? 2;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;

  const out: PageImage[] = [];
  for (const box of boxes) {
    const [vx0, vy0] = viewport.convertToViewportPoint(box[0], box[1]) as number[];
    const [vx1, vy1] = viewport.convertToViewportPoint(box[2], box[3]) as number[];
    const x = Math.max(0, Math.floor(Math.min(vx0, vx1)));
    const y = Math.max(0, Math.floor(Math.min(vy0, vy1)));
    const w = Math.min(canvas.width - x, Math.ceil(Math.abs(vx1 - vx0)));
    const h = Math.min(canvas.height - y, Math.ceil(Math.abs(vy1 - vy0)));
    if (w < 4 || h < 4) continue;
    const crop = document.createElement("canvas");
    crop.width = w;
    crop.height = h;
    const cctx = crop.getContext("2d")!;
    cctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const type = isPhoto(cctx, w, h) ? "jpeg" : "png";
    const blob = await new Promise<Blob | null>((r) => crop.toBlob(r, `image/${type}`, 0.88));
    if (!blob) continue;
    // Rotated pages turn the box sideways on screen; the size follows the screen.
    out.push({
      data: new Uint8Array(await blob.arrayBuffer()),
      type,
      px: { w, h },
      w: w / scale,
      h: h / scale,
      box,
    });
  }
  canvas.width = canvas.height = 0;
  return out;
}

function touching(a: Box, b: Box): boolean {
  const gapX = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
  const gapY = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
  // Strips of one image share an edge exactly, and line up on the other axis.
  const alignedX = Math.abs(a[0] - b[0]) < 1 && Math.abs(a[2] - b[2]) < 1;
  const alignedY = Math.abs(a[1] - b[1]) < 1 && Math.abs(a[3] - b[3]) < 1;
  return (alignedX && Math.abs(gapY) < 1) || (alignedY && Math.abs(gapX) < 1);
}

/** Lots of distinct colours means a photo (JPEG); few means a logo, chart or screenshot (PNG). */
function isPhoto(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  const colours = new Set<number>();
  const step = Math.max(1, Math.floor((w * h) / 4000));
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4;
    colours.add(((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3));
    if (colours.size > 600) return true;
  }
  return false;
}
