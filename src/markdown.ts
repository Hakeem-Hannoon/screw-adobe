import type { Line, Run } from "./extract";

/**
 * Turn laid-out pages into Markdown.
 *
 * Structure is inferred from how the text looks, since PDFs rarely say what
 * anything is:
 * - Lines in a font clearly bigger than the body text become headings, the
 *   biggest size "#", the next "##", the rest "###".
 * - Lines starting with a bullet or "1." / "a)" become list items; lines
 *   tucked in under them continue the item.
 * - Bold and italic text is wrapped in ** and *.
 * - Two or more lines in a row split into the same number of columns by wide
 *   gaps become a table.
 * - Paragraph lines that run (nearly) the full width are joined, so the text
 *   reflows. Short lines, like an address, keep their breaks.
 */
export function toMarkdown(pages: Line[][], opts: { labels: boolean }): string {
  const stats = measure(pages);
  const rendered = pages.map((lines) => renderPage(lines, stats));

  if (opts.labels) {
    return (
      rendered
        .map(
          (blocks, i) => `${i > 0 ? "---\n\n" : ""}*Page ${i + 1}*${blocks.length ? `\n\n${joinBlocks(blocks)}` : ""}`,
        )
        .join("\n\n") + "\n"
    );
  }

  // Without page marks, a paragraph that runs across a page break is put back
  // together when the next page picks up mid-sentence.
  const out: Block[] = [];
  for (const blocks of rendered) {
    const first = blocks[0];
    const prev = out[out.length - 1];
    if (prev && first && prev.kind === "p" && first.kind === "p" && prev.openEnd && /^\p{Ll}/u.test(first.md)) {
      out[out.length - 1] = { ...first, md: `${prev.md} ${first.md}` };
      out.push(...blocks.slice(1));
    } else {
      out.push(...blocks);
    }
  }
  return out.length ? joinBlocks(out) + "\n" : "\n";
}

/** Blank lines between blocks, except between items of the same list. */
function joinBlocks(blocks: Block[]): string {
  return blocks
    .map((b, i) => (i === 0 ? "" : b.kind === "li" && blocks[i - 1].kind === "li" ? "\n" : "\n\n") + b.md)
    .join("");
}

interface Stats {
  body: number;
  /** Heading sizes, biggest first. */
  headings: number[];
  /** How wide a full line of body text is. */
  fullWidth: number;
}

interface Block {
  kind: "h" | "p" | "li" | "table";
  md: string;
  /** Paragraph's last line ran the full width, so it may continue on the next page. */
  openEnd?: boolean;
}

const round = (n: number) => Math.round(n * 2) / 2;
const BULLET = /^\s*([•●○◦▪▫■□‣⁃∙·\u2013\u2014*+-])\s+/;
const NUMBERED = /^\s*(\d{1,3}|[a-z]|[ivx]{1,4})([.)])\s+/;
/** A cell that's only a list marker: "•", "3", "3.", "c)". Set apart by a gap, a bare number counts too. */
const MARKER_CELL = /^([•●○◦▪▫■□‣⁃∙·\u2013\u2014*+-]|\d{1,3}[.)]?|[a-z][.)]|[ivx]{1,4}[.)])$/;

/** "1  Open the file" with a gap after the number: a list item even without "1.". */
const markerLine = (l: Line) => l.cells.length === 2 && MARKER_CELL.test(l.cells[0]);

function measure(pages: Line[][]): Stats {
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

function renderPage(lines: Line[], stats: Stats): Block[] {
  const blocks: Block[] = [];
  let para: Line[] = [];
  let item: { marker: string; indent: number; lines: Line[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push(paragraph(para, stats));
    para = [];
  };
  const flushItem = () => {
    if (item) blocks.push({ kind: "li", md: `${item.marker} ${inline(joinRuns(item.lines, stats, true))}` });
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
      blocks.push({ kind: "table", md: table });
      prev = null;
      continue;
    }
    if (tables.has(-i)) continue; // a row of a table already written
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
      // A heading that wrapped onto a second line continues the same heading.
      const before = blocks[blocks.length - 1];
      const last = before?.kind === "h" ? before : null;
      const md = escapeText(line.text.trim());
      // ...but only if the line before really wrapped: wide, and this one starts where it did.
      const wrapped =
        lastHeading !== null &&
        lastHeading.end - lastHeading.start >= stats.fullWidth * 0.6 &&
        Math.abs(lastHeading.start - line.start) < line.size;
      if (last && wrapped && !line.paraBreak && last.md.startsWith(`${"#".repeat(level)} `)) last.md += ` ${md}`;
      else blocks.push({ kind: "h", md: `${"#".repeat(level)} ${md}` });
      lastHeading = line;
      continue;
    }

    if (bullet || numbered) {
      flushPara();
      flushItem();
      const match = (bullet || numbered) as RegExpMatchArray;
      const marker: string = bullet ? "-" : `${/^\d+$/.test(match[1]) ? match[1] : "1"}.`;
      item = { marker, indent: line.start, lines: [stripMarker(line, match[0].length)] };
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
 * Returns the Markdown for each table keyed by its first line's index, and
 * the other rows keyed by their negated index so they're skipped.
 */
function findTables(lines: Line[]): Map<number, string> {
  const out = new Map<number, string>();
  let i = 0;
  const columns = (l: Line) => (markerLine(l) ? 1 : l.cells.length);
  while (i < lines.length) {
    const n = columns(lines[i]);
    let j = i + 1;
    while (n >= 2 && j < lines.length && columns(lines[j]) === n) j++;
    if (n >= 2 && j - i >= 2) {
      const cell = (c: string) => escapeText(c).replace(/\|/g, "\\|");
      const rows = lines.slice(i, j).map((l) => `| ${l.cells.map(cell).join(" | ")} |`);
      rows.splice(1, 0, `|${" --- |".repeat(n)}`);
      out.set(i, rows.join("\n"));
      for (let k = i + 1; k < j; k++) out.set(-k, "");
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

function paragraph(lines: Line[], stats: Stats): Block {
  const md = inline(joinRuns(lines, stats, false));
  const last = lines[lines.length - 1];
  return { kind: "p", md: escapeStart(md), openEnd: isFull(last, stats) };
}

const isFull = (l: Line, stats: Stats) => l.end - l.start >= stats.fullWidth * 0.65;

/**
 * One paragraph's runs, with line breaks resolved: wrapped lines are joined
 * (a trailing hyphen joins without a space and stays), short lines end in a
 * Markdown hard break so the line structure survives.
 */
function joinRuns(lines: Line[], stats: Stats, alwaysJoin: boolean): Run[] {
  const runs: Run[] = [];
  lines.forEach((line, i) => {
    if (i > 0) {
      const prev = lines[i - 1];
      const hyphen = /\p{L}-$/u.test(prev.text) && /^\p{L}/u.test(line.text);
      const columns = prev.cells.length > 1 || line.cells.length > 1;
      const sep = alwaysJoin || (isFull(prev, stats) && !columns) ? (hyphen ? "" : " ") : "  \n";
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

/** Runs to Markdown text, wrapping bold and italic stretches. */
function inline(runs: Run[]): string {
  // Spaces carry no style: hand them to the neighbor so "**a** **b**" becomes "**a b**".
  const merged: Run[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.bold === r.bold && prev.italic === r.italic) prev.text += r.text;
    else if (prev && !r.text.trim() && !r.text.includes("\n")) prev.text += r.text;
    else merged.push({ ...r });
  }
  return merged
    .map((r) => {
      const text = escapeText(r.text);
      const m = (r.bold ? "**" : "") + (r.italic ? "*" : "");
      if (!m || !text.trim()) return text;
      // Markers must hug the words: "** x **" doesn't render.
      const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      return `${lead}${m}${core}${[...m].reverse().join("")}${trail}`;
    })
    .join("");
}

/** Escape characters Markdown would read as formatting. */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]<>]/g, "\\$&")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"));
}

/** Escape a paragraph start that would otherwise read as a heading, list or quote. */
function escapeStart(md: string): string {
  return md.replace(/^(#{1,6}\s|>|[-+]\s|=+\s*$)/, "\\$1").replace(/^(\d+)([.)]\s)/, "$1\\$2");
}
