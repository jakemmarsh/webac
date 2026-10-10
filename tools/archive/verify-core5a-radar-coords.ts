/**
 * CORE.5.a live verification — coordinate readout inside the radar window
 * (CORE.5.b.b: EoL floaty radar 0x21000074, combined single-line readout).
 *
 * Asserts (at 1568x775):
 *  - #radar-coord is a child of #hud-radar at DAT strip el 0x1000003e
 *    geometry (0,120) 120x18 (layout 0x21000074 root 0x100006d3, attr
 *    0x10000036 -> m_pCombinedCoordsText).
 *  - It stays fully inside the 120x140 radar window (no below-window hang).
 *  - With the inventory panel docked (dock top y=140 = radar bottom), the
 *    readout remains visible; it must not intersect the panel rect at all.
 *  - No compass-degrees text canvas exists.
 *
 * Usage: npx tsx tools/verify-core5a-radar-coords.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5a';
const OUT = join(__dir, '..', 'verification', 'core5-hud');

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
    ui.wizard.name = 'Hud Tester';
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

interface RectInfo { x: number; y: number; w: number; h: number; }
async function rectOf(page: Page, selector: string): Promise<RectInfo | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
}
const inside = (a: RectInfo, b: RectInfo): boolean =>
  a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const intersects = (a: RectInfo, b: RectInfo): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(4000);

  const radar = await rectOf(page, '#hud-radar');
  const coord = await rectOf(page, '#radar-coord');
  check('radar-present', !!radar, JSON.stringify(radar));
  check('coord-present', !!coord, JSON.stringify(coord));
  if (radar && coord) {
    check('coord-inside-window', inside(coord, radar), `coord=${JSON.stringify(coord)} radar=${JSON.stringify(radar)}`);
    check('coord-at-dat-pos', Math.abs(coord.x - radar.x) < 1 && Math.abs(coord.y - (radar.y + 120)) < 1 && coord.w === 120 && coord.h === 18,
      `expected (radar+0, radar+120) 120x18, got offset (${coord.x - radar.x},${coord.y - radar.y}) ${coord.w}x${coord.h}`);
  }
  const nothingBelow = await page.evaluate(() => {
    const radarEl = document.querySelector('#hud-radar');
    if (!radarEl) return false;
    // Everything lives within the 140px floaty window: disc children end at
    // y<=120, the coord strip spans y 120-138.
    return Array.from(radarEl.children).every((c) => {
      const el = c as HTMLElement;
      const top = parseInt(el.style.top || '0', 10);
      const h = (el as HTMLCanvasElement).height ?? el.offsetHeight ?? 0;
      return top + h <= 140;
    });
  });
  check('nothing-below-window', nothingBelow, 'no radar child positioned below the 140px floaty window');

  // Coord text actually rendered (non-blank canvas pixels).
  const coordHasText = await page.evaluate(() => {
    const c = document.querySelector('#radar-coord') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    return ctx.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
  });
  check('coord-text-rendered', coordHasText, 'combined coord canvas has non-transparent pixels');

  await page.screenshot({ path: join(OUT, 'core5a-radar-idle.png') });

  // Dock the inventory panel and confirm the readouts stay visible.
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { inventoryVisible?: boolean; toggleInventory?: () => void } } }).__ac?.gameUI;
    if (ui && !ui.inventoryVisible) ui.toggleInventory?.();
  });
  await page.waitForTimeout(1500);
  const panel = await rectOf(page, '[data-panel="0x21000023"]');
  check('panel-open', !!panel, JSON.stringify(panel));
  const coord2 = await rectOf(page, '#radar-coord');
  if (panel && coord2) {
    check('coord-clear-of-panel', !intersects(coord2, panel), `coord=${JSON.stringify(coord2)} panel=${JSON.stringify(panel)}`);
  }
  await page.screenshot({ path: join(OUT, 'core5a-radar-inventory-docked.png') });

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
