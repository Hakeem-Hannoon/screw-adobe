import type { Run } from "./extract";
import type { Block } from "./structure";
import { zip, type ZipEntry } from "./zip";

/**
 * A small Word (.docx) writer: headings, paragraphs with bold and italic,
 * bulleted and numbered lists, tables, pictures, page breaks, and a header
 * and footer with a live page number. Just enough OOXML for Word, Google
 * Docs, Pages and LibreOffice to open it as an ordinary, editable document.
 *
 * Nothing about where it came from is written: no author, no dates, no app
 * name (there's no docProps part at all).
 */

export interface DocxImage {
  data: Uint8Array;
  type: "png" | "jpeg";
  /** Size on the page, in points. */
  w: number;
  h: number;
}

export type DocxBlock = Block | { kind: "img"; image: DocxImage } | { kind: "break" };

export type Align = "left" | "center" | "right";

export interface HeaderLine {
  /** Text with "#" where the page number goes. */
  text: string;
  align: Align;
}

export interface DocxModel {
  /** Page size in points. */
  page: { w: number; h: number };
  /** Page margin in points. */
  margin: number;
  /** Body text size in points. */
  body: number;
  /** Sizes for heading levels 1-3, in points. */
  headings: number[];
  blocks: DocxBlock[];
  header: HeaderLine[];
  footer: HeaderLine[];
}

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(" ");
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU = 12700; // per point
const TWIP = 20; // per point

/** Text safe for XML: escaped, and without the control characters XML 1.0 forbids. */
function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const t = (text: string) => `<w:t xml:space="preserve">${esc(text)}</w:t>`;
const halfPoints = (pt: number) => Math.max(2, Math.round(pt * 2));

function runXml(run: Run): string {
  // A "\n" in a run is a line break; spaces just before it are dropped.
  const parts = run.text.split("\n");
  const rPr = run.bold || run.italic ? `<w:rPr>${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}</w:rPr>` : "";
  return parts
    .map((part, i) => {
      const text = i < parts.length - 1 ? part.replace(/[ \t]+$/, "") : part;
      return (text ? `<w:r>${rPr}${t(text)}</w:r>` : "") + (i < parts.length - 1 ? "<w:r><w:br/></w:r>" : "");
    })
    .join("");
}

function runsXml(runs: Run[]): string {
  // Trim the paragraph's ends: Word shows leading spaces.
  const out = runs.map((r) => ({ ...r }));
  while (out.length && !out[0].text.trim()) out.shift();
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, "");
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  }
  return out.map(runXml).join("");
}

interface Ctx {
  images: { id: string; file: string; data: Uint8Array }[];
  /** numId of each ordered list, with where it starts. */
  lists: { numId: number; start: number }[];
  pictures: number;
  contentWidth: number;
  contentHeight: number;
}

function imageXml(image: DocxImage, ctx: Ctx): string {
  const n = ctx.images.length + 1;
  const id = `rIdImg${n}`;
  const file = `image${n}.${image.type === "png" ? "png" : "jpeg"}`;
  ctx.images.push({ id, file, data: image.data });
  // Shrink to fit inside the margins, never enlarge.
  const fit = Math.min(1, ctx.contentWidth / image.w, ctx.contentHeight / image.h);
  const cx = Math.max(1, Math.round(image.w * fit * EMU));
  const cy = Math.max(1, Math.round(image.h * fit * EMU));
  ctx.pictures += 1;
  const pid = ctx.pictures;
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pid}" name="Picture ${pid}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${pid}" name="${file}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function tableXml(rows: string[][], ctx: Ctx): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor((ctx.contentWidth * TWIP) / cols);
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`;
  const body = rows
    .map(
      (row) =>
        `<w:tr>${Array.from({ length: cols }, (_, i) => {
          const text = row[i] ?? "";
          return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${
            text ? `<w:r>${t(text)}</w:r>` : ""
          }</w:p></w:tc>`;
        }).join("")}</w:tr>`,
    )
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>` +
    `</w:tblPr>${grid}${body}</w:tbl>`
  );
}

function bodyXml(blocks: DocxBlock[], ctx: Ctx): string {
  const out: string[] = [];
  let ordered: { numId: number } | null = null;
  let breakBefore = false;
  const pPr = (inner: string) => {
    const brk = breakBefore ? "<w:pageBreakBefore/>" : "";
    breakBefore = false;
    return inner || brk ? `<w:pPr>${inner.replace("<!--brk-->", brk) || brk}</w:pPr>` : "";
  };

  for (const block of blocks) {
    if (block.kind !== "li" || block.number === null) ordered = null;
    switch (block.kind) {
      case "break":
        breakBefore = out.length > 0;
        break;
      case "h":
        out.push(`<w:p>${pPr(`<w:pStyle w:val="Heading${block.level}"/><!--brk-->`)}<w:r>${t(block.text)}</w:r></w:p>`);
        break;
      case "p":
        out.push(`<w:p>${pPr("")}${runsXml(block.runs)}</w:p>`);
        break;
      case "li": {
        let numId = 1; // bullets
        if (block.number !== null) {
          if (!ordered) {
            ordered = { numId: 2 + ctx.lists.length };
            ctx.lists.push({ numId: ordered.numId, start: block.number });
          }
          numId = ordered.numId;
        }
        out.push(
          `<w:p>${pPr(`<w:pStyle w:val="ListParagraph"/><!--brk--><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`)}${runsXml(block.runs)}</w:p>`,
        );
        break;
      }
      case "table":
        if (breakBefore) out.push(`<w:p>${pPr("")}</w:p>`);
        out.push(tableXml(block.rows, ctx));
        break;
      case "img":
        out.push(`<w:p>${pPr(`<!--brk--><w:jc w:val="center"/>`)}${imageXml(block.image, ctx)}</w:p>`);
        break;
    }
  }
  // The body has to end with a paragraph, and a table can't be last.
  if (!out.length || out[out.length - 1].startsWith("<w:tbl>")) out.push("<w:p/>");
  return out.join("");
}

/** A header or footer line, with "#" as a live page number. */
function headerParagraph(line: HeaderLine): string {
  const parts = line.text.split("#");
  const runs = parts
    .map(
      (part, i) =>
        (part ? `<w:r>${t(part)}</w:r>` : "") +
        (i < parts.length - 1
          ? `<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:noProof/></w:rPr>${t("1")}</w:r></w:fldSimple>`
          : ""),
    )
    .join("");
  return `<w:p><w:pPr><w:jc w:val="${line.align}"/></w:pPr>${runs}</w:p>`;
}

function stylesXml(model: DocxModel): string {
  const [h1, h2, h3] = [0, 1, 2].map((i) => halfPoints(model.headings[i] ?? model.body * (1.6 - i * 0.2)));
  const heading = (n: number, sz: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>` +
    `<w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  const body = halfPoints(model.body);
  return (
    XML +
    `<w:styles ${NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>` +
    `<w:sz w:val="${body}"/><w:szCs w:val="${body}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading(1, h1) +
    heading(2, h2) +
    heading(3, h3) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>` +
    `<w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>` +
    `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>` +
    `<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>` +
    `<w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
      .join(
        "",
      )}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `</w:styles>`
  );
}

function numberingXml(lists: Ctx["lists"]): string {
  const level = (fmt: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  return (
    XML +
    `<w:numbering ${NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${level("bullet", "\u2022")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level("decimal", "%1.")}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    lists
      .map(
        (l) =>
          `<w:num w:numId="${l.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${l.start}"/></w:lvlOverride></w:num>`,
      )
      .join("") +
    `</w:numbering>`
  );
}

function sectPr(model: DocxModel, refs: { header: boolean; footer: boolean }): string {
  const w = Math.round(model.page.w * TWIP);
  const h = Math.round(model.page.h * TWIP);
  const m = Math.round(model.margin * TWIP);
  const edge = Math.round(Math.min(model.margin * 0.5, 36) * TWIP);
  return (
    `<w:sectPr>` +
    (refs.header ? `<w:headerReference w:type="default" r:id="rIdHeader"/>` : "") +
    (refs.footer ? `<w:footerReference w:type="default" r:id="rIdFooter"/>` : "") +
    `<w:pgSz w:w="${w}" w:h="${h}"${w > h ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="${edge}" w:footer="${edge}" w:gutter="0"/>` +
    `</w:sectPr>`
  );
}

const enc = new TextEncoder();

/** Build the .docx file. */
export function buildDocx(model: DocxModel): Blob {
  const ctx: Ctx = {
    images: [],
    lists: [],
    pictures: 0,
    contentWidth: model.page.w - model.margin * 2,
    contentHeight: model.page.h - model.margin * 2,
  };
  const body = bodyXml(model.blocks, ctx);
  const refs = { header: model.header.length > 0, footer: model.footer.length > 0 };
  const document = XML + `<w:document ${NS}><w:body>${body}${sectPr(model, refs)}</w:body></w:document>`;

  const rels = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
    ...(refs.header
      ? [
          `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`,
        ]
      : []),
    ...(refs.footer
      ? [
          `<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`,
        ]
      : []),
    ...ctx.images.map(
      (img) =>
        `<Relationship Id="${img.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.file}"/>`,
    ),
  ];

  const part = (name: string) =>
    `<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${name.replace(/\d+$/, "")}${
      name === "document" ? ".main" : ""
    }+xml"/>`;
  const contentTypes =
    XML +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    part("document") +
    part("styles") +
    part("numbering") +
    (refs.header ? part("header1") : "") +
    (refs.footer ? part("footer1") : "") +
    `</Types>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    {
      name: "_rels/.rels",
      data: enc.encode(
        XML +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
    },
    { name: "word/document.xml", data: enc.encode(document) },
    {
      name: "word/_rels/document.xml.rels",
      data: enc.encode(
        XML +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
      ),
    },
    { name: "word/styles.xml", data: enc.encode(stylesXml(model)) },
    { name: "word/numbering.xml", data: enc.encode(numberingXml(ctx.lists)) },
  ];
  const hf = (tag: "hdr" | "ftr", style: string, lines: HeaderLine[]) =>
    enc.encode(
      XML +
        `<w:${tag} ${NS}>${lines.map((l) => headerParagraph(l).replace("<w:pPr>", `<w:pPr><w:pStyle w:val="${style}"/>`)).join("")}</w:${tag}>`,
    );
  if (refs.header) entries.push({ name: "word/header1.xml", data: hf("hdr", "Header", model.header) });
  if (refs.footer) entries.push({ name: "word/footer1.xml", data: hf("ftr", "Footer", model.footer) });
  for (const img of ctx.images) entries.push({ name: `word/media/${img.file}`, data: img.data });

  const blob = zip(entries, new Date(1980, 0, 1));
  return new Blob([blob], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/**
 * A .docx that's a picture of each page: looks exactly like the PDF, but
 * nothing in it can be edited. Each page gets its own section the size of
 * the PDF page, with no margins.
 */
export function buildPictureDocx(pages: { image: DocxImage; w: number; h: number }[]): Blob {
  const ctx: Ctx = { images: [], lists: [], pictures: 0, contentWidth: 1e9, contentHeight: 1e9 };
  const sect = (w: number, h: number) =>
    `<w:sectPr><w:pgSz w:w="${Math.round(w * TWIP)}" w:h="${Math.round(h * TWIP)}"${w > h ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  const body = pages
    .map((p, i) => {
      // A hair smaller than the page, so the picture's line never spills onto a blank page.
      const image = { ...p.image, w: p.w - 1, h: p.h - 1 };
      const last = i === pages.length - 1;
      const pPr = `<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>${
        last ? "" : sect(p.w, p.h)
      }</w:pPr>`;
      return `<w:p>${pPr}${imageXml(image, ctx)}</w:p>`;
    })
    .join("");
  const lastPage = pages[pages.length - 1];
  return packPictureDocx(body + sect(lastPage.w, lastPage.h), ctx);
}

function packPictureDocx(bodyAndSect: string, ctx: Ctx): Blob {
  const document = XML + `<w:document ${NS}><w:body>${bodyAndSect}</w:body></w:document>`;
  const rels = ctx.images.map(
    (img) =>
      `<Relationship Id="${img.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.file}"/>`,
  );
  const contentTypes =
    XML +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    {
      name: "_rels/.rels",
      data: enc.encode(
        XML +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
    },
    { name: "word/document.xml", data: enc.encode(document) },
    {
      name: "word/_rels/document.xml.rels",
      data: enc.encode(
        XML +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
      ),
    },
    ...ctx.images.map((img) => ({ name: `word/media/${img.file}`, data: img.data })),
  ];
  return new Blob([zip(entries, new Date(1980, 0, 1))], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
