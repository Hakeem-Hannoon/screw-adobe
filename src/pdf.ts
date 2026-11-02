// The legacy build ships polyfills for newer JS built-ins pdf.js relies on
// (e.g. Map.prototype.getOrInsertComputed), so it works in more browsers.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PageSize } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assets = new URL("./pdfjs/", document.baseURI).href;

export { pdfjs };

/**
 * Open a PDF from bytes. `askPassword` is called for protected files; resolve
 * with null to cancel. `fontNames` keeps font names around for text styling.
 * The caller's buffer is copied because pdf.js transfers (and detaches)
 * whatever it's given.
 */
export function openPdf(
  bytes: Uint8Array,
  askPassword: (wrongPassword: boolean) => Promise<string | null>,
  opts: { fontNames?: boolean } = {},
): Promise<{ doc: PDFDocumentProxy; password: string | null }> {
  let password: string | null = null;
  const task = pdfjs.getDocument({
    // Keeps each font's real name (e.g. "Arial-BoldMT"), for spotting bold and italic text.
    fontExtraProperties: opts.fontNames ?? false,
    data: bytes.slice(),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    enableXfa: false,
  });

  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const wrong = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    void askPassword(wrong).then((pw) => {
      if (pw === null) {
        void task.destroy();
        return;
      }
      password = pw;
      update(pw);
    });
  };

  return task.promise.then((doc) => ({ doc, password }));
}

/** True when opening failed because the person cancelled the password prompt. */
export function isCancelled(err: unknown): boolean {
  return !(err instanceof pdfjs.InvalidPDFException) && /destroy|abort|cancel/i.test(String(err));
}

/** Every page's on-screen size in points (rotation applied). */
export async function pageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  const sizes: PageSize[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return sizes;
}
