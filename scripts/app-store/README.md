# App Store screenshots

Regenerates the screenshots in `vault/Attachments/App Store/`.

```bash
# once
pip install reportlab
npm i --no-save playwright && npx playwright install chromium

# from the repo root: build and serve the production app
npm run build && npx vite preview --port 4173 &

cd scripts/app-store
python3 make_samples.py            # fictional sample PDFs -> samples/
node shots.mjs iphone && node shots.mjs ipad   # plain screens -> raw/
node compose.mjs                   # captioned screens -> final/
```

Then copy `final/*` and `raw/*` into the vault folders, keeping the 01–08 order. Every file must be exactly 1320×2868 (iPhone 6.9") or 2064×2752 (iPad 13"); App Store Connect rejects anything else. Set `CHROME=/path/to/chrome` to use an installed Chrome instead of Playwright's.
