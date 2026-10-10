/**
 * CORE.5.c.d.b live verification — DAT-native fellowship pane.
 *
 * Logs into the local ACE stack, opens the social panel's Fellowship tab,
 * exercises the empty state (paragraph/toggles/name input/Create gating)
 * and the seeded member state (rows + vitals bars + selection + button
 * gating), and writes panel crops to verification/core5cdb-fellowship-native/.
 *
 * Usage: npx tsx tools/verify-core5cdb-fellowship.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(__dir, '..', 'verification', 'core5cdb-fellowship-native');
mkdirSync(OUT, { recursive: true });

const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5cdb';
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
    let el: HTMLElement | null = document.querySelector('[data-social-tab]');
    while (el && !el.querySelector('[data-element-id="0x10000292"]')) el = el.parentElement;
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

  // Open social panel → Fellowship tab.
  await page.evaluate(() => document.getElementById('tb-social')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(800);
  await clickSel(page, '[data-social-tab="fellowship"]');

  // ── EMPTY STATE ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).acDebug.clearSocial());
  await page.waitForTimeout(600);
  await shot(page, '01-fellowship-empty.png');

  // Type a name → Create enables.
  await page.evaluate(() => {
    const input = document.querySelector('.fellowship-name-input') as HTMLInputElement | null;
    if (input) { input.value = 'Olthoi Hunters'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(400);
  await shot(page, '02-fellowship-typed.png');

  const emptyProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000292"]');
    if (!pane) return { pane: false };
    var q = function(id){ return pane.querySelector('[data-element-id="' + id + '"]'); };
    var inF = q('0x10000275'); var empF = q('0x1000026b');
    var create = q('0x10000274');
    return {
      pane: true,
      paneVisible: pane.style.display !== 'none',
      inFrameHidden: inF ? inF.style.display === 'none' : null,
      emptyFrameShown: empF ? empF.style.display !== 'none' : null,
      paragraph: !!(q('0x1000026c') && q('0x1000026c').textContent),
      divider: !!q('0x1000026d'),
      input: !!pane.querySelector('.fellowship-name-input'),
      checkboxKeys: ['0x10000270','0x10000271','0x10000272','0x10000273'].map(function(id){ var n = q(id); return n ? n.dataset.optionKey + '=' + n.dataset.optionOn : null; }),
      createEnabled: create ? create.style.cursor === 'pointer' : null,
    };
  })()`);
  console.log('[probe:empty]', JSON.stringify(emptyProbe));

  // ── MEMBER STATE (seeded: self is leader) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).acDebug.seedFellowship());
  await page.waitForTimeout(600);
  await shot(page, '03-fellowship-seeded.png');

  // Select the other member → Leader/Dismiss enable.
  await clickSel(page, '[data-fellow-name="Member Two"]');
  await shot(page, '04-fellowship-member-selected.png');

  const memberProbe = await page.evaluate(`(function(){
    var pane = document.querySelector('[data-element-id="0x10000292"]');
    if (!pane) return { pane: false };
    var q = function(id){ return pane.querySelector('[data-element-id="' + id + '"]'); };
    var en = function(id){ var n = q(id); return n ? n.style.cursor === 'pointer' : null; };
    var inF = q('0x10000275'); var empF = q('0x1000026b');
    return {
      pane: true,
      inFrameShown: inF ? inF.style.display !== 'none' : null,
      emptyFrameHidden: empF ? empF.style.display === 'none' : null,
      name: q('0x10000276') ? q('0x10000276').textContent : null,
      rows: pane.querySelectorAll('.fellow-row').length,
      selectedRows: pane.querySelectorAll('.fellow-row.selected').length,
      buttons: {
        leader: en('0x1000027b'), quit: en('0x1000027c'), open: en('0x1000027d'),
        recruit: en('0x1000027e'), dismiss: en('0x1000027f'), disband: en('0x10000280'),
      },
      openLabel: q('0x1000027d') ? q('0x1000027d').textContent : null,
    };
  })()`);
  console.log('[probe:member]', JSON.stringify(memberProbe));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).acDebug.clearSocial());
  await browser.close();
  console.log('[done] captures in', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
