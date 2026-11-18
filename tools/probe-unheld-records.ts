/**
 * probe-unheld-records — PERF.unheld-records-pile-up: does the client keep ServerObject records for
 * objects that are out of the world with no holder (no cell, no wielder) after the server is done
 * with them? Such a record keeps its hidden mesh in the scene and is walked by every per-frame pass
 * over all objects.
 *
 * On ACE two message orders leave one (read from reference/ACE):
 *  - `wieldtreasure`: a creature whose create list has a destination-10 (WieldTreasure) item. ACE
 *    tracks the creature's wielded items as their own objects (Player_Tracking.cs TrackObject →
 *    TrackEquippedObject: a CreateObject per selectable wielded item). On death Creature_Death.cs
 *    :667-680 moves each Treasure-flagged item into the corpse: PublicUpdateInstanceID(Wielder, 0),
 *    then PublicUpdateInstanceID(Container, corpse) + PickupEvent. The client takes it out of the
 *    world (pickupEvent → leaveWorld) and no DeleteObject ever follows (the corpse's contents are
 *    not tracked objects; the corpse's own DeleteObject names only the corpse). A destination-2
 *    (Wield) item, e.g. the Bandit 185's Longbow, stays equipped and IS deleted with the creature
 *    (RemoveTrackedObject → RemoveTrackedEquippedObject), so Bandits leave nothing.
 *  - `pickup` (two clients): another player picks an item up off the ground. The watcher gets only
 *    a PickupEvent (Player_Tracking.cs RemoveTrackedObject(wo, fromPickup: true)), never a delete.
 *
 * An orphan here is `o.outOfWorld && !o.wielderId && !o.objCellId` (the record's `position` stays
 * set after a PickupEvent, so "no position" misses them).
 *
 * Usage (local ACE, admin account; one live run at a time):
 *   npx tsx tools/probe-unheld-records.ts [--scenario wieldtreasure|pickup|both] [--rounds 6] [--wcid 43393]
 *   default wcid 43393 Gurog Soldier (Frost Greataxe, WieldTreasure, shade 1 = always);
 *   5196 Wounded Drudge Skulker (Board with Nail, 50 %) is a low-level alternative.
 *   Env as tools/lib/game-session.ts / two-client.ts (AC_ACCOUNT, AC_CLIENT_A / _B, AC_BASE …).
 * Writes verification/unheld-records/results.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, sessionArgs } from './lib/game-session.ts';
import { MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/unheld-records';
const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const SCENARIO = arg('scenario', 'both');
const ROUNDS = Number(arg('rounds', '6'));
const WCID = Number(arg('wcid', '43393'));
/** A Knife (329) for the ground pick-up. */
const GROUND_ITEM = 329;

/** Wrap the ServerObjectManager entry points so the message order per guid is on record. */
const TRACE_JS = `(() => { const som = window.__ac.serverObjectManager; if (window.__unheldTrace) return; window.__unheldTrace = [];
  for (const m of ['createObject', 'pickupEvent', 'parentEvent', 'deleteObject']) {
    const f = som[m]; if (typeof f !== 'function') continue;
    som[m] = function (...a) { const g = typeof a[0] === 'number' ? a[0] : (a[0] && a[0].guid);
      window.__unheldTrace.push({ m, guid: (g >>> 0).toString(16), t: Math.round(performance.now()),
        ...(m === 'createObject' ? { name: a[0].name, wielder: (a[0].wielderId >>> 0).toString(16), parent: ((a[0].physicsParentId || 0) >>> 0).toString(16), pos: !!a[0].position } : {}) });
      return f.apply(this, a); };
  } })()`;

const COUNT_JS = `(() => { const ac = window.__ac; const som = ac.serverObjectManager; const scene = ac.sceneManager.scene; const me = ac.charGuid >>> 0;
  const inScene = (o) => { for (let p = o; p; p = p.parent) if (p === scene) return true; return false; };
  const all = [...som.getAllObjects().values()];
  const orphans = all.filter((o) => (o.guid >>> 0) !== me && o.outOfWorld && !o.wielderId && !o.objCellId)
    .map((o) => ({ guid: (o.guid >>> 0).toString(16), name: o.name, containerId: ((o.containerId || 0) >>> 0).toString(16), hasMesh: !!o.mesh, meshInScene: !!o.mesh && inScene(o.mesh), position: !!o.position }));
  return { total: all.length, placed: all.filter((o) => !o.outOfWorld && o.objCellId).length, orphans,
    unheldQueued: som.unheldObjectCount ?? null, released: som.releasedRecordCount ?? null, sceneChildren: scene.children.length }; })()`;

type Count = { total: number; placed: number; orphans: Array<Record<string, unknown>>; unheldQueued: number | null; released: number | null; sceneChildren: number };
const count = async (p: Page): Promise<Count> => p.evaluate(COUNT_JS) as Promise<Count>;
const brief = (c: Count) => `total ${c.total}, placed ${c.placed}, orphans ${c.orphans.length}, scene ${c.sceneChildren}${c.unheldQueued !== null ? `, unheldQueued ${c.unheldQueued}, released ${c.released}` : ''}`;

async function wieldTreasure(): Promise<Record<string, unknown>> {
  const s = await enterWorld({ settleMs: 3000, ...sessionArgs() });
  const p = s.page;
  try {
    await adminCommand(p, `@teleloc ${MEET_LOC}`);
    await p.waitForTimeout(8000);
    await p.evaluate(TRACE_JS);
    const before = await count(p);
    console.log(`[wieldtreasure] before: ${brief(before)}`);
    const rounds: Array<{ round: number; afterCreate: Count; afterKill: Count }> = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await adminCommand(p, `@create ${WCID}`);
      await adminCommand(p, `@create ${WCID}`);
      await p.waitForTimeout(4000);
      const afterCreate = await count(p);
      await adminCommand(p, '@smite all');
      await p.waitForTimeout(8000); // death animation, corpse, the item moves
      const afterKill = await count(p);
      console.log(`[wieldtreasure] round ${r}: after create ${brief(afterCreate)} | after kill ${brief(afterKill)}`);
      rounds.push({ round: r, afterCreate, afterKill });
    }
    await p.waitForTimeout(30_000);
    const after30 = await count(p);
    console.log(`[wieldtreasure] 30 s later: ${brief(after30)}`);
    const trace = await p.evaluate('window.__unheldTrace') as unknown[];
    return { wcid: WCID, before, rounds, after30, trace };
  } finally { await s.browser.close().catch(() => {}); }
}

async function groundPickup(): Promise<Record<string, unknown>> {
  const accA = process.env.AC_CLIENT_A ?? 'fxprobe1';
  const accB = process.env.AC_CLIENT_B ?? 'fxprobe2';
  const open = (acc: string, ch: string, cb: string) => enterWorld({ createCharacter: ch, settleMs: 3000,
    url: `${gameUrl({ cb, env: { ...process.env, AC_ACCOUNT: acc, AC_PASSWORD: acc } })}&agent`, ...sessionArgs() } as never);
  const a = await open(accA, process.env.AC_CLIENT_A_CHAR ?? 'Fxprobe', 'unheld-a');
  const b = await open(accB, process.env.AC_CLIENT_B_CHAR ?? 'Fxprobetwo', 'unheld-b');
  try {
    await adminCommand(a.page, `@teleloc ${MEET_LOC}`);
    const bName = await b.page.evaluate('window.__ac.playerState.name') as string;
    await a.page.waitForTimeout(6000);
    await adminCommand(a.page, `@teletome ${bName}`);
    await b.page.waitForTimeout(9000);
    await a.page.evaluate(TRACE_JS);
    const before = await count(a.page);
    console.log(`[pickup] A before: ${brief(before)}`);
    const picks: Array<{ round: number; item: string | null; ok: boolean; message: string; a: Count }> = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await adminCommand(b.page, `@create ${GROUND_ITEM}`);
      await b.page.waitForTimeout(3000);
      // The newest Knife on the ground B can see.
      const item = await b.page.evaluate(`(() => { const som = window.__ac.serverObjectManager; let best = null;
        for (const o of som.getAllObjects().values()) if (o.weenieClassId === ${GROUND_ITEM} && !o.outOfWorld && o.objCellId && (!best || o.guid > best.guid)) best = o;
        return best ? best.guid >>> 0 : null; })()`) as number | null;
      const res = item === null ? { ok: false, message: 'no knife on the ground' }
        : await b.page.evaluate(`window.__acAgent.pickUp(${item})`) as { ok: boolean; message: string };
      await a.page.waitForTimeout(3000);
      const c = await count(a.page);
      console.log(`[pickup] round ${r}: B picked ${item?.toString(16) ?? '-'} (${res.ok ? 'ok' : res.message}); A: ${brief(c)}`);
      picks.push({ round: r, item: item?.toString(16) ?? null, ok: res.ok, message: res.message, a: c });
    }
    await a.page.waitForTimeout(30_000);
    const after30 = await count(a.page);
    console.log(`[pickup] A 30 s later: ${brief(after30)}`);
    const trace = await a.page.evaluate('window.__unheldTrace') as unknown[];
    return { before, picks, after30, trace };
  } finally {
    await b.browser.close().catch(() => {});
    await a.browser.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString(), scenario: SCENARIO, rounds: ROUNDS };
  if (SCENARIO === 'wieldtreasure' || SCENARIO === 'both') results.wieldtreasure = await wieldTreasure();
  if (SCENARIO === 'pickup' || SCENARIO === 'both') results.pickup = await groundPickup();
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`[probe-unheld-records] wrote ${OUT}/results.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
