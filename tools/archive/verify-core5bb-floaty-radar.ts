/**
 * CORE.5.b.b live verification — EoL floaty radar family + re-derived dock top.
 *
 * Ground truth: root HUD 0x21000005 authors radar child 0x100006d2 (base
 * layout 0x21000074, 120x140) at (680,0), edges L2/T1 → pinned FLUSH to the
 * screen's top-right corner. Dock panels start at y=140 (the radar bottom;
 * the classic 148 was 28px statusbar + 120px ornate radar, both replaced).
 *
 * Asserts (at 1568x775 and 1920x1080):
 *  - #hud-radar is 120x140 at top 0 / right 0 (flush corner).
 *  - The window shows the floaty disc art 0x06004cc1 (background), not the
 *    classic ornate 300x120 frame 0x06004cf9.
 *  - #radar-coord (combined readout) is at (0,120) 120x18 inside the window
 *    and its rendered text is the retail combined format "N,E" (no space).
 *  - #radar-lock-button at (6,6) 27x27 shows the unlocked open-padlock art
 *    0x060074b8 by default (ACE CharacterOptions2.Default has LockUI clear)
 *    and #radar-drag-button (87,6, art 0x060074c9) is visible; clicking the
 *    lock toggles to 0x060074b7 and hides the drag button
 *    (gmRadarUI::UpdateLockedStatus @ 004d7680).
 *  - Compass tokens ride the floaty ring at computeCompassTokenPositions()
 *    for the live heading (dial center 60,60).
 *  - The docked inventory panel opens at dock top 140 = radar bottom (no
 *    gap, no overlap with the radar window).
 *
 * Saves screenshots + a side-by-side vs reference/images/hud/
 * reddit-shutdown.jpg's radar corner into verification/core5bb-floaty-radar/.
 *
 * Usage: npx tsx tools/verify-core5bb-floaty-radar.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RADAR_COMPASS_TOKENS,
  computeCompassTokenPositions,
} from '../../packages/renderer/src/ui/RadarCompassTokens.js';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5bb';
const OUT = join(__dir, '..', 'verification', 'core5bb-floaty-radar');

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

const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
}

interface RectInfo { x: number; y: number; w: number; h: number }
async function rectOf(page: Page, selector: string): Promise<RectInfo | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

async function verifyAt(page: Page, vw: number, vh: number, label: string): Promise<void> {
  await page.setViewportSize({ width: vw, height: vh });
  await page.waitForTimeout(1500);

  const radar = await rectOf(page, '#hud-radar');
  check(`${label}-radar-present`, !!radar, JSON.stringify(radar));
  if (radar) {
    check(`${label}-radar-size`, Math.abs(radar.w - 120) < 0.5 && Math.abs(radar.h - 140) < 0.5,
      `${radar.w}x${radar.h} (want 120x140)`);
    check(`${label}-radar-top-right-flush`, Math.abs(radar.y) < 0.5 && Math.abs((radar.x + radar.w) - vw) < 0.5,
      `top=${radar.y} rightGap=${vw - radar.x - radar.w}`);
  }

  // Live textures are data: URIs — compare against the client's own texture
  // cache instead of looking for the DID in the URL.
  const art = await page.evaluate(() => {
    const el = document.querySelector('#hud-radar') as HTMLElement | null;
    const ui = (window as unknown as { __ac?: { gameUI?: { getTexURL?: (id: number) => string | null } } }).__ac?.gameUI;
    const bg = el ? el.style.backgroundImage : '';
    const floaty = ui?.getTexURL?.(0x06004cc1) ?? '';
    const classic = ui?.getTexURL?.(0x06004cf9) ?? '';
    return { isFloaty: !!floaty && bg.includes(floaty), isClassic: !!classic && bg.includes(classic), len: bg.length };
  });
  check(`${label}-floaty-disc-art`, art.isFloaty && !art.isClassic,
    `bg matches 0x06004cc1=${art.isFloaty}, matches classic 0x06004cf9=${art.isClassic}`);

  const coord = await rectOf(page, '#radar-coord');
  if (radar && coord) {
    check(`${label}-coord-strip`, Math.abs(coord.x - radar.x) < 0.5 && Math.abs(coord.y - (radar.y + 120)) < 0.5
      && Math.abs(coord.w - 120) < 0.5 && Math.abs(coord.h - 18) < 0.5,
      `offset (${coord.x - radar.x},${coord.y - radar.y}) ${coord.w}x${coord.h} (want (0,120) 120x18)`);
  } else {
    check(`${label}-coord-strip`, false, 'coord canvas missing');
  }
  const coordText = await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { lastCoordText?: string } } }).__ac?.gameUI;
    return ui?.lastCoordText ?? '';
  });
  check(`${label}-coord-combined-format`, /^\d+\.\d[NS],\d+\.\d[EW]$/.test(coordText),
    `lastCoordText="${coordText}" (retail combined L"%.1f%s,%.1f%s", no space)`);
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
  await page.waitForTimeout(4000);

  await verifyAt(page, 1568, 775, '1568x775');

  // Lock/drag buttons — default unlocked (ACE CharacterOptions2.Default).
  const lock = await rectOf(page, '#radar-lock-button');
  const drag = await rectOf(page, '#radar-drag-button');
  const radar = await rectOf(page, '#hud-radar');
  check('lock-present', !!lock, JSON.stringify(lock));
  check('drag-present', !!drag, JSON.stringify(drag));
  if (radar && lock && drag) {
    check('lock-at-dat-pos', Math.abs(lock.x - (radar.x + 6)) < 0.5 && Math.abs(lock.y - (radar.y + 6)) < 0.5
      && Math.abs(lock.w - 27) < 0.5, `offset (${lock.x - radar.x},${lock.y - radar.y}) ${lock.w}x${lock.h}`);
    check('drag-at-dat-pos', Math.abs(drag.x - (radar.x + 87)) < 0.5 && Math.abs(drag.y - (radar.y + 6)) < 0.5
      && Math.abs(drag.w - 27) < 0.5, `offset (${drag.x - radar.x},${drag.y - radar.y}) ${drag.w}x${drag.h}`);
  }
  const lockState = () => page.evaluate(() => {
    const lockEl = document.querySelector('#radar-lock-button') as HTMLElement | null;
    const dragEl = document.querySelector('#radar-drag-button') as HTMLElement | null;
    const ui = (window as unknown as { __ac?: { gameUI?: { getTexURL?: (id: number) => string | null } } }).__ac?.gameUI;
    const bg = lockEl?.style.backgroundImage ?? '';
    const lockedUrl = ui?.getTexURL?.(0x060074b7) ?? '';
    const unlockedUrl = ui?.getTexURL?.(0x060074b8) ?? '';
    return {
      isLockedArt: !!lockedUrl && bg.includes(lockedUrl),
      isUnlockedArt: !!unlockedUrl && bg.includes(unlockedUrl),
      dragShown: dragEl ? dragEl.style.display !== 'none' : false,
    };
  });
  const stateBefore = await lockState();
  check('default-unlocked-art', stateBefore.isUnlockedArt && !stateBefore.isLockedArt,
    `unlocked art=${stateBefore.isUnlockedArt} locked art=${stateBefore.isLockedArt}`);
  check('default-drag-visible', stateBefore.dragShown, 'drag button visible while unlocked');
  await page.click('#radar-lock-button');
  await page.waitForTimeout(300);
  const stateAfter = await lockState();
  check('click-locks-art', stateAfter.isLockedArt && !stateAfter.isUnlockedArt,
    `locked art=${stateAfter.isLockedArt} unlocked art=${stateAfter.isUnlockedArt}`);
  check('click-hides-drag', !stateAfter.dragShown, 'drag button hidden while locked');
  await page.click('#radar-lock-button'); // restore unlocked
  await page.waitForTimeout(300);

  // Compass tokens at the floaty dial center for the live heading.
  const heading = await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { hud?: { headingDegrees?: number } } } }).__ac?.gameUI;
    return ui?.hud?.headingDegrees ?? -1;
  });
  check('heading-known', heading >= 0, `heading=${heading.toFixed(1)}`);
  if (heading >= 0) {
    const expected = computeCompassTokenPositions(heading);
    for (const t of RADAR_COMPASS_TOKENS) {
      const dom = await page.evaluate((k) => {
        const el = document.querySelector(`#radar-compass-${k}`) as HTMLElement | null;
        return el ? { left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) } : null;
      }, t.key);
      check(`token-${t.key}-at-formula`, !!dom
        && Math.abs(dom.left - expected[t.key].left) <= 1 && Math.abs(dom.top - expected[t.key].top) <= 1,
        `dom=${JSON.stringify(dom)} want=${JSON.stringify(expected[t.key])}`);
    }
  }

  // Dock top: inventory panel opens at radar bottom (y=140), no overlap.
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { inventoryVisible?: boolean; toggleInventory?: () => void } } }).__ac?.gameUI;
    if (ui && !ui.inventoryVisible) ui.toggleInventory?.();
  });
  await page.waitForTimeout(1500);
  const panel = await rectOf(page, '[data-panel="0x21000023"]');
  const radar2 = await rectOf(page, '#hud-radar');
  check('panel-open', !!panel, JSON.stringify(panel));
  if (panel && radar2) {
    check('dock-top-at-radar-bottom', Math.abs(panel.y - (radar2.y + radar2.h)) < 0.5,
      `panel.y=${panel.y} radar bottom=${radar2.y + radar2.h}`);
    const overlaps = panel.x < radar2.x + radar2.w && radar2.x < panel.x + panel.w
      && panel.y < radar2.y + radar2.h && radar2.y < panel.y + panel.h;
    check('panel-clear-of-radar', !overlaps, `panel=${JSON.stringify(panel)} radar=${JSON.stringify(radar2)}`);
  }
  await page.screenshot({ path: join(OUT, 'core5bb-inventory-docked-1568x775.png') });
  if (radar2) {
    await page.screenshot({
      path: join(OUT, 'core5bb-radar-crop-1568x775.png'),
      clip: { x: radar2.x - 30, y: 0, width: Math.min(150 + 30, 1568 - radar2.x + 30), height: 200 },
    });
  }

  // Repeat the geometry block at 1920x1080.
  await verifyAt(page, 1920, 1080, '1920x1080');
  await page.screenshot({ path: join(OUT, 'core5bb-full-1920x1080.png') });
  const radar3 = await rectOf(page, '#hud-radar');
  if (radar3) {
    await page.screenshot({
      path: join(OUT, 'core5bb-radar-crop-1920x1080.png'),
      clip: { x: radar3.x - 30, y: 0, width: 1920 - radar3.x + 30, height: 220 },
    });
  }

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
