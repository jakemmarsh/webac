/**
 * Resize a REAL browser window (not viewport emulation) under the game and
 * record what follows it: innerWidth/Height, the WebGL canvas's CSS and
 * drawing-buffer size, and the HUD root's box, plus a screenshot per step.
 *
 *   npx tsx tools/probe-window-resize.ts <url> <outDir> [waitSec=50] [w×h …]
 *
 * Playwright's setViewportSize emulates a fixed viewport; a player drags the
 * window, which this does through CDP Browser.setWindowBounds with no
 * viewport override (Jake, 2026-10-10: "growing one doesn't make the game
 * adjust wider").
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GPU_ARGS } from './lib/game-session.js';

const [url, out, waitArg, ...sizes] = process.argv.slice(2);
if (!url || !out) { console.error('usage: probe-window-resize.ts <url> <outDir> [waitSec] [WxH …]'); process.exit(2); }
mkdirSync(out, { recursive: true });
const steps = (sizes.length ? sizes : ['1200x760', '1800x1000', '1000x700', '1900x1060']).map((s) => s.split('x').map(Number) as [number, number]);
const browser = await chromium.launch({ headless: false, args: [...GPU_ARGS, '--window-size=1200,800'] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
await page.waitForTimeout(Number(waitArg ?? 50) * 1000);
const cdp = await ctx.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
const rows: unknown[] = [];
let i = 0;
for (const [w, h] of steps) {
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: w, height: h } });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(`(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, canvasCss: box(c), canvasBuf: c ? [c.width, c.height] : null,
      hud: box(document.querySelector('#game-hud')), screen: box(document.querySelector('#screen-container')) };
  })()`);
  const shot = join(out, `${String(++i).padStart(2, '0')}-${w}x${h}.png`);
  await page.screenshot({ path: shot });
  rows.push({ window: [w, h], ...m as object, shot });
  console.log(JSON.stringify(rows.at(-1)));
}
writeFileSync(join(out, 'report.json'), JSON.stringify(rows, null, 2));
await browser.close();
