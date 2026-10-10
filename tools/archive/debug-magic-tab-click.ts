/**
 * CORE.5.c.a interactive debug: why does clicking the Spellbook/Components
 * DAT tab pair (0x100002a9/0x100002aa) leave magicPanelTab unchanged?
 * Logs the full event chain (capture-phase document listeners), element
 * geometry/hit-testing, and wraps the GameUI handler path.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=magictab';
const VIEW = { width: 1568, height: 775 };
const OUT = join(REPO, 'verification', 'playtest', 'core5ca-magic-tab');

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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', m => { if (m.text().startsWith('[tabdbg]')) console.log('PAGE:', m.text()); });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  console.log(`[debug] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[debug] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[debug] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* loop */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[debug] in world');
  await page.waitForTimeout(8000);

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);

  // 1. Baseline state + geometry + hit test
  const state1 = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const out = { tab: ui.magicPanelTab, tabs: [] };
    for (const el of document.querySelectorAll('[data-magic-tab]')) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      out.tabs.push({
        key: el.dataset.magicTab,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0,
        hitIsSelf: hit === el,
        hitDesc: hit ? (hit.tagName + ' ' + (hit.dataset ? JSON.stringify(hit.dataset) : '') + ' cls=' + hit.className) : 'null',
        hitIsDescendant: hit ? el.contains(hit) : false,
        pointerEvents: getComputedStyle(el).pointerEvents,
        cursor: getComputedStyle(el).cursor,
      });
    }
    return out;
  })()`);
  console.log('[debug] baseline:', JSON.stringify(state1, null, 1));

  // 2. Instrument: capture-phase document listeners log every event whose
  //    target is (inside) a tab; wrap saveOptionsSettings/playUISound/
  //    renderMagicPanel to see whether the GameUI handler body runs.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__tabdbgEvents = [];
    const log = (m) => { window.__tabdbgEvents.push(m); console.log('[tabdbg] ' + m); };
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      document.addEventListener(type, (e) => {
        const t = e.target;
        const tab = t && t.closest ? t.closest('[data-magic-tab]') : null;
        if (tab) log(type + ' target=' + (t.dataset && t.dataset.magicTab ? 'tab:' + t.dataset.magicTab : t.tagName) + ' defaultPrevented=' + e.defaultPrevented);
      }, true);
      document.addEventListener(type, (e) => {
        const t = e.target;
        const tab = t && t.closest ? t.closest('[data-magic-tab]') : null;
        if (tab) log(type + ' BUBBLE-REACHED-DOC defaultPrevented=' + e.defaultPrevented);
      }, false);
    }
    const origRender = ui.renderMagicPanel;
    ui.renderMagicPanel = function(...a) { log('renderMagicPanel called, tab=' + this.magicPanelTab); return origRender.apply(this, a); };
    const origSave = ui.saveOptionsSettings;
    ui.saveOptionsSettings = function(...a) { log('saveOptionsSettings called'); return origSave.apply(this, a); };
    // per-element listener check: add our own click listener directly on each tab
    for (const el of document.querySelectorAll('[data-magic-tab]')) {
      el.addEventListener('click', () => log('el-level click listener fired on ' + el.dataset.magicTab));
    }
    return 'instrumented';
  })()`);

  // 3. Click the inactive tab with a real mouse sequence
  const target = (state1 as any).tab === 'spells' ? 'components' : 'spells';
  console.log(`[debug] current tab=${(state1 as any).tab}; clicking [data-magic-tab=${target}]`);
  const box = await page.locator(`[data-magic-tab=${target}]`).boundingBox();
  if (!box) { throw new Error('tab not found for mouse click'); }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(1500);

  const state2 = await page.evaluate(`(() => ({
    tab: window.__ac.gameUI.magicPanelTab,
    events: window.__tabdbgEvents,
  }))()`);
  console.log('[debug] after mouse click:', JSON.stringify(state2, null, 1));

  // 4. Also try page.click (what the original probe used) on the other tab
  const state2b = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  const target2 = state2b === 'spells' ? 'components' : 'spells';
  await page.evaluate(`window.__tabdbgEvents = []`);
  try {
    await page.click(`[data-magic-tab=${target2}]`, { timeout: 10000 });
  } catch (e) {
    console.log('[debug] page.click threw:', (e as Error).message.split('\n')[0]);
  }
  await page.waitForTimeout(1500);
  const state3 = await page.evaluate(`(() => ({
    tab: window.__ac.gameUI.magicPanelTab,
    events: window.__tabdbgEvents,
  }))()`);
  console.log('[debug] after page.click:', JSON.stringify(state3, null, 1));

  await page.screenshot({ path: join(OUT, 'magic-tab-debug.png') });
  console.log('[debug] screenshot:', join(OUT, 'magic-tab-debug.png'));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
