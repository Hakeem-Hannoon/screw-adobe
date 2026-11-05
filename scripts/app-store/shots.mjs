// Drives the real app (vite preview of the production build) at the exact
// App Store screenshot sizes and saves plain screens to raw/.
//   node shots.mjs iphone   -> raw/iphone-*.png at 1320x2868 (440x956 @3x)
//   node shots.mjs ipad     -> raw/ipad-*.png   at 2064x2752 (1032x1376 @2x)
// Optional 2nd argument runs one scene, e.g. "node shots.mjs iphone 2-".
import { chromium } from "playwright";
const DEV = process.argv[2] || "iphone";
const cfg = DEV === "iphone"
  ? { w: 440, h: 956, s: 3, top: 62, bottom: 34, mobile: true }
  : { w: 1032, h: 1376, s: 2, top: 32, bottom: 20, mobile: true };
const only = process.argv[3];
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox", "--font-render-hinting=none"] });
const ctx = await b.newContext({ viewport: { width: cfg.w, height: cfg.h }, deviceScaleFactor: cfg.s, isMobile: cfg.mobile, hasTouch: true, colorScheme: "light" });
await ctx.addInitScript(([top, bottom, dev]) => {
  const st = document.createElement("style");
  st.textContent = `:root{--safe-top:${top}px !important;--safe-bottom:${bottom}px !important}
  #sb{position:fixed;left:0;right:0;top:0;height:${top}px;z-index:9999;pointer-events:none;display:flex;align-items:center;justify-content:space-between;
      padding:${dev==="iphone"?"6px 34px 0 50px":"0 22px"};font:600 ${dev==="iphone"?17:15}px -apple-system,"Public Sans Variable",system-ui;color:var(--text);letter-spacing:-.01em}
  #sb .r{display:flex;gap:7px;align-items:center}`;
  const add = () => {
    document.documentElement.classList.add("native");
    document.head.append(st);
    const sb = document.createElement("div"); sb.id = "sb";
    const sig = `<svg width="19" height="12" viewBox="0 0 19 12"><g fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx=".8"/><rect x="5" y="5.5" width="3.2" height="6.5" rx=".8"/><rect x="10" y="3" width="3.2" height="9" rx=".8"/><rect x="15" y="0" width="3.2" height="12" rx=".8"/></g></svg>`;
    const wifi = `<svg width="17" height="12" viewBox="0 0 17 12"><g fill="currentColor"><path d="M8.5 2.3c2.4 0 4.6.9 6.3 2.5l1.2-1.2C14 1.6 11.4.5 8.5.5S3 1.6 1 3.6l1.2 1.2C3.9 3.2 6.1 2.3 8.5 2.3z"/><path d="M8.5 5.7c1.5 0 2.8.6 3.9 1.5l1.2-1.2C12.2 4.7 10.4 4 8.5 4s-3.7.7-5.1 2l1.2 1.2c1.1-.9 2.4-1.5 3.9-1.5z"/><path d="M8.5 9.1c.6 0 1.1.2 1.5.6L8.5 11.2 7 9.7c.4-.4.9-.6 1.5-.6z"/></g></svg>`;
    const bat = `<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg>`;
    sb.innerHTML = dev === "iphone"
      ? `<span>9:41</span><span class="r">${sig}${wifi}${bat}</span>`
      : `<span>9:41&nbsp;&nbsp;Wed Nov 4</span><span class="r">${wifi}<span style="font-size:14px">100%</span>${bat}</span>`;
    document.body.append(sb);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
}, [cfg.top, cfg.bottom, DEV]);

const p = await ctx.newPage();
p.on("pageerror", e => console.log("pageerror", e.message));
const S = (f) => `samples/${f}.pdf`;
const home = async () => { await p.goto(process.env.APP_URL || "http://localhost:4173/"); await p.waitForTimeout(1600); };
async function setFiles(files) {
  const handle = await p.evaluateHandle(() => [...document.querySelectorAll("input[type=file]")].find(i => !i.parentElement.closest("[hidden]")));
  await handle.asElement().setInputFiles(files);
}
const shot = async (name) => { await p.waitForTimeout(500); await p.evaluate(() => document.querySelector("#toasts")?.replaceChildren()); await p.screenshot({ path: `raw/${DEV}-${name}.png` }); console.log("shot", name); };


async function cover(query) {
  await p.fill("#find-input", query); await p.waitForTimeout(700);
  if (await p.locator("#find-apply").isEnabled()) await p.click("#find-apply");
  await p.waitForTimeout(500);
}
async function preset(label, apply = true) {
  await p.locator("[data-preset]").filter({ hasText: label }).first().click();
  await p.waitForTimeout(900);
  if (apply && await p.locator("#find-apply").isEnabled()) { await p.click("#find-apply"); await p.waitForTimeout(500); }
}
async function redactScene(keepFind) {
  await home();
  await p.setInputFiles("#file-input", S("Tenancy Confirmation"));
  await p.waitForTimeout(2500);
  await p.click("#find-toggle");
  await cover("Jordan A. Whitfield");
  await cover("Whitfield");
  await cover("55 Harbourfront Way");
  await preset("Long numbers");
  await preset("Phone numbers");
  if (keepFind) { await preset("Emails", false); await p.locator("#find-input").blur(); }
  else { await preset("Emails"); await p.click("#find-close"); }
  await p.evaluate(() => document.querySelector("#scroller")?.scrollTo(0, 0));
  await p.waitForTimeout(800);
}

const scenes = {
  async "1-home"() { await home(); await p.waitForTimeout(1200); await shot("1-home"); },
  async "2-redact"() { await redactScene(false); await shot("2-redact"); },
  async "3-find"() { await redactScene(true); await shot("3-find"); },
  async "4-sign"() {
    await home(); await p.click("#go-sign"); await p.waitForTimeout(500);
    await setFiles(S("Tenancy Confirmation")); await p.waitForTimeout(2000);
    await p.fill("#sg-name", "Priya Natarajan"); await p.waitForTimeout(1500);
    await p.locator("[data-ink]").nth(1).click().catch(()=>{});
    await p.locator(".sg-style[data-style]").nth(1).click(); await p.waitForTimeout(800);
    await p.evaluate(() => document.querySelector("#sign-tool [data-scroller]").scrollTo(0, 0));
    await shot("4-sign");
  },
  async "5-merge"() {
    await home(); await p.click("#go-merge"); await p.waitForTimeout(500);
    await setFiles([S("Offer Letter"), S("Pay Stub October"), S("Reference Letter"), S("Tenancy Confirmation")]);
    await p.waitForTimeout(3000); await shot("5-merge");
  },
  async "6-organize"() {
    await home(); await p.click("#go-organize"); await p.waitForTimeout(500);
    await setFiles(S("Application Packet")); await p.waitForTimeout(3500);
    const imgs = await p.evaluate(() => [...document.querySelectorAll("canvas, img")].filter(e => e.offsetParent && e.getBoundingClientRect().width > 60).map(e => { const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height*0.6]; }));
    console.log("thumbs", imgs.length);
    for (const i of [4, 5]) if (imgs[i]) { await p.mouse.click(imgs[i][0], imgs[i][1]); await p.waitForTimeout(300); }
    await shot("6-organize");
  },
  async "7-convert"() { await home(); await p.click("#go-convert"); await p.waitForTimeout(800); await shot("7-convert"); },
  async "8-signed"() {
    await home(); await p.click("#go-sign"); await p.waitForTimeout(500);
    await setFiles(S("Tenancy Confirmation")); await p.waitForTimeout(2000);
    await p.fill("#sg-name", "Priya Natarajan"); await p.waitForTimeout(1500);
    await p.locator("[data-ink]").nth(1).click().catch(()=>{});
    await p.locator(".sg-style[data-style]").nth(1).click(); await p.waitForTimeout(500);
    await p.click("#sign-tool [data-go]"); await p.waitForTimeout(2000);
    const page = p.locator("#sign-tool [data-pages] canvas, #sign-tool [data-pages] img").first();
    const bb = await page.boundingBox(); console.log("page box", bb);
    await p.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.578);
    await p.waitForTimeout(800);
    await p.waitForTimeout(800);
    await shot("8-signed");
  },
};
for (const [k, f] of Object.entries(scenes)) if (!only || k.startsWith(only)) await f();
await b.close();
