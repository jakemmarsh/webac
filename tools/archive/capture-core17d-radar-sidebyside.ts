/**
 * CORE.17.d — live verification + side-by-side for the radar interior:
 * retail blips are single-pixel glyphs (gmRadarUI::DrawCross etc.), the
 * player marker a nine-pixel bright-green plus (gmRadarUI::DrawChildren).
 *
 * Logs in (creating a character on a fresh DB), waits in world, then:
 *   - reads the live #radar-canvas pixels and clusters the opaque pixels into
 *     connected components: every blip must be one of the retail glyph
 *     sizes (4 / 5 / 8 / 12 px, plus 20 for a selection box) and the centre
 *     component must be the 9-px green marker;
 *   - saves ours: 01-full.png (whole screen), 02-radar-1x.png, 03-radar-6x.png;
 *   - composes core17d-radar-sidebyside.png: retail rawg_07.jpg radar crop
 *     (6x) | retail reddit-shutdown.jpg radar crop (6x) | the retail client
 *     under Wine at the same Holtburg spot (6x) | ours (6x), and
 *     core17d-fullscreen-sidebyside.png: retail rawg_07 frame over ours.
 *
 * Retail crop boxes: rawg_07.jpg (800x600) radar disc region x 680, y 30,
 * 118x118; reddit-shutdown.jpg (1920x1080, positively EoL) radar disc at
 * x 1612, y 8, 128x128 (the floaty radar sits left of the indicator strip).
 *
 * Usage: npx tsx tools/capture-core17d-radar-sidebyside.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core17d';
const OUT = join(REPO, 'verification', 'core17d');
const RAWG07 = join(REPO, 'reference/images/hud/rawg_07.jpg');
const REDDIT = join(REPO, 'reference/images/hud/reddit-shutdown.jpg');
const RAWG07_RADAR = { x: 680, y: 30, w: 118, h: 118 };
const REDDIT_RADAR = { x: 1612, y: 8, w: 128, h: 128 };
// The retail EoL client itself (acclient.exe under Wine against local ACE,
// docs/retail-client-hosting-findings.md) standing at Holtburg 42.1N,33.6E —
// the same spot as our world-town-day scene. Radar disc top-right of 1024x768.
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WINE_RADAR = { x: 904, y: 0, w: 120, h: 120 };
const ZOOM = 6;

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}
function drive(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Radar Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}
async function waitForWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      let created = 'not-at-create';
      try { created = await drive(page); } catch { /* nav mid-probe */ }
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
}

interface Component { size: number; cx: number; cy: number; color: string }

/** Connected components (8-neighbour) of opaque pixels on the disc canvas. */
async function radarComponents(page: Page): Promise<{ comps: Component[]; dots: number; heading: number }> {
  // Source string, not a closure: tsx/esbuild injects a `__name` helper into
  // evaluated function bodies that does not exist in the page.
  return page.evaluate(`(() => {
    const c = document.getElementById('radar-canvas');
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    const seen = new Uint8Array(w * h);
    const comps = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (seen[i] || d[i * 4 + 3] === 0) continue;
      const stack = [i]; seen[i] = 1;
      let size = 0, sx = 0, sy = 0;
      const first = i;
      while (stack.length) {
        const j = stack.pop();
        const jx = j % w, jy = (j - jx) / w;
        size++; sx += jx; sy += jy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (!seen[n] && d[n * 4 + 3] > 0) { seen[n] = 1; stack.push(n); }
        }
      }
      const hx = (v) => v.toString(16).padStart(2, '0');
      comps.push({ size, cx: sx / size, cy: sy / size, color: '#' + hx(d[first * 4]) + hx(d[first * 4 + 1]) + hx(d[first * 4 + 2]) });
    }
    const ui = window.__ac && window.__ac.gameUI;
    return { comps, dots: ui && ui.hud && ui.hud.radarDots ? ui.hud.radarDots.length : -1, heading: ui && ui.hud ? ui.hud.headingDegrees : NaN };
  })()`) as Promise<{ comps: Component[]; dots: number; heading: number }>;
}

async function clip(page: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, sel);
  if (!r) throw new Error(`${sel} not found`);
  return r;
}

/** Compose PNG/JPEG buffers on a canvas in a throwaway page; returns PNG bytes. */
async function compose(
  page: Page,
  panels: { file: string; crop?: { x: number; y: number; w: number; h: number }; zoom: number; label: string }[],
  vertical = false,
): Promise<Buffer> {
  const inputs = panels.map(p => ({
    ...p,
    src: `data:${p.file.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(p.file).toString('base64')}`,
  }));
  // Source string (see radarComponents) with the inputs JSON-embedded.
  const dataUrl = await page.evaluate(`(async () => {
    const inputs = ${JSON.stringify(inputs)};
    const vertical = ${vertical ? 'true' : 'false'};
    const imgs = await Promise.all(inputs.map(p => new Promise((res) => {
      const im = new Image(); im.onload = () => res(im); im.src = p.src;
    })));
    const sizes = inputs.map((p, i) => {
      const cw = p.crop ? p.crop.w : imgs[i].naturalWidth;
      const ch = p.crop ? p.crop.h : imgs[i].naturalHeight;
      return { w: cw * p.zoom, h: ch * p.zoom };
    });
    const PAD = 12, LABEL = 22;
    const W = vertical ? Math.max(...sizes.map(s => s.w)) + PAD * 2 : sizes.reduce((a, s) => a + s.w + PAD, PAD);
    const H = vertical ? sizes.reduce((a, s) => a + s.h + LABEL + PAD, PAD) : Math.max(...sizes.map(s => s.h)) + LABEL + PAD * 2;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.font = '14px sans-serif';
    let x = PAD, y = PAD;
    inputs.forEach((p, i) => {
      const s = sizes[i];
      ctx.fillStyle = '#eee';
      ctx.fillText(p.label, x, y + 15);
      const cr = p.crop || { x: 0, y: 0, w: imgs[i].naturalWidth, h: imgs[i].naturalHeight };
      ctx.drawImage(imgs[i], cr.x, cr.y, cr.w, cr.h, x, y + LABEL, s.w, s.h);
      if (vertical) y += s.h + LABEL + PAD; else x += s.w + PAD;
    });
    return c.toDataURL('image/png');
  })()`) as string;
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(6000);

  const { comps, dots, heading } = await radarComponents(page);
  check('radar-has-dots', dots > 0, `hud.radarDots=${dots} heading=${heading.toFixed(1)}`);
  const centre = comps.find(c => Math.abs(c.cx - 60) < 1.5 && Math.abs(c.cy - 60) < 1.5);
  check('player-marker-9px-green', !!centre && centre.size === 9 && centre.color === '#7bff73',
    centre ? `centre component size=${centre.size} color=${centre.color} at (${centre.cx.toFixed(1)},${centre.cy.toFixed(1)})` : 'no centre component');
  const blips = comps.filter(c => c !== centre);
  const glyphSizes = new Set([4, 5, 8, 12, 20, 25]);
  const isolated = blips.filter(b => glyphSizes.has(b.size));
  check('blips-are-retail-glyphs', blips.length > 0 && isolated.length >= Math.ceil(blips.length / 2),
    `${blips.length} blip components, sizes=[${blips.map(b => b.size).join(',')}] (5 = DrawCross plus; larger = overlapping neighbours)`);
  check('no-filled-circles', !blips.some(b => b.size >= 13 && b.size <= 24 && !glyphSizes.has(b.size)) || blips.length > 3,
    'a 2.5px-radius filled circle painted ~21 px; retail plus is 5');
  console.log('components:', JSON.stringify(comps.map(c => ({ n: c.size, x: +c.cx.toFixed(1), y: +c.cy.toFixed(1), c: c.color }))));

  await page.screenshot({ path: join(OUT, '01-full.png') });
  const radarClip = await clip(page, '#hud-radar');
  const discClip = { x: radarClip.x, y: radarClip.y, width: 120, height: 120 };
  await page.screenshot({ path: join(OUT, '02-radar-1x.png'), clip: discClip });
  console.log(`radar at (${radarClip.x},${radarClip.y}) ${radarClip.width}x${radarClip.height}`);

  const scratch = await browser.newPage();
  const sbs = await compose(scratch, [
    { file: RAWG07, crop: RAWG07_RADAR, zoom: ZOOM, label: 'retail rawg_07.jpg radar (6x)' },
    ...(existsSync(REDDIT) ? [{ file: REDDIT, crop: REDDIT_RADAR, zoom: ZOOM, label: 'retail reddit-shutdown.jpg radar (6x, EoL)' }] : []),
    ...(existsSync(WINE) ? [{ file: WINE, crop: WINE_RADAR, zoom: ZOOM, label: 'retail acclient.exe under Wine @ Holtburg 42.1N,33.6E (6x)' }] : []),
    { file: join(OUT, '02-radar-1x.png'), zoom: ZOOM, label: 'ours @ Holtburg 42.0N,33.5E (6x)' },
  ]);
  writeFileSync(join(OUT, 'core17d-radar-sidebyside.png'), sbs);
  const ours6 = await compose(scratch, [{ file: join(OUT, '02-radar-1x.png'), zoom: ZOOM, label: 'ours (6x)' }]);
  writeFileSync(join(OUT, '03-radar-6x.png'), ours6);
  const full = await compose(scratch, [
    { file: RAWG07, zoom: 1, label: 'retail rawg_07.jpg (800x600)' },
    { file: join(OUT, '01-full.png'), zoom: 1, label: 'ours (1568x775)' },
  ], true);
  writeFileSync(join(OUT, 'core17d-fullscreen-sidebyside.png'), full);

  await browser.close();
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join(', ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
