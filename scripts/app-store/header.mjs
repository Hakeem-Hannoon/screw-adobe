// Builds the App Store product page header: the "HackerPDF" wordmark in the
// same style as the screenshots, with "PDF" in a black redaction bar.
// Writes an SVG (source) and a PNG (what App Store Connect accepts) into
// vault/Attachments/App Store/.
//
//   npm i --no-save playwright && node scripts/app-store/header.mjs
//   (CHROME=/path/to/chrome to use an installed Chrome)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const W = 3840, H = 1646; // one of Apple's two accepted header sizes
const SIZE = 440; // font size in px
const TRACK = -0.045; // letter spacing in em, as in the screenshot captions
const BG = "#e3e5e8";

const out = new URL("../../vault/Attachments/App Store/", import.meta.url);
const font = readFileSync(new URL("../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2", import.meta.url)).toString("base64");
const fontFace = `@font-face{font-family:PS;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}`;

const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

// Measure the two words with the real font.
await page.setContent(`<style>${fontFace}</style><span style="font:800 10px PS">.</span>`);
const m = await page.evaluate(async ({ SIZE, TRACK }) => {
  await document.fonts.load(`800 ${SIZE}px PS`);
  const c = document.createElement("canvas").getContext("2d");
  c.font = `800 ${SIZE}px PS`;
  c.letterSpacing = `${TRACK * SIZE}px`;
  const hacker = c.measureText("Hacker"), pdf = c.measureText("PDF");
  return { hacker: hacker.width, pdf: pdf.width, cap: pdf.actualBoundingBoxAscent };
}, { SIZE, TRACK });

const em = SIZE;
const padX = 0.14 * em; // same bar padding as the screenshot captions
const gap = 0.06 * em;
const barW = padX + m.pdf - TRACK * em + padX; // drop the trailing tracking inside the bar
const total = m.hacker + gap + barW;
const x0 = (W - total) / 2;
const baseline = H / 2 + m.cap / 2;
const barTop = baseline - m.cap - 0.17 * em;
const barH = m.cap + 0.17 * em + 0.13 * em;
const r = (n) => Math.round(n * 10) / 10;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>HackerPDF</title>
  <style>${fontFace} text{font-family:PS,"Public Sans",Helvetica,Arial,sans-serif;font-weight:800;font-size:${SIZE}px;letter-spacing:${TRACK}em}</style>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="${r(x0)}" y="${r(baseline)}" fill="#000">Hacker</text>
  <rect x="${r(x0 + m.hacker + gap)}" y="${r(barTop)}" width="${r(barW)}" height="${r(barH)}" rx="${r(0.06 * em)}" fill="#000"/>
  <text x="${r(x0 + m.hacker + gap + padX)}" y="${r(baseline)}" fill="#fff">PDF</text>
</svg>
`;
writeFileSync(new URL(`Header (${W}x${H}).svg`, out), svg);

await page.setContent(`<!doctype html><style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}</style>${svg}`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: fileURLToPath(new URL(`Header (${W}x${H}).png`, out)), clip: { x: 0, y: 0, width: W, height: H } });
await b.close();
console.log(`wrote Header (${W}x${H}).svg and .png`);
