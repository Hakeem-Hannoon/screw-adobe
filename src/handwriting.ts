import fontkit from "@pdf-lib/fontkit";
import {
  degrees,
  LineCapStyle,
  PDFDocument,
  rgb,
  type Color,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

/**
 * Write a document out by hand: its text set in a handwriting font, on
 * lined, squared, dotted or blank paper, as a new PDF.
 *
 * The font itself is embedded, so the result is sharp at any zoom, small,
 * and its text can still be selected and searched. What makes it look
 * written rather than typeset is small, seeded unevenness: each line runs a
 * touch uphill or down, each word sits a little off the line, tilts, varies
 * in size and pressure, and the gaps between words aren't all the same. The
 * seed is fixed, so the same document and settings always come out the same.
 *
 * Equations and figures ("art") come in ready-made: equations as pictures of
 * their ink in the pen's colour, sized to match the handwriting, inline in a
 * line or on lines of their own; figures copied from the original page as
 * they are, at their own size.
 */

export type Paper = "lined" | "grid" | "dots" | "blank";

export interface HwRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/**
 * What to write. A "\n" inside a run keeps a line break, like in an address.
 * A character that's a key of the art map stands for that art.
 */
export type HwBlock =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; runs: HwRun[] }
  | { kind: "li"; number: number | null; runs: HwRun[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "art"; id: string };

export type HwArt =
  | {
      /** An equation: a PNG of its ink, its size in points as it was, where its baseline was, and the text size around it. */
      kind: "inline" | "display";
      png: Uint8Array;
      w: number;
      h: number;
      base: number;
      size: number;
    }
  | {
      /** A figure: copied from `page` of the source PDF (the box is in that page's own coordinates), or the PNG if it can't be. */
      kind: "figure";
      page: number;
      pdfBox: [number, number, number, number];
      png: Uint8Array;
      w: number;
      h: number;
    };

export interface HwOptions {
  paper: Paper;
  /** Ink colour, 0-255 per channel. */
  ink: readonly [number, number, number];
  /** Page size in points. */
  page: { w: number; h: number };
}

/**
 * Font files, in the order each character is looked for: the handwriting
 * font's own files (its Latin set, then extended Latin and so on), then a
 * plain font for anything those lack, like a bullet. `bold` is the same
 * font's bold, for fonts that have one; others are pressed harder instead.
 */
export interface HwFonts {
  hand: Uint8Array[];
  bold?: Uint8Array[];
  fallback?: Uint8Array;
}

export interface HwExtras {
  arts?: Map<string, HwArt>;
  /** The original PDF, so figures can be copied over exactly. */
  source?: Uint8Array;
}

export interface HwResult {
  bytes: Uint8Array;
  pages: number;
  /** Characters no font had, so they were left out. */
  missing: string[];
}

/** Distance between the lines on the paper, in points: wide-ruled notebook paper. */
const RULE = 23;
/** Computer Modern's (and most text fonts') small letters, as a share of the size: to match equations to the handwriting. */
const TEX_X_HEIGHT = 0.43;

interface Face {
  font: PDFFont;
  chars: Set<number>;
  /** Size multiplier, so a fallback font's small letters stand as tall as the handwriting's. */
  scale: number;
}

type Piece =
  | { kind: "text"; text: string; face: Face; bold: boolean; italic: boolean }
  | { kind: "art"; id: string };

type Token = { kind: "word"; pieces: Piece[] } | { kind: "space" } | { kind: "nl" };

/** A word placed on a line: its pieces, its own size wobble and how wide it comes out. */
interface Word {
  pieces: Piece[];
  scale: number;
  width: number;
}

/** Proportions of a font, as a share of its size. */
interface Metrics {
  x: number;
  cap: number;
  /** Tallest small letter, like an "l". */
  asc: number;
  /** How wide a short phrase runs, as a share of the size. */
  phrase: number;
}

function metrics(bytes: Uint8Array): Metrics {
  const f = fontkit.create(bytes) as unknown as {
    unitsPerEm: number;
    glyphForCodePoint(cp: number): { id: number; bbox: { maxY: number }; advanceWidth: number } | null;
  };
  const top = (ch: string) => {
    const g = f.glyphForCodePoint(ch.codePointAt(0)!);
    return g && g.id ? Math.max(0, g.bbox.maxY) / f.unitsPerEm : 0;
  };
  const x = top("x") || top("o") || top("a") || 0.45;
  const cap = top("H") || top("E") || x * 1.6;
  const asc = Math.max(top("l"), top("d"), top("h"), top("k")) || cap;
  let phrase = 0;
  for (const ch of "the quick brown fox") {
    const g = f.glyphForCodePoint(ch.codePointAt(0)!);
    phrase += (g?.advanceWidth ?? 0) / f.unitsPerEm;
  }
  return { x, cap, asc, phrase: phrase || 8 };
}

/** A small seeded random generator (mulberry32), so every build of the same document matches. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Embedded pictures and copied figures, made once each. */
interface Gallery {
  image(id: string): PDFImage | undefined;
  figure(id: string): PDFEmbeddedPage | undefined;
}

/** Writes blocks onto pages, a ruled line at a time. */
class Writer {
  private readonly doc: PDFDocument;
  private readonly faces: Face[];
  private readonly boldFaces: Face[];
  private readonly opts: HwOptions;
  private readonly arts: Map<string, HwArt>;
  private readonly gallery: Gallery;
  private readonly r: () => number;
  private readonly color: Color;
  /** Body text size, chosen so the font's small letters fill about a third of a line. */
  readonly size: number;
  private readonly xHeight: number;
  private readonly W: number;
  private readonly H: number;
  /** Where writing starts and how wide a line can be. */
  private readonly left: number;
  private readonly width: number;
  /** The first line's baseline, from the top of the page, and how many lines fit. */
  private readonly top: number;
  private readonly slots: number;
  private page: PDFPage | null = null;
  private slot = 0;
  private readonly spaceW: number;
  readonly missing = new Set<string>();
  pages = 0;

  constructor(
    doc: PDFDocument,
    faces: Face[],
    boldFaces: Face[],
    hand: Metrics,
    opts: HwOptions,
    arts: Map<string, HwArt>,
    gallery: Gallery,
  ) {
    this.doc = doc;
    this.faces = faces;
    this.boldFaces = boldFaces;
    this.opts = opts;
    this.arts = arts;
    this.gallery = gallery;
    this.r = random(0x5eed + 7);
    this.color = rgb(opts.ink[0] / 255, opts.ink[1] / 255, opts.ink[2] / 255);
    // Small letters about 30% of the line, or, for narrow hands, big enough that words run about as
    // wide as an everyday hand's; either way not so big the tall letters reach the line above.
    const natural = Math.max((RULE * 0.3) / hand.x, 125 / hand.phrase);
    this.size = Math.max(11, Math.min(30, natural, (RULE * 0.75) / hand.asc, (RULE * 0.9) / hand.cap));
    this.xHeight = hand.x * this.size;
    this.W = opts.page.w;
    this.H = opts.page.h;
    const margin = Math.round(this.W * 0.115);
    this.left = opts.paper === "lined" ? margin + 9 : Math.round(this.W * 0.1);
    this.width = this.W - this.left - Math.round(this.W * 0.075);
    this.top = Math.max(60, Math.round(this.H * 0.105));
    this.slots = Math.max(4, Math.floor((this.H - Math.max(36, this.H * 0.065) - this.top) / RULE) + 1);
    const face = faces[0];
    const space = face.chars.has(32) ? face.font.widthOfTextAtSize(" ", this.size) : this.size * 0.3;
    this.spaceW = Math.min(this.size * 0.42, Math.max(this.size * 0.24, space));
  }

  // ------------------------------------------------------------- blocks

  write(blocks: HwBlock[]): void {
    let prev: HwBlock["kind"] | null = null;
    for (const b of blocks) {
      // A blank line between blocks, but list items run on.
      const together = prev === "li" && b.kind === "li";
      if (prev !== null && !together) this.skip(1);
      if (b.kind === "h") this.heading(b.level, b.text);
      else if (b.kind === "p") this.lines(this.tokens(b.runs), this.left, this.width, 1);
      else if (b.kind === "li") this.item(b.number, b.runs);
      else if (b.kind === "table") this.table(b.rows);
      else this.art(b.id);
      prev = b.kind;
    }
    if (!this.page) this.newPage();
  }

  private heading(level: number, text: string): void {
    const scale = level === 1 ? 1.5 : level === 2 ? 1.28 : 1.12;
    const lines = this.wrap(this.tokens([{ text, bold: false, italic: false }]), this.width, scale);
    // Big letters take two lines of the paper; keep the heading with what follows it.
    const span = level === 1 ? 2 : 1;
    if (this.page && this.slot > 0 && this.slot + lines.length * span + 1 > this.slots) this.newPage();
    for (const words of lines) {
      if (span > 1) this.skip(span - 1);
      this.ensurePage();
      const end = this.line(words, this.left, scale);
      if (level === 1) this.underline(this.left, end, this.baseline() - this.size * 0.32);
      this.slot += 1;
    }
  }

  private item(number: number | null, runs: HwRun[]): void {
    const plain = (text: string) => this.tokens([{ text, bold: false, italic: false }]);
    const indent = this.measure(plain("00."), 1) + this.size * 0.35;
    const lines = this.wrap(this.tokens(runs), this.width - indent, 1);
    lines.forEach((words, i) => {
      this.ensurePage();
      if (i === 0) {
        if (number !== null) this.line(this.wrap(plain(`${number}.`), indent, 1)[0] ?? [], this.left, 1);
        else this.dot(this.left + this.xHeight * 0.6, this.baseline() + this.xHeight * 0.55);
      }
      this.line(words, this.left + indent, 1);
      this.slot += 1;
    });
    if (!lines.length) this.slot += 1;
  }

  private table(rows: string[][]): void {
    const n = Math.max(1, ...rows.map((r) => r.length));
    const gap = this.size * 0.8;
    const colW = (this.width - gap * (n - 1)) / n;
    rows.forEach((row, ri) => {
      // The first row is the header: written heavier.
      const cells = row.map((cell) => this.wrap(this.tokens([{ text: cell, bold: ri === 0, italic: false }]), colW, 1));
      const height = Math.max(1, ...cells.map((c) => c.length));
      for (let l = 0; l < height; l++) {
        this.ensurePage();
        cells.forEach((c, ci) => {
          if (c[l]) this.line(c[l], this.left + ci * (colW + gap), 1);
        });
        this.slot += 1;
      }
    });
  }

  /** Wrapped text, a line of the paper per line of text. */
  private lines(tokens: Token[], left: number, width: number, scale: number): void {
    for (const words of this.wrap(tokens, width, scale)) {
      this.ensurePage();
      this.line(words, left, scale);
      this.slot += 1;
    }
  }

  /** How much to enlarge an equation so its letters stand as tall as the handwriting's. */
  private mathScale(art: { size: number; h: number }, scale = 1, maxH = Infinity): number {
    const k = (this.xHeight * scale) / (TEX_X_HEIGHT * art.size);
    return Math.min(k, maxH / art.h);
  }

  /** A display equation or a figure, on lines of its own, centred. */
  private art(id: string): void {
    const art = this.arts.get(id);
    if (!art) return;
    const figure = art.kind === "figure";
    const room = (this.slots - 1) * RULE;
    let k = figure ? 1 : this.mathScale(art);
    k = Math.min(k, this.width / art.w, room / art.h);
    const w = art.w * k;
    const h = art.h * k;
    const x = this.left + (this.width - w) / 2 + (this.r() - 0.5) * 6;
    let n: number;
    let y: number;
    if (art.kind === "figure") {
      n = Math.max(1, Math.ceil((h + 10) / RULE));
      this.ensurePage();
      if (this.slot > 0 && this.slot + n > this.slots) this.newPage();
      // Centred in the lines it takes: from just under the previous line to n lines down.
      const top = this.baselineAt(this.slot - 1);
      const bottom = this.baselineAt(this.slot + n - 1);
      y = bottom + (top - bottom - h) / 2;
    } else {
      // An equation sits on a line like writing does: its baseline on a rule, with as many lines above
      // as its tall parts need, and below only if it hangs past the line's own room for descenders.
      const below = art.base * k;
      const up = Math.max(1, Math.ceil((h - below + 3) / RULE));
      const down = Math.max(0, Math.ceil((below - RULE * 0.3) / RULE));
      n = up + down;
      this.ensurePage();
      if (this.slot > 0 && this.slot + n > this.slots) this.newPage();
      y = this.baselineAt(this.slot + up - 1) - below;
    }
    const page = this.page!;
    if (art.kind === "figure") {
      // Pasted in: on its own white, so the paper's lines don't run through it.
      page.drawRectangle({ x: x - 3, y: y - 3, width: w + 6, height: h + 6, color: rgb(1, 1, 1) });
      const copy = this.gallery.figure(id);
      if (copy) page.drawPage(copy, { x, y, width: w, height: h });
      else {
        const img = this.gallery.image(id);
        if (img) page.drawImage(img, { x, y, width: w, height: h });
      }
    } else {
      const img = this.gallery.image(id);
      const tilt = (this.r() - 0.5) * 0.8;
      if (img) page.drawImage(img, { x, y, width: w, height: h, rotate: degrees(tilt), opacity: 0.95 });
    }
    this.slot += n;
  }

  // ------------------------------------------------------------- pages

  private ensurePage(): void {
    if (!this.page || this.slot >= this.slots) this.newPage();
  }

  private skip(n: number): void {
    if (!this.page || this.slot === 0) return; // no blank lines at the top of a page
    this.slot += n;
    if (this.slot >= this.slots) this.newPage();
  }

  private newPage(): void {
    this.page = this.doc.addPage([this.W, this.H]);
    this.pages += 1;
    this.slot = 0;
    this.drawPaper(this.page);
  }

  /** The paper: ruled notebook lines with a red margin, squares, dots, or nothing. */
  private drawPaper(page: PDFPage): void {
    const paper = this.opts.paper;
    if (paper === "lined") {
      const blue = rgb(0.68, 0.8, 0.92);
      for (let i = -1; i < this.slots; i++) {
        const y = this.H - (this.top + i * RULE);
        page.drawLine({ start: { x: 0, y }, end: { x: this.W, y }, thickness: 0.6, color: blue });
      }
      const x = this.left - 9;
      page.drawLine({ start: { x, y: 0 }, end: { x, y: this.H }, thickness: 0.8, color: rgb(0.92, 0.6, 0.62) });
    } else if (paper === "grid" || paper === "dots") {
      // Squares half a line high, lined up so every other one is a baseline.
      const step = RULE / 2;
      const ys: number[] = [];
      for (let y = this.H - this.top + Math.ceil(this.top / step) * step; y > 0; y -= step) ys.push(y);
      const xs: number[] = [];
      for (let x = this.left % step; x < this.W; x += step) xs.push(x);
      if (paper === "grid") {
        const c = rgb(0.75, 0.82, 0.88);
        for (const y of ys) page.drawLine({ start: { x: 0, y }, end: { x: this.W, y }, thickness: 0.45, color: c });
        for (const x of xs) page.drawLine({ start: { x, y: 0 }, end: { x, y: this.H }, thickness: 0.45, color: c });
      } else {
        const c = rgb(0.62, 0.66, 0.72);
        for (const y of ys) for (const x of xs) page.drawCircle({ x, y, size: 0.65, color: c });
      }
    }
  }

  /** A line's baseline, in PDF coordinates: just above the rule, where a pen rests. */
  private baselineAt(slot: number): number {
    return this.H - (this.top + slot * RULE) + 1.2;
  }

  private baseline(): number {
    return this.baselineAt(this.slot);
  }

  // ------------------------------------------------------------- text

  /** Split runs into words, spaces and kept line breaks, each character in the first font that has it. */
  private tokens(runs: HwRun[]): Token[] {
    const out: Token[] = [];
    const word = (): Piece[] => {
      const last = out[out.length - 1];
      if (last?.kind === "word") return last.pieces;
      const pieces: Piece[] = [];
      out.push({ kind: "word", pieces });
      return pieces;
    };
    for (const run of runs) {
      for (const part of run.text.split(/(\n|[ \t  -​]+)/)) {
        if (!part) continue;
        if (part === "\n") out.push({ kind: "nl" });
        else if (!part.trim()) {
          if (out.length && out[out.length - 1].kind === "word") out.push({ kind: "space" });
        } else {
          const pieces = word();
          for (const ch of part) {
            const art = this.arts.get(ch);
            if (art) {
              // Display equations and figures were split out into blocks of their own; only inline ones flow with the text.
              if (art.kind === "inline") pieces.push({ kind: "art", id: ch });
              continue;
            }
            if (/\p{C}/u.test(ch)) continue; // soft hyphens, zero-width joiners and the like
            const cp = ch.codePointAt(0)!;
            const strong = run.bold ? this.boldFaces.find((f) => f.chars.has(cp)) : undefined;
            const face = strong ?? this.faces.find((f) => f.chars.has(cp));
            if (!face) {
              this.missing.add(ch);
              continue;
            }
            // A real bold face needs no pressing harder.
            const bold = run.bold && !strong;
            const p = pieces[pieces.length - 1];
            if (p?.kind === "text" && p.face === face && p.bold === bold && p.italic === run.italic) p.text += ch;
            else pieces.push({ kind: "text", text: ch, face, bold, italic: run.italic });
          }
        }
      }
    }
    return out;
  }

  /** An inline equation's size: matched to the handwriting, and never taller than a line and a third. */
  private inlineSize(id: string, size: number): { w: number; h: number; base: number } {
    const art = this.arts.get(id);
    if (!art || art.kind === "figure") return { w: 0, h: 0, base: 0 };
    const k = this.mathScale(art, size / this.size, RULE * 1.35);
    return { w: art.w * k, h: art.h * k, base: art.base * k };
  }

  private pieceWidth(p: Piece, size: number): number {
    if (p.kind === "art") return this.inlineSize(p.id, size).w;
    return p.face.font.widthOfTextAtSize(p.text, size * p.face.scale);
  }

  private measure(tokens: Token[], scale: number): number {
    let w = 0;
    for (const t of tokens) {
      if (t.kind === "word") for (const p of t.pieces) w += this.pieceWidth(p, this.size * scale);
      else if (t.kind === "space") w += this.spaceW * scale;
    }
    return w;
  }

  /** Break words into lines that fit `width`. A word too long for any line is split across lines. */
  private wrap(tokens: Token[], width: number, scale: number): Word[][] {
    const lines: Word[][] = [];
    let line: Word[] = [];
    let used = 0;
    const flush = () => {
      lines.push(line);
      line = [];
      used = 0;
    };
    for (const t of tokens) {
      if (t.kind === "nl") {
        flush();
        continue;
      }
      if (t.kind === "space" || !t.pieces.length) continue;
      const wobble = 1 + (this.r() - 0.5) * 0.06;
      const size = this.size * scale * wobble;
      for (const pieces of this.split(t.pieces, size, width)) {
        const w = pieces.reduce((s, p) => s + this.pieceWidth(p, size), 0);
        const gap = line.length ? this.spaceW * scale : 0;
        if (line.length && used + gap + w > width) flush();
        line.push({ pieces, scale: scale * wobble, width: w });
        used += (line.length > 1 ? this.spaceW * scale : 0) + w;
      }
    }
    if (line.length) flush();
    // Drop empty lines from a trailing break, but keep deliberate blank ones in the middle.
    while (lines.length && !lines[lines.length - 1].length) lines.pop();
    return lines;
  }

  /** A word as one piece list, or several if it's wider than a whole line. */
  private split(pieces: Piece[], size: number, width: number): Piece[][] {
    const total = pieces.reduce((s, p) => s + this.pieceWidth(p, size), 0);
    if (total <= width) return [pieces];
    const out: Piece[][] = [];
    let cur: Piece[] = [];
    let used = 0;
    const put = (c: Piece, w: number) => {
      if (cur.length && used + w > width) {
        out.push(cur);
        cur = [];
        used = 0;
      }
      const last = cur[cur.length - 1];
      if (
        c.kind === "text" &&
        last?.kind === "text" &&
        last.face === c.face &&
        last.bold === c.bold &&
        last.italic === c.italic
      )
        last.text += c.text;
      else cur.push(c);
      used += w;
    };
    for (const p of pieces) {
      if (p.kind === "art") put(p, this.pieceWidth(p, size));
      else for (const ch of p.text) put({ ...p, text: ch }, this.pieceWidth({ ...p, text: ch }, size));
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /**
   * One line of words, written along a slightly sloping baseline. Returns
   * where the writing ended, for underlining.
   */
  private line(words: Word[], left: number, scale: number): number {
    const page = this.page!;
    const r = this.r;
    const bell = () => (r() + r() + r()) / 1.5 - 1; // -1..1, mostly near 0
    const slope = (bell() * 0.35 * Math.PI) / 180;
    const base = this.baseline() + bell() * 0.6;
    let x = left + r() * 1.6;
    for (const [i, word] of words.entries()) {
      if (i > 0) x += this.spaceW * scale * (0.85 + r() * 0.4);
      const size = this.size * word.scale;
      const tilt = slope + (bell() * 0.7 * Math.PI) / 180;
      const y = base + (x - left) * Math.tan(slope) + bell() * 0.55;
      // Pressure: a few levels, so the PDF holds a handful of transparency settings, not one per word.
      const opacity = [0.86, 0.91, 0.95, 1][Math.floor(r() * 4)];
      let px = x;
      let py = y;
      for (const p of word.pieces) {
        if (p.kind === "art") {
          const { w, h, base: b } = this.inlineSize(p.id, size);
          const img = this.gallery.image(p.id);
          // The equation's own baseline on the pen's line.
          if (img) {
            page.drawImage(img, {
              x: px + b * Math.sin(tilt),
              y: py - b * Math.cos(tilt),
              width: w,
              height: h,
              rotate: degrees((tilt * 180) / Math.PI),
              opacity: Math.max(0.92, opacity),
            });
          }
          px += w * Math.cos(tilt);
          py += w * Math.sin(tilt);
          continue;
        }
        const s = size * p.face.scale;
        const w = p.face.font.widthOfTextAtSize(p.text, s);
        const draw = (dx: number) =>
          page.drawText(p.text, {
            x: px + dx,
            y: py,
            size: s,
            font: p.face.font,
            color: this.color,
            opacity,
            rotate: degrees((tilt * 180) / Math.PI),
            // ySkew leans the letters forward; xSkew would tilt the baseline instead.
            ySkew: p.italic ? degrees(11) : undefined,
          });
        draw(0);
        // Bold: go over the word again, a hair to the side, like pressing harder.
        if (p.bold) draw(Math.max(0.35, s * 0.025));
        px += w * Math.cos(tilt);
        py += w * Math.sin(tilt);
      }
      x += word.width;
    }
    return x;
  }

  /** A hand-drawn underline: a slightly bowed stroke that tapers off. */
  private underline(x0: number, x1: number, y: number): void {
    const page = this.page!;
    const r = this.r;
    const len = x1 - x0 + this.size * 0.3;
    const lift = (r() - 0.3) * 2.2;
    const sag = 0.8 + r() * 1.2;
    // drawSvgPath measures y downwards from the point it's given.
    const path = `M 0 0 Q ${len * 0.5} ${sag} ${len} ${-lift}`;
    page.drawSvgPath(path, {
      x: x0 - this.size * 0.1,
      y,
      borderColor: this.color,
      borderWidth: Math.max(0.9, this.size * 0.05),
      borderOpacity: 0.92,
      borderLineCap: LineCapStyle.Round,
    });
  }

  /** A bullet: a small pressed-in dot of ink. */
  private dot(x: number, y: number): void {
    const rad = Math.max(1.4, this.xHeight * 0.27);
    this.page!.drawEllipse({ x, y, xScale: rad * 1.1, yScale: rad, color: this.color, opacity: 0.95 });
  }
}

async function embedFaces(doc: PDFDocument, files: Uint8Array[] | undefined, scale = 1): Promise<Face[]> {
  const faces: Face[] = [];
  for (const bytes of files ?? []) {
    const font = await doc.embedFont(bytes, { subset: true });
    faces.push({ font, chars: new Set(font.getCharacterSet()), scale });
  }
  return faces;
}

/** Write the blocks out by hand as a new PDF. */
export async function handwrite(
  blocks: HwBlock[],
  fonts: HwFonts,
  opts: HwOptions,
  extras: HwExtras = {},
): Promise<HwResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const hand = metrics(fonts.hand[0]);
  const faces = await embedFaces(doc, fonts.hand);
  if (fonts.fallback) faces.push(...(await embedFaces(doc, [fonts.fallback], Math.min(1.4, hand.x / metrics(fonts.fallback).x))));
  const boldFaces = await embedFaces(doc, fonts.bold);

  // Pictures for the equations (and figures that can't be copied), and the figures copied from the original.
  const arts = extras.arts ?? new Map<string, HwArt>();
  const used = new Set<string>();
  for (const b of blocks) {
    const texts = b.kind === "art" ? [b.id] : b.kind === "h" ? [b.text] : b.kind === "table" ? b.rows.flat() : b.runs.map((r) => r.text);
    for (const t of texts) for (const ch of t) if (arts.has(ch)) used.add(ch);
  }
  const images = new Map<string, PDFImage>();
  const figures = new Map<string, PDFEmbeddedPage>();
  let source: PDFDocument | null = null;
  if (extras.source && [...used].some((id) => arts.get(id)!.kind === "figure")) {
    try {
      source = await PDFDocument.load(extras.source, { updateMetadata: false });
      if (source.isEncrypted) source = null;
    } catch {
      source = null;
    }
  }
  for (const id of used) {
    const art = arts.get(id)!;
    if (art.kind === "figure" && source) {
      const page = source.getPages()[art.page];
      if (page && page.getRotation().angle % 360 === 0) {
        try {
          const [x0, y0, x1, y1] = art.pdfBox;
          figures.set(id, await doc.embedPage(page, { left: x0, bottom: y0, right: x1, top: y1 }));
          continue;
        } catch {
          // Fall back to the picture of it.
        }
      }
    }
    if (art.png.length) {
      try {
        images.set(id, await doc.embedPng(art.png));
      } catch {
        // Leave it out.
      }
    }
  }
  const gallery: Gallery = { image: (id) => images.get(id), figure: (id) => figures.get(id) };

  const writer = new Writer(doc, faces, boldFaces, hand, opts, arts, gallery);
  writer.write(blocks);
  // A new document: no title, author or producer carried over or added.
  doc.setProducer("");
  doc.setCreator("");
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pages: writer.pages, missing: [...writer.missing] };
}
