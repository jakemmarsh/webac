/**
 * BUG.walkin-cave-invisible-walls (AC1999, Jake 2026-11-01) — "the entrance to
 * the cave [whose portal is the Old Warehouse] … was hard to run through,
 * seemed to have invisible wall(s)".
 *
 * The cave is landblock 0xC88A (8.7N 58.1E). Its mouth is a building (GfxObj
 * 0x010011A9 at (12, 60, 64), turned 180°) whose one portal leads into
 * 0xC88A0104: a doorway cell 2 m wide (x 11–13), a slab between leaning
 * faces only 0.1–0.3 m deep at mid-height (y ~63.5–63.9), whose floor rises 0.12 m from the grass. Then 0x103, 0x102, the ramp 0x101
 * and the portal room 0x100 (floor 58.8, the Old Warehouse portal at
 * (12, 43.5)), all under the flat terrain at z 64.
 *
 * A step onto the doorway's lip is a step up (CTransition::step_up), whose
 * placement insert tests the mouth's shell with bldg_check: its solid leaves
 * count unless the sphere path hits_interior_cell (BSPTREE::find_collisions
 * @ 0053a440). Retail sets that flag when a body sphere reaches the volume of
 * a cell behind a building's portal (CEnvCell::check_building_transit
 * @ 0052c5d0: CCellStruct::sphere_intersects_cell @ 00533900 not OUTSIDE).
 * Ours set it only when a sphere's CENTRE was in a cell, so on the lip, with
 * both centres still outside 0x104, the shell's solid refused every step up:
 * the player stopped 0.4 m short of the doorway, and a player inside was held
 * at the lip on the way out.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import { sphereIntersectsCell, sphereIntersectsCellBsp } from '../packages/renderer/src/world/cellContainment.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { DAT_PATHS, dataPath } from './_harness/dat.js';

type V3 = [number, number, number];
const IDQ = { w: 1, x: 0, y: 0, z: 0 };

/** The plane chain of a box x −5..5, y −2..2, z −1..4 (CELL BSP: behind any plane = outside). */
function boxCellBsp() {
  const planes: [V3, number][] = [[[1, 0, 0], 5], [[-1, 0, 0], 5], [[0, 1, 0], 2], [[0, -1, 0], 2], [[0, 0, 1], 1], [[0, 0, -1], 4]];
  let node: unknown;
  for (const [[x, y, z], distance] of planes.reverse()) node = { splittingPlane: { normal: { x, y, z }, distance }, posNode: node };
  return node;
}

describe('sphereIntersectsCellBsp — BSPNODE::sphere_intersects_cell_bsp @ 0053c260', () => {
  const bsp = boxCellBsp() as never;
  it('a centre in the cell is inside; a sphere reaching it from outside within radius + 0.01 too', () => {
    expect(sphereIntersectsCellBsp(bsp, { x: 0, y: 0, z: 1 }, 0.48)).toBe(true);
    // Centre 0.488 m west of the x −5 face: the 0.48 sphere + 0.01 slack reaches it.
    expect(sphereIntersectsCellBsp(bsp, { x: -5.488, y: 0, z: 1 }, 0.48)).toBe(true);
    expect(sphereIntersectsCellBsp(bsp, { x: -5.495, y: 0, z: 1 }, 0.48)).toBe(false);
    // Past a corner on two planes each within reach: still not outside (each plane alone decides).
    expect(sphereIntersectsCellBsp(bsp, { x: -5.3, y: 2.3, z: 1 }, 0.48)).toBe(true);
    expect(sphereIntersectsCellBsp(bsp, { x: 0, y: 0, z: 5 }, 0.48)).toBe(false);
  });
  it('sphereIntersectsCell carries the sphere into the cell\'s frame first', () => {
    // The cell turned 180° about z at (100, 0, 0): its x −5 face is at world x 105.
    const turned = { w: 0, x: 0, y: 0, z: 1 };
    expect(sphereIntersectsCell(bsp, { x: 100, y: 0, z: 0 }, turned, { x: 105.4, y: 0, z: 1 }, 0.48)).toBe(true);
    expect(sphereIntersectsCell(bsp, { x: 100, y: 0, z: 0 }, turned, { x: 94.6, y: 0, z: 1 }, 0.48)).toBe(true);
    expect(sphereIntersectsCell(bsp, { x: 100, y: 0, z: 0 }, turned, { x: 105.6, y: 0, z: 1 }, 0.48)).toBe(false);
  });
});

// ── Synthetic doorway: a cell whose floor starts with a 0.12 m lip, under a solid building shell ──

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
  return { vertexArray: { vertices }, polygons, sphere: { origin: { x: c[0], y: c[1], z: c[2] }, radius: r } };
}

/** The doorway cell (box x −5..5): a lip ramp x −5..−4.85 rising 0.12 m, the floor at 0.12 beyond; polygon 2 its west portal. */
function doorwayCell() {
  const m = mesh([
    [[-5, -2, 0], [-4.85, -2, 0.12], [-4.85, 2, 0.12], [-5, 2, 0]],
    [[-4.85, -2, 0.12], [5, -2, 0.12], [5, 2, 0.12], [-4.85, 2, 0.12]],
    [[-5, 2, 3], [-5, -2, 3], [-5, -2, 0], [-5, 2, 0]],
  ]);
  const phys = new Map([[0, m.polygons.get(0)], [1, m.polygons.get(1)]]);
  const leaf = { type: 'LEAF', solid: 0, sphere: m.sphere, inPolys: [0, 1] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { vertexArray: m.vertexArray, polygons: m.polygons, portals: [2], physicsPolygons: phys, physicsBSP: { rootNode: leaf }, cellBSP: { rootNode: boxCellBsp() }, drawingBSP: null } as any;
}

/** A building shell that is one solid leaf around the doorway (the mouth's rock); its one polygon, a wall at x −9.5, is far from the walk. */
function solidShell() {
  const m = mesh([[[-9.5, 3, 3], [-9.5, -3, 3], [-9.5, -3, 0], [-9.5, 3, 0]]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { physicsBSP: { rootNode: { type: 'LEAF', solid: 1, sphere: { origin: { x: -5, y: 0, z: 1 }, radius: 5 }, inPolys: [0] } }, physicsPolygons: m.polygons, vertexArray: m.vertexArray } as any;
}

function world(outsidePortal: boolean): DungeonCollision {
  const dc = new DungeonCollision();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.addCell(0x00000100, doorwayCell(), { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ } as any, outsidePortal ? [2] : []);
  dc.addGfxObjCollision(collisionKey.building(0, 0, 'p', 0), solidShell(), { x: 0, y: 0, z: 0 }, IDQ, 0, 0, 1, { building: true });
  return dc;
}

describe('a step up onto a building doorway\'s lip clears the shell\'s solid once a body sphere reaches the doorway cell', () => {
  it('the body outside the doorway steps up the lip (was: refused by the shell\'s solid)', () => {
    const dc = world(true);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(-5.15, 0, 0), 0.1, 0);
    expect(dx).toBeCloseTo(0.1, 9);
    expect(dz).toBe(0);
    expect(dc.lastStepUp).toBeGreaterThan(0);
  });

  it('a cell no building portal leads into does not clear it: the step is still refused', () => {
    const dc = world(false);
    expect(dc.getAdjustedMovement(new THREE.Vector3(-5.15, 0, 0), 0.1, 0)).toEqual([0, 0]);
  });
});

// ── The real caves: a block's collision world, walked as main.ts walks the player ──

/**
 * A block's collision world (tests/_harness/a9b4-world.ts) and a walker that runs the shipped
 * stepPlayerMovement, floor follow and body-cell tracking as main.ts does (updateSurfaceCellVisibility:
 * DungeonCollision.nextBodyCell, then two frames in no cell before outdoors).
 */
async function caveWorld(bx: number, by: number, dats?: { portal: string; cell: string; ac1999?: boolean }) {
  const OX = bx * 192;
  const OY = by * 192;
  const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
  const base = (await buildLandblockWorld(bx, by, { interiors: true, dats }))({ slidingNormal: null });
  const dc = base.outdoorCollision as DungeonCollision;
  let bodyCell = 0;
  /** main.ts's playerGroundSources / outdoorGroundSources. */
  const sources = (body: boolean): OutdoorGroundSources => ({
    terrainHeight: (a, b) => base.terrain.getHeightAt(a, b),
    floorHeight: body
      ? (a, b, y, m, f) => dc.getBodyFloorHeight(a, b, y, base.stepDownHeight, m, f)
      : (a, b, y, m, f) => dc.getFloorHeight(a, b, y, m, f),
    cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight, bodyCell),
    landReachable: (a, b, f) => dc.reachesLandCells(a, b, f),
  });
  const services: MovementServices = {
    ...base, groundAt: (x, z, fromY) => outdoorGroundY(sources(false), x, z, fromY), landReachable: (x, z, f) => dc.reachesLandCells(x, z, f),
  };
  /** `n` 1/30 s substeps of (dx, dy) m from block-local (x0, y0), feet at f0. `cells`: every body cell held on the way. */
  function walk(x0: number, y0: number, f0: number, n: number, dx: number, dy: number, startCell?: number) {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = f0;
    const src = sources(true);
    bodyCell = startCell ?? dc.findCellContaining(x, z, floorY, 0);
    dc.setBodyCell(bodyCell);
    services.slide!.slidingNormal = null;
    let zeroFrames = 0;
    // The longest run of frames whose feet were in no cell (the old rule put the body outdoors after 2).
    let missRun = 0;
    let maxMissRun = 0;
    const cells = new Set<number>([bodyCell]);
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dy, 1 / 30, services);
      const g = traceGroundAlongPath((a, b, y) => outdoorGroundY(src, a, b, y), x, z, r.x, r.z,
        floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
      missRun = bodyCell !== 0 && dc.findCellContaining(x, z, floorY, bodyCell) === 0 ? missRun + 1 : 0;
      maxMissRun = Math.max(maxMissRun, missRun);
      const found = dc.nextBodyCell(bodyCell, x, z, floorY);
      if (found !== 0) {
        bodyCell = found;
        zeroFrames = 0;
      } else if (bodyCell !== 0 && ++zeroFrames >= 2) {
        bodyCell = 0;
        zeroFrames = 0;
      }
      dc.setBodyCell(bodyCell);
      cells.add(bodyCell);
    }
    return { x: x - OX, y: z - OY, floorY, cell: bodyCell, cells, maxMissRun, land: dc.reachesLandCells(x, z, floorY) };
  }
  return { dc, services, walk, OX, OY };
}

const AC1999 = { portal: dataPath('dat-sets/ac1999-retail/portal.dat'), cell: dataPath('dat-sets/ac1999-retail/cell.dat'), ac1999: true };
const haveDat = existsSync(AC1999.portal) && existsSync(AC1999.cell);

describe.skipIf(!haveDat)('the Old Warehouse cave at 0xC88A (AC1999 DATs)', () => {
  const OX = 0xc8 * 192;
  const OY = 0x8a * 192;
  let world: Awaited<ReturnType<typeof caveWorld>>;
  let dc: DungeonCollision;
  let services: MovementServices;
  const walk = (x0: number, y0: number, f0: number, n: number, dx: number, dy: number) => world.walk(x0, y0, f0, n, dx, dy);

  beforeAll(async () => {
    world = await caveWorld(0xc8, 0x8a, AC1999);
    ({ dc, services } = world);
  }, 120_000);

  it('the cave: the doorway cell 0x104 behind the mouth\'s portal, the portal room 0x100 under the terrain', () => {
    expect(dc.findCellContaining(OX + 12, OY + 63.7, 64.6)).toBe(0xc88a0104);
    expect(dc.findCellContaining(OX + 12, OY + 50, 59.3)).toBe(0xc88a0100);
    expect(services.terrain.getHeightAt(OX + 12, OY + 50)).toBeCloseTo(64, 1);
  });

  it('running in from the grass goes through the mouth, down the ramp, into the portal room (was: stopped at y 64.0)', () => {
    const s = walk(12, 70, 64, 200, 0, -0.1);
    expect(s.cell).toBe(0xc88a0100);
    expect(s.y).toBeLessThan(51);
    expect(s.floorY).toBeCloseTo(58.8, 1);
  });

  it('the whole doorway lane goes in: x 10.5–13.5 from 4 m out', () => {
    for (let x = 10.5; x <= 13.5; x += 0.5) {
      const s = walk(x, 68, 64, 160, 0, -0.1);
      expect(s.cell, `x ${x}`).not.toBe(0);
      expect(s.y, `x ${x}`).toBeLessThan(55);
    }
  });

  it('approaching at an angle within 15° of straight on goes in too (was: 2 of 7)', () => {
    for (let deg = -15; deg <= 15; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const sx = 12 + 6 * Math.sin(a);
      const sy = 64 + 6 * Math.cos(a);
      const len = Math.hypot(12 - sx, 58 - sy);
      const s = walk(sx, sy, 64, 140, ((12 - sx) / len) * 0.1, ((58 - sy) / len) * 0.1);
      expect(s.cell, `${deg}°`).not.toBe(0);
    }
  });

  it('walking out from the portal room climbs the ramp and leaves through the mouth onto the grass (was: held at the lip)', () => {
    const s = walk(12, 52, 58.8, 200, 0, 0.1);
    expect(s.cell).toBe(0);
    expect(s.y).toBeGreaterThan(70);
    expect(s.floorY).toBeCloseTo(64, 1);
  });

  it('the mouth\'s rock still stops a body walking into it from either side of the doorway', () => {
    // From the east, level with the doorway: the shell stops it at x 15.6, outdoors.
    const e = walk(20, 62.5, 64, 120, -0.1, 0);
    expect(e.cell).toBe(0);
    expect(e.x).toBeGreaterThan(15.5);
    // From the west: at x 8.4.
    const w = walk(4, 62.5, 64, 120, 0.1, 0);
    expect(w.cell).toBe(0);
    expect(w.x).toBeLessThan(8.5);
  });
});

describe('nextBodyCell — a body that leaves every cell\'s volume keeps its env cell unless it reaches the land cells', () => {
  // The synthetic doorway cell (box x −5..5, y −2..2), its outside portal across x −5.
  it('past the outside portal: outdoors; in no cell away from it: still the env cell; in a cell: that cell', () => {
    const dc = world(true);
    expect(dc.nextBodyCell(0x100, 0, 0, 0.2)).toBe(0x100);
    // Out through the doorway, within a radius of its plane and well past it.
    expect(dc.nextBodyCell(0x100, -5.3, 0, 0.2)).toBe(0);
    expect(dc.nextBodyCell(0x100, -7.5, 0, 0.2)).toBe(0);
    // Off the north side, far from the doorway: the walls reach past the cell's volume here.
    expect(dc.nextBodyCell(0x100, 0, 2.3, 0.2)).toBe(0x100);
    expect(dc.reachesLandCells(0, 2.3, 0.2)).toBe(true); // no body cell set: everything, as before
    dc.setBodyCell(0x100);
    expect(dc.reachesLandCells(0, 2.3, 0.2)).toBe(false);
    // Outdoors already: outdoors.
    expect(dc.nextBodyCell(0, 0, 2.3, 0.2)).toBe(0);
  });
  it('a cell registered without its portals keeps the old rule (outdoors)', () => {
    const dc = new DungeonCollision();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dc.addCell(0x00000100, doorwayCell(), { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ } as any);
    expect(dc.nextBodyCell(0x100, 0, 2.3, 0.2)).toBe(0);
  });
});

// ── The same mouth on the end-of-retail DATs: 0x482E, the chamber's north-west corner ──

const haveEol = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!haveEol)('the cave mouth at 0x482E (end of retail): the body never leaves the cave for the landscape', () => {
  // Building 0x010011A9 at (132, 132, 6). Doorway 0x149 (the one outside portal, east), the chamber 0x148
  // (floor 6.12), 0x147 over the ramp 0x146 down to the room 0x145 (floor 0.8), under flat terrain at z 6.
  // The lead's live walk (2026-11-01: @teleloc 0x482E002E 147 133.5 9, five "4m west" legs) went
  // 0x148 → 0x147 → outdoor 0x2E with the camera in the rock.
  let world: Awaited<ReturnType<typeof caveWorld>>;
  beforeAll(async () => {
    world = await caveWorld(0x48, 0x2e);
    // The player's StepDownHeight: Setup 0x02000001's 1.5 m (main.ts passes setup.stepDownHeight), not the block
    // harness's 0.6. Since BUG.edge-slide-check-walkable-overhang (2026-11-09) the precipice rule steps the destination
    // down by it (transitional_insert @ 0050b6f0), and the chamber floor's west lip stands ~1 m over the ramp: 0.6 held
    // the walk at the lip, 1.5 (the live body's) walks off it onto the ramp as the old point probe did.
    (world.services as { stepDownHeight: number }).stepDownHeight = 1.5;
  }, 120_000);

  it('one outside portal, 0x149\'s: a cave, not a tunnel', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cells = (world.dc as any).envCells as Map<number, { outsidePlanes?: unknown[] }>;
    const withOutside = [0x145, 0x146, 0x147, 0x148, 0x149].filter((c) => (cells.get((0x482e0000 | c) >>> 0)?.outsidePlanes?.length ?? 0) > 0);
    expect(withOutside).toEqual([0x149]);
  });

  it('running west through the mouth: the chamber\'s west wall stops it at x 128 (no way through the rock)', () => {
    const s = world.walk(147, 133.5, 9, 400, -0.1, 0);
    expect(s.cells.has(0x482e0148)).toBe(true);
    expect(s.cells.has(0)).toBe(true); // the grass it started on
    expect(s.x).toBeGreaterThan(127.7);
    expect(s.cell).toBe(0x482e0148);
    expect(s.land).toBe(false);
    expect(s.floorY).toBeCloseTo(6.12, 1);
  });

  it('down the ramp, the feet cross the seam into the room 0x145 in no cell for frames: the body stays in the cave (was: outdoor 0x2E)', () => {
    for (const [x0, y0, dx, dy] of [[134, 131, -0.0985, -0.0174], [134, 131.5, -0.0866, -0.05]]) {
      const s = world.walk(x0, y0, 6.12, 300, dx, dy, 0x482e0148);
      // The old rule (two frames in no cell → outdoors) put the body on the landscape here.
      expect(s.maxMissRun, `${x0},${y0}`).toBeGreaterThanOrEqual(2);
      expect(s.cells.has(0), `${x0},${y0}`).toBe(false);
      expect(s.cell).toBe(0x482e0145);
      expect(s.floorY).toBeCloseTo(0.8, 1);
      expect(s.land).toBe(false);
    }
  });

  it('the body still leaves by the doorway: from the chamber east onto the grass', () => {
    const s = world.walk(132, 133.5, 6.12, 200, 0.1, 0);
    expect(s.cell).toBe(0);
    expect(s.x).toBeGreaterThan(140);
    expect(s.land).toBe(true);
  });
});
