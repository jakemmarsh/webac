/**
 * REND.collision-key-collisions + REND.scenery-collision-never-removed —
 * DungeonCollision's source registry:
 *  - structured string keys (collisionKey.*) can't alias each other or an
 *    EnvCell id the way the old packed numbers (blockKey*10000 +
 *    totalModelsPlaced*10 + pi, *10+pi at ≥10 parts, 32-bit-truncated
 *    scenery keys) did;
 *  - removeKey retires a BSP cell, cylinder or sphere alike (per-landblock
 *    scenery cleanup);
 *  - the XZ spatial grid (CollisionGrid) is invisible: every query answers
 *    exactly what the linear scan answered (DAT-backed Holtburg check too).
 * All behavioural: drives the real DungeonCollision / CollisionGrid.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makePlane } from '@ac/shared';
import type { PhysicsPolygon } from '@ac/shared';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import { CollisionGrid, type GridEntry } from '../packages/renderer/src/world/CollisionGrid.js';
import { openDat } from './_harness/dat.js';

type V3 = [number, number, number];
function quad(a: V3, b: V3, c: V3, d: V3): PhysicsPolygon {
  const vertices = [a, b, c, d].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

/** Minimal GfxObj with one BSP leaf holding `polys`, bounding sphere enclosing them. */
function mockGfx(polys: PhysicsPolygon[]) {
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  let cx = 0, cy = 0, cz = 0, n = 0;
  polys.forEach((p, pi) => {
    const idx: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(vi++); cx += v.x; cy += v.y; cz += v.z; n++; }
    physicsPolygons.set(pi, { vertexIndices: idx, numVertices: idx.length, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  cx /= n; cy /= n; cz /= n;
  let r = 0;
  for (const p of polys) for (const v of p.vertices) r = Math.max(r, Math.hypot(v.x - cx, v.y - cy, v.z - cz));
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: cx, y: cy, z: cz }, radius: r }, inPolys: [...physicsPolygons.keys()] } },
    physicsPolygons,
    vertexArray: { vertices },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A 2×2 m box (4 walls, open top) + a floor slab at z=0.5, centred on the local origin. */
function boxGfx() {
  return mockGfx([
    // Walls wound so their normals face OUT of the box (toward an approaching body).
    quad([1, 1, 2], [1, -1, 2], [1, -1, 0], [1, 1, 0]),
    quad([-1, -1, 2], [-1, 1, 2], [-1, 1, 0], [-1, -1, 0]),
    quad([-1, 1, 2], [1, 1, 2], [1, 1, 0], [-1, 1, 0]),
    quad([1, -1, 2], [-1, -1, 2], [-1, -1, 0], [1, -1, 0]),
    quad([-1, -1, 0.5], [1, -1, 0.5], [1, 1, 0.5], [-1, 1, 0.5]),
  ]);
}

const IDQ = { w: 1, x: 0, y: 0, z: 0 };

describe('collisionKey — structured keys never alias', () => {
  it('distinct (block, object, part) triples give distinct keys, including the old *10+pi overflow cases', () => {
    // Old: oi*10 + pi → (1, 10) and (2, 0) both packed to 20.
    expect(collisionKey.landblockStatic(0xa9b4, 1, 'p', 10)).not.toBe(collisionKey.landblockStatic(0xa9b4, 2, 'p', 0));
    // Old: blockKey*10000 + totalModelsPlaced*10 → a global count ≥ 1000 spilled into the next block.
    expect(collisionKey.building(0xa9b4, 1000, 'p', 0)).not.toBe(collisionKey.building(0xa9b5, 0, 'p', 0));
    expect(collisionKey.cellStatic(0xa9b40100, 1, 'p', 10)).not.toBe(collisionKey.cellStatic(0xa9b40100, 2, 'p', 0));
    // Old: (landblockId*10000 + idx) >>> 0 truncated to 32 bits.
    expect(collisionKey.scenery(0xa9b4ffff, 1, 'c', 0)).not.toBe(collisionKey.scenery(0xa9b5ffff, 1, 'c', 0));
    expect(collisionKey.scenery(0xa9b4ffff, 1, 'c', 0)).not.toBe(collisionKey.scenery(0xa9b4ffff, 1, 's', 0));
  });

  it('a building source never overwrites an EnvCell registered under a colliding number', () => {
    const dc = new DungeonCollision();
    const gfx = boxGfx();
    const cellId = 0xa9b40100;
    dc.addGfxObjCollision(cellId, gfx, { x: 10, y: 10, z: 0 }, IDQ, 0, 0);
    dc.addGfxObjCollision(collisionKey.building(0xa9b4, 0, 'p', 0), gfx, { x: 50, y: 50, z: 0 }, IDQ, 0, 0);
    expect(dc.cellCount).toBe(2);
    // Both boxes still block.
    expect(dc.getAdjustedMovement(new THREE.Vector3(10, 0, 7), 0, 2)).toEqual([0, 0]);
    expect(dc.getAdjustedMovement(new THREE.Vector3(50, 0, 47), 0, 2)).toEqual([0, 0]);
  });
});

describe('removeKey — per-landblock retirement of every source kind', () => {
  it('removes BSP cells, cylinders and spheres by key', () => {
    const dc = new DungeonCollision();
    const k1 = collisionKey.scenery(0xa9b4ffff, 1, 'p', 0);
    const k2 = collisionKey.scenery(0xa9b4ffff, 2, 'c', 0);
    const k3 = collisionKey.scenery(0xa9b4ffff, 3, 's', 0);
    dc.addGfxObjCollision(k1, boxGfx(), { x: 5, y: 5, z: 0 }, IDQ, 0, 0);
    dc.addCylinderObstacle(k2, 20, 20, 1);
    dc.addSphereObstacle(k3, 30, 1, 30, 1);
    expect([dc.cellCount, dc.cylinderCount, dc.sphereCount]).toEqual([1, 1, 1]);
    for (const k of [k1, k2, k3]) dc.removeKey(k);
    expect([dc.cellCount, dc.cylinderCount, dc.sphereCount]).toEqual([0, 0, 0]);
    expect(dc.hasCells).toBe(false);
    // Nothing blocks any more.
    expect(dc.getAdjustedMovement(new THREE.Vector3(20, 0, 17), 0, 2)).toEqual([0, 2]);
  });
});

describe('CollisionGrid', () => {
  interface E extends GridEntry { id: number }
  const e = (id: number, seq: number): E => ({ id, seq, gridCells: [] });

  it('returns entries whose disc reaches the query, in registration order, and forgets removed ones', () => {
    const g = new CollisionGrid<E>();
    const a = e(1, 5), b = e(2, 1), c = e(3, 3);
    g.insert(a, 10, 10, 1);
    g.insert(b, 12, 12, 1);
    g.insert(c, 500, 500, 1);
    expect(g.queryDisc(11, 11, 1).map(x => x.id)).toEqual([2, 1]);
    g.remove(b);
    expect(g.queryDisc(11, 11, 1).map(x => x.id)).toEqual([1]);
  });

  it('a big disc spanning several grid cells is found from any of them; unbounded entries always return', () => {
    const g = new CollisionGrid<E>();
    const big = e(1, 0);
    const inf = e(2, 1);
    g.insert(big, 100, 100, 40);
    g.insert(inf, NaN, NaN, NaN);
    expect(g.queryDisc(65, 100, 0.1).map(x => x.id)).toEqual([1, 2]);
    expect(g.queryDisc(135, 135, 0.1).map(x => x.id)).toEqual([1, 2]);
    expect(g.queryDisc(1000, 1000, 0.1).map(x => x.id)).toEqual([2]);
  });
});

/** Deterministic PRNG so the equivalence sweeps are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('spatial index is invisible — indexed === linear on the same sources', () => {
  it('movement, floor, floor-normal and camera answers match over a random field of boxes + obstacles', () => {
    const r = rng(42);
    const indexed = new DungeonCollision();
    const linear = new DungeonCollision({ spatialIndex: false });
    const gfx = boxGfx();
    for (let i = 0; i < 60; i++) {
      const ox = r() * 150, oy = r() * 150, yaw = r() * Math.PI * 2, scale = 0.5 + r() * 2;
      const q = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
      for (const dc of [indexed, linear]) dc.addGfxObjCollision(`b${i}`, gfx, { x: ox, y: oy, z: 0 }, q, 192, 384, scale);
    }
    for (let i = 0; i < 80; i++) {
      const x = 192 + r() * 150, z = 384 + r() * 150, rad = 0.2 + r() * 2, lo = -1 + r(), hi = 1 + r() * 3;
      for (const dc of [indexed, linear]) dc.addCylinderObstacle(`c${i}`, x, z, rad, lo, hi);
      const sx = 192 + r() * 150, sy = r() * 2, sz = 384 + r() * 150, sr = 0.3 + r();
      for (const dc of [indexed, linear]) dc.addSphereObstacle(`s${i}`, sx, sy, sz, sr);
    }
    // Remove a few to exercise the grid bookkeeping.
    for (const k of ['b3', 'c7', 's11']) { indexed.removeKey(k); linear.removeKey(k); }
    let blocked = 0;
    for (let i = 0; i < 1500; i++) {
      const pos = new THREE.Vector3(192 + r() * 150, r() * 1.5, 384 + r() * 150);
      const dx = (r() - 0.5) * 3, dz = (r() - 0.5) * 3;
      const a = indexed.getAdjustedMovement(pos, dx, dz);
      const b = linear.getAdjustedMovement(pos, dx, dz);
      expect(a).toEqual(b);
      expect(indexed.lastStepUp).toBe(linear.lastStepUp);
      if (a[0] !== dx || a[1] !== dz) blocked++;
      expect(indexed.getFloorHeight(pos.x, pos.z, pos.y + 1)).toBe(linear.getFloorHeight(pos.x, pos.z, pos.y + 1));
      const fy = linear.getFloorHeight(pos.x, pos.z, pos.y + 1);
      if (fy !== null) expect(indexed.getFloorNormal(pos.x, pos.z, fy)).toEqual(linear.getFloorNormal(pos.x, pos.z, fy));
      const yaw = r() * Math.PI * 2;
      expect(indexed.getCameraDistance(pos, Math.sin(yaw), Math.cos(yaw), 12, 0.3))
        .toBe(linear.getCameraDistance(pos, Math.sin(yaw), Math.cos(yaw), 12, 0.3));
    }
    // The sweep actually exercised collisions.
    expect(blocked).toBeGreaterThan(50);
  });
});

const REPO = resolve(__dirname, '..');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('spatial index on real DAT sources (Holtburg 0xA9B4 buildings + cells)', () => {
  let indexed: DungeonCollision;
  let linear: DungeonCollision;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { resolveObjectPhysics, addObjectCollision } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const ecr = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    indexed = new DungeonCollision();
    linear = new DungeonCollision({ spatialIndex: false });
    const [bx, by] = [0xa9, 0xb4];
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(((bx << 24) | (by << 16) | 0xfffe) >>> 0)!));
    for (const dc of [indexed, linear]) {
      info.buildings.forEach((b, bi) => {
        const m = resolveObjectPhysics(b.modelId, src);
        if (m) addObjectCollision(dc, (k, i) => collisionKey.building(0xa9b4, bi, k, i), m, b.frame.origin, b.frame.orientation, 1, bx * 192, by * 192);
      });
      info.objects.forEach((o, oi) => {
        const m = resolveObjectPhysics(o.id, src);
        if (m) addObjectCollision(dc, (k, i) => collisionKey.landblockStatic(0xa9b4, oi, k, i), m, o.frame.origin, o.frame.orientation, 1, bx * 192, by * 192);
      });
      for (let i = 0; i < info.numCells; i++) {
        const id = ((((bx << 24) | (by << 16)) >>> 0) | (0x100 + i)) >>> 0;
        const cd = ecr.getCellCollisionData(id);
        if (cd) dc.addCell(id, cd.cellStruct, cd.position);
      }
    }
  }, 60_000);

  it('movement + floor answers match the linear scan across the town', () => {
    const r = rng(7);
    let hits = 0, floors = 0;
    for (let i = 0; i < 3000; i++) {
      const x = 0xa9 * 192 + r() * 192;
      const z = 0xb4 * 192 + r() * 192;
      const fy = linear.getFloorHeight(x, z, 60 + r() * 30);
      const y = fy ?? 60 + r() * 20;
      if (fy !== null) floors++;
      expect(indexed.getFloorHeight(x, z, y + 0.5)).toBe(linear.getFloorHeight(x, z, y + 0.5));
      const pos = new THREE.Vector3(x, y, z);
      const dx = (r() - 0.5) * 2, dz = (r() - 0.5) * 2;
      const a = indexed.getAdjustedMovement(pos, dx, dz);
      expect(a).toEqual(linear.getAdjustedMovement(pos, dx, dz));
      if (a[0] !== dx || a[1] !== dz) hits++;
      const cellA = indexed.findCellContaining(x, z, y + 0.5);
      expect(cellA).toBe(linear.findCellContaining(x, z, y + 0.5));
    }
    expect(floors).toBeGreaterThan(20);
    expect(hits).toBeGreaterThan(5);
  });
});
