import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";
import { pdfjs } from "./pdf";

/**
 * Find equations and figures on a page, so the handwriting tool can carry
 * them over as they look instead of as scrambled text.
 *
 * Equations are found by their fonts: LaTeX sets math in its own fonts
 * (Computer Modern's CMMI, CMSY and CMEX, AMS symbols, Latin Modern Math
 * and the like with unicode-math, Cambria Math from Word). Runs of math on a
 * line of text are inline equations; lines that are mostly math, stacked
 * together (fractions, limits, aligned rows), are display equations. Each is
 * cut out of the page as a picture of its ink, to be redrawn in the pen's
 * colour.
 *
 * Figures are whatever ink is left once every piece of text is accounted
 * for: plots, diagrams, photos, boxes. Big enough clumps of it, together
 * with the labels written on them, are copied over exactly as they are.
 *
 * Both are taken out of the page's text and replaced by a single
 * placeholder character from the private-use area, which then flows
 * through layout like a letter (inline) or a line of its own.
 */

export type ArtKind = "inline" | "display" | "figure";

export interface Art {
  kind: ArtKind;
  page: number;
  /** Where it sits on the page as seen, in points from the top-left: [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  /** The same box in the page's own coordinates (from the bottom-left), for copying the figure as it is. */
  pdfBox: [number, number, number, number];
  /** For equations: how far the baseline is above the box's bottom, in points. */
  base: number;
  /** For equations: the size of the text it sat in, in points. */
  size: number;
  /** For equations: ink coverage per pixel (0-255), `pw` by `ph`. */
  mask?: Uint8ClampedArray;
  /** For figures: a PNG of it, for when the page can't be copied directly. */
  png?: Uint8Array;
  pw: number;
  ph: number;
}

/** Fonts TeX, Word and the web set mathematics in. */
const MATH_FONT =
  /(^|\+|[-_ ])(cmmi|cmsy|cmex|cmbsy|cmmib|msam|msbm|eufm|eufb|eusm|eusb|eurm|rsfs|lmmi|lmsy|lmex|txmi|txsy|txex|pxmi|pxsy|pxex|ntxmi|ntxsy|ntxex|zxmi|stmary|wasy|esint|mathdesign|mdbch|mdput)|math|katex_(main-italic|size|ams|caligraphic|fraktur|script)|mjx(c-tex)?-(math|size|ams)|stixgeneral|stixsize/i;
/** Mathematical alphanumerics (𝑥, 𝐀, ℝ-style letters) mean math in any font. */
const MATH_CHARS = /[\u{1d400}-\u{1d7ff}ℂℊ-ℓℕℙ-ℝℤℨℬ-ℭℯ-ℱℳ-ℴ]/u;
/** Characters that read the same in or out of math: they join equations either side of them. */
const NEUTRAL = /^[\s()[\]{}=+\-−<>|,.;:!/'′\d]*$/;
/** Punctuation that ends a sentence rather than belonging to the equation before it. */
const PUNCT = /^[\s,.;:!]*$/;

/** First private-use code point handed out, and how many there are. */
const PUA = 0xe000;
const PUA_SIZE = 6400;

interface Item {
  raw: TextItem;
  index: number;
  math: boolean;
  big: boolean; // a big operator or delimiter from an extension font: hangs below its baseline
  x0: number;
  x1: number;
  base: number;
  size: number;
  top: number;
  bottom: number;
  /** Part of a run split where math meets prose ("= 0 are"): which end this is, and the rest of the run. */
  cut?: { side: "head" | "tail"; rest: string; restX0: number; restX1: number };
}

interface Row {
  base: number;
  size: number;
  items: Item[];
}

type Box = [number, number, number, number];

const overlap = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Hands out placeholder characters across a whole document. */
export class ArtShelf {
  readonly arts = new Map<string, Art>();
  private next = 0;

  take(art: Art): string | null {
    if (this.next >= PUA_SIZE) return null;
    const ch = String.fromCodePoint(PUA + this.next++);
    this.arts.set(ch, art);
    return ch;
  }
}

/** Is this character a placeholder for an equation or figure? */
export const isArt = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return cp >= PUA && cp < PUA + PUA_SIZE;
};

/**
 * Take the equations and figures out of one page's text items, putting a
 * placeholder in their place and the art itself on the shelf.
 */
export async function scanPage(
  page: PDFPageProxy,
  items: ReadonlyArray<TextItem | TextMarkedContent>,
  nameOf: (fontId: string) => string,
  index: number,
  shelf: ArtShelf,
): Promise<ReadonlyArray<TextItem | TextMarkedContent>> {
  const vp = page.getViewport({ scale: 1 });
  const all: Item[] = [];
  const mathFont = new Map<string, boolean>();
  const isMathFont = (id: string) => {
    let m = mathFont.get(id);
    if (m === undefined) {
      m = MATH_FONT.test(nameOf(id).replace(/^[A-Z]{6}\+/, ""));
      mathFont.set(id, m);
    }
    return m;
  };
  items.forEach((raw, i) => {
    if (!("str" in raw) || !raw.str) return;
    // Into page-as-seen coordinates (y down). Only upright text takes part.
    const [a, b, c, d, e, f] = pdfjs.Util.transform(vp.transform, raw.transform);
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d >= 0) return;
    const size = Math.abs(d);
    const name = nameOf(raw.fontName);
    // Big operators, delimiters and radical signs hang below where their baseline says.
    const big = /cmex|lmex|txex|pxex|ntxex|size\d/i.test(name) || raw.str.includes("\u221a");
    // LaTeX draws list bullets from the math symbol font; a bullet on its own is still just a bullet.
    const bullet = /^\s*[\u2022\u25e6\u2219\u22c6\u2217\u2013]\s*$/.test(raw.str);
    const math = !bullet && (isMathFont(raw.fontName) || MATH_CHARS.test(raw.str));
    const width = raw.width * (a / Math.hypot(raw.transform[0], raw.transform[1]) || 1);
    all.push({
      raw,
      index: i,
      math,
      big,
      x0: e,
      x1: e + Math.abs(width),
      base: f,
      size,
      top: f - size * 0.85,
      bottom: f + size * (big ? 1.6 : 0.3),
    });
  });
  const ink = all.filter((it) => it.raw.str.trim());
  const hasMath = ink.some((it) => it.math);
  const graphics = await hasGraphics(page);
  if (!hasMath && !graphics) return items;

  // Body size: what most characters are set in.
  const counts = new Map<number, number>();
  for (const it of ink) counts.set(Math.round(it.size), (counts.get(Math.round(it.size)) ?? 0) + it.raw.str.length);
  const body = [...counts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 10;

  // Rows: full-size text by baseline. Sub- and superscripts, fraction parts and big operators then
  // join the row they belong to; whatever belongs to none (limits under a sum, say) makes rows of its own.
  const rows: Row[] = [];
  const sorted = [...ink].sort((p, q) => p.base - q.base);
  for (const it of sorted.filter((it) => !it.big && it.size >= body * 0.8)) {
    const row = rows.find((r) => Math.abs(r.base - it.base) < Math.min(r.size, it.size) * 0.3);
    if (row) {
      row.items.push(it);
      row.size = Math.max(row.size, it.size);
    } else rows.push({ base: it.base, size: it.size, items: [it] });
  }
  const spans = rows.map((r) => [Math.min(...r.items.map((x) => x.x0)), Math.max(...r.items.map((x) => x.x1))]);
  const leftover: Item[] = [];
  for (const it of sorted.filter((it) => it.big || it.size < body * 0.8)) {
    let best: Row | null = null;
    let score = Infinity;
    rows.forEach((r, i) => {
      // Big operators sit a little apart from what they apply to.
      const slack = r.size * (it.big ? 2.5 : 1);
      const near = it.x0 < spans[i][1] + slack && it.x1 > spans[i][0] - slack;
      if (!near) return;
      // A big glyph's top is at its baseline: the row's baseline runs through it, lower down.
      const d = it.big ? r.base - (it.base + it.size * 0.6) : it.base - r.base;
      const ok = it.big ? r.base - it.base > -it.size * 0.25 && r.base - it.base < it.size * 1.7 : d > -r.size * 0.8 && d < r.size * 0.5;
      if (ok && Math.abs(d) < score) {
        best = r;
        score = Math.abs(d);
      }
    });
    if (best) (best as Row).items.push(it);
    else leftover.push(it);
  }
  for (const it of leftover) {
    const row = rows.find((r) => r.items.every((x) => leftover.includes(x)) && Math.abs(r.base - it.base) < it.size * 0.4);
    if (row) row.items.push(it);
    else rows.push({ base: it.base, size: it.size, items: [it] });
  }
  rows.sort((p, q) => p.base - q.base);

  const S = Math.min(5, Math.sqrt(14e6 / (vp.width * vp.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width * S);
  canvas.height = Math.ceil(vp.height * S);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  try {
    await page.render({ canvas, viewport: page.getViewport({ scale: S }), background: "#ffffff" }).promise;
  } catch {
    canvas.width = canvas.height = 0;
    return items;
  }
  const W = canvas.width;
  const H = canvas.height;
  const px = g.getImageData(0, 0, W, H).data;
  // Darkness of each pixel: 0 for paper, up to 255 for full ink.
  const dark = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < dark.length; i += 4, j++) dark[j] = 255 - Math.min(px[i], px[i + 1], px[i + 2]);
  const inkAt = (x: number, y: number) => dark[y * W + x] > 40;

  /** Is there ink along a row (or column) of pixels, inside a span? */
  const rowInk = (y: number, x0: number, x1: number) => {
    if (y < 0 || y >= H) return false;
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) if (inkAt(x, y)) return true;
    return false;
  };
  const colInk = (x: number, y0: number, y1: number) => {
    if (x < 0 || x >= W) return false;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) if (inkAt(x, y)) return true;
    return false;
  };

  /**
   * Grow a box (points) outwards while ink continues past its edges, at most
   * `reach` points up and down and `side` points left and right, then shrink
   * it to the ink inside. Fraction bars, roots and big brackets that the
   * text items don't cover get pulled in this way.
   */
  const fit = (box: Box, reach: number, side: number): Box => {
    let x0 = Math.floor(box[0] * S);
    let y0 = Math.floor(box[1] * S);
    let x1 = Math.ceil(box[2] * S);
    let y1 = Math.ceil(box[3] * S);
    const ry0 = y0 - reach * S;
    const ry1 = y1 + reach * S;
    const sx0 = x0 - side * S;
    const sx1 = x1 + side * S;
    for (let pass = 0; pass < 2; pass++) {
      while (y0 > ry0 && rowInk(y0 - 1, x0, x1)) y0--;
      while (y1 < ry1 && rowInk(y1, x0, x1)) y1++;
      while (x0 > sx0 && colInk(x0 - 1, y0, y1)) x0--;
      while (x1 < sx1 && colInk(x1, y0, y1)) x1++;
    }
    // Shrink to the ink.
    while (y0 < y1 && !rowInk(y0, x0, x1)) y0++;
    while (y1 > y0 && !rowInk(y1 - 1, x0, x1)) y1--;
    while (x0 < x1 && !colInk(x0, y0, y1)) x0++;
    while (x1 > x0 && !colInk(x1 - 1, y0, y1)) x1--;
    const pad = 0.8 * S;
    return [Math.max(0, x0 - pad) / S, Math.max(0, y0 - pad) / S, Math.min(W, x1 + pad) / S, Math.min(H, y1 + pad) / S];
  };

  const taken = new Set<Item>();
  const placeholders: { at: number; item: TextItem; box: Box }[] = [];
  const pdfBox = (b: Box): Box => {
    const [ax, ay] = vp.convertToPdfPoint(b[0], b[3]);
    const [bx, by] = vp.convertToPdfPoint(b[2], b[1]);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  };
  /** A placeholder text item: a single character standing in for the art, `size` tall, at a spot on the page. */
  const placeholder = (ch: string, like: TextItem, x: number, base: number, width: number, size: number): TextItem => {
    const [ex, ey] = vp.convertToPdfPoint(x, base);
    const [a, b, c, d] = like.transform;
    const k = size / (Math.hypot(c, d) || size);
    return { ...like, str: ch, transform: [a * k, b * k, c * k, d * k, ex, ey], width, height: size, hasEOL: false };
  };
  const cut = (box: Box): { mask: Uint8ClampedArray; pw: number; ph: number } => {
    const x0 = Math.floor(box[0] * S);
    const y0 = Math.floor(box[1] * S);
    const pw = Math.max(1, Math.ceil(box[2] * S) - x0);
    const ph = Math.max(1, Math.ceil(box[3] * S) - y0);
    const mask = new Uint8ClampedArray(pw * ph);
    for (let y = 0; y < ph; y++) {
      const sy = y0 + y;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < pw; x++) {
        const sx = x0 + x;
        if (sx >= 0 && sx < W) mask[y * pw + x] = dark[sy * W + sx];
      }
    }
    return { mask, pw, ph };
  };

  /**
   * LaTeX sets "=", "+", brackets and digits in the text font, so a run of
   * text often starts or ends with a bit of an equation ("= 0 are", "Let 1 +").
   * Split such runs where the math stops, at a gap in the ink, so that bit
   * goes with the equation.
   */
  const OPERATOR = /[=+\-\u2212<>()[\]{}|/\d\u00d7\u00b7]/;
  const gapNear = (x: number, r: Row): number => {
    const y0 = Math.floor((r.base - r.size * 0.75) * S);
    const y1 = Math.ceil((r.base + r.size * 0.2) * S);
    const c = Math.round(x * S);
    const reach = Math.round(r.size * 0.4 * S);
    for (let d = 0; d <= reach; d++) {
      if (!colInk(c - d, y0, y1)) return (c - d) / S;
      if (!colInk(c + d, y0, y1)) return (c + d) / S;
    }
    return x;
  };
  const splitMixed = (line: Item[], r: Row): Item[] => {
    const out: Item[] = [];
    const joins = (it: Item | undefined) => it !== undefined && (it.math || NEUTRAL.test(it.raw.str));
    line.forEach((it, i) => {
      const str = it.raw.str;
      if (it.math || NEUTRAL.test(str)) {
        out.push(it);
        return;
      }
      const prev = line[i - 1];
      const next = line[i + 1];
      const at = (n: number) => gapNear(it.x0 + ((it.x1 - it.x0) * n) / str.length, r);
      if (joins(prev) && it.x0 - prev!.x1 < r.size * 0.6) {
        const head = str.match(/^[\s()[\]{}=+\-\u2212<>|/\d\u00d7\u00b7]*/)![0];
        const tail = str.slice(head.length);
        if (OPERATOR.test(head) && (/\s$/.test(head) || /^[,.;:!?)]/.test(tail))) {
          const xs = at(head.length);
          out.push(
            { ...it, x1: xs, raw: { ...it.raw, str: head.trimEnd() }, cut: { side: "head", rest: tail, restX0: xs, restX1: it.x1 } },
            { ...it, x0: xs, raw: { ...it.raw, str: tail } },
          );
          return;
        }
      }
      if (joins(next) && next!.x0 - it.x1 < r.size * 0.6) {
        const tailPart = str.match(/[\s()[\]{}=+\-\u2212<>|/\d\u00d7\u00b7]*$/)![0];
        const head = str.slice(0, str.length - tailPart.length);
        if (OPERATOR.test(tailPart) && /\s$/.test(head)) {
          const xs = at(head.length);
          out.push(
            { ...it, x1: xs, raw: { ...it.raw, str: head } },
            { ...it, x0: xs, raw: { ...it.raw, str: tailPart.trimStart() }, cut: { side: "tail", rest: head, restX0: it.x0, restX1: xs } },
          );
          return;
        }
      }
      out.push(it);
    });
    return out;
  };
  /** What's left of a split run once its math end has gone with an equation. */
  const edits = new Map<number, TextItem>();
  const rest = (it: Item): TextItem => {
    const { rest: str, restX0, restX1 } = it.cut!;
    const [ex, ey] = vp.convertToPdfPoint(restX0, it.base);
    const [a, b, c, d] = it.raw.transform;
    return { ...it.raw, str, transform: [a, b, c, d, ex, ey], width: restX1 - restX0 };
  };

  // ---------------------------------------------------------- display equations

  // Operator names and the little words of displayed equations ("if", "for") don't make a line prose.
  const OPS_WORDS =
    /\b(det|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|arcsin|arccos|arctan|log|ln|lg|exp|lim|liminf|limsup|max|min|sup|inf|arg|argmax|argmin|tr|Pr|gcd|mod|deg|dim|ker|Re|Im|if|and|or|for|all|otherwise|where|s\.t)\b/g;
  const textLetters = (r: Row) =>
    r.items
      .filter((it) => !it.math)
      .reduce((n, it) => n + (it.raw.str.replace(OPS_WORDS, "").match(/\p{L}/gu)?.length ?? 0), 0);
  // Where lines of text start: displayed equations are set in from there.
  const starts = new Map<number, number>();
  for (const r of rows) {
    if (r.size < body * 0.8) continue;
    const x = Math.round(Math.min(...r.items.map((it) => it.x0)));
    starts.set(x, (starts.get(x) ?? 0) + 1);
  }
  const margin = [...starts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
  const chars = (r: Row) => r.items.reduce((n, it) => n + it.raw.str.replace(/\s/g, "").length, 0);
  const mathRow = (r: Row) => r.items.some((it) => it.math) && textLetters(r) <= Math.max(4, chars(r) * 0.3);
  const rowBox = (r: Row): Box => [
    Math.min(...r.items.map((it) => it.x0)),
    Math.min(...r.items.map((it) => it.top)),
    Math.max(...r.items.map((it) => it.x1)),
    Math.max(...r.items.map((it) => it.bottom)),
  ];

  // Mathematical rows that touch (stacked parts of fractions, limits, aligned lines) make one display.
  const math = rows.filter(mathRow);
  const boxes = math.map(rowBox);
  const parent = math.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < math.length; i++) {
    for (let j = i + 1; j < math.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const gap = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
      const across = a[0] < b[2] + body * 4 && b[0] < a[2] + body * 4;
      if (gap < body * 0.9 && across) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Row[]>();
  math.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  const bands = [...groups.values()];
  const used: Box[] = [];
  for (const band of bands) {
    const its = band.flatMap((r) => r.items);
    // Displayed equations are centred or indented, never flush with the text.
    if (Math.min(...its.map((it) => it.x0)) < margin + body * 1.5) continue;
    const box = fit(band.map(rowBox).reduce(union), body * 1.2, body * 0.6);
    // The row with the most in it carries the baseline.
    const main = [...band].sort((p, q) => q.items.length - p.items.length)[0];
    const { mask, pw, ph } = cut(box);
    const ch = shelf.take({
      kind: "display",
      page: index,
      box,
      pdfBox: pdfBox(box),
      base: box[3] - main.base,
      size: main.size,
      mask,
      pw,
      ph,
    });
    if (!ch) break;
    for (const it of its) taken.add(it);
    const first = its.reduce((p, q) => (q.index < p.index ? q : p));
    placeholders.push({ at: first.index, item: placeholder(ch, first.raw, box[0], main.base, box[2] - box[0], 1), box });
    used.push(box);
  }

  // ---------------------------------------------------------- inline equations

  for (const r of rows) {
    if (r.items.every((it) => taken.has(it)) || !r.items.some((it) => it.math)) continue;
    const line = splitMixed(r.items.filter((it) => !taken.has(it)).sort((p, q) => p.x0 - q.x0), r);
    let run: Item[] = [];
    const flush = () => {
      // Sentence punctuation at either end stays as handwriting.
      while (run.length && !run[0].math && PUNCT.test(run[0].raw.str)) run.shift();
      while (run.length && !run[run.length - 1].math && PUNCT.test(run[run.length - 1].raw.str)) run.pop();
      if (run.some((it) => it.math)) {
        const approx: Box = [
          Math.min(...run.map((it) => it.x0)),
          Math.min(...run.map((it) => it.top)),
          Math.max(...run.map((it) => it.x1)),
          Math.max(...run.map((it) => it.bottom)),
        ];
        const box = fit(approx, r.size * 0.2, r.size * 0.12);
        // Keep the baseline inside, even for an equation that's all above it (like a superscript alone).
        box[3] = Math.max(box[3], r.base + 0.5);
        const { mask, pw, ph } = cut(box);
        const ch = shelf.take({ kind: "inline", page: index, box, pdfBox: pdfBox(box), base: box[3] - r.base, size: r.size, mask, pw, ph });
        if (ch) {
          for (const it of run) {
            taken.add(it);
            if (it.cut) edits.set(it.index, rest(it));
          }
          const first = run.reduce((p, q) => (q.index < p.index ? q : p));
          const host = run.find((it) => it.size === r.size) ?? first;
          placeholders.push({ at: first.index, item: placeholder(ch, host.raw, box[0], r.base, box[2] - box[0], r.size), box });
          used.push(box);
        }
      }
      run = [];
    };
    for (const it of line) {
      const joins = it.math || NEUTRAL.test(it.raw.str);
      const prev = run[run.length - 1];
      if (joins && (!prev || it.x0 - prev.x1 < r.size * 0.6)) run.push(it);
      else {
        flush();
        if (joins) run.push(it);
      }
    }
    flush();
  }

  // ---------------------------------------------------------- figures

  if (graphics) {
    // Ink on a grid of 2-point cells, with every piece of text and every equation rubbed out.
    const C = 2;
    const gw = Math.ceil(vp.width / C);
    const gh = Math.ceil(vp.height / C);
    const cell = new Uint8Array(gw * gh);
    const step = Math.max(1, Math.floor(S / 2));
    for (let y = 0; y < H; y += step) {
      const cy = Math.floor(y / S / C);
      for (let x = 0; x < W; x += step) if (dark[y * W + x] > 48) cell[cy * gw + Math.floor(x / S / C)] = 1;
    }
    const erase = (b: Box) => {
      for (let y = Math.max(0, Math.floor(b[1] / C)); y < Math.min(gh, Math.ceil(b[3] / C)); y++)
        for (let x = Math.max(0, Math.floor(b[0] / C)); x < Math.min(gw, Math.ceil(b[2] / C)); x++) cell[y * gw + x] = 0;
    };
    for (const it of ink) erase([it.x0 - 0.5, it.top - 0.5, it.x1 + 0.5, it.bottom + 0.5]);
    for (const b of used) erase(b);

    // Clumps of ink: cells within a few points of each other belong together.
    const label = new Int32Array(gw * gh).fill(-1);
    const reach = 3; // cells, so 6 points
    const found: Box[] = [];
    for (let start = 0; start < cell.length; start++) {
      if (!cell[start] || label[start] >= 0) continue;
      const id = found.length;
      let box: Box = [Infinity, Infinity, -Infinity, -Infinity];
      let n = 0;
      const stack = [start];
      label[start] = id;
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % gw;
        const y = (k - x) / gw;
        n++;
        box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)];
        for (let dy = -reach; dy <= reach; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= gh) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= gw) continue;
            const nk = ny * gw + nx;
            if (cell[nk] && label[nk] < 0) {
              label[nk] = id;
              stack.push(nk);
            }
          }
        }
      }
      const b: Box = [box[0] * C, box[1] * C, box[2] * C, box[3] * C];
      // Big enough to be a picture, not a rule, an underline or a stray mark.
      if (b[2] - b[0] >= 40 && b[3] - b[1] >= 28 && n >= 25) found.push(b);
    }
    // Merge clumps that overlap, then pull in the labels written on and around them.
    let figs = found;
    for (let changed = true; changed; ) {
      changed = false;
      const out: Box[] = [];
      for (const b of figs) {
        const hit = out.findIndex((o) => overlap(o, b));
        if (hit >= 0) {
          out[hit] = union(out[hit], b);
          changed = true;
        } else out.push(b);
      }
      figs = out;
    }
    for (const fig of figs) {
      let box = fig;
      // Pull in the labels written on and around it (axis names, tick numbers, equations in a diagram),
      // a few times over, since a label can sit beyond another.
      for (let pass = 0; pass < 3; pass++) {
        const near: Box = [box[0] - 8, box[1] - 8, box[2] + 8, box[3] + 8];
        for (const it of ink) {
          if (taken.has(it) || it.raw.str.trim().length > 40) continue;
          const ib: Box = [it.x0, it.top, it.x1, it.bottom];
          if (overlap(near, ib)) box = union(box, ib);
        }
        for (let i = placeholders.length - 1; i >= 0; i--) {
          const b = placeholders[i].box;
          if (b[2] - b[0] > (box[2] - box[0]) * 0.9 && !overlap(box, b)) continue; // a whole equation nearby, not a label
          if (overlap(near, b)) {
            box = union(box, b);
            placeholders.splice(i, 1);
          }
        }
      }
      box = [Math.max(0, box[0] - 2), Math.max(0, box[1] - 2), Math.min(vp.width, box[2] + 2), Math.min(vp.height, box[3] + 2)];
      const inside = ink.filter((it) => {
        const cx = (it.x0 + it.x1) / 2;
        const cy = (it.top + it.base) / 2;
        return cx > box[0] && cx < box[2] && cy > box[1] && cy < box[3];
      });
      // A frame around the page, or a shaded box full of writing, isn't a figure: leave its text be.
      const words = inside.reduce((n, it) => n + it.raw.str.length, 0);
      const area = ((box[2] - box[0]) * (box[3] - box[1])) / (vp.width * vp.height);
      if (area > 0.3 && words > 300) continue;
      const png = await crop(canvas, box, S);
      const ch = shelf.take({
        kind: "figure",
        page: index,
        box,
        pdfBox: pdfBox(box),
        base: 0,
        size: body,
        png,
        pw: Math.round((box[2] - box[0]) * S),
        ph: Math.round((box[3] - box[1]) * S),
      });
      if (!ch) break;
      for (const it of inside) taken.add(it);
      // In reading order: before the first remaining text that starts below the figure's top.
      const next = all
        .filter((it) => !taken.has(it) && it.raw.str.trim() && it.base > box[1] + it.size)
        .sort((p, q) => p.index - q.index)[0];
      const like = (ink[0] ?? all[0])?.raw;
      if (!like) continue;
      placeholders.push({
        at: next ? next.index - 0.5 : Infinity,
        item: placeholder(ch, like, box[0], box[1] + 1, box[2] - box[0], 1),
        box,
      });
    }
  }
  canvas.width = canvas.height = 0;

  if (!placeholders.length) return items;
  // Everything taken goes; whitespace between pieces of a taken equation goes with it.
  const gone = new Set<number>([...taken].filter((it) => !it.cut).map((it) => it.index));
  for (const it of all) {
    if (it.raw.str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.base - it.base) < r.size * 0.3);
    if (!row) continue;
    const left = row.items.filter((x) => x.x1 <= it.x0 + 0.5).sort((p, q) => q.x1 - p.x1)[0];
    const right = row.items.filter((x) => x.x0 >= it.x1 - 0.5).sort((p, q) => p.x0 - q.x0)[0];
    if (left && right && taken.has(left) && taken.has(right)) gone.add(it.index);
  }
  const out: { at: number; item: TextItem | TextMarkedContent }[] = [];
  items.forEach((item, i) => {
    if (gone.has(i)) return;
    // pdf.js's own spaces sit wherever the gap was, often up at a superscript's height; with the math
    // lifted out they'd look like a line of their own. Spaces are worked out from the gaps anyway.
    if ("str" in item && item.str && !item.str.trim()) {
      if (item.hasEOL) out.push({ at: i, item: { ...item, str: "" } });
      return;
    }
    out.push({ at: i, item: edits.get(i) ?? item });
  });
  out.push(...placeholders);
  out.sort((p, q) => p.at - q.at);
  // pdf.js marks a line end wherever the text jumps up or down, which math does all the time
  // (fractions, superscripts). With the math gone, a mark between two bits of the same line would
  // break it in two.
  const kept = out.map((o) => o.item);
  const base = (it: TextItem) => it.transform[5];
  return kept.filter((it, i) => {
    if (!("str" in it) || it.str || !it.hasEOL) return true;
    let prev: TextItem | null = null;
    let next: TextItem | null = null;
    for (let k = i - 1; k >= 0 && !prev; k--) {
      const c = kept[k];
      if ("str" in c && c.str.trim()) prev = c;
    }
    for (let k = i + 1; k < kept.length && !next; k++) {
      const c = kept[k];
      if ("str" in c && c.str.trim()) next = c;
    }
    if (!prev || !next || prev.transform[1] || prev.transform[2] || next.transform[1] || next.transform[2]) return true;
    const size = Math.min(Math.abs(prev.transform[3]), Math.abs(next.transform[3])) || 10;
    return Math.abs(base(prev) - base(next)) > size * 0.3;
  });
}

/** Does the page draw anything besides text: paths, images, shadings? */
async function hasGraphics(page: PDFPageProxy): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    const O = pdfjs.OPS;
    const drawing = new Set<number>([
      O.constructPath,
      O.paintImageXObject,
      O.paintInlineImageXObject,
      O.paintImageMaskXObject,
      O.paintSolidColorImageMask,
      O.paintImageXObjectRepeat,
      O.paintImageMaskXObjectGroup,
      O.shadingFill,
    ]);
    return ops.fnArray.some((fn) => drawing.has(fn));
  } catch {
    return false;
  }
}

/** A region of the rendered page, as a PNG in its own colours. */
async function crop(canvas: HTMLCanvasElement, box: Box, S: number): Promise<Uint8Array> {
  const x = Math.floor(box[0] * S);
  const y = Math.floor(box[1] * S);
  const w = Math.max(1, Math.ceil(box[2] * S) - x);
  const h = Math.max(1, Math.ceil(box[3] * S) - y);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  out.width = out.height = 0;
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}

/** An equation's ink as a PNG in the pen's colour, on nothing. */
export async function tint(art: Art, ink: readonly [number, number, number]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = art.pw;
  canvas.height = art.ph;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(art.pw, art.ph);
  const d = img.data;
  const mask = art.mask!;
  for (let i = 0; i < mask.length; i++) {
    d[i * 4] = ink[0];
    d[i * 4 + 1] = ink[1];
    d[i * 4 + 2] = ink[2];
    d[i * 4 + 3] = mask[i];
  }
  g.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  canvas.width = canvas.height = 0;
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}
