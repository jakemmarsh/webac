/**
 * Stream movement reports from Hollow Lair (landblock 0x039C), end of retail, 2026-10-16 04:24–05:21Z (Claude Arcanist /
 * Claude Bulwark; transcripts stream/sessions/{mage,soldier}-2026-10-16-seg2.jsonl, page traces mage.log / soldier.log).
 *
 * 1. walk_to a Tusker in the pit "within=25" ran down the ramp into it (0x039C018C → 0x0109), ending 21.5 m off: the
 *    arrival needed the target's floor (|dz| < 2.5) and the pit is 12 m down. A within of RANGED_WITHIN_M or more is now
 *    a range: the straight distance, floors and all, and the answer says whether the line to it is open.
 * 2. follow / walk_to toward Bulwark took Arcanist down into the pit's pack (0x039C019B). Indoors a walk_to (avoid_monsters)
 *    or a follow (stop_on_aggro) now stops before it comes within ACE's 18 m wake range of two or more monsters not yet
 *    awake, naming them (and before a drop that lands among them).
 * 3. walk_to "20m east" from 0x039C018C "went round in circles" for 34 s: the body ran 8 m between two ticks, either
 *    side of a goal 4 m off (stalls at 662.0 and 670.1 round 666.1), and the stall's replan routed back three doorways
 *    to the start cell, because the point (0.6 m past the corridor floor's edge) had no room under it. Arrival is now
 *    judged along the stretch run since the last tick, and an offset point next to a floor is that floor's room.
 * 4. walk_to target="0x039C0104" said "target vanished": a cell id of your landblock is now that room; an id nothing
 *    answers to says so at once.
 * 5. walk_to stay_with stopped "hasn't moved for 12 s" whenever Arcanist stood casting: a fellow heard casting (or with
 *    monsters on them) is waited for quietly, and one standing back within the leash has stopped beside you.
 * 6. walk_to "Exit" took the doll dungeon's straight-nearest Exit across the rift: of several of a name, the one a walk
 *    reaches, nearest by the doorway route (walk_to and use).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, floorsAt, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ARCANIST = 0x50000002;
const vitals = { cur: 40, max: 50 };
const ROOM = 0xa9b40105; // an interior cell of the fake host's landblock (a dungeon's, with cellSealed)

/** Run the page's ticks every `tick` ms until the promise settles (or `ms` pass); `each` runs before every tick. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, opts: { tick?: number; each?: () => void } = {}): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  const tick = opts.tick ?? 100;
  for (let t = 0; t < ms && !done; t += tick) {
    opts.each?.();
    host.t += tick;
    vi.advanceTimersByTime(tick);
    host.physics(tick);
    api.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  return out;
}

describe('Hollow Lair movement reports (fake host)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const dungeon = (): void => {
    host.me.cell = ROOM;
    host.cellSealed = () => true;
  };
  const monster = (guid: number, name: string, x: number, y: number, z: number, level = 30) =>
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x, y, z, level });

  describe('1. within= a range: the straight distance, floors and all', () => {
    it('a Tusker 12 m down in a pit, within=25: arrives 25 m off it up top, not down on its floor (was 21.5 m, in the pit)', async () => {
      const t = monster(0x8000fa14, 'Goldenback Tusker', 80, 60, 94 - 12);
      const r = await settle(api, host, api.walkTo(t.guid, { within: 25 }), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^arrived \(2[45]\.\d m away, 12 m above it\)/);
      const flat = 60 - host.me.y;
      // sqrt(25² − 12²) = 21.9 m across: stopped there (a tick's 0.4 m), not walked on to its floor.
      expect(flat).toBeGreaterThan(21.4);
      expect(flat).toBeLessThan(22.4);
    });

    it('says when the line from there is blocked, and where it opens', async () => {
      const t = monster(0x8000fa14, 'Goldenback Tusker', 80, 60, 94 - 12);
      host.lineOfFire = () => ({ dist: 25, blockedAt: 3.2, blocker: 'the ceiling' });
      host.lineOfFireOpenSpot = () => ({ dx: 3, dy: 0, dist: 3 });
      const r = await settle(api, host, api.walkTo(t.guid, { within: 25 }), 30_000);
      expect(r!.ok).toBe(true);
      expect(r!.message).toMatch(/no open line to it from here \(the ceiling 3\.2 m along the line would take a bolt or arrow\); the line is open from 3 m east of here \(walk_to "3m east"\)/);
    });

    it('a short within (beside it) still needs its floor: no "arrived" from overhead', async () => {
      const t = host.add({ guid: 0x7f000001, name: 'Lever', cell: host.me.cell, x: 80, y: 40, z: 94 - 12 });
      const r = await settle(api, host, api.walkTo(t.guid, { within: 2 }), 12_000);
      expect(r?.ok ?? false).toBe(false);
    });
  });

  describe('3. arrival along the stretch run since the last tick', () => {
    it('"20m east" with 8 m between ticks: arrives as it runs past (was a 30 s hop either side of it, then "in circles")', async () => {
      const r = await settle(api, host, api.walkTo('20m east'), 120_000, { tick: 2000 });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^arrived \(4\.0 m away, run past it a little/);
      expect(traces.some((l) => /stall/.test(l))).toBe(false);
      expect(host.keys.has('KeyW')).toBe(false);
    });

    it('a follow at 8 m between ticks stands beside the leader as it runs past (was a hop either side of them)', async () => {
      host.add({ guid: ARCANIST, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 32.5 });
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Bulwark', health: vitals, stamina: vitals, mana: vitals }];
      let stoodTicks = 0;
      const r = await settle(api, host, api.follow(ARCANIST, { within: 1.5, durationMs: 20_000 }), 30_000, { tick: 2000, each: () => { if (host.t > 6000 && !host.keys.has('KeyW')) stoodTicks++; } });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^followed Claude Bulwark for 2\d s/);
      // Standing beside him from the first pass on (the old follow ran 28 ↔ 36 either side of him the whole 20 s).
      expect(stoodTicks).toBeGreaterThanOrEqual(5);
    });

    it('the same at 10 ticks a second: arrives within 2 m as before', async () => {
      const r = await settle(api, host, api.walkTo('20m east'), 30_000);
      expect(r!.message).toMatch(/^arrived \(\d\.\d m away\)$/);
    });

    it('an offset just off a corridor floor\'s edge is that floor\'s room, not the cell you started in', async () => {
      dungeon();
      host.me.y = 20.6;
      // A corridor floor for y 17–20 (the wall margin beyond): cell 0x0105 west of x 90, 0x0106 east of it.
      host.floorsAt = (_lb, x, y) => (y >= 17 && y <= 20 && x >= 60 && x <= 110 ? [{ cell: x < 90 ? 0xa9b40105 : 0xa9b40106, z: 94 }] : []);
      const asked: number[] = [];
      host.route = (_fc, _f, tc, to) => { asked.push(tc >>> 0); return [to]; };
      const r = await settle(api, host, api.walkTo('20m east'), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((c) => c === 0xa9b40106)).toBe(true);
    });
  });

  describe('4. a cell id is a room; an unknown id says so', () => {
    beforeEach(() => {
      dungeon();
      host.cellPoint = (c: number) => (c === 0xa9b40107 ? { x: 90, y: 30, z: 94 } : null);
    });
    it('walk_to 0xA9B40107 walks to the floor in its middle (was "target vanished")', async () => {
      const r = await settle(api, host, api.walkTo(0xa9b40107), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^arrived/);
      expect(Math.hypot(host.me.x - 90, host.me.y - 30)).toBeLessThan(2.1);
      const r2 = await settle(api, host, api.walkTo('0xA9B40107'), 5000);
      expect(r2!.ok).toBe(true);
    });
    it('a cell with no floor, an id nothing answers to: said at once', async () => {
      expect(await api.walkTo(0xa9b40199)).toMatchObject({ ok: false, message: expect.stringMatching(/^walking to cell 0xA9B40199: no floor in that cell/) });
      expect(await api.walkTo(0x8000fe1a)).toMatchObject({ ok: false, message: expect.stringMatching(/^no object #8000fe1a in view or remembered/) });
    });
  });

  describe('2. indoors, stop short of a pack not yet awake', () => {
    beforeEach(() => {
      dungeon();
      monster(0x8000f89b, 'Goldenback Tusker', 78, 60, 82);
      monster(0x8000fe8a, 'Drudge Lurker', 82, 62, 82, 40);
      monster(0x8000ffdb, 'Drudge Lurker', 80, 64, 82, 40);
    });
    it('walk_to past the pit stops ~22 m from them, naming them (avoid_monsters=false walks on)', async () => {
      const r = await settle(api, host, api.walkTo('45m north', { avoidMonsters: true, stopOnAggro: true }), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/: going on brings you within 18 m of 2 monsters not awake yet: Goldenback Tusker L30 2\d m N \(12 m down\), Drudge Lurker L40/);
      expect(r!.message).toMatch(/walk_to with avoid_monsters=false/);
      // The second of them comes within 22 m (straight, 12 m down) at y ≈ 43.6; checked every 0.4 s at 4 m/s.
      expect(host.me.y).toBeLessThan(45.5);
      expect(host.me.y).toBeGreaterThan(41);
      const on = await settle(api, host, api.walkTo('20m north', { avoidMonsters: false, stopOnAggro: true }), 30_000);
      expect(on!.message).not.toMatch(/not awake/);
    });
    it('monsters under half your level are no pack: a level-90 walks past the L30/L40 pit without stopping', async () => {
      host.me.level = 90;
      const r = await settle(api, host, api.walkTo('45m north', { avoidMonsters: true, stopOnAggro: true }), 30_000);
      expect(r!.message).not.toMatch(/not awake/);
    });
    it('at level 70 the L30 Tusker no longer counts but the two L40 Lurkers still make a pack', async () => {
      host.me.level = 70;
      const r = await settle(api, host, api.walkTo('45m north', { avoidMonsters: true, stopOnAggro: true }), 30_000);
      expect(r!.message).toMatch(/within 18 m of 2 monsters not awake yet: Drudge Lurker L40/);
      expect(r!.message).not.toMatch(/Tusker/);
    });
    it('on a GDLE-family server (monsters notice you from 40 m: MonsterAI DEFAULT_AWARENESS_RANGE) it stops ~44 m off', async () => {
      host.fallFamily = 'gdle';
      host.me.y = 0;
      const r = await settle(api, host, api.walkTo('45m north', { avoidMonsters: true, stopOnAggro: true }), 30_000);
      expect(r!.message).toMatch(/within 40 m of 2 monsters not awake yet/);
      expect(host.me.y).toBeGreaterThan(17);
      expect(host.me.y).toBeLessThan(22);
    });
    it('a follow toward a fellow beside them stops too (stop_on_aggro=false follows on)', async () => {
      host.add({ guid: ARCANIST, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 58, z: 82 });
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Bulwark', health: vitals, stamina: vitals, mana: vitals }];
      const r = await settle(api, host, api.follow(ARCANIST, { within: 4, durationMs: 30_000, stopOnAggro: true }), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/^stopped following Claude Bulwark, [\d.]+ m from them: going on brings you within 18 m of \d monsters not awake yet/);
      expect(r!.message).toMatch(/follow with stop_on_aggro=false/);
    });
    it('monsters already that near when the walk began are known: no stop for them', async () => {
      host.me.y = 45; // 15–19 m from them already
      const r = await settle(api, host, api.walkTo('8m south', { avoidMonsters: true, stopOnAggro: true }), 15_000);
      expect(r!.message).toMatch(/^arrived/);
    });
    it('outdoors it never stops for them (the outdoor walk goes round monsters instead)', async () => {
      host.me.cell = 0xa9b40019;
      for (const o of host.objs.values()) o.cell = 0xa9b40019;
      const r = await settle(api, host, api.walkTo('20m north', { stopOnAggro: true }), 30_000);
      expect(r!.message).not.toMatch(/not awake/);
    });
  });

  describe('5. stay_with: a fellow busy casting is waited for quietly', () => {
    beforeEach(() => {
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 18 });
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
    });
    it('she stands 40 s buffing (her spell words every 3 s), then comes: the walk waits and goes on (was "hasn\'t moved for 12 s")', async () => {
      let n = 0;
      const her = (): void => {
        n++;
        if (host.t < 40_000) { if (n % 30 === 0) api.pushChat('Claude Arcanist says, "Malar Aetak"', 0x11); return; }
        host.objs.get(ARCANIST)!.y += 0.5;
      };
      const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 200_000, { each: her });
      const log = traces.filter((t) => /walk:/.test(t)).join('\n');
      expect(r, log).toMatchObject({ ok: true });
      expect(r!.message).not.toMatch(/hasn't moved/);
      expect(log).toMatch(/Claude Arcanist is casting; waiting on/);
    });
    it('without her spell words, standing 13 s is still "hasn\'t moved"', async () => {
      const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 60_000);
      expect(r!.message).toMatch(/hasn't moved for 1\d s/);
    });
    it('she comes to 8 m back and stands there (inside the 15 m leash): the walk goes on (was "hasn\'t moved")', async () => {
      let stopAt: number | null = null;
      let stoodAt: number | null = null;
      let waited = false;
      const her = (): void => {
        const a = host.objs.get(ARCANIST)!;
        if (!host.keys.has('KeyW') && host.me.y > 40) waited = true;
        if (waited && stopAt === null) stopAt = host.me.y - 8;
        if (stopAt === null) { a.y += 0.25; return; }
        if (a.y < stopAt) { a.y = Math.min(a.y + 0.4, stopAt); return; }
        stoodAt ??= host.t;
        if (host.t - stoodAt > 6000) a.y += 0.38; // then she runs on after you
      };
      const r = await settle(api, host, api.walkTo('70m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000, { each: her });
      const log = traces.filter((t) => /walk:/.test(t)).join('\n');
      expect(r, log).toMatchObject({ ok: true });
      expect(log).toMatch(/Claude Arcanist caught up \(8 m\); on/);
    });
  });

  describe('6. of several of a name, the one a walk reaches', () => {
    const NEAR = 0x7a9b4001, FAR = 0x7a9b4002;
    beforeEach(() => {
      dungeon();
      // The straight-nearest Exit is across a rift (no doorway route); the other is a 60 m walk.
      host.add({ guid: NEAR, name: 'Exit', itemType: 0x10000, objectDescFlags: 0x40000, cell: 0xa9b40110, x: 80, y: 55, z: 94 });
      host.add({ guid: FAR, name: 'Exit', itemType: 0x10000, objectDescFlags: 0x40000, cell: 0xa9b40120, x: 80, y: -40, z: 94 });
      host.route = (_fc, _f, tc, to) => ((tc >>> 0) === 0xa9b40120 ? [to] : null);
    });
    it('walk_to "Exit" takes the reachable one (was the straight-nearest across the rift)', async () => {
      const r = await settle(api, host, api.walkTo('Exit'), 60_000);
      expect(traces.some((l) => /Exit #7a9b4001 is out of reach on foot \(no doorway route\); taking #7a9b4002 of that name, a 60 m way/.test(l)), traces.join('\n')).toBe(true);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(host.me.y).toBeLessThan(-30);
    });
    it('an id is that object, reachable or not', async () => {
      void api.walkTo(NEAR);
      expect(traces.some((l) => /taking #/.test(l))).toBe(false);
    });
    it('use "Exit" goes to the reachable one too', async () => {
      const p: Promise<AgentResult> = api.use('Exit');
      await settle(api, host, p, 3000);
      expect(traces.some((l) => /taking #7a9b4002/.test(l))).toBe(true);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x039c0000;
const C = (c: number): number => (LB | c) >>> 0;

describe.skipIf(!haveDat)('the real Hollow Lair (0x039C): its corridor, ramp and pit', () => {
  let g: CellGraph;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB);
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 185, runRate: 2.8 });
  }, 120_000);

  const host = async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    return new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
  };

  it('the "20m east" point (0x039C019C) is 0.6 m past the corridor floor\'s edge; the cell 0x039C0104 has a floor in its middle', () => {
    expect(floorsAt(g, 90.1, -131.8)).toEqual([]);
    expect(floorsAt(g, 90.1, -131.2).map((f) => f.cell)).toEqual([C(0x19c)]);
    const p = cellStandPoint(g, C(0x104))!;
    expect(p).not.toBeNull();
    expect(floorsAt(g, p.x, p.y).some((f) => f.cell === C(0x104) && Math.abs(f.z - p.z) < 0.05)).toBe(true);
  });

  it('walk_to "20m east" from 0x039C018C arrives, at 10 ticks a second and at one every 2 s (was "in circles", 34 s)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const tickMs of [100, 2000]) {
        const h = await host();
        try {
          const r = await h.walkTarget(C(0x18c), { x: 70.1, y: -131.2, z: -6 }, '20m east', { tickMs, maxMs: 90_000 });
          expect(r, `${tickMs} ms ticks\n${h.traces.join('\n')}`).toMatchObject({ ok: true });
          expect(r.message).toMatch(/^arrived/);
          expect(h.me.cell).toBe(C(0x19c));
          // Never a stall, never back over its own track (the stall's replan used to route west to the start cell).
          expect(h.traces.some((l) => /walk stall|back at|in circles/.test(l)), h.traces.join('\n')).toBe(false);
        } finally { h.dispose(); }
      }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 120_000);

  it('walk_to a Tusker in the pit within=30 from the corridor stops part way down the ramp, 30 m off it (was 21.6 m, at the ramp\'s foot)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const pit = floorsAt(g, 70, -176).sort((a, b) => a.z - b.z)[0];
      expect(pit.z).toBeLessThan(-15);
      const h = await host();
      try {
        const r = await h.walk(C(0x18c), { x: 72.4, y: -130.5, z: -6 }, { cell: pit.cell, x: 70, y: -176, z: pit.z, name: 'Goldenback Tusker' }, { within: 30, maxMs: 90_000 });
        expect(r, h.traces.join('\n')).toMatchObject({ ok: true });
        const d3 = Math.hypot(h.me.x - 70, h.me.y + 176, h.me.z - pit.z);
        expect(d3).toBeLessThanOrEqual(30.6);
        expect(d3).toBeGreaterThan(28);
        // Up the ramp (it falls 12 m over 18 m to the pit's floor), not at its foot where the floor rule let it stop.
        expect(h.me.z).toBeGreaterThan(pit.z + 3.5);
        expect(r.message).toMatch(/m above it\)/);
      } finally { h.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 120_000);

  it('walk_to target=0x039C0104 walks down into that room (was "target vanished")', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const h = await host();
      try {
        const r = await h.walkTarget(C(0x18c), { x: 72.4, y: -130.5, z: -6 }, C(0x104), { maxMs: 120_000 });
        expect(r, h.traces.join('\n')).toMatchObject({ ok: true });
        expect(h.me.cell).toBe(C(0x104));
      } finally { h.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 150_000);
});
