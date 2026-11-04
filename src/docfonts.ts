/**
 * Fonts for laying out and drawing documents (Word to PDF). Each one is
 * metric-compatible with a common Office font, so text wraps where it would
 * in Word: Carlito for Calibri, Caladea for Cambria, Arimo for Arial,
 * Tinos for Times New Roman, Cousine for Courier New.
 *
 * The browser lays the document out with these exact files and the PDF
 * embeds the same files, so what's measured is what's drawn. They're
 * self-hosted in public/fonts (SIL Open Font License) and only fetched
 * when a document needs them.
 */

export type Family = "Carlito" | "Caladea" | "Arimo" | "Tinos" | "Cousine";
export const FAMILIES: Family[] = ["Carlito", "Caladea", "Arimo", "Tinos", "Cousine"];

/** The CSS family name a document uses for one of ours. No spaces, so it needs no quoting. */
export const cssName = (f: Family) => `Hpdf${f}`;

/** Which of ours a CSS family name refers to, if any. */
export function ourFamily(css: string): Family | null {
  const m = /^["']?Hpdf(Carlito|Caladea|Arimo|Tinos|Cousine)["']?$/.exec(css.trim());
  return m ? (m[1] as Family) : null;
}

/** Fonts that draw pictures in private-use code points rather than letters. */
export const SYMBOL_FONT = /^["']?(symbol|wingdings( \d)?|webdings|zapf ?dingbats|marlett)["']?$/i;

/** The closest of ours to a font a document asks for. */
export function mapFont(name: string): Family {
  const n = name.replace(/["']/g, "").trim().toLowerCase();
  const own = ourFamily(name);
  if (own) return own;
  if (
    /mono|courier|consolas|menlo|monaco|lucida console|lucida sans typewriter|cousine|code|andale|fixed|terminal/.test(
      n,
    )
  )
    return "Cousine";
  if (/cambria|caladea/.test(n)) return "Caladea";
  if (
    /times|tinos|georgia|garamond|antiqua|palatino|baskerville|bookman|schoolbook|constantia|minion|serif|merriweather|playfair|charter|cochin|didot|bodoni|perpetua|rockwell|sylfaen|batang|mincho|song|ming/.test(
      n,
    ) &&
    !/sans/.test(n)
  ) {
    return "Tinos";
  }
  if (
    /arial|helvetica|arimo|liberation sans|nimbus sans|verdana|tahoma|trebuchet|franklin|century gothic|futura|roboto|open sans|lato|montserrat|poppins|inter\b|arial narrow|geneva|dejavu sans|ubuntu|sf pro|system-ui|-apple-system/.test(
      n,
    )
  ) {
    return "Arimo";
  }
  return "Carlito"; // Calibri, Aptos, Segoe UI, Candara, and anything unknown
}

/**
 * One line of "single" spacing in Word, as a share of the font size: the
 * font's own line height. CSS "line-height: 1" is tighter than that, so
 * Word's line spacing is scaled by these.
 */
export const LINE: Record<Family, number> = {
  Carlito: 1.2207,
  Caladea: 1.1719,
  Arimo: 1.1499,
  Tinos: 1.1499,
  Cousine: 1.1328,
};

export interface Face {
  family: Family;
  bold: boolean;
  italic: boolean;
}

export const faceKey = (f: Face) => `${f.family}-${f.bold ? "b" : ""}${f.italic ? "i" : ""}`;

const fileName = (f: Face) =>
  `${f.family}-${f.bold && f.italic ? "BoldItalic" : f.bold ? "Bold" : f.italic ? "Italic" : "Regular"}.ttf`;

const bytes = new Map<string, Promise<Uint8Array>>();
const registered = new Set<string>();

/** The font file's bytes, fetched once. */
export function faceBytes(face: Face): Promise<Uint8Array> {
  const key = faceKey(face);
  let p = bytes.get(key);
  if (!p) {
    const url = new URL(`./fonts/${fileName(face)}`, document.baseURI).href;
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Couldn't load ${fileName(face)}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => bytes.delete(key));
    bytes.set(key, p);
  }
  return p;
}

/** Make every style of these families usable in the page, and wait until they are. */
export async function loadFamilies(families: Iterable<Family>): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  for (const family of new Set(families)) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const face = { family, bold, italic };
        const key = faceKey(face);
        if (registered.has(key)) continue;
        jobs.push(
          faceBytes(face).then(async (data) => {
            const ff = new FontFace(cssName(family), data.slice().buffer, {
              weight: bold ? "700" : "400",
              style: italic ? "italic" : "normal",
            });
            await ff.load();
            document.fonts.add(ff);
            registered.add(key);
          }),
        );
      }
    }
  }
  await Promise.all(jobs);
}

/**
 * Private-use characters from Symbol and Wingdings that have a real Unicode
 * equivalent: bullets, check marks, boxes and arrows, mostly from list markers.
 */
const SYMBOLS: Record<number, string> = {
  0xf0b7: "\u2022", // Symbol bullet
  0xf06c: "\u25cf", // Wingdings filled circle
  0xf06e: "\u25a0", // Wingdings filled square
  0xf06f: "\u25a1", // Wingdings empty square
  0xf071: "\u2751",
  0xf075: "\u25c6",
  0xf076: "\u2756", // Wingdings diamond star
  0xf0a7: "\u25aa", // Wingdings small square
  0xf0a8: "\u25fb",
  0xf0d8: "\u27a2", // Wingdings arrowhead
  0xf0e0: "\u27a2",
  0xf0e8: "\u2794",
  0xf0fb: "\u2717",
  0xf0fc: "\u2714", // Wingdings check
  0xf0fd: "\u2612",
  0xf0fe: "\u2611",
  0xf0a1: "\u25cb",
  0xf02d: "\u2013",
  0xf0be: "\u2014",
};

export function fromSymbolFont(text: string): string {
  return text.replace(/[\uf000-\uf0ff]/g, (c) => SYMBOLS[c.charCodeAt(0)] ?? "\u2022");
}
