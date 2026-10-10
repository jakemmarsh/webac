/**
 * CORE.17.h.c live verification — Reset/Defaults scope to the visible page.
 * Run from the repo root: npx tsx tools/verify-core17hc-live.ts (writes verification/screens/core17hc/, gitignored)
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/user/acjs';
const OUT = join(ROOT, 'verification', 'screens', 'core17hc');
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core17hc';
const VIEW = { width: 1568, height: 775 };

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

const OPTS = '(function(){var ui=window.__ac&&window.__ac.gameUI;';
function js(body: string): string { return OPTS + body + '})()'; }

async function snapshotSettings(page: Page, keys: string[]): Promise<Record<string, unknown>> {
  return page.evaluate(js(`var o={};${JSON.stringify(keys)}.forEach(function(k){o[k]=ui.optionsSettings[k];});o.__tab=ui.optionsTab;return o;`)) as Promise<Record<string, unknown>>;
}

async function clickTab(page: Page, tab: string): Promise<void> {
  await page.evaluate(`document.querySelector('[data-options-tab="${tab}"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
  await page.waitForTimeout(600);
}
async function dragSlider(page: Page, label: string, frac: number): Promise<void> {
  const box = await page.evaluate((l) => {
    const t = document.querySelector(`[data-slider-label="${l}"]`) as HTMLElement | null;
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  }, label);
  if (!box) throw new Error(`slider ${label} not found`);
  await page.mouse.move(box.x + box.w * frac, box.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
}
async function clickToggle(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    const rows = [...document.querySelectorAll(`.option-toggle-row[data-option-key="${k}"]`)] as HTMLElement[];
    rows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, key);
  await page.waitForTimeout(300);
}
async function clickFooter(page: Page, id: number): Promise<void> {
  await page.evaluate((hex) => {
    const btns = [...document.querySelectorAll(`.options-footer-btn[data-element-id="${hex}"]`)] as HTMLElement[];
    const vis = btns.find((b) => b.style.display !== 'none' && b.getClientRects().length > 0) ?? btns[0];
    vis?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, `0x${id.toString(16)}`);
  await page.waitForTimeout(700);
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
  page.on('console', (msg) => { const t = msg.text(); if (/\[AC\]|rror/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[live] char-create: ${created}`); createSent = true; }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[live] not in world — reload');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never in world'); }
  console.log('[live] in world');
  await page.waitForTimeout(8000);

  const KEYS = ['chatInactiveOpacity', 'chatActiveOpacity', 'chatMainWindowGeneral', 'showHelm', 'lockUI',
    'screenBrightness', 'cameraStiffness', 'fieldOfView', 'activeSpellBarTab', 'optionsTab'];
  const log: Record<string, unknown> = {};

  // Baseline: make sure we start from a known clean state.
  await page.evaluate(js(`ui.applyOptionsBulk(Object.assign({},ui.constructor.OPTIONS_DEFAULTS));ui.optionsSettings.chatInactiveOpacitySet=false;ui.optionsSettings.chatActiveOpacitySet=false;ui.saveOptionsSettings();`));
  await page.evaluate(js(`ui.optionsSettings.activeSpellBarTab=3;ui.saveOptionsSettings();`));

  // Open the options panel (tb-opt) on the Chat tab, perturb.
  await page.evaluate(`document.getElementById('tb-opt').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
  await page.waitForTimeout(800);
  await clickTab(page, 'chat');
  await dragSlider(page, 'Inactive Opacity', 0.2);
  await clickToggle(page, 'chatMainWindowGeneral');
  log.afterChatEdits = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '1-chat-edited.png') });

  // Character tab: flip Show Helm.
  await clickTab(page, 'character');
  await clickToggle(page, 'showHelm');
  log.afterCharacterEdit = await snapshotSettings(page, KEYS);

  // Config tab: drag brightness + stiffness, then Defaults.
  await clickTab(page, 'config');
  await dragSlider(page, 'Screen Brightness', 0.9);
  await dragSlider(page, 'Camera Stiffness', 0.1);
  log.afterConfigEdits = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '2-config-edited.png') });
  await clickFooter(page, 0x100001fe); // Defaults
  log.afterConfigDefaults = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '3-config-after-defaults.png') });

  // Back to Chat: the edits must have survived a Config-page Defaults.
  await clickTab(page, 'chat');
  log.chatAfterConfigDefaults = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '4-chat-after-config-defaults.png') });

  // Now Defaults on the Chat tab restores ONLY chat.
  await clickFooter(page, 0x100001fe);
  log.afterChatDefaults = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '5-chat-after-chat-defaults.png') });

  // Character tab still has Show Helm flipped; Reset there restores it (snapshot at panel open).
  await clickTab(page, 'character');
  log.characterBeforeReset = await snapshotSettings(page, KEYS);
  await clickFooter(page, 0x100001fd); // Reset
  log.characterAfterReset = await snapshotSettings(page, KEYS);
  await page.screenshot({ path: join(OUT, '6-character-after-reset.png') });

  writeFileSync(join(OUT, 'settings-log.json'), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log, null, 2));

  // Clean up: restore defaults so later captures start clean.
  await page.evaluate(js(`ui.applyOptionsBulk(Object.assign({},ui.constructor.OPTIONS_DEFAULTS));ui.optionsSettings.chatInactiveOpacitySet=false;ui.optionsSettings.chatActiveOpacitySet=false;ui.saveOptionsSettings();if(ui.optionsPanelVisible)ui.toggleOptionsPanel();`));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
