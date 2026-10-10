/**
 * verify-core4-vitals-toggle — CORE.4 live verification harness.
 *
 * Logs into the local ACE stack headlessly, enters the world, and drives the
 * retail vitals presentation toggle (gmVitalsUI::ListenToElementMessage @
 * 004bfc00: click toggles element states 0x10000006 numeric / 0x10000007
 * icons). Asserts the two presentations are EXCLUSIVE in the DOM (ornaments
 * XOR numeric labels) and captures cropped top-bar screenshots for the
 * side-by-side vs reference/images/hud/chat-panel.jpg (numeric) and
 * rawg_01/rawg_07.jpg (icons).
 *
 * Usage:  npx tsx tools/verify-core4-vitals-toggle.ts
 * Output: verification/core4-vitals-toggle/*.png + result lines on stdout.
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(__dir, '..', 'verification', 'core4-vitals-toggle');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core4';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Virgin-account handling — same scripted create as measure-perf.ts. */
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

interface VitalsDomState {
  ornaments: { total: number; visible: number };
  labels: { total: number; visible: number };
  bothShown: boolean;
  neitherShown: boolean;
}

/** Inspect the live DOM: how many ornament / numeric-label elements render?
 *
 * Scoped to the PAINTED vitals instance: the statusbar layout 0x21000013
 * embeds the whole vitals subtree by base-inheritance (element 0x100000e3,
 * baseElement=0x100000e5 baseLayout=0x21000014 — DAT ground truth), so a
 * second, inert copy of every vitals element exists in the DOM with blank
 * base textures and no text. Only the GameUI vitalsHandle instance gets the
 * lit ornament textures painted (inline background-image) and setText'd
 * labels — filter on that, and use offsetParent (null under a display:none
 * ancestor) rather than computed display, which ignores hidden ancestors.
 *
 * Source string, not a function — tsx's esbuild transform injects a `__name`
 * helper into evaluated functions that doesn't exist in the page (same
 * landmine measure-perf.ts documents on sampleFrames). */
async function vitalsState(page: Page): Promise<VitalsDomState> {
  return page.evaluate(`(() => {
    const vis = (el) => el.offsetParent !== null &&
      getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const orns = Array.from(document.querySelectorAll('[data-element-id="0x100004a9"]'))
      .filter((el) => el.style.backgroundImage);
    const labels = ['0x100000eb', '0x100000ed', '0x100000ef']
      .flatMap((id) => Array.from(document.querySelectorAll('[data-element-id="' + id + '"]')))
      .filter((el) => el.childNodes.length > 0 || (el.textContent || '').length > 0);
    const ornVisible = orns.filter(vis).length;
    const labVisible = labels.filter(vis).length;
    return {
      ornaments: { total: orns.length, visible: ornVisible },
      labels: { total: labels.length, visible: labVisible },
      bothShown: ornVisible > 0 && labVisible > 0,
      neitherShown: ornVisible === 0 && labVisible === 0,
    };
  })()`) as Promise<VitalsDomState>;
}

async function topBarShot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: join(OUT, name),
    clip: { x: 0, y: 0, width: VIEW.width, height: 34 },
  });
  console.log(`[core4] ${name}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  console.log(`[core4] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (same as capture-ui-screens.ts / measure-perf.ts).
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core4] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core4] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch {
        /* keep polling */
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world within 360s — see _login-failed.png');
  }
  console.log('[core4] in world — letting vitals settle (5s)…');
  await page.waitForTimeout(5000);

  const failures: string[] = [];
  const expect = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
    if (!cond) failures.push(msg);
  };

  // ── 1. Default presentation (DAT defaultState=0x0 → base → numeric) ──
  const def = await vitalsState(page);
  console.log(`[core4] default state: ${JSON.stringify(def)}`);
  expect(def.labels.visible > 0, 'default shows numeric labels (chat-panel.jpg mode)');
  expect(def.ornaments.visible === 0, 'default hides ornaments (exclusive)');
  expect(!def.bothShown, 'default never shows both at once (the CORE.4 defect)');
  await topBarShot(page, '1-default-numeric.png');
  await page.screenshot({ path: join(OUT, '1-default-full.png') });

  // ── 2. First click: retail formula from base is SetState((0==6)+6) = 6 —
  //      numeric → numeric, NO visual change (decomp @ 004bfc00 semantics). ──
  const healthBox = await page.locator('[data-element-id="0x100000e6"]').last().boundingBox();
  if (!healthBox) throw new Error('health bar element 0x100000e6 not found');
  const cx = healthBox.x + healthBox.width / 2;
  const cy = healthBox.y + healthBox.height / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  const afterFirst = await vitalsState(page);
  console.log(`[core4] after click 1 (base→6): ${JSON.stringify(afterFirst)}`);
  expect(afterFirst.labels.visible > 0 && afterFirst.ornaments.visible === 0,
    'first click from base keeps numeric (retail SetState((0==6)+6)=6, no visual change)');
  await topBarShot(page, '2-after-first-click-numeric.png');

  // ── 3. Second click: 6 → 7 = icon mode (lit ornaments, no numbers) ──
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  const icons = await vitalsState(page);
  console.log(`[core4] after click 2 (6→7): ${JSON.stringify(icons)}`);
  expect(icons.ornaments.visible > 0, 'second click swaps to lit ornaments (rawg_07.jpg mode)');
  expect(icons.labels.visible === 0, 'icon mode hides numeric labels (exclusive)');
  expect(!icons.bothShown, 'icon mode never shows both at once');
  await topBarShot(page, '3-toggled-icons.png');
  await page.screenshot({ path: join(OUT, '3-toggled-full.png') });

  // ── 4. Right-click toggles back → numeric (retail msg 0x1c dwParam1 10) ──
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.waitForTimeout(300);
  const back = await vitalsState(page);
  console.log(`[core4] after right-click (7→6): ${JSON.stringify(back)}`);
  expect(back.labels.visible > 0, 'right-click returns to numeric labels');
  expect(back.ornaments.visible === 0, 'numeric mode hides ornaments again');
  await topBarShot(page, '4-toggled-back-numeric.png');

  // ── 4. Side-by-side sheets vs retail (stacked rows — bars are wide/short) ──
  await composeSheet(browser, 'side-by-side-numeric.png', [
    [join(REPO, 'reference/images/hud/chat-panel.jpg'), 'image/jpeg', 'RETAIL chat-panel.jpg (numeric mode — white cur/max, no icons)'],
    [join(OUT, '1-default-numeric.png'), 'image/png', 'OURS default (top-bar crop) — numeric labels, ornaments hidden'],
  ]);
  await composeSheet(browser, 'side-by-side-icons.png', [
    [join(REPO, 'reference/images/hud/rawg_07.jpg'), 'image/jpeg', 'RETAIL rawg_07.jpg (icon mode — heart/sword/swirl, no numbers)'],
    [join(OUT, '3-toggled-icons.png'), 'image/png', 'OURS after second click (top-bar crop) — lit ornaments, labels hidden'],
  ]);

  await browser.close();
  if (failures.length) {
    console.log(`[core4] RESULT: FAIL (${failures.length} assertion(s))`);
    process.exit(1);
  }
  console.log('[core4] RESULT: PASS — exclusive presentations + working toggle verified live');
}

/** Compose a stacked comparison sheet in a fresh page (data URLs, no CSP issues). */
async function composeSheet(
  browser: Browser, out: string,
  rows: Array<[path: string, mime: string, label: string]>,
): Promise<void> {
  const figs = rows.map(([p, mime, label]) => {
    const src = `data:${mime};base64,${readFileSync(p).toString('base64')}`;
    return `<figure style="margin:6px"><figcaption>${label}</figcaption><img src="${src}" style="width:1550px"></figure>`;
  }).join('');
  const sheet = await browser.newPage({ viewport: { width: 1568, height: 900 } });
  await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;display:flex;flex-direction:column;font-family:monospace;font-size:13px;color:#fff">${figs}</body>`);
  await sheet.waitForTimeout(400);
  await sheet.screenshot({ path: join(OUT, out), fullPage: true });
  await sheet.close();
  console.log(`[core4] wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
