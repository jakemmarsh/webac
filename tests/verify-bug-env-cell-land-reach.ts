/**
 * BUG.env-cell-land-reach — a body in an env cell (cell id & 0xffff >= 0x100)
 * reaches the landscape (the terrain's height, slope and water rules, and
 * the land cells' objects: building shells, landblock statics, scenery) only
 * while one of its spheres lies within its radius of the plane of one of
 * that cell's outside portals: CEnvCell::find_transit_cells @ 0052c820 →
 * CLandCell::add_all_outside_cells (ACE EnvCell.cs:311-371), and
 * CLandCell::find_env_collisions @ 00532f20 runs only for the land cells in
 * the cell array. "In a cell" is the cell, never the floor's height against
 * the terrain. The sweep after BUG.holtburg-statue-tunnel-wall /
 * BUG.bunker-sealed-at-ground found the same shape in:
 *  - stepPlayerMovement's slope / open-sea / precipice gates (a room whose
 *    floor is at or above the terrain obeyed the terrain's rules);
 *  - the steep-slope slide's contact (main.ts unwalkableTerrainContact →
 *    outdoorGround.unwalkableTerrainNormal);
 *  - outdoorGroundY's floor-search miss in a cell (the feet snapped up
 *    through a cellar's ceiling onto the grass; retail has no contact plane
 *    and the body falls to the walkable below);
 *  - DungeonCollision's floor queries (floor search, step-down contact, floor
 *    normal, precipice edge, a falling object's floorBelow, spheresOverlap),
 *    which tested the shells from inside a cell: a jump under the drudge
 *    statue's pedestal lid (0x01002A1B) was clamped by it;
 *  - remote creatures walking on their own MoveTo into the ramp's env cell
 *    kept their land cell and followed the terrain over it (RemotePhysics).
 *
 * Synthetic cases run on CI; the DAT cases use the real Holtburg statue ramp
 * (end of retail) and the classic bunker (Dark Majesty DATs).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LandWaterType } from '@ac/shared';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, unwalkableTerrainNormal, standsOnTerrain, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { RemotePhysicsObject, landCellAt, type RemotePhysicsEnv } from '../packages/renderer/src/world/RemotePhysics.js';
import { DAT_PATHS } from './_harness/dat.js';

type V3 = [number, number, number];
const IDQ = { w: 1, x: 0, y: 0, z: 0 };

describe('outdoorGroundY — in an env cell away from its outside portals the terrain is never the ground', () => {
  const src = (floor: (drop?: number) => number | null, reach: boolean): OutdoorGroundSources => ({
    terrainHeight: () => 80,
    floorHeight: (_x, _z, _y, drop) => floor(drop),
    cellAt: () => 0xa9b40185,
    landReachable: () => reach,
  });

  it('a floor-search miss in a cellar: the walkable below, not the terrain over its ceiling', () => {
    // The search window holds no floor; the room's floor lies further down.
    const s = src((drop) => (drop === Infinity ? 73.7 : null), false);
    expect(outdoorGroundY(s, 0, 0, 79)).toBe(73.7);
    // Near an outside portal the land cells are in reach: the terrain (as before).
    expect(outdoorGroundY(src((drop) => (drop === Infinity ? 73.7 : null), true), 0, 0, 79)).toBe(80);
  });

  it('nothing walkable under the body at all: the fallback (the floor it stood on), else none', () => {
    expect(outdoorGroundY(src(() => null, false), 0, 0, 74, { fallbackY: 73.7 })).toBe(73.7);
    expect(outdoorGroundY(src(() => null, false), 0, 0, 74)).toBeNull();
  });

  it('a room floor 0.3 m under the terrain is the floor, not the terrain', () => {
    expect(outdoorGroundY(src(() => 79.7, false), 0, 0, 79.7)).toBe(79.7);
    // A foundation in no cell, 0.3 m under the grass: the terrain (unchanged).
    expect(outdoorGroundY({ ...src(() => 79.7, true), cellAt: () => 0 }, 0, 0, 79.7)).toBe(80);
  });

  it('the cell is asked for the body\'s feet: bodyFeetY when the search starts at the head', () => {
    const asked: number[] = [];
    const s: OutdoorGroundSources = {
      terrainHeight: () => 66, floorHeight: () => null,
      landReachable: (_x, _z, f) => { asked.push(f); return false; },
    };
    expect(outdoorGroundY(s, 0, 0, 64.8, { bodyFeetY: 63 })).toBeNull();
    expect(asked).toEqual([63]);
  });
});

describe('stepPlayerMovement — a room at or above the terrain does not obey the terrain\'s rules', () => {
  /** Rising, unwalkable (and optionally open-sea) terrain; the body's floor `floorAt(x)`; `reach` = landReachable. */
  function services(floorAt: (x: number) => number, reach: boolean | undefined, water = LandWaterType.NotWater): MovementServices {
    const collider = { getAdjustedMovement: (_p: unknown, dx: number, dz: number): [number, number] => [dx, dz], playerRadius: 0.48, lastStepUp: 0 };
    return {
      dungeonCollision: null, outdoorCollision: collider,
      terrain: { isWalkable: () => false, getHeightAt: (x) => 66 + x, getTriangleNormalAt: () => ({ x: -0.7071, y: 0.7071, z: 0 }) },
      water: { blockWaterTypeAt: () => water },
      creatureObstacles: null, defaultPlayerRadius: 0.48, edgeSlide: false, stepDownHeight: 0.6,
      groundAt: (x) => floorAt(x),
      ...(reach === undefined ? {} : { landReachable: () => reach }),
    };
  }
  const state = (floorY: number) => ({ x: 0, z: 0, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 });
  const level = () => 66;
  const onTerrain = (x: number) => 66 + x;

  it('a ground-floor room whose level floor meets the slope: the step is walked (on the open slope it is refused)', () => {
    expect(stepPlayerMovement(state(66), 0.1, 0, 1 / 30, services(level, false)).x).toBeCloseTo(0.1, 9);
    expect(stepPlayerMovement(state(66), 0.1, 0, 1 / 30, services(onTerrain, true)).x).toBe(0);
  });

  it('a floor in a room that lies exactly on the terrain is still the room\'s, not the slope\'s', () => {
    expect(stepPlayerMovement(state(66), 0.1, 0, 1 / 30, services(onTerrain, false)).x).toBeCloseTo(0.1, 9);
  });

  it('a BSP floor over the slope (a bridge, a porch) is the contact there: the slope does not refuse the step', () => {
    expect(stepPlayerMovement(state(67.5), 0.1, 0, 1 / 30, services(() => 67.5, undefined)).x).toBeCloseTo(0.1, 9);
  });

  it('open sea: refused on the land cell, walked in a room on the block', () => {
    expect(stepPlayerMovement(state(66), 0, 0.1, 1 / 30, services(level, true, LandWaterType.EntirelyWater)).z).toBe(0);
    expect(stepPlayerMovement(state(66), 0, 0.1, 1 / 30, services(level, false, LandWaterType.EntirelyWater)).z).toBeCloseTo(0.1, 9);
  });
});

describe('unwalkableTerrainNormal — the steep-slope slide never starts in a room', () => {
  const STEEP = { x: -0.866, y: 0.5, z: 0 };
  const src = (reach: boolean, cell = 0) => ({
    terrainHeight: () => 66, terrainNormal: () => STEEP, cellAt: () => cell, landReachable: () => reach,
  });
  it('on the open slope the face is the contact; on a room floor level with it, never', () => {
    expect(unwalkableTerrainNormal(src(true), 0, 0, 66, 0.66)).toEqual(STEEP);
    expect(unwalkableTerrainNormal(src(false, 0x0100), 0, 0, 66, 0.66)).toBeNull();
  });
  it('the other contacts are unchanged: a BSP floor over it, an interior floor under it, a walkable face', () => {
    expect(unwalkableTerrainNormal(src(true), 0, 0, 67, 0.66)).toBeNull();
    expect(unwalkableTerrainNormal(src(true, 0x0100), 0, 0, 64, 0.66)).toBeNull();
    expect(unwalkableTerrainNormal({ ...src(true), terrainNormal: () => ({ x: 0, y: 1, z: 0 }) }, 0, 0, 66, 0.66)).toBeNull();
  });
});

// ── The synthetic room: DungeonCollision with a hand-built env cell and building-shell sources ──

/** Polygons + vertex array in the DAT's shapes, one BSP leaf holding every physics polygon. */
function mesh(polys: V3[][]) {
  const vertices = new Map<number, unknown>();
  const polygons = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const idx: number[] = [];
    for (const [x, y, z] of p) { vertices.set(vi, { origin: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(vi++); }
    polygons.set(pi, { vertexIndices: idx, numPts: idx.length, stippling: 0, sidesType: 0, posSurface: 0, negSurface: 0, posUVIndices: [], negUVIndices: [] });
  });
  const pts = polys.flat();
  const c = pts.reduce((a, [x, y, z]) => [a[0] + x / pts.length, a[1] + y / pts.length, a[2] + z / pts.length], [0, 0, 0]);
  const r = Math.max(...pts.map(([x, y, z]) => Math.hypot(x - c[0], y - c[1], z - c[2])));
  const leaf = { type: 'LEAF', solid: 0, sphere: { origin: { x: c[0], y: c[1], z: c[2] }, radius: r }, inPolys: [...polygons.keys()] };
  return { vertexArray: { vertices }, polygons, leaf };
}

/** A building shell of these polygons. */
function shell(polys: V3[][]) {
  const m = mesh(polys);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { physicsBSP: { rootNode: m.leaf }, physicsPolygons: m.polygons, vertexArray: m.vertexArray } as any;
}

/** The plane chain of a box x −5..5, y −2..2, z −1..4 (CELL BSP: Behind any plane = outside). */
function boxCellBsp() {
  const planes: [V3, number][] = [[[1, 0, 0], 5], [[-1, 0, 0], 5], [[0, 1, 0], 2], [[0, -1, 0], 2], [[0, 0, 1], 1], [[0, 0, -1], 4]];
  let node: unknown;
  for (const [[x, y, z], distance] of planes.reverse()) node = { splittingPlane: { normal: { x, y, z }, distance }, posNode: node };
  return node;
}

/** The room cell: a floor at z 0, and polygon 1 its outside portal across the west end (x −5). */
function room() {
  const m = mesh([
    [[-5, -2, 0], [5, -2, 0], [5, 2, 0], [-5, 2, 0]],
    [[-5, 2, 3], [-5, -2, 3], [-5, -2, 0], [-5, 2, 0]],
  ]);
  const floorOnly = new Map([[0, m.polygons.get(0)]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { vertexArray: m.vertexArray, polygons: m.polygons, portals: [1], physicsPolygons: floorOnly, physicsBSP: { rootNode: { ...m.leaf, inPolys: [0] } }, cellBSP: { rootNode: boxCellBsp() }, drawingBSP: null } as any;
}

/** A level plate (a pedestal's lid) over x −1..1 at height z, its walkable face up. */
const plate = (z: number, x0 = -1, x1 = 1): V3[] => [[x0, -1, z], [x1, -1, z], [x1, 1, z], [x0, 1, z]];
/** A wall across x = `x` (y −2..2, z 0..3). */
const wallAt = (x: number): V3[] => [[x, 2, 3], [x, -2, 3], [x, -2, 0], [x, 2, 0]];

/** The room with a shell lid at z 2.5 over its middle, a lid outdoors at x −8, and shell walls at x 0 and x −8. */
function world(key: (i: number) => string = (i) => collisionKey.building(0, i, 'p', 0), building = true): DungeonCollision {
  const dc = new DungeonCollision();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.addCell(0x00000100, room(), { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ } as any, [1]);
  [shell([plate(2.5)]), shell([plate(2.5, -9, -7)]), shell([wallAt(0.3)]), shell([wallAt(-8)])].forEach((s, i) =>
    dc.addGfxObjCollision(key(i), s, { x: 0, y: 0, z: 0 }, IDQ, 0, 0, 1, { building }));
  return dc;
}

describe('DungeonCollision floor queries from inside an env cell skip the land cells\' sources', () => {
  it('the floor search from the head (a jump under the lid) finds the room floor, not the lid; outdoors the lid', () => {
    const dc = world();
    // Feet on the room floor at x 0.6 (deep in the cell), head at 1.8.
    expect(dc.getFloorHeight(0.6, 0, 1.8, undefined, 0)).toBeCloseTo(0, 6);
    expect(dc.getFloorHeight(-8, 0, 1.8, undefined, 0)).toBeCloseTo(2.5, 6);
  });

  it('a body in the cell never stands on the lid: the step-down contact and the body floor are the room\'s', () => {
    const dc = world();
    expect(dc.stepDownContact(0.6, 0, 2.5, 0.6)).toBeNull();
    expect(dc.getBodyFloorHeight(0.6, 0, 2.5, 0.6)).toBeCloseTo(0, 6);
    // Outdoors on the lid at x −8 the lid is the contact.
    expect(dc.stepDownContact(-8, 0, 2.5, 0.6)?.y).toBeCloseTo(2.5, 6);
  });

  it('the contact normal and the precipice edge are not the lid\'s', () => {
    const dc = world();
    expect(dc.getFloorNormal(0.6, 0, 2.5)).toBeNull();
    expect(dc.precipiceEdge(0.6, 0, 2.5, 0.7, 0)).toBeNull();
    expect(dc.getFloorNormal(-8, 0, 2.5)).not.toBeNull();
  });

  it('a falling object\'s floorBelow and spheresOverlap are judged by its own spheres', () => {
    const dc = world();
    const inCell = [{ x: 0.6, y: 0, z: 3.0, radius: 0.2 }];
    expect(dc.floorBelow(0.6, 0, 3.0, inCell)).toBeCloseTo(0, 6);
    expect(dc.floorBelow(-8, 0, 3.0, [{ x: -8, y: 0, z: 3.0, radius: 0.2 }])).toBeCloseTo(2.5, 6);
    // A sphere through the shell wall at x 0.3, deep in the cell: no overlap; outdoors through the wall at −8: overlap.
    expect(dc.spheresOverlap([{ x: 0.3, y: 0, z: 1, radius: 0.3 }])).toBe(false);
    expect(dc.spheresOverlap([{ x: -8, y: 0, z: 1, radius: 0.3 }])).toBe(true);
  });

  it('landblock statics and scenery are land-cell sources too; an env cell\'s own statics are not', () => {
    const st = world((i) => collisionKey.landblockStatic(0, i, 'p', 0), false);
    expect(st.getFloorHeight(0.6, 0, 1.8, undefined, 0)).toBeCloseTo(0, 6);
    const sc = world((i) => collisionKey.scenery(0, i, 'p', 0), false);
    expect(sc.getFloorHeight(0.6, 0, 1.8, undefined, 0)).toBeCloseTo(0, 6);
    const cs = world((i) => collisionKey.cellStatic(0x100, i, 'p', 0), false);
    expect(cs.getFloorHeight(0.6, 0, 1.8, undefined, 0)).toBeCloseTo(2.5, 6);
  });

  it('reachesLandCells: deep in the cell no, within a sphere radius of the outside portal yes, outdoors yes', () => {
    const dc = world();
    expect(dc.reachesLandCells(0.6, 0, 0)).toBe(false);
    expect(dc.reachesLandCells(-4.7, 0, 0)).toBe(true);
    expect(dc.reachesLandCells(-8, 0, 0)).toBe(true);
  });
});

describe('a remote creature walking on its own motion into an env cell takes that cell and its floor', () => {
  const ROOM_CELL = 0xa9b40177;
  const BASE_X = 0xa9 * 192, BASE_Y = 0xb4 * 192;
  /** The terrain rises 1 m per m north; north of y 10 is the ramp cell, whose floor falls 0.5 m per m. */
  const env: RemotePhysicsEnv = {
    terrainHeight: (_x, y) => 66 + (y - BASE_Y),
    surfaceCellAt: (_x, y) => (y - BASE_Y > 10 ? ROOM_CELL : 0),
    holdsSurfaceCell: (cell) => cell === ROOM_CELL,
    surfaceFloorZ: (_x, y) => 76 - 0.5 * (y - BASE_Y - 10),
  };
  function walkNorth(from: number, z: number, frames: number, cell: number) {
    const b = new RemotePhysicsObject({ position: { cell, pos: { x: BASE_X + 50, y: BASE_Y + from, z }, orient: IDQ }, state: 0 });
    for (let i = 0; i < frames; i++) b.update(1 / 30, { origin: { x: 0, y: 0.1, z: 0 }, orientation: { ...IDQ } }, env, i / 30);
    return b;
  }

  it('across the doorway the cell becomes the ramp\'s and the body follows its floor, not the terrain over it', () => {
    const b = walkNorth(9, 75, 40, landCellAt(BASE_X + 50, BASE_Y + 9));
    expect(b.position().cell).toBe(ROOM_CELL);
    expect(b.pos.y - BASE_Y).toBeGreaterThan(12.5);
    expect(b.pos.z).toBeCloseTo(76 - 0.5 * (b.pos.y - BASE_Y - 10), 6);
  });

  it('walking back out it takes the land cell again and follows the terrain', () => {
    const b = new RemotePhysicsObject({ position: { cell: ROOM_CELL, pos: { x: BASE_X + 50, y: BASE_Y + 11, z: 75.5 }, orient: { w: 0, x: 0, y: 0, z: 1 } }, state: 0 });
    for (let i = 0; i < 30; i++) b.update(1 / 30, { origin: { x: 0, y: 0.1, z: 0 }, orientation: { ...IDQ } }, env, i / 30);
    expect(b.pos.y - BASE_Y).toBeLessThan(9);
    expect(b.position().cell).toBe(landCellAt(b.pos.x, b.pos.y));
    expect((b.position().cell & 0xffff) < 0x100).toBe(true);
  });

  it('a dungeon\'s cell (one the landscape does not hold) keeps the server\'s cell and height', () => {
    const b = walkNorth(11, 50, 20, 0x01d20150);
    expect(b.position().cell).toBe(0x01d20150);
    expect(b.pos.z).toBe(50);
  });

  it('landCellAt numbers the land cells 1 + 8·column + row', () => {
    expect(landCellAt(BASE_X + 108, BASE_Y + 84)).toBe(0xa9b40024);
    expect(landCellAt(BASE_X + 0.5, BASE_Y + 191.5)).toBe(0xa9b40008);
  });
});

// ── DAT cases ──

const haveEol = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!haveEol)('the Holtburg drudge statue ramp (A9B4 0x177) under the pedestal', () => {
  let dc: DungeonCollision;
  let OX = 0;
  let OY = 0;
  let services: MovementServices;
  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    OX = A9B4.OX;
    OY = A9B4.OY;
    services = (await buildA9b4World({ interiors: true }))({ slidingNormal: null });
    dc = services.outdoorCollision as DungeonCollision;
  }, 120_000);

  /** main.ts's outdoorGroundSources. */
  const sources = (): OutdoorGroundSources => ({
    terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
    floorHeight: (a, b, y, drop, feet) => dc.getFloorHeight(a, b, y, drop, feet),
    cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight),
    landReachable: (a, b, f) => dc.reachesLandCells(a, b, f),
  });

  it('a body on the ramp finds no floor on the pedestal\'s top (z 72.8, a building shell) over it', () => {
    const x = OX + 66, y = OY + 156.7;
    const feet = dc.getBodyFloorHeight(x, y, 63.5, 0.6)!;
    expect(feet).toBeCloseTo(63.5, 1);
    expect(dc.findCellContaining(x, y, feet + dc.lowerSphereHeight)).toBe(0xa9b40177);
    // The pedestal's top is a walkable over the ramp.
    expect(dc.floorPlanesAt(x, y, 0.6)[0].y).toBeCloseTo(72.8, 1);
    // Searched from 71 for the body whose feet are on the ramp's cell, deep from its outside portal (pre-fix: 72.8).
    expect(dc.reachesLandCells(x, y, feet)).toBe(false);
    expect(dc.getFloorHeight(x, y, 71, undefined, feet)).toBeNull();
    expect(outdoorGroundY(sources(), x, y, 71, { bodyFeetY: feet })).toBeCloseTo(feet, 1);
    // The same search for a body out on the town's ground (no cell) finds the pedestal's top.
    expect(dc.getFloorHeight(x, y, 71, undefined, 71)).toBeCloseTo(72.8, 1);
  });
});

const CLASSIC = {
  portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'),
  cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat'),
};
const haveClassic = existsSync(CLASSIC.portal) && existsSync(CLASSIC.cell);
const STAIRS_CELL = 0xa9b40187;

describe.skipIf(!haveClassic)('the classic Holtburg bunker (A9B4 0x185 room, 0x188 hut): the cell decides, not the heights', () => {
  let dc: DungeonCollision;
  let services: MovementServices;
  const OX = 0xa9 * 192;
  const OY = 0xb4 * 192;
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    services = (await buildLandblockWorld(0xa9, 0xb4, { interiors: true, dats: CLASSIC }))({ slidingNormal: null });
    dc = services.outdoorCollision as DungeonCollision;
  }, 120_000);

  const sources = (): OutdoorGroundSources => ({
    terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
    floorHeight: (a, b, y, drop, feet) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight, drop, feet),
    cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight),
    landReachable: (a, b, f) => dc.reachesLandCells(a, b, f),
  });

  it('deep in the portal room the body has no land cell; a floor-search miss there finds the room floor, not the terrain', () => {
    const x = OX + 108, y = OY + 70;
    expect(dc.findCellContaining(x, y, 73.7 + dc.lowerSphereHeight)).toBe(0xa9b40185);
    // A search starting 6 m up (no walkable in its window under the hut's level) used to land on the terrain at z 80+.
    const g = outdoorGroundY(sources(), x, y, 79.9, { bodyFeetY: 73.7 });
    expect(g, 'ground').not.toBeNull();
    expect(g!).toBeLessThan(79);
    expect(dc.reachesLandCells(x, y, 73.7)).toBe(false);
  });

  it('a jump on the stairs under the hut meets the hut\'s own ceiling, not its shell\'s roof top (z 84.05)', () => {
    const x = OX + 108, y = OY + 83;
    const feet = dc.getBodyFloorHeight(x, y, 78.2, 0.6)!;
    expect(feet).toBeCloseTo(78.15, 1);
    expect(dc.findCellContaining(x, y, feet + dc.lowerSphereHeight)).toBe(STAIRS_CELL);
    expect(dc.floorPlanesAt(x, y, 0.6)[0].y).toBeCloseTo(84.05, 1);
    // floorAtHead with the head 4 m over a standing head: pre-fix the roof top, 84.05.
    const head = feet + dc.playerHeight + 4;
    expect(dc.getFloorHeight(x, y, head, undefined, feet)).toBeNull();
    const over = outdoorGroundY(sources(), x, y, head, { bodyFeetY: feet });
    expect(over === null || over <= feet + 1, `storey over the head at ${over}`).toBe(true);
  });
});

describe('standsOnTerrain — the wade, the terrain contact plane and the camera\'s alignment', () => {
  const src = (reach?: boolean) => ({ terrainHeight: () => 66, ...(reach === undefined ? {} : { landReachable: () => reach }) });
  it('on the terrain\'s height on the land cell: yes; on a room floor level with it: no; off its height: no', () => {
    expect(standsOnTerrain(src(true), 0, 0, 66)).toBe(true);
    expect(standsOnTerrain(src(), 0, 0, 66)).toBe(true);
    expect(standsOnTerrain(src(false), 0, 0, 66)).toBe(false);
    expect(standsOnTerrain(src(true), 0, 0, 66.5)).toBe(false);
  });
});
