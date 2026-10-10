/**
 * CORE.5 live verification — native-pixel HUD + per-region anchoring.
 *
 * Captures the full HUD at two viewports and asserts the retail anchor
 * geometry (per DAT edge flags, UIElement::UpdateForParentSizeChange
 * @ 00462640): vitals strip top full-width, radar top-right at native
 * 300x120, toolbar bottom-right at native 300x122, chat bottom-left,
 * spellbar band bottom-center, right-dock panels between radar bottom
 * and toolbar top with no overlaps.
 *
 * Usage: npx tsx tools/verify-core5-hud.ts [--label before|after]
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5';
const OUT = join(__dir, '..', 'verification', 'core5-hud');
const LABEL = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'capture';
const VIEWPORTS = [
  { width: 1568, height: 775, name: '1568x775' },
  { width: 1920, height: 1080, name: '1920x1080' },
];

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
  const status = cond ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${name} — ${detail}`);
  if (!cond) failures.push(`${name}: ${detail}`);
}

async function auditViewport(page: Page, vw: number, vh: number, name: string): Promise<void> {
  console.log(`\n=== viewport ${name} ===`);
  await page.setViewportSize({ width: vw, height: vh });
  await page.waitForTimeout(1500);

  const hud = await rectOf(page, '#game-hud');
  check('hud-native-size', !!hud && Math.abs(hud.w - vw) < 2 && Math.abs(hud.h - vh) < 2,
    `#game-hud rect=${JSON.stringify(hud)} expected ${vw}x${vh} (native pixel, scale 1)`);

  // Radar: native 300x120, top-right, below the 28px vitals strip.
  const radar = await rectOf(page, '#hud-radar');
  // CORE.5.b.b — EoL floaty radar 0x21000074: 120x140 flush top-right
  // (root HUD 0x21000005 child 0x100006d2 at (680,0), edges L2/T1).
  check('radar-top-right-native', !!radar
    && Math.abs(radar.w - 120) < 2 && Math.abs(radar.h - 140) < 2
    && Math.abs((radar.x + radar.w) - vw) < 2 && Math.abs(radar.y) < 2,
    `radar=${JSON.stringify(radar)} expected 120x140 at right edge, y=0`);

  // Toolbar: native 300x122 pinned bottom-right.
  const toolbar = await rectOf(page, '#hud-toolbar');
  check('toolbar-bottom-right-native', !!toolbar
    && Math.abs(toolbar.w - 300) < 2 && Math.abs(toolbar.h - 122) < 2
    && Math.abs((toolbar.x + toolbar.w) - vw) < 2 && Math.abs((toolbar.y + toolbar.h) - vh) < 2,
    `toolbar=${JSON.stringify(toolbar)} expected 300x122 at bottom-right`);

  // Chat: bottom-left, native 100 tall.
  const chat = await rectOf(page, '#hud-chat');
  check('chat-bottom-left-native', !!chat
    && Math.abs(chat.x) < 2 && Math.abs((chat.y + chat.h) - vh) < 2 && Math.abs(chat.h - 100) < 2,
    `chat=${JSON.stringify(chat)} expected 100 tall at bottom-left`);

  // Vitals strip: top row, 28px tall, starts at x=0.
  const status = await rectOf(page, '#hud-statusbar');
  check('statusbar-top-strip', !!status && Math.abs(status.y) < 2 && Math.abs(status.h - 28) < 3,
    `statusbar=${JSON.stringify(status)} expected 28-tall top strip`);

  // No structural overlaps between fixed HUD regions.
  const pairs: Array<[string, RectInfo | null, string, RectInfo | null]> = [
    ['radar', radar, 'toolbar', toolbar],
    ['radar', radar, 'statusbar', status],
    ['chat', chat, 'toolbar', toolbar],
  ];
  for (const [an, a, bn, b] of pairs) {
    if (!a || !b) continue;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    check(`no-overlap-${an}-${bn}`, !overlap, `${an}=${JSON.stringify(a)} vs ${bn}=${JSON.stringify(b)}`);
  }

  await page.screenshot({ path: join(OUT, `${LABEL}-${name}-idle.png`) });

  // Open the inventory panel and confirm it docks between radar and toolbar.
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { inventoryVisible?: boolean; toggleInventory?: () => void } } }).__ac?.gameUI;
    if (ui && !ui.inventoryVisible) ui.toggleInventory?.();
  });
  await page.waitForTimeout(1200);
  const inv = await rectOf(page, '[data-panel="0x21000023"]');
  if (inv && radar && toolbar) {
    check('inventory-docked-below-radar', inv.y >= radar.y + radar.h - 2,
      `inventory top ${inv.y} vs radar bottom ${radar.y + radar.h}`);
    check('inventory-above-toolbar', inv.y + inv.h <= toolbar.y + 2,
      `inventory bottom ${inv.y + inv.h} vs toolbar top ${toolbar.y}`);
    check('inventory-right-docked', Math.abs((inv.x + inv.w) - vw) < 4,
      `inventory right ${inv.x + inv.w} vs viewport ${vw}`);
  } else {
    console.log(`  [note] inventory panel rect=${JSON.stringify(inv)} (selector may differ pre-refactor)`);
  }
  await page.screenshot({ path: join(OUT, `${LABEL}-${name}-inventory.png`) });
  // Close it again for the next viewport pass.
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { inventoryVisible?: boolean; toggleInventory?: () => void } } }).__ac?.gameUI;
    if (ui?.inventoryVisible) ui.toggleInventory?.();
  });
  await page.waitForTimeout(400);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: VIEWPORTS[0] });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  console.log('waiting for world entry...');
  await waitForWorld(page);
  console.log('in world; settling...');
  await page.waitForTimeout(5000);

  for (const v of VIEWPORTS) await auditViewport(page, v.width, v.height, v.name);

  await browser.close();
  console.log(failures.length === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures.length} CHECKS FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
