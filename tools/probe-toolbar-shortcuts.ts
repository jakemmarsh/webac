/**
 * GAP.toolbar-item-shortcuts-inert — live check on the ACE stack that the
 * 18 item-shortcut slots work as retail gmToolbarUI's do:
 *
 *   1. @ci 258 5 (Apple). A real HTML5 drag of the pack cell onto slot 1
 *      makes a shortcut there (HandleDropRelease → CreateShortcutToItem →
 *      Event_AddShortCut).
 *   2. The 1 key (Quickslot 1 outside magic mode, ListenToGlobalMessage →
 *      UseShortcut(0, true)) eats an apple: the client sends Use and the
 *      stack drops by one.
 *   3. A click on the slot selects the apple.
 *   4. Dragging slot 1 onto slot 5 moves the shortcut (RemoveShortCut(0),
 *      AddShortCut(4)); dragging it off onto the 3D view removes it.
 *   5. 0 (Create Shortcut) with the apple selected puts it in the first
 *      empty slot.
 *   6. Relog: ACE's PlayerDescription brings back the server's copy.
 *
 * Screenshots + state.json → verification/gap-toolbar-item-shortcuts/.
 *
 *   npx tsx tools/probe-toolbar-shortcuts.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { enterWorld, waitForWorld, adminCommand, readAc, shot, elementBox, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'gap-toolbar-item-shortcuts');
const TAG = '[toolbar-shortcuts]';
const WCID = 258;

interface Stack { idx: number; id: number; stackSize: number }
const apples = (page: Page) => readAc<Stack[]>(page, `(ac.gameUI.inventoryItems || []).map((x, i) => ({ idx: i, id: x.id, stackSize: x.stackSize, w: x.weenieClassId })).filter((x) => x.w === ${WCID})`);
const slots = (page: Page) => readAc<number[]>(page, 'dbg.toolbarShortcuts()');

async function toolbarShot(page: Page, file: string): Promise<void> {
  const box = await elementBox(page, '[data-item-shortcut="0"]', 0).catch(() => null);
  await shot(page, join(OUT, `${file}.png`));
  if (box) await shot(page, join(OUT, `${file}-toolbar.png`), { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 70), w: 340, h: 120 });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page, url } = await enterWorld({ cb: 'toolbarshortcuts', createCharacter: 'Shortcut Tester', settleMs: 5000 });
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/ShortCut|Sent Use|Item-shortcut bar/.test(t)) logs.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  // Clean bar, no apples.
  for (const [i, id] of (await slots(page)).entries()) if (id) await readAc(page, `(dbg.removeShortcut ? dbg.removeShortcut(${i}) : 0, 0)`);
  for (const s of await apples(page)) { await readAc(page, `(dbg.dropInventoryItem(${s.id}), 0)`); await page.waitForTimeout(1500); }
  await adminCommand(page, `@ci ${WCID} 5`);
  await page.waitForTimeout(3000);
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  await page.waitForTimeout(2000);
  const [apple] = await apples(page);
  if (!apple) throw new Error(`${TAG} no apple stack`);
  state.apple = apple;
  state.slotsStart = await slots(page);

  // 1. Pack cell → slot 1.
  await page.dragAndDrop(`[data-inv-slot="${apple.idx}"]`, '[data-item-shortcut="0"]');
  await page.waitForTimeout(2000);
  state.slotsAfterDrop = await slots(page);
  await toolbarShot(page, '1-dropped-on-slot1');

  // 2. The 1 key eats one.
  await page.mouse.click(700, 300); // focus the 3D view (not the chat entry)
  await page.waitForTimeout(500);
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(5000);
  const afterUse = (await apples(page))[0];
  state.afterUse = afterUse;
  await toolbarShot(page, '2-after-key1');

  // 3. Click selects.
  await readAc(page, '(ac.gameUI.hudState.target = null, 0)');
  await page.click('[data-item-shortcut="0"]');
  await page.waitForTimeout(800);
  state.selectedAfterClick = await readAc<number>(page, '(ac.gameUI.hudState.target && ac.gameUI.hudState.target.id) || 0');

  // 4. Slot 1 → slot 5, then slot 5 → the 3D view.
  await page.dragAndDrop('[data-item-shortcut="0"]', '[data-item-shortcut="4"]');
  await page.waitForTimeout(2000);
  state.slotsAfterMove = await slots(page);
  await toolbarShot(page, '3-moved-to-slot5');
  await page.dragAndDrop('[data-item-shortcut="4"]', 'canvas', { targetPosition: { x: 600, y: 250 } });
  await page.waitForTimeout(2000);
  state.slotsAfterDragOff = await slots(page);
  await toolbarShot(page, '4-dragged-off');

  // 5. Create Shortcut (0) on the selection.
  await page.click('[data-item-shortcut="0"]').catch(() => {});
  await readAc(page, `(() => { const it = ac.gameUI.inventoryItems.find((x) => x.id === ${apple.id}); if (it) ac.gameUI.selectInventoryItem(it); return 0; })()`);
  await page.mouse.click(700, 300).catch(() => {});
  await readAc(page, `(() => { const it = ac.gameUI.inventoryItems.find((x) => x.id === ${apple.id}); if (it) ac.gameUI.selectInventoryItem(it); return 0; })()`);
  await page.keyboard.press('Digit0');
  await page.waitForTimeout(2000);
  state.slotsAfterCreate = await slots(page);
  await toolbarShot(page, '5-create-shortcut');

  // 6. Relog.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page, { url });
  await page.waitForTimeout(8000);
  state.slotsRelog = await slots(page);
  await toolbarShot(page, '6-after-relog');

  const hex = apple.id.toString(16);
  const s = (k: string) => state[k] as number[];
  const checks = {
    dropMadeShortcut: s('slotsAfterDrop')[0] === apple.id && logs.some((l) => l.includes(`AddShortCut: idx=0 obj=0x${hex}`)),
    key1Used: logs.some((l) => /Sent Use/.test(l) && l.includes(hex)) && !!afterUse && afterUse.stackSize === apple.stackSize - 1,
    clickSelects: state.selectedAfterClick === apple.id,
    dragMoves: s('slotsAfterMove')[4] === apple.id && s('slotsAfterMove')[0] === 0,
    dragOffRemoves: !s('slotsAfterDragOff').includes(apple.id),
    createShortcut: s('slotsAfterCreate')[0] === apple.id,
    serverKept: s('slotsRelog')[0] === apple.id,
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
