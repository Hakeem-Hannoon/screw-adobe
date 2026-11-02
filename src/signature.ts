import "@fontsource/mrs-saint-delafield/400.css";
import "@fontsource/herr-von-muellerhoff/400.css";
import "@fontsource/homemade-apple/400.css";
import "@fontsource/la-belle-aurore/400.css";
import "@fontsource/cedarville-cursive/400.css";
import "@fontsource/ms-madi/400.css";
import "@fontsource/nothing-you-could-do/400.css";
import "@fontsource/dawning-of-a-new-day/400.css";
import "@fontsource/zeyada/400.css";
import "@fontsource/kristi/400.css";
import "@fontsource/waiting-for-the-sunrise/400.css";
import "@fontsource/great-vibes/400.css";
import "@fontsource/alex-brush/400.css";
import "@fontsource/pinyon-script/400.css";
import "@fontsource/monsieur-la-doulaise/400.css";
import "@fontsource/italianno/400.css";
import "@fontsource/imperial-script/400.css";
import { degrees, PDFDocument } from "pdf-lib";
import { buildPdfs } from "./combine";
import { visualSize, visualToUser } from "./numbers";
import type { PdfSource } from "./source";

export const INKS = {
  black: { label: "Black", color: [22, 22, 26] },
  blue: { label: "Blue", color: [28, 63, 148] },
  navy: { label: "Dark blue", color: [17, 38, 92] },
} as const;
export type Ink = keyof typeof INKS;

export type StyleGroup = "natural" | "fancy";

/**
 * Handwriting fonts for typed signatures. "Natural" ones look like an
 * everyday pen signature; "fancy" ones are calligraphy and formal script.
 */
export const STYLES: readonly { family: string; group: StyleGroup }[] = [
  { family: "Herr Von Muellerhoff", group: "natural" },
  { family: "Homemade Apple", group: "natural" },
  { family: "La Belle Aurore", group: "natural" },
  { family: "Cedarville Cursive", group: "natural" },
  { family: "Nothing You Could Do", group: "natural" },
  { family: "Dawning of a New Day", group: "natural" },
  { family: "Zeyada", group: "natural" },
  { family: "Kristi", group: "natural" },
  { family: "Waiting for the Sunrise", group: "natural" },
  { family: "Mrs Saint Delafield", group: "fancy" },
  { family: "Ms Madi", group: "fancy" },
  { family: "Great Vibes", group: "fancy" },
  { family: "Alex Brush", group: "fancy" },
  { family: "Pinyon Script", group: "fancy" },
  { family: "Monsieur La Doulaise", group: "fancy" },
  { family: "Italianno", group: "fancy" },
  { family: "Imperial Script", group: "fancy" },
];

/** A finished signature: a transparent PNG and its size in pixels. */
export interface Signature {
  png: Uint8Array;
  url: string;
  w: number;
  h: number;
}

/** One pen stroke: points with the time they were drawn (for speed-based width). */
export type Stroke = { x: number; y: number; t: number }[];

const BASE = 140; // typed signatures are drawn at this pixel size, then trimmed

/** Make sure a font has loaded before drawing with it on a canvas. */
export async function loadFont(family: string): Promise<void> {
  await document.fonts.load(`${BASE}px "${family}"`, "Signature");
}

/**
 * A typed name drawn in a handwriting font, with a slight slant and ink
 * texture. Fonts differ a lot in how big their letters are at the same
 * size, so each is scaled until its capitals stand the same height.
 */
export async function typedSignature(name: string, family: string, ink: Ink): Promise<Signature> {
  await loadFont(family);
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `100px "${family}"`;
  const cap = measure.measureText("H").actualBoundingBoxAscent || 70;
  const size = Math.min(BASE * 2, Math.max(BASE * 0.6, (BASE * 70) / cap));
  const font = `${size}px "${family}"`;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const width = probe.measureText(name).width;
  const canvas = document.createElement("canvas");
  // Generous room: handwriting fonts swing well past their nominal box.
  canvas.width = Math.ceil(width + size * 1.6);
  canvas.height = Math.ceil(size * 2.4);
  const g = canvas.getContext("2d")!;
  g.font = font;
  g.textBaseline = "alphabetic";
  g.fillStyle = rgb(ink);
  g.translate(size * 0.8, size * 1.45);
  g.rotate((-2.5 * Math.PI) / 180); // people sign a touch uphill
  g.fillText(name, 0, 0);
  return finish(canvas, ink);
}

/**
 * Hand-drawn strokes rendered the way a pen lays ink: thinner where the
 * stroke moved fast, thicker where it slowed, with smoothed curves between
 * points. `scale` maps stroke coordinates to output pixels.
 */
export function drawStrokes(g: CanvasRenderingContext2D, strokes: Stroke[], scale: number, ink: Ink): void {
  g.fillStyle = rgb(ink);
  const maxW = 3.6 * scale;
  const minW = 1.0 * scale;
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    if (stroke.length === 1) {
      dot(g, stroke[0].x * scale, stroke[0].y * scale, maxW / 2);
      continue;
    }
    let v = 0;
    let lastW = (maxW + minW) / 2;
    const widths: number[] = [lastW];
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.t - a.t); // px per ms
      v = 0.7 * speed + 0.3 * v;
      const target = Math.max(minW, maxW / (v * 1.6 + 1));
      lastW = lastW * 0.6 + target * 0.4; // ease width changes so the line doesn't wobble
      widths.push(lastW);
    }
    // Quadratic curves through the midpoints, stamped with round dots.
    const P = stroke.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    let prev = P[0];
    for (let i = 1; i < P.length; i++) {
      const mid = i < P.length - 1 ? { x: (P[i].x + P[i + 1].x) / 2, y: (P[i].y + P[i + 1].y) / 2 } : P[i];
      const c = P[i];
      const w0 = widths[i - 1];
      const w1 = widths[i];
      const len = Math.hypot(c.x - prev.x, c.y - prev.y) + Math.hypot(mid.x - c.x, mid.y - c.y);
      const steps = Math.max(2, Math.ceil(len / (minW * 0.35)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = (1 - t) * (1 - t) * prev.x + 2 * (1 - t) * t * c.x + t * t * mid.x;
        const y = (1 - t) * (1 - t) * prev.y + 2 * (1 - t) * t * c.y + t * t * mid.y;
        dot(g, x, y, (w0 + (w1 - w0) * t) / 2);
      }
      prev = mid;
    }
  }
}

/** A drawn signature at print resolution. */
export function drawnSignature(strokes: Stroke[], ink: Ink): Signature | null {
  const pts = strokes.flat();
  if (!pts.length) return null;
  const scale = 3; // pad pixels to output pixels: sharp when printed
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = 8;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((Math.max(...xs) - x0 + pad) * scale);
  canvas.height = Math.ceil((Math.max(...ys) - y0 + pad) * scale);
  const g = canvas.getContext("2d")!;
  const shifted = strokes.map((s) => s.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })));
  drawStrokes(g, shifted, scale, ink);
  return finish(canvas, ink);
}

function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, Math.max(0.3, r), 0, Math.PI * 2);
  g.fill();
}

const rgb = (ink: Ink) => `rgb(${INKS[ink].color.join(",")})`;

/**
 * Give the ink a ballpoint's slight unevenness (density varying in soft
 * patches, never holes), trim to the ink, and encode as a PNG.
 */
function finish(canvas: HTMLCanvasElement, ink: Ink): Signature {
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const W = canvas.width;
  const H = canvas.height;
  const noise = valueNoise(W, H, 5, 7);
  const [r, gg, b] = INKS[ink].color;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = d[i + 3];
      if (!a) continue;
      d[i] = r;
      d[i + 1] = gg;
      d[i + 2] = b;
      d[i + 3] = Math.round(a * (0.8 + 0.2 * noise[y * W + x]));
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  g.putImageData(img, 0, 0);
  const pad = 4;
  const tx = Math.max(0, x0 - pad);
  const ty = Math.max(0, y0 - pad);
  const tw = Math.min(W, x1 + pad + 1) - tx;
  const th = Math.min(H, y1 + pad + 1) - ty;
  const out = document.createElement("canvas");
  out.width = Math.max(1, tw);
  out.height = Math.max(1, th);
  out.getContext("2d")!.drawImage(canvas, tx, ty, tw, th, 0, 0, tw, th);
  const url = out.toDataURL("image/png");
  const bin = atob(url.split(",")[1]);
  const png = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i);
  return { png, url, w: out.width, h: out.height };
}

/** Smooth random values in 0-1, from a coarse grid blended at a few scales. */
function valueNoise(W: number, H: number, cell: number, seed: number): Float32Array {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const out = new Float32Array(W * H);
  const layers = [
    { c: cell, wt: 0.6 },
    { c: cell * 4, wt: 0.4 },
  ];
  for (const { c, wt } of layers) {
    const gw = Math.ceil(W / c) + 2;
    const gh = Math.ceil(H / c) + 2;
    const grid = new Float32Array(gw * gh).map(rand);
    for (let y = 0; y < H; y++) {
      const gy = y / c;
      const iy = Math.floor(gy);
      const fy = gy - iy;
      for (let x = 0; x < W; x++) {
        const gx = x / c;
        const ix = Math.floor(gx);
        const fx = gx - ix;
        const a = grid[iy * gw + ix];
        const b = grid[iy * gw + ix + 1];
        const cc = grid[(iy + 1) * gw + ix];
        const dd = grid[(iy + 1) * gw + ix + 1];
        const top = a + (b - a) * fx;
        const bot = cc + (dd - cc) * fx;
        out[y * W + x] += (top + (bot - top) * fy) * wt;
      }
    }
  }
  return out;
}

/** Where a signature goes: its center and width as fractions of the page as seen. */
export interface Placement {
  id: number;
  page: number;
  fx: number;
  fy: number;
  fw: number;
}

/**
 * The PDF with the signature stamped where placed. The original file is
 * kept as it is (form fields, links, bookmarks and all), with only the
 * signature added. Password-protected files can't be edited that way, so
 * they're rebuilt like a merge, with their pages turned into images.
 */
export async function signPdf(src: PdfSource, sig: Signature, places: Placement[]): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    if (doc.isEncrypted) throw new Error("encrypted");
  } catch {
    const [built] = await buildPdfs([src.sizes.map((_, index) => ({ src, index }))]);
    doc = await PDFDocument.load(built.bytes, { updateMetadata: false });
  }
  const image = await doc.embedPng(sig.png);
  const pages = doc.getPages();
  for (const p of places) {
    const page = pages[p.page];
    if (!page) continue;
    const { w: VW } = visualSize(page);
    const w = p.fw * VW;
    const h = w * (sig.h / sig.w);
    const cx = p.fx * VW;
    const cy = p.fy * visualSize(page).h;
    // The image's bottom-left corner as seen, then into the page's own coordinates.
    const at = visualToUser(page, cx - w / 2, cy + h / 2);
    page.drawImage(image, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(at.angle) });
  }
  return doc.save();
}
