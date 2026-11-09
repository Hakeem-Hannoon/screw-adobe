// The handwriting fonts' own files, for embedding in a PDF. The signature
// fonts are the ones the Sign tool draws with (it loads their CSS); the
// "clear" ones are neat, print-like hands that read almost as easily as
// type, loaded here. Files are WOFF: pdf-lib can subset WOFF but not WOFF2.
// Each has its basic Latin set, and most extended Latin (accents), some
// Greek and Cyrillic too. A few come in bold.
import { STYLES, type StyleGroup } from "./signature";
import "@fontsource/patrick-hand/400.css";
import "@fontsource/playpen-sans/400.css";
import "@fontsource/kalam/400.css";
import "@fontsource/architects-daughter/400.css";
import "@fontsource/handlee/400.css";
import "@fontsource/caveat/400.css";
import "@fontsource/shadows-into-light-two/400.css";
import "@fontsource/indie-flower/400.css";
import patrickHandLatin from "@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff?url";
import patrickHandLatinExt from "@fontsource/patrick-hand/files/patrick-hand-latin-ext-400-normal.woff?url";
import playpenSansLatin from "@fontsource/playpen-sans/files/playpen-sans-latin-400-normal.woff?url";
import playpenSansLatinExt from "@fontsource/playpen-sans/files/playpen-sans-latin-ext-400-normal.woff?url";
import playpenSansGreek from "@fontsource/playpen-sans/files/playpen-sans-greek-400-normal.woff?url";
import playpenSansCyrillic from "@fontsource/playpen-sans/files/playpen-sans-cyrillic-400-normal.woff?url";
import playpenSansLatinBold from "@fontsource/playpen-sans/files/playpen-sans-latin-700-normal.woff?url";
import playpenSansLatinExtBold from "@fontsource/playpen-sans/files/playpen-sans-latin-ext-700-normal.woff?url";
import playpenSansGreekBold from "@fontsource/playpen-sans/files/playpen-sans-greek-700-normal.woff?url";
import playpenSansCyrillicBold from "@fontsource/playpen-sans/files/playpen-sans-cyrillic-700-normal.woff?url";
import kalamLatin from "@fontsource/kalam/files/kalam-latin-400-normal.woff?url";
import kalamLatinExt from "@fontsource/kalam/files/kalam-latin-ext-400-normal.woff?url";
import kalamLatinBold from "@fontsource/kalam/files/kalam-latin-700-normal.woff?url";
import kalamLatinExtBold from "@fontsource/kalam/files/kalam-latin-ext-700-normal.woff?url";
import architectsDaughterLatin from "@fontsource/architects-daughter/files/architects-daughter-latin-400-normal.woff?url";
import architectsDaughterLatinExt from "@fontsource/architects-daughter/files/architects-daughter-latin-ext-400-normal.woff?url";
import handleeLatin from "@fontsource/handlee/files/handlee-latin-400-normal.woff?url";
import caveatLatin from "@fontsource/caveat/files/caveat-latin-400-normal.woff?url";
import caveatLatinExt from "@fontsource/caveat/files/caveat-latin-ext-400-normal.woff?url";
import caveatCyrillic from "@fontsource/caveat/files/caveat-cyrillic-400-normal.woff?url";
import caveatLatinBold from "@fontsource/caveat/files/caveat-latin-700-normal.woff?url";
import caveatLatinExtBold from "@fontsource/caveat/files/caveat-latin-ext-700-normal.woff?url";
import caveatCyrillicBold from "@fontsource/caveat/files/caveat-cyrillic-700-normal.woff?url";
import shadowsIntoLightTwoLatin from "@fontsource/shadows-into-light-two/files/shadows-into-light-two-latin-400-normal.woff?url";
import shadowsIntoLightTwoLatinExt from "@fontsource/shadows-into-light-two/files/shadows-into-light-two-latin-ext-400-normal.woff?url";
import indieFlowerLatin from "@fontsource/indie-flower/files/indie-flower-latin-400-normal.woff?url";
import indieFlowerLatinExt from "@fontsource/indie-flower/files/indie-flower-latin-ext-400-normal.woff?url";
import balletLatin from "@fontsource/ballet/files/ballet-latin-400-normal.woff?url";
import balletLatinExt from "@fontsource/ballet/files/ballet-latin-ext-400-normal.woff?url";
import meaCulpaLatin from "@fontsource/mea-culpa/files/mea-culpa-latin-400-normal.woff?url";
import meaCulpaLatinExt from "@fontsource/mea-culpa/files/mea-culpa-latin-ext-400-normal.woff?url";
import mrDeHavilandLatin from "@fontsource/mr-de-haviland/files/mr-de-haviland-latin-400-normal.woff?url";
import mrDeHavilandLatinExt from "@fontsource/mr-de-haviland/files/mr-de-haviland-latin-ext-400-normal.woff?url";
import herrVonMuellerhoffLatin from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-400-normal.woff?url";
import herrVonMuellerhoffLatinExt from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-ext-400-normal.woff?url";
import homemadeAppleLatin from "@fontsource/homemade-apple/files/homemade-apple-latin-400-normal.woff?url";
import laBelleAuroreLatin from "@fontsource/la-belle-aurore/files/la-belle-aurore-latin-400-normal.woff?url";
import laBelleAuroreLatinExt from "@fontsource/la-belle-aurore/files/la-belle-aurore-latin-ext-400-normal.woff?url";
import cedarvilleCursiveLatin from "@fontsource/cedarville-cursive/files/cedarville-cursive-latin-400-normal.woff?url";
import nothingYouCouldDoLatin from "@fontsource/nothing-you-could-do/files/nothing-you-could-do-latin-400-normal.woff?url";
import dawningOfANewDayLatin from "@fontsource/dawning-of-a-new-day/files/dawning-of-a-new-day-latin-400-normal.woff?url";
import zeyadaLatin from "@fontsource/zeyada/files/zeyada-latin-400-normal.woff?url";
import zeyadaLatinExt from "@fontsource/zeyada/files/zeyada-latin-ext-400-normal.woff?url";
import kristiLatin from "@fontsource/kristi/files/kristi-latin-400-normal.woff?url";
import waitingForTheSunriseLatin from "@fontsource/waiting-for-the-sunrise/files/waiting-for-the-sunrise-latin-400-normal.woff?url";
import waitingForTheSunriseLatinExt from "@fontsource/waiting-for-the-sunrise/files/waiting-for-the-sunrise-latin-ext-400-normal.woff?url";
import mrsSaintDelafieldLatin from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-400-normal.woff?url";
import mrsSaintDelafieldLatinExt from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-ext-400-normal.woff?url";
import msMadiLatin from "@fontsource/ms-madi/files/ms-madi-latin-400-normal.woff?url";
import msMadiLatinExt from "@fontsource/ms-madi/files/ms-madi-latin-ext-400-normal.woff?url";
import greatVibesLatin from "@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff?url";
import greatVibesLatinExt from "@fontsource/great-vibes/files/great-vibes-latin-ext-400-normal.woff?url";
import greatVibesCyrillic from "@fontsource/great-vibes/files/great-vibes-cyrillic-400-normal.woff?url";
import alexBrushLatin from "@fontsource/alex-brush/files/alex-brush-latin-400-normal.woff?url";
import alexBrushLatinExt from "@fontsource/alex-brush/files/alex-brush-latin-ext-400-normal.woff?url";
import pinyonScriptLatin from "@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff?url";
import pinyonScriptLatinExt from "@fontsource/pinyon-script/files/pinyon-script-latin-ext-400-normal.woff?url";
import monsieurLaDoulaiseLatin from "@fontsource/monsieur-la-doulaise/files/monsieur-la-doulaise-latin-400-normal.woff?url";
import monsieurLaDoulaiseLatinExt from "@fontsource/monsieur-la-doulaise/files/monsieur-la-doulaise-latin-ext-400-normal.woff?url";
import italiannoLatin from "@fontsource/italianno/files/italianno-latin-400-normal.woff?url";
import italiannoLatinExt from "@fontsource/italianno/files/italianno-latin-ext-400-normal.woff?url";
import imperialScriptLatin from "@fontsource/imperial-script/files/imperial-script-latin-400-normal.woff?url";
import imperialScriptLatinExt from "@fontsource/imperial-script/files/imperial-script-latin-ext-400-normal.woff?url";

export type HandGroup = "clear" | StyleGroup;

/** Every font the handwriting tool offers, clear ones first. */
export const HAND_STYLES: readonly { family: string; group: HandGroup }[] = [
  { family: "Patrick Hand", group: "clear" },
  { family: "Playpen Sans", group: "clear" },
  { family: "Kalam", group: "clear" },
  { family: "Architects Daughter", group: "clear" },
  { family: "Handlee", group: "clear" },
  { family: "Caveat", group: "clear" },
  { family: "Shadows Into Light Two", group: "clear" },
  { family: "Indie Flower", group: "clear" },
  ...STYLES.map((s) => ({ family: s.family, group: s.group })),
];

const FILES: Record<string, { regular: string[]; bold?: string[] }> = {
  "Patrick Hand": { regular: [patrickHandLatin, patrickHandLatinExt] },
  "Playpen Sans": { regular: [playpenSansLatin, playpenSansLatinExt, playpenSansGreek, playpenSansCyrillic], bold: [playpenSansLatinBold, playpenSansLatinExtBold, playpenSansGreekBold, playpenSansCyrillicBold] },
  "Kalam": { regular: [kalamLatin, kalamLatinExt], bold: [kalamLatinBold, kalamLatinExtBold] },
  "Architects Daughter": { regular: [architectsDaughterLatin, architectsDaughterLatinExt] },
  "Handlee": { regular: [handleeLatin] },
  "Caveat": { regular: [caveatLatin, caveatLatinExt, caveatCyrillic], bold: [caveatLatinBold, caveatLatinExtBold, caveatCyrillicBold] },
  "Shadows Into Light Two": { regular: [shadowsIntoLightTwoLatin, shadowsIntoLightTwoLatinExt] },
  "Indie Flower": { regular: [indieFlowerLatin, indieFlowerLatinExt] },
  "Ballet": { regular: [balletLatin, balletLatinExt] },
  "Mea Culpa": { regular: [meaCulpaLatin, meaCulpaLatinExt] },
  "Mr De Haviland": { regular: [mrDeHavilandLatin, mrDeHavilandLatinExt] },
  "Herr Von Muellerhoff": { regular: [herrVonMuellerhoffLatin, herrVonMuellerhoffLatinExt] },
  "Homemade Apple": { regular: [homemadeAppleLatin] },
  "La Belle Aurore": { regular: [laBelleAuroreLatin, laBelleAuroreLatinExt] },
  "Cedarville Cursive": { regular: [cedarvilleCursiveLatin] },
  "Nothing You Could Do": { regular: [nothingYouCouldDoLatin] },
  "Dawning of a New Day": { regular: [dawningOfANewDayLatin] },
  "Zeyada": { regular: [zeyadaLatin, zeyadaLatinExt] },
  "Kristi": { regular: [kristiLatin] },
  "Waiting for the Sunrise": { regular: [waitingForTheSunriseLatin, waitingForTheSunriseLatinExt] },
  "Mrs Saint Delafield": { regular: [mrsSaintDelafieldLatin, mrsSaintDelafieldLatinExt] },
  "Ms Madi": { regular: [msMadiLatin, msMadiLatinExt] },
  "Great Vibes": { regular: [greatVibesLatin, greatVibesLatinExt, greatVibesCyrillic] },
  "Alex Brush": { regular: [alexBrushLatin, alexBrushLatinExt] },
  "Pinyon Script": { regular: [pinyonScriptLatin, pinyonScriptLatinExt] },
  "Monsieur La Doulaise": { regular: [monsieurLaDoulaiseLatin, monsieurLaDoulaiseLatinExt] },
  "Italianno": { regular: [italiannoLatin, italiannoLatinExt] },
  "Imperial Script": { regular: [imperialScriptLatin, imperialScriptLatinExt] },
};

const cache = new Map<string, Promise<Uint8Array>>();

function bytes(url: string): Promise<Uint8Array> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Couldn't load ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** A handwriting font's files (and its bold, if it has one), fetched once. */
export async function handFontBytes(family: string): Promise<{ regular: Uint8Array[]; bold?: Uint8Array[] }> {
  const f = FILES[family];
  if (!f) throw new Error(`No files for ${family}`);
  const [regular, bold] = await Promise.all([
    Promise.all(f.regular.map(bytes)),
    f.bold ? Promise.all(f.bold.map(bytes)) : Promise.resolve(undefined),
  ]);
  return { regular, bold };
}
