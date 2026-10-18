/**
 * BUG.bunker-sealed-at-ground — a building's shell is tested from its land
 * cell only. A body in an env cell reaches the land cells (and so the shells)
 * only while one of its spheres lies within its radius of the plane of one of
 * that cell's outside portals (EnvCell::find_transit_cells →
 * LandCell::add_all_outside_cells; ACE EnvCell.cs:311-371, SortCell.cs,
 * BuildingObj.cs). The Holtburg drudge statue's pedestal (GfxObj 0x01002A1B)
 * caps its footprint with a plate at ground level over the ramp down to the
 * Mannikin Foundry room, and that plate stopped a player walking back up
 * (2026-10-18 report: "it seals you in at ground level").
 *
 * Synthetic and DAT-free: the real DungeonCollision with a hand-built room
 * cell (one outside portal on its west wall) and building-shell walls. The
 * real tunnel walk is in verify-bug-holtburg-statue-tunnel-wall.ts.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';

type V3 = [number, number, number];
const IDQ = { w: 1, x: 0, y: 0, z: 0 };

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

/** A wall across x = `x` (y −2..2, z 0..3), its face toward +x. */
const wallAt = (x: number): V3[] => [[x, 2, 3], [x, -2, 3], [x, -2, 0], [x, 2, 0]];

/** A building shell holding one wall at x. */
function shell(x: number) {
  const m = mesh([wallAt(x)]);
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

const CELL = 0x00000100;
const frame = { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ };

function world(withPortals: boolean, ...shellWalls: number[]): DungeonCollision {
  const dc = new DungeonCollision();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.addCell(CELL, room(), frame as any, withPortals ? [1] : undefined);
  shellWalls.forEach((x, i) => dc.addGfxObjCollision(collisionKey.building(0, i, 'p', 0), shell(x), { x: 0, y: 0, z: 0 }, IDQ, 0, 0, 1, { building: true }));
  return dc;
}

/** One 0.1 m step west from AC (x, 0) with the feet at z 0 (THREE: x, y up, z = AC y). */
const stepWest = (dc: DungeonCollision, x: number) => dc.getAdjustedMovement(new THREE.Vector3(x, 0, 0), -0.1, 0)[0];

describe('building shells from inside an env cell (BUG.bunker-sealed-at-ground)', () => {
  it('deep in the cell, away from its outside portal\'s plane, a shell wall is no wall', () => {
    expect(stepWest(world(true, 0), 0.55)).toBeCloseTo(-0.1, 9);
  });

  it('within a sphere radius of the outside portal\'s plane, the shells count again', () => {
    expect(stepWest(world(true, -4.95), -4.45)).toBe(0);
  });

  it('outdoors (in no env cell) a shell wall blocks', () => {
    expect(stepWest(world(true, -8), -7.45)).toBe(0);
  });

  it('a missile swept inside the cell flies through a shell wall there; outdoors it hits one', () => {
    // THREE axes: (AC x, height, AC y). A bolt at 1.5 m flown west from x 2 to x −2 across the shell at x 0.
    expect(world(true, 0).sweepSphere({ x: 2, y: 1.5, z: 0 }, { x: -2, y: 1.5, z: 0 }, 0.25)).toBeNull();
    expect(world(true, -8).sweepSphere({ x: -6, y: 1.5, z: 0 }, { x: -10, y: 1.5, z: 0 }, 0.25)).not.toBeNull();
  });

  it('a cell registered without its portals keeps every shell (the old rule)', () => {
    expect(stepWest(world(false, 0), 0.55)).toBe(0);
  });
});

/**
 * BUG.ramp-sliding-normal-stuck — a walkable face is never carried as the sliding normal. Retail keeps the
 * 3-D normal and steps along the contact plane (CTransition::adjust_offset @ 0050a370), so a step up a ramp
 * never pushes into the ramp's own normal; flattened to (0, 1) it stopped every uphill step on the Yaraq
 * statue ramp for good once one step-up failed.
 */
describe('the sliding normal a blocked step leaves (BUG.ramp-sliding-normal-stuck)', () => {
  /** A source of one polygon, as a building-free static. */
  function only(poly: V3[]) {
    const dc = new DungeonCollision();
    const m = mesh([poly]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dc.addGfxObjCollision('test', { physicsBSP: { rootNode: m.leaf }, physicsPolygons: m.polygons, vertexArray: m.vertexArray } as any, { x: 0, y: 0, z: 0 }, IDQ, 0, 0);
    return dc;
  }

  it('a wall the step runs into is the sliding normal', () => {
    const dc = only(wallAt(0));
    dc.getAdjustedMovement(new THREE.Vector3(0.55, 0, 0), -0.1, 0.05);
    expect(dc.collisionNormal).not.toBeNull();
    expect(dc.collisionNormal!.x).toBeCloseTo(1, 6);
  });

  it('a walkable ramp face the feet run into (its step-up refused) is not', () => {
    // A 36° ramp (normal z 0.81) rising westward from x 0: 2 m up over 2.75 m, too high to step onto at once.
    const dc = only([[0, -2, 0], [0, 2, 0], [-2.75, 2, 2], [-2.75, -2, 2]]);
    dc.getAdjustedMovement(new THREE.Vector3(0.6, -1.5, 0), -0.3, 0);
    expect(dc.collisionNormal).toBeNull();
  });
});
