/**
 * How the stream players split up in Mountain Keep (dungeon landblock 0x01D2) at 20:29Z on 2026-10-17 (end-of-retail
 * local ACE, build 114eb24b; transcripts stream/sessions/{mage,soldier}-2026-10-17-seg2.jsonl 20:28–20:31Z, page traces
 * mage.log / soldier.log 20:28:30–20:31Z):
 *   1. Arcanist's `follow "Claude Bulwark"` (20:29:14) found his 6 m drop's edge in 1.0 s (20:29:30.7), then Bulwark ran on
 *      NW out of the rooms in sight of hers. The client let him go (lost) while ACE went on placing him (heard), and the
 *      follow's out-of-sight check read the client's flag alone: it stood still 10 s (FOLLOW_LOST_MS) and ended "stopped
 *      following: … went out of sight", prefixed "is 6 m below you on a lower floor; no way down to them was found". The
 *      walk_to after it took the same drop in 1.6 s (20:29:47). Follow and walk share one planner and one drop rule.
 *   2. Bulwark's stay_with walk took the drop because he asked for drop=true (every walk of his since 20:28:51): it waited
 *      at the edge until Arcanist was within STAY_WITH_DROP_TOGETHER_M ("caught up (4 m)", 20:29:22.5) and then dropped,
 *      as drop=true says. The split was item 1.
 *   3. 0x01D20340 from Arcanist's landing (0x01D20137) or 0x01D20200 is reachable on the cell DAT, but only by one route
 *      (~400 m, 100 doorways) across the 7.1 m corner leap over the pit 0x01D202A7 from the 0x02A6 side; the locked door
 *      #701d2021 (0x01D201A6) is on no route. Arcanist's buffed jump makes that leap; Bulwark's finds no take-off from the
 *      0x02A6 lip (soldier.log 20:27:33Z, 1566 points; the jump came down short at 04:22Z), yet every walk of his planned
 *      it again, 20+ times that day. A leap your own jump failed is now left out of your routes for a while, so the walk
 *      ends at once saying so.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, findRouteViaOutside, floorsAt, loadCellGraph, routeCutOff, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.ts';

const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;
const BUL = 0x500000a4, ARC = 0x50000002;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('1. a follow whose leader is out of the client\'s sight but placed by the server goes on after them', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.wall = () => false;
    host.cellSealed = (c) => ((c >>> 16) & 0xffff) === 0x01d2;
    host.me.cell = C(0x133); host.me.x = 60; host.me.y = -30; host.me.z = 0;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const fellow = (): void => {
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 196, max: 196 }, stamina: { cur: 170, max: 297 }, mana: { cur: 141, max: 141 } }];
  };

  it('lost to the client, heard all along: followed to where he is (was: stood 10 s, "went out of sight")', async () => {
    fellow();
    const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x137), x: 62, y: -30, z: 0, heardAt: 0 });
    let still = 0;
    const r = await settle(api, host, api.follow('Claude Bulwark'), 90_000, () => {
      // Off he runs NW, 20 m in 8 s, out of the rooms in sight of yours (lost) while the server places him each tick.
      Object.assign(b, { lost: host.t > 500, heardAt: host.t });
      if (b.x > 48) { b.x -= 0.18; b.y += 0.12; } else still++;
    });
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).toMatch(/^followed Claude Bulwark for \d+ s, until they stopped/);
    expect(still).toBeGreaterThan(0);
    expect(Math.hypot(host.me.x - b.x, host.me.y - b.y)).toBeLessThan(5);
  });

  it('lost and not placed since: on to where he was last placed, then the follow on from there (unchanged)', async () => {
    fellow();
    const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x137), x: 50, y: -30, z: 0, heardAt: 0 });
    const p = api.follow('Claude Bulwark', { durationMs: 40_000 });
    run(api, host, 300);
    Object.assign(b, { lost: true, heardAt: host.t - 6000 });
    const r = await settle(api, host, p, 60_000);
    expect(r?.message).toMatch(/^Claude Bulwark went out of sight on the way: /);
    expect(Math.hypot(host.me.x - 50, host.me.y + 30)).toBeLessThan(4);
  });

  it('a leader below who goes out of sight: the answer says that, not "no way down to them was found"', async () => {
    // Not a fellow (no last place to walk on to), 6 m below and near across: the follow says it is taking the way down,
    // then he vanishes. The stop is the out-of-sight one, and nothing claims the way down failed.
    // An upper floor (z 100) over x 60–80, the floor 6 m below everywhere (Holtburg's frame, as the fake's floors are):
    // he stands below, 1 m across from you.
    host.floors = (x, y) => (x < 50 || x > 110 || y < 0 || y > 40 ? [] : x >= 60 && x <= 80 ? [94, 100] : [94]);
    host.cellSealed = () => true;
    host.me.cell = 0xa9b40150; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.me.health = { current: 193, max: 193 };
    const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b40151, x: 71, y: 20, z: 94, heardAt: 0 });
    const p = api.follow('Claude Bulwark', { durationMs: 60_000 });
    run(api, host, 1500);
    expect(api.eventsSince(0).some((e) => /following: Claude Bulwark is 6 m below you .*taking the way down to them/.test((e as { text?: string }).text ?? ''))).toBe(true);
    Object.assign(b, { lost: true, heardAt: host.t - 6000 });
    const r = await settle(api, host, p, 30_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped following: Claude Bulwark went out of sight/);
    expect(r?.message).not.toMatch(/no way down to them was found/);
  });
});

describe('2. stay_with drop=true goes down with the fellow beside you, reading where they are now', () => {
  const UPPER = 0xa9b40150;
  let host: FakeHost;
  let api: AgentApi;
  // The upper floor (z 100) over x 60–80; the floor below (94) everywhere.
  const world = (x: number, y: number): number[] => {
    if (x < 50 || x > 110 || y < 0 || y > 40) return [];
    return x >= 60 && x <= 80 ? [94, 100] : [94];
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.floors = world;
    host.me.health = { current: 196, max: 196 };
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 182, max: 193 }, stamina: { cur: 268, max: 268 }, mana: { cur: 300, max: 350 } }];
    host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the fellow 16 m back on this floor: waits at the edge; once they have come up (4 m), down', async () => {
    const a = host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 62, y: 5, z: 100, heardAt: 0 });
    let droppedWithHerAt: number | null = null;
    const r = await settle(api, host, api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist', drop: true }), 60_000, () => {
      a.heardAt = host.t;
      // She stands 16 m off for 4 s, then walks up beside him.
      if (host.t > 4000) { const dx = host.me.x - 1 - a.x, dy = host.me.y - a.y, l = Math.hypot(dx, dy); if (l > 3) { a.x += (dx / l) * 0.4; a.y += (dy / l) * 0.4; } }
      if (droppedWithHerAt === null && host.launches.length) droppedWithHerAt = Math.hypot(a.x - host.me.x, a.y - host.me.y);
    });
    expect(r?.ok, r?.message).toBe(true);
    expect(host.me.z).toBeCloseTo(94, 1);
    expect(droppedWithHerAt).not.toBeNull();
    expect(droppedWithHerAt!).toBeLessThanOrEqual(AgentApi.STAY_WITH_DROP_TOGETHER_M);
  });

  it('without drop=true the same edge stops the walk (the guard of dfa53b46, unchanged)', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 70, y: 21, z: 100, heardAt: 0 });
    const r = await settle(api, host, api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' }), 40_000, () => {
      const a = host.objs.get(ARC)!; a.x = host.me.x; a.y = host.me.y + 1; a.heardAt = host.t;
    });
    expect(r?.message).toMatch(/so stay_with doesn't go down without them/);
    expect(host.launches).toHaveLength(0);
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('the real Mountain Keep (0x01D2): the split of 20:29Z', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });
  // Arcanist's landing below the drop (mage.log 20:29:53Z: (302.3, 40254.3, z −12) global), where her walk stalled in
  // 0x01D20200 (20:30:01Z: (292.3, 40270.0, z −8.76)), and Bulwark's spot in the fountain wing 0x01D202A6.
  const LANDING = { x: 110.3, y: -65.7, z: -12 }, STALL = { x: 100.3, y: -50, z: -8.76 };
  const LOCKED_DOOR = { x: 64.75, y: -60, z: -6 }; // #701d2021 in 0x01D201A6 (ACE-World-16PY 01D2.sql), weenie 1298
  /** The 7.1 m corner leap from 0x02A6's doorway into the pit 0x02A7 to 0x029D's: its route point, past the far lip. */
  const LEAP_WEST = { x: 83.9, y: -71.1, z: 0 };

  it('3. the landing cells: 0x01D20137 at −12 under the drop, 0x01D20200 on the ramp', () => {
    expect(floorsAt(g, LANDING.x, LANDING.y).map((f) => f.cell)).toContain(C(0x137));
    expect(floorsAt(g, STALL.x, STALL.y).map((f) => f.cell)).toContain(C(0x200));
  });

  it('3. 0x01D20340 from there: one route, ~400 m by 90+ doorways, only across the 7.1 m leap; the locked door is on no route', () => {
    const to = cellStandPoint(g, C(0x340))!;
    for (const [cell, at] of [[C(0x137), LANDING], [C(0x200), { ...STALL, z: -8.8 }]] as const) {
      expect(findRouteViaOutside(g, cell, at, C(0x340), to, { maxDrop: 12 })).toBeNull();
      const r = findRouteViaOutside(g, cell, at, C(0x340), to, { maxDrop: 12, jumpAcross: 7.5 })!;
      expect(r).not.toBeNull();
      expect(r.length).toBeGreaterThan(90);
      expect(r.filter((p) => p.leap !== undefined).map((p) => p.leap!.toFixed(1))).toEqual(['7.1']);
      const leap = r.find((p) => p.leap !== undefined)!;
      expect(Math.hypot(leap.x - LEAP_WEST.x, leap.y - LEAP_WEST.y)).toBeLessThan(1);
      let len = 0;
      for (let i = 1; i < r.length; i++) len += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y, r[i].z - r[i - 1].z);
      expect(len).toBeGreaterThan(300);
      // The locked door: closing it changes nothing.
      const shut = findRouteViaOutside(g, cell, at, C(0x340), to, { maxDrop: 12, jumpAcross: 7.5, closed: [LOCKED_DOOR] })!;
      expect(shut.length).toBe(r.length);
      // That leap left out (noLeapTo): no route, and cut off.
      expect(findRouteViaOutside(g, cell, at, C(0x340), to, { maxDrop: 12, jumpAcross: 7.5, noLeapTo: [LEAP_WEST] })).toBeNull();
      expect(routeCutOff(g, cell, at, C(0x340), to, { maxDrop: 12, jumpAcross: 7.5, noLeapTo: [LEAP_WEST] })).not.toBeNull();
      expect(routeCutOff(g, cell, at, C(0x340), to, { maxDrop: 12, jumpAcross: 7.5 })).toBeNull();
    }
  });

  it('3. noLeapTo leaves out that direction only: the leap the other way (0x029D → 0x02A6) still routes', () => {
    const from = cellStandPoint(g, C(0x29d))!, to = cellStandPoint(g, C(0x2a6))!;
    const r = findRouteViaOutside(g, C(0x29d), from, C(0x2a6), to, { maxDrop: 0, jumpAcross: 7.5, noLeapTo: [LEAP_WEST] });
    expect(r?.some((p) => p.leap !== undefined)).toBe(true);
    expect(findRouteViaOutside(g, C(0x2a6), to, C(0x29d), from, { maxDrop: 0, jumpAcross: 7.5, noLeapTo: [LEAP_WEST] })?.some((p) => p.leap !== undefined) ?? false).toBe(false);
  });

  describe('walks through the real collision (DungeonHost)', () => {
    let navMage: DungeonNav;
    let navSoldier: DungeonNav;
    beforeAll(async () => {
      const { dungeonNav } = await import('./_harness/dungeonNav.ts');
      // Arcanist buffed (Jump and Run about 200), Bulwark (Jump 191, Run 179), as the earlier Mountain Keep tests.
      navMage = await dungeonNav(LB, { statics: true, jumpSkill: 230, runRate: getClientRunRate(0.5, 200) });
      navSoldier = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
    }, 240_000);
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

    it('1. follow Bulwark down his 6 m drop while he runs on NW out of her sight (heard): she drops and reaches him below', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(navMage, dats(), LB, { rooms: true });
      host.me.health = { current: 178, max: 193 };
      host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 196, max: 196 }, stamina: { cur: 170, max: 297 }, mana: { cur: 141, max: 141 } }];
      // Landed under the drop (soldier.log 20:29:30.06Z: (302.4, 40254.5, z −12)), then NW along the −11 floor to the
      // doorway at (90, −55) (soldier.log 20:29:30–20:29:36Z), out of the rooms in sight of hers.
      const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x137), x: 110.4, y: -65.5, z: -12, heardAt: 0 });
      const path = [{ x: 105, y: -67 }, { x: 100, y: -65 }, { x: 95, y: -60 }, { x: 90, y: -56 }];
      try {
        // Arcanist on the −6 floor above, beside the opening (mage.log 20:29:30.7Z: its edge at (305.7, 40251.8)).
        const r = await host.run(C(0x133), { x: 113.7, y: -68.2, z: -6 }, (api) => api.follow('Claude Bulwark'), {
          maxMs: 120_000,
          each: () => {
            b.heardAt = host.t;
            if (host.t > 1500) {
              b.lost = true;
              const n = path[0];
              if (n) { const dx = n.x - b.x, dy = n.y - b.y, l = Math.hypot(dx, dy); if (l < 0.5) path.shift(); else { b.x += (dx / l) * 0.4; b.y += (dy / l) * 0.4; } }
              const f = floorsAt(g, b.x, b.y).sort((p, q) => Math.abs(p.z - b.z) - Math.abs(q.z - b.z))[0];
              if (f) { b.cell = f.cell; b.z = f.z; }
            }
          },
        });
        expect(r.ok, `${r.message}\n${host.traces.slice(-30).join('\n')}`).toBe(true);
        expect(r.message).not.toMatch(/went out of sight|no way down/);
        expect(host.traces.some((l) => /walk drop 6\.0 m/.test(l))).toBe(true);
        expect(host.me.z).toBeLessThan(-8);
        expect(Math.hypot(host.me.x - b.x, host.me.y - b.y)).toBeLessThan(6);
      } finally { host.dispose(); }
    }, 240_000);

    it('3. Arcanist\'s jump makes the leap: walk_to 0x01D20340 from her landing arrives by the one long route', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(navMage, dats(), LB, { rooms: true });
      host.me.health = { current: 182, max: 193 };
      try {
        const r = await host.walkTarget(C(0x137), LANDING, '0x01D20340', { maxMs: 300_000 });
        expect(r.ok, `${r.message}\n${host.traces.slice(-20).join('\n')}`).toBe(true);
        expect(host.me.cell).toBe(C(0x340));
        expect(host.traces.some((l) => /walk leg jumps a 7\.1 m gap/.test(l))).toBe(true);
      } finally { host.dispose(); }
    }, 300_000);

    it('3. Bulwark\'s doesn\'t: the first walk finds no take-off and says so; the next ends at once, the leap named (was: planned again every walk)', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(navSoldier, dats(), LB, { rooms: true });
      host.me.health = { current: 196, max: 196 };
      const at = cellStandPoint(g, C(0x2a6))!;
      try {
        const r1 = await host.walkTarget(C(0x2a6), at, '0x01D20340', { maxMs: 120_000 });
        expect(r1.ok).toBe(false);
        expect(r1.message).toMatch(/the only doorway route there leaps a 7\.1 m gap over open air \(landing \d+ m [NSEW]+ of you\), and no take-off your jump lands it from was found/);
        expect(host.traces.some((l) => /remembering the 7\.1 m leap to \(275\.9, 40248\.9\) as one your jump doesn't make \(no take-off found\)/.test(l))).toBe(true);
        host.traces.length = 0;
        const t0 = host.t;
        const r2 = await host.walkTarget(C(0x2a6), at, '0x01D20340', { maxMs: 120_000, sameApi: true });
        expect(r2.ok).toBe(false);
        expect(r2.message).toMatch(/^stopped [\d.]+ m short: no way on foot from this part of the dungeon to there: .*the doorway route there needs a 7\.1 m leap over open air, and your jump didn't make it \d+ min ago \(no take-off for it was found from this side\), so it is left out for now/);
        expect(host.t - t0).toBeLessThan(2000);
        expect(host.traces.some((l) => /walk leg jumps|walk search/.test(l))).toBe(false);
      } finally { host.dispose(); }
    }, 300_000);
  });
});
