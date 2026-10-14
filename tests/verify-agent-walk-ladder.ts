/**
 * The walk to the Mannikin Foundry portal at the Holtburg drudge statue (stream rehearsals, 2026-10-13): the cell
 * route goes through the pedestal's doorway, where the Pedestal Weak Spot stands, and no walk gets into it. The walk
 * ran its whole ladder of searches toward that doorway (the box, wider, with jumps and drops), went to open the
 * pedestal, and then ran the same ladder again, 6–12 searches and up to 105 s standing still, before the wide search
 * straight for the goal found the way in 16 points. Now a leg whose ladder found no way once is not searched again:
 * after the door detour the walk goes wide at once (AgentApi.LEG_LADDER_RERUNS).
 *
 * Why every search there failed (the real A9B4 DATs, below): the cell router took the tunnel's real way in (cell
 * 0x177's outside portal, 1.79 m tall) for a window, and routed through the statue's other opening, its sill at z 68,
 * 2 m over the town's ground, which no search reaches ("none after 1829 points", the rehearsal's 1827). The router now
 * tries a slightly low opening on the ground before a doorway no walk reaches (cellPath LOW_DOOR_MIN_M), and every leg
 * of the route is found.
 *
 * Real AgentApi on the fake host (tests/_harness/agentFake.ts) with its floors world (so jumps and drops are
 * searched too), its walls as the pedestal, and a cell router that only knows the blocked doorway.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { PathSearch, type NavPoint } from '../packages/renderer/src/agent/navPlanner.ts';
import type { RoutePoint } from '../packages/renderer/src/agent/cellPath.ts';
import type { MovementServices } from '../packages/renderer/src/player/OutdoorMovement.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS } from './_harness/dat.ts';

const PIT = 0xa9b40176; // the pedestal's interior cell, as the rehearsal's route trace named it
const PEDESTAL = 0x7a9b4044;
const STATUE = 0x8000a001;

/** The walk to the statue below the pedestal, timed in fake ms; with the trace's lines. */
async function walkToStatue(reruns: number): Promise<{ ok: boolean; ms: number; lines: string[]; uses: number; at: { x: number; y: number } }> {
  const host = new FakeHost();
  const api = new AgentApi(host);
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
  const before = AgentApi.LEG_LADDER_RERUNS;
  AgentApi.LEG_LADDER_RERUNS = reruns;
  try {
    host.floors = () => [94];
    host.me.x = 80; host.me.y = 20; host.me.z = 94;
    // An east–west wall at y 40 with a gap far to the east, and the pedestal's plinth standing in the doorway.
    host.wall = (x, y) => (Math.abs(y - 40) < 0.4 && x > 40 && x < 120 && !(x > 110 && x < 113)) || Math.hypot(x - 80, y - 41) < 1.2;
    const door = host.add({ guid: PEDESTAL, name: 'Pedestal Weak Spot', objectDescFlags: 0x1000, physicsState: 0, x: 80, y: 39.3 });
    host.add({ guid: STATUE, name: 'Bronze Statue of a Drudge', itemType: 0x10, cell: PIT, x: 80, y: 60 });
    // The cell graph's way in is the pedestal's doorway; with it left out (a door that would not open) there is none.
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, o?: { closed?: unknown[] }) =>
      (o?.closed?.length ? null : [{ x: 80, y: 40.5, z: 94 }, to])) as typeof host.route;
    const use = host.use;
    // The pedestal opens (ethereal) to a Use, but its plinth still fills the doorway.
    host.use = (g: number) => { if (g === PEDESTAL) door.physicsState = 0x4; return use(g); };
    let done: { ok: boolean } | null = null;
    const p = api.walkTo('Bronze Statue of a Drudge', { within: 1.5, timeoutMs: 600_000 }).then((r) => { done = r; return r; });
    const t0 = host.t;
    for (let i = 0; i < 6000 && !done; i++) { run(api, host, 100); await Promise.resolve(); }
    const r = await Promise.race([p, Promise.resolve(null)]);
    return { ok: !!r?.ok, ms: host.t - t0, lines, uses: host.sent.filter((s) => s === `use ${PEDESTAL.toString(16)}`).length, at: { x: host.me.x, y: host.me.y } };
  } finally {
    AgentApi.LEG_LADDER_RERUNS = before;
    vi.restoreAllMocks();
  }
}

describe('a leg whose searches all found no way is not searched again (the Foundry pedestal, 2026-10-13)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('after the door detour the walk goes wide at once: fewer failed searches, sooner there', async () => {
    const old = await walkToStatue(Infinity);
    const now = await walkToStatue(0);
    const failed = (ls: string[]) => ls.filter((l) => /walk search none/.test(l)).length;
    // Both get there, through the gap; the pedestal is opened once either way (the door detour stays).
    expect(old.ok).toBe(true);
    expect(now.ok).toBe(true);
    expect(Math.hypot(now.at.x - 80, now.at.y - 60)).toBeLessThan(2);
    expect(old.uses).toBe(1);
    expect(now.uses).toBe(1);
    // The old order ran the doorway's ladder twice; now once, then the wide search.
    expect(failed(old.lines)).toBeGreaterThanOrEqual(2 * failed(now.lines));
    expect(failed(now.lines)).toBeGreaterThanOrEqual(2);
    expect(now.lines.some((l) => /every search toward \(\d+\.\d, \d+\.\d\) already found no way; searching wide straight for the goal, jumps and drops included \(\d+\.\d s into the walk\)/.test(l))).toBe(true);
    // The trace says how long each search stood, and when.
    expect(now.lines.some((l) => /walk search none after \d+ points in \d+\.\d s \(\d+\.\d s into the walk\)/.test(l))).toBe(true);
    // Standing time is search work: the fake host searches a whole ladder within a few 100 ms ticks, the game at
    // 6–25 ms a frame, about 4.5 ms a point at the pedestal (22,400 points in the 105 s walk). So the points
    // searched in vain are the measure; the fake clock's arrival must not be later either.
    const points = (ls: string[]) => ls.map((l) => /walk search none after (\d+) points/.exec(l)).reduce((a, m) => a + (m ? Number(m[1]) : 0), 0);
    expect(points(now.lines)).toBeLessThan(points(old.lines) * 0.6);
    expect(now.ms).toBeLessThanOrEqual(old.ms);
    process.stdout.write(`pedestal walk: old order ${failed(old.lines)} failed searches, ${points(old.lines)} points, ${(old.ms / 1000).toFixed(1)} s; now ${failed(now.lines)}, ${points(now.lines)} points, ${(now.ms / 1000).toFixed(1)} s\n`);
  }, 120_000);
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('the real pedestal doorway (A9B4, the drudge statue → Mannikin Foundry Portal in cell 0x176)', () => {
  let OX = 0, OY = 0;
  let route: RoutePoint[] | null = null;
  let oldRoute: RoutePoint[] | null = null;
  let probe: (from: NavPoint, to: { x: number; y: number }) => NavPoint;
  let ground: (x: number, y: number) => number;
  const PORTAL = { x: 78.97, y: 157, z: 60.8 }; // world DB landblock_instance 0x7A9B404A
  const START = { x: 61, y: 145 }; // on the town's grass south of the statue

  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.ts');
    const { openDat } = await import('./_harness/dat.ts');
    const { loadCellGraph, findRouteViaOutside } = await import('../packages/renderer/src/agent/cellPath.ts');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.ts');
    const { outdoorGroundY } = await import('../packages/renderer/src/world/outdoorGround.ts');
    const { stepPlayerMovement } = await import('../packages/renderer/src/player/OutdoorMovement.ts');
    const { DatReader, RegionDesc } = await import('@ac/dat-parser');
    OX = A9B4.OX; OY = A9B4.OY;
    const base = (await buildA9b4World({ interiors: true }))({ slidingNormal: null });
    const dc = base.outdoorCollision as InstanceType<typeof DungeonCollision>;
    const services: MovementServices = {
      ...base,
      groundAt: (x, z, y) => outdoorGroundY({ terrainHeight: (a, b) => base.terrain.getHeightAt(a, b), floorHeight: (a, b, f) => dc.getFloorHeight(a, b, f), cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight) }, x, z, y),
    };
    ground = (x, y) => services.groundAt!(OX + x, OY + y, 70)!;
    // main.ts navProbe (outdoors the agent's global metres are the render world's x / z).
    probe = (from, to) => {
      const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.15));
      let x = from.x, z = from.y, floorY = from.z;
      for (let i = 1; i <= n; i++) {
        const tx = from.x + ((to.x - from.x) * i) / n, tz = from.y + ((to.y - from.y) * i) / n;
        const step = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, tx - x, tz - z, 1 / 30, services);
        const g = services.groundAt!(step.x, step.z, floorY + 0.6);
        if (g === null || g === undefined || floorY - g > services.stepDownHeight + 0.05) break;
        const moved = Math.hypot(step.x - x, step.z - z);
        x = step.x; z = step.z; floorY = g;
        if (moved < 0.01) break;
      }
      return { x, y: z, z: floorY };
    };
    // The graph as main.ts loads it (agentCellGraph: with the LandHeightTable, so outside doorways know their ground).
    const portalDb = openDat(DAT_PATHS.portal);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const region: any = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const graph = loadCellGraph(openDat(DAT_PATHS.cell), portalDb, 0xa9b40000, { landHeightTable: region.landDefs?.landHeightTable ?? region.landHeightTable });
    const from = { ...START, z: ground(START.x, START.y) };
    route = findRouteViaOutside(graph, 0xa9b40019, from, 0xa9b40176, PORTAL, { maxDrop: 30 });
    // The old router: 0x177's 1.79 m opening only a window (below LOW_DOOR_MIN_M), as before.
    const doors = new Map([...graph.doors].map(([c, l]) => [c, l.map((d) => (c === 0xa9b40177 && d.b === 0xffff ? { ...d, height: 1.7 } : d))]));
    oldRoute = findRouteViaOutside({ ...graph, doors }, 0xa9b40019, from, 0xa9b40176, PORTAL, { maxDrop: 30 });
  }, 180_000);

  const search = (from: NavPoint, aim: { x: number; y: number; z?: number }, opts: ConstructorParameters<typeof PathSearch>[3]) => {
    const s = new PathSearch(probe, from, { ...aim, x: OX + aim.x, y: OY + aim.y }, opts);
    let r = s.step(60_000);
    while (!r) r = s.step(60_000);
    return r;
  };
  /** Each leg of the route as the walk plans it (a straight walk, else the box search), from START on: the failed searches. */
  const walkRoute = (pts: RoutePoint[]) => {
    let at: NavPoint = { x: OX + START.x, y: OY + START.y, z: ground(START.x, START.y) };
    const failed: number[] = [];
    for (const [i, p] of pts.entries()) {
      const last = i === pts.length - 1;
      const aim = { x: p.x, y: p.y, z: p.feet ?? p.z };
      const r = search(at, aim, last ? { within: 1.3 } : { within: 0.6, margin: 12, maxNodes: 4000 });
      if (r.status !== 'found') { failed.push(r.expanded); break; }
      at = r.path[r.path.length - 1] ?? at;
    }
    return { failed, at: { x: at.x - OX, y: at.y - OY, z: at.z } };
  };

  it('before: the route went in by the statue\'s other opening, its sill at z 68 over ground at 66, and its first leg found no way', () => {
    expect(oldRoute).not.toBeNull();
    expect(oldRoute![1].feet).toBeCloseTo(68, 1);
    expect(ground(oldRoute![0].x, oldRoute![0].y)).toBeCloseTo(66, 0);
    const w = walkRoute(oldRoute!);
    expect(w.failed).toHaveLength(1);
    expect(w.failed[0]).toBeGreaterThan(1000); // "none after 1829 points" (the live walk's 1827)
    // The wide search for the portal itself walks in at once.
    expect(search({ x: OX + 62.4, y: OY + 156.5, z: ground(62.4, 156.5) }, PORTAL, { within: 1, spacing: 1, margin: 35, maxNodes: 6000 }).expanded).toBeLessThan(40);
  });

  it('now: in by cell 0x177\'s 1.79 m doorway at the ramp\'s top (sill z 66.21), and every leg to the portal is found', () => {
    expect(route).not.toBeNull();
    const door = route!.find((p) => Math.abs(p.x - 62.3) < 0.1)!;
    expect(door).toBeDefined();
    expect(door.feet).toBeCloseTo(66.21, 1);
    expect(route!.some((p) => (p.feet ?? 0) > 67)).toBe(false);
    const w = walkRoute(route!);
    expect(w.failed).toEqual([]);
    expect(Math.hypot(w.at.x - PORTAL.x, w.at.y - PORTAL.y)).toBeLessThan(1.5);
    expect(w.at.z).toBeCloseTo(60.8, 0);
  });
});
