import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { collectGarbage } from "./export";

export interface Level {
  /** JPEG quality, 0-1. */
  quality: number;
  /** Longest side in pixels; bigger images are scaled down. */
  maxSide: number;
  /** Also turn losslessly stored photos and screenshots into JPEGs. */
  lossless: boolean;
}

export type LevelName = "light" | "strong" | "smallest";

export const LEVELS: Record<LevelName, Level> = {
  light: { quality: 0.82, maxSide: 2600, lossless: false },
  strong: { quality: 0.7, maxSide: 1800, lossless: true },
  smallest: { quality: 0.55, maxSide: 1200, lossless: true },
};

/** Tried after "smallest" when aiming for a size. */
const HARDER: Level[] = [
  { quality: 0.45, maxSide: 1000, lossless: true },
  { quality: 0.38, maxSide: 800, lossless: true },
];

export interface CompressResult {
  bytes: Uint8Array;
  /** Images that were shrunk. */
  changed: number;
  /** Images that could have been. */
  images: number;
}

/**
 * Shrink a PDF by re-compressing the photos inside it. Text, vector
 * drawings, fonts, links, bookmarks and form fields are left exactly as they
 * were, so text stays selectable and searchable.
 *
 * Only images that can be redone safely are touched: JPEGs and plain 8-bit
 * RGB or gray images, never transparency masks, CMYK or palette images, or
 * the 1-bit images scanners make. An image is only swapped when the new one
 * is clearly smaller. If the whole file doesn't come out smaller, the
 * original is returned.
 */
export async function compressPdf(
  original: Uint8Array,
  level: Level,
  onProgress?: (done: number, total: number) => void,
): Promise<CompressResult> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const ctx = doc.context;
  const candidates = findImages(doc);

  let changed = 0;
  for (const [k, { ref, stream }] of candidates.entries()) {
    try {
      const next = await shrink(stream, level);
      if (next) {
        ctx.assign(ref, next);
        changed += 1;
      }
    } catch {
      // Couldn't decode this one: leave it as it was.
    }
    onProgress?.(k + 1, candidates.length);
  }

  collectGarbage(doc);
  const bytes = await doc.save({ useObjectStreams: true });
  if (bytes.length >= original.length) return { bytes: original, changed: 0, images: candidates.length };
  return { bytes, changed, images: candidates.length };
}

/**
 * Try levels from lightest to harshest until the file fits under `target`
 * bytes. Returns the first that fits, or the smallest if none does.
 */
export async function compressToSize(
  original: Uint8Array,
  target: number,
  onStep?: (step: number, steps: number) => void,
): Promise<CompressResult & { fits: boolean }> {
  const ladder = [LEVELS.light, LEVELS.strong, LEVELS.smallest, ...HARDER];
  let best: CompressResult | null = null;
  for (const [i, level] of ladder.entries()) {
    onStep?.(i + 1, ladder.length);
    const res = await compressPdf(original, level);
    if (!best || res.bytes.length < best.bytes.length) best = res;
    if (res.bytes.length <= target) return { ...res, fits: true };
  }
  return { ...best!, fits: false };
}

/** How many images a PDF has that compression could touch. */
export async function countImages(original: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  return findImages(doc).length;
}

// ------------------------------------------------------------------ images

interface Candidate {
  ref: PDFRef;
  stream: PDFRawStream;
}

const name = (dict: PDFDict, key: string) => {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.asString() : null;
};
const num = (dict: PDFDict, key: string) => {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
};

/**
 * The image's real encoding (JPEG or Flate) and any text wrappers in front of
 * it (ASCII85 or hex, which some PDF makers add). Null if it's anything else.
 */
function filterOf(dict: PDFDict): { main: "/DCTDecode" | "/FlateDecode"; wrappers: string[] } | null {
  const f = dict.lookup(PDFName.of("Filter"));
  const list: string[] = [];
  if (f instanceof PDFName) list.push(f.asString());
  else if (f instanceof PDFArray) {
    for (let i = 0; i < f.size(); i++) {
      const x = f.lookup(i);
      if (!(x instanceof PDFName)) return null;
      list.push(x.asString());
    }
  } else return null;
  const main = list.pop();
  if (main !== "/DCTDecode" && main !== "/FlateDecode") return null;
  if (list.some((w) => w !== "/ASCII85Decode" && w !== "/A85" && w !== "/ASCIIHexDecode" && w !== "/AHx")) return null;
  // Decode parameters on a filter chain come as an array; only plain ones are handled.
  if (list.length && dict.lookup(PDFName.of("DecodeParms")) instanceof PDFArray) {
    const parms = dict.lookup(PDFName.of("DecodeParms")) as PDFArray;
    if (parms.size() !== list.length + 1) return null;
  }
  return { main, wrappers: list };
}

/** The stream's bytes with text wrappers removed, so what's left is JPEG or Flate data. */
function unwrap(stream: PDFRawStream, wrappers: string[]): Uint8Array {
  let data = stream.contents;
  for (const w of wrappers) data = w === "/ASCIIHexDecode" || w === "/AHx" ? fromHex(data) : fromAscii85(data);
  return data;
}

export function fromAscii85(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  let i = 0;
  // Optional "<~" start marker.
  if (src[0] === 0x3c && src[1] === 0x7e) i = 2;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === 0x7e) break; // "~>" end
    if (c <= 0x20) continue; // whitespace
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0); // "z" is four zero bytes
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new Error("Bad ASCII85");
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

function fromHex(src: Uint8Array): Uint8Array {
  const hex = new TextDecoder().decode(src).replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2).padEnd(2, "0"), 16);
  return out;
}

/** Color components of a color space we can redo: 1 (gray) or 3 (RGB). Anything else is null. */
function components(dict: PDFDict): 1 | 3 | null {
  const cs = dict.lookup(PDFName.of("ColorSpace"));
  const byName = (n: string) =>
    n === "/DeviceRGB" || n === "/CalRGB" ? 3 : n === "/DeviceGray" || n === "/CalGray" ? 1 : null;
  if (cs instanceof PDFName) return byName(cs.asString());
  if (cs instanceof PDFArray && cs.size() >= 1) {
    const kind = cs.lookup(0);
    if (!(kind instanceof PDFName)) return null;
    if (kind.asString() === "/ICCBased") {
      const profile = cs.lookup(1);
      const n = profile instanceof PDFStream ? num(profile.dict, "N") : null;
      return n === 3 ? 3 : n === 1 ? 1 : null;
    }
    return byName(kind.asString());
  }
  return null;
}

function findImages(doc: PDFDocument): Candidate[] {
  const ctx = doc.context;
  const all: Candidate[] = [];
  const masks = new Set<string>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || name(obj.dict, "Subtype") !== "/Image") continue;
    // Transparency masks belong to another image and must stay gray and exact.
    for (const key of ["SMask", "Mask"]) {
      const m = obj.dict.get(PDFName.of(key));
      if (m instanceof PDFRef) masks.add(m.toString());
    }
    all.push({ ref, stream: obj });
  }
  return all.filter(({ ref, stream }) => {
    const d = stream.dict;
    if (masks.has(ref.toString())) return false;
    if (d.lookup(PDFName.of("ImageMask"))?.toString() === "true") return false;
    if (d.has(PDFName.of("Decode")) || d.lookup(PDFName.of("Mask")) instanceof PDFArray) return false;
    if (num(d, "BitsPerComponent") !== 8 || !components(d)) return false;
    const w = num(d, "Width") ?? 0;
    const h = num(d, "Height") ?? 0;
    // Tiny images aren't worth it.
    if (w * h < 120_000 || stream.contents.length < 24_000) return false;
    return filterOf(d) !== null;
  });
}

/** A smaller replacement for an image stream, or null to keep it. */
async function shrink(stream: PDFRawStream, level: Level): Promise<PDFRawStream | null> {
  const d = stream.dict;
  const w = num(d, "Width")!;
  const h = num(d, "Height")!;
  const comps = components(d)!;
  const f = filterOf(d)!;
  const data = unwrap(stream, f.wrappers);

  let source: ImageBitmap;
  if (f.main === "/DCTDecode") {
    // PDFs ignore a JPEG's rotation flag, so decoding must too.
    source = await createImageBitmap(new Blob([data as BlobPart], { type: "image/jpeg" }), {
      imageOrientation: "none",
    });
  } else {
    if (!level.lossless) return null;
    const pixels = await decodeFlate(data, stream.dict, f.wrappers.length, w, comps);
    if (!pixels) return null;
    source = await createImageBitmap(toImageData(pixels, w, h, comps));
  }

  const scale = Math.min(1, level.maxSide / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, nw, nh);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", level.quality));
  canvas.width = canvas.height = 0;
  if (!blob) return null;
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  // Only worth swapping when it's clearly smaller than what's stored now.
  if (jpeg.length > stream.contents.length * 0.9) return null;

  const dict = d.clone(d.context);
  dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
  dict.delete(PDFName.of("DecodeParms"));
  dict.set(PDFName.of("Width"), PDFNumber.of(nw));
  dict.set(PDFName.of("Height"), PDFNumber.of(nh));
  dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  // The browser always writes color JPEGs, so gray images become RGB.
  if (comps === 1) dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  return PDFRawStream.of(dict, jpeg);
}

/** Inflate a Flate image and undo PNG-style row filters. Null if it isn't laid out as expected. */
async function decodeFlate(
  data: Uint8Array,
  dict: PDFDict,
  wrappers: number,
  w: number,
  comps: number,
): Promise<Uint8Array | null> {
  const raw = new Uint8Array(
    await new Response(
      new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  // With a filter chain, Flate's parameters are the last entry of an array.
  const all = dict.lookup(PDFName.of("DecodeParms"));
  const parms = all instanceof PDFArray ? all.lookup(wrappers) : all;
  const predictor = parms instanceof PDFDict ? (num(parms, "Predictor") ?? 1) : 1;
  if (predictor === 1) return raw;
  if (predictor < 10) return null; // TIFF predictor: rare, not worth the risk
  const colors = parms instanceof PDFDict ? (num(parms, "Colors") ?? 1) : 1;
  const columns = parms instanceof PDFDict ? (num(parms, "Columns") ?? 1) : 1;
  if (colors !== comps || columns !== w) return null;
  return unfilterPng(raw, columns * colors, colors);
}

/** Reverse PNG filters (None, Sub, Up, Average, Paeth) on rows of `rowLen` bytes. */
export function unfilterPng(data: Uint8Array, rowLen: number, bpp: number): Uint8Array | null {
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    const up = dst - rowLen;
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[up + i] : 0;
      const c = r > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let pred: number;
      switch (type) {
        case 0:
          pred = 0;
          break;
        case 1:
          pred = a;
          break;
        case 2:
          pred = b;
          break;
        case 3:
          pred = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          return null;
      }
      out[dst + i] = (data[src + i] + pred) & 0xff;
    }
  }
  return out;
}

function toImageData(px: Uint8Array, w: number, h: number, comps: number): ImageData {
  const need = w * h * comps;
  if (px.length < need) throw new Error("Image data is short");
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += comps) {
    const o = i * 4;
    if (comps === 3) {
      rgba[o] = px[j];
      rgba[o + 1] = px[j + 1];
      rgba[o + 2] = px[j + 2];
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[j];
    }
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, w, h);
}
