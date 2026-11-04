import JSZip from "jszip";
import { Marked } from "marked";
import { cssName, fromSymbolFont, LINE, loadFamilies, mapFont, ourFamily, SYMBOL_FONT, type Family } from "./docfonts";

/**
 * Lay a document out in the page, offscreen, ready to be measured and drawn
 * into a PDF (see docrender.ts). Word files are laid out by docx-preview;
 * Markdown and plain text by the browser with a simple page style.
 *
 * Before anything is laid out, every font the document asks for is swapped
 * for one of ours (see docfonts.ts), so the measurements match what's drawn.
 */

export type Paper = "letter" | "a4";
export type Kind = "docx" | "markdown" | "text";

export const PAPER: Record<Paper, { w: number; h: number }> = {
  letter: { w: 612, h: 792 },
  a4: { w: 595.28, h: 841.89 },
};

/** Page-number fields in headers and footers, marked so each page can fill in its own. */
export const FIELD_PAGE = "\ue000";
export const FIELD_PAGES = "\ue001";

export interface Laid {
  host: HTMLElement;
  /** One element per page or run of pages; each is as wide as the page and at least as tall. */
  sections: HTMLElement[];
  /**
   * For Word files whose first page has its own header or footer: the same
   * sections laid out with the ordinary header and footer, for the pages
   * after the first.
   */
  later: HTMLElement[] | null;
  dispose(): void;
}

export class UnsupportedFile extends Error {}

export function documentKind(file: File): Kind | null {
  const n = file.name.toLowerCase();
  if (n.endsWith(".docx") || n.endsWith(".docm") || n.endsWith(".dotx")) return "docx";
  if (/\.(md|markdown|mdown|mkd)$/.test(n)) return "markdown";
  if (n.endsWith(".txt") || n.endsWith(".text") || n.endsWith(".log") || n.endsWith(".csv")) return "text";
  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (file.type === "text/markdown") return "markdown";
  if (file.type === "text/plain") return "text";
  return null;
}

/** Why a file can't be converted, in words for the person. */
export function unsupportedReason(file: File): string {
  const n = file.name.toLowerCase();
  if (n.endsWith(".doc")) return "Old Word files (.doc) aren't supported. Open it in Word and save it as .docx first.";
  if (n.endsWith(".odt")) return "OpenDocument files (.odt) aren't supported. Save it as .docx first.";
  if (n.endsWith(".rtf")) return "RTF files aren't supported. Save it as .docx first.";
  if (n.endsWith(".pages")) return "Pages files aren't supported. In Pages, export it as Word (.docx) first.";
  return "Choose a Word (.docx), Markdown (.md) or text (.txt) file.";
}

const CLASS = "hpdfdoc";

export async function layOut(file: File, kind: Kind, paper: Paper): Promise<Laid> {
  const host = document.createElement("div");
  host.className = "doc-render-host";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  const dispose = () => host.remove();
  try {
    if (kind === "docx") return { ...(await layOutDocx(file, host)), host, dispose };
    const families: Family[] = kind === "markdown" ? ["Carlito", "Cousine"] : ["Cousine"];
    await loadFamilies(families);
    const text = await file.text();
    const section = textSection(text, kind, paper);
    host.append(section);
    return { host, sections: [section], later: null, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

// ------------------------------------------------------------------- Word

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function layOutDocx(
  file: File,
  host: HTMLElement,
): Promise<{ sections: HTMLElement[]; later: HTMLElement[] | null }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new UnsupportedFile("This file isn't a Word document, or it's damaged.");
  }
  if (!zip.file("word/document.xml")) throw new UnsupportedFile("This file isn't a Word document, or it's damaged.");

  const families = new Set<Family>(["Carlito"]);
  const contextual = contextualStyles(await zip.file("word/styles.xml")?.async("string"));
  const parts = Object.keys(zip.files).filter((n) => /^word\/.*\.xml$/.test(n) && !zip.files[n].dir);
  let titlePage = false;
  for (const name of parts) {
    let xml = await zip.file(name)!.async("string");
    xml = swapFonts(xml, families);
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) xml = markPageFields(xml);
    if (name === "word/document.xml") titlePage = /<w:titlePg(?:\s*\/>|\s+w:val="(?:1|true|on)")/.test(xml);
    zip.file(name, xml);
  }

  const { renderAsync } = await import("docx-preview");
  await loadFamilies(families);

  const render = async (blob: Blob) => {
    const style = document.createElement("div");
    const body = document.createElement("div");
    body.className = "doc-render-body";
    host.append(style, body);
    await renderAsync(blob, body, style, {
      className: CLASS,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true, // tab stops
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
      useBase64URL: false,
      ignoreFonts: true, // fonts embedded in the file would undo the swap
    });
    // Word's line spacing counts in lines of the font, not font sizes: see LINE.
    for (const el of style.querySelectorAll("style")) el.textContent = scaleLineHeights(el.textContent ?? "");
    const sections = [...body.querySelectorAll<HTMLElement>(`section.${CLASS}`)];
    // Done before docx-preview places tab stops (half a second after rendering), so they see the final layout.
    for (const s of sections) {
      // Word's defaults for a file that doesn't say: Letter, one-inch margins.
      if (!s.style.width) s.style.width = "612pt";
      if (!s.style.minHeight) s.style.minHeight = "792pt";
      if (!s.style.padding) s.style.padding = "72pt";
      finishSection(s, contextual);
    }
    return sections;
  };

  const sections = await render(await zip.generateAsync({ type: "blob" }));
  let later: HTMLElement[] | null = null;
  if (titlePage) {
    // Same document without "different first page", for the headers of the pages after it.
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace(/<w:titlePg(?:\s+w:val="[^"]*")?\s*\/>/g, ""));
    later = await render(await zip.generateAsync({ type: "blob" }));
  }
  if (host.querySelector(`.${CLASS}-tab-stop`)) {
    // docx-preview positions tab stops half a second after rendering.
    await new Promise((r) => setTimeout(r, 650));
  }
  return { sections, later };
}

/** Class names (as docx-preview writes them) of paragraph styles with contextual spacing, inherited ones included. */
function contextualStyles(xml: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const styles = new Map<string, { basedOn: string | null; own: boolean | null }>();
  for (const st of doc.getElementsByTagNameNS(W, "style")) {
    const id = st.getAttributeNS(W, "styleId") ?? st.getAttribute("w:styleId");
    if (!id) continue;
    const based = st.getElementsByTagNameNS(W, "basedOn")[0];
    const cs = st.getElementsByTagNameNS(W, "contextualSpacing")[0];
    const val = cs ? (cs.getAttributeNS(W, "val") ?? cs.getAttribute("w:val")) : null;
    styles.set(id, {
      basedOn: based ? (based.getAttributeNS(W, "val") ?? based.getAttribute("w:val")) : null,
      own: cs ? !/^(0|false|off)$/i.test(val ?? "") : null,
    });
  }
  for (const id of styles.keys()) {
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 20; depth++) {
      const st = styles.get(cur);
      if (!st) break;
      if (st.own !== null) {
        if (st.own) out.add(`${CLASS}_${id.replace(/[ .]+/g, "-").replace(/[&]+/g, "and").toLowerCase()}`);
        break;
      }
      cur = st.basedOn;
    }
  }
  return out;
}

/** Unitless line heights from docx-preview ("1.15"), as Word means them: lines of the font in use. */
function scaleLineHeights(css: string): string {
  return css.replace(
    /line-height:\s*([\d.]+)\s*(;|})/g,
    (_, n, end) => `line-height: calc(${n} * var(--hpdf-line, 1.2))${end}`,
  );
}

/** Swap every font the document names for the closest of ours. */
function swapFonts(xml: string, used: Set<Family>): string {
  const swap = (name: string) => {
    if (SYMBOL_FONT.test(name)) return name;
    const f = mapFont(name);
    used.add(f);
    return cssName(f);
  };
  return xml
    .replace(/(w:(?:ascii|hAnsi|cs|eastAsia)=")([^"]*)(")/g, (_, a, name, b) => a + swap(name) + b)
    .replace(/(<a:(?:latin|ea|cs|font)\b[^>]*?\btypeface=")([^"]*)(")/g, (_, a, name, b) =>
      name ? a + swap(name) + b : a + name + b,
    )
    .replace(/(<w:font\s+w:name=")([^"]*)(")/g, (_, a, name, b) => a + swap(name) + b);
}

/**
 * Replace the shown result of PAGE and NUMPAGES fields with a marker, so
 * each page can draw its own number. Handles simple fields and the
 * begin/separate/end kind.
 */
function markPageFields(xml: string): string {
  if (!/PAGE/.test(xml)) return xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return xml;
  const kind = (instr: string) => {
    const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instr);
    return m ? (m[1].toUpperCase() === "PAGE" ? FIELD_PAGE : FIELD_PAGES) : null;
  };
  const fill = (texts: Element[], marker: string) => {
    texts.forEach((t, i) => (t.textContent = i === 0 ? marker : ""));
  };

  for (const fld of [...doc.getElementsByTagNameNS(W, "fldSimple")]) {
    const marker = kind(fld.getAttributeNS(W, "instr") ?? fld.getAttribute("w:instr") ?? "");
    if (marker) fill([...fld.getElementsByTagNameNS(W, "t")], marker);
  }

  let depth = 0;
  let instr = "";
  let marker: string | null = null;
  let texts: Element[] = [];
  for (const el of [...doc.getElementsByTagNameNS(W, "*")]) {
    if (el.localName === "fldChar") {
      const type = el.getAttributeNS(W, "fldCharType") ?? el.getAttribute("w:fldCharType");
      if (type === "begin") {
        depth += 1;
        if (depth === 1) instr = "";
      } else if (type === "separate" && depth === 1) {
        marker = kind(instr);
        texts = [];
      } else if (type === "end") {
        if (depth === 1 && marker) fill(texts, marker);
        if (depth === 1) marker = null;
        depth = Math.max(0, depth - 1);
      }
    } else if (el.localName === "instrText" && depth === 1 && !marker) {
      instr += el.textContent ?? "";
    } else if (el.localName === "t" && depth === 1 && marker) {
      texts.push(el);
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Tidy a laid-out page so everything on it is plain text in our fonts:
 * - List numbers and bullets, which docx-preview draws with CSS counters,
 *   become real text (CSS-generated text can't be measured or drawn).
 * - Symbol and Wingdings characters become their Unicode equivalents.
 * - Anything still in a font that isn't ours is moved to the closest one.
 * - Page-number markers get their own element, filled in per page.
 */
function finishSection(section: HTMLElement, contextual: Set<string>): void {
  const root = section.closest<HTMLElement>(`.${CLASS}-wrapper`) ?? section;
  materializeMarkers(section, root);

  // "Don't add space between paragraphs of the same style" (list items, mostly).
  for (const p of section.querySelectorAll<HTMLElement>("p")) {
    const style = [...p.classList].find((c) => contextual.has(c));
    const next = p.nextElementSibling as HTMLElement | null;
    if (style && next?.tagName === "P" && next.classList.contains(style)) {
      p.style.marginBottom = "0";
      next.style.marginTop = "0";
    }
  }

  // Word fills a footer from the bottom up, so its last line sits at the footer distance.
  const footer = section.querySelector<HTMLElement>(":scope > footer");
  if (footer) {
    footer.style.display = "flex";
    footer.style.flexDirection = "column";
    footer.style.justifyContent = "flex-end";
  }

  const elements = [section, ...section.querySelectorAll<HTMLElement>("*")];
  for (const el of elements) {
    const cs = getComputedStyle(el);
    const first = cs.fontFamily.split(",")[0]?.trim() ?? "";
    let family = ourFamily(first);
    if (SYMBOL_FONT.test(first)) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) node.textContent = fromSymbolFont(node.textContent ?? "");
      }
      family = "Carlito";
      el.style.fontFamily = cssName(family);
    } else if (!family) {
      family = mapFont(first);
      el.style.fontFamily = cssName(family);
    }
    el.style.setProperty("--hpdf-line", String(LINE[family]));
    const lh = el.style.lineHeight;
    if (/^[\d.]+$/.test(lh)) el.style.lineHeight = `calc(${lh} * var(--hpdf-line, 1.2))`;
  }

  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const marked: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/[\ue000\ue001]/.test(n.textContent ?? "")) marked.push(n as Text);
  }
  for (const node of marked) {
    const parts = (node.textContent ?? "").split(/([\ue000\ue001])/);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part === FIELD_PAGE || part === FIELD_PAGES) {
        const span = document.createElement("span");
        span.className = "hpdf-field";
        span.dataset.field = part === FIELD_PAGE ? "page" : "pages";
        span.textContent = "1";
        frag.append(span);
      } else if (part) {
        frag.append(part);
      }
    }
    node.replaceWith(frag);
  }
}

/** Evaluate docx-preview's CSS list counters ourselves and write the markers into the text. */
function materializeMarkers(section: HTMLElement, root: HTMLElement): void {
  const counters =
    (root as HTMLElement & { _hpdfCounters?: Map<string, number> })._hpdfCounters ?? new Map<string, number>();
  (root as HTMLElement & { _hpdfCounters?: Map<string, number> })._hpdfCounters = counters;
  if (!root.dataset.hpdfCounted) {
    root.dataset.hpdfCounted = "1";
    applyCounters(getComputedStyle(root).counterReset, counters, "reset");
  }
  for (const el of section.querySelectorAll<HTMLElement>("p")) {
    const cs = getComputedStyle(el);
    applyCounters(cs.counterReset, counters, "reset");
    applyCounters(cs.counterSet, counters, "set");
    const before = getComputedStyle(el, "::before");
    const content = before.content;
    if (!content || content === "none" || content === "normal") continue;
    applyCounters(before.counterIncrement, counters, "increment");
    let text = evaluateContent(content, counters);
    if (!text.trim()) continue;

    const symbol = SYMBOL_FONT.test(before.fontFamily.split(",")[0]?.trim() ?? "");
    text = fromSymbolFont(text);
    const tab = /\t$/.test(text);
    text = text.replace(/[\t\u00a0 ]+$/, "");

    const marker = document.createElement("span");
    marker.className = "hpdf-marker";
    marker.textContent = text;
    if (!symbol) marker.style.fontFamily = before.fontFamily;
    marker.style.fontSize = before.fontSize;
    marker.style.fontWeight = before.fontWeight;
    marker.style.fontStyle = before.fontStyle;
    marker.style.color = before.color;
    // Word puts the text after the marker at the hanging indent (or the next tab stop).
    const indent = parseFloat(cs.textIndent) || 0;
    marker.style.display = "inline-block";
    marker.style.whiteSpace = "pre";
    marker.style.textIndent = "0";
    if (tab && indent < 0) marker.style.minWidth = `${-indent}px`;
    else marker.style.paddingRight = tab ? "1.6em" : "0.3em";
    el.classList.add("hpdf-no-marker");
    el.prepend(marker);
  }
}

function applyCounters(value: string, counters: Map<string, number>, how: "reset" | "set" | "increment"): void {
  if (!value || value === "none") return;
  const tokens = value.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    const next = Number(tokens[i + 1]);
    const n = Number.isFinite(next) && tokens[i + 1] !== undefined && /^-?\d+$/.test(tokens[i + 1]) ? next : null;
    if (n !== null) i++;
    if (how === "increment") counters.set(name, (counters.get(name) ?? 0) + (n ?? 1));
    else counters.set(name, n ?? 0);
  }
}

/** A computed `content` value like `"" counter(x, decimal) "."` as text. */
function evaluateContent(content: string, counters: Map<string, number>): string {
  let out = "";
  const re = /"((?:[^"\\]|\\.)*)"|counter\(\s*([^,)\s]+)\s*(?:,\s*([^)\s]+)\s*)?\)/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m[1] !== undefined) out += unescapeCss(m[1]);
    else out += formatCounter(counters.get(m[2]) ?? 0, m[3] ?? "decimal");
  }
  return out;
}

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch,
  );
}

function formatCounter(n: number, style: string): string {
  switch (style) {
    case "lower-alpha":
    case "lower-latin":
      return alpha(n).toLowerCase();
    case "upper-alpha":
    case "upper-latin":
      return alpha(n);
    case "lower-roman":
      return roman(n).toLowerCase();
    case "upper-roman":
      return roman(n);
    case "decimal-leading-zero":
      return n < 10 && n >= 0 ? `0${n}` : String(n);
    case "disc":
      return "\u2022";
    case "none":
      return "";
    default:
      return String(n);
  }
}

function alpha(n: number): string {
  if (n <= 0) return String(n);
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let s = "";
  for (const [v, r] of table) {
    while (n >= v) {
      s += r;
      n -= v;
    }
  }
  return s;
}

// ------------------------------------------------------- Markdown and text

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
  renderer: {
    // No raw HTML from the file: show it as text.
    html({ text }) {
      return escapeHtml(text);
    },
    // Only pictures embedded in the file itself; anything else can't load here.
    image({ href, text }) {
      return /^data:image\//i.test(href)
        ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`
        : escapeHtml(text ? `[${text}]` : "");
    },
  },
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textSection(text: string, kind: Exclude<Kind, "docx">, paper: Paper): HTMLElement {
  const { w, h } = PAPER[paper];
  const section = document.createElement("section");
  section.className = `doc-text-page ${kind === "markdown" ? "md" : "txt"}`;
  section.style.width = `${w}pt`;
  section.style.minHeight = `${h}pt`;
  section.style.padding = "72pt";
  const article = document.createElement("article");
  if (kind === "markdown") {
    article.innerHTML = md.parse(text.replace(/^\ufeff/, "")) as string;
    htmlListMarkers(article);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
    article.append(pre);
  }
  section.append(article);
  return section;
}

/** Bullets and numbers of HTML lists as real text (the browser's own markers can't be measured or drawn). */
function htmlListMarkers(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")) {
    box.replaceWith(box.checked ? "\u2611" : "\u2610");
  }
  for (const list of root.querySelectorAll<HTMLOListElement | HTMLUListElement>("ol, ul")) {
    const depth = [...ancestors(list)].filter((e) => e.tagName === "UL" || e.tagName === "OL").length;
    const ordered = list.tagName === "OL";
    let n = ordered ? Number(list.getAttribute("start") ?? 1) || 1 : 0;
    list.style.listStyle = "none";
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const marker = document.createElement("span");
      marker.className = "hpdf-marker";
      marker.textContent = ordered ? `${n++}.` : ["\u2022", "\u25e6", "\u25aa"][depth % 3];
      marker.style.cssText = "display:inline-block;width:20pt;margin-left:-20pt;text-indent:0";
      const first = li.firstElementChild;
      const target = first && first.tagName === "P" && li.firstChild === first ? first : li;
      target.prepend(marker);
    }
  }
}

function* ancestors(el: Element): Generator<Element> {
  for (let e = el.parentElement; e; e = e.parentElement) yield e;
}
