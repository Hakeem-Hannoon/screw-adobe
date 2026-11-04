import type { Line, Run } from "./extract";

/**
 * Work out a document's structure from laid-out pages: headings, paragraphs,
 * list items and tables. Markdown and Word output are both written from this.
 *
 * Structure is inferred from how the text looks, since PDFs rarely say what
 * anything is:
 * - Lines in a font clearly bigger than the body text are headings, the
 *   biggest size level 1, the next level 2, the rest level 3.
 * - Lines starting with a bullet or "1." / "a)" are list items; lines tucked
 *   in under them continue the item.
 * - Two or more lines in a row split into the same number of columns by wide
 *   gaps are a table.
 * - Paragraph lines that run (nearly) the full width are joined, so the text
 *   reflows. Short lines, like an address, keep their breaks: the run between
 *   them holds a "\n".
 */

export interface Stats {
  body: number;
  /** Heading sizes, biggest first. */
  headings: number[];
  /** How wide a full line of body text is. */
  fullWidth: number;
}

interface Placed {
  /** Where the block starts and ends on the page, measured up from the bottom along the text's direction. */
  top: number;
  bottom: number;
}

export interface Heading extends Placed {
  kind: "h";
  level: number;
  text: string;
  /** The lines it came from, so a heading that wrapped can be joined back up. */
  last: Line;
}

export interface Paragraph extends Placed {
  kind: "p";
  runs: Run[];
  /** The last line ran the full width, so the paragraph may continue on the next page. */
  openEnd: boolean;
}

export interface ListItem extends Placed {
  kind: "li";
  /** Number for an ordered item, null for a bullet. */
  number: number | null;
  runs: Run[];
}

export interface Table extends Placed {
  kind: "table";
  rows: string[][];
}

export type Block = Heading | Paragraph | ListItem | Table;

const round = (n: number) => Math.round(n * 2) / 2;
// Includes the private-use bullets Word's Symbol and Wingdings fonts leave behind.
const BULLET = /^\s*([•●○◦▪▫■□‣⁃∙·\u2013\u2014*+\uf0b7\uf0a7\uf0d8\uf076\uf0fc-])\s+/;
const NUMBERED = /^\s*(\d{1,3}|[a-z]|[ivx]{1,4})([.)])\s+/;
/** A cell that's only a list marker: "•", "3", "3.", "c)". Set apart by a gap, a bare number counts too. */
const MARKER_CELL = /^([•●○◦▪▫■□‣⁃∙·\u2013\u2014*+\uf0b7\uf0a7\uf0d8\uf076\uf0fc-]|\d{1,3}[.)]?|[a-z][.)]|[ivx]{1,4}[.)])$/;

/** "1  Open the file" with a gap after the number: a list item even without "1.". */
const markerLine = (l: Line) => l.cells.length === 2 && MARKER_CELL.test(l.cells[0]);

export function measure(pages: Line[][]): Stats {
  // Body text is whatever size most of the characters are set in.
  const chars = new Map<number, number>();
  for (const lines of pages) {
    for (const l of lines) chars.set(round(l.size), (chars.get(round(l.size)) ?? 0) + l.text.length);
  }
  let body = 0;
  let most = -1;
  for (const [size, n] of chars) {
    if (n > most) {
      body = size;
      most = n;
    }
  }

  const headings = [...chars.keys()].filter((s) => s > body * 1.12).sort((a, b) => b - a);

  const widths = pages
    .flat()
    .filter((l) => round(l.size) === body && l.text.length > 20)
    .map((l) => l.end - l.start)
    .sort((a, b) => a - b);
  const fullWidth = widths.length ? widths[Math.floor(widths.length * 0.9)] : Infinity;

  return { body, headings, fullWidth };
}

const placed = (lines: Line[]): Placed => ({
  top: lines[0].across + lines[0].size,
  bottom: lines[lines.length - 1].across - lines[lines.length - 1].size * 0.25,
});

/** One page's blocks, in reading order. */
export function pageBlocks(lines: Line[], stats: Stats): Block[] {
  const blocks: Block[] = [];
  let para: Line[] = [];
  let item: { number: number | null; indent: number; lines: Line[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push(paragraph(para, stats));
    para = [];
  };
  const flushItem = () => {
    if (item) {
      blocks.push({ kind: "li", number: item.number, runs: joinRuns(item.lines, stats, true), ...placed(item.lines) });
    }
    item = null;
  };

  let prev: Line | null = null;
  let lastHeading: Line | null = null;
  const tables = findTables(lines);
  for (const [i, line] of lines.entries()) {
    const table = tables.get(i);
    if (table) {
      flushPara();
      flushItem();
      blocks.push(table);
      prev = null;
      continue;
    }
    if (tables.has(-i)) continue; // a row of a table already taken
    const level = headingLevel(line, stats);
    // A list marker only counts at the start of something: not on a line that
    // continues a full-width one ("...said\n- quietly" or "...by\nJ. Smith").
    const canStart: boolean = !prev || line.paraBreak || item !== null || !isFull(prev, stats);
    prev = line;
    const bullet: RegExpMatchArray | null | false = canStart && line.text.match(BULLET);
    const numbered =
      canStart &&
      !bullet &&
      (line.text.match(NUMBERED) || (markerLine(line) && line.text.match(/^\s*(\d{1,3})[.)]?\s+/)));

    if (level) {
      flushPara();
      flushItem();
      // A heading that wrapped onto a second line continues the same heading...
      const before = blocks[blocks.length - 1];
      const last = before?.kind === "h" ? before : null;
      const text = line.text.trim();
      // ...but only if the line before really wrapped: wide, and this one starts where it did.
      const wrapped =
        lastHeading !== null &&
        lastHeading.end - lastHeading.start >= stats.fullWidth * 0.6 &&
        Math.abs(lastHeading.start - line.start) < line.size;
      if (last && wrapped && !line.paraBreak && last.level === level) {
        last.text += ` ${text}`;
        last.last = line;
        last.bottom = placed([line]).bottom;
      } else {
        blocks.push({ kind: "h", level, text, last: line, ...placed([line]) });
      }
      lastHeading = line;
      continue;
    }

    if (bullet || numbered) {
      flushPara();
      flushItem();
      const match = (bullet || numbered) as RegExpMatchArray;
      const number: number | null = bullet ? null : /^\d+$/.test(match[1]) ? Number(match[1]) : 1;
      item = { number, indent: line.start, lines: [stripMarker(line, match[0].length)] };
      continue;
    }

    // A line tucked in under a list item, with no gap above, continues it.
    if (item && !line.paraBreak && line.start > item.indent + line.size * 0.5) {
      item.lines.push(line);
      continue;
    }
    flushItem();

    if (line.paraBreak) flushPara();
    para.push(line);
  }
  flushPara();
  flushItem();
  return blocks;
}

/**
 * Runs of 2+ consecutive lines split into the same number (2+) of columns.
 * Returns each table keyed by its first line's index, and the other rows
 * keyed by their negated index so they're skipped.
 */
function findTables(lines: Line[]): Map<number, Table | null> {
  const out = new Map<number, Table | null>();
  let i = 0;
  const columns = (l: Line) => (markerLine(l) ? 1 : l.cells.length);
  while (i < lines.length) {
    const n = columns(lines[i]);
    let j = i + 1;
    while (n >= 2 && j < lines.length && columns(lines[j]) === n) j++;
    if (n >= 2 && j - i >= 2) {
      const rows = lines.slice(i, j);
      out.set(i, { kind: "table", rows: rows.map((l) => [...l.cells]), ...placed(rows) });
      for (let k = i + 1; k < j; k++) out.set(-k, null);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function headingLevel(line: Line, stats: Stats): number {
  const i = stats.headings.indexOf(round(line.size));
  if (i < 0 || line.text.length > 150) return 0;
  return Math.min(i + 1, 3);
}

function paragraph(lines: Line[], stats: Stats): Paragraph {
  const last = lines[lines.length - 1];
  return { kind: "p", runs: joinRuns(lines, stats, false), openEnd: isFull(last, stats), ...placed(lines) };
}

const isFull = (l: Line, stats: Stats) => l.end - l.start >= stats.fullWidth * 0.65;

/** Line-break run between two lines of a paragraph that shouldn't be joined. */
export const BREAK = "  \n";

/**
 * One paragraph's runs, with line breaks resolved: wrapped lines are joined
 * (a trailing hyphen joins without a space and stays), short lines keep their
 * break as a run of BREAK so the line structure survives.
 */
function joinRuns(lines: Line[], stats: Stats, alwaysJoin: boolean): Run[] {
  const runs: Run[] = [];
  lines.forEach((line, i) => {
    if (i > 0) {
      const prev = lines[i - 1];
      const hyphen = /\p{L}-$/u.test(prev.text) && /^\p{L}/u.test(line.text);
      const columns = prev.cells.length > 1 || line.cells.length > 1;
      const sep = alwaysJoin || (isFull(prev, stats) && !columns) ? (hyphen ? "" : " ") : BREAK;
      runs.push({ text: sep, bold: false, italic: false });
    }
    runs.push(...line.runs);
  });
  return runs;
}

/** Drop a list marker from the start of a line. */
function stripMarker(line: Line, length: number): Line {
  let left = length;
  const runs: Run[] = [];
  for (const r of line.runs) {
    if (left >= r.text.length) {
      left -= r.text.length;
      continue;
    }
    runs.push({ ...r, text: r.text.slice(left) });
    left = 0;
  }
  return { ...line, runs, text: line.text.slice(length) };
}

/**
 * Lines that repeat at the top or bottom of most pages: running headers and
 * footers like a document title or "Page 3 of 9". Digits are ignored when
 * comparing, so page numbers match. Returns, per page, the lines to leave out
 * of the body, plus the header and footer text as it reads on the first page
 * it appears on (with its page number, if any, swapped for "#").
 */
export function runningLines(pages: Line[][]): {
  skip: Set<Line>[];
  header: string | null;
  footer: string | null;
} {
  const skip = pages.map(() => new Set<Line>());
  const result = { skip, header: null as string | null, footer: null as string | null };
  const withText = pages.filter((p) => p.length);
  if (withText.length < 2) return result;

  const key = (l: Line) => l.text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  for (const edge of ["top", "bottom"] as const) {
    // The outermost two lines on each page, by position.
    const counts = new Map<string, number>();
    const candidates = pages.map((lines) => {
      const sorted = [...lines].sort((a, b) => (edge === "top" ? b.across - a.across : a.across - b.across));
      const picked = sorted.slice(0, 2);
      for (const k of new Set(picked.map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
      return picked;
    });
    const need = Math.max(2, Math.ceil(withText.length * 0.6));
    let text: string | null = null;
    candidates.forEach((picked, i) => {
      for (const l of picked) {
        const k = key(l);
        if (k.length < 1 || (counts.get(k) ?? 0) < need) continue;
        skip[i].add(l);
        text ??= l.text.trim().replace(/\d+/g, (d) => (/^(page\s*)?#/i.test(key(l)) || k === "#" ? "#" : d));
      }
    });
    if (edge === "top") result.header = text;
    else result.footer = text;
  }
  return result;
}

/**
 * Put paragraphs that run across a page break back together: when a page's
 * last paragraph ran to the end of its line and the next page picks up
 * mid-sentence (lowercase), they're one paragraph.
 */
export function joinPages(pages: Block[][]): Block[] {
  const out: Block[] = [];
  for (const blocks of pages) {
    const first = blocks[0];
    const prev = out[out.length - 1];
    const lead = first?.kind === "p" ? first.runs.map((r) => r.text).join("") : "";
    if (prev && first && prev.kind === "p" && first.kind === "p" && prev.openEnd && /^\p{Ll}/u.test(lead)) {
      out[out.length - 1] = { ...first, runs: [...prev.runs, { text: " ", bold: false, italic: false }, ...first.runs] };
      out.push(...blocks.slice(1));
    } else {
      out.push(...blocks);
    }
  }
  return out;
}
