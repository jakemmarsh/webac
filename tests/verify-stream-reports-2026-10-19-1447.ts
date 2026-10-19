/**
 * Stream reports, 2026-10-19 13:46–14:47Z (build b2375d93f): Claude Arcanist (mage, "Arcanist fights" following Bulwark,
 * Follow 8 m + FollowLeash 7) and Claude Bulwark (soldier, "Bulwark fights") looping Sand Shallow 0x02A0's rooms
 * 0x0122 → 0x013C → 0x015A → 0x010F. Transcripts {mage,soldier}-2026-10-19-seg1.jsonl, page traces {mage,soldier}.log.
 *
 * 1. Arcanist 19–29 m behind Bulwark, a floor up, several times; his stay_with walks stopped "they are going elsewhere".
 *    Two causes in the page traces. (a) Every walk through the doorway at (424, 30655) south of 0x02A00140 stood ~60 s
 *    searching ("no way into the doorway … (something stands in it)") before a wide search walked straight through: the
 *    corridor past it is two cells split by a slanted plane (0x013E under, 0x013F over), read as a ceiling hole, so the
 *    only route was 0x013F's 0.75 m sliver of the doorway at z −15 (cellPath CellDoor.slanted). (b) Her Follow's walk to
 *    Bulwark ran the plan made when it set off: once he went on down the ramp into other rooms it walked straight at him,
 *    stalled at the wall (or up into the alcove 0x0135 at z −15), and fell 20–30 m behind (WalkOptions.track).
 * 2. Arcanist's walk_to got "walking to Claude Bulwark: interrupted (replaced by walking to Claude Bulwark)": her
 *    routine's own Follow walk, replaced by that very walk_to (which went on and arrived); the hold had applied.
 * 3. Mummies "AIMED AT YOU BUT NOT REACHING YOU" behind walls: "Bulwark fights" skipped every stuck chaser, though a
 *    walk reached them (he fetched each with far=true), and nothing said which Arcanist's bolts reached.
 * 4. The fellow leash refused 13–20 m pulls with Arcanist beside him: it measured where she stood, while she follows.
 * 5. "ghost monster Ancient Mu-miyah set aside": a mummy walled off from her (checked in verify-vtank-macro.ts and
 *    verify-macro-target-tracker.ts).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { findRoute, loadCellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
};

const LB = 0x02a00000;
const C = (n: number): number => (LB | n) >>> 0;
/** Sand Shallow's landblock frame: global = local + (2 × 192, 0xA0 × 192). */
const GX = 384, GY = 0xa0 * 192;

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('1. Sand Shallow 0x02A0 (needs DAT files)', () => {
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 120_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the slanted split between 0x013E and 0x013F is walked through: the route south from 0x0140 takes the doorway at its floor (z −18), not 0x013F\'s 0.75 m sliver at z −15', () => {
    const g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB);
    const split = (g.doors.get(C(0x13e)) ?? []).find((d) => d.b === C(0x13f))!;
    expect(split.slanted).toBe(true);
    expect(split.climb).toBe(true);
    // A true ceiling hole is still one: 0x013A's opening up into 0x01C5 (z −12 over a floor at −18).
    expect((g.doors.get(C(0x13a)) ?? []).find((d) => d.b === C(0x1c5))?.slanted).toBeUndefined();
    const from = { x: 424 - GX, y: 30645 - GY, z: -18 };
    const route = findRoute(g, C(0x140), from, C(0x10f), { x: 10, y: -99.4, z: -24 }, [], { bodyOnly: true });
    expect(route, 'a body-sized route').not.toBeNull();
    const first = route![0];
    expect(Math.hypot(first.x - (424 - GX), first.y - (30655 - GY))).toBeLessThan(0.5);
    expect(first.feet).toBeCloseTo(-18, 1);
    // The split itself is no point to aim at (mid-room, over the floor).
    expect(route!.some((p) => Math.hypot(p.x - (424 - GX), p.y - (30657.2 - GY)) < 0.3)).toBe(false);
  });

  it('Bulwark\'s walk_to 0x02A0010F from 0x0140 goes through that doorway with no "something stands in it" search', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      const r = await host.walkTarget(C(0x140), { x: 424 - GX, y: 30645 - GY, z: -18 }, '0x02A0010F', { maxMs: 120_000 });
      expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
      expect(host.me.cell).toBe(C(0x10f));
      expect(host.traces.join('\n')).not.toMatch(/no way into the doorway|no doorway route from cell 0x2a00140/);
    } finally { host.dispose(); }
  }, 300_000);

  it('"Arcanist fights" keeps within its leash (Follow 8 m + FollowLeash 7) of Bulwark as he goes down the ramp to 0x010F: the Follow\'s walk plans the way again as he goes into other rooms', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    // Bulwark's own walk, recorded tick by tick.
    const traj: Array<{ cell: number; x: number; y: number; z: number }> = [];
    {
      const h = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
      try {
        const r = await h.run(C(0x140), { x: 40, y: -77, z: -18 }, (api) => api.walkTo('0x02A0010F', { timeoutMs: 120_000 }), { maxMs: 120_000, each: () => traj.push({ cell: h.me.cell, x: h.me.x, y: h.me.y, z: h.me.z }) });
        expect(r.ok, r.message).toBe(true);
      } finally { h.dispose(); }
    }
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me.health = { current: 187, max: 187 };
    host.me.name = 'Claude Arcanist';
    const BUL = 0x500000a4;
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, cell: C(0x140), x: 40, y: -77, z: -18, heardAt: 0 });
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 197, max: 197 }, stamina: { cur: 200, max: 297 }, mana: { cur: 97, max: 97 } }];
    try {
      await host.run(C(0x140), { x: 41, y: -74, z: -18 }, async (api) => { api.routine.start(ready('mage')); return { ok: true, message: 'started' }; }, { maxMs: 1000 });
      const api = (host as unknown as { api: AgentApi }).api;
      let t = 0, i = 0, maxGap = 0;
      const gaps: string[] = [];
      await host.run(host.me.cell, { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), {
        maxMs: 60_000, sameApi: true,
        each: () => {
          t += 100;
          if (t >= 3000 && i < traj.length) { Object.assign(host.objs.get(BUL)!, traj[i], { heardAt: host.t }); i++; }
          const b = host.objs.get(BUL)!;
          const gap = Math.hypot(b.x - host.me.x, b.y - host.me.y, b.z - host.me.z);
          if (t > 3000) maxGap = Math.max(maxGap, gap);
          if (t % 1000 === 0) gaps.push(`${t / 1000}s gap ${gap.toFixed(1)} me z ${host.me.z.toFixed(1)}`);
        },
      });
      const b = host.objs.get(BUL)!;
      const why = `${gaps.join('\n')}\n${host.traces.filter((l) => /walk|follow/.test(l)).join('\n')}`;
      // Never past the leash (it stood 26 m behind before: the walk ran straight at him from its first plan).
      expect(maxGap, why).toBeLessThanOrEqual(15);
      expect(host.traces.some((l) => /follow: Claude Bulwark went into another room; planning the way to them again/.test(l)), why).toBe(true);
      // And beside him at the end, on his floor.
      expect(Math.hypot(b.x - host.me.x, b.y - host.me.y), why).toBeLessThanOrEqual(9);
      expect(Math.abs(b.z - host.me.z)).toBeLessThan(2);
      api.routine.stop();
    } finally { host.dispose(); }
  }, 300_000);
});

describe('2. the routine\'s own task, replaced by the player\'s command, answers only the routine', () => {
  let host: FakeHost;
  let api: AgentApi;
  const BUL = 0x500000a4;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, x: 80, y: 50 });
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 197, max: 197 }, stamina: { cur: 200, max: 297 }, mana: { cur: 97, max: 97 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const taskDones = (): string[] => api.eventsSince(0).filter((e) => e.type === 'task-done').map((e) => e.text);

  it('a walk started outside any hand command (a routine\'s Follow) replaced by walk_to: no "interrupted" task-done; the walk_to\'s own end is one', async () => {
    const surface = api.surface() as { walkTo: (t: number | string, o?: object) => Promise<{ ok: boolean; message: string }> };
    let routineGot = '';
    void api.walkTo(BUL, { within: 8 }).then((r) => { routineGot = r.message; });
    await step(api, host, 500);
    let handGot = '';
    void surface.walkTo('Claude Bulwark').then((r) => { handGot = r.message; });
    await step(api, host, 15_000);
    expect(routineGot).toMatch(/interrupted \(replaced by walking to Claude Bulwark\)/);
    expect(handGot).toMatch(/arrived/);
    expect(taskDones().filter((x) => /interrupted/.test(x)), taskDones().join('\n')).toEqual([]);
    expect(taskDones().filter((x) => /arrived/.test(x))).toHaveLength(1);
  });

  it('the player\'s own walk replaced by their next one still says so (that is their order, cut off)', async () => {
    const surface = api.surface() as { walkTo: (t: number | string, o?: object) => Promise<{ ok: boolean; message: string }> };
    void surface.walkTo('Claude Bulwark');
    await step(api, host, 500);
    void surface.walkTo('Claude Bulwark');
    await step(api, host, 15_000);
    expect(taskDones().filter((x) => /interrupted \(replaced by walking to Claude Bulwark\)/.test(x))).toHaveLength(1);
  });
});

describe('3 and 4. stuck chasers and the fellow leash, by what each of them can hit', () => {
  const ROOM = 0x01d20150, ROOM2 = 0x01d20151;
  const STUCK = 0x80005012, M = 0x80005020;
  const ARC = 0x500000b7;
  let host: FakeHost;
  let api: AgentApi;
  // The macro plans with the era's spell table (its families); the routine test below needs the portal DAT for it.
  let table: unknown = null;
  beforeAll(async () => {
    if (!existsSync(DAT_PATHS.portal)) return;
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    if (table) (host as unknown as { spellTableData: () => unknown }).spellTableData = () => table;
    host.spells = () => [];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 300, buffed: 300 }];
    Object.assign(host.me, { cell: ROOM, x: 80, y: 20, z: 0, combatMode: 'melee', name: 'Claude Bulwark' });
    host.me.health = { current: 197, max: 197 };
    host.inv = [{ guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as never;
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 187, max: 187 }, stamina: { cur: 200, max: 256 }, mana: { cur: 300, max: 334 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('observe says which fellow\'s bolt reaches a chaser stuck behind a wall, or that none does', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, cell: ROOM, x: 82, y: 18, z: 0 });
    host.add({ guid: STUCK, name: 'Ancient Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 88, y: 26, z: 0, seeks: { guid: host.me.guid, kind: 'move' } });
    host.lineOfFire = () => ({ dist: 10, blockedAt: 3, blocker: 'a wall' });
    let open = true;
    host.lineOfFireFrom = (_g, from) => (from === ARC ? { dist: 10, blockedAt: open ? null : 4, blocker: 'a wall' } : null);
    await step(api, host, 25_000);
    expect(api.observe().nearby.find((o) => o.guid === STUCK)?.comingAtYouStuck).toBe(true);
    let text = formatObservation(api.observe());
    expect(text, text).toMatch(/Ancient Mu-miyah .*AIMED AT YOU BUT NOT REACHING YOU \(running at you, no closer in \d+ s, no line of fire: a wall in the way, Claude Arcanist has a line of fire to it \(\d+ m from them\): a bolt from there reaches it\)/);
    open = false;
    text = formatObservation(api.observe());
    expect(text).toMatch(/AIMED AT YOU BUT NOT REACHING YOU \(.*no line of fire from Claude Arcanist either\)/);
  });

  it.skipIf(!existsSync(DAT_PATHS.portal))('"Bulwark fights" goes after a stuck chaser indoors that the doorway route reaches (as far=true by hand did); one no route is known to is still left alone', async () => {
    // In the next room, 8 m off, by a short doorway way round.
    host.add({ guid: STUCK, name: 'Ancient Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM2, x: 88, y: 20, z: 0, seeks: { guid: host.me.guid, kind: 'move' } });
    await step(api, host, 25_000);
    expect(api.observe().nearby.find((o) => o.guid === STUCK)?.comingAtYouStuck).toBe(true);
    // No route known (the fake's cell graph has none): left alone, as before.
    expect(api.walkReaches(STUCK)).toBe(false);
    api.routine.start(ready('soldier'));
    await step(api, host, 3000);
    expect(host.sent.some((s) => s.startsWith(`attack ${STUCK.toString(16)}`))).toBe(false);
    api.routine.stop();
    // The way there by a doorway at (84, 21).
    host.routeTo = [{ x: 84, y: 21, z: 0 }];
    expect(api.walkReaches(STUCK)).toBe(true);
    const at = host.sent.length;
    api.routine.start(ready('soldier'));
    await step(api, host, 6000);
    expect(host.sent.slice(at).some((s) => s.startsWith(`attack ${STUCK.toString(16)}`)), `${host.sent.slice(at).join('\n')}\n${api.routine.history().join('\n')}`).toBe(true);
  });

  it('the fellow leash counts a fellow who keeps up with you as coming along; one who stays put is still left behind', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, cell: ROOM, x: 81, y: 20, z: 0 });
    host.add({ guid: M, name: 'Ancient Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 80, y: 36, z: 0 });
    await step(api, host, 500);
    // Beside him, 16 m from the mummy: refused (she hasn't shown she follows).
    expect(api.meleeChaseBar(M)).toMatch(/running up to it leaves Claude Arcanist 1\d m behind/);
    // They walk 12 m north together (her routine's Follow at his heels).
    const arc = host.objs.get(ARC)!;
    await step(api, host, 3000, () => { host.me.y += 0.4; arc.y += 0.4; });
    Object.assign(host.objs.get(M)!, { y: host.me.y + 16 });
    expect(api.meleeChaseBar(M)).toBeNull();
    // Now he walks 12 m on and she stays put: she fell behind, and the leash holds again.
    await step(api, host, 3000, () => { host.me.y += 0.4; });
    Object.assign(arc, { y: host.me.y - 1 }); // back beside him, but not following
    Object.assign(host.objs.get(M)!, { y: host.me.y + 16 });
    await step(api, host, 200);
    expect(api.meleeChaseBar(M)).toMatch(/running up to it leaves Claude Arcanist 1\d m behind/);
  });
});
