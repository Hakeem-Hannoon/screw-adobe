import type { Line, Run } from "./extract";
import { measure, pageBlocks, type Block } from "./structure";

/**
 * Turn laid-out pages into Markdown. The structure (headings, lists, tables,
 * paragraphs) comes from structure.ts; this writes it out:
 * - Headings get "#", "##" or "###" by level.
 * - Bold and italic text is wrapped in ** and *.
 * - Short lines in a paragraph end in a Markdown hard break.
 */
export function toMarkdown(pages: Line[][], opts: { labels: boolean }): string {
  const stats = measure(pages);
  const rendered = pages.map((lines) => pageBlocks(lines, stats).map(render));

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
  const out: MdBlock[] = [];
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

interface MdBlock {
  kind: Block["kind"];
  md: string;
  openEnd?: boolean;
}

function render(b: Block): MdBlock {
  switch (b.kind) {
    case "h":
      return { kind: "h", md: `${"#".repeat(b.level)} ${escapeText(b.text)}` };
    case "li":
      return { kind: "li", md: `${b.number === null ? "-" : `${b.number}.`} ${inline(b.runs)}` };
    case "p":
      return { kind: "p", md: escapeStart(inline(b.runs)), openEnd: b.openEnd };
    case "table": {
      const cell = (c: string) => escapeText(c).replace(/\|/g, "\\|");
      const rows = b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
      rows.splice(1, 0, `|${" --- |".repeat(b.rows[0].length)}`);
      return { kind: "table", md: rows.join("\n") };
    }
  }
}

/** Blank lines between blocks, except between items of the same list. */
function joinBlocks(blocks: MdBlock[]): string {
  return blocks
    .map((b, i) => (i === 0 ? "" : b.kind === "li" && blocks[i - 1].kind === "li" ? "\n" : "\n\n") + b.md)
    .join("");
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
