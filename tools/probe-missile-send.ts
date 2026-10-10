/**
 * probe-missile-send — RECON.missile-suppressed-send-stuck live check.
 * Retail ExecuteAttack @ 0056bb70 sends every missile attack (no client ammo
 * or range gate); ACE answers each rejection with AttackDone, which frees the
 * next attack. ACE refuses Missile mode with no ammo wielded ("You are out of
 * ammunition!" + NonCombat), so the live beats are the range ones. At
 * Holtburg, with a @create'd Sparring Golem (attackable, never fights back),
 * each beat is two End (Medium Attack) presses:
 *   out-of-range — after backing past the Shortbow's 63.3 m range (MaximumVelocity
 *                  24.9): both presses still send, the server's "Out of Range!"
 *                  shows, and each gets its AttackDone.
 *   in-range     — walked back to the golem: both shots fire, each AttackDone'd.
 *
 * Usage: npx tsx tools/probe-missile-send.ts   (writes verification/missile-send/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, readAc, telepoi, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/missile-send`;
const SHORTBOW = 307;
const ARROW = 300;
const SPARRING_GOLEM = 12699;

async function press(page: Page): Promise<void> {
  await page.keyboard.down('End');
  await page.waitForTimeout(1200); // full accuracy bar
  await page.keyboard.up('End');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'missile-send', settleMs: 4000 });
  const log: string[] = [];
  const all: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Sent TargetedMissileAttack|\[AttackDone\]|Missile attack suppressed/.test(t)) log.push(t);
    all.push(t);
  });
  const spew = () => readAc<string[]>(page, 'ac.gameUI.spewBox.items.map((i) => i.text)');
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await telepoi(page, 'holtburg', 15_000);
  await readAc(page, '(dbg.freezeTimeOfDay(0.5), 0)');
  for (const slot of ['MissileWeapon', 'MissileAmmo', 'MeleeWeapon']) {
    await readAc(page, `(dbg.unwield(${JSON.stringify(slot)}), 0)`);
    await page.waitForTimeout(2000);
  }
  const wieldFromPack = async (wcid: number) => {
    const i = await readAc<number | null>(page, `(() => { const i = (ac.gameUI.inventoryItems || []).findIndex((x) => x.weenieClassId === ${wcid}); return i >= 0 ? i : null; })()`);
    if (i === null) throw new Error(`wcid ${wcid} not in the pack`);
    await readAc(page, `(ac.gameUI.dragCallbacks.onDoubleClickItem(${i}), 0)`);
    await page.waitForTimeout(3000);
  };
  await adminCommand(page, `@ci ${SHORTBOW}`);
  await page.waitForTimeout(2500);
  await wieldFromPack(SHORTBOW);
  await adminCommand(page, `@ci ${ARROW} 50`);
  await page.waitForTimeout(2500);
  await wieldFromPack(ARROW);
  state.wielded = await readAc(page, '(ac.gameUI.equippedItems || []).map((e) => e.name)');
  console.log('[missile-send] wielded', JSON.stringify(state.wielded));

  await adminCommand(page, `@create ${SPARRING_GOLEM}`);
  await page.waitForTimeout(4000);
  const golem = await readAc<number | null>(page, `(() => { const c = dbg.collisionState(); let best = null, bd = 1e9;
    for (const o of dbg.getObjects()) { if (!o.pos || o.name !== "Sparring Golem") continue;
      const d = Math.hypot(o.pos.x - c.x, o.pos.z - c.z); if (d < bd) { bd = d; best = o.guid; } }
    return bd < 15 ? best : null; })()`);
  if (golem === null) throw new Error('the @create\'d Sparring Golem is not within 15 m');
  const distance = () => readAc<number | null>(page, `(() => { const o = dbg.getObjects().find((x) => x.guid === ${golem}); const c = dbg.collisionState();
    return o && o.pos ? Math.hypot(o.pos.x - c.x, o.pos.y - c.feetY, o.pos.z - c.z) : null; })()`);
  await readAc(page, `(dbg.select(${golem}), 0)`);
  await readAc(page, `(dbg.combatMode('missile'), 0)`);
  await page.waitForTimeout(4000);

  const beat = async (key: string) => {
    await readAc(page, `(dbg.select(${golem}), 0)`);
    const before = log.length;
    const spewBefore = await spew();
    const d = await distance();
    await press(page);
    await page.waitForTimeout(4000);
    await press(page);
    await page.waitForTimeout(4000);
    const lines = log.slice(before);
    const newSpew = (await spew()).filter((t) => !spewBefore.includes(t));
    await page.screenshot({ path: `${OUT}/${key}.png` });
    const sends = lines.filter((l) => /Sent TargetedMissileAttack/.test(l)).length;
    const dones = lines.filter((l) => /\[AttackDone\]/.test(l)).length;
    const mode = await readAc(page, 'ac.gameUI.hudState.combatMode');
    state[key] = { distance: d, sends, dones, mode, lines, spew: newSpew };
    console.log('[missile-send]', key, JSON.stringify(state[key]));
  };

  // Back away first (the golem stays ahead, so it stays in view and
  // selected); the in-range shots come last because they kill it.
  const walk = async (key: string, until: (d: number) => boolean) => {
    await page.keyboard.down(key);
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(500);
      const d = await distance();
      if (d !== null && until(d)) break;
    }
    await page.keyboard.up(key);
    await page.waitForTimeout(1500);
  };
  await walk('KeyS', (d) => d > 68);
  await beat('out-of-range');
  await walk('KeyW', (d) => d < 8);
  await beat('in-range');

  writeFileSync(`${OUT}/console.log`, all.join('\n'));
  writeFileSync(`${OUT}/state.json`, JSON.stringify(state, null, 2));
  await readAc(page, `(dbg.combatMode('peace'), 0)`);
  await page.waitForTimeout(1500);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
