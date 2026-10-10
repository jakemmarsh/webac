/**
 * CORE.17.k.b.b.c.c.a.a.c.a.c — live capture of the transaction dock as a
 * gmFloatyEnvPanelUI: one border set per LockUI, the Dragbar top border
 * moving it, the Resizebar right border widening it (the slot reflowing),
 * the rect persisted under WindowID 6 and kept across a close / re-open.
 *
 * On the live ACE stack (Holtburg): @ci an Ust; double-clicked through the
 * real inventory handler it opens gmSalvageUI in the dock. Real mouse drags
 * (page.mouse) on the DAT border elements; LockUI through the radar's real
 * lock button. Whole-screen + zoom captures and a before | after sheet under
 * verification/core17kbbccaaacac/ (the "before" is the previous cycle's
 * verification/core17kbbccaaacaa/ours-empty*.png, both border sets drawn).
 *
 *   npx tsx tools/capture-core17kbbccaaacac-dock-floaty.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacac');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbbccaaacaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const UST_WCID = 20646;
const TELEPORT = '@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const TAG = '[core17kbbccaaacac]';
const DRAG = [0x1000066c, 0x10000670];
const RESIZE = [0x1000066b, 0x1000066d, 0x1000066e, 0x1000066f, 0x10000671, 0x10000672];
const LOCKED = [0x10000663, 0x10000664, 0x10000665, 0x10000666, 0x10000667, 0x10000668, 0x10000669, 0x1000066a];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function admin(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => (window as any).acDebug?.admin?.(c), cmd);
}

/** The inventory index of the newest item matching `pred` (by name / itemType). */
async function indexOf(page: Page, kind: 'ust' | 'loot', skip: number[] = []): Promise<number> {
  return page.evaluate(({ k, skip }) => {
    const items: any[] = (window as any).__ac?.gameUI?.inventoryItems ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (skip.includes(i)) continue;
      const it = items[i];
      const isUst = ((it.itemType ?? 0) & 0x20000000) !== 0;
      if (k === 'ust' ? isUst : (/rusted/i.test(it.name ?? '') && !isUst)) return i;
    }
    return -1;
  }, { k: kind, skip });
}

async function probe(page: Page) {
  return page.evaluate(({ DRAG, RESIZE, LOCKED }) => {
    const ui = (window as any).__ac?.gameUI;
    const host: HTMLElement | null = ui?.salvagePanel ?? null;
    const rect = (e: Element | null | undefined) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const byId = (id: number) => host?.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
    const vis = (ids: number[]) => ids.filter((id) => { const e = byId(id); return !!e && getComputedStyle(e).display !== 'none'; }).length;
    let stored: unknown = null;
    try { stored = Object.entries(localStorage).filter(([k]) => k.startsWith('ac_floaty_windows_v1')).map(([k, v]) => [k, JSON.parse(v)['6'] ?? null]); } catch { /* */ }
    return {
      open: !!ui?.isSalvageOpen, lockUI: !!ui?.optionsSettings?.lockUI,
      host: rect(host), slot: rect(byId(0x1000005e)), list: rect(byId(0x10000074)), button: rect(byId(0x10000076)),
      shown: { drag: vis(DRAG), resize: vis(RESIZE), locked: vis(LOCKED) },
      stored,
    };
  }, { DRAG, RESIZE, LOCKED });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function center(page: Page, id: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate((i) => {
    const el = (window as any).__ac?.gameUI?.salvagePanel?.querySelector(`[data-element-id="0x${i.toString(16)}"]`); // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = el?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, id);
}

async function mouseDrag(page: Page, id: number, dx: number, dy: number, atX?: number): Promise<void> {
  const c = await center(page, id);
  if (!c) throw new Error(`no element 0x${id.toString(16)}`);
  const x = atX ?? c.x;
  await page.mouse.move(x, c.y);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) await page.mouse.move(x + (dx * s) / 8, c.y + (dy * s) / 8);
  await page.mouse.up();
  await page.waitForTimeout(600);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __ac?: { gameUI?: { salvagePanel?: HTMLElement } } }).__ac?.gameUI?.salvagePanel;
    const b = h?.getBoundingClientRect();
    return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  });
  if (r) {
    await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 20, height: r.h + 20 } });
  }
}

async function openSalvage(page: Page): Promise<void> {
  const ust = await indexOf(page, 'ust');
  await page.evaluate((i) => (window as any).__ac?.gameUI?.dragCallbacks?.onDoubleClickItem?.(i), ust); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(1500);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG)) console.log(t.slice(0, 240)); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await page.goto(`${URL}&cb=kbbccaaacac`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
  await admin(page, TELEPORT);
  await page.waitForTimeout(10000);
  await page.evaluate(() => (window as unknown as { acDebug?: { freezeTimeOfDay?: (t: number) => void } }).acDebug?.freezeTimeOfDay?.(0.5));
  if (await indexOf(page, 'ust') < 0) { await admin(page, `@ci ${UST_WCID}`); await page.waitForTimeout(4000); }

  // Unlocked (the ACE default): the interactive set only.
  if (await page.evaluate(() => !!(window as any).__ac?.gameUI?.optionsSettings?.lockUI)) { // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.click('#radar-lock-button'); await page.waitForTimeout(800);
  }
  await openSalvage(page);
  state.unlocked = await probe(page);
  await shoot(page, 'ours-unlocked');

  // The Dragbar top border: up 180, left 300.
  await mouseDrag(page, 0x1000066c, -300, -180);
  state.moved = await probe(page);
  await shoot(page, 'ours-moved');

  // The Resizebar right side: +220 wide.
  await mouseDrag(page, 0x10000672, 220, 0);
  state.resized = await probe(page);
  await shoot(page, 'ours-resized');

  // Close + re-open: the persisted rect.
  await page.evaluate(() => (window as any).__ac?.gameUI?.hideSalvagePanel?.()); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(800);
  await openSalvage(page);
  state.reopened = await probe(page);

  // LockUI through the radar's lock button: the locked art only; drags do nothing.
  await page.click('#radar-lock-button');
  await page.waitForTimeout(800);
  state.locked = await probe(page);
  await shoot(page, 'ours-locked');
  await mouseDrag(page, 0x10000664, 200, 100).catch(() => { /* the top art is not a drag bar */ });
  state.lockedAfterDrag = await probe(page);
  await page.click('#radar-lock-button');
  await page.waitForTimeout(800);
  state.unlockedAgain = await probe(page);
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.zoom img{max-width:1560px}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.c — the transaction dock as a gmFloatyEnvPanelUI (live ACE, Holtburg)</h1>
  <p>DAT 0x2100006d:0x100005fb — Dragbar 0x1000066c/0x10000670, Resizebar 0x1000066b/6d/6e/6f/71/72 (p43 left / p44 right), locked art 0x10000663-66a (0x060074bf-c6); WindowID 6 (0x1000007e on HUD slot 0x100005fd); width 410..1000, height 120. UpdateLockedStatus @ 004d48f0 shows one set.</p>
  <div>${img(join(BEFORE_DIR, 'ours-empty.png'), 'before — fixed host, both border sets drawn')}${img(join(OUT, 'ours-unlocked.png'), 'after — unlocked: the drag / resize set only')}</div>
  <div>${img(join(OUT, 'ours-moved.png'), 'after — dragged by its top border')}${img(join(OUT, 'ours-resized.png'), 'after — widened by its right border (the slot reflows)')}</div>
  <div>${img(join(OUT, 'ours-locked.png'), 'after — LockUI on: the locked art only')}</div>
  <div class="zoom">${img(join(BEFORE_DIR, 'ours-empty-zoom.png'), 'before (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-unlocked-zoom.png'), 'after — unlocked (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-locked-zoom.png'), 'after — locked (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-resized-zoom.png'), 'after — resized (zoom)')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacac-dock-floaty-sidebyside.png'), fullPage: true });
  console.log(`${TAG} wrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
