/**
 * CORE.5.b live verification — EoL vitals cluster + indicator strip.
 *
 * Asserts (at 1568x775 and 1920x1080):
 *  - NO classic full-width statusbar row (#hud-statusbar gone, element
 *    0x100000e2 absent from the DOM).
 *  - #hud-vitals is the STACKED cluster by default: 160x58, top-pinned,
 *    horizontally centered (layout 0x2100006c, root-HUD child 0x100005fa,
 *    edges L3/T1/R3/B2).
 *  - The three bars (0x100000e6/ec/ee) render inside it at the DAT rows
 *    y=5/21/37.
 *  - #hud-indicators is the 150x30 strip at top-left (layout 0x21000071,
 *    root-HUD child 0x10000611) with the 7 strip buttons.
 *  - Toggling SideBySideVitals swaps in the 460x26 side-by-side cluster
 *    (layout 0x21000075), still top-center, and back.
 *  - Cluster does not overlap the radar or the indicator strip.
 *
 * Usage: npx tsx tools/verify-core5b-vitals.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5b';
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
const intersects = (a: RectInfo, b: RectInfo): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function checkViewport(page: Page, width: number, tag: string): Promise<void> {
  // Default: stacked cluster, top-center
  const cluster = await rectOf(page, '#hud-vitals');
  check(`${tag}:cluster-present`, !!cluster, JSON.stringify(cluster));
  if (cluster) {
    check(`${tag}:cluster-stacked-size`, cluster.w === 160 && cluster.h === 58, `${cluster.w}x${cluster.h} (want 160x58)`);
    check(`${tag}:cluster-top-pinned`, cluster.y === 0, `y=${cluster.y}`);
    const center = cluster.x + cluster.w / 2;
    check(`${tag}:cluster-centered`, Math.abs(center - width / 2) <= 1, `center=${center} (want ${width / 2})`);
  }
  // No classic statusbar
  const statusbar = await rectOf(page, '#hud-statusbar');
  check(`${tag}:no-statusbar-row`, statusbar === null, JSON.stringify(statusbar));
  const classicBg = await page.evaluate(() => !!document.querySelector('[data-element-id="0x100000e2"]'));
  check(`${tag}:no-classic-bg-element`, !classicBg, 'element 0x100000e2 absent');

  // Bars at the DAT rows inside the cluster
  if (cluster) {
    for (const [name, id, y] of [['health', '0x100000e6', 5], ['stamina', '0x100000ec', 21], ['mana', '0x100000ee', 37]] as const) {
      const bar = await rectOf(page, `#hud-vitals [data-element-id="${id}"]`);
      check(`${tag}:bar-${name}`, !!bar && Math.abs(bar.y - (cluster.y + y)) <= 1 && Math.abs(bar.w - 150) <= 1,
        bar ? `offset y=${bar.y - cluster.y} w=${bar.w} (want y=${y} w=150)` : 'missing');
    }
  }

  // Indicator strip top-left
  const strip = await rectOf(page, '#hud-indicators');
  check(`${tag}:strip-present`, !!strip, JSON.stringify(strip));
  if (strip) {
    check(`${tag}:strip-at-topleft`, strip.x === 0 && strip.y === 0 && strip.w === 150 && strip.h === 30,
      `(${strip.x},${strip.y}) ${strip.w}x${strip.h} (want (0,0) 150x30)`);
  }
  // CORE.5.b role-corrected buttons (decompiled element classes) + logout X.
  const stripIcons = await page.evaluate(() =>
    ['connection', 'effects-beneficial', 'effects-harmful', 'vitae', 'burden', 'minigame', 'logout']
      .filter((id) => !!document.getElementById(`hud-indicator-${id}`)).length);
  check(`${tag}:strip-buttons`, stripIcons === 7, `${stripIcons}/7 strip buttons present (6 indicators + logout X)`);

  // No overlaps: cluster vs radar, cluster vs strip
  const radar = await rectOf(page, '#hud-radar');
  if (cluster && radar) check(`${tag}:cluster-clear-of-radar`, !intersects(cluster, radar), `cluster=${JSON.stringify(cluster)} radar=${JSON.stringify(radar)}`);
  if (cluster && strip) check(`${tag}:cluster-clear-of-strip`, !intersects(cluster, strip), `cluster=${JSON.stringify(cluster)} strip=${JSON.stringify(strip)}`);
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

  await checkViewport(page, 1568, '1568');
  await page.screenshot({ path: join(OUT, 'core5b-vitals-stacked-1568.png') });

  // Toggle SideBySideVitals → 460x26 side-by-side cluster
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { optionsSettings: Record<string, unknown>; refreshVitalsCluster: () => void } } }).__ac?.gameUI;
    if (ui) { ui.optionsSettings.sideBySideVitals = true; ui.refreshVitalsCluster(); }
  });
  await page.waitForTimeout(1000);
  const sbs = await rectOf(page, '#hud-vitals');
  check('sbs-size', !!sbs && sbs.w === 460 && sbs.h === 26, sbs ? `${sbs.w}x${sbs.h} (want 460x26)` : 'missing');
  if (sbs) {
    check('sbs-centered', Math.abs((sbs.x + sbs.w / 2) - 1568 / 2) <= 1, `center=${sbs.x + sbs.w / 2}`);
    check('sbs-top-pinned', sbs.y === 0, `y=${sbs.y}`);
  }
  const sbsCount = await page.evaluate(() => document.querySelectorAll('#hud-vitals').length);
  check('sbs-single-instance', sbsCount === 1, `${sbsCount} cluster windows`);
  await page.screenshot({ path: join(OUT, 'core5b-vitals-sidebyside-1568.png') });

  // Toggle back to stacked
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { optionsSettings: Record<string, unknown>; refreshVitalsCluster: () => void } } }).__ac?.gameUI;
    if (ui) { ui.optionsSettings.sideBySideVitals = false; ui.refreshVitalsCluster(); }
  });
  await page.waitForTimeout(500);
  const back = await rectOf(page, '#hud-vitals');
  check('toggle-back-stacked', !!back && back.w === 160 && back.h === 58, back ? `${back.w}x${back.h}` : 'missing');

  // 1920x1080 pass (reference viewport for reddit-shutdown.jpg comparison)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(1500);
  await checkViewport(page, 1920, '1080p');
  await page.screenshot({ path: join(OUT, 'core5b-vitals-stacked-1080.png') });

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
