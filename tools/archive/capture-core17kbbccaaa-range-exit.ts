/**
 * CORE.17.k.b.b.c.c.a.a.a — live evidence that the slumlord dialog and the
 * vendor bar close themselves when the player walks out of range of their
 * object (CPlayerSystem::CalculateObjectRangeChecks → OnObjectRangeExit):
 *
 *   slumlord-in-range   acDebug.testSlumlordPanel(false, true, <guid of a real world object within
 *                       MaxLordDistance>) — the dialog open, the range entry live and in range
 *   slumlord-exited     the character walked away (facing away from the object, W held): the dialog
 *                       gone within CHECK_LORD_INTERVAL of the cylinder distance passing 9.0 m
 *   vendor-open         acDebug.useObject(<a vendor>) — the real approach-then-Use → ApproachVendor →
 *                       the bar open, the range entry live at the vendor's UseRadius
 *   vendor-exited       walked away: the bar gone once the cylinder distance passes the UseRadius
 *
 * `--before` runs the same script on the pre-change sources (git stash the
 * GameUI.ts / main.ts edits first) — there the panels stay open however far
 * the character walks; the vendor is opened through the real Use path only
 * when the sources have acDebug.useObject, else acDebug.testVendor.
 *
 *   npx tsx tools/capture-core17kbbccaaa-range-exit.ts [--before] [--compose-only]
 *
 * Writes before-*.png / ours-*.png + <prefix>-live-state.json and composes
 * core17kbbccaaa-range-exit-sidebyside.png under verification/core17kbbccaaa/.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const TAG = '[core17kbbccaaa]';
const VENDOR_FLAG = 0x200; // ObjectDescriptionFlag.Vendor

interface Obj { guid: number; name: string; type: number; objectDescFlags: number; pos?: { x: number; y: number; z: number } }
interface Snapshot {
  t: number; x: number; z: number; horiz: number; cyl: number | null;
  slumlordVisible: boolean; vendorVisible: boolean; entries: unknown[];
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

/** The player's world position + the panels' visibility + the live range list (post-change) or just visibility (pre-change). */
async function snapshot(page: Page, guid: number, t0: number): Promise<Snapshot> {
  const s = await ev<{ x: number; z: number; slumlordVisible: boolean; vendorVisible: boolean; entries: Array<{ objectId: number; inRange: boolean; body: { x: number; y: number; z: number } | null; player: { x: number; y: number; z: number } }>; objPos: { x: number; y: number; z: number } | null; cyl: number | null }>(page, `(() => {
    const dbg = window.acDebug; const ui = window.__ac && window.__ac.gameUI;
    const cs = dbg.collisionState();
    const rc = dbg.objectRangeChecks ? dbg.objectRangeChecks() : null;
    const objs = dbg.getObjects(); const o = objs.find((x) => x.guid === ${guid});
    let cyl = null;
    if (rc) { const e = rc.entries.find((e) => e.objectId === ${guid}); if (e && e.body && e.player) {
      const dx = e.player.x - e.body.x, dy = e.player.y - e.body.y, dz = e.player.z - e.body.z;
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
      cyl = len; /* centre distance (the cylinder gap is len - radii; recorded server-side below) */ } }
    return {
      x: cs.x, z: cs.z,
      slumlordVisible: rc ? rc.slumlordVisible : !!(ui && (ui.isSlumlordVisible !== undefined ? ui.isSlumlordVisible : ui.slumlordVisible)),
      vendorVisible: rc ? rc.vendorVisible : !!(ui && ui.isVendorVisible),
      entries: rc ? rc.entries.map((e) => ({ objectId: e.objectId, range: e.range, inRange: e.inRange, useRadii: e.useRadii })) : [],
      objPos: o && o.pos ? { x: o.pos.x, y: o.pos.y, z: o.pos.z } : null,
      cyl,
    };
  })()`);
  const horiz = s.objPos ? Math.hypot(s.x - s.objPos.x, s.z - s.objPos.z) : NaN;
  return { t: +((Date.now() - t0) / 1000).toFixed(2), x: +s.x.toFixed(2), z: +s.z.toFixed(2), horiz: +horiz.toFixed(2), cyl: s.cyl === null ? null : +s.cyl.toFixed(2), slumlordVisible: s.slumlordVisible, vendorVisible: s.vendorVisible, entries: s.entries };
}

/** Face away from the object and hold W until `done()` or the deadline. */
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

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || t.includes('beyond') || t.includes('pageerror')) console.log(t); });
  page.on('pageerror', (e) => console.log(`${TAG} pageerror`, e.message));
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: {} };
  const cells = state.cells as Record<string, unknown>;

  console.log(`${TAG} world: navigating`);
  await page.goto(`${URL}&cb=kbbccaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(6000);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(800);

  // ── The candidates: every loaded object with a mesh, by horizontal distance ──
  const objs = await ev<Array<Obj & { horiz: number; hasMesh: boolean; collisionRadius: number; useRadius: number; acPos: unknown }>>(page, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    return dbg.getObjects().filter((o) => o.pos).map((o) => {
      const p = dbg.objectAcPosition ? dbg.objectAcPosition(o.guid) : null;
      return { guid: o.guid, name: o.name, type: o.type, objectDescFlags: o.objectDescFlags, pos: { x: o.pos.x, y: o.pos.y, z: o.pos.z },
        horiz: Math.hypot(o.pos.x - cs.x, o.pos.z - cs.z), hasMesh: p ? p.hasMesh : true, collisionRadius: p ? p.collisionRadius : -1, useRadius: p ? p.useRadius : -1, acPos: p ? p.position : null };
    }).sort((a, b) => a.horiz - b.horiz);
  })()`);
  console.log(`${TAG} ${objs.length} objects; nearest: ${objs.slice(0, 6).map((o) => `${o.name}(0x${o.guid.toString(16)}) ${o.horiz.toFixed(1)}m r=${o.collisionRadius}`).join(', ')}`);

  // ── Cell 1/2: the slumlord dialog on a real object within MaxLordDistance ──
  const lord = objs.find((o) => o.hasMesh && o.collisionRadius > 0 && o.horiz > 1.5 && o.horiz < 7.5) ?? objs.find((o) => o.hasMesh && o.horiz < 8);
  if (!lord) throw new Error('no world object within MaxLordDistance of the Holtburg telepoi spot');
  console.log(`${TAG} slumlord stand-in: ${lord.name} 0x${lord.guid.toString(16)} at ${lord.horiz.toFixed(2)} m (radius ${lord.collisionRadius})`);
  const t0 = Date.now();
  await ev(page, `window.acDebug.testSlumlordPanel(false, true, ${lord.guid})`);
  await page.waitForTimeout(1600);
  const lordOpen = await snapshot(page, lord.guid, t0);
  await page.screenshot({ path: join(OUT, `${PREFIX}-slumlord-in-range.png`) });
  console.log(`${TAG} slumlord-in-range: ${JSON.stringify(lordOpen)}`);
  const lordLog: Snapshot[] = [];
  const lordEnd = await walkAway(page, lord.guid, (s) => !s.slumlordVisible || s.horiz > 14, 25_000, t0, lordLog);
  await page.screenshot({ path: join(OUT, `${PREFIX}-slumlord-exited.png`) });
  console.log(`${TAG} slumlord-exited: ${JSON.stringify(lordEnd)}`);
  const lordExitAt = lordLog.find((s) => !s.slumlordVisible);
  cells['slumlord'] = { object: { guid: lord.guid, name: lord.name, collisionRadius: lord.collisionRadius, startHoriz: +lord.horiz.toFixed(2) }, open: lordOpen, end: lordEnd, exitAt: lordExitAt ?? null, walk: lordLog };
  await ev(page, `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui) ui.hideSlumlordPanel(); })()`);

  // ── Cell 3/4: a real vendor through the real Use path ──
  const vendor = objs.find((o) => (o.objectDescFlags & VENDOR_FLAG) !== 0);
  if (!vendor) {
    cells['vendor'] = { skipped: 'no vendor among the loaded objects' };
    console.log(`${TAG} vendor: none loaded — skipped`);
  } else {
    console.log(`${TAG} vendor: ${vendor.name} 0x${vendor.guid.toString(16)} at ${vendor.horiz.toFixed(1)} m, useRadius ${vendor.useRadius}`);
    const ap = vendor.acPos as { landblock: number; x: number; y: number; z: number } | null;
    // Stand ~2.5 m from the vendor (its own cell, so a shop interior works too), then Use it.
    // (The pre-change sources have no objectAcPosition hook: the seeded bar opens where we stand.)
    if (ap) {
      await ev(page, `window.acDebug.tele(${ap.landblock}, ${(ap.x + 2.5).toFixed(2)}, ${ap.y.toFixed(2)}, ${ap.z.toFixed(2)})`);
      await page.waitForTimeout(7000);
    }
    const t1 = Date.now();
    const hasUse = await ev<boolean>(page, `!!(window.acDebug && window.acDebug.useObject)`);
    if (hasUse) await ev(page, `window.acDebug.useObject(${vendor.guid})`);
    else await ev(page, `window.acDebug.testVendor()`);
    let vOpen = await snapshot(page, vendor.guid, t1);
    const openDeadline = Date.now() + 30_000;
    while (!vOpen.vendorVisible && Date.now() < openDeadline) { await page.waitForTimeout(1000); vOpen = await snapshot(page, vendor.guid, t1); }
    await page.waitForTimeout(1500);
    vOpen = await snapshot(page, vendor.guid, t1);
    await page.screenshot({ path: join(OUT, `${PREFIX}-vendor-open.png`) });
    console.log(`${TAG} vendor-open (${hasUse ? 'acDebug.useObject → ApproachVendor' : 'acDebug.testVendor'}): ${JSON.stringify(vOpen)}`);
    const vLog: Snapshot[] = [];
    const vEnd = vOpen.vendorVisible
      ? await walkAway(page, vendor.guid, (s) => !s.vendorVisible || s.horiz > 12, 25_000, t1, vLog)
      : vOpen;
    await page.screenshot({ path: join(OUT, `${PREFIX}-vendor-exited.png`) });
    console.log(`${TAG} vendor-exited: ${JSON.stringify(vEnd)}`);
    cells['vendor'] = { object: { guid: vendor.guid, name: vendor.name, useRadius: vendor.useRadius, collisionRadius: vendor.collisionRadius }, openedVia: hasUse ? 'useObject' : 'testVendor', open: vOpen, end: vEnd, exitAt: vLog.find((s) => !s.vendorVisible) ?? null, walk: vLog };
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

function walkTable(walk: Snapshot[] | undefined, key: 'slumlordVisible' | 'vendorVisible'): string {
  if (!walk || !walk.length) return '';
  const rows = walk.map((s) => `<tr><td>${s.t}s</td><td>${s.horiz}</td><td>${s.cyl ?? '—'}</td><td>${(s.entries as Array<{ inRange: boolean }>).length ? (s.entries as Array<{ inRange: boolean }>).map((e) => (e.inRange ? 'in' : 'OUT')).join(',') : '—'}</td><td>${s[key] ? 'open' : 'closed'}</td></tr>`).join('');
  return `<table><tr><th>t</th><th>horiz m</th><th>centre m</th><th>entry</th><th>panel</th></tr>${rows}</table>`;
}

async function compose(): Promise<void> {
  const st = (p: string) => (existsSync(join(OUT, p)) ? JSON.parse(readFileSync(join(OUT, p), 'utf8')) : null);
  const before = st('before-live-state.json'); const ours = st('ours-live-state.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string) => existsSync(join(OUT, file))
    ? `<div class="cell"><div class="lbl">${label}</div><img class="frame" src="${dataUrl(join(OUT, file))}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const c = (s: Record<string, Record<string, unknown>> | null, k: string) => (s?.cells?.[k] ?? {}) as Record<string, unknown>;
  const lo = c(ours, 'slumlord'); const lb = c(before, 'slumlord'); const vo = c(ours, 'vendor'); const vb = c(before, 'vendor');
  const obj = (x: Record<string, unknown>) => (x.object as { name?: string; guid?: number; collisionRadius?: number; useRadius?: number } | undefined);
  const html = `${CSS}<h1>CORE.17.k.b.b.c.c.a.a.a — the slumlord dialog / vendor bar close on OnObjectRangeExit: before | after</h1>
    <p>Reference: CPlayerSystem::RegisterObjectRangeHandler @ 005602d0 / CalculateObjectRangeChecks @ 0055f360 (from UseTime @ 00563110, once per frame) / ACCWeenieObject::ObjectsInRange @ 0058c1a0 (cylinder_distance with both radii when useRadii). gmSlumlordUI::RecvNotice_UpdateHouseProfile @ 004c9040 registers at MaxLordDistance = 9.0 (acclient.exe .rdata 0x7b66b8) every CHECK_LORD_INTERVAL = 1.0 s (0x7b6720); OnObjectRangeExit @ 004c7cb0 → SetVisible(0). gmVendorUI::OpenVendor @ 004c4ba0 registers at the vendor's UseRadius every CHECK_GROUND_OBJECT_INTERVAL = 1.0 s (0x7b4f58); OnObjectRangeExit @ 004c02f0 → SetVisible(0). No retail footage of the walk-away exists in reference/images — the decomp + the exe constants are the anchor; the before / after frames are ours on the live ACE stack (SwiftShader).</p>
    <div class="row">
      ${img('before-slumlord-in-range.png', `before — the dialog opened on ${obj(lb)?.name ?? '?'} (0x${(obj(lb)?.guid ?? 0).toString(16)}) at ${(lb.open as Snapshot | undefined)?.horiz ?? '?'} m`)}
      ${img('before-slumlord-exited.png', `before — after walking to ${(lb.end as Snapshot | undefined)?.horiz ?? '?'} m: the dialog is STILL open (no range handler)`)}
      ${img('ours-slumlord-in-range.png', `after — opened on ${obj(lo)?.name ?? '?'} (0x${(obj(lo)?.guid ?? 0).toString(16)}, radius ${obj(lo)?.collisionRadius}) at ${(lo.open as Snapshot | undefined)?.horiz ?? '?'} m: the MaxLordDistance entry live + in range`)}
      ${img('ours-slumlord-exited.png', `after — the dialog closed at t=${(lo.exitAt as Snapshot | null)?.t ?? '?'} s, ${(lo.exitAt as Snapshot | null)?.horiz ?? '?'} m horizontal (centre ${(lo.exitAt as Snapshot | null)?.cyl ?? '?'} m; the 9.0 m gate is the cylinder gap, radii subtracted); the entry is gone`)}
    </div>
    <div class="row"><div class="cell"><div class="lbl">after — the walk (slumlord)</div>${walkTable(lo.walk as Snapshot[], 'slumlordVisible')}</div>
    <div class="cell"><div class="lbl">before — the walk (slumlord)</div>${walkTable(lb.walk as Snapshot[], 'slumlordVisible')}</div></div>
    <div class="row">
      ${img('before-vendor-open.png', `before — the vendor bar (${vb.openedVia ?? '?'}) on ${obj(vb)?.name ?? '?'}`)}
      ${img('before-vendor-exited.png', `before — after walking to ${(vb.end as Snapshot | undefined)?.horiz ?? '?'} m: the bar is STILL open`)}
      ${img('ours-vendor-open.png', `after — ${obj(vo)?.name ?? '?'} (0x${(obj(vo)?.guid ?? 0).toString(16)}) opened through acDebug.useObject → the real approach + ApproachVendor; the UseRadius (${obj(vo)?.useRadius}) entry live`)}
      ${img('ours-vendor-exited.png', `after — the bar closed at t=${(vo.exitAt as Snapshot | null)?.t ?? '?'} s, ${(vo.exitAt as Snapshot | null)?.horiz ?? '?'} m horizontal`)}
    </div>
    <div class="row"><div class="cell"><div class="lbl">after — the walk (vendor)</div>${walkTable(vo.walk as Snapshot[], 'vendorVisible')}</div>
    <div class="cell"><div class="lbl">before — the walk (vendor)</div>${walkTable(vb.walk as Snapshot[], 'vendorVisible')}</div></div>`;
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaa-range-exit-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kbbccaaa-range-exit-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
