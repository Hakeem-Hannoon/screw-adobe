# screw adobe

Black out or white out anything in a PDF, then download a clean copy. Runs entirely in your browser: your file is never uploaded anywhere.

**Live:** https://hakeem-hannoon.github.io/screw-adobe/

## What it does

- **Box tool:** drag to cover anything with a black or white box. Move, resize, or delete boxes after.
- **Text tool:** click to type on the page, for example over a white-out to replace a value.
- **Find and cover:** type a name, number, or phrase and cover every match in the document at once. One-click presets for emails, phone numbers, and long numbers (card, account, SIN/SSN).
- **Delete pages** you don't want to share.
- **Undo / redo**, zoom, keyboard shortcuts, dark mode, works on phones.
- **Password-protected PDFs** open after you enter the password.

## Why the redaction is real

Drawing a black rectangle on top of a PDF doesn't remove anything: the text is still underneath and anyone can copy it out. This tool doesn't do that.

When you download:

1. **Every page you edited is flattened.** It's rendered to an image with your boxes and text burned in, and that image replaces the page. The original text, fonts, links and hidden layers on that page are gone from the file.
2. **Pages you didn't touch are copied as-is**, so their text stays selectable. Anything on them that could point back to an edited page (internal links, form-field trees, page back-references) is cut, and any object no longer reachable is dropped from the file.
3. **It's a brand-new PDF**, so the original title, author, XMP metadata, bookmarks, attachments and scripts don't carry over.

Want the strongest option? Open the arrow next to **Download** and turn on **Flatten every page**. No text in the output will be selectable.

Password-protected files are always fully flattened, and the downloaded copy has no password.

## Privacy

There's no backend. The production build ships a Content-Security-Policy with `connect-src 'self'`, so the page can't send your file to any other server even if it wanted to. Fonts and pdf.js assets are self-hosted; nothing loads from a third party.

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
| `Ctrl/⌘ S` | Download |

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
npm run preview  # serve dist/ (with the production CSP)
```

Built with [pdf.js](https://mozilla.github.io/pdf.js/) for rendering and text search, [pdf-lib](https://pdf-lib.js.org/) for writing the output, Vite, and TypeScript. No framework.

## Deploy

Every push to `main` builds the site and publishes `dist/` to the `gh-pages` branch via GitHub Actions (`.github/workflows/deploy.yml`). GitHub Pages serves that branch.
