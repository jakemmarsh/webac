#!/usr/bin/env node
/**
 * YouTube thumbnails (1280x720 JPEG, under 2 MB) for the promo video, as HTML rendered with Playwright.
 *
 *   node tools/video/thumbnails.mjs --cast <frame.png> --vista <frame.png> --out <dir>
 *
 * Frames are full-size stills from the recorded takes (ffmpeg -i take.mp4 -ss <t> -frames:v 1).
 * Three concepts for YouTube's Test & Compare: A "NO INSTALL" in a browser window, B the logo
 * line over a vista, C the 2017 shutdown against today.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(opt('out') ?? '.');
mkdirSync(out, { recursive: true });
const img = (p) => `data:image/png;base64,${readFileSync(resolve(p)).toString('base64')}`;
const fontDir = resolve(dirname(fileURLToPath(import.meta.url)), '../site/fonts');
const font = (f) => `url(data:font/woff2;base64,${readFileSync(join(fontDir, f)).toString('base64')})`;
const cast = img(opt('cast'));
const vista = img(opt('vista'));

const base = `
@font-face { font-family: Uncial; src: ${font('uncial-antiqua-400.woff2')}; }
@font-face { font-family: Alegreya; font-weight: 700; src: ${font('alegreya-sans-700.woff2')}; }
* { box-sizing: border-box; } html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #0a0e22; }
.shot { position: absolute; background-size: cover; background-position: center; }
.big { font-family: 'Arial Black', Arial, sans-serif; font-weight: 900; color: #fff; -webkit-text-stroke: 10px #000; paint-order: stroke fill;
       text-shadow: 0 8px 28px rgba(0,0,0,.7); line-height: .95; letter-spacing: -0.02em; }
.gold { color: #ffd76a; }
.logo { font-family: Uncial, serif; color: #f3e6c4; text-shadow: 0 3px 0 #000, 0 0 24px rgba(0,0,0,.9); }
`;

// A: the game inside a browser window, address bar playwebac.com, "NO INSTALL".
const A = `<style>${base}
.win { position: absolute; left: 36px; top: 70px; width: 820px; height: 600px; border-radius: 14px; overflow: hidden; background: #dfe3ea;
       box-shadow: 0 20px 60px rgba(0,0,0,.6); border: 2px solid #9aa3b5; transform: rotate(-2deg); }
.bar { height: 54px; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: #e8ebf0; }
.dot { width: 14px; height: 14px; border-radius: 50%; } .url { flex: 1; height: 34px; border-radius: 17px; background: #fff; display: flex; align-items: center;
       padding-left: 18px; font: 600 22px Arial, sans-serif; color: #222; } .url b { color: #0b6b2f; margin-right: 8px; }
.win .shot { left: 0; right: 0; top: 54px; bottom: 0; background-image: url(${cast}); background-position: 42% 40%; background-size: 135%; }
.bg { inset: 0; background-image: url(${cast}); filter: blur(18px) brightness(.45) saturate(1.3); transform: scale(1.1); }
.txt { position: absolute; right: 40px; top: 120px; width: 420px; text-align: right; }
.txt .big { font-size: 100px; } .txt .logo { font-size: 48px; margin-top: 26px; }
</style><div class="shot bg"></div><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
<span class="dot" style="background:#28c840"></span><div class="url"><b>🔒</b>playwebac.com</div></div><div class="shot"></div></div>
<div class="txt"><div class="big">NO<br><span class="gold">INSTALL</span></div><div class="logo">Asheron's Call<br>in your browser</div></div>`;

// B: the vista, "ASHERON'S CALL" in the game's lettering, "IN YOUR BROWSER" below.
const B = `<style>${base}
.shot { inset: 0; background-image: url(${vista}); background-position: 50% 45%; background-size: 118%; filter: saturate(1.25) contrast(1.08); }
.shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,8,25,.0) 30%, rgba(5,8,25,.85) 100%); }
.t { position: absolute; left: 0; right: 0; bottom: 46px; text-align: center; }
.t .logo { font-size: 104px; line-height: 1; } .t .big { font-size: 84px; margin-top: 14px; }
.tag { position: absolute; top: 34px; right: 40px; font: 900 40px 'Arial Black', Arial; color: #111; background: #ffd76a; padding: 8px 18px; border-radius: 10px; transform: rotate(3deg); box-shadow: 0 8px 22px rgba(0,0,0,.5); }
</style><div class="shot"></div><div class="shade"></div><div class="tag">2026</div>
<div class="t"><div class="logo">Asheron's Call</div><div class="big">IN YOUR <span class="gold">BROWSER</span></div></div>`;

// C: left half grey "CLOSED 2017", right half the game today "STILL PLAYABLE".
const C = `<style>${base}
.l, .r { position: absolute; top: 0; bottom: 0; width: 640px; } .l { left: 0; } .r { right: 0; }
.l .shot { inset: 0; background-image: url(${cast}); background-position: 30% 50%; background-size: 230%; filter: grayscale(1) brightness(.35) contrast(1.2); }
.r .shot { inset: 0; background-image: url(${cast}); background-position: 48% 42%; background-size: 210%; filter: saturate(1.35) contrast(1.08); }
.split { position: absolute; left: 632px; top: 0; bottom: 0; width: 16px; background: #ffd76a; box-shadow: 0 0 30px rgba(0,0,0,.8); }
.l .big { position: absolute; left: 0; right: 0; top: 230px; text-align: center; font-size: 92px; color: #bbb; }
.l .big small { display: block; font-size: 120px; color: #ff5a4f; }
.r .big { position: absolute; left: 0; right: 0; bottom: 60px; text-align: center; font-size: 82px; }
.logo.top { position: absolute; left: 0; right: 0; top: 26px; text-align: center; font-size: 58px; }
</style><div class="l"><div class="shot"></div><div class="big">CLOSED<small>2017</small></div></div>
<div class="r"><div class="shot"></div><div class="big">STILL<br><span class="gold">PLAYABLE</span></div></div><div class="split"></div>
<div class="logo top">Asheron's Call</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
for (const [name, html] of Object.entries({ A, B, C })) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const f = join(out, `thumb-${name}.jpg`);
  await page.screenshot({ path: f, type: 'jpeg', quality: 90 });
  console.log(f);
}
await browser.close();
