/**
 * GAP.world-drag-drop — live check on the ACE stack of the 3D view as a drop
 * target (sr_Drop → ItemHolder::AttemptPlaceIn3D) and a drag source (sr_Drag):
 *
 *   drop     a Dirk dragged from the pack grid and released over open ground
 *            → DropItem; it leaves the pack and lands in the world.
 *   refuse   the ground Dirk dragged off the view and released back on it →
 *            "You must first pick up the Dirk" (not owned).
 *   pickup   the ground Dirk dragged off the view with the REAL mouse and
 *            released on the pack grid → PutItemInContainer; back in the pack.
 *   give     a Pyreal stack released on a Holtburg NPC → GiveObjectRequest.
 *
 * Screenshots + state JSON → verification/gap-world-drag-drop/.
 *
 *   npx tsx tools/capture-gap-world-drag-drop.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'gap-world-drag-drop');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1568, height: 775 };
const TAG = '[gap-world-drag-drop]';
const DIRK = 23320; const PYREAL = 273;

// Source strings: tsx injects `__name` into named function bodies (docs/remote-agent-ops.md).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, charName: string): Promise<void> {
  await page.goto(`${url}&cb=gapworlddrag`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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

const invFind = (page: Page, wcid: number) => ev<{ idx: number; id: number; name: string; stackSize: number } | null>(page, `(() => {
  const items = window.__ac.gameUI.inventoryItems || [];
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.weenieClassId === ${wcid}) return { idx: i, id: it.id, name: it.name, stackSize: it.stackSize }; }
  return null;
})()`);

/** Start an inventory-cell drag the way the cell's own dragstart does, then release over the canvas at (x, y). */
const dropInvOnView = (page: Page, idx: number, x: number, y: number) => ev(page, `(() => {
  const ui = window.__ac.gameUI; ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null;
  const canvas = document.getElementById('game-canvas');
  const o = { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} };
  canvas.dispatchEvent(new DragEvent('dragover', o));
  canvas.dispatchEvent(new DragEvent('drop', o));
})()`);

const spew = (page: Page) => ev<string[]>(page, `(() => Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && /pick up the|cannot|mid air|Move cancelled/.test(e.textContent || '')).map((e) => e.textContent))()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const A = await (await browser.newContext({ viewport: VIEW })).newPage();
  await A.addInitScript('window.__name = (f) => f;');
  A.on('dialog', (d) => void d.dismiss());
  const logs: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/Sent (DropItem|PutItemInContainer|GiveObjectRequest|StackableMerge)|3D drag/.test(t)) logs.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await enterWorld(A, URL_A, 'Drag Tester');
  await admin(A, '@telepoi holtburg');
  await A.waitForTimeout(7000);
  for (const cmd of [`@ci ${DIRK}`, `@ci ${PYREAL} 50`]) { await admin(A, cmd); await A.waitForTimeout(2500); }
  await ev(A, `window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(A, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()`);
  await A.waitForTimeout(2000);

  // ── drop: a Dirk released over open ground ahead of the player ──
  const dirk = await invFind(A, DIRK);
  if (!dirk) throw new Error('no Dirk in the pack');
  const ground = { x: Math.round(VIEW.width * 0.42), y: Math.round(VIEW.height * 0.72) };
  await A.screenshot({ path: join(OUT, '1-before-drop.png') });
  await dropInvOnView(A, dirk.idx, ground.x, ground.y);
  const dropped = await waitFor(A, `(() => !(window.__ac.gameUI.inventoryItems || []).some((i) => i.id === ${dirk.id}) && window.acDebug.getObjects().some((o) => o.guid === ${dirk.id}))()`, 15_000);
  await A.waitForTimeout(2500);
  await A.screenshot({ path: join(OUT, '2-dirk-on-ground.png') });
  state.drop = { dirk, ground, dropped };
  console.log(`${TAG} drop:`, state.drop);

  // ── refuse: the ground Dirk dragged off the view, released back on the view ──
  const pt = await ev<{ x: number; y: number; found: number } | null>(A, `window.acDebug.objectScreenPoint(${dirk.id})`);
  state.dirkScreen = pt;
  if (pt) {
    await ev(A, `(() => {
      const ui = window.__ac.gameUI; ui.beginWorldDrag(${dirk.id});
      const canvas = document.getElementById('game-canvas');
      const o = { bubbles: true, cancelable: true, clientX: ${Math.round(ground.x + 200)}, clientY: ${ground.y} };
      canvas.dispatchEvent(new DragEvent('dragover', o));
      canvas.dispatchEvent(new DragEvent('drop', o));
    })()`);
    await A.waitForTimeout(800);
    state.refuse = { spew: await spew(A) };
    await A.screenshot({ path: join(OUT, '3-must-first-pick-up.png') });
    console.log(`${TAG} refuse:`, state.refuse);
  }

  // ── pickup: the REAL mouse — press on the Dirk, drag to an empty pack cell, release ──
  const pt2 = await ev<{ x: number; y: number; found: number } | null>(A, `window.acDebug.objectScreenPoint(${dirk.id})`);
  const cell = await ev<{ x: number; y: number } | null>(A, `(() => {
    const grid = window.__ac.gameUI.inventoryPanelHandle.elements.get(0x100001cf);
    const c = Array.from(grid.querySelectorAll('div')).find((d) => d.draggable !== true && d.style.width === '32px' && d.getBoundingClientRect().width > 0);
    if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.left + 16, y: b.top + 16 };
  })()`);
  state.pickupPoints = { from: pt2, to: cell };
  if (pt2 && cell && pt2.found === dirk.id) {
    await A.mouse.move(pt2.x, pt2.y);
    await A.mouse.down();
    const draggable = await ev<boolean>(A, `document.getElementById('game-canvas').draggable`);
    for (let i = 1; i <= 12; i++) await A.mouse.move(pt2.x + (cell.x - pt2.x) * i / 12, pt2.y + (cell.y - pt2.y) * i / 12);
    const inFlight = await ev<number>(A, `window.__ac.gameUI.worldDragInProgress()`);
    await A.screenshot({ path: join(OUT, '4-dragging-dirk.png') });
    await A.mouse.up();
    const back = await waitFor(A, `(window.__ac.gameUI.inventoryItems || []).some((i) => i.id === ${dirk.id})`, 15_000);
    await A.waitForTimeout(1500);
    await A.screenshot({ path: join(OUT, '5-dirk-picked-up.png') });
    state.pickup = { draggableOnPress: draggable, worldDragInFlight: inFlight, backInPack: back };
    console.log(`${TAG} pickup:`, state.pickup);
  } else {
    state.pickup = { skipped: 'the Dirk is not findable on screen', pt2, cell };
  }

  // ── give: Pyreals released on the nearest non-vendor NPC ──
  const npc = await ev<{ guid: number; name: string } | null>(A, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    const onScreen = (g) => { const p = dbg.objectScreenPoint(g); return !!p && p.found === g && p.x > 0 && p.x < 1260 && p.y > 60 && p.y < ${VIEW.height - 100}; };
    const npcs = dbg.getObjects().filter((o) => o.pos && (o.type & 0x10) && !(o.objectDescFlags & 0x208) && onScreen(o.guid));
    npcs.sort((a, b) => Math.hypot(a.pos.x - cs.x, a.pos.z - cs.z) - Math.hypot(b.pos.x - cs.x, b.pos.z - cs.z));
    return npcs[0] ? { guid: npcs[0].guid, name: npcs[0].name } : null;
  })()`);
  const pyr = await invFind(A, PYREAL);
  if (npc && pyr) {
    const np = await ev<{ x: number; y: number; found: number } | null>(A, `window.acDebug.objectScreenPoint(${npc.guid})`);
    if (np) await dropInvOnView(A, pyr.idx, Math.round(np.x), Math.round(np.y));
    await A.waitForTimeout(15000);
    await A.screenshot({ path: join(OUT, '6-give-npc.png') });
    state.give = { npc, np, pyr, after: await invFind(A, PYREAL) };
    console.log(`${TAG} give:`, state.give);
  }

  state.logs = logs;
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
  console.log(`${TAG} logs:\n${logs.join('\n')}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
