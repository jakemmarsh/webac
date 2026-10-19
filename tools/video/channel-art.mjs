#!/usr/bin/env node
/**
 * The webAC YouTube channel's profile picture (800x800) and banner (2560x1440), as HTML rendered with Playwright.
 *
 *   node tools/video/channel-art.mjs --vista <frame.png> --out <dir>
 *
 * The vista is a full-size still from a recorded take (the thumbnails' B frame). YouTube crops the banner per
 * device: TV shows all of it, desktop a 2560x423 middle strip, phones the 1546x423 centre, so every word sits in
 * that centre. The picture is shown as a circle down to ~24 px, so it carries only the wordmark.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(opt('out') ?? '.');
mkdirSync(out, { recursive: true });
const vista = `data:image/png;base64,${readFileSync(resolve(opt('vista'))).toString('base64')}`;
const fontDir = resolve(dirname(fileURLToPath(import.meta.url)), '../site/fonts');
const font = (f) => `url(data:font/woff2;base64,${readFileSync(join(fontDir, f)).toString('base64')})`;

const base = `
@font-face { font-family: Uncial; src: ${font('uncial-antiqua-400.woff2')}; }
@font-face { font-family: Alegreya; font-weight: 700; src: ${font('alegreya-sans-700.woff2')}; }
* { box-sizing: border-box; } html, body { margin: 0; overflow: hidden; background: #0a0e22; }
.logo { font-family: Uncial, serif; color: #ffd76a; text-shadow: 0 4px 0 #000, 0 0 30px rgba(0,0,0,.9); }
`;

const avatar = `<style>${base}
body { width: 800px; height: 800px; background: radial-gradient(circle at 50% 42%, #2a3a8c 0%, #121a4a 55%, #070a1c 100%); }
.ring { position: absolute; inset: 60px; border-radius: 50%; border: 14px solid #c99a3a; box-shadow: inset 0 0 40px rgba(0,0,0,.6); }
.logo { position: absolute; left: 0; right: 0; top: 320px; text-align: center; font-size: 148px; line-height: 1; letter-spacing: -0.02em; }
</style><div class="ring"></div><div class="logo">webAC</div>`;

const banner = `<style>${base}
body { width: 2560px; height: 1440px; }
.shot { position: absolute; inset: 0; background-image: url(${vista}); background-size: 118%; background-position: 50% 62%;
        filter: saturate(1.2) contrast(1.05); }
.shade { position: absolute; inset: 0; background:
  linear-gradient(90deg, rgba(5,8,25,.85) 0%, rgba(5,8,25,.35) 30%, rgba(5,8,25,.35) 70%, rgba(5,8,25,.85) 100%),
  linear-gradient(180deg, rgba(5,8,25,.9) 0%, rgba(5,8,25,0) 36%, rgba(5,8,25,0) 64%, rgba(5,8,25,.9) 100%); }
.safe { position: absolute; left: 507px; top: 509px; width: 1546px; height: 423px; display: flex; flex-direction: column;
        align-items: center; justify-content: center; text-align: center; }
.logo { font-size: 150px; line-height: 1; }
.sub { font: 700 58px Alegreya, sans-serif; color: #fff; text-shadow: 0 3px 12px rgba(0,0,0,.95); margin-top: 18px; }
.url { font: 700 44px Alegreya, sans-serif; color: #ffd76a; text-shadow: 0 3px 12px rgba(0,0,0,.95); margin-top: 10px; }
</style><div class="shot"></div><div class="shade"></div>
<div class="safe"><div class="logo">webAC</div><div class="sub">Asheron's Call in your browser · free, no install</div><div class="url">playwebac.com</div></div>`;

const browser = await chromium.launch();
for (const [name, html, w, h] of [['channel-avatar', avatar, 800, 800], ['channel-banner', banner, 2560, 1440]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const f = join(out, `${name}.jpg`);
  await page.screenshot({ path: f, type: 'jpeg', quality: 90 });
  console.log(f);
  await page.close();
}
await browser.close();
