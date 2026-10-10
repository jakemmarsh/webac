/**
 * CORE.17.c — whole-screen + toolbar side-by-side vs the positively-EoL
 * retail reference (reference/images/hud/reddit-shutdown.jpg, Jan-2017
 * shutdown event, 1920x1080).
 *
 * Captures, in world at noon with weather off:
 *   01-full-peace.png     whole screen, peace mode (dove ornament)
 *   02-full-magic.png     whole screen, magic mode (fireball ornament + spell bar)
 *   03-toolbar-peace.png  #hud-toolbar-window crop, peace
 *   04-toolbar-magic.png  #hud-toolbar-window crop, magic
 * and composes:
 *   core17c-toolbar-sidebyside.png   retail toolbar crop (3x) / ours peace (3x) /
 *                                    ours magic (3x) / the DAT button + slot
 *                                    textures the toolbar is painted from
 *   core17c-fullscreen-sidebyside.png retail full frame over ours (magic mode,
 *                                    so the spell bar is on screen too)
 *
 * The retail crop box (x 1606, y 978, 314x102) is the bottom-right floaty
 * toolbar window in reddit-shutdown.jpg.
 *
 * Usage: npx tsx tools/capture-core17c-toolbar-sidebyside.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack, an existing
 * character on the testacjs account (tools/verify-core5bd-toolbar.ts creates
 * one on a fresh DB).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core17c';
const OUT = join(REPO, 'verification', 'core17c');
const TEX_DIR = join(OUT, 'dat-textures');
const RETAIL = join(REPO, 'reference/images/hud/reddit-shutdown.jpg');
const RETAIL_W = 1920;
const RETAIL_TOOLBAR = { x: 1606, y: 978, w: 314, h: 102 };
const ZOOM = 3;

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}

async function toolbarClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const clip = await page.evaluate(() => {
    const el = document.getElementById('hud-toolbar-window') ?? document.getElementById('hud-toolbar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
  });
  if (!clip) throw new Error('toolbar element not found');
  return clip;
}

const b64 = (p: string, mime: string): string => `data:${mime};base64,${readFileSync(p).toString('base64')}`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !(await inWorld(page))) {
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(8000);

  // Lighting-comparable frame: noon, weather off (same pins as capture-ui-screens --scenes).
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
  await page.waitForTimeout(2500);

  await page.screenshot({ path: join(OUT, '01-full-peace.png') });
  await page.screenshot({ path: join(OUT, '03-toolbar-peace.png'), clip: await toolbarClip(page) });
  console.log('[core17c] peace captures');

  await page.evaluate(() => (window as any).acDebug?.combatMode?.('magic'));
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(OUT, '02-full-magic.png') });
  await page.screenshot({ path: join(OUT, '04-toolbar-magic.png'), clip: await toolbarClip(page) });
  console.log('[core17c] magic captures');
  await page.evaluate(() => (window as any).acDebug?.combatMode?.('peace'));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));

  const retailSrc = b64(RETAIL, 'image/jpeg');
  const retailCrop = `<div style="width:${RETAIL_TOOLBAR.w * ZOOM}px;height:${RETAIL_TOOLBAR.h * ZOOM}px;
      background-image:url(${retailSrc});background-size:${RETAIL_W * ZOOM}px auto;
      background-position:-${RETAIL_TOOLBAR.x * ZOOM}px -${RETAIL_TOOLBAR.y * ZOOM}px;image-rendering:pixelated"></div>`;
  const ours = (f: string) => `<img src="${b64(join(OUT, f), 'image/png')}" style="image-rendering:pixelated;zoom:${ZOOM}">`;
  const texStrip = existsSync(TEX_DIR)
    ? readdirSync(TEX_DIR).filter((f) => f.endsWith('.png')).sort().map((f) =>
      `<figure style="margin:4px;text-align:center"><img src="${b64(join(TEX_DIR, f), 'image/png')}" style="image-rendering:pixelated;zoom:${ZOOM}"><figcaption style="font-size:12px">${f.replace('.png', '')}</figcaption></figure>`).join('')
    : '<em>(no dat-textures dir)</em>';

  const sheet = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;font-family:monospace;color:#fff;padding:6px">
    <figure style="margin:4px"><figcaption>RETAIL — reddit-shutdown.jpg (EoL, Jan 2017) bottom-right toolbar window, 3x</figcaption>${retailCrop}</figure>
    <figure style="margin:4px"><figcaption>OURS — 03-toolbar-peace.png, 3x</figcaption>${ours('03-toolbar-peace.png')}</figure>
    <figure style="margin:4px"><figcaption>OURS — 04-toolbar-magic.png, 3x</figcaption>${ours('04-toolbar-magic.png')}</figure>
    <figure style="margin:4px"><figcaption>DAT — LayoutDesc 0x21000016 button media (0x10000197/98/99/0x1000055a/0x1000019a/0x1000019b) + UIItem empty-slot tiles, straight from portal.dat</figcaption>
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end">${texStrip}</div></figure>
  </body>`);
  await sheet.waitForTimeout(500);
  await sheet.screenshot({ path: join(OUT, 'core17c-toolbar-sidebyside.png'), fullPage: true });
  console.log('[core17c] wrote core17c-toolbar-sidebyside.png');

  await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;font-family:monospace;color:#fff;padding:6px">
    <figure style="margin:4px"><figcaption>RETAIL — reddit-shutdown.jpg whole frame (1920x1080, owner-dragged windows)</figcaption><img src="${retailSrc}" style="width:980px"></figure>
    <figure style="margin:4px"><figcaption>OURS — 02-full-magic.png whole frame (1568x775, fresh character, magic mode)</figcaption><img src="${b64(join(OUT, '02-full-magic.png'), 'image/png')}" style="width:980px"></figure>
  </body>`);
  await sheet.waitForTimeout(500);
  await sheet.screenshot({ path: join(OUT, 'core17c-fullscreen-sidebyside.png'), fullPage: true });
  console.log('[core17c] wrote core17c-fullscreen-sidebyside.png');
  await sheet.close();
  await browser.close();
  console.log(`[core17c] done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
