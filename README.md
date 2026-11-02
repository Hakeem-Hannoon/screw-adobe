# HackerPDF

Black out or white out anything in a PDF, then download a clean copy. Merge, split, rotate and number PDFs, pull out their text, or turn images into a PDF, too. Runs entirely in your browser: your files are never uploaded anywhere.

**Live:** https://hakeem-hannoon.github.io/screw-adobe/

## What it does

- **Box tool:** drag to cover anything with a black or white box. Move, resize, or delete boxes after.
- **Text tool:** click to type on the page, for example over a white-out to replace a value.
- **Find and cover:** type a name, number, or phrase and cover every match in the document at once. One-click presets for emails, phone numbers, and long numbers (card, account, SIN/SSN).
- **Delete pages** you don't want to share.
- **Undo / redo**, zoom, keyboard shortcuts, dark mode, works on phones.
- **Password-protected PDFs** open after you enter the password.
- **Merge PDFs:** add several files, drag them into order, download one PDF. Drop two or more PDFs on the page to start a merge.
- **Split a PDF:** click between pages to cut, or cut every N pages. Untick any part you don't want. One part downloads as a PDF; several come as a ZIP.
- **PDF to text:** pull all the text out of a PDF as plain text (`.txt`) or **Markdown** (`.md`), or copy it. Markdown picks up headings from font sizes, bulleted and numbered lists, tables, and bold and italic text. Scanned pages can be read with OCR right there. Optionally mark where each page starts, or (for plain text) join wrapped lines so paragraphs reflow wherever you paste them. Scanned PDFs have no text to pull out (they're pictures of letters), and the tool tells you when that's the case.
- **Sign:** pick a colour (black, ballpoint blue or dark blue), pick a style (your name in one of 17 handwriting fonts, natural or fancy, or draw it with a mouse or finger, with strokes that thin and thicken like real ink), then click where it goes. Drag to move, pull the corner to resize, sign in as many places as you like. The original file is kept intact, form fields included. This is a visual signature, not a certificate-based digital signature.
- **Images to PDF:** turn photos, scans or screenshots (JPEG, PNG, WebP, GIF, SVG, and HEIC in Safari) into one PDF, one image per page. Drag them into order, pick Letter, A4 or pages that fit each image, with or without margins. Drop images on the home screen to start.
- **Page numbers:** pick where the number goes by clicking on a blank page, then preview your real pages with the numbers on before downloading. Choose `1`, `Page 1`, `1 / 12` or `Page 1 of 12`, three sizes, and whether to skip the first page (it still counts). Works on rotated pages too.
- **Rotate:** click a page to turn it right (Shift-click for left), or turn every page at once. Turning only changes how each page is displayed, so nothing on it is re-rendered.
- **Organize pages:** drag pages into a new order, select pages (Shift-click for a range) to delete them (with undo) or extract them into their own PDF.
- **Compress:** shrink a PDF by re-compressing the photos and scans inside it: Light, Strong, Smallest, or *Fit a size* (the lightest setting that gets under, say, 2 MB). Text, vector drawings, fonts, links, bookmarks and form fields are left exactly as they were, so text stays selectable. Shows before/after sizes and page 1 side by side.
- **Compare:** two versions of a PDF, matched page by page by their text (so an added or removed page is reported as such), with changed regions outlined on both pages and a word-by-word text diff. Catches visual-only changes too, like a recolored figure.
- **Make searchable (OCR):** read scanned pages with Tesseract, a neural-network OCR engine that runs on your device (English). The page looks the same, but an invisible text layer is laid exactly over each word, so the text can be selected, searched and copied. Sideways and upside-down scans are detected and read the right way up. Pages that already have text are left alone.

## Why the redaction is real

Drawing a black rectangle on top of a PDF doesn't remove anything: the text is still underneath and anyone can copy it out. This tool doesn't do that.

When you download:

1. **Every page you edited is flattened.** It's rendered to an image with your boxes and text burned in, and that image replaces the page. The original text, fonts, links and hidden layers on that page are gone from the file.
2. **Pages you didn't touch are copied as-is**, so their text stays selectable. Anything on them that could point back to an edited page (internal links, form-field trees, page back-references) is cut, and any object no longer reachable is dropped from the file.
3. **It's a brand-new PDF**, so the original title, author, XMP metadata, bookmarks, attachments and scripts don't carry over.

Want the strongest option? Open the arrow next to **Download** and turn on **Flatten every page**. No text in the output will be selectable.

Password-protected files are always fully flattened, and the downloaded copy has no password.

### Merging, splitting, rotating, images and page numbers

Merged, split, organized, rotated and numbered files are built the same way as untouched pages above: brand-new PDFs with no metadata, bookmarks, attachments or scripts, and with links between pages removed (web links stay). That matters for splitting: a page that links to page 10 would otherwise drag page 10 into a file you meant to contain only pages 1 to 3. Pages from password-protected files are turned into images.

Photos carry hidden metadata: often the GPS location they were taken at, the time, and the phone's make and serial number. Images to PDF leaves all of it out. JPEGs are copied without re-compressing, minus their metadata; sideways phone photos are turned upright.

## Privacy

There's no backend. The production build ships a Content-Security-Policy with `connect-src 'self'`, so the page can't send your file to any other server even if it wanted to. Fonts, pdf.js assets and the OCR engine and its language model are self-hosted; nothing loads from a third party.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` / `T` | Box tool / Text tool |
| `X` | Switch between black and white |
| `Delete` | Remove the selected box or text |
| Arrow keys | Nudge selection (hold `Shift` for bigger steps) |
| `Enter` | Edit the selected text |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` | Undo, redo |
| `Ctrl/⌘ F` | Find text to cover |
| `Ctrl/⌘ +`, `-`, `0` | Zoom in, out, fit width |
| `Ctrl/⌘ S` | Download (also in Merge, Split and PDF to text) |

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
npm run preview  # serve dist/ (with the production CSP)
```

Built with [pdf.js](https://mozilla.github.io/pdf.js/) for rendering and text search, [pdf-lib](https://pdf-lib.js.org/) for writing the output, [Tesseract.js](https://tesseract.projectnaptha.com/) for OCR, Vite, and TypeScript. No framework.

## Deploy

Every push to `main` builds the site and publishes `dist/` to the `gh-pages` branch via GitHub Actions (`.github/workflows/deploy.yml`). GitHub Pages serves that branch.
