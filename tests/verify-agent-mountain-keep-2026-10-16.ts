/**
 * Mountain Keep (dungeon landblock 0x01D2, portal at 54.7N 32.9E; floors 6 m apart), 2026-10-16 14:20–15:21Z, end of
 * retail local ACE, build e96f9d42. Stream players Claude Arcanist (mage) and Claude Bulwark (tank) reported (reports
 * stream/reports/{mage-2026-10-16T15-21-07-376Z,soldier-2026-10-16T15-21-00-536Z}-seg1.md; transcripts
 * stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl; page traces mage.log / soldier.log):
 *   1. walk_to "fell 5.6 m where no drop was planned (slid off an edge)" / "dropped off a ledge (6.0 m)"; with stay_with
 *      the pair split onto different floors.
 *   2. observe said Bulwark was "ON ANOTHER FLOOR: no walk reaches it" while walk_to reached him; walk_to 0x01D202B3 /
 *      0x01D20340 "stuck, no walkable way"; the walks to 0x01D2014F stayed 56–66 m short.
 *   3. "arrived (0.1 m)" with the partner "15 m away"; and a walk_to Arcanist "stuck 0.5 m short" 6 m under her.
 *   4. attack took the tank to Mu-miyahs 6–12 m up or down, off the caster's floor (three times).
 *   5. walk_to the partner "target vanished or not in world" when she was only out of sight.
 *
 * What the real geometry says (cell DAT, landblock 0x01D2; tests below): the floors join downward through pits, and
 * the pits are crossed at −6 by bridges: the deck of 0x01D20124 lies at the floor opening of the air cell 0x01D201FF,
 * between that cell's doorways to 0x01D201FB (west) and 0x01D20201 (east). The doorway route treated every air cell as
 * "down only", so a route across a pit needed a leap or a fall, and 0x014F's whole part of the keep had no route from the
 * fountain wing (0x01D202A2) but a 7.1 m corner-to-corner leap over the pit 0x01D202A7. 0x02B3 and 0x0340 (the upper
 * part, z −6 to +36, where the portal drops you at 0x01D202F7) really are cut off from the fountain wing but for that
 * leap: the doorway route's only way, which neither player's jump search found a take-off for.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { bridgeAcross, cellStandPoint, findRouteViaOutside, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** Two interior cells of the fake host's landblock (0xA9B4): an upper room and the floor under it. */
const UPPER = 0xa9b40150, LOWER = 0xa9b40151, OTHER = 0xa9b40152;
const ARC = 0x50000002;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

const fellowship = (host: FakeHost, guid = ARC, name = 'Claude Arcanist'): void => {
  host.fellows = () => [{ guid, name, health: { cur: 160, max: 166 }, stamina: { cur: 200, max: 214 }, mana: { cur: 300, max: 306 } }];
};

describe('fake host', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.me.level = 35;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('4. attack: a monster on another floor while your fellow stands on yours', () => {
    const MU = 0x80007179;
    beforeEach(() => {
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 81, y: 21, z: 0 });
      fellowship(host);
      host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 86, y: 30, z: 12, level: 60 });
    });

    it('is refused with where it is and what to do instead (was: a run-up off her floor)', () => {
      host.add({ guid: 0x80008449, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 80, y: 28, z: 0, level: 60 });
      const r = api.attack(MU);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Dread Mu-miyah #80007179 is on a floor above \(12 m up, 12 m NE\)/);
      expect(r.message).toMatch(/running up to it leaves Claude Arcanist \(1 m from you\) behind on this floor, so no attack was started/);
      expect(r.message).toMatch(/fight Dread Mu-miyah #80008449 on your floor \(8 m N\)/);
      expect(r.message).toMatch(/ac_attack target=#80007179 far=true to go anyway/);
      expect(host.sent.filter((x) => x.startsWith('attack'))).toEqual([]);
      expect(host.target).toBeNull();
    });

    it('says when no walk reaches it either (the doorway route has none)', () => {
      host.routeTo = null; // FakeHost.route: none
      host.objs.get(MU)!.cell = OTHER;
      const r = api.attack(MU);
      expect(r.message).toMatch(/is on a floor above \(12 m up, 12 m NE\), and no walk reaches it from here anyway \(no doorway route from your floor\)/);
    });

    it('far=true goes anyway, through the page\'s method table as the ac_attack tool sends it', () => {
      const surface = api.surface() as { attack: (t: unknown, o?: unknown) => { ok: boolean; message: string } };
      expect(surface.attack(MU).ok).toBe(false);
      expect(surface.attack(MU, { far: true }).ok).toBe(true);
    });

    it('with no fellow on your floor (or none at all) it goes as before', () => {
      host.objs.get(ARC)!.z = 12; // up there with it
      expect(api.attack(MU).ok).toBe(true);
      host.fellows = undefined;
      expect(api.attack(MU).ok).toBe(true);
    });

    it('with no target named, a monster on your floor is taken first', () => {
      host.add({ guid: 0x80008449, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 80, y: 32, z: 0, level: 60 });
      const r = api.attack(null);
      expect(r.ok).toBe(true);
      expect(host.target).toBe(0x80008449);
    });
  });

  describe('2. observe: whether a walk gets to a target on another floor is the planner\'s answer', () => {
    beforeEach(() => {
      host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: LOWER, x: 82, y: 20, z: -6 });
      host.target = 0x500000a4;
    });

    it('a doorway route with a drop: "a walk gets there", not "no walk reaches it" (Arcanist, 15:14Z)', () => {
      host.routeTo = [{ x: 85, y: 20, z: 0, drop: 6, landing: -6 } as { x: number; y: number; z: number }];
      const obs = api.observe();
      expect(obs.target?.otherFloor).toBe(-6);
      expect(obs.target?.otherFloorWay).toMatchObject({ drops: 1, leaps: 0 });
      expect(formatObservation(obs)).toMatch(/ON ANOTHER FLOOR, 6 m down: no melee from here; a walk gets there by the doorways \(about 8 m, a drop\), not a step; a bolt or arrow only through an opening/);
    });

    it('no doorway route: "no walk reaches it from here"', () => {
      host.routeTo = null;
      expect(formatObservation(api.observe())).toMatch(/ON ANOTHER FLOOR, 6 m down: no melee from here; no walk reaches it from here \(no doorway route from your floor\)/);
    });
  });

  describe('3. a fellow-aggro read after a walk to them: where they were then, and now', () => {
    it('"was 15 m SE of you 5 s ago (1 m N of you now)" (Bulwark, 14:30Z: read as the walk\'s arrival being wrong)', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 90, y: 9, z: 0 });
      host.add({ guid: 0x80007a87, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 95, y: 0, z: 0 });
      api.push('fellow-aggro', 'Dread Mu-miyah #80007a87 (level 60) is coming at your fellow Claude Arcanist, 18 m from them (running at them); Claude Arcanist is 15 m SE of you, 100% health', 0x80007a87, undefined, ARC);
      const fresh = api.waitFor({ types: ['fellow-aggro'], sinceSeq: 0 }, 10);
      vi.advanceTimersByTime(20);
      expect((await fresh)[0].text).toMatch(/Claude Arcanist is 15 m SE of you, 100% health$/);
      host.t += 5000;
      host.objs.get(ARC)!.y = 21;
      const p = api.waitFor({ types: ['fellow-aggro'], sinceSeq: 0 }, 10);
      vi.advanceTimersByTime(20);
      const later = await p;
      expect(later[0].text).toMatch(/; Claude Arcanist was 15 m SE of you 5 s ago \(10 m E of you now\), 100% health$/);
    });
  });

  describe('3. arrival at a fellow the client has let go is not "arrived"', () => {
    it('reaching where they were last placed says they are not in sight there', async () => {
      fellowship(host);
      // Last placed over a minute ago (a player standing still gets no updates).
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 40, z: 0, heardAt: -70_000 });
      const p = api.walkTo('Claude Arcanist', { within: 2 });
      run(api, host, 300);
      // Out of the client's sight on the way (a room yours can't see).
      Object.assign(host.objs.get(ARC)!, { lost: true });
      const r = await settle(api, host, p, 20_000);
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/^reached where Claude Arcanist was last placed \([\d.]+ m from that spot, \d+ s ago\), but they aren't in sight here: they moved on/);
    });
  });

  describe('5. a fellow gone from the client\'s world on the way: on to where they were last placed', () => {
    it('walk_to: "went out of sight on the way: … going to where they were last seen" (was "target vanished or not in world")', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 50, z: 0, heardAt: 0 });
      const p = api.walkTo('Claude Arcanist', { within: 2 });
      run(api, host, 500);
      host.objs.delete(ARC);
      const r = await settle(api, host, p, 30_000);
      expect(r?.message).not.toMatch(/target vanished/);
      expect(r?.message).toMatch(/^Claude Arcanist went out of sight on the way: Claude Arcanist is out of your sight \(in a dungeon you see only the rooms in sight of yours\); going to where they were last seen/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 50)).toBeLessThan(3);
    });

    it('follow: walks to the spot rather than standing out FOLLOW_LOST_MS and stopping', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 50, z: 0, heardAt: 0 });
      const p = api.follow('Claude Arcanist', { durationMs: 60_000 });
      run(api, host, 500);
      host.objs.delete(ARC);
      const r = await settle(api, host, p, 40_000);
      expect(r?.message).not.toMatch(/stopped following: Claude Arcanist went out of sight/);
      expect(r?.message).toMatch(/going to where they were last seen/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 50)).toBeLessThan(3);
    });

    it('outdoors the old answer stands (out of update range, or through a portal)', async () => {
      host.me.cell = 0xa9b40019;
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b40019, x: 80, y: 50, z: 0 });
      const p = api.walkTo('Claude Arcanist', { within: 2 });
      run(api, host, 500);
      host.objs.delete(ARC);
      const r = await settle(api, host, p, 5_000);
      expect(r?.message).toMatch(/^target vanished or not in world/);
    });
  });

  describe('5. stay_with: a fellow out of sight counts at their last placement', () => {
    it('waits for them (and says they are out of sight) rather than stopping at once "out of sight"', async () => {
      fellowship(host);
      // Placed 25 s ago 20 m behind you, in a room yours can't see.
      host.t = 30_000;
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 0, z: 0, lost: true, heardAt: 5_000 });
      const goal = { cell: UPPER, x: 80, y: 60 };
      host.add({ guid: 0x7f000001, name: 'Pillar', cell: goal.cell, x: goal.x, y: goal.y, z: 0 });
      const w = await settle(api, host, api.walkTo(0x7f000001, { stayWith: 'Claude Arcanist' }), 30_000);
      expect(w?.ok).toBe(false);
      expect(w?.message).not.toMatch(/is out of sight \(too far behind, or not a fellow\)/);
      expect(w?.message).toMatch(/Claude Arcanist is 20 m S of you \(out of sight: where they were last placed, \d+ s ago\) and hasn't moved for 1\d s/);
    });
  });

  describe('1. a slide off an edge: plan again from the floor below, and say at once when that floor leads nowhere', () => {
    it('a one-way fall (no doorway route from the lower floor) ends the walk saying so', async () => {
      host.add({ guid: 0x7f000002, name: 'Altar', cell: OTHER, x: 80, y: 60, z: 0 });
      // The doorway route reaches the altar from the upper room; from the floor below there is none.
      host.route = (fc, _f, _tc, to) => ((fc >>> 0) === UPPER ? [{ x: 80, y: 45, z: 0 }, to] : null);
      const p = api.walkTo(0x7f000002, { within: 2 });
      run(api, host, 1000);
      // The body slides off a ledge: 6 m down onto the floor below, in two ticks.
      host.me.z = -3; run(api, host, 100, { physics: false });
      host.me.z = -6; host.me.cell = LOWER; run(api, host, 100, { physics: false });
      const r = await settle(api, host, p, 2_000, () => { host.keys.delete('KeyW'); });
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/^stopped [\d.]+ m short: slid off an edge and fell 6\.0 m to the floor below \(cell 0xA9B40151\), and no way from this floor leads back to there \(no doorway route: the fall was one way\)/);
      expect(r?.message).not.toMatch(/where no drop was planned/);
    });

    it('a fall the floor below has a way on from: the walk plans again and goes on', async () => {
      host.add({ guid: 0x7f000002, name: 'Altar', cell: OTHER, x: 80, y: 60, z: -6 });
      host.route = (_fc, _f, _tc, to) => [to];
      const p = api.walkTo(0x7f000002, { within: 2 });
      run(api, host, 1000);
      host.me.z = -3; run(api, host, 100, { physics: false });
      host.me.z = -6; host.me.cell = LOWER; run(api, host, 100, { physics: false });
      const r = await settle(api, host, p, 30_000);
      expect(r?.ok).toBe(true);
      expect(r?.message).toMatch(/fell 6\.0 m where no drop was planned/);
    });
  });

  describe('1. stay_with: no one-way drop off the floor your fellow is on while they are not with you', () => {
    // The upper floor (z 100) over x 60–80; the floor below (94) everywhere; the goal down there at x 90.
    const world = (x: number, y: number): number[] => {
      if (x < 50 || x > 110 || y < 0 || y > 40) return [];
      return x >= 60 && x <= 80 ? [94, 100] : [94];
    };
    beforeEach(() => {
      host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
      host.floors = world;
      host.me.health = { current: 200, max: 200 };
    });

    it('waits at the edge until the fellow comes up, then goes down (was: down alone, the pair split)', async () => {
      fellowship(host);
      // 3 m behind you, inside the leash: she stays where she is (casting, say) while you walk on to the edge.
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 67, y: 20, z: 100 });
      host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
      const p = api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' });
      let edgeAt = 0, waited = false;
      const r = await settle(api, host, p, 60_000, () => {
        // At the edge she is 12 m back: the walk holds there (no launch) until she comes within 6 m.
        if (!edgeAt && host.me.x > 78) edgeAt = host.t;
        if (edgeAt && !waited && host.t > edgeAt + 8000) {
          waited = true;
          expect(host.launches).toHaveLength(0);
          expect(host.me.z).toBeCloseTo(100, 1);
          Object.assign(host.objs.get(ARC)!, { x: host.me.x - 2 });
        }
      });
      expect(waited, `${r?.message} at ${host.me.x.toFixed(1)},${host.me.z} t ${host.t}\n${(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.join(' ')).join('\n')}`).toBe(true);
      expect(r?.ok, r?.message).toBe(true);
      expect(host.launches.length).toBeGreaterThan(0);
      expect(host.me.z).toBeCloseTo(94, 1);
      const traces = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.join(' '));
      expect(traces.some((l) => /waiting at the edge of a 6\.0 m drop for Claude Arcanist \(1[0-3] m W\) to come up/.test(l))).toBe(true);
    });

    it('a fellow beside you: down at once', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 70, y: 21, z: 100 });
      host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
      const r = await settle(api, host, api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' }), 40_000, () => {
        const a = host.objs.get(ARC)!; a.x = host.me.x; a.y = host.me.y + 1; a.z = host.me.z;
      });
      expect(r?.ok, r?.message).toBe(true);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;

describe.skipIf(!haveDat)('the real Mountain Keep (0x01D2)', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });

  it('the pit 0x01D201FF is crossed at −6 by the deck of 0x01D20124: its west and east doorways stand on it', () => {
    expect(g.airCells!.has(C(0x1ff))).toBe(true);
    const doors = g.doors.get(C(0x1ff))!;
    const west = doors.find((d) => (d.b >>> 0) === C(0x1fb))!, east = doors.find((d) => (d.b >>> 0) === C(0x201))!;
    const deck = doors.find((d) => (d.b >>> 0) === C(0x124))!;
    expect(deck.landing).toBeCloseTo(-6, 1);
    expect(bridgeAcross(g, C(0x1ff), west, deck)).toBe(true);
    expect(bridgeAcross(g, C(0x1ff), west, east)).toBe(true);
    // Not the doorway 6 m up into the pit (0x01D202A7 above, its floor opening): that one is a fall.
    const up = doors.find((d) => (d.b >>> 0) === C(0x2a7))!;
    expect(bridgeAcross(g, C(0x1ff), west, up)).toBe(false);
  });

  it('the doorway route: 0x014F from the fountain wing with a drop and no leap (was none without a 7.1 m leap)', () => {
    const from = { x: 86, y: -46.1, z: 0 };
    const to = cellStandPoint(g, C(0x14f))!;
    const r = findRouteViaOutside(g, C(0x2a2), from, C(0x14f), to, { maxDrop: 12 })!;
    expect(r).not.toBeNull();
    expect(r.some((p) => p.leap !== undefined)).toBe(false);
    expect(r.some((p) => p.drop !== undefined)).toBe(true);
    // From the −12 hall under the pit (0x01D20127), and to the deck itself.
    expect(findRouteViaOutside(g, C(0x127), { x: 89.9, y: -67.3, z: -12 }, C(0x14f), to, { maxDrop: 12 })).not.toBeNull();
    expect(findRouteViaOutside(g, C(0x2a2), from, C(0x124), cellStandPoint(g, C(0x124))!, { maxDrop: 12 })).not.toBeNull();
  });

  it('0x02B3 and 0x0340 (the upper part, where the portal drops you) are cut off from the fountain wing but for a 7.1 m leap', () => {
    const from = { x: 86, y: -46.1, z: 0 };
    for (const t of [0x2b3, 0x340]) {
      const to = cellStandPoint(g, C(t))!;
      expect(findRouteViaOutside(g, C(0x2a2), from, C(t), to, { maxDrop: 12 })).toBeNull();
      const leap = findRouteViaOutside(g, C(0x2a2), from, C(t), to, { maxDrop: 12, jumpAcross: 9 })!;
      expect(leap.filter((p) => p.leap !== undefined).map((p) => p.leap!.toFixed(1))).toEqual(['7.1']);
    }
  });

  describe('walks through the real collision (DungeonHost; Bulwark unbuffed: Jump 191, Run 179)', () => {
    let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
    beforeAll(async () => {
      const { dungeonNav } = await import('./_harness/dungeonNav.ts');
      nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
    }, 120_000);
    const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

    it('walk_to 0x01D202B3 from the fountain: ends at once naming the leap (was 70 s of searches and six stalls, "walls all round")', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 175, max: 175 };
        try {
          const r = await host.walkTarget(C(0x2a2), { x: 86, y: -46.1, z: 0 }, '0x01D202B3', { maxMs: 120_000 });
          expect(r.ok).toBe(false);
          expect(r.message).toMatch(/^stuck [\d.]+ m short \(no walkable way from here.*; the only doorway route there leaps a 7\.1 m gap over open air \(landing \d+ m [NSEW]+ of you\), and no take-off your jump lands it from was found/);
          expect(host.traces.some((l) => /walk stall/.test(l))).toBe(false);
          expect(host.t).toBeLessThan(15_000);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);

    it('walk_to 0x01D2014F from the −12 hall: arrives over the bridge, no leap tried', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 175, max: 175 };
        try {
          const r = await host.walkTarget(C(0x127), { x: 89.9, y: -67.3, z: -12 }, '0x01D2014F', { maxMs: 240_000 });
          expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
          expect(host.me.cell).toBe(C(0x14f));
          expect(host.traces.some((l) => /jumps a [\d.]+ m gap/.test(l))).toBe(false);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);

    it('walk_to Arcanist on the −6 deck, whom the server places in 0x01D20127 (floor −12): arrives beside her, not 6 m under her', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 175, max: 175 };
        try {
          const r = await host.walk(C(0x2a6), { x: 90, y: -60, z: 0 }, { cell: C(0x127), x: 86.3, y: -67.8, z: -6, name: 'Claude Arcanist', itemType: 0x10 }, { maxMs: 120_000 });
          expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
          expect(r.message).toMatch(/^arrived/);
          expect(host.me.z).toBeCloseTo(-6, 0);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);
  });
});
