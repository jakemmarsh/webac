/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.a — live evidence for the VendorSellUI
 * DragItemAcceptable / AcceptDragObject port on the ACE stack (Holtburg,
 * Shopkeeper Renald the Elder — MerchandiseItemTypes 0x480467A7, min 0, max
 * 1,000,000):
 *
 *   emerald   @ci 2410 (TYPE_GEM, outside the shopkeeper's types) dropped on the
 *             bar → "That item cannot be sold here" (before: silent)
 *   dirk      @ci 23320 (a melee weapon of value 0) → "That item has no
 *             value and cannot be sold" (before: silent)
 *   split     @ci 258 20 apples (Food, 7 each; no server PluralName),
 *             selected, toolbar split 5, dropped → StackableSplitToContainer
 *             + "Splitting the Apples before selling them"; the arriving
 *             5-stack replaces the 20 on the list; Sell Item sells 5
 *             (before: the list held "5 of the 20" and ACE's
 *             VerifySellItems — keyed on the object, not the amount — sold
 *             all 20). (Arrow 300 is IsSellable = false in the world DB:
 *             ACE refuses it server-side, a flag the client never sees.)
 *
 *   npx tsx tools/capture-core17kbbccaaacaaaaaa-vendor-sell-drag.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaaaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL = process.env.AC_URL ?? `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const TAG = '[core17kbbccaaacaaaaaa]';
const CHAR_NAME = 'Sell Tester';
const APPLE_WCID = 258; const DIRK_WCID = 23320; const EMERALD_WCID = 2410; const COIN_WCID = 273;
const VENDOR = 'Shopkeeper Renald the Elder';

interface InvItem { id: number; name: string; weenieClassId: number; stackSize: number; containerId: number; value: number; itemType: number }

const launch = () => chromium.launch({
  args: ['--enable-unsafe-swiftshader'],
  ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
});

// Source strings: tsx injects `__name` into named function bodies (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page): Promise<void> {
  await page.goto(`${URL}&cb=kbbccaaacaaaaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await ev<string>(page, `(() => {
        const ui = window.__ac && window.__ac.gameUI;
        if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
        if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
        ui.wizard.name = ${JSON.stringify(CHAR_NAME)};
        ui.callbacks.onCharacterCreated(ui.wizard);
        return 'sent';
      })()`).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} character creation submitted`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
}

const inventory = (page: Page): Promise<InvItem[]> => ev<InvItem[]>(page, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id, name: i.name, weenieClassId: i.weenieClassId, stackSize: i.stackSize, containerId: i.containerId, value: i.value, itemType: i.itemType || 0 }))`);

async function ci(page: Page, wcid: number, amount?: number): Promise<InvItem> {
  const before = new Set((await inventory(page)).map((i) => i.id));
  await ev(page, `window.acDebug.admin('@ci ${wcid}${amount ? ` ${amount}` : ''}')`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const fresh = (await inventory(page)).filter((i) => !before.has(i.id) && i.weenieClassId === wcid);
    if (fresh.length > 0 && (!amount || fresh[0].stackSize === amount)) return fresh[0];
  }
  const late = (await inventory(page)).filter((i) => !before.has(i.id) && i.weenieClassId === wcid);
  if (late.length > 0) { console.log(`${TAG} @ci ${wcid} ${amount ?? ''} → stack ${late[0].stackSize}`); return late[0]; }
  throw new Error(`@ci ${wcid} ${amount ?? ''} produced no inventory item`);
}

async function waitInv(page: Page, pred: (items: InvItem[]) => boolean, ms = 10_000): Promise<InvItem[]> {
  const deadline = Date.now() + ms;
  let items = await inventory(page);
  while (!pred(items) && Date.now() < deadline) { await page.waitForTimeout(400); items = await inventory(page); }
  return items;
}

async function waitFor(page: Page, src: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(page, src).catch(() => false)) return true; await page.waitForTimeout(500); }
  return false;
}

/** The retail drag: dragstart on the item's inventory cell, dragover + drop on the vendor bar's sell list. */
const dragToSellList = (page: Page, guid: number) => ev<string>(page, `(() => {
  const ui = window.__ac.gameUI;
  const idx = ui.inventoryItems.findIndex((i) => i.id === ${guid});
  if (idx < 0) return 'no-item';
  const cell = document.querySelector('[data-inv-slot="' + idx + '"]');
  const bar = ui.vendorWrapper;
  if (!cell) return 'no-cell'; if (!bar) return 'no-vendor';
  const dt = new DataTransfer();
  cell.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const target = ui.vendorWrapper;
  const list = target.querySelector('[data-element-id="0x100000ce"]') || target;
  list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  cell.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()`);

const spewText = (page: Page): Promise<string[]> => ev<string[]>(page, `Array.from(document.querySelectorAll('#hud-spew-box .spew-item')).map((r) => { const c = r.querySelector('[data-ac-run-text], [data-ac-full-text], canvas, span'); return (c && (c.dataset.acRunText || c.dataset.acFullText || c.textContent)) || r.textContent || ''; }).filter(Boolean)`);
const sellList = (page: Page) => ev<Array<{ guid: string; qty: number }>>(page, `window.__ac.gameUI.vendorData.sellList.map((e) => ({ guid: '0x' + e.guid.toString(16), qty: e.qty }))`);

async function crop(page: Page, selectorOrExpr: string, out: string, pad = 6, isExpr = false): Promise<boolean> {
  const r = await ev<{ x: number; y: number; width: number; height: number } | null>(page, `(() => { const el = ${isExpr ? selectorOrExpr : `document.querySelector(${JSON.stringify(selectorOrExpr)})`}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  if (!r || r.width === 0 || r.height === 0) return false;
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(VIEW.width - Math.max(0, r.x - pad), r.width + 2 * pad), height: Math.min(VIEW.height - Math.max(0, r.y - pad), r.height + 2 * pad) };
  await page.screenshot({ path: out, clip });
  return true;
}

async function step(page: Page, name: string, state: Record<string, unknown>, guid: number, extra: Record<string, unknown> = {}): Promise<void> {
  const drop = await dragToSellList(page, guid);
  await page.waitForTimeout(250);
  const spew = await spewText(page);
  await crop(page, '#hud-spew-box', join(OUT, `${PREFIX}-${name}-spew.png`), 2);
  await page.screenshot({ path: join(OUT, `${PREFIX}-${name}.png`) });
  await crop(page, 'window.__ac.gameUI.vendorWrapper', join(OUT, `${PREFIX}-${name}-bar.png`), 4, true);
  const cell = { drop, spew, sellList: await sellList(page), ...extra };
  (state.cells as Record<string, unknown>)[name] = cell;
  console.log(`${TAG} ${name}: ${JSON.stringify(cell)}`);
  await page.waitForTimeout(5500); // let the spew row expire before the next gesture
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  const consoleLines: string[] = [];
  let tapAll = false;
  page.on('console', (m) => { const t = m.text(); if (tapAll || /StackableSplitToContainer|Sent Sell|pageerror/.test(t)) { consoleLines.push(t.slice(0, 300)); console.log(`${TAG} page: ${t.slice(0, 300)}`); } });
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: {} };

  await enterWorld(page);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(8000);
  // Earlier runs' leftovers push this character past its burden (ACE then
  // refuses the @ci stack silently): drop them before creating fresh ones.
  for (const it of (await inventory(page)).filter((i) => [300, APPLE_WCID, DIRK_WCID, EMERALD_WCID].includes(i.weenieClassId))) {
    await ev(page, `window.acDebug.dropInventoryItem(${it.id})`);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2000);
  const emerald = await ci(page, EMERALD_WCID);
  const dirk = await ci(page, DIRK_WCID);
  const apples = await ci(page, APPLE_WCID, 20);
  await ev(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); ui.selectedPackSlot = 0; ui.renderInventoryPanel(); })()`);

  let opened = false;
  for (let i = 0; i < 4 && !opened; i++) {
    const v = await ev<{ guid: number; acPos: { landblock: number; x: number; y: number; z: number } | null } | null>(page, `(() => {
      const dbg = window.acDebug; const o = dbg.getObjects().find((x) => x.name === ${JSON.stringify(VENDOR)});
      if (!o) return null; const p = dbg.objectAcPosition ? dbg.objectAcPosition(o.guid) : null;
      return { guid: o.guid, acPos: p ? p.position : null };
    })()`);
    if (!v) {
      const seen = await ev<string[]>(page, `window.acDebug.getObjects().filter((o) => o.objectDescFlags & 0x200).map((o) => o.name)`);
      console.log(`${TAG} no ${VENDOR} yet; vendors in view: ${JSON.stringify(seen)}`);
      await page.waitForTimeout(4000); continue;
    }
    console.log(`${TAG} ${VENDOR} 0x${v.guid.toString(16)} at ${JSON.stringify(v.acPos)}`);
    if (v.acPos) { await ev(page, `window.acDebug.tele(${v.acPos.landblock}, ${(v.acPos.x + 2).toFixed(2)}, ${v.acPos.y.toFixed(2)}, ${v.acPos.z.toFixed(2)})`); await page.waitForTimeout(7000); }
    await ev(page, `window.acDebug.useObject(${v.guid})`);
    opened = await waitFor(page, `!!window.__ac.gameUI.isVendorVisible`, 25_000);
  }
  if (!opened) throw new Error('the shopkeeper never opened');
  await page.waitForTimeout(1500);
  state.profile = await ev(page, `window.__ac.gameUI.vendorData.profile || null`);
  state.items = { emerald, dirk, apples };

  await step(page, 'emerald', state, emerald.id);
  await step(page, 'dirk', state, dirk.id);

  // Split: select the apples, the toolbar split entry at 10, drag them on.
  const splitSet = await ev<unknown>(page, `(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.id === ${apples.id});
    const cell = document.querySelector('[data-inv-slot="' + idx + '"]');
    if (!cell) return 'no-cell';
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const entry = document.getElementById('tb-stack-entry');
    if (!entry) return 'no-entry';
    entry.focus(); entry.value = '5';
    entry.dispatchEvent(new Event('input', { bubbles: true }));
    entry.dispatchEvent(new Event('change', { bubbles: true }));
    entry.blur();
    return ui.getToolbarSplitState ? ui.getToolbarSplitState() : entry.value;
  })()`);
  await step(page, 'split', state, apples.id, { splitSet });
  const afterSplit = await waitInv(page, (items) => items.filter((i) => i.weenieClassId === APPLE_WCID).length >= 2, 8000);
  await page.waitForTimeout(1500);
  const appleStacks = () => inventory(page).then((xs) => xs.filter((i) => i.weenieClassId === APPLE_WCID).map((i) => ({ id: `0x${i.id.toString(16)}`, stackSize: i.stackSize })));
  const settled = { appleStacks: afterSplit.filter((i) => i.weenieClassId === APPLE_WCID).map((i) => ({ id: `0x${i.id.toString(16)}`, stackSize: i.stackSize })), sellList: await sellList(page) };
  await page.screenshot({ path: join(OUT, `${PREFIX}-split-settled.png`) });
  await crop(page, 'window.__ac.gameUI.vendorWrapper', join(OUT, `${PREFIX}-split-settled-bar.png`), 4, true);
  (state.cells as Record<string, unknown>).splitSettled = settled;
  console.log(`${TAG} split settled: ${JSON.stringify(settled)}`);

  // Sell Item (0x100000d2): what ACE actually takes.
  const coinsBefore = (await inventory(page)).filter((i) => i.weenieClassId === COIN_WCID).reduce((s, i) => s + i.stackSize, 0);
  tapAll = true;
  await ev(page, `window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000d2).click()`);
  await page.waitForTimeout(1500);
  const sellSpew = await spewText(page);
  await page.waitForTimeout(4000);
  const chatTail = await ev<string[]>(page, `(() => { const ui = window.__ac.gameUI; const el = ui.chatMessages; return el ? Array.from(el.children).slice(-6).map((c) => (c.textContent || '').trim()) : []; })()`);
  tapAll = false;
  const coinsAfter = (await inventory(page)).filter((i) => i.weenieClassId === COIN_WCID).reduce((s, i) => s + i.stackSize, 0);
  (state.cells as Record<string, unknown>).sold = { appleStacksAfterSell: await appleStacks(), coinsBefore, coinsAfter, sellSpew, chatTail, console: consoleLines.slice() };
  console.log(`${TAG} sold: ${JSON.stringify((state.cells as Record<string, unknown>).sold)}`);
  await page.screenshot({ path: join(OUT, `${PREFIX}-sold.png`) });

  writeFileSync(join(OUT, `${PREFIX}-live-state.json`), JSON.stringify(state, null, 2));
  await browser.close();
}

const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function compose(): Promise<void> {
  const st = (mode: string): Record<string, Any> => { const f = join(OUT, `${mode}-live-state.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).cells : {}; };
  const before = st('before'); const ours = st('ours');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const row = (name: string, label: string, extra = '') => `<div class="row">
    <div class="cell" style="width:100%"><div class="lbl"><b>${name}</b> — ${label}</div>
    <pre>before: ${JSON.stringify(before[name] ?? null)}\nafter:  ${JSON.stringify(ours[name] ?? null)}${extra}</pre></div>
    ${img(join(OUT, `before-${name}-spew.png`), 'before — spew at 2x')}${img(join(OUT, `ours-${name}-spew.png`), 'after — spew at 2x')}
    ${img(join(OUT, `before-${name}-bar.png`), 'before — vendor bar', 'frame')}${img(join(OUT, `ours-${name}-bar.png`), 'after — vendor bar', 'frame')}
  </div>`;
  await page.setContent(`<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
    .cell{display:flex;flex-direction:column;gap:4px} .lbl{color:#ffd;max-width:820px}
    .zoom{display:block;zoom:2;border:1px solid #444} .frame{display:block;border:1px solid #444;max-width:820px}
    h1{font-size:14px;margin:0 0 8px} pre{color:#ccc;margin:4px 0;white-space:pre-wrap;max-width:1850px}
  </style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.a — VendorSellUI::DragItemAcceptable / AcceptDragObject: before | after (live ACE, Holtburg shopkeeper)</h1>
  <p>Reference: the decompiled EoL client — DragItemAcceptable @ 004c20c0 + VendorProfile::InqAcceptability @ 005d1a90 push the 0x1a notices from acclient.exe .rdata; AcceptDragObject @ 004c4f00 splits a partial stack in place ("Splitting the %s before selling them") and ItemAttributesChanged @ 004c3fd0 swaps the split-off stack in. No retail capture of these notices exists; the binary's strings are the reference.</p>
  ${row('emerald', 'an Emerald (TYPE_GEM) onto the shopkeeper (types 0x480467A7)')}
  ${row('dirk', 'a Rusted Dirk (melee, value 0)')}
  ${row('split', 'Apples ×20 selected, toolbar split 5, dropped')}
  ${row('splitSettled', 'after the split-off stack arrived')}
  <div class="row"><div class="cell" style="width:100%"><div class="lbl"><b>sold</b> — Sell Item on the list</div><pre>before: ${JSON.stringify(before.sold ?? null)}\nafter:  ${JSON.stringify(ours.sold ?? null)}</pre></div></div>
  <div class="row">${img(join(OUT, 'ours-split.png'), 'whole screen — the split drop (after)', 'frame')}${img(join(OUT, 'scene-hud-vendor-over-world.png'), 'scene: hud-vendor-over-world', 'frame')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaacaaaaaa-vendor-sell-drag-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote the side-by-side`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
