import { PDFDocument, type PDFImage } from "pdf-lib";

/** An image added to the Images to PDF list. Only its size is kept in memory; pixels are decoded again when building. */
export interface LoadedImage {
  id: string;
  file: File;
  /** Size as it should appear, with any camera rotation applied. */
  w: number;
  h: number;
}

export type Paper = "letter" | "a4" | "fit";

export interface ImagePdfOptions {
  paper: Paper;
  margin: boolean;
}

const PAPER: Record<Exclude<Paper, "fit">, [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
};
const MARGIN = 36; // half an inch
const PX_TO_PT = 0.75; // "Fit image" treats pixels as 96 per inch

const IMAGE_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|svg|heic|heif|tiff?|ico)$/i;

export function isImage(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

/** "Photo.final.JPG" -> "Photo.final". Never empty. */
export function imageBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || "images";
}

let counter = 0;

/** Read an image's size. Rejects if the browser can't decode it (e.g. HEIC outside Safari). */
export async function loadImage(file: File): Promise<LoadedImage> {
  const img = await decode(file);
  const w = img.width;
  const h = img.height;
  release(img);
  if (!w || !h) throw new Error("Image has no size");
  counter += 1;
  return { id: `i${counter}`, file, w, h };
}

type Decoded = ImageBitmap | HTMLImageElement;

async function decode(file: Blob): Promise<Decoded> {
  try {
    // Applies the camera's rotation flag, so phone photos come out upright.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // SVG and a few others only decode through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function release(img: Decoded): void {
  if ("close" in img) img.close();
}

/** Build one PDF with each image on its own page. */
export async function imagesToPdf(
  images: LoadedImage[],
  opts: ImagePdfOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const [i, image] of images.entries()) {
    const embedded = await embed(doc, image);
    const box = layout(image.w, image.h, opts);
    const page = doc.addPage([box.pw, box.ph]);
    page.drawImage(embedded, { x: box.x, y: box.y, width: box.w, height: box.h });
    onProgress?.(i + 1, images.length);
  }
  return doc.save();
}

/** Where an image of w x h goes on its page. Paper turns landscape for landscape images. */
export function layout(w: number, h: number, opts: ImagePdfOptions) {
  const m = opts.margin ? MARGIN : 0;
  if (opts.paper === "fit") {
    const iw = w * PX_TO_PT;
    const ih = h * PX_TO_PT;
    return { pw: iw + m * 2, ph: ih + m * 2, x: m, y: m, w: iw, h: ih };
  }
  const [short, long] = PAPER[opts.paper];
  const landscape = w > h;
  const pw = landscape ? long : short;
  const ph = landscape ? short : long;
  const scale = Math.min((pw - m * 2) / w, (ph - m * 2) / h);
  const iw = w * scale;
  const ih = h * scale;
  return { pw, ph, x: (pw - iw) / 2, y: (ph - ih) / 2, w: iw, h: ih };
}

/**
 * Put an image into the PDF without carrying its hidden metadata along.
 *
 * JPEGs are copied byte for byte (no quality loss) with their EXIF, XMP and
 * comment segments cut out, since those can hold the GPS location a photo was
 * taken at, the camera's serial number, and so on. A JPEG whose rotation flag
 * isn't "upright" is redrawn instead, because PDFs ignore that flag. PNGs are
 * decoded and re-packed by pdf-lib, which drops their text chunks. Anything
 * else (WebP, GIF, HEIC...) is redrawn through a canvas.
 */
async function embed(doc: PDFDocument, image: LoadedImage): Promise<PDFImage> {
  const bytes = new Uint8Array(await image.file.arrayBuffer());
  if (isJpeg(bytes)) {
    const jpeg = cleanJpeg(bytes);
    if (jpeg && jpeg.orientation <= 1) {
      try {
        return await doc.embedJpg(jpeg.bytes);
      } catch {
        // fall through to redrawing
      }
    }
    return doc.embedJpg(await redraw(image.file, "image/jpeg"));
  }
  if (isPng(bytes)) {
    try {
      return await doc.embedPng(bytes);
    } catch {
      return doc.embedPng(await redraw(image.file, "image/png"));
    }
  }
  // Photo-like formats become JPEGs; the rest stay lossless.
  const photo = /image\/(webp|avif|heic|heif)/i.test(image.file.type) || /\.(webp|avif|heic|heif)$/i.test(image.file.name);
  return photo
    ? doc.embedJpg(await redraw(image.file, "image/jpeg"))
    : doc.embedPng(await redraw(image.file, "image/png"));
}

async function redraw(file: File, type: "image/jpeg" | "image/png"): Promise<Uint8Array> {
  const img = await decode(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  if (type === "image/jpeg") {
    // JPEG has no transparency; show see-through parts as white paper.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  release(img);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("Canvas export failed");
  return new Uint8Array(await blob.arrayBuffer());
}

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Copy a JPEG without its metadata segments, and read its EXIF rotation flag
 * on the way. Keeps what decoding needs: JFIF (APP0), the color profile
 * (APP2) and Adobe's color info (APP14). Returns null if the file isn't laid
 * out the way it should be.
 */
export function cleanJpeg(b: Uint8Array): { bytes: Uint8Array; orientation: number } | null {
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let orientation = 0;
  let pos = 2;
  while (pos < b.length) {
    if (b[pos] !== 0xff) return null;
    // Markers may be padded with extra 0xFF bytes.
    let p = pos;
    while (b[p + 1] === 0xff) p++;
    const marker = b[p + 1];
    if (marker === undefined) return null;
    // Markers with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      keep.push(b.subarray(pos, p + 2));
      pos = p + 2;
      continue;
    }
    if (marker === 0xd9) {
      keep.push(b.subarray(pos, p + 2));
      break;
    }
    if (p + 3 >= b.length) return null;
    const len = (b[p + 2] << 8) | b[p + 3];
    const end = p + 2 + len;
    if (len < 2 || end > b.length) return null;
    if (marker === 0xda) {
      // Start of the image data: everything from here on is pixels.
      keep.push(b.subarray(pos));
      break;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1) orientation ||= exifOrientation(b.subarray(p + 4, end));
    const drop = marker === 0xfe || (isApp && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee);
    if (!drop) keep.push(b.subarray(pos, end));
    pos = end;
  }
  const size = keep.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of keep) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, orientation: orientation || 1 };
}

/** The Orientation tag (1-8) from an APP1 payload, or 0 if there isn't one. */
function exifOrientation(seg: Uint8Array): number {
  // "Exif\0\0" then a TIFF header.
  if (seg.length < 14 || String.fromCharCode(...seg.subarray(0, 4)) !== "Exif") return 0;
  const t = seg.subarray(6);
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return 0;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  try {
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const v = u16(entry + 8);
        return v >= 1 && v <= 8 ? v : 0;
      }
    }
  } catch {
    // Truncated EXIF: treat as no flag.
  }
  return 0;
}
