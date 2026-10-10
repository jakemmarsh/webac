/**
 * CORE.17.k.b.b.c.c.a.a.a.a — live evidence that the container panel, the book,
 * the trade window and the world selection drop themselves when the player
 * walks out of range of their object (CPlayerSystem::CalculateObjectRangeChecks
 * → OnObjectRangeExit), like the slumlord dialog / vendor bar of the parent:
 *
 *   container-open / -exited   `@create 143` (a Chest, 5 m ahead) → acDebug.useObject → the real
 *                              approach + Use → ViewContents → the panel with the UseRadius entry
 *                              live; walked away → the panel gone past the chest's UseRadius
 *   book-open / -exited        `@create 364` (a Book) → useObject → BookData → the book panel;
 *                              walked away → gone past its UseRadius
 *   selected / deselected      acDebug.select on a world object → the entry at
 *                              RADAR_OUTDOOR_RADIUS (75 m, ignoreZDelta); walked away facing away
 *                              (the object out of view) → deselected past 75 m
 *   trade-open / -exited       a second client (account testacjs2) at the same spot;
 *                              acDebug.tradeOpen → RegisterTrade on both → the window with the
 *                              5.0 m entry; the initiator walks away → CloseTradeNegotiations at
 *                              5.0 m → CloseTrade hides both windows
 *
 * `--before` runs the same script on the pre-change sources (git stash the
 * GameUI.ts / main.ts / ObjectRangeChecks.ts edits first) — there every
 * panel stays open and the selection is kept however far the character walks.
 *
 *   npx tsx tools/capture-core17kbbccaaaa-range-registrants.ts [--before] [--compose-only] [--skip-trade]
 *
 * Writes before-*.png / ours-*.png + <prefix>-live-state.json and composes
 * core17kbbccaaaa-range-registrants-sidebyside.png under verification/core17kbbccaaaa/.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = process.env.AC_URL ?? `${BASE}&account=testacjs&password=testacjs`;
const URL_B = process.env.AC_URL_B ?? `${BASE}&account=testacjs2&password=testacjs2`;
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const SKIP_TRADE = process.argv.includes('--skip-trade');
/** `--only=container,book,selection,trade` — run a subset; the other cells' state is kept from the previous run. */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=container,book,selection,trade').slice('--only='.length).split(',');
const PREFIX = BEFORE ? 'before' : 'ours';
const TAG = '[core17kbbccaaaa]';
const CHEST_WCID = 143;  // ace_world.weenie 'chest'
const BOOK_WCID = 364;   // ace_world.weenie 'book'
const SECOND_NAME = 'Range Tester Two';

interface Obj { guid: number; name: string; horiz: number; hasMesh: boolean; collisionRadius: number; useRadius: number }
interface Snapshot {
  t: number; x: number; z: number; horiz: number;
  containerVisible: boolean; bookVisible: boolean; tradeVisible: boolean; selectedGuid: number; selectedInView: boolean | null;
  playerOutside: boolean | null; entries: Array<{ objectId: number; range: number; inRange: boolean; useRadii: boolean; ignoreZDelta: boolean }>;
}

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

/** measure-perf.ts's virgin-account driver: a fresh account parks at the chargen wizard. */
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

async function enterWorld(page: Page, url: string, label: string, charName: string): Promise<void> {
  console.log(`${TAG} ${label}: navigating`);
  await page.goto(`${url}&cb=kbbccaaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, `_login-failed-${label}.png`) }); throw new Error(`${label}: never entered world`); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, charName).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} ${label}: character creation submitted (${charName})`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} ${label}: not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

/** The player's position + every registrant's visibility + the live range list (post-change), with pre-change fallbacks. */
async function snapshot(page: Page, guid: number, t0: number): Promise<Snapshot> {
  const s = await ev<Omit<Snapshot, 't' | 'horiz'> & { objPos: { x: number; z: number } | null }>(page, `(() => {
    const dbg = window.acDebug; const ui = window.__ac && window.__ac.gameUI;
    const cs = dbg.collisionState();
    const rc = dbg.objectRangeChecks ? dbg.objectRangeChecks() : {};
    const objs = dbg.getObjects(); const o = objs.find((x) => x.guid === ${guid});
    const td = ui && ui.getTradeData ? ui.getTradeData() : null;
    return {
      x: cs.x, z: cs.z,
      containerVisible: rc.containerVisible !== undefined ? rc.containerVisible : !!(ui && ui.isContainerOpen),
      bookVisible: rc.bookVisible !== undefined ? rc.bookVisible : !!(ui && (ui.bookPanelGuid != null || ui.bookPanelHandle != null)),
      tradeVisible: rc.tradeVisible !== undefined ? rc.tradeVisible : !!(td && td.partnerGuid !== 0),
      selectedGuid: rc.selectedGuid !== undefined ? rc.selectedGuid : ((dbg.getTarget && dbg.getTarget()) || 0),
      selectedInView: rc.selectedInView !== undefined ? rc.selectedInView : null,
      playerOutside: rc.playerOutside !== undefined ? rc.playerOutside : null,
      entries: (rc.entries || []).map((e) => ({ objectId: e.objectId, range: e.range, inRange: e.inRange, useRadii: e.useRadii, ignoreZDelta: e.ignoreZDelta })),
      objPos: o && o.pos ? { x: o.pos.x, z: o.pos.z } : null,
    };
  })()`);
  const horiz = s.objPos ? Math.hypot(s.x - s.objPos.x, s.z - s.objPos.z) : NaN;
  const { objPos: _p, ...rest } = s;
  return { t: +((Date.now() - t0) / 1000).toFixed(2), ...rest, x: +s.x.toFixed(2), z: +s.z.toFixed(2), horiz: +horiz.toFixed(2) };
}

/** Face away from the object and hold W (running) until `done()` or the deadline. */
async function walkAway(page: Page, guid: number, done: (s: Snapshot) => boolean, maxMs: number, t0: number, log: Snapshot[]): Promise<Snapshot> {
  let last = await snapshot(page, guid, t0);
  log.push(last);
  await ev(page, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    const o = dbg.getObjects().find((x) => x.guid === ${guid});
    if (!o || !o.pos) return;
    const dx = o.pos.x - cs.x, dz = o.pos.z - cs.z, d = Math.hypot(dx, dz) || 1;
    // The approach code faces the target with atan2(-nx, -nz); away is atan2(nx, nz).
    dbg.setPlayerYaw(Math.atan2(dx / d, dz / d));
    dbg.simulateKey('ShiftLeft', true);
    dbg.simulateKey('KeyW', true);
  })()`);
  const deadline = Date.now() + maxMs;
  let stuckSince = Date.now(); let stuckRef = last.horiz;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    last = await snapshot(page, guid, t0);
    log.push(last);
    console.log(`${TAG}   walk t=${last.t}s horiz=${last.horiz} entries=${last.entries.map((e) => `${e.range}${e.ignoreZDelta ? 'xy' : ''}:${e.inRange ? 'in' : 'OUT'}`).join(',') || '—'} cont=${last.containerVisible} book=${last.bookVisible} trade=${last.tradeVisible} sel=${last.selectedGuid ? 1 : 0} inView=${last.selectedInView}`);
    if (done(last)) break;
    // Blocked by a wall / obstacle: turn 90° and keep going.
    if (last.horiz > stuckRef + 0.3) { stuckRef = last.horiz; stuckSince = Date.now(); }
    else if (Date.now() - stuckSince > 3000) {
      await ev(page, `(() => { const d = window.acDebug; const cc = window.__ac && window.__ac.cameraController; d.setPlayerYaw(((cc && cc.playerYaw) || 0) + Math.PI / 2); })()`).catch(() => {});
      stuckSince = Date.now();
    }
  }
  await ev(page, `(() => { window.acDebug.simulateKey('KeyW', false); window.acDebug.simulateKey('ShiftLeft', false); })()`);
  // One more interval so a just-crossed threshold is polled.
  await page.waitForTimeout(1300);
  last = await snapshot(page, guid, t0);
  log.push(last);
  return last;
}

async function loadedObjects(page: Page): Promise<Obj[]> {
  return ev<Obj[]>(page, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    return dbg.getObjects().filter((o) => o.pos).map((o) => {
      const p = dbg.objectAcPosition ? dbg.objectAcPosition(o.guid) : null;
      return { guid: o.guid, name: o.name, horiz: Math.hypot(o.pos.x - cs.x, o.pos.z - cs.z),
        hasMesh: p ? p.hasMesh : true, collisionRadius: p ? p.collisionRadius : -1, useRadius: p ? p.useRadius : -1 };
    }).sort((a, b) => a.horiz - b.horiz);
  })()`);
}

/** `@create <wcid>` and wait for the one new object to load. */
async function createObject(page: Page, wcid: number): Promise<Obj | null> {
  const before = new Set((await loadedObjects(page)).map((o) => o.guid));
  await ev(page, `window.acDebug.admin('@create ${wcid}')`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const fresh = (await loadedObjects(page)).filter((o) => !before.has(o.guid) && o.hasMesh);
    if (fresh.length) return fresh[0];
  }
  return null;
}

/** Return to the telepoi spot (the walks leave the character up to 100 m away). */
async function home(page: Page): Promise<void> {
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(6000);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(800);
}

async function groundObjectCell(page: Page, cells: Record<string, unknown>, key: 'container' | 'book', wcid: number, visible: (s: Snapshot) => boolean): Promise<void> {
  await home(page);
  const obj = await createObject(page, wcid);
  if (!obj) { cells[key] = { skipped: `@create ${wcid} produced no loaded object` }; console.log(`${TAG} ${key}: @create ${wcid} produced nothing — skipped`); return; }
  console.log(`${TAG} ${key}: ${obj.name} 0x${obj.guid.toString(16)} at ${obj.horiz.toFixed(2)} m, useRadius ${obj.useRadius}, radius ${obj.collisionRadius}`);
  const t0 = Date.now();
  await ev(page, `window.acDebug.useObject(${obj.guid})`);
  let open = await snapshot(page, obj.guid, t0);
  const openDeadline = Date.now() + 40_000;
  while (!visible(open) && Date.now() < openDeadline) { await page.waitForTimeout(1000); open = await snapshot(page, obj.guid, t0); }
  await page.waitForTimeout(1500);
  open = await snapshot(page, obj.guid, t0);
  await page.screenshot({ path: join(OUT, `${PREFIX}-${key}-open.png`) });
  console.log(`${TAG} ${key}-open: ${JSON.stringify(open)}`);
  const walk: Snapshot[] = [];
  const end = visible(open) ? await walkAway(page, obj.guid, (s) => !visible(s) || s.horiz > 14, 30_000, t0, walk) : open;
  await page.screenshot({ path: join(OUT, `${PREFIX}-${key}-exited.png`) });
  console.log(`${TAG} ${key}-exited: ${JSON.stringify(end)}`);
  cells[key] = { object: obj, open, end, exitAt: walk.find((s) => !visible(s)) ?? null, walk };
  // Leave nothing open for the next cell.
  await ev(page, `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (ui.hideBookPanel) ui.hideBookPanel(); if (ui.hideContainerPanel) ui.hideContainerPanel(); })()`);
}

async function selectionCell(page: Page, cells: Record<string, unknown>): Promise<void> {
  await home(page);
  const objs = await loadedObjects(page);
  // A real world object a few metres away (not the just-created ground items).
  const pick = objs.find((o) => o.hasMesh && o.collisionRadius > 0 && o.horiz > 2 && o.horiz < 12 && !/^(Chest|Book)$/.test(o.name)) ?? objs.find((o) => o.hasMesh && o.horiz > 2);
  if (!pick) { cells['selection'] = { skipped: 'no world object near the telepoi spot' }; return; }
  console.log(`${TAG} selection: ${pick.name} 0x${pick.guid.toString(16)} at ${pick.horiz.toFixed(2)} m`);
  const t0 = Date.now();
  await ev(page, `window.acDebug.select(${pick.guid})`);
  await page.waitForTimeout(1600);
  const open = await snapshot(page, pick.guid, t0);
  await page.screenshot({ path: join(OUT, `${PREFIX}-selected.png`) });
  console.log(`${TAG} selected: ${JSON.stringify(open)}`);
  const walk: Snapshot[] = [];
  const end = await walkAway(page, pick.guid, (s) => s.selectedGuid !== pick.guid || s.horiz > 100, 100_000, t0, walk);
  await page.screenshot({ path: join(OUT, `${PREFIX}-deselected.png`) });
  console.log(`${TAG} deselected: ${JSON.stringify(end)}`);
  cells['selection'] = { object: pick, open, end, exitAt: walk.find((s) => s.selectedGuid !== pick.guid) ?? null, walk };
}

async function tradeCell(browser: Browser, pageA: Page, cells: Record<string, unknown>): Promise<void> {
  const ctxB = await browser.newContext({ viewport: VIEW });
  const pageB = await ctxB.newPage();
  pageB.on('dialog', (d) => void d.dismiss());
  try {
    await enterWorld(pageB, URL_B, 'B', SECOND_NAME);
    await home(pageA);
    await home(pageB);
    await pageA.waitForTimeout(3000);
    const nameB = await ev<string>(pageB, `(window.__ac && window.__ac.playerState && window.__ac.playerState.name) || ''`).catch(() => '');
    const objs = await loadedObjects(pageA);
    const partner = objs.find((o) => o.name === (nameB || SECOND_NAME)) ?? objs.find((o) => o.name === SECOND_NAME);
    if (!partner) { cells['trade'] = { skipped: `the second character (${nameB || SECOND_NAME}) is not among A's loaded objects` }; console.log(`${TAG} trade: partner not loaded — skipped`); return; }
    console.log(`${TAG} trade: partner ${partner.name} 0x${partner.guid.toString(16)} at ${partner.horiz.toFixed(2)} m`);
    const t0 = Date.now();
    await ev(pageA, `window.acDebug.tradeOpen(${partner.guid})`);
    let open = await snapshot(pageA, partner.guid, t0);
    const openDeadline = Date.now() + 30_000;
    while (!open.tradeVisible && Date.now() < openDeadline) { await pageA.waitForTimeout(1000); open = await snapshot(pageA, partner.guid, t0); }
    await pageA.waitForTimeout(1500);
    open = await snapshot(pageA, partner.guid, t0);
    await pageA.screenshot({ path: join(OUT, `${PREFIX}-trade-open.png`) });
    // The second SwiftShader page can crash under load: its frames are best-effort.
    await pageB.screenshot({ path: join(OUT, `${PREFIX}-trade-open-partner.png`) }).catch((e) => console.log(`${TAG} partner screenshot failed: ${(e as Error).message.split('\n')[0]}`));
    console.log(`${TAG} trade-open: ${JSON.stringify(open)}`);
    const walk: Snapshot[] = [];
    const end = open.tradeVisible ? await walkAway(pageA, partner.guid, (s) => !s.tradeVisible || s.horiz > 12, 30_000, t0, walk) : open;
    await pageA.waitForTimeout(1500);
    const partnerEnd = await ev<boolean>(pageB, `(() => { const ui = window.__ac && window.__ac.gameUI; const td = ui && ui.getTradeData ? ui.getTradeData() : null; return !!(td && td.partnerGuid !== 0); })()`).catch(() => null);
    await pageA.screenshot({ path: join(OUT, `${PREFIX}-trade-exited.png`) });
    await pageB.screenshot({ path: join(OUT, `${PREFIX}-trade-exited-partner.png`) }).catch((e) => console.log(`${TAG} partner screenshot failed: ${(e as Error).message.split('\n')[0]}`));
    console.log(`${TAG} trade-exited: ${JSON.stringify(end)} partnerWindowStillOpen=${partnerEnd}`);
    cells['trade'] = { partner, open, end, exitAt: walk.find((s) => !s.tradeVisible) ?? null, partnerWindowOpenAtEnd: partnerEnd, walk };
    await ev(pageA, `window.acDebug.tradeClose && window.acDebug.tradeClose()`).catch(() => {});
  } catch (e) {
    cells['trade'] = { skipped: `second client failed: ${(e as Error).message}` };
    console.log(`${TAG} trade: ${(e as Error).message} — skipped`);
  } finally {
    await ctxB.close().catch(() => {});
  }
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const ctxA = await browser.newContext({ viewport: VIEW });
  const page = await ctxA.newPage();
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || t.includes('beyond') || t.includes('pageerror')) console.log(t); });
  page.on('pageerror', (e) => console.log(`${TAG} pageerror`, e.message));
  const stateFile = join(OUT, `${PREFIX}-live-state.json`);
  const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: { ...(previous?.cells ?? {}) } };
  const cells = state.cells as Record<string, unknown>;

  await enterWorld(page, URL_A, 'A', 'Range Tester');
  if (ONLY.includes('container')) await groundObjectCell(page, cells, 'container', CHEST_WCID, (s) => s.containerVisible);
  if (ONLY.includes('book')) await groundObjectCell(page, cells, 'book', BOOK_WCID, (s) => s.bookVisible);
  if (ONLY.includes('selection')) await selectionCell(page, cells);
  if (ONLY.includes('trade')) {
    if (!SKIP_TRADE) await tradeCell(browser, page, cells);
    else cells['trade'] = { skipped: '--skip-trade' };
  }

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
  .lbl{color:#ffd;white-space:normal;max-width:760px}
  .frame{display:block;border:1px solid #444;max-width:760px}
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1700px;color:#ccc;margin:4px 0}
  table{border-collapse:collapse;margin-top:6px} td,th{border:1px solid #444;padding:2px 6px;text-align:right} th{color:#ffd}
</style>`;

type Cell = Record<string, unknown>;
const snap = (c: Cell, k: 'open' | 'end' | 'exitAt'): Snapshot | null => (c[k] as Snapshot | null | undefined) ?? null;
const objOf = (c: Cell) => ((c.object ?? c.partner) as Obj | undefined);

function walkTable(walk: Snapshot[] | undefined, key: keyof Snapshot, label: string): string {
  if (!walk || !walk.length) return '';
  const rows = walk.map((s) => `<tr><td>${s.t}s</td><td>${s.horiz}</td><td>${s.entries.length ? s.entries.map((e) => `${e.range}${e.ignoreZDelta ? 'xy' : ''}:${e.inRange ? 'in' : 'OUT'}`).join(',') : '—'}</td><td>${s.selectedInView === null ? '—' : s.selectedInView ? 'yes' : 'no'}</td><td>${key === 'selectedGuid' ? (s.selectedGuid ? 'selected' : 'none') : s[key] ? 'open' : 'closed'}</td></tr>`).join('');
  return `<table><tr><th>t</th><th>horiz m</th><th>entry</th><th>in view</th><th>${label}</th></tr>${rows}</table>`;
}

async function compose(): Promise<void> {
  const st = (p: string) => (existsSync(join(OUT, p)) ? JSON.parse(readFileSync(join(OUT, p), 'utf8')) : null);
  const before = st('before-live-state.json'); const ours = st('ours-live-state.json');
  const c = (s: Record<string, Record<string, unknown>> | null, k: string) => (s?.cells?.[k] ?? {}) as Cell;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string) => existsSync(join(OUT, file))
    ? `<div class="cell"><div class="lbl">${label}</div><img class="frame" src="${dataUrl(join(OUT, file))}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const section = (key: string, openFile: string, exitFile: string, visKey: keyof Snapshot, what: string, gate: string) => {
    const o = c(ours, key); const b = c(before, key);
    const skipped = (x: Cell) => (x.skipped ? ` — skipped: ${x.skipped}` : '');
    return `<div class="row">
      ${img(`before-${openFile}.png`, `before — ${what} on ${objOf(b)?.name ?? '?'} at ${snap(b, 'open')?.horiz ?? '?'} m${skipped(b)}`)}
      ${img(`before-${exitFile}.png`, `before — after walking to ${snap(b, 'end')?.horiz ?? '?'} m: ${what} STILL ${visKey === 'selectedGuid' ? 'selected' : 'open'} (no range handler)`)}
      ${img(`ours-${openFile}.png`, `after — ${what} on ${objOf(o)?.name ?? '?'} (0x${(objOf(o)?.guid ?? 0).toString(16)}, useRadius ${objOf(o)?.useRadius ?? '?'}) at ${snap(o, 'open')?.horiz ?? '?'} m: the ${gate} entry live + in range${skipped(o)}`)}
      ${img(`ours-${exitFile}.png`, `after — ${visKey === 'selectedGuid' ? 'deselected' : 'closed'} at t=${snap(o, 'exitAt')?.t ?? '?'} s, ${snap(o, 'exitAt')?.horiz ?? '?'} m horizontal; the entry is gone`)}
    </div>
    <div class="row"><div class="cell"><div class="lbl">after — the walk (${key})</div>${walkTable(o.walk as Snapshot[], visKey, key)}</div>
    <div class="cell"><div class="lbl">before — the walk (${key})</div>${walkTable(b.walk as Snapshot[], visKey, key)}</div></div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.c.c.a.a.a.a — the container panel / book / selection / trade drop on OnObjectRangeExit: before | after</h1>
    <p>Reference: gmExternalContainerUI::SetGroundObject @ 004cbbd0 (the container at its pwd._useRadius, CHECK_GROUND_OBJECT_INTERVAL 1.0 s) / OnObjectRangeExit @ 004cbd10 → CloseCurrentContainer @ 004cbcb0; gmBookUI::OpenBook @ 004bbca0 (a book not IsOwnedByPlayer at its UseRadius) / OnObjectRangeExit @ 004baa50; CPlayerSystem::RecvNotice_SetSelectedItem @ 00560720 (RADAR_OUTDOOR_RADIUS 75 / RADAR_INDOOR_RADIUS 25 — acclient.exe .rdata 0x7cc6a0 / 0x7cc6a4 — with ignoreZDelta every CHECK_SELECTED_OBJECT_INTERVAL 1.0 s @ 0x7cc5c0) / OnObjectRangeExit @ 00560870 (re-register while is_selected_object_in_view, else SetSelectedObject(0, 0)); gmSecureTradeUI::RecvNotice_RegisterTrade @ 004ca5c0 (the partner at 5.0 every CHECK_TRADE_INTERVAL) / OnObjectRangeExit @ 004ca4c0 → ClientTradeSystem::CloseTradeNegotiations (order 0x01F7). No retail footage of the walk-away exists in reference/images — the decomp + the exe constants are the anchor; the frames are ours on the live ACE stack (SwiftShader).</p>
    ${section('container', 'container-open', 'container-exited', 'containerVisible', 'the container panel', 'UseRadius')}
    ${section('book', 'book-open', 'book-exited', 'bookVisible', 'the book', 'UseRadius')}
    ${section('selection', 'selected', 'deselected', 'selectedGuid', 'the selection', 'RADAR_OUTDOOR_RADIUS (75 m, xy)')}
    ${section('trade', 'trade-open', 'trade-exited', 'tradeVisible', 'the trade window', '5.0 m')}
    <div class="row">
      ${img('ours-trade-open-partner.png', 'after — the partner\'s window while the trade is open')}
      ${img('ours-trade-exited-partner.png', `after — the partner's window once the initiator's range exit sent CloseTradeNegotiations (partner window open at end: ${c(ours, 'trade').partnerWindowOpenAtEnd ?? '?'})`)}
    </div>`;
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaaa-range-registrants-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kbbccaaaa-range-registrants-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
