/**
 * capture-preworld-screens — visual-fidelity capture for the pre-world flow
 * (WF5 Phase 0, sibling of capture-ui-screens.ts).
 *
 * Captures the screens a player sees BEFORE the HUD exists:
 *   login-connecting  — AC logo + progress bars + "Connecting..."
 *   char-select       — World / Characters / ENTER / DELETE screen
 *   char-create-*     — creation wizard steps (race, then two Next steps)
 *   portal-space      — the world-entry / teleport transition overlay,
 *                       forced deterministically via acDebug.showPortalSpace()
 *
 * Writes verification/screens/preworld/<name>.png + manifest.json.
 * Usage: npx tsx tools/capture-preworld-screens.ts
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'verification', 'screens', 'preworld');
const BASE = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

interface Shot { name: string; refs: string[]; layouts: string[]; notes?: string }
const manifest: Array<Shot & { file: string }> = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  }).catch(() => false);
}

async function shoot(page: Page, s: Shot): Promise<void> {
  const file = `${s.name}.png`;
  await page.screenshot({ path: join(OUT, file) });
  manifest.push({ ...s, file });
  console.log(`[capture] ${file}`);
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Remote containers pin a pre-installed browser whose revision can drift
  // ahead of our @playwright/test dep (same fallback as capture-ui-screens.ts).
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', d => void d.dismiss());
  page.on('console', (m) => { if (/\[AC\] (ACE|CharacterError)/.test(m.text())) console.log(`  [page] ${m.text().slice(0, 120)}`); });

  // ── 1. login/connecting screen (timing capture, pre-charlist) ──
  console.log('[capture] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=preworld`, { waitUntil: 'domcontentloaded' });
  // VISUAL.78 — the connecting phase now shows the ToD login screen
  // (charselect backdrop + World/Characters panels, layout 0x21000004)
  // with "Connecting..." in the World panel. Wait for that marker, not a
  // fixed delay (a 4s fixed delay once captured flat black and poisoned
  // an audit section).
  await page.waitForFunction(() =>
    document.getElementById('charsel-inner')?.dataset.mode === 'connecting',
    undefined, { timeout: 120_000 }).catch(() => console.warn('[capture] Connecting marker never appeared — shooting anyway'));
  await page.waitForTimeout(500);
  await shoot(page, {
    name: 'login-connecting',
    refs: ['reference/images/preworld/login-connecting-ref1..3.png (ToD backdrop + wordmark + World/Characters nav)'],
    layouts: ['0x21000004 (charsel scaffold in connecting mode)'],
    notes: 'ToD login screen: charselect backdrop + wordmark + World ("Connecting...") and Characters panels, no action buttons until the char list arrives.',
  });

  // ── 2. character select (wait for it; retry through phantom sessions) ──
  // The connecting screen also renders #charsel-inner — distinguish the
  // populated state via the persistent data-mode marker (the AC font
  // renderer strips data-ac-text spans, so text queries are unreliable).
  const charSelVisible = async (): Promise<boolean> => page.evaluate(() =>
    document.getElementById('charsel-inner')?.dataset.mode === 'select').catch(() => false);
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await charSelVisible()) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[capture] charselect not up — reloading (phantom retry)');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  if (!(await charSelVisible())) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  await shoot(page, {
    name: 'char-select',
    refs: ['WEB: search "Asheron\'s Call character selection screen"'],
    layouts: ['0x21000004 (charsel; see tools/dump-charsel-layout.ts)'],
    notes: 'World pane + Characters list + Create Character + ENTER ellipse + DELETE/CREDITS/EXIT. Retail also shows Asheron portrait art on the right.',
  });

  // ── 3. character creation wizard (Create Character → step through) ──
  const clickAcText = async (text: string): Promise<boolean> => page.evaluate((t) => {
    const el = [...document.querySelectorAll('[data-ac-text]')].find(e => e.getAttribute('data-ac-text') === t);
    if (!el) return false;
    (el.closest('div') ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, text);
  // Stable DOM hooks (GameUI): #btn-create-character on charsel,
  // #chargen-root[data-step] for the current wizard step (CreateStep enum
  // value), #btn-next / #btn-cancel in the wizard footer. The old version
  // blind-clicked viewport coordinates, which silently missed the Next
  // button — step2/step3 captures were all the Race step (VISUAL.30/.34).
  const clickById = async (id: string): Promise<boolean> => page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, id).catch(() => false);
  const currentStep = async (): Promise<number> => page.evaluate(() =>
    parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)).catch(() => -1);
  const createClicked = await clickById('btn-create-character');
  if (createClicked) {
    await page.waitForFunction(() => document.getElementById('chargen-root') !== null,
      undefined, { timeout: 15_000 }).catch(() => console.warn('[capture] chargen-root never appeared'));
    await page.waitForTimeout(2000);
    await shoot(page, {
      name: 'char-create-race',
      refs: ['WEB: search "Asheron\'s Call character creation heritage race screen"'],
      layouts: ['CharacterGenerator 0x0E000002 + chargen LayoutDescs'],
      notes: 'Race/Gender tab: heritage list w/ crests, model preview, lore text, attribute/skill credits.',
    });
    // advance two wizard steps via #btn-next, verifying data-step changes
    for (const stepShot of [
      { name: 'char-create-step2', refs: ['WEB: search "Asheron\'s Call character creation appearance screen"'], layouts: [], notes: 'wizard step after Race (appearance sliders in retail)' },
      { name: 'char-create-step3', refs: ['WEB: search "Asheron\'s Call character creation attributes screen"'], layouts: [], notes: 'wizard step 3 (attributes allocation in retail)' },
    ]) {
      const before = await currentStep();
      if (!(await clickById('btn-next'))) { console.warn(`[capture] #btn-next not found before ${stepShot.name}`); break; }
      const advanced = await page.waitForFunction((prev) =>
        parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev,
        before, { timeout: 10_000 }).then(() => true).catch(() => false);
      if (!advanced) { console.warn(`[capture] wizard did not advance past step ${before} — skipping ${stepShot.name}`); break; }
      await page.waitForTimeout(1500);
      await shoot(page, stepShot);
    }
    // bail out of the wizard
    if (!(await clickById('btn-cancel'))) await clickAcText('Cancel');
    await page.waitForTimeout(1500);
  } else {
    console.warn('[capture] Create Character button not found — skipping wizard captures');
  }

  // ── 4. world entry + portal space ──
  console.log('[capture] entering world for portal-space capture');
  await page.goto(`${BASE}&cb=preworld2`, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
  const wDeadline = Date.now() + 360_000;
  lastReload = Date.now();
  while (Date.now() < wDeadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {}); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  if (await inWorld(page)) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => (window as unknown as { acDebug: { showPortalSpace: () => void } }).acDebug.showPortalSpace());
    await page.waitForTimeout(1500);
    await shoot(page, {
      name: 'portal-space',
      refs: ['WEB: search "Asheron\'s Call portal space screen" / "In Portal Space Please Wait"'],
      layouts: [],
      notes: 'The teleport/world-entry transition. Retail: swirling purple portal tunnel animation with "In Portal Space - Please Wait..." text.',
    });
    await page.evaluate(() => (window as unknown as { acDebug: { hidePortalSpace: () => void } }).acDebug.hidePortalSpace());
  } else {
    console.warn('[capture] never entered world — portal-space capture skipped');
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), viewport: VIEW, captures: manifest,
  }, null, 2));
  console.log(`[capture] wrote ${manifest.length} captures + manifest.json to ${OUT}`);
  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
