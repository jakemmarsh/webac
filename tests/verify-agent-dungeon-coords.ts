/**
 * AGENT.dungeon-map-coords (2026-10-13) — map coordinates inside the dungeon you are in are a walk, not "the landscape".
 *
 * Found live in the Training Academy (cell 0x72020273, global (21954.8, 345.9)): walkTo('100.5088S, 10.4717W'), the
 * coordinates RoutineEngine's own mapCoordsText(me.pos) gave for a spot in the same dungeon, was refused at once
 * ("map coordinates are the landscape, and you are in a dungeon"). Decal and VirindiTank give a dungeon position as
 * map coordinates of the dungeon landblock's own frame (origin + the EnvCell-frame position, / 240 − 101.95, as ACE
 * Position.GetMapCoords), so a VTank .nav recorded in a dungeon is a list of them (with Z = metres / 240), and pull's
 * way back, flee-to, hold-position, walk-to, checkpoint and follow-route all failed underground.
 *
 * Driven through the real AgentApi / RoutineEngine on the fake host (tests/_harness/agentFake.ts), with the cell DAT's
 * real floors (cellPath floorsAt) where the DATs are present.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { AgentApi, parseMapCoords, toGlobal } from '../packages/renderer/src/agent/AgentApi.ts';
import { mapCoordsText } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { floorsAt, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { ALL_MODULES_OFF, navToRoute, parseNav, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** The Training Academy's landblock: its rooms sit at local y −255..5, south of the landblock's own square. */
const ACADEMY = 0x72020000;
const ROOM_A = 0x72020273; // where Jake's walk began
const ROOM_B = 0x72020274; // the next room east
const LOFT = 0x72020310; // a storey up over room B

/** A fake dungeon: room A (x 60–75) and room B (x 75–90) at floor 0, a loft at 6.8 over room B, all at local y −50..−20. */
function academyFloors(lb: number, x: number, y: number): Array<{ cell: number; z: number }> {
  if (lb !== ACADEMY || y < -50 || y > -20 || x < 60 || x > 90) return [];
  return x < 75 ? [{ cell: ROOM_A, z: 0 }] : [{ cell: LOFT, z: 6.8 }, { cell: ROOM_B, z: 0 }];
}

const G = (x: number, y: number) => toGlobal(ACADEMY, x, y);

/** Run the page's ticks until the promise settles (or `ms` pass). */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('map coordinates in the dungeon you are in', () => {
  let host: FakeHost;
  let api: AgentApi;
  let routedTo: number[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = ROOM_A; host.me.x = 66.8; host.me.y = -38.1; host.me.z = 0;
    host.cellSealed = (c) => ((c & 0xffff) < 0x100 ? false : (c >>> 16) === 0x7202);
    host.floorsAt = academyFloors;
    host.routeTo = [];
    routedTo = [];
    const route = host.route;
    host.route = (fc, f, tc, to) => { routedTo.push(tc >>> 0); return route(fc, f, tc, to); };
  });
  afterEach(() => { api.stopMoving(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the reported case: the academy spot\'s own coordinates (its frame runs south of the landblock\'s square) walk', async () => {
    // Global (21954.8, 345.9): 345.9 / 192 is landblock row 1, yet the room is the academy's (0x7202) at local y −38.1.
    const here = mapCoordsText(G(66.8, -38.1));
    expect(here).toBe('100.5088S, 10.4717W');
    const r = await settle(api, host, api.walkTo(mapCoordsText(G(70, -30)), { within: 1 }), 15_000);
    expect(r?.message ?? '').not.toMatch(/landscape/);
    expect(r).toMatchObject({ ok: true });
    expect(Math.hypot(host.me.x - 70, host.me.y + 30)).toBeLessThan(1.5);
  });

  it('a point in the next room is walked as an in-dungeon goal: routed to the room whose floor is under it, on your storey', async () => {
    const p = api.walkTo(mapCoordsText(G(82, -30)), { within: 1 });
    run(api, host, 300);
    expect(host.keys.has('KeyW')).toBe(true);
    expect(routedTo).toContain(ROOM_B);
    expect(routedTo).not.toContain(LOFT);
    const r = await settle(api, host, p, 15_000);
    expect(r).toMatchObject({ ok: true });
  });

  it('a height (a VTank point\'s Z) picks the storey: the loft over room B', async () => {
    void api.walkTo(mapCoordsText(G(82, -30)), { within: 1, z: 6.8 });
    run(api, host, 300);
    expect(routedTo).toContain(LOFT);
    expect(routedTo).not.toContain(ROOM_B);
  });

  it('coordinates out on the landscape (another landblock) are still refused, with the same message', async () => {
    const r = await api.walkTo('43.6N, 33.0E');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^walking to 43\.6N, 33\.0E: map coordinates are the landscape, and you are in a dungeon\. No walk gets there from here: leave by the way out/);
    expect(host.keys.has('KeyW')).toBe(false);
  });

  it('a point near the dungeon with no room under it (rock) says so, not "the landscape"', async () => {
    const r = await api.walkTo(mapCoordsText(G(150, 100)));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/that point is in this dungeon's landblock, but no room of the dungeon is under it/);
    expect(host.keys.has('KeyW')).toBe(false);
  });

  it('an offset ("10m east") in a dungeon is the room under it, not your own cell', async () => {
    void api.walkTo('15m east', { within: 1 });
    run(api, host, 300);
    expect(routedTo).toContain(ROOM_B);
  });

  it('a host that can\'t say where rooms are walks a near point in your own room (no refusal)', async () => {
    host.floorsAt = undefined;
    const p = api.walkTo(mapCoordsText(G(72, -30)), { within: 1 });
    run(api, host, 300);
    expect(host.keys.has('KeyW')).toBe(true);
    expect(await settle(api, host, p, 15_000)).toMatchObject({ ok: true });
  });
});

describe('routines underground: a VirindiTank dungeon route, its heights, the watchdog', () => {
  let host: FakeHost;
  let api: AgentApi;
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = ROOM_A; host.me.x = 66.8; host.me.y = -38.1; host.me.z = 0;
    host.cellSealed = (c) => ((c & 0xffff) < 0x100 ? false : (c >>> 16) === 0x7202);
    host.floorsAt = academyFloors;
    host.routeTo = [];
  });
  afterEach(() => { api.routine.stop(); api.stopMoving(); vi.useRealTimers(); vi.restoreAllMocks(); });

  /** A VTank .nav (uTank2 NAV 1.2, type 4 = once) through the dungeon: E/W, N/S in map units, Z = metres / 240. */
  const navOf = (pts: Array<{ x: number; y: number; z: number }>): string => {
    const lines = ['uTank2 NAV 1.2', '4', String(pts.length)];
    for (const p of pts) { const g = G(p.x, p.y); lines.push('0', String(g.x / 240 - 101.95), String(g.y / 240 - 101.95), String(p.z / 240), '0'); }
    return lines.join('\r\n');
  };
  const profile = (route: NonNullable<ReturnType<typeof navToRoute>['route']>): RoutineProfile => ({
    name: 'Hive', modules: { ...ALL_MODULES_OFF, navigation: true }, initialState: 'Hunt', loot: [], buffSets: [],
    macro: true, settings: { EnableCombat: false, EnableNav: true, NavCloseStopRange: 1.5 }, navRoute: route.name, routes: [route],
    states: [{ name: 'Hunt', rules: [] }],
  });

  it('follow-route walks an imported dungeon .nav point to point to its end', async () => {
    const { route } = navToRoute('Hive', parseNav(navOf([{ x: 72, y: -30, z: 0 }, { x: 82, y: -30, z: 0 }])));
    const walks: Array<{ to: string; z?: number }> = [];
    const walk = api.walkTo.bind(api);
    api.walkTo = (t, o = {}) => { walks.push({ to: String(t), z: o.z }); return walk(t, o); };
    api.routine.start(profile(route!));
    await step(20_000);
    const log = api.routine.history().join('\n');
    expect(log).not.toMatch(/landscape/);
    expect(log).toMatch(/route "Hive" point 1[\s\S]*route "Hive" point 2/);
    expect(Math.hypot(host.me.x - 82, host.me.y + 30)).toBeLessThan(2);
    // Each walk carried the point's height (VTank's Z × 240).
    expect(walks[0]).toMatchObject({ to: route!.points[0], z: 0 });
  });

  it('a reversed route keeps each point\'s height with its point', async () => {
    const { route } = navToRoute('Hive', parseNav(navOf([{ x: 72, y: -30, z: 0 }, { x: 82, y: -30, z: 6.8 }])));
    const walks: Array<{ to: string; z?: number }> = [];
    const walk = api.walkTo.bind(api);
    api.walkTo = (t, o = {}) => { walks.push({ to: String(t), z: o.z }); return walk(t, o); };
    api.routine.start(profile(route!));
    api.routine.reverseRoute(true);
    await step(3000);
    // The route's head (now its last point) is still the floor-level point, with the floor's height, not the loft's.
    expect(walks[0].to).toBe(route!.points[0]);
    expect(walks[0].z).toBeCloseTo(0, 6);
  });

  it('the watchdog samples your position in a dungeon (the radar has no coordinates indoors)', async () => {
    api.routine.start({
      name: 'W', modules: { ...ALL_MODULES_OFF }, initialState: 'Hunt', loot: [], buffSets: [], routes: [],
      states: [
        { name: 'Hunt', rules: [{ label: 'Watch', when: [{ kind: 'not', condition: { kind: 'seconds-in-state', seconds: 1 } }], do: [{ kind: 'set-watchdog', state: 'Stuck', meters: 5, seconds: 3 }, { kind: 'wait', seconds: 1 }] }] },
        { name: 'Stuck', rules: [] },
      ],
    });
    await step(6000);
    expect(api.routine.status().state).toBe('Stuck');
  });

  it('checkpoint\'s coordinates round-trip: mapCoordsText → parseMapCoords is the same spot in the dungeon frame', () => {
    const g = G(66.8, -38.1);
    const back = parseMapCoords(mapCoordsText(g))!;
    expect(Math.hypot(back.x - g.x, back.y - g.y)).toBeLessThan(0.05);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('cellPath floorsAt on the cell DAT', () => {
  let academy: CellGraph;
  let hive: CellGraph;
  beforeAll(() => {
    academy = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), ACADEMY);
    hive = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x039d0000);
  });
  it('the academy spot (global (21954.8, 345.9)) is room 0x72020273 at floor 0, with the storeys over it listed too', () => {
    const f = floorsAt(academy, 21954.8 - 0x72 * 192, 345.9 - 0x02 * 192);
    expect(f.map((x) => x.cell)).toContain(ROOM_A);
    expect(f.find((x) => x.cell === ROOM_A)!.z).toBeCloseTo(0, 1);
  });
  it('a real VirindiTank hive route\'s point (-99.3367 E/W, 23.4151 N/S, Z -0.12498) is room 0x039D0156 at z -30', () => {
    const g = { x: (-99.3367254257202 + 101.95) * 240, y: (23.4151046911875 + 101.95) * 240 };
    // Not in landblock 0x039D's own square (local y −56): the dungeon frame, which dividing by 192 would miss.
    expect(Math.floor(g.y / 192)).toBe(0x9c);
    const f = floorsAt(hive, g.x - 0x03 * 192, g.y - 0x9d * 192);
    expect(f).toEqual([{ cell: 0x039d0156, z: expect.closeTo(-0.124979170163473 * 240, 1) }]);
  });
});
