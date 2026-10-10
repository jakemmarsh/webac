/**
 * GAP.world-drag-drop.a.a.a.a — live check on the ACE stack: dragging a
 * stack that has a toolbar shortcut onto another stack of the same kind
 * moves the shortcut onto the destination in the same slot and selects the
 * destination (ItemHolder::AttemptMerge @ 005878f0 → CM_UI::
 * SendNotice_FullMergingItem → gmToolbarUI::RecvNotice_FullMergingItem
 * @ 004be9b0, then SetSelectedObject(dst, 0)).
 *
 *   1. @ci 7975 2 twice (Vial of Berimphur Dye) → two stacks A, B.
 *   2. A gets a shortcut in slot 3 (gmToolbarUI::AddShortcut, sent).
 *   3. A is dragged onto B in the pack (a real HTML5 drag).
 *   4. Slot 3 holds B, A has no slot, B is the selection; the client sent
 *      StackableMerge, RemoveShortCut(2), AddShortCut(2, B).
 *   5. Relog: ACE's PlayerDescription restores slot 3 to B (the server took
 *      the shortcut events).
 *
 * Screenshots + state.json → verification/gap-world-drag-drop-aaaa/.
 *
 *   npx tsx tools/probe-merge-shortcut.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { enterWorld, waitForWorld, adminCommand, readAc, shot, elementBox, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'gap-world-drag-drop-aaaa');
const TAG = '[merge-shortcut]';
const WCID = 7975;
const SLOT = 2;

interface Stack { idx: number; id: number; stackSize: number; name: string }
const stacks = (page: Page) => readAc<Stack[]>(page, `(ac.gameUI.inventoryItems || []).map((x, i) => ({ idx: i, id: x.id, stackSize: x.stackSize, name: x.name, w: x.weenieClassId })).filter((x) => x.w === ${WCID})`);

async function toolbarShot(page: Page, file: string): Promise<void> {
  const box = await elementBox(page, '[data-shortcut-num="1"]', 0).catch(() => null);
  await shot(page, join(OUT, `${file}.png`));
  if (box) await shot(page, join(OUT, `${file}-toolbar.png`), { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 70), w: 340, h: 120 });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page, url } = await enterWorld({ cb: 'mergeshortcut', createCharacter: 'Merge Tester', settleMs: 5000 });
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/StackableMerge|ShortCut|Item-shortcut bar/.test(t)) logs.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  // Start from a clean slot and no dye in the pack.
  for (const s of await stacks(page)) await readAc(page, `(dbg.dropInventoryItem(${s.id}), 0)`), await page.waitForTimeout(1500);
  for (let i = 0; i < 2; i++) { await adminCommand(page, `@ci ${WCID} 2`); await page.waitForTimeout(3000); }
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  await page.waitForTimeout(2000);
  const before = await stacks(page);
  state.before = before;
  if (before.length < 2) throw new Error(`${TAG} expected two dye stacks, got ${JSON.stringify(before)}`);
  const [a, b] = before;

  await readAc(page, `(dbg.addShortcut(${SLOT}, ${a.id}), 0)`);
  await page.waitForTimeout(2000);
  state.slotsBefore = await readAc<number[]>(page, 'dbg.toolbarShortcuts()');
  await toolbarShot(page, '1-shortcut-on-a');

  // A real HTML5 drag of pack cell A onto pack cell B.
  await page.dragAndDrop(`[data-inv-slot="${a.idx}"]`, `[data-inv-slot="${b.idx}"]`);
  await page.waitForTimeout(4000);
  const after = await stacks(page);
  const slotsAfter = await readAc<number[]>(page, 'dbg.toolbarShortcuts()');
  const selected = await readAc<number>(page, '(ac.gameUI.hudState.target && ac.gameUI.hudState.target.id) || 0');
  state.after = after;
  state.slotsAfter = slotsAfter;
  state.selected = selected;
  await toolbarShot(page, '2-after-merge');

  // Relog: the server's copy of the bar comes back in PlayerDescription.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page, { url });
  await page.waitForTimeout(8000);
  const slotsRelog = await readAc<number[]>(page, 'dbg.toolbarShortcuts()');
  state.slotsRelog = slotsRelog;
  await toolbarShot(page, '3-after-relog');

  const checks = {
    shortcutOnA: (state.slotsBefore as number[])[SLOT] === a.id,
    mergedIntoB: !after.some((s) => s.id === a.id) && after.some((s) => s.id === b.id && s.stackSize === a.stackSize + b.stackSize),
    slotMovedToB: slotsAfter[SLOT] === b.id && !slotsAfter.includes(a.id),
    bSelected: selected === b.id,
    sentRemoveThenAdd: logs.some((l) => l.includes(`RemoveShortCut: idx=${SLOT}`)) && logs.some((l) => l.includes(`AddShortCut: idx=${SLOT} obj=0x${b.id.toString(16)}`)),
    serverKeptB: slotsRelog[SLOT] === b.id,
  };
  state.checks = checks;
  state.logs = logs;
  const pass = Object.values(checks).every(Boolean);
  state.pass = pass;
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
  console.log(`${TAG} ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`);
  console.log(`${TAG} logs:\n${logs.join('\n')}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
