import type { PDFDocumentProxy } from "pdfjs-dist";
import { isCancelled, openPdf, pageSizes } from "./pdf";
import { askPassword } from "./ui";
import type { PageSize } from "./types";

/** An opened PDF the merge and split tools can pull pages from. */
export interface PdfSource {
  id: string;
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  sizes: PageSize[];
}

let counter = 0;

/**
 * Open a PDF file, asking for its password if it has one. Resolves with null
 * if they cancel the password prompt; rejects if the file can't be read.
 */
export async function loadSource(file: File): Promise<PdfSource | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocumentProxy;
  try {
    ({ doc } = await openPdf(bytes, (wrong) => askPassword(wrong, file.name)));
  } catch (err) {
    const dialog = document.querySelector<HTMLDialogElement>("#pw-dialog");
    if (dialog?.open) dialog.close();
    if (isCancelled(err)) return null;
    throw err;
  }
  counter += 1;
  return { id: `f${counter}`, name: file.name, bytes, doc, sizes: await pageSizes(doc) };
}

export function closeSource(src: PdfSource): void {
  void src.doc.loadingTask.destroy();
}
