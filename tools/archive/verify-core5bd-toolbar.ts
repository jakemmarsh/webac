/**
 * CORE.5.b.d live verification — EoL floaty toolbar window family.
 *
 * Asserts (at 1568x775 and 1920x1080):
 *  - #hud-toolbar-window is 310x100 pinned bottom-right FLUSH (root HUD
 *    0x21000005 child 0x10000603 at (490,500), edges L2/T2/R1/B1).
 *  - The content viewport sits at (5,5) 300x90 (window inner area), with
 *    the classic 300x122 content pinned to its top and cropped: shortcut
 *    row 1 (y=58) fully visible, row 2 (y=90) clipped away at default.
 *  - 18 shortcut slot elements exist (two rows of 9).
 *  - Floaty chrome: interactive drag (type 2) + bottom resize (type 9)
 *    borders visible while the UI is unlocked, the locked border art
 *    (0x060074bf-c6) hidden — and the swap flips with LockUI.
 *  - Dragging the top border moves the window (persisted under WindowID
 *    10); dragging the bottom resize border grows it, clamped to maxH 132
 *    (p60), revealing shortcut row 2; width stays 310 (p63=p61).
 *  - The inventory dock panel bottom rides the toolbar window top
 *    (screenH - 100).
 *
 * Usage: npx tsx tools/verify-core5bd-toolbar.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5bd';
const OUT = join(__dir, '..', 'verification', 'core5bd-toolbar');

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

async function checkDefault(page: Page, vw: number, vh: number, tag: string): Promise<void> {
  const win = await rectOf(page, '#hud-toolbar-window');
  check(`${tag}:window-present`, !!win, JSON.stringify(win));
  if (win) {
    check(`${tag}:window-310x100`, Math.abs(win.w - 310) < 2 && Math.abs(win.h - 100) < 2, `${win.w}x${win.h}`);
    check(`${tag}:window-bottom-right-flush`,
      Math.abs(win.x + win.w - vw) < 2 && Math.abs(win.y + win.h - vh) < 2,
      `right gap ${vw - win.x - win.w}, bottom gap ${vh - win.y - win.h}`);
  }
  const vp = await rectOf(page, '#hud-toolbar-viewport');
  check(`${tag}:viewport-300x90-at-5-5`, !!vp && !!win
    && Math.abs(vp.x - win.x - 5) < 1 && Math.abs(vp.y - win.y - 5) < 1
    && Math.abs(vp.w - 300) < 1 && Math.abs(vp.h - 90) < 1,
    vp && win ? `offset (${vp.x - win.x},${vp.y - win.y}) ${vp.w}x${vp.h}` : 'missing');

  // Content pinned to the viewport top; slot row 1 fully inside, row 2 clipped.
  const slots = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const arr = (ui && ui.itemShortcutSlots) || [];
    return arr.map((el) => { const r = el.getBoundingClientRect(); return { y: r.y, h: r.height }; });
  })()`) as Array<{ y: number; h: number }>;
  check(`${tag}:18-slots`, slots.length === 18, `${slots.length} slot elements`);
  if (vp && slots.length === 18) {
    const vpBottom = vp.y + vp.h;
    check(`${tag}:row1-visible`, slots[0].y + slots[0].h <= vpBottom + 1,
      `row1 bottom ${slots[0].y + slots[0].h} vs viewport bottom ${vpBottom}`);
    check(`${tag}:row2-clipped`, slots[9].y >= vpBottom - 1,
      `row2 top ${slots[9].y} vs viewport bottom ${vpBottom}`);
  }

  // Chrome while unlocked: interactive borders shown, locked art hidden.
  const chrome = await page.evaluate(`(() => {
    const q = (id) => {
      const el = document.querySelector('#hud-toolbar-window [data-element-id="' + id + '"]');
      return el ? getComputedStyle(el).display : null;
    };
    return { lockedTop: q('0x10000624'), dragTop: q('0x1000062c'), resizeBottom: q('0x10000630') };
  })()`) as { lockedTop: string | null; dragTop: string | null; resizeBottom: string | null };
  check(`${tag}:unlocked-chrome`, chrome.lockedTop === 'none' && chrome.dragTop !== 'none' && chrome.resizeBottom !== 'none',
    JSON.stringify(chrome));
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

  await checkDefault(page, 1568, 775, '1568');
  await page.screenshot({ path: join(OUT, 'toolbar-default-1568x775.png') });

  // LockUI swap — locked art shows, interactive borders hide.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.optionsSettings.lockUI = true;
    ui.updateRadarLockedStatus();
  })()`);
  const lockedChrome = await page.evaluate(`(() => {
    const q = (id) => {
      const el = document.querySelector('#hud-toolbar-window [data-element-id="' + id + '"]');
      return el ? getComputedStyle(el).display : null;
    };
    return { lockedTop: q('0x10000624'), dragTop: q('0x1000062c'), resizeBottom: q('0x10000630') };
  })()`) as { lockedTop: string | null; dragTop: string | null; resizeBottom: string | null };
  check('lockui-swap', lockedChrome.lockedTop !== 'none' && lockedChrome.dragTop === 'none' && lockedChrome.resizeBottom === 'none',
    JSON.stringify(lockedChrome));
  await page.screenshot({ path: join(OUT, 'toolbar-locked-1568x775.png') });
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.optionsSettings.lockUI = false;
    ui.updateRadarLockedStatus();
  })()`);

  // Drag by the top border: move up-left 120,160.
  const dragBar = await rectOf(page, '#hud-toolbar-window [data-element-id="0x1000062c"]');
  check('dragbar-present', !!dragBar, JSON.stringify(dragBar));
  const before = await rectOf(page, '#hud-toolbar-window');
  if (dragBar && before) {
    await page.mouse.move(dragBar.x + dragBar.w / 2, dragBar.y + dragBar.h / 2);
    await page.mouse.down();
    await page.mouse.move(dragBar.x + dragBar.w / 2 - 120, dragBar.y + dragBar.h / 2 - 160, { steps: 8 });
    await page.mouse.up();
    const after = await rectOf(page, '#hud-toolbar-window');
    check('drag-moves-window', !!after && Math.abs(after.x - (before.x - 120)) < 3 && Math.abs(after.y - (before.y - 160)) < 3,
      `before (${before.x},${before.y}) after (${after?.x},${after?.y})`);
    const persisted = await page.evaluate(`(() => {
      const ui = window.__ac && window.__ac.gameUI;
      return (ui && ui.floatyWindowGeometry && ui.floatyWindowGeometry.get(10)) || null;
    })()`) as { x?: number; y?: number } | null;
    check('drag-persists-windowid-10', !!persisted && typeof persisted.x === 'number' && typeof persisted.y === 'number',
      JSON.stringify(persisted));
  }

  // Resize by the bottom border: +60 clamps to maxH 132; width stays 310.
  const resizeBar = await rectOf(page, '#hud-toolbar-window [data-element-id="0x10000630"]');
  check('resizebar-present', !!resizeBar, JSON.stringify(resizeBar));
  if (resizeBar) {
    await page.mouse.move(resizeBar.x + resizeBar.w / 2, resizeBar.y + resizeBar.h / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBar.x + resizeBar.w / 2, resizeBar.y + resizeBar.h / 2 + 60, { steps: 8 });
    await page.mouse.up();
    const grown = await rectOf(page, '#hud-toolbar-window');
    check('resize-clamps-132', !!grown && Math.abs(grown.h - 132) < 2 && Math.abs(grown.w - 310) < 2,
      grown ? `${grown.w}x${grown.h}` : 'missing');
    const vp = await rectOf(page, '#hud-toolbar-viewport');
    check('resize-viewport-122', !!vp && Math.abs(vp.h - 122) < 2, vp ? `${vp.h}` : 'missing');
    const row2 = await page.evaluate(`(() => {
      const ui = window.__ac && window.__ac.gameUI;
      const el = ui && ui.itemShortcutSlots && ui.itemShortcutSlots[9];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: r.y, h: r.height };
    })()`) as { y: number; h: number } | null;
    check('resize-reveals-row2', !!vp && !!row2 && row2.y + row2.h <= vp.y + vp.h + 1,
      vp && row2 ? `row2 bottom ${row2.y + row2.h} vs viewport bottom ${vp.y + vp.h}` : 'missing');
    await page.screenshot({ path: join(OUT, 'toolbar-resized-132.png') });
  }

  // Fresh state (clear persisted geometry) → inventory dock bottom rides toolbar top.
  await page.evaluate(`(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } })()`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(4000);
  await page.evaluate(`window.__ac.gameUI.toggleInventory()`);
  await page.waitForTimeout(1500);
  const invPanel = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const root = ui && ui.inventoryPanelHandle && ui.inventoryPanelHandle.root
      && ui.inventoryPanelHandle.root.parentElement;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`) as RectInfo | null;
  const win = await rectOf(page, '#hud-toolbar-window');
  check('dock-bottom-rides-toolbar-top', !!invPanel && !!win && Math.abs((invPanel.y + invPanel.h) - win.y) <= 2,
    `panel bottom ${invPanel ? invPanel.y + invPanel.h : '-'} vs toolbar window top ${win?.y}`);
  // CORE.5.b.d regression fix — updateToolbarActiveStates repaints tb-inv
  // from dataset textures; pre-fix the first panel toggle wiped the
  // backpack art to a bare dark block.
  const invBtnBg = await page.evaluate(`(() => {
    const el = document.getElementById('tb-inv');
    return el ? el.style.backgroundImage : null;
  })()`) as string | null;
  check('inv-button-keeps-backpack-art', !!invBtnBg && invBtnBg.includes('url('), String(invBtnBg).slice(0, 60));
  await page.screenshot({ path: join(OUT, 'toolbar-with-inventory-1568x775.png') });

  // 1920x1080 pass (reference viewport for reddit-shutdown.jpg comparison).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(2500);
  await checkDefault(page, 1920, 1080, '1080');
  await page.screenshot({ path: join(OUT, 'toolbar-default-1920x1080.png') });

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
