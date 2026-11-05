// Adds the headline, sub line and frame to every raw screen and writes the
// final App Store screenshots to final/<device>/ at the exact required size.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
const font = readFileSync(new URL("../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2", import.meta.url)).toString("base64");
const slides = [
  ["1-home", "Every PDF tool.", "[Free.]", "No ads. No account. Nothing uploaded."],
  ["2-redact", "Black out", "[anything]", "The text underneath is really gone."],
  ["3-find", "Cover every", "[match] at once", "Emails, phone and account numbers in one tap."],
  ["4-sign", "Sign in your", "[own hand]", "20 handwriting styles, or draw your own."],
  ["8-signed", "Tap. Place.", "[Signed.]", "Drag to move, pull the corner to resize."],
  ["5-merge", "Merge PDFs", "in [seconds]", "Drag to reorder. Split them just as fast."],
  ["6-organize", "Every page", "at a [glance]", "Reorder, delete or extract pages."],
  ["7-convert", "PDF to Word,", "and [back]", "Images and text too. Works offline."],
];
const dev = {
  iphone: { W: 1320, H: 2868, shotW: 1040, top: 150, h1: 112, sub: 46, gap: 26, radius: 64, after: 92 },
  ipad: { W: 2064, H: 2752, shotW: 1560, top: 140, h1: 120, sub: 48, gap: 26, radius: 40, after: 92 },
};
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
for (const [name, d] of Object.entries(dev)) {
  const out = `final/${name === "iphone" ? "iPhone 6.9in (1320x2868)" : "iPad 13in (2064x2752)"}`;
  mkdirSync(out, { recursive: true });
  const page = await b.newPage({ viewport: { width: d.W, height: d.H }, deviceScaleFactor: 1 });
  let n = 0;
  for (const [file, l1, l2, sub] of slides) {
    n++;
    const img = readFileSync(`raw/${name}-${file}.png`).toString("base64");
    const hl = l2.replace(/\[(.+?)\]/, '<span class="bar">$1</span>');
    await page.setContent(`<!doctype html><html><head><style>
      @font-face{font-family:PS;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}
      *{box-sizing:border-box;margin:0}
      html,body{width:${d.W}px;height:${d.H}px;overflow:hidden;background:#e3e5e8;font-family:PS}
      .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding-top:${d.top}px}
      h1{font-size:${d.h1}px;font-weight:800;letter-spacing:-0.045em;line-height:1.13;color:#000;text-align:center}
      .bar{background:#000;color:#fff;padding:0 .14em;margin:0 -.02em;border-radius:.06em;box-decoration-break:clone;-webkit-box-decoration-break:clone}
      p{margin-top:${d.gap + 10}px;font-size:${d.sub}px;font-weight:500;color:#41464d;text-align:center;max-width:${d.shotW + 40}px;line-height:1.3;letter-spacing:-0.01em}
      .shot{margin-top:${d.after}px;width:${d.shotW}px;border-radius:${d.radius}px;overflow:hidden;
            box-shadow:0 0 0 ${name==="iphone"?14:12}px #0b0c0e, 0 40px 90px rgba(20,24,30,.28)}
      .shot img{display:block;width:100%}
    </style></head><body><div class="wrap"><h1>${l1}<br>${hl}</h1><p>${sub}</p><div class="shot"><img src="data:image/png;base64,${img}"></div></div></body></html>`);
    await page.waitForTimeout(300);
    const path = `${out}/${String(n).padStart(2, "0")}-${file.replace(/^\d-/, "")}.png`;
    await page.screenshot({ path, type: "png", omitBackground: false });
    console.log(path);
  }
  await page.close();
}
await b.close();
