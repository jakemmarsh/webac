/**
 * CORE.5.c.d live verification — DAT-native friends + squelch panes.
 *
 * Logs into the local ACE stack, opens the social panel, exercises the
 * friends and squelch tabs (empty + seeded + selection + typed input),
 * and writes panel crops to verification/core5cd-social-native/.
 *
 * Usage: npx tsx tools/verify-core5cd-social.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE docker stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(__dir, '..', 'verification', 'core5cd-social-native');
mkdirSync(OUT, { recursive: true });

const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5cd';
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
    const root = tab?.closest('div[style*="position"]') as HTMLElement | null;
    // walk up to the panel root (the renderPanel window root that contains the panes)
    let el: HTMLElement | null = tab;
    while (el && !el.querySelector('[data-element-id="0x10000513"]')) el = el.parentElement;
    const target = el ?? root;
    if (!target) return null;
    const r = target.getBoundingClientRect();
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

  // Open social panel.
  await page.evaluate(() => document.getElementById('tb-social')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(800);

  // ── FRIENDS ──
  await clickSel(page, '[data-social-tab="friends"]');
  await shot(page, '01-friends-empty.png');

  await page.evaluate(() => (window as any).acDebug.seedFriends());
  await page.waitForTimeout(600);
  await shot(page, '02-friends-seeded.png');

  // Select the online friend → Send Tell + Remove enable.
  await clickSel(page, '.friend-row');
  await shot(page, '03-friends-selected.png');

  // Type into the Friend Name field → Add enables.
  await page.evaluate(() => {
    const input = document.querySelector('.friend-name-input') as HTMLInputElement | null;
    if (input) { input.value = 'Espy'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(400);
  await shot(page, '04-friends-typed.png');

  // Structural probe: chrome elements present + rows inside the DAT list.
  const friendsProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000513"]');
    if (!pane) return { pane: false };
    var q = function(id){ return !!pane.querySelector('[data-element-id="' + id + '"]'); };
    var sq = document.querySelector('[data-element-id="0x1000054a"]');
    return {
      pane: true,
      paneVisible: pane.style.display !== 'none',
      squelchPaneHidden: sq ? sq.style.display === 'none' : null,
      rowsInList: pane.querySelectorAll('[data-element-id="0x10000517"] .friend-row').length,
      buttons: [q('0x10000514'), q('0x10000515'), q('0x10000516')],
      checkbox: q('0x1000052c'),
      input: !!pane.querySelector('.friend-name-input'),
      dividers: [q('0x10000254'), q('0x1000025d')],
    };
  })()`);
  console.log('[probe:friends]', JSON.stringify(friendsProbe));

  // ── SQUELCH ──
  await clickSel(page, '[data-social-tab="squelch"]');
  await page.evaluate(() => (window as any).acDebug.seedSquelch());
  await page.waitForTimeout(600);
  await shot(page, '05-squelch-seeded.png');

  await clickSel(page, '.squelch-row');
  await page.evaluate(() => {
    const input = document.querySelector('.squelch-name-input') as HTMLInputElement | null;
    if (input) { input.value = 'Rando'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(400);
  await shot(page, '06-squelch-selected-typed.png');

  const squelchProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x1000054a"]');
    if (!pane) return { pane: false };
    var q = function(id){ return !!pane.querySelector('[data-element-id="' + id + '"]'); };
    var fr = document.querySelector('[data-element-id="0x10000513"]');
    return {
      pane: true,
      paneVisible: pane.style.display !== 'none',
      friendsPaneHidden: fr ? fr.style.display === 'none' : null,
      rowsInList: pane.querySelectorAll('[data-element-id="0x1000053e"] .squelch-row').length,
      typeTexts: Array.prototype.map.call(pane.querySelectorAll('.squelch-row'), function(r){ return r.textContent; }),
      buttons: [q('0x10000547'), q('0x1000054b'), q('0x1000054c')],
      input: !!pane.querySelector('.squelch-name-input'),
    };
  })()`);
  console.log('[probe:squelch]', JSON.stringify(squelchProbe));

  // ── regression shots: fellowship + allegiance still render on their own panes ──
  await clickSel(page, '[data-social-tab="fellowship"]');
  await page.evaluate(() => (window as any).acDebug.seedFellowship());
  await page.waitForTimeout(600);
  await shot(page, '07-fellowship-seeded.png');

  await clickSel(page, '[data-social-tab="allegiance"]');
  await page.evaluate(() => (window as any).acDebug.seedAllegiance());
  await page.waitForTimeout(600);
  await shot(page, '08-allegiance-seeded.png');

  const paneProbe = await page.evaluate(`(function(){
    var vis = function(id){ var el = document.querySelector('[data-element-id="' + id + '"]'); return el ? el.style.display !== 'none' : null; };
    return { allegiance: vis('0x10000291'), fellowship: vis('0x10000292'), friends: vis('0x10000513'), squelch: vis('0x1000054a') };
  })()`);
  console.log('[probe:panes-on-allegiance-tab]', JSON.stringify(paneProbe));

  await browser.close();
  console.log('[done]');
}
main();
