/**
 * BUG.stack-merge-not-found — live check on the ACE stack that a stack merged
 * OUT of an open container (a chest, as a corpse) leaves that container's window.
 *
 * ACE ends a merge that uses up a contained stack with InventoryRemoveObject
 * (0x0024) alone (Player_Inventory.cs:3096): the stack is not on a landblock,
 * so its Destroy sends no DeleteObject. Retail's 0x24 → ServerSaysRemove
 * @ 0058e4c0 → ServerSaysMoveItem drops it from the open item list; ours left
 * it listed, and merging it again drew "Source stack not found!".
 *
 *   1. @ci two Practice Arrow stacks (30 and 20) and @create a chest beside you.
 *   2. Open the chest and put the 20 into it (PutItemInContainer).
 *   3. Pick the 20 up from the chest's window (the double-click's PlaceInBackpack):
 *      it auto-merges onto a Practice Arrow stack in the main pack (StackableMerge),
 *      and ACE answers with 0x0024 alone.
 *   4. Pass: the pack's arrows grew by 20, the 20 is gone from the chest's window,
 *      and no "stack not found" / "can't be merged" line came back.
 *
 * Needs an admin account (testacjs3) and a Vite serving the fix, with &agent
 * (window.__acAgent). Plays the account's own character; the chest is deleted after.
 * Screenshots + state.json → verification/bug-stack-merge-not-found/.
 *
 *   AC_URL='http://localhost:<port>/?ace&bridge=ws://localhost:9090&account=testacjs3&password=testacjs3&agent' \
 *     npx tsx tools/probe-container-merge-strip.ts   (&agent exposes window.__acAgent)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  enterWorld, adminCommand, deleteObjects, telepoi, readAc, shot, REPO,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'bug-stack-merge-not-found');
const TAG = '[container-merge]';
const PRACTICE_ARROW = 4184; const CHEST = 143;

async function until(page: Page, expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await readAc<boolean>(page, expr).catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const packItems = (page: Page) => readAc<Array<{ id: number; wcid: number; stack: number; containerId: number }>>(page,
  `(ac.gameUI.inventoryItems || []).map((i) => ({ id: i.id, wcid: i.weenieClassId, stack: i.stackSize, containerId: i.containerId }))`);
const strip = (page: Page) => readAc<Array<{ guid: number; name: string; stack: number }>>(page,
  `(ac.gameUI.containerItems || []).map((i) => ({ guid: i.guid, name: i.name, stack: i.stackSize }))`);
const agent = <T>(page: Page, call: string) => page.evaluate(`(async () => { const r = await window.__acAgent.${call}; return r; })()`) as Promise<T>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'cmerge', settleMs: 4000 });
  const sends: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/Sent (StackableMerge|PutItemInContainer)/.test(t)) sends.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };
  await telepoi(page, 'holtburg', 12_000);
  await readAc(page, `(dbg.freezeTimeOfDay(0.5), 0)`);
  const arrows = async () => (await packItems(page)).filter((i) => i.wcid === PRACTICE_ARROW).reduce((n, i) => n + i.stack, 0);

  const before = new Set((await packItems(page)).map((i) => i.id));
  const chestsBefore = new Set((await readAc<Array<{ guid: number }>>(page, `dbg.listServerObjects()`)).map((o) => o.guid));
  for (const cmd of [`@ci ${PRACTICE_ARROW} 30`, `@ci ${PRACTICE_ARROW} 20`, `@create ${CHEST}`]) {
    await adminCommand(page, cmd);
    await page.waitForTimeout(2500);
  }
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  const b20 = (await packItems(page)).find((i) => !before.has(i.id) && i.wcid === PRACTICE_ARROW && i.stack === 20);
  const chest = (await readAc<Array<{ guid: number; name: string }>>(page, `dbg.listServerObjects()`)).find((o) => !chestsBefore.has(o.guid) && /chest/i.test(o.name));
  state.b20 = b20; state.chest = chest;
  if (!b20 || !chest) throw new Error(`${TAG} setup failed: ${JSON.stringify(state)}`);

  try {
    state.open = await agent(page, `use(${chest.guid})`);
    state.openOk = await until(page, `!!(ac.gameUI.containerItems)`, 10_000);
    state.put = await readAc(page, `dbg.putInPack(${b20.id}, ${chest.guid})`);
    state.inChest = await until(page, `(ac.gameUI.containerItems || []).some((i) => i.guid === ${b20.id})`, 10_000);
    state.stripBefore = await strip(page);
    await shot(page, join(OUT, 'in-chest.png'));

    const arrowsBefore = await arrows();
    const sentBefore = sends.length;
    // Picking it up from the open window = the double-click's PlaceInBackpack: it auto-merges onto a pack stack.
    state.merge = await agent(page, `pickUp(${b20.id})`);
    state.grewBy20 = await until(page, `(ac.gameUI.inventoryItems || []).filter((i) => i.weenieClassId === ${PRACTICE_ARROW}).reduce((n, i) => n + i.stackSize, 0) === ${arrowsBefore + 20}`, 15_000);
    state.stripCleared = await until(page, `!(ac.gameUI.containerItems || []).some((i) => i.guid === ${b20.id})`, 10_000);
    await page.waitForTimeout(2000);
    state.stripAfter = await strip(page);
    state.mergeSends = sends.slice(sentBefore);
    const spew = await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`);
    state.spewNotFound = spew.filter((t) => /stack not found|can't be merged/i.test(t));
    await shot(page, join(OUT, 'after-merge.png'));
    state.pass = !!(state.inChest && state.grewBy20 && state.stripCleared && (state.spewNotFound as string[]).length === 0
      && (state.mergeSends as string[]).some((t) => /StackableMerge/.test(t)));
  } finally {
    // Probe world hygiene: the chest goes.
    state.cleanedUp = await deleteObjects(page, [chest.guid]).catch(() => 0);
  }
  console.log(TAG, JSON.stringify(state, null, 1));
  writeFileSync(join(OUT, 'state.json'), JSON.stringify({ ...state, sends }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
