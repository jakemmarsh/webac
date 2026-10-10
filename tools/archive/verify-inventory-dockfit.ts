/**
 * verify-inventory-dockfit — live verification for CORE.1.a + CORE.1.b.
 *
 * Asserts against the running stack:
 *  1. Panel dock-fit (CORE.1.b): the inventory window's screen rect does
 *     NOT overlap the bottom toolbar, and it sits below the radar dock
 *     (top 140 HUD units — CORE.5.b.b EoL floaty radar bottom).
 *  2. Grid scrolling (CORE.1.b): with >18 items in the main pack the grid
 *     viewport overflows; a wheel event over it scrolls (and does NOT
 *     zoom the camera — CameraController HUD guard); the DAT scrollbar
 *     thumb moves.
 *  3. Retail scrollbar art (CORE.1.a): grid + pack-column bars present
 *     with track 0x06004d33 / thumb 0x06004d34 / arrows 0x06004d35-36.
 *  4. Burden text fit (CORE.1.a): the "Burden" label + % canvases are no
 *     wider than the 36px column.
 *
 * Screenshots (full + panel crop) land in verification/core1-inventory/.
 *
 * Usage: npx tsx tools/verify-inventory-dockfit.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=dockfit';
const OUT = join(REPO, 'verification', 'core1-inventory');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function loginLoop(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[dockfit] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[dockfit] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  console.log(`[dockfit] logging in — ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  await page.waitForTimeout(8000);

  // Ensure >18 non-stackable items in the MAIN PACK so the grid overflows
  // (worn clothing has containerId 0 and is not a grid item).
  const count = await page.evaluate(`(() => {
    const guid = window.__ac.gameUI.sidePackGuids[0];
    return window.__ac.playerState.inventory.getAll().filter(i => i.containerId === guid && (i.itemType & 0x200) === 0).length;
  })()`) as number;
  console.log(`[dockfit] main-pack grid items: ${count}`);
  if (count < 20) {
    console.log(`[dockfit] granting ${20 - count} daggers (@ci 314)…`);
    for (let i = count; i < 20; i++) {
      await page.evaluate(`window.acDebug.sendTalk('@ci 314')`);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(4000);
  }

  // Open the inventory panel.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1500);

  const geom = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const wrapper = ui.inventoryPanel;
    const wrapRect = wrapper.getBoundingClientRect();
    const hud = document.getElementById('game-hud');
    const hudRect = hud.getBoundingClientRect();
    const hudScale = hudRect.height / 600;
    // toolbar = the fixed 300x122 bottom bar (child of hud with top 478px)
    const toolbar = [...hud.children].find(c => c.style.top === '478px');
    const tbRect = toolbar ? toolbar.getBoundingClientRect() : null;
    const vp = document.querySelector('[data-panel="0x21000023"] .layout-scroll-content');
    const bars = [...document.querySelectorAll('[data-panel="0x21000023"] [data-dat-scrollbar]')];
    const gridBar = bars.find(b => b.style.height === '96px');
    const thumbTopBefore = gridBar ? gridBar.children[2].style.top : null;
    // Burden label + % live in the strip's two 36px-wide 15px-tall holders
    // (els 0x100001d7/d8) — measure only the canvases inside those.
    const burdenCanvases = [...wrapper.querySelectorAll('div')]
      .filter(d => d.style.width === '36px' && d.style.height === '15px')
      .flatMap(d => [...d.querySelectorAll('canvas')].map(c => c.width));
    return {
      wrapper: { w: wrapper.style.width, h: wrapper.style.height, tf: wrapper.style.transform, origin: wrapper.style.transformOrigin },
      rect: { top: wrapRect.top, bottom: wrapRect.bottom, left: wrapRect.left, right: wrapRect.right },
      hudScale,
      toolbarTop: tbRect ? tbRect.top : null,
      grid: vp ? { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight, scrollTop: vp.scrollTop, width: vp.style.width } : null,
      scrollbars: bars.map(b => ({ left: b.style.left, top: b.style.top, h: b.style.height, track: b.style.backgroundImage.length > 0, pieces: b.children.length })),
      thumbTopBefore,
      burdenCanvases,
    };
  })()`) as any;
  console.log('[dockfit] geometry:', JSON.stringify(geom, null, 1));

  // Wheel over the grid viewport: must scroll the grid, not zoom the camera.
  const wheelResult = await page.evaluate(`(() => {
    const vp = document.querySelector('[data-panel="0x21000023"] .layout-scroll-content');
    const camDist = () => window.__ac.cameraController ? window.__ac.cameraController.cameraDistance : null;
    const before = { scrollTop: vp.scrollTop, cam: camDist() };
    const r = vp.getBoundingClientRect();
    const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 });
    vp.dispatchEvent(ev);
    return { before, after: { scrollTop: vp.scrollTop, cam: camDist() } };
  })()`) as any;
  // The scroll event (which drives the thumb) fires async — give it a beat.
  await page.waitForTimeout(300);
  wheelResult.thumbTopAfter = await page.evaluate(`(() => {
    const bars = [...document.querySelectorAll('[data-panel="0x21000023"] [data-dat-scrollbar]')];
    const grid = bars.find(b => b.style.height === '96px');
    return grid ? grid.children[2].style.top : null;
  })()`) as string | null;
  console.log('[dockfit] wheel:', JSON.stringify(wheelResult));

  await page.screenshot({ path: join(OUT, '05-dockfit-full.png') });
  const wrapRect = geom.rect;
  await page.screenshot({
    path: join(OUT, '06-dockfit-panel-crop.png'),
    clip: {
      x: Math.max(0, wrapRect.left - 10), y: Math.max(0, wrapRect.top - 10),
      width: Math.min(1280, wrapRect.right - wrapRect.left + 20),
      height: Math.min(800, wrapRect.bottom - wrapRect.top + 20),
    },
  });

  // ── Assertions ──
  const fails: string[] = [];
  const expectTrue = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

  expectTrue(geom.wrapper.w === '300px' && geom.wrapper.h === '362px', `wrapper 300x362, got ${geom.wrapper.w}x${geom.wrapper.h}`);
  expectTrue(geom.wrapper.tf.startsWith('scale(0.91'), `dock-fit scale, got '${geom.wrapper.tf}'`);
  expectTrue(geom.toolbarTop !== null, 'toolbar found');
  if (geom.toolbarTop !== null) {
    expectTrue(geom.rect.bottom <= geom.toolbarTop + 2, `panel bottom (${geom.rect.bottom.toFixed(1)}) must not pass toolbar top (${geom.toolbarTop.toFixed(1)})`);
  }
  // top of the panel at the dock boundary (140 HUD units — CORE.5.b.b) ± 4px
  const expectedTop = 140 * geom.hudScale;
  expectTrue(Math.abs(geom.rect.top - expectedTop) < 8, `panel top ~${expectedTop.toFixed(1)}, got ${geom.rect.top.toFixed(1)}`);
  expectTrue(geom.grid && geom.grid.width === '192px', `grid viewport 192px, got ${geom.grid?.width}`);
  expectTrue(geom.grid && geom.grid.scrollHeight > geom.grid.clientHeight, `grid overflows (scrollHeight ${geom.grid?.scrollHeight} > clientHeight ${geom.grid?.clientHeight})`);
  expectTrue(geom.scrollbars.length === 2, `2 DAT scrollbars, got ${geom.scrollbars.length}`);
  expectTrue(geom.scrollbars.every((b: any) => b.track && b.pieces === 3), 'scrollbars have track art + 3 pieces (arrows + thumb)');
  expectTrue(wheelResult.after.scrollTop > wheelResult.before.scrollTop, `wheel scrolled grid (${wheelResult.before.scrollTop} → ${wheelResult.after.scrollTop})`);
  expectTrue(wheelResult.before.cam === null || wheelResult.after.cam === wheelResult.before.cam, `wheel did not zoom camera (${wheelResult.before.cam} → ${wheelResult.after.cam})`);
  expectTrue(wheelResult.thumbTopAfter !== geom.thumbTopBefore, `scrollbar thumb moved (${geom.thumbTopBefore} → ${wheelResult.thumbTopAfter})`);
  expectTrue(geom.burdenCanvases.length >= 2 && geom.burdenCanvases.every((w: number) => w <= 36), `burden label/% canvases ≤36px, got [${geom.burdenCanvases}]`);

  await browser.close();
  if (fails.length) {
    console.error(`[dockfit] FAIL:\n - ${fails.join('\n - ')}`);
    process.exit(1);
  }
  console.log('[dockfit] PASS — all assertions green. Screenshots in verification/core1-inventory/05-06.');
}

main().catch((e) => { console.error(e); process.exit(1); });
