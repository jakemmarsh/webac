/**
 * CORE.5.c.d.a live verification — DAT-native allegiance pane.
 *
 * Logs into the local ACE stack, opens the social panel's Allegiance tab,
 * captures the empty state (vs allegiance-panel.jpg), the seeded populated
 * state (vs allegiance-panel-2.jpg), and the vassal-selection state, plus
 * structural probes of the pane's bound DAT chrome.
 *
 * Usage: npx tsx tools/verify-core5cda-allegiance.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE docker stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(__dir, '..', 'verification', 'core5cda-allegiance-native');
mkdirSync(OUT, { recursive: true });

const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5cda';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function panelBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const tab = document.querySelector('[data-social-tab]') as HTMLElement | null;
    let el: HTMLElement | null = tab;
    while (el && !el.querySelector('[data-element-id="0x10000291"]')) el = el.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const box = await panelBox(page);
  if (box && box.width > 50) {
    await page.screenshot({ path: join(OUT, name), clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: Math.min(VIEW.height - box.y, box.height + 8) } });
  } else {
    await page.screenshot({ path: join(OUT, name) });
  }
  console.log(`[shot] ${name}`);
}

async function clickSel(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), sel);
  await page.waitForTimeout(500);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200)); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[login] retrying (phantom-session guard)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[login] in world');
  await page.waitForTimeout(5000);

  // Open social panel → Allegiance tab.
  await page.evaluate(() => document.getElementById('tb-social')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(800);
  await clickSel(page, '[data-social-tab="allegiance"]');

  // ── Empty state (real server char: no allegiance) vs allegiance-panel.jpg ──
  await shot(page, '01-allegiance-empty.png');
  const emptyProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000291"]');
    if (!pane) return { pane: false };
    var vis = function(id){ var el = pane.querySelector('[data-element-id="' + id + '"]'); return el ? el.style.display !== 'none' : null; };
    return {
      pane: true, paneVisible: pane.style.display !== 'none',
      monarchHidden: vis('0x10000255') === false,
      patronHidden: vis('0x1000025a') === false,
      vassalRows: pane.querySelectorAll('.vassal-row').length,
      headerTexts: [vis('0x1000025e'), vis('0x1000025f')],
      swearCursor: (pane.querySelector('[data-element-id="0x10000263"]')||{}).style ? pane.querySelector('[data-element-id="0x10000263"]').style.cursor : null,
      breakCursor: (pane.querySelector('[data-element-id="0x10000264"]')||{}).style ? pane.querySelector('[data-element-id="0x10000264"]').style.cursor : null,
      kickCursor: (pane.querySelector('[data-element-id="0x10000265"]')||{}).style ? pane.querySelector('[data-element-id="0x10000265"]').style.cursor : null,
    };
  })()`);
  console.log('[probe:empty]', JSON.stringify(emptyProbe));

  // ── Seeded populated state vs allegiance-panel-2.jpg ──
  await page.evaluate(() => (window as any).acDebug.seedAllegiance());
  await page.waitForTimeout(600);
  await shot(page, '02-allegiance-seeded.png');

  const seededProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000291"]');
    if (!pane) return { pane: false };
    var el = function(id, scope){ return (scope || pane).querySelector('[data-element-id="' + id + '"]'); };
    var monarch = el('0x10000255');
    var patron = el('0x1000025a');
    return {
      monarchVisible: monarch && monarch.style.display !== 'none',
      patronVisible: patron && patron.style.display !== 'none',
      monarchXpHidden: monarch ? (el('0x10000490', monarch)||{style:{display:''}}).style.display === 'none' : null,
      patronXpText: patron ? ((el('0x10000492', patron)||{}).textContent||'') : null,
      nameText: (el('0x10000251')||{}).textContent || '',
      followersText: (el('0x10000252')||{}).textContent || '',
      rankText: (el('0x10000253')||{}).textContent || '',
      vassalRows: Array.prototype.map.call(pane.querySelectorAll('.vassal-row'), function(r){ return r.dataset.rowName; }),
      checkboxBound: !!(el('0x10000262')||{dataset:{}}).dataset.optionKey,
      swearCursor: el('0x10000263') ? el('0x10000263').style.cursor : null,
      breakCursor: el('0x10000264') ? el('0x10000264').style.cursor : null,
      kickCursor: el('0x10000265') ? el('0x10000265').style.cursor : null,
    };
  })()`);
  console.log('[probe:seeded]', JSON.stringify(seededProbe));

  // ── Vassal selection → Kick enables ──
  await clickSel(page, '.vassal-row');
  await shot(page, '03-allegiance-vassal-selected.png');
  const selProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000291"]');
    var kick = pane ? pane.querySelector('[data-element-id="0x10000265"]') : null;
    return {
      selectedRow: pane ? (pane.querySelector('.vassal-row.selected')||{dataset:{}}).dataset.rowName : null,
      kickCursor: kick ? kick.style.cursor : null,
    };
  })()`);
  console.log('[probe:selected]', JSON.stringify(selProbe));

  await browser.close();
  console.log('[done]');
}
main();
