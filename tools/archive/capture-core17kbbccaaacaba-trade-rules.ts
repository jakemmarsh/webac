/**
 * CORE.17.k.b.b.c.c.a.a.c.a.b.a — live capture of gmSecureTradeUI's drag / add
 * rules in a REAL two-character trade on the live ACE stack (Holtburg).
 *
 * Client A (testacjs, admin) @ci's a rusted dirk, a rusted mace, a Pack and
 * 50 pyreals, moves the mace into the Pack (the real pack-drop handler), and
 * pulls client B (testacjs2) over. A opens the negotiation; then, through the
 * real drop handler on A's own list 0x10000088: the Pack (AddItem's walk —
 * "Trading contents of Pack", the mace listed, the Pack not), the dirk twice
 * (the second refused: already listed), the pyreal stack after a real click
 * selects it and the split entry is set to 10 (the split in place — "Splitting
 * the Pyreals before trading them" — and the 10-pyreal stack ACE creates
 * joins the trade on arrival: ItemAttributesChanged). A ground object offered
 * through acceptTradeDrag draws "You can only trade items you are carrying".
 * Frames of both clients + the per-step state under verification/core17kbbccaaacaba/.
 *
 *   npx tsx tools/capture-core17kbbccaaacaba-trade-rules.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaba');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const URL_B = `${BASE}&account=testacjs2&password=testacjs2`;
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kbbccaaacaba]';
const SECOND_NAME = 'Range Tester Two';
const DIRK = 23320; const MACE = 23321; const PACK = 136; const PYREAL = 273;

// Source strings for page.evaluate: tsx injects a `__name` helper into named
// function bodies that does not exist in the page (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, label: string, charName: string): Promise<void> {
  console.log(`${TAG} ${label}: navigating`);
  await page.goto(`${url}&cb=kbbccaaacaba`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} ${label}: not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} ${label}: in world`);
  await page.waitForTimeout(4000);
}

async function home(page: Page): Promise<void> {
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(6000);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(800);
}

/** The trade slot's live state: dock, element rects, texts, state art, the list cells. */
async function probe(page: Page): Promise<Record<string, unknown>> {
  return ev(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const host = ui && ui.tradePanel;
    const td = ui && ui.getTradeData ? ui.getTradeData() : null;
    const byId = (id) => host ? host.querySelector('[data-element-id="0x' + id.toString(16) + '"]') : null;
    const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const txt = (id) => { const e = byId(id); if (!e) return null; return Array.from(e.querySelectorAll('canvas, span')).map((n) => n.dataset.acFullText || n.textContent || '').join(' ') || e.textContent || ''; };
    const art = (id) => { const e = byId(id); return e ? (e.style.backgroundImage || '').slice(0, 80) : null; };
    const cells = (id) => { const e = byId(id); return e ? Array.from(e.querySelectorAll('[data-ac-trade-cell]')).map((c) => c.dataset.acTradeCell === 'item' ? 'item:0x' + Number(c.dataset.guid).toString(16) : 'empty') : null; };
    return {
      dockPanel: ui ? ui.transactionDockPanel : null,
      partnerGuid: td ? td.partnerGuid : 0, yourReady: td ? td.yourReady : null, theirReady: td ? td.theirReady : null,
      host: rect(host), slot: rect(byId(0x1000005f)),
      partnerName: txt(0x1000007e), selfName: txt(0x10000085),
      partnerTotal: txt(0x10000080), selfTotal: txt(0x10000087),
      tradeButtonArt: art(0x10000086), partnerLampArt: art(0x1000007f),
      tradeButton: rect(byId(0x10000086)), partnerLamp: rect(byId(0x1000007f)),
      selfCells: cells(0x10000088), partnerCells: cells(0x10000081),
    };
  })()`);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const r = await ev<{ x: number; y: number; w: number; h: number } | null>(page, `(() => {
    const h = window.__ac && window.__ac.gameUI && window.__ac.gameUI.tradePanel;
    const b = h && h.getBoundingClientRect();
    return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  })()`);
  if (r) await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: r.x - 10, y: r.y - 10, width: r.w + 20, height: r.h + 20 } });
}

async function _inventoryGuids(page: Page, wcids: number[]): Promise<Array<{ idx: number; id: number; name: string }>> {
  return ev(page, `(() => {
    const items = (window.__ac && window.__ac.gameUI && window.__ac.gameUI.inventoryItems) || [];
    const want = ${JSON.stringify(wcids)};
    const out = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (want.includes(it.weenieClassId) && !out.some((o) => o.wcid === it.weenieClassId)) out.push({ idx: i, id: it.id, name: it.name, wcid: it.weenieClassId });
    }
    return out;
  })()`);
}

async function _clickEl(page: Page, id: number): Promise<boolean> {
  const c = await ev<{ x: number; y: number } | null>(page, `(() => {
    const h = window.__ac && window.__ac.gameUI && window.__ac.gameUI.tradePanel;
    const e = h && h.querySelector('[data-element-id="0x${id.toString(16)}"]');
    const r = e && e.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (!c) return false;
  await page.mouse.click(c.x, c.y);
  return true;
}


const dropOnSelf = (page: Page, idx: number) => ev(page, `(() => {
  const ui = window.__ac.gameUI;
  ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null;
  const list = ui.tradePanel.querySelector('[data-element-id="0x10000088"]');
  list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
})()`);

const invIndex = (page: Page, pred: string) => ev<{ idx: number; id: number; name: string; stackSize: number; containerId: number } | null>(page, `(() => {
  const items = window.__ac.gameUI.inventoryItems || [];
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (${pred}) return { idx: i, id: it.id, name: it.name, stackSize: it.stackSize, containerId: it.containerId }; }
  return null;
})()`);

const notices = (page: Page) => ev<string[]>(page, `(window.__tradeNotices || []).slice()`);
const sentLog: string[] = [];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser: Browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const ctxA = await browser.newContext({ viewport: VIEW });
  const ctxB = await browser.newContext({ viewport: VIEW });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [p, l] of [[A, 'A'], [B, 'B']] as const) {
    await p.addInitScript('window.__name = (f) => f;');
    p.on('dialog', (d) => void d.dismiss());
    p.on('console', (m) => { const t = m.text(); if (/trade|Split|PutItemInContainer/i.test(t)) { console.log(`${l}: ${t.slice(0, 200)}`); if (l === 'A') sentLog.push(t.slice(0, 200)); } });
  }
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await enterWorld(A, URL_A, 'A', 'Trade Tester One');
  await enterWorld(B, URL_B, 'B', SECOND_NAME);
  await home(A);
  const nameB = await ev<string>(B, `(window.__ac && window.__ac.playerState && window.__ac.playerState.name) || ''`).catch(() => '');
  await ev(A, `window.acDebug.admin(${JSON.stringify(`@teletome ${nameB || SECOND_NAME}`)})`);
  await A.waitForTimeout(8000);
  await ev(B, `window.acDebug.freezeTimeOfDay(0.5)`);
  for (const cmd of [`@ci ${DIRK}`, `@ci ${MACE}`, `@ci ${PACK}`, `@ci ${PYREAL} 50`]) { await ev(A, `window.acDebug.admin(${JSON.stringify(cmd)})`); await A.waitForTimeout(2500); }
  await A.waitForTimeout(3000);
  // Instrument the 0x1a notices (the call still goes through).
  await ev(A, `(() => { const ui = window.__ac.gameUI; const orig = ui.displayErrorText.bind(ui); window.__tradeNotices = []; ui.displayErrorText = (t) => { window.__tradeNotices.push(t); return orig(t); }; })()`);

  await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui && !ui.inventoryVisible) ui.toggleInventory(); })()`);
  await A.waitForTimeout(1500);
  console.log(`${TAG} A inventory: ${JSON.stringify(await ev(A, `(window.__ac.gameUI.inventoryItems || []).map((it) => it.weenieClassId + ':' + it.name)`))}`);
  // The mace into the Pack (the real pack-drop handler → PutItemInContainer).
  const pack = await invIndex(A, `it.weenieClassId === ${PACK}`);
  const mace = await invIndex(A, `it.weenieClassId === ${MACE}`);
  if (!pack || !mace) throw new Error('the @ci items never arrived');
  const packSlot = await ev<number>(A, `(window.__ac.gameUI.sidePackGuids || []).indexOf(${pack.id})`);
  await ev(A, `window.__ac.gameUI.dragCallbacks.onDropToPack(${mace.idx}, ${packSlot})`);
  await A.waitForTimeout(3000);
  state.maceInPack = await invIndex(A, `it.weenieClassId === ${MACE}`);

  const findPartner = () => ev<{ guid: number; name: string } | null>(A, `(() => {
    const want = ${JSON.stringify((nameB || SECOND_NAME).toLowerCase())};
    const o = window.acDebug.getObjects().find((x) => (x.name || '').toLowerCase() === want);
    return o ? { guid: o.guid, name: o.name } : null;
  })()`);
  let partner = await findPartner();
  for (let i = 0; !partner && i < 6; i++) {
    const cmd = i % 2 === 0 ? `@teleto ${nameB || SECOND_NAME}` : `@teletome ${nameB || SECOND_NAME}`;
    await ev(A, `window.acDebug.admin(${JSON.stringify(cmd)})`);
    await A.waitForTimeout(10000);
    partner = await findPartner();
  }
  if (!partner) throw new Error(`partner ${nameB} not loaded on A`);
  state.partner = partner;

  await ev(A, `window.acDebug.tradeOpen(${partner.guid})`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ev<boolean>(A, `!!(window.__ac.gameUI.tradePanel)`) && await ev<boolean>(B, `!!(window.__ac.gameUI.tradePanel)`)) break;
    await A.waitForTimeout(1000);
  }
  if (!(await ev<boolean>(A, `!!(window.__ac.gameUI.tradePanel)`))) throw new Error('the negotiation never opened on A');
  await A.waitForTimeout(1500);

  // 1. The Pack: its contents, not the pack.
  const packNow = await invIndex(A, `it.weenieClassId === ${PACK}`);
  await dropOnSelf(A, packNow!.idx);
  await A.waitForTimeout(3000);
  state.afterPack = { A: await probe(A), B: await probe(B), notices: await notices(A), pack: packNow, mace: state.maceInPack };
  await shoot(A, 'ours-after-pack'); await shoot(B, 'ours-after-pack-partner');

  // 2. The dirk, twice: the second is already listed.
  const dirk = await invIndex(A, `it.weenieClassId === ${DIRK}`);
  const sentBefore = sentLog.filter((t) => t.includes('Sent AddToTrade')).length;
  await dropOnSelf(A, dirk!.idx);
  await dropOnSelf(A, dirk!.idx);
  await A.waitForTimeout(3000);
  state.afterDirk = { A: await probe(A), addToTradeSends: sentLog.filter((t) => t.includes('Sent AddToTrade')).length - sentBefore, dirk };

  // 3. The pyreals: a real click selects the stack; the split entry → 10; the drop splits in place.
  const pyr = await invIndex(A, `it.weenieClassId === ${PYREAL} && it.stackSize === 50`);
  if (!pyr) throw new Error('no 50-pyreal stack');
  if (!(await ev<boolean>(A, `!!window.__ac.gameUI.inventoryVisible`))) await ev(A, `window.__ac.gameUI.toggleInventory()`);
  await A.waitForTimeout(1000);
  const cellPos = await ev<{ x: number; y: number } | null>(A, `(() => {
    const c = document.querySelector('[data-inv-slot="${pyr.idx}"]');
    const r = c && c.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (cellPos) await A.mouse.click(cellPos.x, cellPos.y);
  else console.log(`${TAG} pyreal cell not visible — selecting through the HUD path`);
  await A.waitForTimeout(800);
  await ev(A, `window.__ac.gameUI.setToolbarSplitSize(10)`);
  await A.waitForTimeout(300);
  state.split = await ev(A, `({ target: window.__ac.gameUI.hud.target && window.__ac.gameUI.hud.target.id, split: window.__ac.gameUI.toolbarSplitSize, max: window.__ac.gameUI.toolbarMaxSplitSize, clicked: ${!!cellPos} })`);
  const pyrIdx = await invIndex(A, `it.id === ${pyr.id}`);
  await dropOnSelf(A, pyrIdx!.idx);
  await A.waitForTimeout(5000);
  state.afterSplit = {
    A: await probe(A), B: await probe(B), notices: await notices(A),
    pyreals: await ev(A, `(window.__ac.gameUI.inventoryItems || []).filter((it) => it.weenieClassId === ${PYREAL}).map((it) => ({ id: it.id, stackSize: it.stackSize }))`),
  };
  await shoot(A, 'ours-after-split'); await shoot(B, 'ours-after-split-partner');

  // 4. A ground object (API-level: no drag source for world objects in ours) → the not-carrying notice.
  const ground = await ev<{ guid: number; name: string } | null>(A, `(() => {
    const o = window.acDebug.getObjects().find((x) => x.pos && x.guid !== ${partner.guid} && !/^(\\+|Range Tester|Trade Tester)/.test(x.name || ''));
    return o ? { guid: o.guid, name: o.name } : null;
  })()`);
  if (ground) {
    state.ground = { ground, accepted: await ev(A, `window.__ac.gameUI.acceptTradeDrag({ guid: ${ground.guid}, name: ${JSON.stringify(ground.name)}, weenieClassId: 0, stackSize: 1, ownedByPlayer: false })`), notices: await notices(A) };
  }
  await A.waitForTimeout(1500);
  await shoot(A, 'ours-final');
  state.sent = sentLog;
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
  await ev(A, `window.acDebug.tradeClose && window.acDebug.tradeClose()`).catch(() => {});

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.zoom img{max-width:1560px}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.b.a — gmSecureTradeUI's drag / add rules (live ACE, Holtburg, a real two-character trade)</h1>
  <p>Retail side: DragItemAcceptable @ 004ca6a0, AcceptDragObject @ 004caa40, AddItem @ 004ca780, ItemAttributesChanged @ 004ca9d0 (no retail frame of the trade panel exists in reference/images; the decomp + the exe's literals are the reference). Before (prior cycle, verification/core17kbbccaaacab/ours-items.png): any dropped object went straight to AddToTrade, a Pack included.</p>
  <div>${img(join(REPO, 'verification', 'core17kbbccaaacab', 'ours-items.png'), 'before — A: every drop sent as-is')}${img(join(OUT, 'ours-after-pack.png'), 'after — A: the Pack dropped: "Trading contents of Pack", its mace listed, the Pack not')}</div>
  <div>${img(join(OUT, 'ours-after-split.png'), 'after — A: the 50 pyreals with the split entry at 10: "Splitting the Pyreals before trading them", the 10-stack joined')}${img(join(OUT, 'ours-after-split-partner.png'), 'after — B: the same table from the partner')}</div>
  <div class="zoom">${img(join(OUT, 'ours-after-split-zoom.png'), 'after — A (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-after-split-partner-zoom.png'), 'after — B (zoom)')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaba-trade-rules-sidebyside.png'), fullPage: true });
  console.log(`${TAG} wrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
