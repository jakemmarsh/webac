/**
 * HARNESS.first-hour-stairs — tools/lib/cell-path.ts, the cell-graph router
 * probe-first-hour walks to reach the academy's upper floor.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CellDoor, type CellGraph, type FloorPoly, OPENING_MIN_HEIGHT_M, findRoute, findRouteViaOutside, frameToParent, loadCellGraph, onLevel, walkableExit, yawToward } from '../tools/lib/cell-path.ts';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.ts';

const v = (x: number, y: number, z = 0) => ({ x, y, z });

describe('frameToParent', () => {
  it('applies the rotation, then the origin', () => {
    // 90° about +z: (w, x, y, z) = (cos 45°, 0, 0, sin 45°) takes +x to +y.
    const s = Math.SQRT1_2;
    const p = frameToParent({ origin: v(10, 20, 3), orientation: { w: s, x: 0, y: 0, z: s } }, v(1, 0, 0));
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(21);
    expect(p.z).toBeCloseTo(3);
  });
  it('is a plain translation for the identity orientation', () => {
    expect(frameToParent({ origin: v(1, 2, 3), orientation: { w: 1, x: 0, y: 0, z: 0 } }, v(4, 5, 6))).toEqual(v(5, 7, 9));
  });
});

describe('yawToward', () => {
  // The client steps forward by (−sin yaw, −cos yaw) in AC (x, y).
  const forward = (yaw: number) => ({ x: -Math.sin(yaw), y: -Math.cos(yaw) });
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [3, -4]]) {
    it(`faces (${dx}, ${dy})`, () => {
      const f = forward(yawToward(v(5, 5), v(5 + dx, 5 + dy)));
      const n = Math.hypot(dx, dy);
      expect(f.x).toBeCloseTo(dx / n);
      expect(f.y).toBeCloseTo(dy / n);
    });
  }
});

describe('findRoute', () => {
  // A ─ B ─ C in a row, plus a long detour A ─ D ─ C; and E, cut off.
  const A = 0x12340100, B = 0x12340101, C = 0x12340102, D = 0x12340103, E = 0x12340104;
  const WALL = v(0, 1, 0), FLOOR = v(0, 0, 1);
  const door = (a: number, b: number, at: { x: number; y: number; z: number }, normal = WALL) => ({ a, b, at, normal });
  const g: CellGraph = {
    landblock: 0x12340000,
    doors: new Map([
      [A, [door(A, B, v(10, 0)), door(A, D, v(0, 10)), door(A, 0xFFFF, v(-5, 0))]],
      [B, [door(B, A, v(10, 0)), door(B, C, v(20, 0), FLOOR)]],
      [C, [door(C, B, v(20, 0), FLOOR), door(C, D, v(30, 40))]],
      [D, [door(D, A, v(0, 10)), door(D, C, v(30, 40))]],
      [E, []],
    ]),
  };
  it('goes straight to the target inside one cell', () => {
    expect(findRoute(g, A, v(1, 1), A, v(2, 2))).toEqual([v(2, 2)]);
  });
  it('passes the shortest chain of doorways, then the target', () => {
    expect(findRoute(g, A, v(5, 0), C, v(25, 0))).toEqual([v(10, 0), { ...v(20, 0), floor: true }, v(25, 0)]);
  });
  it('tags a horizontal (floor) portal on the route', () => {
    const r = findRoute(g, A, v(5, 0), C, v(25, 0))!;
    expect(r.map((p) => !!p.floor)).toEqual([false, true, false]);
  });
  it('routes around an avoided doorway (a floor portal found to be a drop)', () => {
    expect(findRoute(g, A, v(5, 0), C, v(25, 0), [v(20, 0)])).toEqual([v(0, 10), v(30, 40), v(25, 0)]);
    expect(findRoute(g, A, v(5, 0), C, v(25, 0), [v(20, 0), v(30, 40)])).toBeNull();
  });
  it('takes the detour when it is shorter for the endpoints', () => {
    // From near A's D-door to near C's D-door, via D beats via B.
    expect(findRoute(g, A, v(0, 9), C, v(29, 39))).toEqual([v(0, 10), v(30, 40), v(29, 39)]);
  });
  it('never routes through the outside (0xFFFF) and fails when cut off', () => {
    expect(findRoute(g, A, v(1, 1), E, v(0, 0))).toBeNull();
  });
});

describe('onLevel', () => {
  it('puts a wall doorway\'s floor 0–4 m under its centroid', () => {
    expect(onLevel(v(135, -140, -3.8), -5.3)).toBe(true);
    // Live 2026-10-04: over the stairwell landing's doorway in plan, but on the landing above it.
    expect(onLevel(v(135, -140, -3.8), 0)).toBe(false);
    expect(onLevel(v(0, 0, 3), -1.5)).toBe(false);
  });
  it('puts a floor portal at its own height', () => {
    expect(onLevel({ ...v(130, -130, 0), floor: true }, -1)).toBe(true);
    expect(onLevel({ ...v(130, -130, 0), floor: true }, -3.8)).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('the Holtburg academy (landblock 0x8602)', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x86020000); });

  it('reads each doorway\'s orientation: the stairwell landing 0x8602013C opens up into 0x860202C5', () => {
    const up = g.doors.get(0x8602013C)!.find((d) => d.b === 0x860202C5)!;
    expect(Math.abs(up.normal.z)).toBeCloseTo(1);
    const east = g.doors.get(0x8602013C)!.find((d) => d.b === 0x8602014C)!;
    expect(Math.abs(east.normal.x)).toBeCloseTo(1);
  });

  it('routes the Sentry to the exit portal around the stairwell opening once it is avoided', () => {
    // Sentry 0x860202C2 (123.67, −132.95, 0.005) → Exit to Holtburg 0x86020169 (158.64, −149.52, −6.06).
    const from = v(123.67, -132.95, 0.005), to = v(158.641, -149.516, -6.063);
    const opening = v(130, -140, 0);
    // The opening is a 6 m drop; the stairwell's stair is a static object, and since the router reads statics'
    // floors (2026-10-10) the route walks down it rather than falling (a fall costs DROP_PENALTY_M).
    const direct = findRoute(g, 0x860202C5, v(129, -140, 0), 0x86020169, to)!;
    expect(direct.every((p) => p.drop === undefined)).toBe(true);
    expect(direct.some((p) => p.floor && Math.hypot(p.x - 130, p.y + 130, p.z) < 0.01)).toBe(true);
    const fallOnly = findRoute(g, 0x860202C5, v(129, -140, 0), 0x86020169, to, [v(130, -130, 0)])!;
    expect(fallOnly.some((p) => p.floor && p.drop === 6 && Math.hypot(p.x - 130, p.y + 140, p.z) < 0.01)).toBe(true);
    const around = findRoute(g, 0x860202C5, v(129, -140, 0), 0x86020169, to, [opening])!;
    expect(around).not.toBeNull();
    expect(around.some((p) => Math.hypot(p.x - 130, p.y + 140, p.z) < 0.01)).toBe(false);
    expect(findRoute(g, 0x860202C2, from, 0x86020169, to)).not.toBeNull();
  });

  it('reads every EnvCell with its doorways', () => {
    expect(g.doors.size).toBe(568);
    // Doorways are shared: each side's copy of a door sits at the same centroid.
    const lib = g.doors.get(0x8602024C)!;
    for (const d of lib.filter((x) => x.b !== 0xFFFF)) {
      const back = g.doors.get(d.b)!.find((x) => x.b === d.a && Math.hypot(x.at.x - d.at.x, x.at.y - d.at.y, x.at.z - d.at.z) < 0.01);
      expect(back, `0x${d.b.toString(16)} → 0x${d.a.toString(16)}`).toBeDefined();
    }
  });

  it('routes from the Blacksmith up the stairs to the Outer Courtyard portal (z 12)', () => {
    // landblock_instance: Academy Blacksmith 0x860201F6 (37.88, −89.23, 0.005); Outer Courtyard 0x86020331 (90, −60, 11.937).
    const r = findRoute(g, 0x860201F6, v(37.88, -89.23, 0.005), 0x86020331, v(90, -60, 11.937))!;
    expect(r).not.toBeNull();
    expect(r.at(-1)).toEqual(v(90, -60, 11.937));
    // The stair cells join by wall doorways all the way up: no floor portal on this route.
    expect(r.filter((p) => p.floor)).toEqual([]);
    // It climbs: doorway centroids rise from the ground floor (≈1.5) to the upper floor (≈13.5).
    const zs = r.map((p) => p.z);
    expect(Math.min(...zs)).toBeLessThan(3);
    expect(Math.max(...zs)).toBeGreaterThan(12);
    // Through the library (its door in 0x8602024C at (64.74, −90)), as live 2026-10-04.
    expect(r.some((p) => Math.abs(p.x - 65) < 1 && Math.abs(p.y + 90) < 1)).toBe(true);
    // Every leg is short: no straight line across the floor plan.
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y)).toBeLessThan(15);
  });
});

describe('findRouteViaOutside', () => {
  // A cottage: hall 0x0100 (front door to the outside at x=10) ─ room 0x0101; a back door from the room at x=30.
  const LB = 0xA9B40000;
  const hall = (LB | 0x0100) >>> 0, room = (LB | 0x0101) >>> 0;
  const g: CellGraph = {
    landblock: LB,
    doors: new Map([
      [hall, [{ a: hall, b: 0xFFFF, at: v(10, 0), normal: v(0, 1) }, { a: hall, b: room, at: v(20, 5), normal: v(1, 0) }]],
      [room, [{ a: room, b: hall, at: v(20, 5), normal: v(1, 0) }, { a: room, b: 0xFFFF, at: v(30, 0), normal: v(0, 1) }]],
    ]),
  };
  const outside = (LB | 0x0011) >>> 0;
  it('walks outdoors to the nearer doorway, then inside', () => {
    expect(findRouteViaOutside(g, outside, v(8, -10), room, v(25, 8))).toEqual([v(10, 0), v(20, 5), v(25, 8)]);
    expect(findRouteViaOutside(g, outside, v(32, -10), room, v(25, 8))).toEqual([v(30, 0), v(25, 8)]);
  });
  it('walks out through the doorway nearest the destination', () => {
    expect(findRouteViaOutside(g, hall, v(12, 3), outside, v(9, -20))).toEqual([v(10, 0), v(9, -20)]);
  });
  it('goes out one building and into another', () => {
    const shop = (LB | 0x0110) >>> 0;
    const g2: CellGraph = { landblock: LB, doors: new Map([...g.doors, [shop, [{ a: shop, b: 0xFFFF, at: v(60, 0), normal: v(0, 1) }]]]) };
    // Out the back (through the room, 54 m in all) beats the front door (59 m).
    expect(findRouteViaOutside(g2, hall, v(12, 3), shop, v(60, 5))).toEqual([v(20, 5), v(30, 0), v(60, 0), v(60, 5)]);
    expect(findRouteViaOutside(g2, hall, v(2, 3), shop, v(60, 5))).toEqual([v(10, 0), v(60, 0), v(60, 5)]);
  });

  it('approaches an outside doorway from its doorstep, on the side away from the cell', () => {
    // The hall's centre is north of its front door (y > 0), so the doorstep is 1.5 m south.
    const gc: CellGraph = { ...g, centers: new Map([[hall, v(15, 5)], [room, v(25, 6)]]) };
    expect(findRouteViaOutside(gc, outside, v(8, -10), room, v(25, 8))).toEqual([v(10, -1.5), v(10, 0), v(20, 5), v(25, 8)]);
    expect(findRouteViaOutside(gc, hall, v(12, 3), outside, v(9, -20))).toEqual([v(10, 0), v(10, -1.5), v(9, -20)]);
  });

  it('never walks out through a window, a service counter or a roof opening while a door exists (the Holtburg blacksmith, 2026-10-09)', () => {
    // The hall gains a 1.5 m counter window at x=12 (nearer than the door from the north-west), and a hole in its roof.
    const g3: CellGraph = { landblock: LB, doors: new Map([...g.doors, [hall, [
      { a: hall, b: 0xFFFF, at: v(10, 0), normal: v(0, 1), height: 2.5 },
      { a: hall, b: 0xFFFF, at: v(12, 10), normal: v(0, 1), height: 1.5 },
      { a: hall, b: 0xFFFF, at: v(13, 5), normal: { x: 0, y: 0, z: 1 }, height: 0 },
      { a: hall, b: room, at: v(20, 5), normal: v(1, 0) },
    ]]]) };
    expect(findRouteViaOutside(g3, outside, v(12, 14), hall, v(13, 5))).toEqual([v(10, 0), v(13, 5)]);
    expect(findRouteViaOutside(g3, hall, v(13, 5), outside, v(12, 14))).toEqual([v(10, 0), v(12, 14)]);
    expect(walkableExit({ a: hall, b: 0xFFFF, at: v(0, 0), normal: v(0, 1), height: OPENING_MIN_HEIGHT_M })).toBe(true);
    // A building whose only opening is window-sized still gets a route (any way out beats none).
    const shed = (LB | 0x0120) >>> 0;
    const g4: CellGraph = { landblock: LB, doors: new Map([[shed, [{ a: shed, b: 0xFFFF, at: v(40, 0), normal: v(0, 1), height: 1.5 }]]]) };
    expect(findRouteViaOutside(g4, outside, v(40, -5), shed, v(40, 3))).toEqual([v(40, 0), v(40, 3)]);
  });

  it('is findRoute indoors and a straight line outdoors', () => {
    expect(findRouteViaOutside(g, hall, v(12, 3), room, v(25, 8))).toEqual(findRoute(g, hall, v(12, 3), room, v(25, 8)));
    expect(findRouteViaOutside(g, outside, v(0, 0), outside, v(5, 5))).toEqual([v(5, 5)]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Holtburg (landblock 0xA9B4): the blacksmith shop', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0xA9B40000); });

  it('walk_to Sedor from the lifestone goes in by the west door, not over the service counter (2026-10-09)', () => {
    // ACE world: the Life Stone at A9B40000 (81.3, 11.8, 94); Sedor Wystan the Blacksmith at A9B40100 (87.48, 131.04, 66).
    const r = findRouteViaOutside(g, 0xA9B40001, { x: 81.3, y: 11.8, z: 94 }, 0xA9B40100, { x: 87.48, y: 131.04, z: 66 })!;
    expect(r).not.toBeNull();
    const near = (x: number, y: number) => r.some((p) => Math.hypot(p.x - x, p.y - y) < 0.6);
    expect(near(73.1, 131.5)).toBe(true); // the door: 2.5 m tall, from the floor
    expect(near(89.1, 126.5)).toBe(false); // the counter: 1.5 m tall, a 1 m sill
    // The counter really is window-sized in the DAT, and the door door-sized.
    const counter = g.doors.get(0xA9B40103)!.find((d) => d.b === 0xFFFF)!;
    expect(counter.bottom!).toBeCloseTo(67, 1);
    expect(counter.height!).toBeCloseTo(1.5, 1);
    expect(walkableExit(counter)).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('a cell graph read before streamed files land', () => {
  it('is marked incomplete (not kept) when an Environment or the whole cell bundle is not readable yet, complete otherwise', () => {
    const cell = openDat(DAT_PATHS.cell), portal = openDat(DAT_PATHS.portal);
    expect(loadCellGraph(cell, portal, 0xA9B40000).complete).toBe(true);
    // A streamed store answers a non-resident read with null (DatStore); the first Environment missing:
    let dropped = 0;
    const partialPortal = { getFileData: (id: number) => ((id >>> 24) === 0x0D && dropped++ === 0 ? null : portal.getFileData(id)) } as unknown as typeof portal;
    expect(loadCellGraph(cell, partialPortal, 0xA9B40000).complete).toBe(false);
    const noBundle = { getFileData: () => null } as unknown as typeof cell;
    expect(loadCellGraph(noBundle, portal, 0xA9B40000).complete).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Holtburg (landblock 0xA9B4): the tavern\'s tall doorways', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0xA9B40000); });

  it('a wall doorway is reached at its floor (feet), not its centroid 1.55 m up a 3.1 m door (2026-10-09)', () => {
    // From the tavern room 0xA9B40157 (local 103.7, 26, floor 94) out to the lifestone (81.3, 11.8).
    const r = findRouteViaOutside(g, 0xA9B40157, { x: 103.7, y: 26, z: 94 }, 0xA9B40001, { x: 81.3, y: 11.8, z: 94 })!;
    const tall = r.find((p) => Math.abs(p.x - 104.05) < 0.1 && Math.abs(p.y - 27.1) < 0.1)!;
    expect(tall.z - tall.feet!).toBeGreaterThan(1.5); // the centroid alone was out of the planner's 1.5 m reach
    expect(tall.feet!).toBeCloseTo(94, 1);
    // From the bar room 0xA9B40155 the way out goes through doors, not over the 1.8 m bar (0x015C / 0x015D).
    const bar = findRouteViaOutside(g, 0xA9B40155, { x: 105.5, y: 34, z: 94 }, 0xA9B40001, { x: 81.3, y: 11.8, z: 94 })!;
    expect(bar).not.toBeNull();
    expect(bar.some((p) => Math.abs(p.y - 36) < 0.6 && (Math.abs(p.x - 105.5) < 0.6 || Math.abs(p.x - 109.5) < 0.6))).toBe(false);
    expect(g.doors.get(0xA9B40155)!.filter((d) => d.b === 0xA9B4015D || d.b === 0xA9B4015C).every((d) => d.height! < OPENING_MIN_HEIGHT_M)).toBe(true);
    // Every wall doorway on the way, and the doorstep outside, is at the ground floor's height.
    for (const p of r.slice(0, -1)) if (!p.floor) expect(p.feet!).toBeCloseTo(94, 0);
  });
});

describe('AGENT.walk-drops-jumps — floor openings: up only by a stair, down as a fall your health takes, never across the air', () => {
  // A hall (floor 0) under an air cell (no floor) with a 6 m-high opening between them; a walkway room
  // (floor 6) opens onto the air; a ramp room joins the hall to the walkway; a second walkway across the air.
  const LB = 0x12340000;
  const H = LB | 0x100, A = LB | 0x101, W = LB | 0x102, R = LB | 0x103, W2 = LB | 0x104;
  const UP = v(0, 0, 1), WALL = v(0, 1, 0);
  const hole = (a: number, b: number) => ({ a, b, at: v(10, 0, 6), normal: UP, height: 0, bottom: 6, below: H, climb: false, landing: 0 });
  const door = (a: number, b: number, at: { x: number; y: number; z: number }) => ({ a, b, at, normal: WALL, height: 3, bottom: at.z - 1.5 });
  const graph = (withRamp: boolean): CellGraph => ({
    landblock: LB,
    airCells: new Set([A]),
    doors: new Map([
      [H, [hole(H, A), ...(withRamp ? [door(H, R, v(0, 0, 1.5))] : [])]],
      [A, [hole(A, H), door(A, W, v(10, 5, 7.5)), door(A, W2, v(10, -5, 7.5))]],
      [W, [door(W, A, v(10, 5, 7.5)), ...(withRamp ? [door(W, R, v(0, 10, 7.5))] : [])]],
      [W2, [door(W2, A, v(10, -5, 7.5))]],
      [R, withRamp ? [door(R, H, v(0, 0, 1.5)), door(R, W, v(0, 10, 7.5))] : []],
    ]),
  });

  it('never up through the opening, which no floor climbs to: up the ramp instead', () => {
    const r = findRoute(graph(true), H, v(10, -2, 0), W, v(10, 8, 6))!;
    expect(r).not.toBeNull();
    expect(r.some((p) => p.floor)).toBe(false);
    expect(r.some((p) => p.x === 0 && p.y === 10)).toBe(true);
    expect(findRoute(graph(false), H, v(10, -2, 0), W, v(10, 8, 6))).toBeNull();
  });

  it('down, a walk round beats a fall; with no walk, the fall, tagged with its height and landing, if your health takes it', () => {
    expect(findRoute(graph(true), W, v(10, 8, 6), H, v(10, -2, 0))!.some((p) => p.drop !== undefined)).toBe(false);
    const fall = findRoute(graph(false), W, v(10, 8, 6), H, v(10, -2, 0))!;
    expect(fall.find((p) => p.floor)).toMatchObject({ x: 10, y: 0, z: 6, drop: 6, landing: 0 });
    expect(findRoute(graph(false), W, v(10, 8, 6), H, v(10, -2, 0), [], { maxDrop: 5 })).toBeNull();
  });

  it('a fall goes straight from the walkway to the opening: the doorway into the air is not a point to stand on (AC1999 tutorial balcony, 2026-10-11)', () => {
    // The walkway's doorway into the air cell (10, 5) is in the air (a rail can stand in it): the route's
    // first point is the opening the body drops through, then the goal.
    const fall = findRoute(graph(false), W, v(10, 8, 6), H, v(10, -2, 0))!;
    expect(fall).toHaveLength(2);
    expect(fall[0]).toMatchObject({ x: 10, y: 0, z: 6, floor: true, drop: 6, landing: 0 });
    expect(fall.some((p) => p.x === 10 && p.y === 5)).toBe(false);
    // A doorway into the air not followed by a fall through it stays (and a walk round never meets one).
    expect(findRoute(graph(true), W, v(10, 8, 6), H, v(10, -2, 0))).toEqual([
      expect.objectContaining({ x: 0, y: 10 }), expect.objectContaining({ x: 0, y: 0 }), expect.objectContaining({ x: 10, y: -2 }),
    ]);
  });

  it('a fall the walk found no way down through (a rail too high to jump) is avoided: round by the ramp, or no route', () => {
    const hole = v(10, 0, 6);
    expect(findRoute(graph(true), W, v(10, 8, 6), H, v(10, -2, 0), [], { maxDrop: 12 })!.some((p) => p.drop !== undefined)).toBe(false);
    // With the walk round 30 m+ longer the fall is taken; avoided, the ramp is.
    const far = graph(true);
    far.doors.get(R)!.splice(0, 2, { a: R, b: H, at: v(0, 0, 1.5), normal: v(0, 1, 0), height: 3, bottom: 0 }, { a: R, b: W, at: v(-40, 10, 7.5), normal: v(0, 1, 0), height: 3, bottom: 6 });
    far.doors.get(W)!.splice(1, 1, { a: W, b: R, at: v(-40, 10, 7.5), normal: v(0, 1, 0), height: 3, bottom: 6 });
    far.doors.get(H)!.splice(1, 1, { a: H, b: R, at: v(0, 0, 1.5), normal: v(0, 1, 0), height: 3, bottom: 0 });
    expect(findRoute(far, W, v(10, 8, 6), H, v(10, -2, 0), [], { maxDrop: 12 })![0]).toMatchObject({ x: 10, y: 0, drop: 6 });
    const round = findRoute(far, W, v(10, 8, 6), H, v(10, -2, 0), [], { maxDrop: 12, avoid: [hole] })!;
    expect(round.some((p) => p.drop !== undefined)).toBe(false);
    expect(round[0]).toMatchObject({ x: -40, y: 10 });
    expect(findRoute(graph(false), W, v(10, 8, 6), H, v(10, -2, 0), [], { maxDrop: 12, avoid: [hole] })).toBeNull();
  });

  it('never across the air from one walkway to another (a body in it falls)', () => {
    expect(findRoute(graph(false), W, v(10, 8, 6), W2, v(10, -8, 6))).toBeNull();
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Banderling Ruin (dungeon 0x01E0): the atrium (2026-10-10)', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x01e00000); });

  it('reads the atrium: 0x01E00120 is air over the hall 0x01E00105, the opening between them 6 m up with no floor rising to it', () => {
    expect(g.airCells!.has(0x01e00120)).toBe(true);
    expect(g.airCells!.has(0x01e00105)).toBe(false);
    const hole = g.doors.get(0x01e00105)!.find((d) => d.b === 0x01e00120)!;
    expect(hole).toMatchObject({ below: 0x01e00105, climb: false, landing: 0 });
    expect(hole.at.z).toBeCloseTo(6, 3);
  });

  it('from the south nook 0x01E00106 to the walkway room 0x01E0011F goes up the north ramp, never up through the opening', () => {
    // Live: walk_to went for the doorway (10, −15) at z 6 straight from the hall, by way of the opening at (10, −20, 6).
    const r = findRoute(g, 0x01e00106, v(10, -28.6, 0), 0x01e0011f, v(10, -12, 6))!;
    expect(r).not.toBeNull();
    expect(r.some((p) => p.floor)).toBe(false);
    expect(r.some((p) => Math.abs(p.x - 10) < 0.5 && Math.abs(p.y + 20) < 0.5)).toBe(false);
    // The ramp 0x01E0011C–0x01E0011E: doorways at feet 3 and 6 along local y ≈ 0 … −5.
    expect(r.some((p) => p.feet !== undefined && Math.abs(p.feet - 3) < 0.1 && p.y > -2)).toBe(true);
    expect(r.at(-1)).toEqual(v(10, -12, 6));
  });

  it('down from the walkway landing 0x01E00121 to the hall takes the ramp down, not a fall through the air', () => {
    const r = findRoute(g, 0x01e00121, v(8.5, -30, 6), 0x01e00105, v(10, -22, 0))!;
    expect(r.some((p) => p.drop !== undefined)).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('routes that stay on the floors a body can walk (players\' reports, 2026-10-10)', () => {
  it('A Rat Nest (0x01DD): from the lower floor 0x01DD011C to the red rats in 0x01DD0116 it stays down at z −6, not back up through the entry 0x01DD015F', () => {
    const g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x01dd0000);
    const r = findRoute(g, 0x01dd011c, g.centers!.get(0x01dd011c)!, 0x01dd0116, v(21.8, -34, -6))!;
    expect(r).not.toBeNull();
    // The old route climbed to the entry (feet 0 at (30, −65..−75)) and then needed the hole at (30, −60).
    for (const p of r) expect(p.feet ?? p.z).toBeLessThan(-2.5);
  });

  it('Banderling Ruin: from the SE walkway landing 0x01E00127 to the chest landing 0x01E00121 it never walks into the air between them', () => {
    const g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x01e00000);
    const r = findRoute(g, 0x01e00127, v(30, -30, 6), 0x01e00121, v(8.5, -30, 6))!;
    // The old route went (25, −30) → (15, −30) at z 6, straight through the air cell 0x01E00124: a fall into the hall.
    expect(r.some((p) => Math.abs(p.y + 30) < 0.5 && (Math.abs(p.x - 25) < 0.5 || Math.abs(p.x - 15) < 0.5))).toBe(false);
    // The only walk: down the SE ramp, across the hall, up the west ramp, arriving on the landing's floor.
    expect(r.at(-1)).toEqual(v(8.5, -30, 6));
    expect(Math.min(...r.map((p) => p.feet ?? p.z))).toBeCloseTo(0, 1);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Holtburg (landblock 0xA9B4): the archmage\'s tower', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0xA9B40000); });
  it('walk_to Archmage Cindrue climbs the staircase static to the upper floor (Arcanist pressed into the wall, 2026-10-10)', () => {
    // The stair is the static Setup 0x020001B4 in cell 0x0117, not the cell's own floor; it rises to the
    // 0.2 m floorless slab 0x011E and on through it to the archmage's floor in 0x011B at z 69.
    const up = (g.doors.get(0xA9B40117) ?? []).find((d) => d.b === 0xA9B4011E)!;
    expect(up.climb).toBe(true);
    expect(g.airCells?.has(0xA9B4011E)).toBe(false);
    const archmage = { x: 152.347, y: 132.546, z: 69.005 };
    const route = findRouteViaOutside(g, 0xA9B40036, { x: 148.5, y: 136.4, z: 66 }, 0xA9B4011B, archmage)!;
    expect(route).not.toBeNull();
    expect(route.at(-1)).toEqual(archmage);
    expect(route.some((p) => p.floor && Math.abs(p.z - 69) < 0.05)).toBe(true);
    expect(route.every((p) => p.drop === undefined)).toBe(true);
  });
  it('still never climbs into a true air cell (the Banderling Ruin atrium stays down-only)', () => {
    for (const c of g.airCells ?? []) for (const d of g.doors.get(c) ?? []) if (d.below === c) expect(d.climb).toBe(false);
  });
});

describe('findRouteViaOutside: doorways the landscape walks up to, and doors that would not open', () => {
  // A hall 0x0100 with a door on a 5 m porch (east, x 10, feet 99) and one at the ground up a ramp (south, y -10, feet 96).
  const LB = 0xE63D0000;
  const hall = (LB | 0x0100) >>> 0;
  const porch: FloorPoly = { pts: [v(10, -2, 99), v(12.5, -2, 99), v(12.5, 2, 99), v(10, 2, 99)], n: v(0, 0, 1), d: 99 };
  const high: CellDoor = { a: hall, b: 0xFFFF, at: v(10, 0, 100.25), normal: v(1, 0), height: 2.5, bottom: 99, grounded: false };
  const low: CellDoor = { a: hall, b: 0xFFFF, at: v(0, -10, 97.25), normal: v(0, 1), height: 2.5, bottom: 96, grounded: true };
  const g: CellGraph = { landblock: LB, doors: new Map([[hall, [high, low]]]), exitFloors: new Map([[high, [porch]], [low, []]]) };
  const outside = (LB | 0x002D) >>> 0;
  it('from the ground, in by the door the ground reaches, though the porch door is nearer', () => {
    expect(findRouteViaOutside(g, outside, v(11, -4, 94), hall, v(5, 0, 96))).toEqual([{ ...v(0, -10, 97.25), feet: 96 }, v(5, 0, 96)]);
  });
  it('from up on the porch, in by the porch door', () => {
    expect(findRouteViaOutside(g, outside, v(11.5, 0, 99), hall, v(5, 0, 96))).toEqual([{ ...v(10, 0, 100.25), feet: 99 }, v(5, 0, 96)]);
  });
  it('with no grounded door at all, any door (the walk may still jump or find a way)', () => {
    const g2: CellGraph = { landblock: LB, doors: new Map([[hall, [high]]]) };
    expect(findRouteViaOutside(g2, outside, v(11, -4, 94), hall, v(5, 0, 96))).toEqual([{ ...v(10, 0, 100.25), feet: 99 }, v(5, 0, 96)]);
  });
  it('leaves out a doorway by a door that would not open, and has no route when it was the only one', () => {
    expect(findRouteViaOutside(g, outside, v(1, -14, 94), hall, v(5, 0, 96), { closed: [v(0.2, -10.7, 96)] })).toEqual([{ ...v(10, 0, 100.25), feet: 99 }, v(5, 0, 96)]);
    expect(findRouteViaOutside(g, outside, v(1, -14, 94), hall, v(5, 0, 96), { closed: [v(0.2, -10.7, 96), v(10.7, 0, 99)] })).toBeNull();
    // Indoors as well: a shut door between two rooms.
    const A = (LB | 0x0101) >>> 0, B = (LB | 0x0102) >>> 0;
    const gi: CellGraph = { landblock: LB, doors: new Map([[A, [{ a: A, b: B, at: v(5, 0, 1), normal: v(1, 0), bottom: 0 }]], [B, [{ a: B, b: A, at: v(5, 0, 1), normal: v(1, 0), bottom: 0 }]]]) };
    expect(findRoute(gi, A, v(0, 0, 0), B, v(9, 0, 0))).not.toBeNull();
    expect(findRoute(gi, A, v(0, 0, 0), B, v(9, 0, 0), [], { closed: [v(5.6, 0.3, 0)] })).toBeNull();
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Nanto (landblock 0xE63D): the scriveners\' hall up on its foundation (2026-10-11)', () => {
  let g: CellGraph;
  const LB = 0xE63D0000;
  const exit = (cell: number): CellDoor => g.doors.get((LB | cell) >>> 0)!.find((d) => d.b === 0xFFFF)!;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const region = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    g = loadCellGraph(openDat(DAT_PATHS.cell), portal, LB, { landHeightTable: region.landDefs.landHeightTable });
  });

  it('reads the hall\'s doors: four 5 m up on porches no stair reaches, one at 96 up the ramp static 0x020002F8', () => {
    expect(g.complete).toBe(true);
    for (const c of [0x015D, 0x015E, 0x015F, 0x0160]) {
      expect(exit(c).bottom!).toBeCloseTo(99, 1);
      expect(exit(c).grounded).toBe(false);
    }
    expect(exit(0x0161).bottom!).toBeCloseTo(96, 1);
    expect(exit(0x0161).grounded).toBe(true);
    // Elsewhere in Nanto, ground-floor doors stay grounded.
    expect(exit(0x0121).grounded).toBe(true);
    expect(exit(0x0165).grounded).toBe(true);
  });

  it('walk_to the Journeyman Scrivener of War Magic from the foot of the foundation goes up the ramp and in at 0x0161, not at the porch door overhead', () => {
    // The player at local (139.6, 102.8, z 94) in 0xE63D002D; the scrivener in 0xE63D0159 at (136.7, 105.6, z 96).
    const r = findRouteViaOutside(g, (LB | 0x002D) >>> 0, v(139.6, 102.8, 94), (LB | 0x0159) >>> 0, v(136.7, 105.6, 96), { maxDrop: 0 })!;
    expect(r).not.toBeNull();
    expect(r[0].feet).toBeCloseTo(96, 1);
    expect(Math.hypot(r[0].x - 132.1, r[0].y - 117)).toBeLessThan(0.3); // the doorstep, on the ramp
    expect(r.every((p) => (p.feet ?? p.z) < 98.5 || p === r[r.length - 1])).toBe(true);
    // Standing up on the east porch, the east door is the way in.
    const up = findRouteViaOutside(g, (LB | 0x002D) >>> 0, v(141, 107.9, 99), (LB | 0x0159) >>> 0, v(136.7, 105.6, 96), { maxDrop: 0 })!;
    expect(up[0].feet).toBeCloseTo(99, 1);
    expect(Math.hypot(up[0].x - 141, up[0].y - 107.9)).toBeLessThan(0.3);
  });

  it('with the ramp door shut to a Use, the route goes by a porch door (the walk may still jump to it)', () => {
    const r = findRouteViaOutside(g, (LB | 0x002D) >>> 0, v(139.6, 102.8, 94), (LB | 0x0159) >>> 0, v(136.7, 105.6, 96), { maxDrop: 0, closed: [v(132.1, 115.6, 96)] })!;
    expect(r).not.toBeNull();
    expect(r[0].feet).toBeCloseTo(99, 1);
  });

  it('counts the cells LandblockInfo says it has: a cell still in flight below NumCells marks the graph incomplete', () => {
    const cell = openDat(DAT_PATHS.cell), portal = openDat(DAT_PATHS.portal);
    const gap = { getFileData: (id: number) => (id === 0xE63D0130 ? null : cell.getFileData(id)) } as unknown as typeof cell;
    const partial = loadCellGraph(gap, portal, LB);
    expect(partial.complete).toBe(false);
    // The cells past the gap were still read (the old scan stopped at the first gap and called it complete).
    expect(partial.doors.has((LB | 0x0159) >>> 0)).toBe(true);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Holtburg (landblock 0xA9B4): the drudge statue\'s pedestal (2026-10-11)', () => {
  it('the pedestal\'s opening 0xA9B40178, 2 m over the ground with nothing up to it, is not a doorway the landscape reaches', () => {
    const portal = openDat(DAT_PATHS.portal);
    const region = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    const g = loadCellGraph(openDat(DAT_PATHS.cell), portal, 0xA9B40000, { landHeightTable: region.landDefs.landHeightTable });
    const d = g.doors.get(0xA9B40178)!.find((x) => x.b === 0xFFFF)!;
    expect(d.bottom!).toBeCloseTo(68, 1);
    expect(d.grounded).toBe(false);
    // Holtburg's ground-floor doors (the blacksmith's west door, the tavern's) stay grounded.
    expect(g.doors.get(0xA9B4010B)!.find((x) => x.b === 0xFFFF)!.grounded).toBe(true);
    expect(g.doors.get(0xA9B40164)!.find((x) => x.b === 0xFFFF)!.grounded).toBe(true);
  });
});
