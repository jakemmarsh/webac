/**
 * CORE.17.k.b.b.c.c.a.a.c.a.b — live capture of gmSecureTradeUI drawn from its
 * DAT slot (0x2100006d:0x100005fb slot 0x1000005f ← 0x2100000d:0x1000007a),
 * in a REAL two-character trade on the live ACE stack (Holtburg).
 *
 * Client A (testacjs, admin) goes to @telepoi holtburg and pulls client B
 * (testacjs2, created on first run, not an admin) over with @teletome; A
 * @ci's two rusted weapons, B offers one of its starter items. A opens the negotiation
 * (OpenTradeNegotiations → RegisterTrade on both), A's items are dropped on
 * A's own list (the real drop handler → AddToTrade), B adds one through
 * acDebug.tradeAdd, B presses its Trade toggle for real (a mouse click →
 * AcceptTrade), then A does (both accepted → ACE completes the exchange).
 * Whole-screen + zoom frames of both clients per step, the per-step element
 * states, and a before | after sheet under verification/core17kbbccaaacab/
 * (the "before" is verification/core17kbbccaaaca/ours-trade*.png).
 *
 *   npx tsx tools/capture-core17kbbccaaacab-trade-slot.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacab');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbbccaaaca');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const URL_B = `${BASE}&account=testacjs2&password=testacjs2`;
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kbbccaaacab]';
const SECOND_NAME = 'Range Tester Two';
const ITEMS_A = [23320, 23321]; // rusted dirk, rusted mace

// Source strings for page.evaluate: tsx injects a `__name` helper into named
// function bodies that does not exist in the page (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, label: string, charName: string): Promise<void> {
  console.log(`${TAG} ${label}: navigating`);
  await page.goto(`${url}&cb=kbbccaaacab`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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

async function inventoryGuids(page: Page, wcids: number[]): Promise<Array<{ idx: number; id: number; name: string }>> {
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

async function clickEl(page: Page, id: number): Promise<boolean> {
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
    p.on('console', (m) => { const t = m.text(); if (/trade/i.test(t)) console.log(`${l}: ${t.slice(0, 200)}`); });
  }
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await enterWorld(A, URL_A, 'A', 'Trade Tester One');
  await enterWorld(B, URL_B, 'B', SECOND_NAME);
  await home(A);
  // B's account is not an admin (its @ commands are ignored): A pulls B over.
  const nameB = await ev<string>(B, `(window.__ac && window.__ac.playerState && window.__ac.playerState.name) || ''`).catch(() => '');
  await ev(A, `window.acDebug.admin(${JSON.stringify(`@teletome ${nameB || SECOND_NAME}`)})`);
  await A.waitForTimeout(8000);
  await ev(B, `window.acDebug.freezeTimeOfDay(0.5)`);
  for (const w of ITEMS_A) { await ev(A, `window.acDebug.admin('@ci ${w}')`); await A.waitForTimeout(2500); }
  await A.waitForTimeout(3000);

  const findPartner = () => ev<{ guid: number; name: string } | null>(A, `(() => {
    const want = ${JSON.stringify((nameB || SECOND_NAME).toLowerCase())};
    const o = window.acDebug.getObjects().find((x) => (x.name || '').toLowerCase() === want);
    return o ? { guid: o.guid, name: o.name } : null;
  })()`);
  let partner = await findPartner();
  for (let i = 0; !partner && i < 6; i++) {
    const near = await ev<string[]>(A, `window.acDebug.getObjects().filter((o) => o.pos).map((o) => o.name).slice(0, 40)`);
    const where = async (p: Page) => ev<string>(p, `(() => { const cs = window.acDebug.collisionState(); return cs ? cs.x.toFixed(1) + ',' + cs.z.toFixed(1) : '?'; })()`).catch(() => '?');
    console.log(`${TAG} partner "${nameB}" not yet on A (try ${i}); A at ${await where(A)}, B at ${await where(B)}; A sees: ${near.slice(0, 12).join(', ')}`);
    const cmd = i % 2 === 0 ? `@teleto ${nameB || SECOND_NAME}` : `@teletome ${nameB || SECOND_NAME}`;
    await ev(A, `window.acDebug.admin(${JSON.stringify(cmd)})`);
    await A.waitForTimeout(10000);
    partner = await findPartner();
  }
  if (!partner) throw new Error(`partner ${nameB} not loaded on A`);
  console.log(`${TAG} partner ${partner.name} 0x${partner.guid.toString(16)}`);
  state.partner = partner;

  await ev(A, `window.acDebug.tradeOpen(${partner.guid})`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await ev<boolean>(A, `!!(window.__ac.gameUI.tradePanel)`) && await ev<boolean>(B, `!!(window.__ac.gameUI.tradePanel)`);
    if (ok) break;
    await A.waitForTimeout(1000);
  }
  if (!(await ev<boolean>(A, `!!(window.__ac.gameUI.tradePanel)`))) {
    await shoot(A, '_trade-not-open'); await shoot(B, '_trade-not-open-partner');
    throw new Error('the negotiation never opened on A');
  }
  await A.waitForTimeout(1500);
  state.open = { A: await probe(A), B: await probe(B) };
  await shoot(A, 'ours-open'); await shoot(B, 'ours-open-partner');

  // A's items dropped on A's OWN list (the right half) → the real drop handler → AddToTrade.
  const invA = await inventoryGuids(A, ITEMS_A);
  state.invA = invA;
  for (const it of invA) {
    await ev(A, `(() => {
      const ui = window.__ac.gameUI;
      ui.dragItemIndex = ${it.idx}; ui.dragSourceSlot = null;
      const list = ui.tradePanel.querySelector('[data-element-id="0x10000088"]');
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    })()`);
    await A.waitForTimeout(1500);
  }
  // B offers one of its starter items, dropped on B's own list: the pack items
  // in turn until ACE takes one (attuned starter gear draws a TradeFailure).
  const invB = await ev<Array<{ idx: number; id: number; name: string }>>(B, `(() => {
    const items = (window.__ac && window.__ac.gameUI && window.__ac.gameUI.inventoryItems) || [];
    return items.map((it, i) => ({ idx: i, id: it.id, name: it.name }));
  })()`);
  const tried: string[] = [];
  for (const it of invB.slice(0, 12)) {
    tried.push(it.name);
    await ev(B, `(() => {
      const ui = window.__ac.gameUI;
      ui.dragItemIndex = ${it.idx}; ui.dragSourceSlot = null;
      const list = ui.tradePanel.querySelector('[data-element-id="0x10000088"]');
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    })()`);
    await B.waitForTimeout(2000);
    if (await ev<number>(B, `window.__ac.gameUI.getTradeData().yourItems.length`) > 0) break;
  }
  state.invB = { tried };
  await A.waitForTimeout(2500);
  state.items = { A: await probe(A), B: await probe(B) };
  await shoot(A, 'ours-items'); await shoot(B, 'ours-items-partner');

  // B presses its Trade toggle (a real mouse click) → AcceptTrade: A's lamp lights.
  state.bClicked = await clickEl(B, 0x10000086);
  await A.waitForTimeout(3000);
  state.partnerAccepted = { A: await probe(A), B: await probe(B) };
  await shoot(A, 'ours-partner-accepted'); await shoot(B, 'ours-partner-accepted-partner');

  // A accepts too → ACE completes the exchange.
  state.aClicked = await clickEl(A, 0x10000086);
  await A.waitForTimeout(4000);
  state.completed = { A: await probe(A), B: await probe(B) };
  await shoot(A, 'ours-completed'); await shoot(B, 'ours-completed-partner');
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
  await ev(A, `window.acDebug.tradeClose && window.acDebug.tradeClose()`).catch(() => {});

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.zoom img{max-width:1560px}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.b — gmSecureTradeUI from its DAT slot (live ACE, Holtburg, a real two-character trade)</h1>
  <p>DAT: 0x2100006d:0x100005fb slot 0x1000005f ← 0x2100000d:0x1000007a. gmSecureTradeUI::PostInit @ 004ca160: the RIGHT half is the player's ("You" 0x10000085, Trade toggle 0x10000086 — art 13 0x06004cbb / 1 0x06004cbc / 6 0x06004cbd, "Total Items: N" 0x10000087, list 0x10000088), the LEFT the partner's (name 0x1000007e, accepted lamp 0x1000007f — 13 0x06004cb9 / 6 0x06004cba, total 0x10000080, list 0x10000081). No retail frame of the trade panel exists in reference/images; the retail side is the DAT + decomp.</p>
  <div>${img(join(BEFORE_DIR, 'ours-trade.png'), 'before — hand-built rows, halves mirrored (acDebug.testTrade)')}${img(join(OUT, 'ours-open.png'), 'after — A: the negotiation open, the table empty (Trade toggle disabled)')}</div>
  <div>${img(join(OUT, 'ours-items.png'), 'after — A: two items on A\'s (right) list, B\'s item on the partner (left) list')}${img(join(OUT, 'ours-partner-accepted.png'), 'after — A: B pressed Trade — the partner lamp lit')}</div>
  <div class="zoom">${img(join(BEFORE_DIR, 'ours-trade-zoom.png'), 'before (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-items-zoom.png'), 'after — A, items (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-items-partner-zoom.png'), 'after — B, the same table seen from the partner (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-partner-accepted-zoom.png'), 'after — A, partner accepted (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-partner-accepted-partner-zoom.png'), 'after — B, its own toggle pressed (zoom)')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacab-trade-slot-sidebyside.png'), fullPage: true });
  console.log(`${TAG} wrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
