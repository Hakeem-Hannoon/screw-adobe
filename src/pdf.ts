// The legacy build ships polyfills for newer JS built-ins pdf.js relies on
// (e.g. Map.prototype.getOrInsertComputed), so it works in more browsers.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assets = new URL("./pdfjs/", document.baseURI).href;

export { pdfjs };

/**
 * Open a PDF from bytes. `askPassword` is called for protected files; resolve
 * with null to cancel. The caller's buffer is copied because pdf.js transfers
 * (and detaches) whatever it's given.
 */
export function openPdf(
  bytes: Uint8Array,
  askPassword: (wrongPassword: boolean) => Promise<string | null>,
): Promise<{ doc: PDFDocumentProxy; password: string | null }> {
  let password: string | null = null;
  const task = pdfjs.getDocument({
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
