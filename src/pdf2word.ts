import { buildDocx, buildPictureDocx, type Align, type DocxBlock, type DocxModel, type HeaderLine } from "./docx";
import { extractPages, type Line } from "./extract";
import { ocrPage, ocrToLines } from "./ocr";
import { pageImages, type PageImage } from "./pageimages";
import { joinPages, measure, pageBlocks, runningLines, type Block, type Running } from "./structure";
import type { PdfSource } from "./source";

/** What's on each page of a PDF, read once and reused for previews and downloads. */
export interface Analysis {
  layouts: Line[][];
  images: PageImage[][];
  /** Pages with no text at all: scans, or pictures of text. */
  scanned: number[];
  /** Pages read with OCR. */
  ocred: number[];
}

export async function analyze(src: PdfSource, onPage?: (done: number, total: number) => void): Promise<Analysis> {
  const layouts = await extractPages(src.doc, { fonts: true });
  const images: PageImage[][] = [];
  for (let i = 0; i < src.doc.numPages; i++) {
    const page = await src.doc.getPage(i + 1);
    try {
      images.push(await pageImages(page, { hasText: layouts[i].length > 0 }));
    } catch (err) {
      console.error(err);
      images.push([]);
    } finally {
      page.cleanup();
    }
    onPage?.(i + 1, src.doc.numPages);
  }
  const scanned = layouts.flatMap((l, i) => (l.length ? [] : [i]));
  return { layouts, images, scanned, ocred: [] };
}

/** Read the pages that have no text with OCR. Their full-page scan picture is dropped in favour of the text. */
export async function ocrScanned(src: PdfSource, a: Analysis, onStatus: (text: string) => void): Promise<void> {
  const todo = a.scanned.filter((i) => !a.ocred.includes(i));
  for (const [k, i] of todo.entries()) {
    onStatus(`Reading scanned page ${i + 1} (${k + 1} of ${todo.length})`);
    const res = await ocrPage(src.doc, i, onStatus);
    const lines = ocrToLines(res);
    if (!lines.length) continue;
    a.layouts[i] = lines;
    a.ocred.push(i);
    // Keep pictures that are only part of the page, like a photo in a scanned letter.
    const { w, h } = src.sizes[i];
    a.images[i] = a.images[i].filter((img) => img.w * img.h < w * h * 0.6);
  }
}

export interface WordOptions {
  /** Start each PDF page on a new Word page. */
  keepBreaks: boolean;
}

export interface Summary {
  pages: number;
  pictures: number;
  tables: number;
  headings: number;
  header: boolean;
  footer: boolean;
}

/** The Word document's content, worked out from the analysis. */
export function wordModel(src: PdfSource, a: Analysis, opts: WordOptions): { model: DocxModel; summary: Summary } {
  const running = runningLines(a.layouts);
  const layouts = a.layouts.map((lines, i) => lines.filter((l) => !running.skip[i].has(l)));
  const stats = measure(layouts);

  const perPage: DocxBlock[][] = layouts.map((lines, i) => {
    const blocks: DocxBlock[] = pageBlocks(lines, stats);
    // Pictures go before the first block that starts below them.
    const ux = lines[0]?.ux ?? 1;
    const uy = lines[0]?.uy ?? 0;
    const across = (x: number, y: number) => -x * uy + y * ux;
    const pictures = a.images[i]
      .map((image) => {
        const [x0, y0, x1, y1] = image.box;
        const top = Math.max(across(x0, y0), across(x1, y0), across(x0, y1), across(x1, y1));
        return { image, top };
      })
      .sort((p, q) => q.top - p.top);
    for (const pic of pictures) {
      const at = blocks.findIndex((b) => b.kind !== "img" && b.kind !== "break" && (b as Block).top < pic.top - 1);
      const img: DocxBlock = { kind: "img", image: pic.image };
      if (at < 0) blocks.push(img);
      else blocks.splice(at, 0, img);
    }
    return blocks;
  });

  let blocks: DocxBlock[];
  if (opts.keepBreaks) {
    blocks = perPage.flatMap((b, i) => (i > 0 ? [{ kind: "break" } as DocxBlock, ...b] : b));
  } else {
    blocks = joinPages(perPage as Block[][]) as DocxBlock[];
  }

  const first = src.sizes[0] ?? { w: 612, h: 792 };
  const align = (r: Running): Align => {
    const mid = (r.line.start + r.line.end) / 2;
    if (Math.abs(mid - first.w / 2) < first.w * 0.08) return "center";
    return r.line.start > first.w * 0.5 ? "right" : "left";
  };
  const lines = (rs: Running[]): HeaderLine[] => rs.map((r) => ({ text: r.text, align: align(r) }));

  const body = stats.body > 0 ? Math.min(16, Math.max(7, stats.body)) : 11;
  const model: DocxModel = {
    page: first,
    margin: first.w < 420 ? 36 : 72,
    body,
    headings: stats.headings.slice(0, 3).map((s) => Math.min(40, s)),
    blocks,
    header: lines(running.header),
    footer: lines(running.footer),
  };
  const count = (k: DocxBlock["kind"]) => blocks.filter((b) => b.kind === k).length;
  return {
    model,
    summary: {
      pages: src.doc.numPages,
      pictures: count("img"),
      tables: count("table"),
      headings: count("h"),
      header: model.header.length > 0,
      footer: model.footer.length > 0,
    },
  };
}

export function editableDocx(src: PdfSource, a: Analysis, opts: WordOptions): Blob {
  return buildDocx(wordModel(src, a, opts).model);
}

/** Every page as a picture: looks exactly like the PDF, but can't be edited. */
export async function pictureDocx(src: PdfSource, onPage?: (done: number, total: number) => void): Promise<Blob> {
  const pages = [];
  for (let i = 0; i < src.doc.numPages; i++) {
    const page = await src.doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    canvas.width = canvas.height = 0;
    page.cleanup();
    if (!blob) throw new Error("Couldn't draw a page");
    const { w, h } = src.sizes[i];
    pages.push({ image: { data: new Uint8Array(await blob.arrayBuffer()), type: "jpeg" as const, w, h }, w, h });
    onPage?.(i + 1, src.doc.numPages);
  }
  return buildPictureDocx(pages);
}
