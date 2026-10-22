// Copies the static assets pdf.js loads at runtime (CMaps for CJK text,
// standard font data, image-decoder wasm, ICC profiles) into public/pdfjs/
// so they're served from our own origin. Runs automatically before dev/build.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const outRoot = join(process.cwd(), "public", "pdfjs");

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const src = join(pdfjsRoot, dir);
  if (existsSync(src)) cpSync(src, join(outRoot, dir), { recursive: true });
}

console.log("pdf.js assets copied to public/pdfjs/");
