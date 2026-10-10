/**
 * GAP.world-drag-drop.a.a — live check on the ACE stack: pack items dropped
 * on the paperdoll run CPlayerSystem::AutoWear / AutoWield's client-side
 * legality before anything is sent (gmPaperDollUI::AcceptDragObject
 * @ 004a3b10, AcceptPaperDollDragObject @ 004a4a70).
 *
 *   cap-band   a Leather Cap on the drag band while the starter Cap is worn →
 *              "You must remove your Cap to wear that", nothing sent
 *              (AutoWearIsLegal's clothingPriority overlap).
 *   cap-worn   the worn Cap itself on the band → "The Cap is already being
 *              worn", nothing sent.
 *   bow-1      a Longbow on the Weapon slot → wielded.
 *   bow-2      a second Longbow on the Weapon slot → refused silently, nothing
 *              sent (AutoWield param_4 = 1, param_5 = 0: no line, no unwield).
 *   shield     a Kite Shield on the Shield slot → "A shield may not be worn
 *              with the Longbow" (AutoWieldIsLegal).
 *   quarrels   Quarrels on the Ammunition slot → "Cannot be used with Longbow".
 *   arrows     Arrows on the Ammunition slot → wielded.
 *
 * Each drop sets the pack cell's drag state and releases on whatever element
 * sits at the target's centre (the real mouse's hit: the DAT renderer draws
 * a listener-less twin of the band 0x100001d6 under ours). Runs on the
 * account's auto-entered character; the bow / arrows a previous run wielded
 * are unwielded first. A character the probe had to create is soft-deleted. Screenshots + state.json → verification/gap-world-drag-drop-a-a/.
 *
 *   npx tsx tools/probe-paperdoll-slot-legality.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  enterWorld, adminCommand, telepoi, readAc, shot, REPO, openSession, sessionArgs, gameUrl, waitForCharSelect,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'gap-world-drag-drop-a-a');
const TAG = '[paperdoll-legality]';
const NAME = 'Slot Tester';

interface Beat { key: string; name: string; worn?: boolean; target: string; expectWorn: boolean; expectLine: string | null }
const BAND = '[data-element-id="0x100001d6"]';
const BEATS: Beat[] = [
  { key: 'cap-band', name: 'Leather Cap', target: BAND, expectWorn: false, expectLine: 'You must remove your Cap to wear that' },
  { key: 'cap-worn', name: 'Cap', worn: true, target: BAND, expectWorn: true, expectLine: 'The Cap is already being worn' },
  { key: 'bow-1', name: 'Longbow', target: '[data-equip-slot="Weapon"]', expectWorn: true, expectLine: null },
  { key: 'bow-2', name: 'Longbow', target: '[data-equip-slot="Weapon"]', expectWorn: false, expectLine: null },
  { key: 'shield', name: 'Kite Shield', target: '[data-equip-slot="Shield"]', expectWorn: false, expectLine: 'A shield may not be worn with the Longbow' },
  { key: 'quarrels', name: 'Quarrel', target: '[data-equip-slot="Ammunition"]', expectWorn: false, expectLine: 'Cannot be used with Longbow' },
  { key: 'arrows', name: 'Arrow', target: '[data-equip-slot="Ammunition"]', expectWorn: true, expectLine: null },
];

async function until(page: Page, expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await readAc<boolean>(page, expr).catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** A pack item by name: the first UNEQUIPPED one, or the worn one. */
const packFind = (page: Page, name: string, worn: boolean) => readAc<{ idx: number; id: number; name: string } | null>(page, `(() => {
  const items = ac.gameUI.inventoryItems || []; const on = new Set((ac.gameUI.equippedItems || []).map((e) => e.id));
  const i = items.findIndex((it) => it.name === ${JSON.stringify(name)} && on.has(it.id) === ${worn});
  return i < 0 ? null : { idx: i, id: items[i].id, name: items[i].name }; })()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'pdlegality', createCharacter: NAME, settleMs: 4000 });
  const sends: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/Sent (GetAndWieldItem|StackableSplitToWield|PutItemInContainer)|refused/.test(t)) sends.push(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };
  await telepoi(page, 'holtburg', 12_000);
  await readAc(page, `(dbg.freezeTimeOfDay(0.5), 0)`);
  for (const slot of ['MissileWeapon', 'MissileAmmo']) {
    await readAc(page, `(dbg.unwield(${JSON.stringify(slot)}), 0)`);
    await page.waitForTimeout(2500);
  }
  const have = await readAc<string[]>(page, `(ac.gameUI.inventoryItems || []).map((i) => i.name)`);
  const want: Array<[string, number, number]> = [['Leather Cap', 45, 1], ['Longbow', 306, 2], ['Kite Shield', 91, 1], ['Quarrel', 305, 1], ['Arrow', 300, 1]];
  for (const [n, w, count] of want) {
    for (let k = have.filter((h) => h === n).length; k < count; k++) { await adminCommand(page, `@ci ${w}`); await page.waitForTimeout(2000); }
  }
  await readAc(page, `(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()`);
  await page.waitForTimeout(2500);

  for (const b of BEATS) {
    // One inventory request at a time: wait for the previous one to clear.
    await until(page, 'dbg.inventoryRequestRefusal() === null', 10_000);
    const item = await packFind(page, b.name, b.worn === true);
    if (!item) { state[b.key] = { skipped: 'not in the pack' }; continue; }
    const sentBefore = sends.length;
    const spewBefore = await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`);
    const dropped = await readAc<boolean>(page, `(() => { const ui = ac.gameUI;
      const pd = ui.inventoryPanelHandle.elements.get(0x100001cd); const at = pd && pd.querySelector(${JSON.stringify(b.target)});
      if (!at) return false; const r = at.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y); if (!el) return false;
      ui.dragItemIndex = ${item.idx}; ui.dragSourceSlot = null;
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      el.dispatchEvent(new DragEvent('dragover', o)); el.dispatchEvent(new DragEvent('drop', o)); return true; })()`);
    // The spew strip keeps a line 5 s: read it at once.
    await page.waitForTimeout(500);
    const spew = await readAc<string[]>(page, `ac.gameUI.spewBox.items.map((i) => i.text)`);
    const newLines = spew.filter((t) => !spewBefore.includes(t));
    await shot(page, join(OUT, `${b.key}.png`));
    const worn = await until(page, `(ac.gameUI.equippedItems || []).some((e) => e.id === ${item.id})`, b.expectWorn ? 15_000 : 3_000);
    const slot = await readAc<number | null>(page, `(() => { const e = (ac.gameUI.equippedItems || []).find((x) => x.id === ${item.id}); return e ? e.slot : null; })()`);
    const sent = sends.slice(sentBefore);
    const lineOk = b.expectLine === null ? !newLines.some((t) => /wear|worn|wield|Cannot/.test(t)) : newLines.includes(b.expectLine);
    const expectSend = b.expectWorn && !b.worn;
    const pass = dropped && worn === b.expectWorn && lineOk && (expectSend ? sent.length > 0 : sent.length === 0);
    state[b.key] = { item, target: b.target, dropped, worn, slot: slot === null ? null : `0x${slot.toString(16)}`, spew: newLines, sent, pass };
    console.log(TAG, b.key, JSON.stringify(state[b.key]));
    await page.waitForTimeout(1500);
  }
  await shot(page, join(OUT, 'final.png'));
  state.sends = sends;
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
  await browser.close();

  // Soft-delete the probe character so auto-enter keeps landing elsewhere.
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'pdlegality-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log(TAG, 'probe character deleted:', del);
  await s2.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
