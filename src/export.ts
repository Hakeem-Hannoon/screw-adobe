import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFObject,
} from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { INK, TEXT_FONT, TEXT_LINE_HEIGHT, type DocState, type PageSize, type Shape } from "./types";

const DPI = 200;
const MAX_PIXELS = 16_000_000;
const JPEG_QUALITY = 0.92;

export interface ExportOptions {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  state: DocState;
  flattenAll: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface ExportResult {
  bytes: Uint8Array;
  pages: number;
  flattened: number;
  /** True when the source couldn't be copied (e.g. encrypted) so every page was flattened. */
  forcedFlatten: boolean;
}

/**
 * Build a clean PDF:
 * - Pages with any edits are rendered to an image with the boxes and text
 *   burned in, so the text underneath is gone, not just covered.
 * - Untouched pages are copied as-is, minus anything that could point back at
 *   other pages of the original (links, form-field parents, page back-refs).
 * - It's a brand-new document, so no title/author/metadata, bookmarks,
 *   attachments or scripts carry over. Unreachable objects are dropped.
 */
export async function exportPdf(opts: ExportOptions): Promise<ExportResult> {
  const { bytes, doc, sizes, state, onProgress } = opts;
  const deleted = new Set(state.deleted);
  const order = sizes.map((_, i) => i).filter((i) => !deleted.has(i));

  const byPage = new Map<number, Shape[]>();
  for (const s of state.shapes) {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page)!.push(s);
  }

  let src: PDFDocument | null = null;
  if (!opts.flattenAll) {
    try {
      src = await PDFDocument.load(bytes, { updateMetadata: false });
      if (src.isEncrypted) src = null;
    } catch {
      src = null;
    }
  }
  const forcedFlatten = !opts.flattenAll && src === null;

  const flatten = new Set(order.filter((i) => !src || byPage.has(i)));
  const copyIdx = order.filter((i) => !flatten.has(i));

  const out = await PDFDocument.create({ updateMetadata: false });

  const copied = new Map<number, Awaited<ReturnType<PDFDocument["copyPages"]>>[number]>();
  if (src && copyIdx.length) {
    const srcPages = src.getPages();
    for (const i of copyIdx) sanitizePage(srcPages[i].node);
    const pages = await out.copyPages(src, copyIdx);
    copyIdx.forEach((i, k) => copied.set(i, pages[k]));
  }

  if (flatten.size) await document.fonts.load(`16px ${TEXT_FONT}`);

  let done = 0;
  for (const i of order) {
    if (flatten.has(i)) {
      const size = sizes[i];
      const jpg = await rasterize(doc, i, size, byPage.get(i) ?? []);
      const img = await out.embedJpg(jpg);
      const page = out.addPage([size.w, size.h]);
      page.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h });
    } else {
      out.addPage(copied.get(i)!);
    }
    done += 1;
    onProgress?.(done, order.length);
  }

  collectGarbage(out);
  const saved = await out.save({ useObjectStreams: true });
  return { bytes: saved, pages: order.length, flattened: flatten.size, forcedFlatten };
}

async function rasterize(
  doc: PDFDocumentProxy,
  index: number,
  size: PageSize,
  shapes: Shape[],
): Promise<Uint8Array> {
  const page = await doc.getPage(index + 1);
  let scale = DPI / 72;
  const pixels = size.w * size.h * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;

  // Boxes first, then text on top, matching the editor's stacking.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const s of shapes) {
    if (s.kind !== "box") continue;
    // Snap outward to whole pixels so no anti-aliased sliver of text survives at the edges.
    const x0 = Math.floor(s.x * scale);
    const y0 = Math.floor(s.y * scale);
    const x1 = Math.ceil((s.x + s.w) * scale);
    const y1 = Math.ceil((s.y + s.h) * scale);
    ctx.fillStyle = INK[s.color];
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  for (const s of shapes) {
    if (s.kind !== "text" || !s.text) continue;
    const px = s.size * scale;
    const lineH = px * TEXT_LINE_HEIGHT;
    ctx.font = `${px}px ${TEXT_FONT}`;
    ctx.fillStyle = INK[s.color];
    ctx.textBaseline = "alphabetic";
    const m = ctx.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent || px * 0.95;
    const descent = m.fontBoundingBoxDescent || px * 0.25;
    // Same half-leading placement CSS uses, so it lands where it looked in the editor.
    const baseline = (lineH - (ascent + descent)) / 2 + ascent;
    s.text.split("\n").forEach((line, n) => {
      ctx.fillText(line, s.x * scale, s.y * scale + n * lineH + baseline);
    });
  }

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode page image"))), "image/jpeg", JPEG_QUALITY),
  );
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();
  return new Uint8Array(await blob.arrayBuffer());
}

const N = (name: string) => PDFName.of(name);

/** Cut references from a page that would drag other pages (or private data) into the copy. */
function sanitizePage(node: PDFDict): void {
  for (const key of ["B", "Metadata", "PieceInfo", "AA"]) node.delete(N(key));
  const annots = node.lookup(N("Annots"));
  if (!(annots instanceof PDFArray)) return;
  for (let k = 0; k < annots.size(); k++) {
    const annot = annots.lookup(k);
    if (!(annot instanceof PDFDict)) continue;
    // P = owning page, Parent = form field tree (siblings can live on other pages),
    // Dest / GoTo actions point at other pages.
    for (const key of ["P", "Parent", "Dest", "AA"]) annot.delete(N(key));
    const action = annot.lookup(N("A"));
    if (action instanceof PDFDict) {
      const kind = action.lookup(N("S"));
      if (!(kind instanceof PDFName) || kind !== N("URI")) annot.delete(N("A"));
    }
  }
}

/** Remove every indirect object not reachable from the document catalog. */
function collectGarbage(doc: PDFDocument): void {
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const roots = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean) as PDFObject[];
  stack.push(...roots);

  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }

  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) ctx.delete(ref);
  }
}
