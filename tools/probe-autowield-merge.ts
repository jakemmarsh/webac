/**
 * GAP.world-drag-drop.a.a.a — live check on the ACE stack that a stack
 * wielded onto an occupied ammo / weapon ready slot merges into the wielded
 * stack (CPlayerSystem::AutoWield @ 00560a60 → ItemHolder::AttemptMerge
 * @ 005878f0 → StackableMerge), instead of doing nothing or dequipping it.
 *
 *   bow          a Longbow dropped on the Weapon slot → wielded.
 *   pa-wield     60 Practice Arrows (max stack 100) dropped on the Ammunition
 *                slot → wielded.
 *   pa-drop      30 more dropped on the Ammunition slot → StackableMerge; the
 *                readied stack reads 90 and the dropped one is gone.
 *   pa-dbl       10 more double-clicked → StackableMerge (auto-wield); the
 *                readied stack is full (100).
 *   pa-full      5 more dropped on the full readied stack → nothing sent,
 *                "You cannot wield more …" (0x7ccddc, param_3 = 0).
 *   pa-full-dbl  the same 5 double-clicked → nothing sent, no line
 *                (the double-click passes param_3 = 1).
 *   darts-wield  a 20-Dart stack double-clicked → the Longbow is dequipped and
 *                the Darts wielded (the existing blocked-dequip path).
 *   darts-dbl    a 15-Dart stack double-clicked → StackableMerge into the
 *                wielded Darts (35).
 *
 * A character the probe creates is soft-deleted. Screenshots + state.json →
 * verification/gap-world-drag-drop-a-a-a/.
 *
 *   npx tsx tools/probe-autowield-merge.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  enterWorld, adminCommand, telepoi, readAc, shot, REPO, openSession, sessionArgs, gameUrl, waitForCharSelect,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'gap-world-drag-drop-a-a-a');
const TAG = '[autowield-merge]';
const NAME = 'Merge Tester';
const PRACTICE_ARROW = 4184; const DART = 316; const LONGBOW = 306;

async function until(page: Page, expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await readAc<boolean>(page, expr).catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

interface Found { idx: number; id: number; stackSize: number }
/** An UNEQUIPPED pack item by wcid and stack size. */
const packFind = (page: Page, wcid: number, stack: number | null) => readAc<Found | null>(page, `(() => {
  const items = ac.gameUI.inventoryItems || []; const on = new Set((ac.gameUI.equippedItems || []).map((e) => e.id));
  const i = items.findIndex((it) => it.weenieClassId === ${wcid} && !on.has(it.id) && (${stack === null} || it.stackSize === ${stack}));
  return i < 0 ? null : { idx: i, id: items[i].id, stackSize: items[i].stackSize }; })()`);
const wornStack = (page: Page, wcid: number) => readAc<{ id: number; stackSize: number; slot: number } | null>(page, `(() => {
  const e = (ac.gameUI.equippedItems || []).find((x) => x.weenieClassId === ${wcid});
  return e ? { id: e.id, stackSize: e.stackSize, slot: e.slot } : null; })()`);

/** Release a pack-cell drag on a paperdoll slot, at whatever element the real mouse would hit. */
const dropOn = (page: Page, idx: number, slot: string) => readAc<boolean>(page, `(() => { const ui = ac.gameUI;
  const pd = ui.inventoryPanelHandle.elements.get(0x100001cd); const at = pd && pd.querySelector('[data-equip-slot="${slot}"]');
  if (!at) return false; const r = at.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const el = document.elementFromPoint(x, y); if (!el) return false;
  ui.dragItemIndex = ${idx}; ui.dragSourceSlot = null;
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new DragEvent('dragover', o)); el.dispatchEvent(new DragEvent('drop', o)); return true; })()`);
const doubleClick = (page: Page, idx: number) => readAc<boolean>(page, `(ac.gameUI.dragCallbacks.onDoubleClickItem(${idx}), true)`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'awmerge', createCharacter: NAME, settleMs: 4000 });
  const sends: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/Sent (GetAndWieldItem|StackableSplitToWield|PutItemInContainer|StackableMerge)/.test(t)) sends.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };
  await telepoi(page, 'holtburg', 12_000);
  await readAc(page, `(dbg.freezeTimeOfDay(0.5), 0)`);
  // The auto-entered character may carry a previous run's wielded stacks.
  for (const slot of ['MissileWeapon', 'MissileAmmo']) {
    await readAc(page, `(dbg.unwield(${JSON.stringify(slot)}), 0)`);
    await page.waitForTimeout(2500);
  }
  for (const [w, n] of [[LONGBOW, 1], [PRACTICE_ARROW, 60], [PRACTICE_ARROW, 30], [PRACTICE_ARROW, 10], [PRACTICE_ARROW, 5], [DART, 20], [DART, 15]] as const) {
    await adminCommand(page, n > 1 ? `@ci ${w} ${n}` : `@ci ${w}`);
    await page.waitForTimeout(2000);
  }
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  await page.waitForTimeout(2500);

  const beat = async (key: string, wcid: number, stack: number, how: { drop?: string; dbl?: true },
    expect: { stack?: number; sentRe?: RegExp; noSend?: true; line?: RegExp; noLine?: true; worn?: true }) => {
    await until(page, 'dbg.inventoryRequestRefusal() === null', 10_000);
    const item = await packFind(page, wcid, stack);
    if (!item) { state[key] = { skipped: 'not in the pack' }; console.log(TAG, key, 'skipped'); return; }
    const sentBefore = sends.length;
    const spewBefore = await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`);
    const acted = how.drop ? await dropOn(page, item.idx, how.drop) : await doubleClick(page, item.idx);
    await page.waitForTimeout(500);
    const spew = (await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`)).filter((t) => !spewBefore.includes(t));
    let ok = true;
    if (expect.worn) ok &&= await until(page, `(ac.gameUI.equippedItems || []).some((e) => e.id === ${item.id})`, 15_000);
    if (expect.stack !== undefined) ok &&= await until(page, `(() => { const e = (ac.gameUI.equippedItems || []).find((x) => x.weenieClassId === ${wcid}); return !!e && e.stackSize === ${expect.stack}; })()`, 15_000);
    if (expect.stack !== undefined) ok &&= await until(page, `!(ac.gameUI.inventoryItems || []).some((i) => i.id === ${item.id})`, 10_000);
    await page.waitForTimeout(1000);
    const sent = sends.slice(sentBefore);
    if (expect.sentRe) ok &&= sent.some((s) => expect.sentRe!.test(s));
    if (expect.noSend) ok &&= sent.length === 0;
    if (expect.line) ok &&= spew.some((t) => expect.line!.test(t));
    if (expect.noLine) ok &&= !spew.some((t) => /wield/.test(t));
    const worn = await wornStack(page, wcid);
    await shot(page, join(OUT, `${key}.png`));
    state[key] = { item, acted, sent, spew, worn, pass: acted && ok };
    console.log(TAG, key, JSON.stringify(state[key]));
    await page.waitForTimeout(1500);
  };

  await beat('bow', LONGBOW, 1, { drop: 'Weapon' }, { worn: true });
  await beat('pa-wield', PRACTICE_ARROW, 60, { drop: 'Ammunition' }, { worn: true });
  await beat('pa-drop', PRACTICE_ARROW, 30, { drop: 'Ammunition' }, { stack: 90, sentRe: /StackableMerge \(paperdoll drop\).*amount=30/ });
  await beat('pa-dbl', PRACTICE_ARROW, 10, { dbl: true }, { stack: 100, sentRe: /StackableMerge \(auto-wield\).*amount=10/ });
  await beat('pa-full', PRACTICE_ARROW, 5, { drop: 'Ammunition' }, { noSend: true, line: /^You cannot wield more / });
  await beat('pa-full-dbl', PRACTICE_ARROW, 5, { dbl: true }, { noSend: true, noLine: true });
  await beat('darts-wield', DART, 20, { dbl: true }, { worn: true });
  await beat('darts-dbl', DART, 15, { dbl: true }, { stack: 35, sentRe: /StackableMerge \(auto-wield\).*amount=15/ });

  await shot(page, join(OUT, 'final.png'));
  state.sends = sends;
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
  await browser.close();

  // Soft-delete the probe character so auto-enter keeps landing elsewhere.
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'awmerge-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log(TAG, 'probe character deleted:', del);
  await s2.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
