// The handwriting fonts' own files, for embedding in a PDF. These are the
// same fonts the Sign tool draws with (loaded there through their CSS), as
// WOFF: pdf-lib can subset WOFF but not WOFF2. Each has its basic Latin set,
// and most an extended Latin set for accented letters.
import ballet from "@fontsource/ballet/files/ballet-latin-400-normal.woff?url";
import balletExt from "@fontsource/ballet/files/ballet-latin-ext-400-normal.woff?url";
import meaCulpa from "@fontsource/mea-culpa/files/mea-culpa-latin-400-normal.woff?url";
import meaCulpaExt from "@fontsource/mea-culpa/files/mea-culpa-latin-ext-400-normal.woff?url";
import mrDeHaviland from "@fontsource/mr-de-haviland/files/mr-de-haviland-latin-400-normal.woff?url";
import mrDeHavilandExt from "@fontsource/mr-de-haviland/files/mr-de-haviland-latin-ext-400-normal.woff?url";
import herrVonMuellerhoff from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-400-normal.woff?url";
import herrVonMuellerhoffExt from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-ext-400-normal.woff?url";
import homemadeApple from "@fontsource/homemade-apple/files/homemade-apple-latin-400-normal.woff?url";
import laBelleAurore from "@fontsource/la-belle-aurore/files/la-belle-aurore-latin-400-normal.woff?url";
import laBelleAuroreExt from "@fontsource/la-belle-aurore/files/la-belle-aurore-latin-ext-400-normal.woff?url";
import cedarvilleCursive from "@fontsource/cedarville-cursive/files/cedarville-cursive-latin-400-normal.woff?url";
import nothingYouCouldDo from "@fontsource/nothing-you-could-do/files/nothing-you-could-do-latin-400-normal.woff?url";
import dawningOfANewDay from "@fontsource/dawning-of-a-new-day/files/dawning-of-a-new-day-latin-400-normal.woff?url";
import zeyada from "@fontsource/zeyada/files/zeyada-latin-400-normal.woff?url";
import zeyadaExt from "@fontsource/zeyada/files/zeyada-latin-ext-400-normal.woff?url";
import kristi from "@fontsource/kristi/files/kristi-latin-400-normal.woff?url";
import waitingForTheSunrise from "@fontsource/waiting-for-the-sunrise/files/waiting-for-the-sunrise-latin-400-normal.woff?url";
import waitingForTheSunriseExt from "@fontsource/waiting-for-the-sunrise/files/waiting-for-the-sunrise-latin-ext-400-normal.woff?url";
import mrsSaintDelafield from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-400-normal.woff?url";
import mrsSaintDelafieldExt from "@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-ext-400-normal.woff?url";
import msMadi from "@fontsource/ms-madi/files/ms-madi-latin-400-normal.woff?url";
import msMadiExt from "@fontsource/ms-madi/files/ms-madi-latin-ext-400-normal.woff?url";
import greatVibes from "@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff?url";
import greatVibesExt from "@fontsource/great-vibes/files/great-vibes-latin-ext-400-normal.woff?url";
import alexBrush from "@fontsource/alex-brush/files/alex-brush-latin-400-normal.woff?url";
import alexBrushExt from "@fontsource/alex-brush/files/alex-brush-latin-ext-400-normal.woff?url";
import pinyonScript from "@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff?url";
import pinyonScriptExt from "@fontsource/pinyon-script/files/pinyon-script-latin-ext-400-normal.woff?url";
import monsieurLaDoulaise from "@fontsource/monsieur-la-doulaise/files/monsieur-la-doulaise-latin-400-normal.woff?url";
import monsieurLaDoulaiseExt from "@fontsource/monsieur-la-doulaise/files/monsieur-la-doulaise-latin-ext-400-normal.woff?url";
import italianno from "@fontsource/italianno/files/italianno-latin-400-normal.woff?url";
import italiannoExt from "@fontsource/italianno/files/italianno-latin-ext-400-normal.woff?url";
import imperialScript from "@fontsource/imperial-script/files/imperial-script-latin-400-normal.woff?url";
import imperialScriptExt from "@fontsource/imperial-script/files/imperial-script-latin-ext-400-normal.woff?url";

const FILES: Record<string, string[]> = {
  "Ballet": [ballet, balletExt],
  "Mea Culpa": [meaCulpa, meaCulpaExt],
  "Mr De Haviland": [mrDeHaviland, mrDeHavilandExt],
  "Herr Von Muellerhoff": [herrVonMuellerhoff, herrVonMuellerhoffExt],
  "Homemade Apple": [homemadeApple],
  "La Belle Aurore": [laBelleAurore, laBelleAuroreExt],
  "Cedarville Cursive": [cedarvilleCursive],
  "Nothing You Could Do": [nothingYouCouldDo],
  "Dawning of a New Day": [dawningOfANewDay],
  "Zeyada": [zeyada, zeyadaExt],
  "Kristi": [kristi],
  "Waiting for the Sunrise": [waitingForTheSunrise, waitingForTheSunriseExt],
  "Mrs Saint Delafield": [mrsSaintDelafield, mrsSaintDelafieldExt],
  "Ms Madi": [msMadi, msMadiExt],
  "Great Vibes": [greatVibes, greatVibesExt],
  "Alex Brush": [alexBrush, alexBrushExt],
  "Pinyon Script": [pinyonScript, pinyonScriptExt],
  "Monsieur La Doulaise": [monsieurLaDoulaise, monsieurLaDoulaiseExt],
  "Italianno": [italianno, italiannoExt],
  "Imperial Script": [imperialScript, imperialScriptExt],
};

const cache = new Map<string, Promise<Uint8Array[]>>();

/** A handwriting font's files, fetched once. */
export function handFontBytes(family: string): Promise<Uint8Array[]> {
  let p = cache.get(family);
  if (!p) {
    const urls = FILES[family];
    if (!urls) return Promise.reject(new Error(`No files for ${family}`));
    p = Promise.all(
      urls.map(async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Couldn't load ${family}`);
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
    p.catch(() => cache.delete(family));
    cache.set(family, p);
  }
  return p;
}
