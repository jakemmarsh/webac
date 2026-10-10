/**
 * GAP.world-drag-drop.a — live check on the ACE stack: an object dragged off
 * the 3D view with the REAL mouse and released on the paperdoll wields it from
 * the ground (gmPaperDollUI::AcceptPaperDollDragObject @ 004a4a70 on the drag
 * band 0x100001d6, AcceptDragObject @ 004a3b10 on a slot).
 *
 *   gloves   Leather Gauntlets on the ground → the drag band → worn on the hands.
 *   shield   a Kite Shield on the ground → the Shield slot → wielded.
 *   dirk     a Rusted Dirk on the ground → the drag band → "You can't put
 *            that item there" (a weapon has no wearable bit), stays on the ground.
 *
 * Each object is created in the pack (@ci), dropped on open ground, then
 * dragged back. Screenshots + state.json → verification/gap-world-drag-drop-a/.
 *
 *   npx tsx tools/probe-world-drag-paperdoll.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, telepoi, readAc, shot, REPO, DEFAULT_VIEWPORT } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'gap-world-drag-drop-a');
const TAG = '[world-drag-paperdoll]';

async function until(page: Page, expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await readAc<boolean>(page, expr).catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const invFind = (page: Page, wcid: number) => readAc<{ idx: number; id: number; name: string } | null>(page, `(() => {
  const items = ac.gameUI.inventoryItems || [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].weenieClassId === ${wcid}) return { idx: i, id: items[i].id, name: items[i].name };
  return null; })()`);

/** Drop a pack item on open ground ahead of the player (the pack cell's own dragstart state, released over the canvas). */
async function dropOnGround(page: Page, idx: number, x: number, y: number): Promise<void> {
  await readAc(page, `(() => { const ui = ac.gameUI; ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null;
    const canvas = document.getElementById('game-canvas');
    const o = { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} };
    canvas.dispatchEvent(new DragEvent('dragover', o)); canvas.dispatchEvent(new DragEvent('drop', o)); return 0; })()`);
}

/** The centre of a paperdoll drop target: the drag band or a slot by label. */
const targetPoint = (page: Page, sel: string) => readAc<{ x: number; y: number } | null>(page, `(() => {
  const pd = ac.gameUI.inventoryPanelHandle.elements.get(0x100001cd); const el = pd && pd.querySelector(${JSON.stringify(sel)});
  if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);


interface Beat { key: string; wcid: number; target: string; expectWorn: boolean }
const BEATS: Beat[] = [
  { key: 'gloves', wcid: 56, target: '[data-element-id="0x100001d6"]', expectWorn: true },
  { key: 'shield', wcid: 91, target: '[data-equip-slot="Shield"]', expectWorn: true },
  { key: 'dirk', wcid: 23320, target: '[data-element-id="0x100001d6"]', expectWorn: false },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'worlddragpd', createCharacter: 'Drag Tester', settleMs: 4000 });
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/GetAndWieldItem|StackableSplitToWield|WieldObject|3D drag|DropItem|refused|one item/.test(t)) logs.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };
  await telepoi(page, 'holtburg', 12_000);
  await readAc(page, `(dbg.freezeTimeOfDay(0.5), 0)`);
  for (const b of BEATS) { await adminCommand(page, `@ci ${b.wcid}`); await page.waitForTimeout(2500); }
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  await page.waitForTimeout(2000);

  const ground = [
    { x: Math.round(DEFAULT_VIEWPORT.width * 0.30), y: Math.round(DEFAULT_VIEWPORT.height * 0.72) },
    { x: Math.round(DEFAULT_VIEWPORT.width * 0.40), y: Math.round(DEFAULT_VIEWPORT.height * 0.75) },
    { x: Math.round(DEFAULT_VIEWPORT.width * 0.62), y: Math.round(DEFAULT_VIEWPORT.height * 0.80) },
  ];
  for (const [i, b] of BEATS.entries()) {
    const item = await invFind(page, b.wcid);
    if (!item) { state[b.key] = { skipped: 'not in the pack after @ci' }; continue; }
    const refusalBefore = await readAc<string | null>(page, 'dbg.inventoryRequestRefusal()');
    const wornAlready = await readAc<boolean>(page, `(ac.gameUI.equippedItems || []).some((e) => e.id === ${item.id})`);
    console.log(TAG, b.key, 'before drop: refusal', refusalBefore, 'worn already', wornAlready);
    // One inventory request at a time: retry the drop until the previous one has cleared.
    let onGround = false;
    for (let attempt = 0; attempt < 4 && !onGround; attempt++) {
      const cur = await invFind(page, b.wcid);
      if (!cur) break;
      await dropOnGround(page, cur.idx, ground[i].x, ground[i].y);
      onGround = await until(page, `!(ac.gameUI.inventoryItems || []).some((x) => x.id === ${item.id}) && dbg.getObjects().some((o) => o.guid === ${item.id})`, 8_000);
    }
    await page.waitForTimeout(2500);
    await shot(page, join(OUT, `${b.key}-1-on-ground.png`));
    const from = await readAc<{ x: number; y: number; found: number } | null>(page, `dbg.objectScreenPoint(${item.id})`);
    const to = await targetPoint(page, b.target);
    if (!to) { state[b.key] = { item, onGround, skipped: 'no paperdoll target', from }; continue; }
    let inFlight = 0;
    let gesture = 'real-mouse';
    if (from && from.found === item.id) {
      // The REAL mouse: press on the ground object, drag onto the paperdoll, release.
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let s = 1; s <= 12; s++) await page.mouse.move(from.x + (to.x - from.x) * s / 12, from.y + (to.y - from.y) * s / 12);
      inFlight = await readAc<number>(page, `ac.gameUI.worldDragInProgress()`);
      await shot(page, join(OUT, `${b.key}-2-dragging.png`));
      await page.mouse.up();
    } else {
      // Dropped objects pile at the player's feet, so the screen pick can
      // land on another one: start the same sr_Drag state and release on the target.
      gesture = 'beginWorldDrag+drop';
      inFlight = await readAc<number>(page, `(() => { ac.gameUI.beginWorldDrag(${item.id}); const n = ac.gameUI.worldDragInProgress();
        const el = document.elementFromPoint(${to.x}, ${to.y}); const o = { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y} };
        el.dispatchEvent(new DragEvent('dragover', o)); el.dispatchEvent(new DragEvent('drop', o)); return n; })()`);
    }
    // The spew strip keeps a line 5 s (SPEW_ITEM_LIFETIME_MS): read it at once.
    await page.waitForTimeout(600);
    const spewNow = await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`);
    await shot(page, join(OUT, `${b.key}-2b-released.png`));
    const worn = await until(page, `(ac.gameUI.equippedItems || []).some((e) => e.id === ${item.id})`, b.expectWorn ? 20_000 : 4_000);
    await page.waitForTimeout(2000);
    const stillOnGround = await readAc<boolean>(page, `dbg.getObjects().some((o) => o.guid === ${item.id})`);
    const slot = await readAc<number | null>(page, `(() => { const e = (ac.gameUI.equippedItems || []).find((x) => x.id === ${item.id}); return e ? e.slot : null; })()`);
    await shot(page, join(OUT, `${b.key}-3-after.png`));
    state[b.key] = { item, onGround, gesture, from, to, worldDragInFlight: inFlight, worn, slot, stillOnGround, spew: spewNow, pass: worn === b.expectWorn };
    console.log(TAG, b.key, JSON.stringify(state[b.key]));
  }
  state.logs = logs;
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
  console.log(`${TAG} logs:\n${logs.join('\n')}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
