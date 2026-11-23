/**
 * HEIC/HEIF photos (what iPhones save by default) for browsers that can't
 * open them. Safari and the iOS app decode HEIC themselves; Chrome, Firefox
 * and Edge don't, so there we decode with libheif compiled to WebAssembly.
 * The decoder is a few MB, so it's only downloaded the first time a HEIC
 * photo needs it, and it runs on the device like everything else.
 */

const HEIC_EXT = /\.(heic|heif|hif)$/i;
const HEIC_TYPE = /^image\/hei[cf](-sequence)?$/i;
// "ftyp" brands used by HEIC/HEIF files. mif1/msf1 are also used by AVIF,
// which is fine: we only get here once the browser has failed to decode it.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** True if the file is named, typed or laid out like a HEIC/HEIF image. */
export async function isHeic(file: File): Promise<boolean> {
  if (HEIC_EXT.test(file.name) || HEIC_TYPE.test(file.type)) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  return ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12));
}

/**
 * Turn a HEIC photo into a JPEG with the same name. The photo comes out
 * upright, and with none of the original's metadata (location, camera...),
 * since it's redrawn from pixels.
 */
export async function heicToJpeg(file: File): Promise<File> {
  const { heicTo } = await import("heic-to/csp");
  const blob = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
  return new File([blob], file.name, { type: "image/jpeg", lastModified: file.lastModified });
}
