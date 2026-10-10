/**
 * CORE.4 live verification — vitals bars show ONE presentation at a time
 * (lit heart/sword/swirl ornaments in state 0x10000007, numeric cur/max
 * labels otherwise), toggled by left/right click per
 * gmVitalsUI::ListenToElementMessage @ 004bfc00, driven against the running
 * ACE stack.
 *
 * Usage: npx tsx tools/verify-core4-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core4';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core4');

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
    ui.wizard.name = 'Vitals Tester';
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

/**
 * Probe the vitals presentation: visibility of the six ornament instances
 * (0x100004a9, two per bar) and the three numeric labels (0x100000eb/ed/ef),
 * plus the label text and the DAT defaultState the seed came from.
 */
const probeVitals = `(() => {
  const vis = (el) => !!el && el.style.display !== 'none' && el.offsetParent !== null;
  const orns = Array.from(document.querySelectorAll('[data-element-id="0x100004a9"]'));
  const labels = ['0x100000eb', '0x100000ed', '0x100000ef']
    .map(id => document.querySelector('[data-element-id="' + id + '"]'));
  const ui = window.__ac && window.__ac.gameUI;
  const desc = ui && ui.vitalsHandle && ui.vitalsHandle.descs ? ui.vitalsHandle.descs.get(0x100000e5) : null;
  return {
    ornCount: orns.length,
    ornVisible: orns.filter(vis).length,
    labelVisible: labels.filter(vis).length,
    labelTexts: labels.map(el => el ? (el.textContent || '').trim() : null),
    displayState: ui ? ui.vitalsDisplayState : null,
    datDefaultState: desc ? desc.defaultState : null,
  };
})`;

const clickVitals = `((type) => {
  const bar = document.querySelector('[data-element-id="0x100000e6"]');
  if (!bar) return 'no-bar';
  bar.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  return 'ok';
})`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[core4] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core4] in world — settling…');
  await page.waitForTimeout(10_000);

  const barClip = { x: 0, y: 0, width: VIEW.width, height: 34 };

  // ── 1. Initial presentation (seeded from the DAT defaultState) ──
  const initial = await page.evaluate(`(${probeVitals})()`);
  console.log('[core4] initial:', JSON.stringify(initial));
  await page.screenshot({ path: join(OUT, '01-initial.png'), clip: barClip });

  // ── 2. Left click → toggle ──
  console.log('[core4] left click:', await page.evaluate(`(${clickVitals})('click')`));
  await page.waitForTimeout(300);
  const afterClick = await page.evaluate(`(${probeVitals})()`);
  console.log('[core4] after left click:', JSON.stringify(afterClick));
  await page.screenshot({ path: join(OUT, '02-after-left-click.png'), clip: barClip });

  // ── 3. Right click (contextmenu) → toggle back ──
  console.log('[core4] right click:', await page.evaluate(`(${clickVitals})('contextmenu')`));
  await page.waitForTimeout(300);
  const afterRight = await page.evaluate(`(${probeVitals})()`);
  console.log('[core4] after right click:', JSON.stringify(afterRight));
  await page.screenshot({ path: join(OUT, '03-after-right-click.png'), clip: barClip });

  // ── 4. Exclusivity over repeated toggles ──
  let exclusiveOk = true;
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(${clickVitals})('click')`);
    await page.waitForTimeout(150);
    const p = await page.evaluate(`(${probeVitals})()`) as { ornVisible: number; labelVisible: number };
    const iconsMode = p.ornVisible > 0;
    const numericMode = p.labelVisible > 0;
    if (iconsMode === numericMode) exclusiveOk = false;  // both or neither = defect
    console.log(`[core4] toggle ${i + 1}: orn=${p.ornVisible} labels=${p.labelVisible} exclusive=${iconsMode !== numericMode}`);
  }
  console.log('[core4] exclusivity over repeated toggles:', exclusiveOk ? 'OK' : 'FAIL');

  // Full-screen capture in each mode for the side-by-side.
  const state = await page.evaluate(`(${probeVitals})()`) as { ornVisible: number };
  if (state.ornVisible === 0) { await page.evaluate(`(${clickVitals})('click')`); await page.waitForTimeout(300); }
  await page.screenshot({ path: join(OUT, '04-icons-mode-bar.png'), clip: barClip });
  await page.evaluate(`(${clickVitals})('click')`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, '05-numeric-mode-bar.png'), clip: barClip });

  console.log('[core4] console errors:', errors.length, errors.slice(0, 5));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
