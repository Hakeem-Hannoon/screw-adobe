import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFString, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { cssName, faceBytes, faceKey, FAMILIES, ourFamily, type Face, type Family } from "./docfonts";
import type { Laid } from "./docsource";

/**
 * Draw laid-out document pages into a PDF with real, selectable text.
 *
 * The browser has already done the hard part (line breaking, justification,
 * tables, lists, tab stops) in fonts we also embed. This reads where every
 * word, picture, background and border ended up, splits each section into
 * pages, and draws them with pdf-lib.
 */

const PT = 0.75; // points per CSS pixel

type RGB = [number, number, number];

interface TextItem {
  x: number;
  y: number;
  h: number;
  /** Baseline, from the same origin as y. */
  base: number;
  text: string;
  face: Face;
  size: number;
  color: RGB;
  alpha: number;
  under: boolean;
  strike: boolean;
  /** Underlines run on to the next word when it belongs to the same underlined stretch. */
  decoKey: Element | null;
  endX: number;
  block: number;
  keep: boolean;
  table: boolean;
}

interface RectItem {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RGB;
  alpha: number;
}

interface ImageItem {
  x: number;
  y: number;
  w: number;
  h: number;
  el: HTMLImageElement;
}

interface LinkItem {
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

interface Items {
  texts: TextItem[];
  fills: RectItem[];
  borders: RectItem[];
  images: ImageItem[];
  links: LinkItem[];
}

export interface DocPdf {
  bytes: Uint8Array;
  pages: number;
  /** Characters none of our fonts can draw (like Chinese or Arabic), left out. */
  missing: number;
  /** Pictures in a format the browser can't show (like EMF), left out. */
  skippedImages: number;
}

/** Points per CSS pixel, so callers can talk in points. */
export const PX_TO_PT = PT;

export async function renderPdf(laid: Laid, onPage?: (n: number) => void): Promise<DocPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new FontSet(doc);
  const images = new ImageSet(doc);

  // Work out every section's page breaks first: page-count fields need the total.
  const plans = laid.sections.map((s) => planSection(s));
  const total = plans.reduce((n, p) => n + p.slices.length, 0);

  let pageNo = 0;
  for (const [si, plan] of plans.entries()) {
    for (const [k, slice] of plan.slices.entries()) {
      pageNo += 1;
      const page = doc.addPage([plan.w * PT, plan.h * PT]);
      // The first page of a section may have its own header and footer; later ones use the ordinary ones.
      const bands = k > 0 && laid.later?.[si] ? laid.later[si] : plan.section;
      const header = bands.querySelector<HTMLElement>(":scope > header");
      const footer = bands.querySelector<HTMLElement>(":scope > footer");
      const parts: { items: Items; dy: number }[] = [];
      if (header) parts.push({ items: bandItems(header, bands, pageNo, total, "top"), dy: 0 });
      // Anything above the first slice or below the last still belongs on a page.
      const from = k === 0 ? -Infinity : slice.start;
      const to = k === plan.slices.length - 1 ? Infinity : slice.end;
      parts.push({ items: clip(plan.body, from, to), dy: plan.contentTop - slice.start });
      if (footer) parts.push({ items: bandItems(footer, bands, pageNo, total, "bottom"), dy: plan.h });
      await drawPage(page, plan.h, parts, fonts, images);
      onPage?.(pageNo);
    }
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pages: total, missing: fonts.missing, skippedImages: images.skipped };
}

// --------------------------------------------------------------- planning

interface Plan {
  section: HTMLElement;
  w: number;
  h: number;
  /** Where body text starts on a page, from the top. */
  contentTop: number;
  body: Items;
  slices: { start: number; end: number }[];
}

function planSection(section: HTMLElement): Plan {
  const sr = section.getBoundingClientRect();
  const cs = getComputedStyle(section);
  const w = sr.width;
  const h = parseFloat(cs.minHeight) || w * (11 / 8.5);
  const article = section.querySelector<HTMLElement>(":scope > article") ?? section;
  const footer = section.querySelector<HTMLElement>(":scope > footer");
  const contentTop = Math.max(0, article.getBoundingClientRect().top - sr.top);
  let bodyBottom = h - (parseFloat(cs.paddingBottom) || 0);
  if (footer && footer.textContent?.trim()) {
    // A footer taller than the bottom margin pushes the body up, as in Word.
    bodyBottom = Math.min(bodyBottom, h - (sr.bottom - footer.getBoundingClientRect().top));
  }
  const bodyHeight = Math.max(h * 0.2, bodyBottom - contentTop);

  const body = collect(article, sr.left, sr.top);
  const slices = paginate(body, contentTop, bodyHeight);
  return { section, w, h, contentTop, body, slices };
}

/** Split body content into page-high slices, choosing break points between lines. */
function paginate(items: Items, top: number, height: number): { start: number; end: number }[] {
  // Things that mustn't be cut in half: lines of text and pictures.
  const atoms = [
    ...items.texts.map((t) => ({ y: t.y, bottom: t.y + t.h, block: t.block, keep: t.keep, table: t.table })),
    ...items.images.map((i) => ({ y: i.y, bottom: i.y + i.h, block: -1, keep: false, table: false })),
  ].sort((a, b) => a.y - b.y);
  const lastBottom = Math.max(
    top,
    ...atoms.map((a) => a.bottom),
    ...items.fills.map((r) => r.y + r.h),
    ...items.borders.map((r) => r.y + r.h),
  );

  // Lines of each block, by their top.
  const lines = new Map<number, number[]>();
  for (const a of atoms) {
    if (a.block < 0) continue;
    const list = lines.get(a.block) ?? [];
    if (!list.some((y) => Math.abs(y - a.y) < 2)) list.push(a.y);
    lines.set(a.block, list);
  }

  const slices: { start: number; end: number }[] = [];
  let start = top;
  for (let guard = 0; guard < 5000; guard++) {
    const limit = start + height;
    if (lastBottom <= limit + 0.5) {
      slices.push({ start, end: Math.max(limit, lastBottom) });
      break;
    }
    // The first line or picture that doesn't fit.
    let brk = Infinity;
    for (const a of atoms) {
      if (a.y >= start - 0.5 && a.bottom > limit + 0.5) brk = Math.min(brk, a.y);
    }
    if (!Number.isFinite(brk)) brk = limit; // only backgrounds and borders run on
    if (brk <= start + 1) brk = limit; // taller than a page: cut it

    brk = adjust(brk, start, atoms, lines);
    slices.push({ start, end: brk });
    start = brk;
  }
  return slices;
}

/** Move a page break up to keep headings with what follows and avoid lone lines. */
function adjust(
  brk: number,
  start: number,
  atoms: { y: number; bottom: number; block: number; keep: boolean; table: boolean }[],
  lines: Map<number, number[]>,
): number {
  const minStart = start + 1;
  for (let pass = 0; pass < 6; pass++) {
    const before = atoms.filter((a) => a.y < brk - 0.5 && a.y >= start - 0.5);
    if (!before.length) return brk;
    const lastY = Math.max(...before.map((a) => a.y));
    const last = before.filter((a) => Math.abs(a.y - lastY) < 2);
    const after = atoms.find((a) => a.y >= brk - 0.5);

    // A heading at the bottom of a page goes over with what follows it.
    const heading = last.find((a) => a.keep);
    if (heading) {
      const top = Math.min(...(lines.get(heading.block) ?? [heading.y]));
      if (top > minStart) {
        brk = top;
        continue;
      }
    }
    // Widows and orphans, for ordinary paragraphs.
    if (after && after.block >= 0 && !after.table && last.some((a) => a.block === after.block)) {
      const ys = [...(lines.get(after.block) ?? [])].sort((a, b) => a - b);
      const above = ys.filter((y) => y < brk - 0.5).length;
      const below = ys.length - above;
      if (above === 1 && ys[0] > minStart) {
        brk = ys[0]; // one line left behind: take it along
        continue;
      }
      if (below === 1 && above >= 3) {
        brk = ys[above - 1]; // one line alone at the top of the next page: bring a line with it
        continue;
      }
    }
    return brk;
  }
  return brk;
}

/** The items within a slice of the body; backgrounds and borders are cut at its edges. */
function clip(items: Items, start: number, end: number): Items {
  const inside = (y: number) => y >= start - 0.5 && y < end - 0.5;
  const cut = (r: RectItem): RectItem | null => {
    const y0 = Math.max(r.y, start);
    const y1 = Math.min(r.y + r.h, end);
    return y1 - y0 > 0.01 ? { ...r, y: y0, h: y1 - y0 } : null;
  };
  return {
    // Text goes by its baseline: a big first letter can poke above where its line starts.
    texts: items.texts.filter((t) => inside(t.base - t.size * 0.5)),
    images: items.images.filter((i) => inside(i.y)),
    links: items.links.filter((l) => inside(l.y)),
    fills: items.fills.map(cut).filter((r): r is RectItem => r !== null),
    borders: items.borders.map(cut).filter((r): r is RectItem => r !== null),
  };
}

/** A header or footer with this page's numbers in it, measured from the page's top or bottom edge. */
function bandItems(
  band: HTMLElement,
  section: HTMLElement,
  page: number,
  total: number,
  edge: "top" | "bottom",
): Items {
  for (const f of band.querySelectorAll<HTMLElement>(".hpdf-field")) {
    f.textContent = String(f.dataset.field === "pages" ? total : page);
  }
  const sr = section.getBoundingClientRect();
  return collect(band, sr.left, edge === "top" ? sr.top : sr.bottom);
}

// -------------------------------------------------------------- measuring

let blockIds = new WeakMap<Element, number>();
let nextBlock = 0;
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, figcaption, dt, dd, div, article";

function blockOf(el: Element): { id: number; keep: boolean; table: boolean } {
  const block = el.closest(BLOCK) ?? el;
  let id = blockIds.get(block);
  if (id === undefined) {
    id = nextBlock++;
    blockIds.set(block, id);
  }
  const keep = /^H[1-6]$/.test(block.tagName) || /(^|[_-])(heading\d|title|subtitle)\b/i.test(block.className);
  return { id, keep, table: block.closest("td, th") !== null };
}

function parseColor(c: string): { rgb: RGB; alpha: number } | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(c);
  if (!m) return null;
  let alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (!(alpha > 0)) return null;
  alpha = Math.min(1, alpha);
  return { rgb: [+m[1] / 255, +m[2] / 255, +m[3] / 255], alpha };
}

const baselineCache = new Map<string, number>();

/** Where the baseline sits below the top of a text box, as a share of the font size. */
function baselineRatio(face: Face): number {
  const key = faceKey(face);
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:-40000px;top:0;font-size:100px;line-height:normal;white-space:nowrap;font-kerning:none";
  probe.style.fontFamily = cssName(face.family);
  probe.style.fontWeight = face.bold ? "700" : "400";
  probe.style.fontStyle = face.italic ? "italic" : "normal";
  const text = document.createTextNode("Hxg");
  const mark = document.createElement("span");
  mark.style.cssText = "display:inline-block;width:1px;height:0;vertical-align:baseline";
  probe.append(text, mark);
  document.body.append(probe);
  const range = document.createRange();
  range.selectNodeContents(text);
  const ratio = (mark.getBoundingClientRect().bottom - range.getBoundingClientRect().top) / 100;
  probe.remove();
  const value = Number.isFinite(ratio) && ratio > 0.3 && ratio < 1.5 ? ratio : 0.9;
  baselineCache.set(key, value);
  return value;
}

/** Everything drawn inside `root`, in pixels from (ox, oy). */
function collect(root: HTMLElement, ox: number, oy: number): Items {
  blockIds = new WeakMap();
  nextBlock = 0;
  const items: Items = { texts: [], fills: [], borders: [], images: [], links: [] };
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };

  // Backgrounds, borders, pictures and links.
  const elements = [root, ...root.querySelectorAll<HTMLElement>("*")];
  for (const el of elements) {
    const cs = style(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const bg = parseColor(cs.backgroundColor);
    if (bg) {
      const rects = cs.display === "inline" ? [...el.getClientRects()] : [el.getBoundingClientRect()];
      for (const r of rects) {
        if (r.width > 0.1 && r.height > 0.1) {
          items.fills.push({ x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, color: bg.rgb, alpha: bg.alpha });
        }
      }
    }
    if (cs.display !== "inline") borders(el, cs, ox, oy, items.borders);
    if (el instanceof HTMLImageElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0.5 && r.height > 0.5)
        items.images.push({ x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, el });
    }
    if (el instanceof HTMLAnchorElement && /^(https?:|mailto:)/i.test(el.getAttribute("href") ?? "")) {
      for (const r of el.getClientRects()) {
        items.links.push({ x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, url: el.href });
      }
    }
  }

  // Text, a word at a time, so justified and tabbed lines land exactly.
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent) continue;
    const cs = style(parent);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const color = parseColor(cs.color);
    if (!color) continue;
    const family: Family = ourFamily(cs.fontFamily.split(",")[0] ?? "") ?? "Carlito";
    const face: Face = {
      family,
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
      italic: cs.fontStyle === "italic" || cs.fontStyle.startsWith("oblique"),
    };
    const size = parseFloat(cs.fontSize) || 16;
    const ratio = baselineRatio(face);
    const { under, strike, deco } = decorations(parent, root, style);
    const block = blockOf(parent);
    const transform = cs.textTransform;

    const data = node.data;
    const re = /\S+/g;
    for (let m = re.exec(data); m; m = re.exec(data)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
      if (!rects.length) continue;
      const pieces: { text: string; r: DOMRect }[] = [];
      if (rects.length === 1) {
        pieces.push({ text: m[0], r: rects[0] });
      } else {
        // The word was broken across lines: place it a character at a time.
        let i = 0;
        for (const ch of m[0]) {
          range.setStart(node, m.index + i);
          range.setEnd(node, m.index + i + ch.length);
          const r = range.getClientRects()[0];
          if (r) pieces.push({ text: ch, r });
          i += ch.length;
        }
      }
      for (const { text, r } of pieces) {
        items.texts.push({
          x: r.left - ox,
          y: r.top - oy,
          h: r.height,
          base: r.top - oy + ratio * size,
          text: transformText(text, transform),
          face,
          size,
          color: color.rgb,
          alpha: color.alpha,
          under,
          strike,
          decoKey: deco,
          endX: r.right - ox,
          block: block.id,
          keep: block.keep,
          table: block.table,
        });
      }
    }
  }
  return items;
}

function transformText(text: string, transform: string): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") return text.replace(/^\p{L}/u, (c) => c.toUpperCase());
  return text;
}

/** Underline and strike-through from the element or its inline ancestors (decorations aren't inherited in computed style). */
function decorations(
  el: Element,
  root: Element,
  style: (el: Element) => CSSStyleDeclaration,
): { under: boolean; strike: boolean; deco: Element | null } {
  let under = false;
  let strike = false;
  let deco: Element | null = null;
  for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) {
    const line = style(e).textDecorationLine;
    if (line.includes("underline") && !under) {
      under = true;
      deco ??= e;
    }
    if (line.includes("line-through") && !strike) {
      strike = true;
      deco ??= e;
    }
    if (style(e).display !== "inline" && e !== el) break;
  }
  return { under, strike, deco };
}

function borders(el: Element, cs: CSSStyleDeclaration, ox: number, oy: number, out: RectItem[]): void {
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  let r: DOMRect | null = null;
  for (const side of sides) {
    const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
    const styleName = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
    if (!(width > 0) || styleName === "none" || styleName === "hidden") continue;
    const color = parseColor(cs.getPropertyValue(`border-${side.toLowerCase()}-color`));
    if (!color) continue;
    r ??= el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;
    const x = r.left - ox;
    const y = r.top - oy;
    const box =
      side === "Top"
        ? { x, y, w: r.width, h: width }
        : side === "Bottom"
          ? { x, y: y + r.height - width, w: r.width, h: width }
          : side === "Left"
            ? { x, y, w: width, h: r.height }
            : { x: x + r.width - width, y, w: width, h: r.height };
    out.push({ ...box, color: color.rgb, alpha: color.alpha });
  }
}

// ---------------------------------------------------------------- drawing

async function drawPage(
  page: PDFPage,
  height: number,
  parts: { items: Items; dy: number }[],
  fonts: FontSet,
  images: ImageSet,
): Promise<void> {
  const H = height * PT;
  const rect = (r: RectItem, dy: number) =>
    page.drawRectangle({
      x: r.x * PT,
      y: H - (r.y + dy + r.h) * PT,
      width: r.w * PT,
      height: r.h * PT,
      color: rgb(...r.color),
      opacity: r.alpha,
    });

  // Backgrounds, then pictures, then borders, then text: how documents are usually stacked.
  for (const { items, dy } of parts) for (const r of items.fills) rect(r, dy);
  for (const { items, dy } of parts) {
    for (const img of items.images) {
      const embedded = await images.get(img.el);
      if (!embedded) continue;
      page.drawImage(embedded, {
        x: img.x * PT,
        y: H - (img.y + dy + img.h) * PT,
        width: img.w * PT,
        height: img.h * PT,
      });
    }
  }
  for (const { items, dy } of parts) for (const r of items.borders) rect(r, dy);

  for (const { items, dy } of parts) {
    const texts = items.texts;
    for (const [i, t] of texts.entries()) {
      const size = t.size * PT;
      const baseline = H - (t.base + dy) * PT;
      await fonts.draw(page, t.text, t.face, { x: t.x * PT, y: baseline, size, color: t.color, alpha: t.alpha });
      if (t.under || t.strike) {
        // Run the line on to the next word if it's part of the same underlined stretch on the same line.
        const next = texts[i + 1];
        const joined =
          next && next.decoKey === t.decoKey && t.decoKey && Math.abs(next.base - t.base) < 1 && next.x > t.x;
        const x1 = joined ? next.x : t.endX;
        const thick = Math.max(0.5, size * 0.06);
        const line = (yOff: number) =>
          page.drawRectangle({
            x: t.x * PT,
            y: baseline + yOff - thick / 2,
            width: Math.max(0, (x1 - t.x) * PT),
            height: thick,
            color: rgb(...t.color),
            opacity: t.alpha,
          });
        if (t.under) line(-size * 0.12);
        if (t.strike) line(size * 0.3);
      }
    }
    for (const l of items.links) {
      const y0 = H - (l.y + dy + l.h) * PT;
      const annot = page.doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [l.x * PT, y0, (l.x + l.w) * PT, y0 + l.h * PT],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(l.url) },
      });
      page.node.addAnnot(page.doc.context.register(annot));
    }
  }
}

/** Embedded fonts, each loaded once, with fallback to another of ours for characters a font lacks. */
class FontSet {
  missing = 0;
  private fonts = new Map<string, Promise<{ font: PDFFont; chars: Set<number> }>>();

  constructor(private doc: PDFDocument) {}

  private get(face: Face): Promise<{ font: PDFFont; chars: Set<number> }> {
    const key = faceKey(face);
    let p = this.fonts.get(key);
    if (!p) {
      p = faceBytes(face).then(async (bytes) => {
        const font = await this.doc.embedFont(bytes, {
          subset: true,
          // Match the page layout, which has kerning and ligatures off.
          features: { liga: false, clig: false, calt: false, kern: false, dlig: false },
        });
        return { font, chars: new Set(font.getCharacterSet()) };
      });
      this.fonts.set(key, p);
    }
    return p;
  }

  async draw(
    page: PDFPage,
    text: string,
    face: Face,
    o: { x: number; y: number; size: number; color: RGB; alpha: number },
  ): Promise<void> {
    const main = await this.get(face);
    // Split into stretches by which font can draw them.
    const runs: { text: string; font: PDFFont }[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let font: PDFFont | null = main.chars.has(cp) ? main.font : null;
      if (!font) {
        for (const family of FAMILIES) {
          if (family === face.family) continue;
          const alt = await this.get({ ...face, family });
          if (alt.chars.has(cp)) {
            font = alt.font;
            break;
          }
        }
      }
      if (!font) {
        if (!/\s|[\u200b-\u200f\u2060\ufeff\u00ad]/.test(ch)) this.missing += 1;
        continue;
      }
      const last = runs[runs.length - 1];
      if (last && last.font === font) last.text += ch;
      else runs.push({ text: ch, font });
    }
    let x = o.x;
    for (const r of runs) {
      page.drawText(r.text, { x, y: o.y, size: o.size, font: r.font, color: rgb(...o.color), opacity: o.alpha });
      x += r.font.widthOfTextAtSize(r.text, o.size);
    }
  }
}

/** Pictures, each embedded once. */
class ImageSet {
  skipped = 0;
  private cache = new Map<string, Promise<PDFImage | null>>();

  constructor(private doc: PDFDocument) {}

  get(el: HTMLImageElement): Promise<PDFImage | null> {
    const src = el.currentSrc || el.src;
    let p = this.cache.get(src);
    if (!p) {
      p = this.load(el, src).catch((err) => {
        console.error(err);
        this.skipped += 1;
        return null;
      });
      this.cache.set(src, p);
    }
    return p;
  }

  private async load(el: HTMLImageElement, src: string): Promise<PDFImage | null> {
    if (!el.complete) await el.decode().catch(() => undefined);
    if (!el.naturalWidth) {
      this.skipped += 1;
      return null;
    }
    const blob = await (await fetch(src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      try {
        return await this.doc.embedJpg(bytes);
      } catch {
        // CMYK and other JPEGs pdf-lib can't take: redraw below.
      }
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      try {
        return await this.doc.embedPng(bytes);
      } catch {
        // Fall through to a redraw.
      }
    }
    // GIF, WebP, BMP, SVG...: draw it and keep that.
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 3000 / Math.max(el.naturalWidth, el.naturalHeight));
    canvas.width = Math.max(1, Math.round(el.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(el.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(el, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!png) return null;
    return this.doc.embedPng(new Uint8Array(await png.arrayBuffer()));
  }
}
