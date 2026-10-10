/**
 * CORE.17.k.b.b.c.c.a.a.c.a.b.a.a — live evidence for the slumlord split
 * notice's plural: gmSlumlordUI::AcceptDragObject @ 004c87c0 names the stack
 * via ACCWeenieObject::GetObjectName(NAME_APPROPRIATE) @ 0058e6e0, which
 * appends "s" / "es" client-side when the server sends no PluralName (ACE
 * weenie 273 'coinstack' defines none). `@ci 273 25000`, the toolbar split
 * entry lowered to 100, dragged onto the Buy list → the spew box reads
 * "Splitting the Pyreals before adding to housing panel" (ours read
 * "Pyreal" before the fix).
 *
 *   npx tsx tools/capture-core17kbbccaaacabaa-slumlord-plural.ts [--before] [--compose-only]
 *
 * `--before`: check out the claim commit's SlumlordPanel.ts first (Vite HMR).
 * Writes <prefix>-split*.png + <prefix>-live-state.json and composes
 * core17kbbccaaacabaa-slumlord-plural-sidebyside.png under verification/core17kbbccaaacabaa/.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacabaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL = process.env.AC_URL ?? `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const TAG = '[core17kbbccaaacabaa]';
const CHAR_NAME = 'Plural Tester';
const PACK_WCID = 136;      // ace_world.weenie 'backpack' — "Pack"
const TAPER_WCID = 20631;   // 'Prismatic Taper' (MaxStackSize 1000)
const COIN_WCID = 273;      // 'coinstack' (MaxStackSize 25000)
const NOTE_250K_WCID = 20630;
const NOTE_5K_WCID = 2624;
const SLUMLORD_GUID = 0x80000123;

interface InvItem { id: number; name: string; weenieClassId: number; stackSize: number; containerId: number; value: number; itemType: number }
interface Payments { buy: Array<{ guid: number; name: string; amount: number; weenieId: number }>; rent: Array<{ guid: number; name: string; amount: number; weenieId: number }>; buttons: { buy: number; rent: number } | null }

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

// Source strings for page.evaluate: tsx injects a `__name` helper into named
// function bodies that does not exist in the page (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return ev<string>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`);
}

async function enterWorld(page: Page): Promise<void> {
  console.log(`${TAG} navigating`);
  await page.goto(`${URL}&cb=kbbccaaacabaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, CHAR_NAME).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} character creation submitted (${CHAR_NAME})`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

const inventory = (page: Page): Promise<InvItem[]> => ev<InvItem[]>(page, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id, name: i.name, weenieClassId: i.weenieClassId, stackSize: i.stackSize, containerId: i.containerId, value: i.value, itemType: i.itemType || 0 }))`);

/** `@ci <wcid> [amount]` and wait for the one new inventory item. */
async function ci(page: Page, wcid: number, amount?: number): Promise<InvItem> {
  const before = new Set((await inventory(page)).map((i) => i.id));
  await ev(page, `window.acDebug.admin('@ci ${wcid}${amount ? ` ${amount}` : ''}')`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const fresh = (await inventory(page)).filter((i) => !before.has(i.id) && i.weenieClassId === wcid);
    if (fresh.length > 0 && (!amount || fresh[0].stackSize === amount)) return fresh[0];
  }
  throw new Error(`@ci ${wcid} ${amount ?? ''} produced no inventory item`);
}

async function waitFor(page: Page, pred: (items: InvItem[]) => boolean, ms = 10_000): Promise<InvItem[]> {
  const deadline = Date.now() + ms;
  let items = await inventory(page);
  while (!pred(items) && Date.now() < deadline) { await page.waitForTimeout(400); items = await inventory(page); }
  return items;
}

async function ensureInventoryOpen(page: Page): Promise<void> {
  await ev(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()`);
  await page.waitForTimeout(400);
}

/** Show the pack tab holding `guid` (0 = the main pack) so its cells exist in the grid. */
async function showPack(page: Page, packGuid: number): Promise<void> {
  await ev(page, `(() => {
    const ui = window.__ac.gameUI;
    const slot = ${packGuid} ? ui.sidePackGuids.indexOf(${packGuid}) : 0;
    if (slot >= 0 && ui.selectedPackSlot !== slot) { ui.selectedPackSlot = slot; ui.renderInventoryPanel(); }
  })()`);
  await page.waitForTimeout(300);
}

/** The retail drag: dragstart on the item's inventory cell, drop on the open page's UIElement_ItemList. */
async function dragToList(page: Page, guid: number, tab: 'buy' | 'rent' = 'buy'): Promise<string> {
  const item = (await inventory(page)).find((i) => i.id === guid);
  const sidePacks = await ev<number[]>(page, `window.__ac.gameUI.sidePackGuids.slice()`);
  await showPack(page, item && sidePacks.indexOf(item.containerId) > 0 ? item.containerId : 0);
  return ev<string>(page, `(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.id === ${guid});
    if (idx < 0) return 'no-item';
    const cell = document.querySelector('[data-inv-slot="' + idx + '"]');
    const list = document.querySelector('[data-slumlord-list="${tab}"]');
    if (!cell) return 'no-cell'; if (!list) return 'no-list';
    const dt = new DataTransfer();
    cell.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    cell.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    // The spew box's rows right after the drop (SPEW_ITEM_LIFETIME_MS = 5 s — a later read misses them).
    const spew = Array.from(document.querySelectorAll('#hud-spew-box .spew-item')).map((r) => { const c = r.querySelector('[data-ac-run-text], [data-ac-full-text], canvas, span'); return (c && (c.dataset.acRunText || c.dataset.acFullText || c.textContent)) || r.textContent || ''; }).filter(Boolean);
    return 'dropped' + (spew.length ? ' spew=' + JSON.stringify(spew) : '');
  })()`);
}

async function payments(page: Page): Promise<Payments> {
  return ev<Payments>(page, `(() => {
    const ui = window.__ac.gameUI;
    const m = (p) => ({ guid: p.guid, name: p.name, amount: p.amount, weenieId: p.weenieId });
    return { buy: ui.getHousePayment('buy').map(m), rent: ui.getHousePayment('rent').map(m), buttons: ui.getSlumlordButtonStates ? ui.getSlumlordButtonStates() : null };
  })()`);
}

const spewText = (page: Page): Promise<string[]> => ev<string[]>(page, `Array.from(document.querySelectorAll('#hud-spew-box .spew-item')).map((r) => { const c = r.querySelector('[data-ac-run-text], [data-ac-full-text], canvas, span'); return (c && (c.dataset.acRunText || c.dataset.acFullText || c.textContent)) || r.textContent || ''; }).filter(Boolean)`);

/** The staged guids' inventory cells and whether each carries the trade overlay. */
async function overlays(page: Page, guids: number[]): Promise<Record<string, string | null>> {
  return ev<Record<string, string | null>>(page, `(() => {
    const ui = window.__ac.gameUI; const out = {};
    for (const g of ${JSON.stringify(guids)}) {
      const idx = ui.inventoryItems.findIndex((i) => i.id === g);
      const cell = idx >= 0 ? document.querySelector('[data-inv-slot="' + idx + '"]') : null;
      const ov = cell && cell.querySelector('[data-slot-state]');
      out['0x' + g.toString(16)] = cell ? (ov ? ov.dataset.slotState : 'none') : null;
    }
    return out;
  })()`);
}

async function crop(page: Page, selector: string, out: string, pad = 6): Promise<boolean> {
  const r = await ev<{ x: number; y: number; width: number; height: number } | null>(page, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  if (!r || r.width === 0 || r.height === 0) return false;
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(VIEW.width - Math.max(0, r.x - pad), r.width + 2 * pad), height: Math.min(VIEW.height - Math.max(0, r.y - pad), r.height + 2 * pad) };
  await page.screenshot({ path: out, clip });
  return true;
}

async function snap(page: Page, name: string, state: Record<string, unknown>, extra: Record<string, unknown>): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${PREFIX}-${name}.png`) });
  const panel = await crop(page, '[data-slumlord-panel]', join(OUT, `${PREFIX}-${name}-panel.png`));
  const inv = await crop(page, '[data-panel="0x21000023"]', join(OUT, `${PREFIX}-${name}-inventory.png`));
  const spew = await crop(page, '#hud-spew-box', join(OUT, `${PREFIX}-${name}-spew.png`), 2);
  const pay = await payments(page);
  const cell = { ...extra, payments: pay, spew: await spewText(page), crops: { panel, inv, spew } };
  (state.cells as Record<string, unknown>)[name] = cell;
  console.log(`${TAG} ${name}: buy=${JSON.stringify(pay.buy)} buttons=${JSON.stringify(pay.buttons)} spew=${JSON.stringify(cell.spew)} ${JSON.stringify(extra)}`);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  const consoleLines: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/QueryLord|StackableSplitToContainer|House payment|HouseStatus|Staged house payment|InventoryPutIn3D|pageerror/.test(t)) { consoleLines.push(t); console.log(`${TAG} page: ${t}`); }
  });
  page.on('pageerror', (e) => console.log(`${TAG} pageerror`, e.message));
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: {} };

  await enterWorld(page);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(500);

  // The dialog: after-mode testSlumlordPanel sets m_iidOwner (activeSlumlordGuid) for the
  // QueryLord cell; both modes then take the same profile (38,000 pyreals + 5 Prismatic Tapers).
  await ev(page, `(() => {
    const d = window.acDebug; const ui = window.__ac.gameUI;
    if (d.testSlumlordPanel) d.testSlumlordPanel(false, false, ${SLUMLORD_GUID});
    ui.setHouseData({ profile: {
      dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0, maintenanceFree: false,
      slumlordGuid: ${SLUMLORD_GUID}, minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
      buy: [
        { name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: ${COIN_WCID} },
        { name: 'Prismatic Taper', pluralName: 'Prismatic Tapers', num: 5, paid: 0, weenieId: ${TAPER_WCID} },
      ],
      rent: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 0, weenieId: ${COIN_WCID} }],
    } });
    ui.showSlumlordPanel();
  })()`);
  await ensureInventoryOpen(page);

  // ── split ──
  const coins25k = await ci(page, COIN_WCID, 25000);
  const splitSet = await ev<{ split: unknown; entry: string | null }>(page, `(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.id === ${coins25k.id});
    const cell = document.querySelector('[data-inv-slot="' + idx + '"]');
    if (!cell) return { split: 'no-cell', entry: null };
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const entry = document.getElementById('tb-stack-entry');
    if (!entry) return { split: 'no-entry', entry: null };
    entry.focus(); entry.value = '100';
    entry.dispatchEvent(new Event('input', { bubbles: true }));
    entry.dispatchEvent(new Event('change', { bubbles: true }));
    entry.blur();
    return { split: ui.getToolbarSplitState ? ui.getToolbarSplitState() : null, entry: entry.value };
  })()`);
  console.log(`${TAG} split state ${JSON.stringify(splitSet)}`);
  const invBeforeSplit = (await inventory(page)).filter((i) => i.weenieClassId === COIN_WCID).map((i) => i.stackSize);
  const dSplit = await dragToList(page, coins25k.id);
  // The spew row lives 5 s (SPEW_ITEM_LIFETIME_MS): crop it right after the drop.
  await crop(page, '#hud-spew-box', join(OUT, `${PREFIX}-split-dropspew.png`), 2);
  await page.screenshot({ path: join(OUT, `${PREFIX}-split-drop.png`) });
  const splitInv = await waitFor(page, (items) => items.filter((i) => i.weenieClassId === COIN_WCID).length > invBeforeSplit.length, 8000);
  const coinStacks = splitInv.filter((i) => i.weenieClassId === COIN_WCID).map((i) => ({ id: `0x${i.id.toString(16)}`, stackSize: i.stackSize, containerId: `0x${i.containerId.toString(16)}` }));
  const serverPlural = await ev<unknown>(page, `(() => { const i = window.__ac.playerState.inventory.getAll().find((x) => x.id === ${coins25k.id}); return i ? { name: i.name, pluralName: i.pluralName ?? null } : null; })()`);
  await snap(page, 'split', state, { serverPlural, stack: `0x${coins25k.id.toString(16)}`, splitState: splitSet, drop: dSplit, coinStacksBefore: invBeforeSplit, coinStacksAfter: coinStacks, console: consoleLines.filter((l) => /StackableSplitToContainer/.test(l)) });

  writeFileSync(join(OUT, `${PREFIX}-live-state.json`), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:820px}
  .zoom{display:block;zoom:2;border:1px solid #444;image-rendering:pixelated}
  .frame{display:block;border:1px solid #444;max-width:820px}
  h1{font-size:14px;margin:0 0 8px}
  p,pre{max-width:1700px;color:#ccc;margin:4px 0;white-space:pre-wrap}
</style>`;

const CELLS: Array<{ name: string; label: string; crops: string[] }> = [
  { name: 'split', label: '25,000 pyreals (weenie 273 — the server sends no PluralName) selected with the toolbar split entry at 100, dragged onto the Buy list → StackableSplitToContainer + the AcceptDragObject notice named by GetObjectName(NAME_APPROPRIATE)', crops: ['dropspew'] },
];

async function compose(): Promise<void> {
  const st = (mode: string): Record<string, Any> => { const f = join(OUT, `${mode}-live-state.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).cells : {}; };
  const before = st('before'); const ours = st('ours');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const summary = (c: Any) => c ? `buy=${JSON.stringify((c.payments || {}).buy || [])} buttons=${JSON.stringify((c.payments || {}).buttons)} spew=${JSON.stringify(c.spew || [])}${c.console ? ` console=${JSON.stringify(c.console)}` : ''}${c.overlays ? ` overlays=${JSON.stringify(c.overlays)}` : ''}${c.coinStacksAfter ? ` coins=${JSON.stringify(c.coinStacksAfter)}` : ''}` : '(no state)';
  const rows = CELLS.map((c) => `<div class="row">
      <div class="cell" style="width:100%"><div class="lbl"><b>${c.name}</b> — ${c.label}</div><pre>before: ${summary(before[c.name])}\nafter:  ${summary(ours[c.name])}</pre></div>
      ${c.crops.map((k) => img(join(OUT, `before-${c.name}-${k}.png`), `before — ${k} at 2x`)).join('')}
      ${c.crops.map((k) => img(join(OUT, `ours-${c.name}-${k}.png`), `after — ${k} at 2x`)).join('')}
      ${img(join(OUT, `before-${c.name}-drop.png`), 'before (full frame at the drop)', 'frame')}
      ${img(join(OUT, `ours-${c.name}-drop.png`), 'after (full frame at the drop)', 'frame')}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.c.a.a.c.a.b.a.a — the slumlord split notice's client-side plural: before | after</h1>
    <p>Reference: gmSlumlordUI::AcceptDragObject @ 004c87c0 pushes .rdata 0x7b6bf0 "Splitting the %s before adding to housing panel" with ACCWeenieObject::GetObjectName(NAME_APPROPRIATE) @ 0058e6e0 — a stack of 2+ takes pwd._plural_name, else the singular + "s"/"es". Live on the ACE stack (SwiftShader) through the inventory-cell → list HTML5 drag.</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaacabaa-slumlord-plural-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kbbccaaacabaa-slumlord-plural-sidebyside.png')}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
