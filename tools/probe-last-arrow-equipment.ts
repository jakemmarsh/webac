/**
 * probe-last-arrow-equipment — BUG.death-items-stay-equipped live check on the
 * ammo path. ACE fires the last arrow of a wielded stack with no
 * InventoryRemoveObject: the stack ends in DeleteObject, which must take it
 * off PlayerState.equipment (and the paperdoll ammo slot) too. Wields a
 * Shortbow and a stack of exactly 1 Broadhead Arrow, @create's a Sparring Golem at
 * Holtburg, fires once, and prints the equipment before and after.
 *
 *   AC_BASE=http://localhost:3017/ AC_BRIDGE=ws://localhost:9097 AC_ACCOUNT=stallprobe1 \
 *   AC_PASSWORD=stallprobe1 npx tsx tools/probe-last-arrow-equipment.ts
 * Needs an admin account (@ci / @create / @telepoi).
 * Results 2026-10-12 (local ACE, end of retail): fixed tree PASS; pre-fix 4be2a7a7 FAIL
 * (the Broadhead Arrow stayed in equipment and on the paperdoll after the shot).
 */
import type { Page } from 'playwright';
import { enterWorld, adminCommand, readAc, telepoi } from './lib/game-session.js';

const SHORTBOW = 307;
// Broadhead Arrow: a name no starter stack shares, so dbg.wieldByName picks the single-arrow stack.
const ARROW = 3600;
const ARROW_NAME = 'Broadhead Arrow';
const SPARRING_GOLEM = 12699;

const equipment = (page: Page) => readAc<{ id: number; name: string; slot: number }[]>(page,
  '(ac.playerState.equipment.getAll() || []).map((e) => ({ id: e.id ?? e.objectId ?? e.guid, name: e.name, slot: e.slot ?? e.equipMask ?? e.mask }))');
const paperdoll = (page: Page) => readAc<string[]>(page, '(ac.gameUI.equippedItems || []).map((e) => e.name)');

async function main(): Promise<void> {
  const { browser, page } = await enterWorld({ cb: 'last-arrow', settleMs: 4000, createCharacter: 'Cottage Probe' });
  const log: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/TargetedMissileAttack|AttackDone|DeleteObject|out of ammunition/i.test(t)) log.push(t); });
  await telepoi(page, 'holtburg', 15_000);
  for (const slot of ['MissileWeapon', 'MissileAmmo', 'MeleeWeapon']) {
    await readAc(page, `(dbg.unwield(${JSON.stringify(slot)}), 0)`);
    await page.waitForTimeout(1500);
  }
  // dbg.wieldByName: the first pack item with that name, wielded the retail double-click way.
  const wield = async (name: string) => {
    if (!(await readAc<boolean>(page, `dbg.wieldByName(${JSON.stringify(name)})`))) throw new Error(`${name} not in the pack`);
    await page.waitForTimeout(3000);
  };
  const arrowsInPack = () => readAc<number[]>(page, '(ac.playerState.inventory.getAll() || []).filter((i) => i.name === "Broadhead Arrow").map((i) => i.stackSize ?? i.stack ?? 1)');
  await adminCommand(page, `@ci ${SHORTBOW}`);
  await page.waitForTimeout(2500);
  await wield('Shortbow');
  await adminCommand(page, `@ci ${ARROW} 1`);
  await page.waitForTimeout(2500);
  const stacks = await arrowsInPack();
  if (stacks.length !== 1 || stacks[0] !== 1) throw new Error(`want exactly one stack of 1 Arrow in the pack, have ${JSON.stringify(stacks)}`);
  await wield(ARROW_NAME);
  const before = { equipment: await equipment(page), paperdoll: await paperdoll(page) };
  console.log('[last-arrow] before', JSON.stringify(before));
  if (!before.paperdoll.some((n) => /Arrow/.test(n))) throw new Error('the single arrow did not wield');
  await adminCommand(page, `@create ${SPARRING_GOLEM}`);
  await page.waitForTimeout(4000);
  const golem = await readAc<number | null>(page, `(() => { const c = dbg.collisionState(); let best = null, bd = 1e9;
    for (const o of dbg.getObjects()) { if (!o.pos || o.name !== "Sparring Golem") continue;
      const d = Math.hypot(o.pos.x - c.x, o.pos.z - c.z); if (d < bd) { bd = d; best = o.guid; } }
    return bd < 15 ? best : null; })()`);
  if (golem === null) throw new Error('the @create\'d Sparring Golem is not within 15 m');
  await readAc(page, `(dbg.select(${golem}), 0)`);
  await readAc(page, `(dbg.combatMode('missile'), 0)`);
  await page.waitForTimeout(4000);
  await readAc(page, `(dbg.select(${golem}), 0)`);
  await page.keyboard.down('End');
  await page.waitForTimeout(1200);
  await page.keyboard.up('End');
  await page.waitForTimeout(6000);
  const after = { equipment: await equipment(page), paperdoll: await paperdoll(page) };
  console.log('[last-arrow] after', JSON.stringify(after));
  console.log('[last-arrow] log', JSON.stringify(log));
  const arrowLeft = after.equipment.some((e) => /Arrow/.test(e.name)) || after.paperdoll.some((n) => /Arrow/.test(n));
  console.log(`[last-arrow] RESULT: ${arrowLeft ? 'FAIL — the fired arrow is still equipped' : 'PASS — the last arrow left equipment and the paperdoll'}`);
  await readAc(page, `(dbg.combatMode('peace'), 0)`);
  await page.waitForTimeout(1500);
  await browser.close();
  process.exit(arrowLeft ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
