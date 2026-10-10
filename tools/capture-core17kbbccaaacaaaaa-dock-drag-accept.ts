/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a — live check of the other transaction-dock
 * lists' drag-over feedback on the ACE stack: gmSecureTradeUI::
 * OnItemListDragOver @ 004ca980 (the self list only), VendorSellUI @ 004c2300
 * (the sell list), gmSlumlordUI @ 004c8770 (the Buy list) — each sets the
 * hovered cell's 0x1000045a to 0x10000040 (green ring 0x060011f9) /
 * 0x10000041 (red slashed circle 0x060011f8).
 *
 *   trade     two clients, a real negotiation; the dirk dropped on A's self
 *             list; the mace hovering a cell (accept), the listed dirk
 *             (refuse); the partner list has no overlay.
 *   vendor    the nearest Holtburg vendor that buys something we carry; one
 *             sellable item dropped on the Selling list; another sellable
 *             hovering its cell (accept), an unsellable one (refuse).
 *   slumlord  the cottage slumlord 0x73B9C051 Used; a coin stack dropped on
 *             the Buy list; a second coin stack hovering (accept while the
 *             price is unmet), the staged stack (refuse), the dirk (refuse).
 *
 *   npx tsx tools/capture-core17kbbccaaacaaaaa-dock-drag-accept.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const URL_B = `${BASE}&account=testacjs2&password=testacjs2`;
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kbbccaaacaaaaa]';
const SECOND_NAME = 'Range Tester Two';
const DIRK = 23320; const MACE = 23321; const PYREAL = 273;
const VENDOR_FLAG = 0x200;
const SLUMLORD_TELEPORT = '@teleloc 0x3B9C0032 [151.4 37.5 50.5] 1 0 0 0';
const SLUMLORD_GUID = 0x73B9C051;

// Source strings: tsx injects `__name` into named function bodies (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, label: string, charName: string): Promise<void> {
  await page.goto(`${url}&cb=kbbccaaacaaaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, `_login-failed-${label}.png`) }); throw new Error(`${label}: never entered world`); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await ev<string>(page, `(() => {
        const ui = window.__ac && window.__ac.gameUI;
        if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
        if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
        ui.wizard.name = ${JSON.stringify(charName)};
        ui.callbacks.onCharacterCreated(ui.wizard);
        return 'sent';
      })()`).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} ${label}: character creation submitted (${charName})`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} ${label}: in world`);
  await page.waitForTimeout(4000);
}

const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

async function waitFor(page: Page, src: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(page, src).catch(() => false)) return true; await page.waitForTimeout(500); }
  return false;
}

/** Newest inventory index matching `pred` (a JS expression over `it`). */
const invIndex = (page: Page, pred: string) => ev<{ idx: number; id: number; name: string } | null>(page, `(() => {
  const items = window.__ac.gameUI.inventoryItems || [];
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (${pred}) return { idx: i, id: it.id, name: it.name }; }
  return null;
})()`);

const setDrag = (page: Page, idx: number) => ev(page, `(() => { const ui = window.__ac.gameUI; ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null; })()`);

/** A real dragover on cell `n` of the list element `listId` (cells: `sel`); every cell's state after. */
const hover = (page: Page, listId: number, sel: string, n: number) => ev<{ states: string[]; bg: string }>(page, `(() => {
  const list = document.querySelector('[data-element-id="0x${listId.toString(16)}"]');
  const cells = Array.from(list.querySelectorAll('${sel}'));
  cells[${n}].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  const ov = (c) => c.querySelector('[data-ac-drag-accept]');
  return { states: cells.map((c) => ov(c) ? '0x' + Number(ov(c).dataset.acDragAccept).toString(16) : 'none'), bg: ov(cells[${n}]) ? ov(cells[${n}]).style.backgroundImage.slice(0, 32) : '' };
})()`);

const leave = (page: Page, listId: number, sel: string, n: number) => ev(page, `(() => {
  const list = document.querySelector('[data-element-id="0x${listId.toString(16)}"]');
  Array.from(list.querySelectorAll('${sel}'))[${n}].dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
})()`);

/** dragover + drop on `target` (a JS expression for the element). */
const drop = (page: Page, target: string) => ev(page, `(() => {
  const el = ${target};
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
})()`);

const overlays = (page: Page, listId: number) => ev<number>(page, `document.querySelector('[data-element-id="0x${listId.toString(16)}"]')?.querySelectorAll('[data-ac-drag-accept]').length ?? -1`);

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
  const B = await (await browser.newContext({ viewport: VIEW })).newPage();
  for (const p of [A, B]) {
    await p.addInitScript('window.__name = (f) => f;');
    p.on('dialog', (d) => void d.dismiss());
  }
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await enterWorld(A, URL_A, 'A', 'Trade Tester One');
  await enterWorld(B, URL_B, 'B', SECOND_NAME);
  await admin(A, '@telepoi holtburg');
  await A.waitForTimeout(7000);
  const nameB = await ev<string>(B, `(window.__ac && window.__ac.playerState && window.__ac.playerState.name) || ''`).catch(() => '') || SECOND_NAME;
  for (const cmd of [`@ci ${DIRK}`, `@ci ${MACE}`, `@ci ${PYREAL} 500`, `@ci ${PYREAL} 300`]) { await admin(A, cmd); await A.waitForTimeout(2500); }
  await A.waitForTimeout(3000);
  await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui && !ui.inventoryVisible) ui.toggleInventory(); })()`);
  for (const p of [A, B]) await ev(p, `window.acDebug.freezeTimeOfDay(0.5)`);
  state.inventoryA = await ev(A, `(window.__ac.gameUI.inventoryItems || []).map((it) => it.weenieClassId + ':' + it.name + 'x' + it.stackSize)`);

  // ── 1. trade ──
  const findPartner = () => ev<{ guid: number } | null>(A, `(() => {
    const o = window.acDebug.getObjects().find((x) => (x.name || '').toLowerCase() === ${JSON.stringify(nameB.toLowerCase())});
    return o ? { guid: o.guid } : null;
  })()`);
  let partner = null as { guid: number } | null;
  for (let i = 0; !partner && i < 6; i++) {
    await admin(A, i % 2 === 0 ? `@teletome ${nameB}` : `@teleto ${nameB}`);
    await A.waitForTimeout(10000);
    partner = await findPartner();
  }
  if (!partner) throw new Error('partner never loaded');
  await ev(A, `window.acDebug.tradeOpen(${partner.guid})`);
  if (!(await waitFor(A, `!!window.__ac.gameUI.tradePanel`, 30_000))) throw new Error('trade never opened');
  await A.waitForTimeout(1500);
  const dirk = (await invIndex(A, `it.weenieClassId === ${DIRK}`))!;
  const mace = (await invIndex(A, `it.weenieClassId === ${MACE}`))!;
  await setDrag(A, dirk.idx);
  await drop(A, `document.querySelector('[data-element-id="0x10000088"]')`);
  await waitFor(A, `window.__ac.gameUI.getTradeData().yourItems.some((i) => i.guid === ${dirk.id})`, 10_000);
  await A.waitForTimeout(800);
  const TSEL = '[data-ac-trade-cell]';
  const trade: Record<string, unknown> = {
    listed: await ev(A, `window.__ac.gameUI.getTradeData().yourItems.map((i) => i.name)`),
    selfOverlays: await overlays(A, 0x10000088), partnerOverlays: await overlays(A, 0x10000081),
  };
  await setDrag(A, (await invIndex(A, `it.weenieClassId === ${MACE}`))!.idx);
  trade.maceHover = await hover(A, 0x10000088, TSEL, 1);
  await shoot(A, 'ours-trade-mace-accept', 0x10000088);
  await leave(A, 0x10000088, TSEL, 1);
  await setDrag(A, (await invIndex(A, `it.weenieClassId === ${DIRK}`))!.idx);
  trade.listedDirkHover = await hover(A, 0x10000088, TSEL, 0);
  await shoot(A, 'ours-trade-dirk-refuse', 0x10000088);
  await leave(A, 0x10000088, TSEL, 0);
  state.trade = trade;
  console.log(`${TAG} trade ${JSON.stringify(trade)}`);
  await ev(A, `window.acDebug.tradeClose && window.acDebug.tradeClose()`).catch(() => {});
  await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui.hideTradeWindow) ui.hideTradeWindow(); })()`);
  await A.waitForTimeout(3000);

  // ── 2. vendor ──
  await admin(A, '@telepoi holtburg');
  await A.waitForTimeout(8000);
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
    (vendor.tried as string[]).push(`${v.name}: opened=${opened} sellable=${sellable.length}`);
    if (opened && sellable.length >= 2) { vendor.name = v.name; break; }
    await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui.isVendorVisible) ui.hideVendorWindow(); })()`);
    await A.waitForTimeout(800);
  }
  if (vendor.name) {
    const first = (await invIndex(A, `${JSON.stringify(sellable)}.includes(it.id)`))!;
    const second = (await invIndex(A, `${JSON.stringify(sellable)}.includes(it.id) && it.id !== ${first.id}`))!;
    const unsellable = await invIndex(A, `!${JSON.stringify(sellable)}.includes(it.id)`);
    vendor.items = { first: first.name, second: second.name, unsellable: unsellable?.name ?? null };
    await setDrag(A, first.idx);
    await drop(A, `document.querySelector('[data-element-id="0x100000ce"]').closest('[data-dock]')`);
    await A.waitForTimeout(800);
    const VSEL = '[data-item-cell]';
    vendor.sellListOverlays = await overlays(A, 0x100000ce);
    await setDrag(A, second.idx);
    vendor.secondHover = await hover(A, 0x100000ce, VSEL, 0);
    await shoot(A, 'ours-vendor-accept', 0x100000ce);
    if (unsellable) {
      await setDrag(A, unsellable.idx);
      vendor.unsellableHover = await hover(A, 0x100000ce, VSEL, 0);
      await shoot(A, 'ours-vendor-refuse', 0x100000ce);
    }
    await leave(A, 0x100000ce, VSEL, 0);
    vendor.afterLeave = await hover(A, 0x100000ce, VSEL, 0).catch(() => null); // dragItemIndex still set: re-probe
    await leave(A, 0x100000ce, VSEL, 0);
    await setDrag(A, -1);
    await ev(A, `window.__ac.gameUI.hideVendorWindow()`);
  }
  state.vendor = vendor;
  console.log(`${TAG} vendor ${JSON.stringify(vendor)}`);
  await A.waitForTimeout(1500);

  // ── 3. slumlord ──
  await admin(A, SLUMLORD_TELEPORT);
  await A.waitForTimeout(9000);
  await ev(A, `window.__ac.useObject(${SLUMLORD_GUID})`);
  const slum: Record<string, unknown> = { opened: await waitFor(A, `!!document.querySelector('[data-slumlord-panel]')`, 20_000) };
  await A.waitForTimeout(1500);
  if (slum.opened) {
    slum.profileBuy = await ev(A, `(window.__ac.gameUI.getHouseData().profile || {}).buy`);
    const coinsA = (await invIndex(A, `it.weenieClassId === ${PYREAL} && it.stackSize === 500`)) ?? (await invIndex(A, `it.weenieClassId === ${PYREAL}`))!;
    const coinsB = await invIndex(A, `it.weenieClassId === ${PYREAL} && it.id !== ${coinsA.id}`);
    await setDrag(A, coinsA.idx);
    await drop(A, `document.querySelector('[data-element-id="0x10000095"]')`);
    await A.waitForTimeout(1000);
    const SSEL = '[data-item-cell]';
    slum.staged = await ev(A, `window.__ac.gameUI.housePayment.buy`);
    if (coinsB) {
      await setDrag(A, coinsB.idx);
      slum.secondCoinsHover = await hover(A, 0x10000095, SSEL, 0);
      await shoot(A, 'ours-slumlord-accept', 0x10000095);
    }
    await setDrag(A, (await invIndex(A, `it.id === ${coinsA.id}`))!.idx);
    slum.stagedCoinsHover = await hover(A, 0x10000095, SSEL, 0);
    await setDrag(A, (await invIndex(A, `it.weenieClassId === ${DIRK}`))!.idx);
    slum.dirkHover = await hover(A, 0x10000095, SSEL, 0);
    await shoot(A, 'ours-slumlord-refuse', 0x10000095);
    await leave(A, 0x10000095, SSEL, 0);
    await setDrag(A, -1);
  }
  state.slumlord = slum;
  console.log(`${TAG} slumlord ${JSON.stringify(slum)}`);
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const tex = (id: string) => img(join(REPO, 'verification', 'core17kbbccaaacaaaa', `${id}.png`), id);
  const z = (n: string, cap: string) => img(join(OUT, `${n}-zoom.png`), cap);
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.tex img{width:96px;image-rendering:pixelated}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a — trade / vendor / slumlord list drag-over state (live ACE, Holtburg)</h1>
  <p>Reference: no retail capture of a mid-drag dock cell exists; the DAT is the reference — every drag-handler list's cell template 0x1000033a draws 0x1000045a from 0x21000037:0x1000045d: 0x10000040 → 0x060011f9, 0x10000041 → 0x060011f8. Before this change only the salvage list showed it.</p>
  <div class="tex">${tex('0x060011f9')}${tex('0x060011f8')}</div>
  <div>${z('ours-trade-mace-accept', 'trade self list: the mace over a cell → 0x10000040')}${z('ours-trade-dirk-refuse', 'trade: the already-listed dirk → 0x10000041')}</div>
  <div>${z('ours-vendor-accept', 'vendor sell list: a second sellable item → 0x10000040')}${z('ours-vendor-refuse', 'vendor: an item the vendor does not buy → 0x10000041')}</div>
  <div>${z('ours-slumlord-accept', 'slumlord Buy list: a second coin stack (price unmet) → 0x10000040')}${z('ours-slumlord-refuse', 'slumlord: the dirk (no requirement for its wcid) → 0x10000041')}</div>
  <div>${img(join(OUT, 'ours-trade-mace-accept.png'), 'whole screen — the trade dock mid-drag')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaaaaa-dock-drag-accept-sidebyside.png'), fullPage: true });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
