/**
 * The doll dungeon, landblock 0x0290 (end of retail, local ACE), 2026-10-16 03:23–04:24 UTC. Claude Arcanist (Jump 99,
 * Run 155) and Claude Bulwark (Jump ~185, Run ~140) played its upper floor for an hour and reported:
 *   1. "follow ended 'followed for 25 s; they are 32–35 m SE' and I hadn't moved at all, even with flee=true";
 *   2. walk_to "no walkable way" at ~11 m from Bulwark "on the same open floor";
 *   3. Bulwark's walk_to Arcanist "went in circles and stopped 5.4 m short";
 *   4. the floors 24 m and 42 m down (Innocent Dolls, Dirrich the Warden) were never on a path, and the map's "v" ledge
 *      toward them "may not really be passable".
 *
 * The real geometry (cell DAT, below): the upper floor (z 0) is two halves. The entrance half (the Exit portal
 * 0x70290053 in 0x029002C2, and 0x029002E6 / 0x02900302 / 0x02900306 where they fought) meets the rest only at the
 * rift 0x029002E7: a 10 m floorless cell between 0x029002E6 (y −165) and 0x029002E8 (y −175), the top of a shaft that
 * falls through 0x0298, 0x0235, 0x01EE, the edge slivers of 0x01B6, 0x0155 and 0x012C onto 0x010B's floor 42 m down.
 * The far half's ramps are the way down to the −24 and −42 floors on foot. No ACE portal, door or lever joins the
 * halves (ACE-World 0290.sql). So it is the dungeon: across the rift is a running jump of 10 m plus a landing, which
 * Bulwark's planner made every time (power 0.70–0.78, flights of 11.9 m) and Arcanist's could not (a full-charge
 * jump carries her ~10.1 m, landing on the far lip's edge); dropping in is 42 m, ~103 damage.
 *
 * What was wrong (page traces "[AC:Agent] walk …"): the doorway route had no notion of a leap (every route from the
 * entrance half was "no doorway route"), so Bulwark's walks to the lower floors never left the local searches; a
 * shaft's landing was "null" (unmeasured); a follow stood out its 20–25 s running the search ladder toward a leader
 * mid-leap and answered ok "followed for 25 s"; a stuck walk said only "walls all round"; the loop detector called a
 * walk to a fellow walking to meet you "in circles"; the map drew 'v' over halls 18–24 m down behind solid rock; and
 * "3m north" off the balcony 0x029002E2 became a walk to the hall 18 m under the rail (0x029001EB).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi, circledBack, type TrailPoint } from '../packages/renderer/src/agent/AgentApi.ts';
import { LEAP_LAND_M, findRouteViaOutside, loadCellGraph, routeBarrier, type CellGraph, type RouteGap } from '../packages/renderer/src/agent/cellPath.ts';
import { floorPlan } from '../packages/renderer/src/agent/navPlanner.ts';
import { jumpOptions, safeDropHeight, fallBudget } from '../packages/renderer/src/agent/jumpPlan.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const LB = 0x02900000;
const C = (n: number): number => (LB | n) >>> 0;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

/** Two halves of a floor at z 0, a rift between (y gapLo–gapHi) over a floor 42 m down; rooms of one dungeon landblock. */
const NORTH = 0xa9b40150, SOUTH = 0xa9b40160, RIFT = 0xa9b40155;
function rift(host: FakeHost, gapLo: number, gapHi: number): void {
  const inRoom = (x: number, y: number): boolean => x > 60 && x < 100 && y > 60 && y < 140;
  host.floors = (x, y) => (!inRoom(x, y) ? [] : y > gapLo && y < gapHi ? [-42] : [-42, 0]);
  host.wall = (x, y) => !inRoom(x, y);
  host.me.cell = NORTH; host.me.x = 80; host.me.y = gapHi + 4; host.me.z = 0;
  host.me.health = { current: 50, max: 50 };
}
const BUL = 0x50000004;
function leader(host: FakeHost, x: number, y: number): void {
  host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: SOUTH, x, y, z: 0 });
  host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 50, max: 50 }, mana: { cur: 10, max: 10 } }];
}
const GAP: RouteGap = { air: RIFT, from: { x: 80, y: 110, z: 0 }, to: { x: 80, y: 100, z: 0 }, width: 10, acrossToGoal: true, landing: -42, depth: 42, downToGoal: true };

describe('follow and walk across a rift no jump of yours crosses (fake host)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('follow ends early and says why: the rift, its width against your jump, its depth against your health (was ok "followed for 25 s")', async () => {
    const host = new FakeHost();
    rift(host, 100, 110);
    leader(host, 80, 92);
    host.routeBarrier = () => [GAP];
    const api = new AgentApi(host);
    const t0 = host.t;
    const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 25_000, flee: true }), 30_000);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^couldn't follow Claude Bulwark: the only way from this part of the dungeon to there is across the gap at cell 0xA9B40155: 10\.0 m of open air over a 42 m drop; your longest jump \(running, full charge\) carries about [34]\.\d m, short of the 10\.0 m plus a landing/);
    expect(r!.message).toMatch(/dropping in is a 42 m fall: about 103 damage against the 50 health you have \(it would kill you\)/);
    expect(r!.message).toMatch(/No walk or follow gets there from here.*; they are 2\d m S of you$/);
    // Said once the search that may jump found nothing, not after the whole duration.
    expect(host.t - t0).toBeLessThan(25_000);
    expect(host.me.y).toBeGreaterThan(110);
  });

  it('with no barrier known, a follow that never got moving says so (not ok "followed for 25 s")', async () => {
    const host = new FakeHost();
    rift(host, 100, 110);
    leader(host, 80, 92);
    const api = new AgentApi(host);
    const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 25_000 }), 30_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^couldn't follow Claude Bulwark: (you moved \d m in \d+ s: )?(no way to them was found from here|still searching for a way to them)/);
    expect(r!.message).toMatch(/they are 2\d m S of you/);
  });

  it('a rift your jump crosses: the follow jumps it and stands beside the leader (unchanged: ok)', async () => {
    const host = new FakeHost();
    rift(host, 103, 105.5);
    leader(host, 80, 99);
    host.routeBarrier = () => [{ ...GAP, width: 2.5 }];
    const api = new AgentApi(host);
    const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 40_000 }), 45_000);
    expect(r).toMatchObject({ ok: true });
    expect(r!.message).toMatch(/^followed Claude Bulwark for 40 s; they are \d m/);
    expect(host.me.y).toBeLessThan(103);
    expect(host.launches.length).toBeGreaterThan(0);
  });

  it('a walk stuck at the rift names it after "no walkable way"', async () => {
    const host = new FakeHost();
    rift(host, 100, 110);
    leader(host, 80, 92);
    host.routeBarrier = () => [GAP];
    const api = new AgentApi(host);
    const r = await settle(api, host, api.walkTo('Claude Bulwark'), 400_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^stuck \d+\.\d m short \(no walkable way from here/);
    expect(r!.message).toMatch(/\n {2}the only way from this part of the dungeon to there is across the gap at cell 0xA9B40155: 10\.0 m of open air over a 42 m drop/);
  }, 60_000);

  it('"3m north" off a balcony: your storey (the rail), not the hall 18 m under it, and answered at once (was 60 s of searches)', async () => {
    const host = new FakeHost();
    // The balcony 0x029002E2: floor at z 0 to y 119; the rail (solid) beyond, over a hall at z −18 (0x029001EB).
    host.floors = (x, y) => (x > 60 && x < 100 && y > 100 && y < 130 ? (y < 119 ? [-18, 0] : [-18]) : []);
    host.wall = (x, y) => !(x > 60 && x < 100 && y > 100 && y < 119);
    host.me.cell = NORTH; host.me.x = 80; host.me.y = 118; host.me.z = 0;
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    host.floorsAt = (_lb, _x, y) => (y >= 119 ? [{ cell: 0xa9b40151, z: -18 }] : [{ cell: NORTH, z: 0 }]);
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((m: unknown) => { lines.push(String(m)); });
    const api = new AgentApi(host);
    const t0 = host.t;
    const r = await settle(api, host, api.walkTo('3m north'), 120_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^stopped 3\.0 m short: no way on N from here past (where you stand|1 m) \(walls\)\. Open ways from here: /);
    expect(host.t - t0).toBeLessThan(5_000);
    // No search for the hall below (a drop through the rail).
    expect(lines.some((l) => /jumps and drops|searching wider/.test(l))).toBe(false);
    expect(host.me.z).toBe(0);
  });
});

describe('the loop detector: a goal that moved is chased, not circled (Bulwark → Arcanist, 2026-10-16)', () => {
  const trail = (goalAt: (t: number) => { x: number; y: number }): TrailPoint[] => {
    // Out 14 m north and back, every 2 s for 32 s, the goal ~10 m off at the start.
    const out: TrailPoint[] = [];
    for (let t = 0; t <= 32_000; t += 2000) {
      const y = t <= 16_000 ? (t / 16_000) * 14 : ((32_000 - t) / 16_000) * 14;
      const g = goalAt(t);
      out.push({ x: 0, y, d: Math.hypot(g.x, g.y - y), t, gx: g.x, gy: g.y });
    }
    return out;
  };
  it('a fixed goal the walk came back no nearer to: circling', () => {
    const tr = trail(() => ({ x: 10, y: 0 }));
    expect(circledBack(tr, { x: 0, y: 0.5 }, 10, { x: 10, y: 0 }, 32_000)).not.toBeNull();
  });
  it('the goal walked 9 m to meet you meanwhile: not circling', () => {
    const tr = trail((t) => ({ x: 10 - (9 * t) / 32_000, y: 0 }));
    expect(circledBack(tr, { x: 0, y: 0.5 }, 1.1, { x: 1, y: 0 }, 32_000)).toBeNull();
    // Nor is one 5 m off now that moved there from 10 m (d 5.4 against 10 then: the old test said "no nearer").
    expect(circledBack(tr, { x: 0, y: 0.5 }, 5.4, { x: 5.4, y: 0 }, 32_000)).toBeNull();
  });
  it('over its own path a storey lower (winding ramps down): not circling', () => {
    const tr = trail(() => ({ x: 10, y: 0 })).map((p) => ({ ...p, z: 0 }));
    expect(circledBack(tr, { x: 0, y: 0.5, z: -12 }, 10, { x: 10, y: 0 }, 32_000)).toBeNull();
    expect(circledBack(tr, { x: 0, y: 0.5, z: 0.3 }, 10, { x: 10, y: 0 }, 32_000)).not.toBeNull();
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('the real doll dungeon (0x0290): its rift, shaft and ramps', () => {
  let g: CellGraph;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  let mageNav: typeof nav;
  // Arcanist: Jump 99, Run 155 (burden 44%: no load penalty), health 131–155; Bulwark: Jump ~185, Run ~140.
  const MAGE_RUN = getClientRunRate(0.44, 155), BUL_RUN = getClientRunRate(0.53, 140);
  beforeAll(async () => {
    g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB);
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 185, runRate: BUL_RUN });
    mageNav = await dungeonNav(LB, { statics: true, jumpSkill: 99, runRate: MAGE_RUN });
  }, 120_000);

  it('the rift 0x029002E7 is a floorless cell between the two halves; its shaft lands on 0x010B 42 m down (was "no landing")', () => {
    expect(g.airCells!.has(C(0x2e7))).toBe(true);
    const hole = g.doors.get(C(0x2e7))!.find((d) => (d.b & 0xffff) === 0x298)!;
    expect(hole.landing).toBeCloseTo(-42, 1);
    expect(hole.landingCell).toBe(C(0x10b));
  });

  it('the doorway route: none from the entrance half without a leap (or with Arcanist\'s reach), one leap with Bulwark\'s, and on down the ramps', () => {
    const from = { x: 70, y: -148, z: 0 };
    const to = { x: 90.8, y: -186.8, z: 0 }; // Bulwark's spot in 0x0290030B (@teleloc in ACE's 0290.sql)
    const maxDrop = safeDropHeight(fallBudget({ current: 155, max: 155 }));
    expect(findRouteViaOutside(g, C(0x2e5), from, C(0x30b), to, { maxDrop })).toBeNull();
    const mageReach = AgentApi.jumpReach(mageNav.kit) - AgentApi.LEAP_MARGIN_M;
    const bulReach = AgentApi.jumpReach(nav.kit) - AgentApi.LEAP_MARGIN_M;
    expect(mageReach).toBeLessThan(10);
    expect(bulReach).toBeGreaterThan(10);
    expect(findRouteViaOutside(g, C(0x2e5), from, C(0x30b), to, { maxDrop, jumpAcross: mageReach })).toBeNull();
    const r = findRouteViaOutside(g, C(0x2e5), from, C(0x30b), to, { maxDrop, jumpAcross: bulReach })!;
    expect(r).not.toBeNull();
    const leaps = r.filter((p) => p.leap !== undefined);
    expect(leaps).toHaveLength(1);
    // Past the far lip's doorway (0x2E7 → 0x2E8 at y −175) by LEAP_LAND_M, 10 m across; the near lip's (y −165) is left out.
    expect(leaps[0].y).toBeCloseTo(-175 - LEAP_LAND_M, 1);
    expect(leaps[0].leap).toBeCloseTo(10, 1);
    expect(r.some((p) => Math.abs(p.y + 165) < 0.01 && Math.abs(p.x - 70) < 0.01)).toBe(false);
    // Down to Dirrich's floor (0x0290010B, −42) from the entrance half: across, then the far half's ramps.
    const down = findRouteViaOutside(g, C(0x2e5), from, C(0x10b), { x: 70, y: -170, z: -42 }, { maxDrop, jumpAcross: bulReach })!;
    expect(down).not.toBeNull();
    expect(down.filter((p) => p.leap !== undefined)).toHaveLength(1);
    expect(Math.min(...down.map((p) => p.feet ?? p.z))).toBeLessThan(-35);
    expect(findRouteViaOutside(g, C(0x2e5), from, C(0x10b), { x: 70, y: -170, z: -42 }, { maxDrop, jumpAcross: mageReach })).toBeNull();
  });

  it('routeBarrier names the rift from the entrance half, and nothing from the far half (its ramps walk down)', () => {
    for (const goal of [0x30b, 0x1af, 0x10b]) {
      const gaps = routeBarrier(g, C(0x2e6), C(goal))!;
      expect(gaps[0]).toMatchObject({ air: C(0x2e7), acrossToGoal: true, downToGoal: true });
      expect(gaps[0].width).toBeCloseTo(10, 1);
      expect(gaps[0].depth).toBeCloseTo(42, 1);
    }
    expect(routeBarrier(g, C(0x30b), C(0x1af))).toBeNull();
    expect(routeBarrier(g, C(0x2e6), C(0x302))).toBeNull(); // the same half
  });

  it('the jump itself: Bulwark\'s planner finds it over the rift, Arcanist\'s finds none that lands surely', () => {
    const lip = { x: 454, y: 27483, z: 0 }; // 0x029002E6's south edge (global = this collision's frame)
    const bul = jumpOptions(nav.kit, lip, { x: 0, y: -1 }, { maxDamage: 62, max: 4 }).filter((o) => Math.abs(o.to.z) < 0.5);
    expect(bul.length).toBeGreaterThan(0);
    expect(bul[0].to.y).toBeLessThan(27473);
    const mage = jumpOptions(mageNav.kit, lip, { x: 0, y: -1 }, { maxDamage: 57, max: 4 }).filter((o) => Math.abs(o.to.z) < 0.5);
    expect(mage).toHaveLength(0);
  });

  it('a walk from the entrance half: Bulwark\'s leaps the rift (one jump) and arrives in 0x0290030B; Arcanist\'s names the rift', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const dats = { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) };
      const goal = { cell: C(0x30b), x: 90.8, y: -186.8, z: 0, name: 'Claude Bulwark', itemType: 0x10 };
      const bul = new DungeonHost(nav, dats, LB);
      bul.me.health = { current: 155, max: 155 };
      try {
        const r = await bul.walk(C(0x2e5), { x: 70, y: -148, z: 0 }, goal, { within: 2, maxMs: 120_000 });
        expect(r, bul.traces.join('\n')).toMatchObject({ ok: true });
        expect(r.message).toMatch(/jumped once/);
        expect(bul.launches).toHaveLength(1);
        expect(bul.traces.some((l) => /walk leg jumps a 10\.0 m gap/.test(l))).toBe(true);
      } finally { bul.dispose(); }
      const mage = new DungeonHost(mageNav, dats, LB);
      mage.me.health = { current: 131, max: 155 };
      mage.routeBarrier = (f, t, o) => routeBarrier(g, f, t, o);
      try {
        const r = await mage.walk(C(0x2e5), { x: 70, y: -148, z: 0 }, goal, { within: 2, maxMs: 120_000 });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/^stuck [\d.]+ m short \(no walkable way/);
        expect(r.message).toMatch(/the only way from this part of the dungeon to there is across the gap at cell 0x029002E7: 10\.0 m of open air over a 42 m drop; your longest jump \(running, full charge\) carries about 10\.\d m, short of the 10\.0 m plus a landing/);
        expect(r.message).toMatch(/dropping in is a 42 m fall: about 103 damage against the 131 health you have/);
        expect(mage.launches).toHaveLength(0);
        expect(mage.me.z).toBeCloseTo(0, 1);
      } finally { mage.dispose(); }
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  }, 240_000);

  it('the map draws no ledge over halls behind rock or a balcony rail; the rift itself stays "!" (42 m)', () => {
    // The balcony 0x029002E2 where "3m north" went: its north side is solid rail over 0x029001EB, 18 m down.
    const balcony = floorPlan(mageNav.probe, { x: 454.5, y: 27519.2, z: 0 }, [], { radius: 6, jumps: { kit: mageNav.kit, maxDamage: 57 } });
    expect(balcony.lines.join('\n')).not.toMatch(/v/);
    // At the rift's north lip: the row over the rift is '!', and no 'v' beside the room over the rock either side.
    const lip = floorPlan(mageNav.probe, { x: 454, y: 27484, z: 0 }, [], { radius: 15, jumps: { kit: mageNav.kit, maxDamage: 57 } });
    expect(lip.lines.join('\n')).not.toMatch(/v/);
    expect(lip.lines[17]).toMatch(/^#+!{9}#+$/); // over the rift, 2 m south (row 15 is '@', 16 the lip)
    expect(lip.lines.join('\n')).not.toMatch(/J/); // Arcanist's jump reaches no floor across
    // Bulwark's map from the same spot marks the far lip a jump reaches (0x029002E8's edge, 11–12 m south).
    const bul = floorPlan(nav.probe, { x: 454, y: 27484, z: 0 }, [], { radius: 15, jumps: { kit: nav.kit, maxDamage: 62 } });
    expect(bul.lines.slice(26, 29).join('\n')).toMatch(/J{5,}/);
  });
});
