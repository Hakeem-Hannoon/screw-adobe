// Copies what Tesseract (the OCR engine) loads at runtime into public/tesseract/
// so it's served from our own origin, like the pdf.js assets: the worker
// script, the engine compiled to WebAssembly (three builds; the browser
// picks the fastest it supports), and the trained English model.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = (pkg) => dirname(require.resolve(`${pkg}/package.json`));
const out = join(process.cwd(), "public", "tesseract");

rmSync(out, { recursive: true, force: true });
for (const dir of ["core", "lang"]) mkdirSync(join(out, dir), { recursive: true });

copyFileSync(join(root("tesseract.js"), "dist", "worker.min.js"), join(out, "worker.min.js"));
for (const build of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) {
  const file = `tesseract-core-${build}.wasm.js`;
  copyFileSync(join(root("tesseract.js-core"), file), join(out, "core", file));
}
// "best_int": the accurate model, stored compactly (about 3 MB).
copyFileSync(
  join(root("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"),
  join(out, "lang", "eng.traineddata.gz"),
);

console.log("OCR assets copied to public/tesseract/");
