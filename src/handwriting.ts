import fontkit from "@pdf-lib/fontkit";
import { degrees, LineCapStyle, PDFDocument, rgb, type Color, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Write a document out by hand: its text set in one of the handwriting fonts
 * from the Sign tool, on plain or lined paper, as a new PDF.
 *
 * The font itself is embedded, so the result is sharp at any zoom, small,
 * and its text can still be selected and searched. What makes it look
 * written rather than typeset is small, seeded unevenness: each line runs a
 * touch uphill or down, each word sits a little off the line, tilts, varies
 * in size and pressure, and the gaps between words aren't all the same. The
 * seed is fixed, so the same document and settings always come out the same.
 */

export type Paper = "lined" | "plain";

export interface HwRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** What to write. A "\n" inside a run keeps a line break, like in an address. */
export type HwBlock =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; runs: HwRun[] }
  | { kind: "li"; number: number | null; runs: HwRun[] }
  | { kind: "table"; rows: string[][] };

export interface HwOptions {
  paper: Paper;
  /** Ink colour, 0-255 per channel. */
  ink: readonly [number, number, number];
  /** Page size in points. */
  page: { w: number; h: number };
}

/**
 * Font files, in the order each character is looked for: the handwriting
 * font's own files (its Latin set, then extended Latin), then a plain font
 * for anything those lack, like Greek, Cyrillic or a bullet.
 */
export interface HwFonts {
  hand: Uint8Array[];
  fallback?: Uint8Array;
}

export interface HwResult {
  bytes: Uint8Array;
  pages: number;
  /** Characters no font had, so they were left out. */
  missing: string[];
}

/** Distance between the lines on the paper, in points: wide-ruled notebook paper. */
const RULE = 23;

interface Face {
  font: PDFFont;
  chars: Set<number>;
  /** Size multiplier, so a fallback font's small letters stand as tall as the handwriting's. */
  scale: number;
}

interface Piece {
  text: string;
  face: Face;
  bold: boolean;
  italic: boolean;
}

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
}

function metrics(bytes: Uint8Array): Metrics {
  const f = fontkit.create(bytes) as unknown as {
    unitsPerEm: number;
    glyphForCodePoint(cp: number): { id: number; bbox: { maxY: number } } | null;
  };
  const top = (ch: string) => {
    const g = f.glyphForCodePoint(ch.codePointAt(0)!);
    return g && g.id ? Math.max(0, g.bbox.maxY) / f.unitsPerEm : 0;
  };
  const x = top("x") || top("o") || top("a") || 0.45;
  const cap = top("H") || top("E") || x * 1.6;
  const asc = Math.max(top("l"), top("d"), top("h"), top("k")) || cap;
  return { x, cap, asc };
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

/** Writes blocks onto pages, a ruled line at a time. */
class Writer {
  private readonly doc: PDFDocument;
  private readonly faces: Face[];
  private readonly opts: HwOptions;
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

  constructor(doc: PDFDocument, faces: Face[], hand: Metrics, opts: HwOptions) {
    this.doc = doc;
    this.faces = faces;
    this.opts = opts;
    this.r = random(0x5eed + 7);
    this.color = rgb(opts.ink[0] / 255, opts.ink[1] / 255, opts.ink[2] / 255);
    // Small letters about 30% of the line, unless that makes the tall letters reach the line above.
    this.size = Math.max(11, Math.min(30, (RULE * 0.3) / hand.x, (RULE * 0.75) / hand.asc, (RULE * 0.9) / hand.cap));
    this.xHeight = hand.x * this.size;
    this.W = opts.page.w;
    this.H = opts.page.h;
    const lined = opts.paper === "lined";
    const margin = Math.round(this.W * 0.115);
    this.left = lined ? margin + 9 : Math.round(this.W * 0.1);
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
      // A blank line between blocks, but list items and table rows run on.
      const together = prev === "li" && b.kind === "li";
      if (prev !== null && !together) this.skip(1);
      if (b.kind === "h") this.heading(b.level, b.text);
      else if (b.kind === "p") this.lines(this.tokens(b.runs), this.left, this.width, 1);
      else if (b.kind === "li") this.item(b.number, b.runs);
      else this.table(b.rows);
      prev = b.kind;
    }
    if (!this.page) this.newPage();
  }

  private heading(level: number, text: string): void {
    const scale = level === 1 ? 1.5 : level === 2 ? 1.28 : 1.12;
    const runs = [{ text, bold: false, italic: false }];
    const lines = this.wrap(this.tokens(runs), this.width, scale);
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
    const marker = number === null ? null : `${number}.`;
    const indent = this.measure(this.tokens([{ text: "00.", bold: false, italic: false }]), 1) + this.size * 0.35;
    const lines = this.wrap(this.tokens(runs), this.width - indent, 1);
    lines.forEach((words, i) => {
      this.ensurePage();
      if (i === 0) {
        if (marker) this.line(this.wrap(this.tokens([{ text: marker, bold: false, italic: false }]), indent, 1)[0], this.left, 1);
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
    if (this.opts.paper === "lined") this.rulePaper(this.page);
  }

  /** Notebook paper: pale blue lines and a red margin. */
  private rulePaper(page: PDFPage): void {
    const blue = rgb(0.68, 0.8, 0.92);
    for (let i = -1; i < this.slots; i++) {
      const y = this.H - (this.top + i * RULE);
      page.drawLine({ start: { x: 0, y }, end: { x: this.W, y }, thickness: 0.6, color: blue });
    }
    const x = this.left - 9;
    page.drawLine({ start: { x, y: 0 }, end: { x, y: this.H }, thickness: 0.8, color: rgb(0.92, 0.6, 0.62) });
  }

  /** The current line's baseline, in PDF coordinates: just above the rule, where a pen rests. */
  private baseline(): number {
    return this.H - (this.top + this.slot * RULE) + 1.2;
  }

  // ------------------------------------------------------------- text

  /** Split runs into words, spaces and kept line breaks, each character in the first font that has it. */
  private tokens(runs: HwRun[]): Token[] {
    const out: Token[] = [];
    for (const run of runs) {
      for (const part of run.text.split(/(\n|[ \t  -​]+)/)) {
        if (!part) continue;
        if (part === "\n") out.push({ kind: "nl" });
        else if (!part.trim()) {
          if (out.length && out[out.length - 1].kind === "word") out.push({ kind: "space" });
        } else {
          const last = out[out.length - 1];
          const word = last?.kind === "word" ? last : ({ kind: "word", pieces: [] } as Token & { kind: "word" });
          if (word !== last) out.push(word);
          for (const ch of part) {
            const cp = ch.codePointAt(0)!;
            if (/\p{C}/u.test(ch)) continue; // soft hyphens, zero-width joiners and the like
            const face = this.faces.find((f) => f.chars.has(cp));
            if (!face) {
              this.missing.add(ch);
              continue;
            }
            const p = word.pieces[word.pieces.length - 1];
            if (p && p.face === face && p.bold === run.bold && p.italic === run.italic) p.text += ch;
            else word.pieces.push({ text: ch, face, bold: run.bold, italic: run.italic });
          }
        }
      }
    }
    return out;
  }

  private pieceWidth(p: Piece, size: number): number {
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
      if (t.kind === "space") continue;
      if (!t.pieces.length) continue;
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
    for (const p of pieces) {
      for (const ch of p.text) {
        const c: Piece = { ...p, text: ch };
        const w = this.pieceWidth(c, size);
        if (cur.length && used + w > width) {
          out.push(cur);
          cur = [];
          used = 0;
        }
        const last = cur[cur.length - 1];
        if (last && last.face === c.face && last.bold === c.bold && last.italic === c.italic) last.text += ch;
        else cur.push(c);
        used += w;
      }
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

/** Write the blocks out by hand as a new PDF. */
export async function handwrite(blocks: HwBlock[], fonts: HwFonts, opts: HwOptions): Promise<HwResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const hand = metrics(fonts.hand[0]);
  const faces: Face[] = [];
  for (const bytes of fonts.hand) {
    const font = await doc.embedFont(bytes, { subset: true });
    faces.push({ font, chars: new Set(font.getCharacterSet()), scale: 1 });
  }
  if (fonts.fallback) {
    const font = await doc.embedFont(fonts.fallback, { subset: true });
    const fb = metrics(fonts.fallback);
    faces.push({ font, chars: new Set(font.getCharacterSet()), scale: Math.min(1.4, hand.x / fb.x) });
  }
  const writer = new Writer(doc, faces, hand, opts);
  writer.write(blocks);
  // A new document: no title, author or producer carried over or added.
  doc.setProducer("");
  doc.setCreator("");
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pages: writer.pages, missing: [...writer.missing] };
}
