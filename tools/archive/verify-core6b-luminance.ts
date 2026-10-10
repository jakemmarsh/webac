/**
 * CORE.6.b verification — char-panel luminance rows 0x100005c5/0x100005c6.
 *
 * Ground truth (gmStatManagementUI::UpdateExperience @ 004f0a70 + layout
 * 0x21000045): rows cleared when level < 200 or the character has no
 * luminance; otherwise label L"Luminance:" at (0,52) 110x18 and value
 * "%s / %s" (available / maximum, comma-grouped per
 * ExperienceSystem::XPToString @ 005c82d0) at (110,52) 120x18.
 *
 * Phases (DB edit + ACE restart happen between phases, driven by the
 * caller):
 *   --phase before  fresh/low-level char: rows must be display:none
 *   --phase after   level-200 char with lum pools set in the shard DB:
 *                   rows visible with "750,000 / 1,500,000"; then
 *                   @grantluminance 1000 live-updates the value to
 *                   "751,000 / 1,500,000" without reopening the panel
 *                   (the main.ts PrivateUpdatePropertyInt64 re-sync).
 *
 * Usage: npx tsx tools/verify-core6b-luminance.ts --phase before|after
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const PHASE = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'before';
const URL = process.env.AC_URL
  ?? `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core6b${PHASE}`;
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'core6b-luminance');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
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

/** Read the luminance rows' state from the live attributes pane. */
async function readLumRows(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const handle = ui.charPanelHandle;
    if (!handle) return { error: 'no charPanelHandle' };
    const pane = handle.elements.get(0x1000022b);
    if (!pane) return { error: 'no attributes pane' };
    const byId = (root, id) => root.querySelector('[data-element-id="0x' + id.toString(16) + '"]');
    const label = byId(pane, 0x100005c5);
    const value = byId(pane, 0x100005c6);
    if (!label || !value) return { error: 'rows not in DOM', label: !!label, value: !!value };
    const lr = label.getBoundingClientRect();
    const vr = value.getBoundingClientRect();
    return {
      labelDisplay: label.style.display, valueDisplay: value.style.display,
      labelText: (label.textContent || '').trim(), valueText: (value.textContent || '').trim(),
      labelRect: { x: lr.x, y: lr.y, w: lr.width, h: lr.height },
      valueRect: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
      level: ui.charInfo.level,
      availLum: String(ui.charInfo.availableLuminance),
      maxLum: String(ui.charInfo.maximumLuminance),
    };
  })()`) as Promise<Record<string, unknown>>;
}

async function openAttributesTab(page: Page): Promise<void> {
  await page.evaluate(`document.getElementById('tb-char')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(800);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.charPanelTab = 'attributes';
    ui.renderCharPanel();
  })()`);
  await page.waitForTimeout(800);
}

async function shotPanel(page: Page, name: string): Promise<void> {
  const r = await page.evaluate(`(() => {
    const wr = window.__ac.gameUI.charPanel.getBoundingClientRect();
    return { x: wr.x, y: wr.y, w: wr.width, h: wr.height };
  })()`) as { x: number; y: number; w: number; h: number };
  await page.screenshot({
    path: join(OUT, name),
    clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 40, height: Math.min(VIEW.height - r.y + 10, r.h + 50) },
  });
}

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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[core6b:${PHASE}] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core6b:${PHASE}] virgin account create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log(`[core6b:${PHASE}] not in world yet — phantom-session reload`);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep waiting */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, `${PHASE}-never-entered.png`) });
    await browser.close();
    throw new Error('never entered world within 360s');
  }
  console.log(`[core6b:${PHASE}] in world — settling 8s`);
  await page.waitForTimeout(8000);

  await openAttributesTab(page);
  const initial = await readLumRows(page);
  console.log(`[core6b:${PHASE}] rows:`, JSON.stringify(initial, null, 1));
  await shotPanel(page, `${PHASE}-attributes.png`);

  const results: Record<string, unknown> = { phase: PHASE, initial };

  if (PHASE === 'after') {
    // Live-update path: @grantluminance adds to AvailableLuminance and ACE
    // emits PrivateUpdatePropertyInt64 → the panel must re-render WITHOUT
    // being reopened.
    await page.evaluate(`window.acDebug.sendChat('@grantluminance 1000')`);
    await page.waitForTimeout(4000);
    const afterGrant = await readLumRows(page);
    console.log(`[core6b:${PHASE}] after @grantluminance 1000:`, JSON.stringify(afterGrant, null, 1));
    await shotPanel(page, `${PHASE}-attributes-grant.png`);
    results.afterGrant = afterGrant;
  }

  writeFileSync(join(OUT, `metrics-${PHASE}.json`), JSON.stringify({ results, errors: errors.slice(0, 20) }, null, 2));
  await browser.close();
  console.log(`[core6b:${PHASE}] done — output in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
