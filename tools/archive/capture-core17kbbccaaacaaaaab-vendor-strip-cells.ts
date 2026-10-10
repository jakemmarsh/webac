/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — live check of the vendor / slumlord
 * item strips on the ACE stack: every cell is template 0x1000033a (a 32 px
 * icon filling the cell, the UIItem selection ants 0x06004d09, EMPTY tiles
 * 0x06004d20 padding the view per UpdateEmptySlots @ 004e3700, one trailing
 * EMPTY tile on the p0x10000017 lists).
 *
 *   vendor    the nearest Holtburg vendor that buys something we carry: the
 *             Items strip with a selected merchandise cell, the Buying strip
 *             with two queued items, the Selling strip with one queued item.
 *   slumlord  the cottage slumlord 0x73B9C051 Used; a coin stack on Buy.
 *
 * Before images: verification/core17kbbccaaacaaaaa/ours-{vendor,slumlord}-accept-zoom.png
 * (the previous cycle's captures, 24 px icons in a CSS border, no padding).
 *
 *   npx tsx tools/capture-core17kbbccaaacaaaaab-vendor-strip-cells.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaaaaab');
const BEFORE = join(REPO, 'verification', 'core17kbbccaaacaaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kbbccaaacaaaaab]';
const DIRK = 23320; const MACE = 23321; const PYREAL = 273;
const VENDOR_FLAG = 0x200;
const SLUMLORD_TELEPORT = '@teleloc 0x3B9C0032 [151.4 37.5 50.5] 1 0 0 0';
const SLUMLORD_GUID = 0x73B9C051;

// Source strings: tsx injects `__name` into named function bodies (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, charName: string): Promise<void> {
  await page.goto(`${url}&cb=kbbccaaacaaaaab`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await ev<string>(page, `(() => {
        const ui = window.__ac && window.__ac.gameUI;
        if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
        if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
        ui.wizard.name = ${JSON.stringify(charName)};
        ui.callbacks.onCharacterCreated(ui.wizard);
        return 'sent';
      })()`).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} character creation submitted (${charName})`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
}

const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

async function waitFor(page: Page, src: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(page, src).catch(() => false)) return true; await page.waitForTimeout(500); }
  return false;
}

const invIndex = (page: Page, pred: string) => ev<{ idx: number; id: number; name: string } | null>(page, `(() => {
  const items = window.__ac.gameUI.inventoryItems || [];
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (${pred}) return { idx: i, id: it.id, name: it.name }; }
  return null;
})()`);

const setDrag = (page: Page, idx: number) => ev(page, `(() => { const ui = window.__ac.gameUI; ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null; })()`);

const drop = (page: Page, target: string) => ev(page, `(() => {
  const el = ${target};
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
})()`);

/** The strip's measured geometry: filled / empty cells, icon sizes, selection overlay, list width. */
const measure = (page: Page, listId: number) => ev<Record<string, unknown>>(page, `(() => {
  const list = document.querySelector('[data-element-id="0x${listId.toString(16)}"]');
  if (!list) return { missing: true };
  const filled = Array.from(list.querySelectorAll('[data-item-cell]'));
  const empty = Array.from(list.querySelectorAll('[data-item-cell-empty]'));
  const icon = (c) => Array.from(c.children).find((k) => k.style.backgroundImage && !k.dataset.slotState && k.dataset.acDragAccept === undefined);
  return {
    listW: list.getBoundingClientRect().width,
    filled: filled.length, empty: empty.length,
    iconPx: filled.map((c) => { const i = icon(c); return i ? Math.round(i.getBoundingClientRect().width) : 0; }),
    cellPx: filled.concat(empty).slice(0, 1).map((c) => Math.round(c.getBoundingClientRect().width))[0] ?? 0,
    cssBorders: filled.filter((c) => /solid/.test(c.style.border)).length,
    selectedAnts: filled.filter((c) => c.querySelector('[data-slot-state="selected"]')).length,
    emptyTile: empty[0] ? empty[0].style.backgroundImage.slice(0, 24) : '',
  };
})()`);

async function shoot(page: Page, name: string, listId: number): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const r = await ev<{ x: number; y: number; w: number; h: number } | null>(page, `(() => {
    const host = document.querySelector('[data-element-id="0x${listId.toString(16)}"]')?.closest('[data-dock]');
    const b = host && host.getBoundingClientRect();
    return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  })()`);
  if (r) await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 20, height: r.h + 20 } });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const A = await (await browser.newContext({ viewport: VIEW })).newPage();
  await A.addInitScript('window.__name = (f) => f;');
  A.on('dialog', (d) => void d.dismiss());
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await enterWorld(A, URL_A, 'Strip Tester');
  await admin(A, '@telepoi holtburg');
  await A.waitForTimeout(7000);
  for (const cmd of [`@ci ${DIRK}`, `@ci ${MACE}`, `@ci ${PYREAL} 500`]) { await admin(A, cmd); await A.waitForTimeout(2500); }
  await A.waitForTimeout(3000);
  await ev(A, `window.acDebug.freezeTimeOfDay(0.5)`);

  // ── vendor ──
  const vendors = await ev<Array<{ guid: number; name: string; acPos: { landblock: number; x: number; y: number; z: number } | null }>>(A, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    return dbg.getObjects().filter((o) => o.pos && (o.objectDescFlags & ${VENDOR_FLAG})).map((o) => {
      const p = dbg.objectAcPosition ? dbg.objectAcPosition(o.guid) : null;
      return { guid: o.guid, name: o.name, d: Math.hypot(o.pos.x - cs.x, o.pos.z - cs.z), acPos: p ? p.position : null };
    }).sort((a, b) => a.d - b.d).slice(0, 6);
  })()`);
  const vendor: Record<string, unknown> = { tried: [] as string[] };
  let sellable: number[] = [];
  for (const v of vendors) {
    if (v.acPos) { await ev(A, `window.acDebug.tele(${v.acPos.landblock}, ${(v.acPos.x + 2.5).toFixed(2)}, ${v.acPos.y.toFixed(2)}, ${v.acPos.z.toFixed(2)})`); await A.waitForTimeout(7000); }
    await ev(A, `window.acDebug.useObject(${v.guid})`);
    const opened = await waitFor(A, `!!window.__ac.gameUI.isVendorVisible`, 25_000);
    await A.waitForTimeout(1500);
    sellable = opened ? await ev<number[]>(A, `window.__ac.gameUI.vendorData.sellItems.map((i) => i.guid)`) : [];
    const merch = opened ? await ev<number>(A, `window.__ac.gameUI.vendorData.buyItems.length`) : 0;
    (vendor.tried as string[]).push(`${v.name}: opened=${opened} sellable=${sellable.length} merch=${merch}`);
    if (opened && sellable.length >= 1 && merch >= 2) { vendor.name = v.name; break; }
    await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui.isVendorVisible) ui.hideVendorWindow(); })()`);
    await A.waitForTimeout(800);
  }
  if (vendor.name) {
    // Items: select the second merchandise cell (a real click).
    await ev(A, `(() => { const c = document.querySelectorAll('[data-element-id="0x100000bd"] [data-item-cell]'); (c[1] || c[0]).click(); })()`);
    await A.waitForTimeout(800);
    vendor.items = await measure(A, 0x100000bd);
    await shoot(A, 'ours-vendor-items', 0x100000bd);
    // Buying: Add to List twice (the selected cell, then the first).
    await ev(A, `document.querySelector('[data-element-id="0x100000c3"]').click()`);
    await ev(A, `(() => { document.querySelectorAll('[data-element-id="0x100000bd"] [data-item-cell]')[0].click(); })()`);
    await ev(A, `document.querySelector('[data-element-id="0x100000c3"]').click()`);
    await ev(A, `document.querySelector('[data-element-id="0x100000ba"]').click()`);
    await A.waitForTimeout(800);
    vendor.buying = await measure(A, 0x100000c5);
    await shoot(A, 'ours-vendor-buying', 0x100000c5);
    // Selling: one sellable item dropped on the bar.
    const first = (await invIndex(A, `${JSON.stringify(sellable)}.includes(it.id)`))!;
    await setDrag(A, first.idx);
    await drop(A, `document.querySelector('[data-element-id="0x100000ce"]').closest('[data-dock]')`);
    await setDrag(A, -1);
    await A.waitForTimeout(800);
    vendor.selling = await measure(A, 0x100000ce);
    await shoot(A, 'ours-vendor-selling', 0x100000ce);
    await ev(A, `window.__ac.gameUI.hideVendorWindow()`);
  }
  state.vendor = vendor;
  console.log(`${TAG} vendor ${JSON.stringify(vendor)}`);
  await A.waitForTimeout(1500);

  // ── slumlord ──
  await admin(A, SLUMLORD_TELEPORT);
  await A.waitForTimeout(9000);
  await ev(A, `window.__ac.useObject(${SLUMLORD_GUID})`);
  const slum: Record<string, unknown> = { opened: await waitFor(A, `!!document.querySelector('[data-slumlord-panel]')`, 20_000) };
  await A.waitForTimeout(1500);
  if (slum.opened) {
    const coins = (await invIndex(A, `it.weenieClassId === ${PYREAL}`))!;
    await setDrag(A, coins.idx);
    await drop(A, `document.querySelector('[data-element-id="0x10000095"]')`);
    await setDrag(A, -1);
    await A.waitForTimeout(1000);
    slum.buy = await measure(A, 0x10000095);
    await shoot(A, 'ours-slumlord-buy', 0x10000095);
  }
  state.slumlord = slum;
  console.log(`${TAG} slumlord ${JSON.stringify(slum)}`);
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — vendor / slumlord strip cells (live ACE, Holtburg) — before | after</h1>
  <p>Reference: no retail vendor-bar capture exists in reference/images; the DAT is the reference — all five lists name cell template 0x1000033a (icon 0x1000033b at (0,0) 32x32, EMPTY 0x06004d20), the template the trade and salvage lists (right column) already draw. p95 -1 → UpdateEmptySlots pads the view; p0x10000017 (sell + slumlord) adds a trailing empty tile.</p>
  <div>${img(join(BEFORE, 'ours-vendor-accept-zoom.png'), 'BEFORE — vendor Selling strip: 24 px icon in a CSS border, no empty tiles')}${img(join(OUT, 'ours-vendor-selling-zoom.png'), 'AFTER — vendor Selling strip: 32 px icon + padded recess tiles')}</div>
  <div>${img(join(OUT, 'ours-vendor-items-zoom.png'), 'AFTER — Items strip: the selected cell carries the UIItem ants 0x06004d09 + its amount')}${img(join(OUT, 'ours-vendor-buying-zoom.png'), 'AFTER — Buying strip (no 0x10000017): two items, padded to the view')}</div>
  <div>${img(join(BEFORE, 'ours-slumlord-accept-zoom.png'), 'BEFORE — slumlord Buy list')}${img(join(OUT, 'ours-slumlord-buy-zoom.png'), 'AFTER — slumlord Buy list')}</div>
  <div>${img(join(BEFORE, 'ours-trade-mace-accept-zoom.png'), 'REFERENCE (same template 0x1000033a) — the trade self list')}</div>
  <div>${img(join(OUT, 'ours-vendor-items.png'), 'whole screen — the vendor dock over the world')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaaaaab-vendor-strip-sidebyside.png'), fullPage: true });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
