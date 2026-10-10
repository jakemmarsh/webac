/**
 * verify-core4a-statusbar-gap — CORE.4.a live verification harness.
 *
 * Logs into the local ACE stack headlessly and verifies the status-bar row
 * background (0x21000013 element 0x100000e2, media 0x06004ce4) paints behind
 * the vitals inter-bar gaps:
 *
 *   1. DOM: the statusbar's embedded vitals/indicators subtree anchors
 *      (0x100000e3/0x100000e4 — inert unscaled duplicates) are hidden.
 *   2. DOM: the statusbar root carries the same scaleX transform as the
 *      vitals root, so the 800x28 background spans the whole scaled row.
 *   3. PIXELS: sampling the screenshot inside the stamina→mana DAT gap
 *      (vitals layout x 530–540) finds the opaque dark row background —
 *      not the bright artifact (misplaced indicator icon + status-text
 *      fragment) that used to leak through.
 *
 * Usage:  npx tsx tools/verify-core4a-statusbar-gap.ts
 * Output: verification/core4a-statusbar-gap/*.png + result lines on stdout.
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core4a-statusbar-gap');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core4a';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
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

/** Decode a PNG buffer in-page (the browser has a real 2D canvas) and sample pixels. */
async function samplePixels(
  page: Page, png: Buffer, points: Array<{ x: number; y: number }>,
): Promise<Array<{ x: number; y: number; r: number; g: number; b: number }>> {
  const b64 = png.toString('base64');
  return page.evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ${JSON.stringify(points)}.map((p) => {
      const d = ctx.getImageData(p.x, p.y, 1, 1).data;
      return { x: p.x, y: p.y, r: d[0], g: d[1], b: d[2] };
    });
  })()`) as Promise<Array<{ x: number; y: number; r: number; g: number; b: number }>>;
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

  console.log(`[core4a] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core4a] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core4a] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world within 360s — see _login-failed.png');
  }
  console.log('[core4a] in world — letting HUD settle (5s)…');
  await page.waitForTimeout(5000);

  const failures: string[] = [];
  const expect = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
    if (!cond) failures.push(msg);
  };

  // ── 1. DOM: embed anchors hidden, statusbar root scaled like vitals ──
  const dom = await page.evaluate(`(() => {
    const one = (id) => document.querySelector('[data-element-id="' + id + '"]');
    const e3 = one('0x100000e3'), e4 = one('0x100000e4'), e2 = one('0x100000e2');
    const statusRoot = document.querySelector('[data-layout-id="0x21000013"]');
    const vitalsRoot = document.querySelector('[data-layout-id="0x21000014"]');
    return {
      e2Painted: !!(e2 && getComputedStyle(e2).backgroundImage !== 'none'),
      e3Hidden: !!(e3 && getComputedStyle(e3).display === 'none'),
      e4Hidden: !!(e4 && getComputedStyle(e4).display === 'none'),
      statusTransform: statusRoot ? statusRoot.style.transform : null,
      vitalsTransform: vitalsRoot ? vitalsRoot.style.transform : null,
      statusText: statusRoot ? statusRoot.querySelectorAll('.layout-text').length : -1,
    };
  })()`) as {
    e2Painted: boolean; e3Hidden: boolean; e4Hidden: boolean;
    statusTransform: string | null; vitalsTransform: string | null; statusText: number;
  };
  console.log(`[core4a] dom: ${JSON.stringify(dom)}`);
  expect(dom.e2Painted, 'row background 0x100000e2 paints (background-image set)');
  expect(dom.e3Hidden, 'embedded vitals anchor 0x100000e3 hidden');
  expect(dom.e4Hidden, 'embedded indicators anchor 0x100000e4 hidden');
  expect(!!dom.statusTransform && dom.statusTransform === dom.vitalsTransform,
    `statusbar root scaleX matches vitals root (${dom.statusTransform})`);
  expect(dom.statusText === 0, 'no text rendered inside the statusbar layout');

  // ── 2. PIXELS: the stamina→mana DAT gap shows the dark row background ──
  // The painted (scaled) vitals instance is the LAST match for each bar id.
  const stamBox = await page.locator('[data-element-id="0x100000ec"]').last().boundingBox();
  const manaBox = await page.locator('[data-element-id="0x100000ee"]').last().boundingBox();
  if (!stamBox || !manaBox) throw new Error('vital bar elements not found');
  const gapL = stamBox.x + stamBox.width;
  const gapR = manaBox.x;
  console.log(`[core4a] stamina ends ${gapL.toFixed(1)}, mana starts ${gapR.toFixed(1)} (gap ${(gapR - gapL).toFixed(1)}px)`);
  expect(gapR - gapL > 2, 'a real inter-bar gap exists to sample (DAT x 530-540)');

  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: VIEW.width, height: 36 } });
  const xs = [0.25, 0.5, 0.75].map((f) => Math.round(gapL + (gapR - gapL) * f));
  const samples = await samplePixels(page, shot, xs.flatMap((x) => [{ x, y: 8 }, { x, y: 14 }, { x, y: 20 }]));
  for (const s of samples) console.log(`  gap pixel (${s.x},${s.y}) rgb(${s.r},${s.g},${s.b})`);
  // 0x06004ce4 row: dark warm browns (sampled row y=14: r 17-55, g 7-37, b 1-17).
  // The old artifact was a bright/blue indicator-icon + text fragment.
  const allDark = samples.every((s) => s.r <= 100 && s.g <= 90 && s.b <= 80);
  const noneBlue = samples.every((s) => s.b <= s.r + 25);
  expect(allDark, 'all gap samples are dark (opaque statusbar background, no 3D/artifact bleed)');
  expect(noneBlue, 'no blue-dominant gap samples (the old artifact was a blue box)');

  await page.screenshot({ path: join(OUT, 'topbar-after.png'), clip: { x: 0, y: 0, width: VIEW.width, height: 36 } });
  await page.screenshot({ path: join(OUT, 'gap-zoom-after.png'), clip: { x: Math.max(0, gapL - 120), y: 0, width: 300, height: 36 } });
  await page.screenshot({ path: join(OUT, 'full-after.png') });
  console.log('[core4a] screenshots written to verification/core4a-statusbar-gap/');

  await browser.close();
  if (failures.length) {
    console.log(`\n[core4a] ${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[core4a] ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
