/**
 * HARNESS.first-hour-stairs — tools/lib/cell-path.ts, the cell-graph router
 * probe-first-hour walks to reach the academy's upper floor.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CellGraph, OPENING_MIN_HEIGHT_M, findRoute, findRouteViaOutside, frameToParent, loadCellGraph, onLevel, walkableExit, yawToward } from '../tools/lib/cell-path.ts';
import { DAT_PATHS, openDat } from './_harness/dat.js';

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
    const direct = findRoute(g, 0x860202C5, v(129, -140, 0), 0x86020169, to)!;
    expect(direct.some((p) => p.floor && Math.hypot(p.x - 130, p.y + 140, p.z) < 0.01)).toBe(true);
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
