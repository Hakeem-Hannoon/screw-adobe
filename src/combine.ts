import { PDFDocument, type PDFPage } from "pdf-lib";
import { collectGarbage, rasterize, sanitizePage } from "./export";
import type { PdfSource } from "./source";

/** One page of one source file. */
export interface PickedPage {
  src: PdfSource;
  index: number; // 0-based page index in src
}

export interface BuildResult {
  bytes: Uint8Array;
  pages: number;
  /** Pages that had to be turned into images (their source couldn't be copied, e.g. it's encrypted). */
  flattened: number;
}

/**
 * Build one new PDF per list of pages. Used for merging (one output, pages
 * from several files) and splitting (several outputs from one file).
 *
 * Every output is a brand-new document, held to the same rules as the
 * redactor's download: pages are copied with anything that could reach other
 * pages of the original cut away (internal links, form-field trees, page
 * back-references), unreachable objects are dropped, and no metadata,
 * bookmarks, attachments or scripts carry over. So a split part can't
 * quietly drag along pages you left out.
 *
 * Pages from files pdf-lib can't copy (password-protected ones) are rendered
 * to images instead, like the redactor does.
 */
export async function buildPdfs(
  outputs: PickedPage[][],
  onProgress?: (done: number, total: number) => void,
): Promise<BuildResult[]> {
  const libDocs = new Map<PdfSource, PDFDocument | null>();
  const libDoc = async (src: PdfSource): Promise<PDFDocument | null> => {
    if (!libDocs.has(src)) {
      let d: PDFDocument | null = null;
      try {
        d = await PDFDocument.load(src.bytes, { updateMetadata: false });
        if (d.isEncrypted) d = null;
      } catch {
        d = null;
      }
      if (d) for (const page of d.getPages()) sanitizePage(page.node);
      libDocs.set(src, d);
    }
    return libDocs.get(src)!;
  };

  const total = outputs.reduce((n, pages) => n + pages.length, 0);
  let done = 0;
  const results: BuildResult[] = [];

  for (const picked of outputs) {
    const out = await PDFDocument.create({ updateMetadata: false });

    // Copy each source's pages in one call so objects they share (fonts,
    // images) are only written once, then hand them out in order.
    const wanted = new Map<PdfSource, number[]>();
    for (const p of picked) {
      if (!wanted.has(p.src)) wanted.set(p.src, []);
      wanted.get(p.src)!.push(p.index);
    }
    const copied = new Map<PdfSource, PDFPage[]>();
    for (const [src, indices] of wanted) {
      const lib = await libDoc(src);
      if (lib) copied.set(src, await out.copyPages(lib, indices));
    }

    let flattened = 0;
    for (const p of picked) {
      const queue = copied.get(p.src);
      if (queue) {
        out.addPage(queue.shift()!);
      } else {
        const size = p.src.sizes[p.index];
        const jpg = await rasterize(p.src.doc, p.index, size, []);
        const img = await out.embedJpg(jpg);
        const page = out.addPage([size.w, size.h]);
        page.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h });
        flattened += 1;
      }
      done += 1;
      onProgress?.(done, total);
    }

    collectGarbage(out);
    const bytes = await out.save({ useObjectStreams: true });
    results.push({ bytes, pages: picked.length, flattened });
  }
  return results;
}
