/**
 * BUG.movement-pinned-south-holtburg-slope — static-object collision follows
 * ACE PhysicsObj.FindObjCollisions (Physics/PhysicsObj.cs:381-455):
 *   any part has a physics BSP (CacheHasPhysicsBSP, :263) → part BSPs only,
 *   at GfxObjScale.Z (PhysicsPart.FindObjCollisions, PhysicsPart.cs:52-59);
 *   else Setup CylSpheres (CylSphere.IntersectsSphere(pos, scale));
 *   else Setup Spheres (Sphere.IntersectsSphere(pos, scale));
 *   else NOTHING — the invented "0.4 × max XY extent" / Setup-radius
 *   cylinders that pinned the player in open grass south of Holtburg are gone.
 * Plus the escape rule (an overlapped obstacle never traps the body), the
 * retail scenery frame (ObjectDesc::GetObjFrame / ObjAlign → Frame::
 * set_heading), CPhysicsObj::obj_within_block and the has_building mask.
 * Behavioural throughout: real DungeonCollision / ObjectCollision /
 * SceneryGenerator / SceneryInstancer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makePlane } from '@ac/shared';
import type { PhysicsPolygon } from '@ac/shared';
import { ObjectDesc, Scene } from '@ac/dat-parser';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import {
  resolveObjectPhysics, addObjectCollision, objWithinBlock, type ObjectPhysicsModel,
} from '../packages/renderer/src/world/ObjectCollision.js';
import {
  frameSetHeading, sceneryFrameQuat, vectorHeadingDegrees, buildingCellMask, generateScenery,
  type SceneryPlacement,
} from '../packages/renderer/src/terrain/SceneryGenerator.js';
import { SceneryInstancer } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { openDat } from './_harness/dat.js';

type V3 = [number, number, number];
function quad(a: V3, b: V3, c: V3, d: V3): PhysicsPolygon {
  const vertices = [a, b, c, d].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}
/** GfxObj with a 2×2×2 box physics BSP (outward walls) centred on x/y, z 0..2. */
function boxGfx() {
  const polys = [
    quad([1, 1, 2], [1, -1, 2], [1, -1, 0], [1, 1, 0]),
    quad([-1, -1, 2], [-1, 1, 2], [-1, 1, 0], [-1, -1, 0]),
    quad([-1, 1, 2], [1, 1, 2], [1, 1, 0], [-1, 1, 0]),
    quad([1, -1, 2], [-1, -1, 2], [-1, -1, 0], [1, -1, 0]),
  ];
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const idx: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices: idx, numVertices: 4, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 1 }, radius: 1.8 }, inPolys: [0, 1, 2, 3] } },
    drawingBSP: null,
    physicsPolygons,
    vertexArray: { vertices },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
/** A drawable-only GfxObj (a tree): no physics BSP. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treeGfx = { physicsBSP: null, drawingBSP: { rootNode: { type: 'LEAF', sphere: { origin: { x: 0, y: 0, z: 3 }, radius: 4 } } }, physicsPolygons: new Map(), vertexArray: { vertices: new Map() } } as any;

const IDQ = { w: 1, x: 0, y: 0, z: 0 };
const GFX_TREE = 0x01000010, GFX_BOX = 0x01000011, SETUP_CYL = 0x02000020, SETUP_SPH = 0x02000021, SETUP_BSP_AND_CYL = 0x02000022, SETUP_NONE = 0x02000023;

function setup(parts: number[], extra: Record<string, unknown>) {
  return {
    parts, placementFrames: new Map([[0, { frames: parts.map(() => ({ origin: { x: 0, y: 0, z: 0 }, orientation: IDQ })) }]]),
    defaultScale: [], parentIndex: [], cylSpheres: [], spheres: [],
    sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 0 }, ...extra,
  };
}
const SOURCES = {
  loadGfxObj: (id: number) => (id === GFX_TREE ? treeGfx : id === GFX_BOX ? boxGfx() : null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadSetupModel: (id: number): any => ({
    [SETUP_CYL]: setup([GFX_TREE], { cylSpheres: [{ origin: { x: 1, y: 0, z: 0.5 }, radius: 0.5, height: 2 }] }),
    [SETUP_SPH]: setup([GFX_TREE], { spheres: [{ origin: { x: 0, y: 0, z: 1 }, radius: 0.5 }], sortingSphere: { origin: { x: 0, y: 0, z: 1 }, radius: 0.5 } }),
    [SETUP_BSP_AND_CYL]: setup([GFX_BOX], { cylSpheres: [{ origin: { x: 5, y: 0, z: 0 }, radius: 1, height: 3 }] }),
    [SETUP_NONE]: setup([GFX_TREE], { radius: 3, height: 10 }),
  } as Record<number, unknown>)[id] ?? null,
};

function place(dc: DungeonCollision, objId: number, origin = { x: 50, y: 50, z: 0 }, quat = IDQ, scale = 1) {
  const model = resolveObjectPhysics(objId, SOURCES)!;
  return addObjectCollision(dc, (k, i) => collisionKey.scenery(0x1234ffff, 1, k, i), model, origin, quat, scale, 0, 0);
}

/**
 * Step the feet along +Z (AC +Y) from 3 m south of world (x, z) to 0.6 m
 * short of it (collision tests the destination, so the probe must end where
 * the body sphere touches a wall of a ≥1 m obstacle, not deep inside it);
 * true if the step is stopped short.
 */
function blockedApproaching(dc: DungeonCollision, x: number, z: number, y = 0): boolean {
  const [ax, az] = dc.getAdjustedMovement(new THREE.Vector3(x, y, z - 3), 0, 2.4);
  return !(ax === 0 && az === 2.4);
}

describe('FindObjCollisions rules — which sources an object registers', () => {
  it('a BSP-less GfxObj (a tree) registers NO collision', () => {
    const dc = new DungeonCollision();
    expect(place(dc, GFX_TREE)).toEqual([]);
    expect(dc.hasCells).toBe(false);
  });

  it('a Setup with no BSP, cylspheres or spheres registers nothing (its bounding radius is NOT an obstacle)', () => {
    const dc = new DungeonCollision();
    expect(place(dc, SETUP_NONE)).toEqual([]);
    expect(blockedApproaching(dc, 50, 50)).toBe(false);
  });

  it('BSP beats cylspheres: a Setup whose part has a physics BSP collides with the BSP only', () => {
    const dc = new DungeonCollision();
    place(dc, SETUP_BSP_AND_CYL);
    expect(dc.cellCount).toBe(1);
    expect(dc.cylinderCount).toBe(0);
    expect(blockedApproaching(dc, 50, 50)).toBe(true);
    expect(blockedApproaching(dc, 55, 50)).toBe(false); // where the ignored cylsphere would sit
  });

  it('part BSPs honour the object scale (GfxObjScale.Z)', () => {
    const small = new DungeonCollision();
    const big = new DungeonCollision();
    place(small, SETUP_BSP_AND_CYL, { x: 50, y: 50, z: 0 }, IDQ, 1);
    place(big, SETUP_BSP_AND_CYL, { x: 50, y: 50, z: 0 }, IDQ, 3);
    // The box's south wall: y = 50 − 1·scale. Step to 46.6 (body sphere reaches 47.08).
    const step = (dc: DungeonCollision) => dc.getAdjustedMovement(new THREE.Vector3(50, 0, 45), 0, 1.6);
    expect(step(small)).toEqual([0, 1.6]); // wall at 49 — clear
    expect(step(big)[1]).toBe(0);          // wall at 47 (scale 3) — blocked
  });

  it('CylSpheres: LowPoint carried by heading + scale, radius/height scaled', () => {
    const dc = new DungeonCollision();
    // Heading 90° (retail set_heading: +Y forward turned to +X... the frame
    // rotates local +X to world −Y).
    const q = frameSetHeading(IDQ, 90);
    place(dc, SETUP_CYL, { x: 50, y: 50, z: 0 }, q, 2);
    expect(dc.cylinderCount).toBe(1);
    // LowPoint (1,0,0.5)·2 = (2,0,1) rotated by q:
    const lowX = 50 + (1 - 2 * (q.y * q.y + q.z * q.z)) * 2;
    const lowY = 50 + 2 * (q.x * q.y + q.w * q.z) * 2;
    expect(blockedApproaching(dc, lowX, lowY)).toBe(true);
    expect(blockedApproaching(dc, 52, 50)).toBe(false); // the unrotated LowPoint
    // Height 2·2 = 4 from z = 1: a body standing at 6 m clears it, one at 1 m doesn't.
    expect(blockedApproaching(dc, lowX, lowY, 6)).toBe(false);
  });

  it('Spheres: a sphere-only Setup registers sphere obstacles that block the body spheres', () => {
    const dc = new DungeonCollision();
    place(dc, SETUP_SPH, { x: 50, y: 50, z: 0 }, IDQ, 2); // centre (50,50,2), radius 1
    expect(dc.sphereCount).toBe(1);
    expect(blockedApproaching(dc, 50, 50)).toBe(true);
    expect(blockedApproaching(dc, 50, 50, 5)).toBe(false); // far above
    expect(blockedApproaching(dc, 52.5, 50)).toBe(false);  // beside it
  });
});

describe('obstacle escape + step-up', () => {
  it('a body already overlapping a cylinder can move away or along it, never deeper', () => {
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('c', 10, 10, 1);
    const inside = new THREE.Vector3(10.8, 0, 10); // 0.8 from the axis, radsum ≈ 1.48
    expect(dc.getAdjustedMovement(inside, 0.3, 0)).toEqual([0.3, 0]);      // outward
    expect(dc.getAdjustedMovement(inside, -0.3, 0)).toEqual([0, 0]);       // deeper
    const [tx, tz] = dc.getAdjustedMovement(inside, 0, 0.3);               // tangential: distance grows
    expect(tz).toBeCloseTo(0.3, 6);
    expect(tx).toBe(0);
  });

  it('a body already overlapping a sphere can back out', () => {
    const dc = new DungeonCollision();
    dc.addSphereObstacle('s', 10, 0.5, 10, 1);
    const inside = new THREE.Vector3(10.5, 0, 10);
    expect(dc.getAdjustedMovement(inside, 0.4, 0)).toEqual([0.4, 0]);
    expect(dc.getAdjustedMovement(inside, -0.2, 0)).toEqual([0, 0]);
  });

  it('a knee-high cylinder is stepped over (StepSphereUp); a tall one blocks', () => {
    const low = new DungeonCollision();
    low.addCylinderObstacle('c', 10, 10, 0.5, 0, 0.1);
    // Dest 0.9 m from the axis < radsum 0.98: the feet sphere touches it.
    expect(low.getAdjustedMovement(new THREE.Vector3(10, 0, 8.5), 0, 0.6)).toEqual([0, 0.6]);
    expect(low.lastStepUp).toBeGreaterThan(0);
    const tall = new DungeonCollision();
    tall.addCylinderObstacle('c', 10, 10, 0.5, 0, 3);
    expect(tall.getAdjustedMovement(new THREE.Vector3(10, 0, 8.5), 0, 0.6)).toEqual([0, 0]);
  });
});

describe('CPhysicsObj::obj_within_block', () => {
  const model = (m: Partial<ObjectPhysicsModel>): ObjectPhysicsModel => ({
    parts: [], hasPhysicsBSP: false, cylSpheres: [], spheres: [], sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 0 }, ...m,
  });
  it('BSP object: sorting sphere must fit inside the block', () => {
    const m = model({ hasPhysicsBSP: true, sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 3 } });
    expect(objWithinBlock(m, { x: 3, y: 100, z: 0 }, IDQ)).toBe(true);
    expect(objWithinBlock(m, { x: 2.9, y: 100, z: 0 }, IDQ)).toBe(false);
    expect(objWithinBlock(m, { x: 189.1, y: 100, z: 0 }, IDQ)).toBe(false);
  });
  it('cylsphere object: every low point (rotated) with its radius', () => {
    const m = model({ cylSpheres: [{ origin: { x: 0, y: 2, z: 0 }, radius: 1, height: 1 }] });
    expect(objWithinBlock(m, { x: 100, y: 188, z: 0 }, IDQ)).toBe(true);    // low point y=190 < 192−1
    expect(objWithinBlock(m, { x: 100, y: 189.5, z: 0 }, IDQ)).toBe(false); // low point y=191.5 ≥ 191
    expect(objWithinBlock(m, { x: 100, y: 189.5, z: 0 }, frameSetHeading(IDQ, 180))).toBe(true); // offset now points −Y
  });
  it('plain object: origin only', () => {
    expect(objWithinBlock(model({}), { x: 0, y: 191.99, z: 0 }, IDQ)).toBe(true);
    expect(objWithinBlock(model({}), { x: -0.01, y: 5, z: 0 }, IDQ)).toBe(false);
  });
});

describe('retail scenery frame — ObjectDesc::GetObjFrame / ObjAlign → Frame::set_heading', () => {
  it('identity base: a heading of h is a rotation about +Z by −h (heading 90 turns +Y to +X)', () => {
    const q = frameSetHeading(IDQ, 90);
    const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    expect(fwd.x).toBeCloseTo(1, 6);
    expect(fwd.y).toBeCloseTo(0, 6);
  });
  it('a base YAW does not survive set_heading (the heading replaces it)', () => {
    const s = Math.SQRT1_2;
    expect(frameSetHeading({ w: s, x: 0, y: 0, z: s }, 30)).toEqual(frameSetHeading(IDQ, 30));
  });
  it('a base PITCH feeds the heading vector\'s z (m_fl2gv[5]) exactly as retail normalises it', () => {
    const a = 0.3;
    const pitched = { w: Math.cos(a / 2), x: Math.sin(a / 2), y: 0, z: 0 }; // tilt +Y up about +X
    const q = frameSetHeading(pitched, 0);
    const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    // set_heading builds (sin h, cos h, m_fl2gv[5] = sin a) and normalises it
    // (set_vector_heading) — so the kept pitch is asin(sin a / √(1 + sin²a)).
    expect(fwd.z).toBeCloseTo(Math.sin(a) / Math.sqrt(1 + Math.sin(a) ** 2), 6);
    expect(fwd.x).toBeCloseTo(0, 6);
  });
  it('max_rot 0 + align 0 → the BaseLoc orientation untouched; align → heading of −N', () => {
    const d = new ObjectDesc();
    d.baseLoc.orientation = { w: 0.9, x: 0.1, y: 0.2, z: 0.3 };
    expect(sceneryFrameQuat(d, 123, { x: 0, y: 0, z: 1 })).toEqual(d.baseLoc.orientation);
    d.align = 1;
    const n = { x: 0.3, y: -0.2, z: 0.93 };
    expect(sceneryFrameQuat(d, 123, n)).toEqual(frameSetHeading(d.baseLoc.orientation, vectorHeadingDegrees(-n.x, -n.y)));
  });
  it('SceneryInstancer.placementMatrix draws the retail frame when the placement carries one', () => {
    const q = frameSetHeading(IDQ, 45);
    const p = {
      objId: GFX_TREE, x: 1, y: 2, z: 3, scale: 1, heading: 45, desc: new ObjectDesc(), quat: q,
    } as SceneryPlacement;
    const m = SceneryInstancer.placementMatrix(p, 0, 0);
    const got = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), got, new THREE.Vector3());
    const want = new THREE.Quaternion(-q.x, -q.z, -q.y, q.w);
    expect(Math.abs(got.dot(want))).toBeCloseTo(1, 6);
  });
});

describe('scenery placement filters', () => {
  it('buildingCellMask marks building cells only', () => {
    const mask = buildingCellMask([{ frame: { origin: { x: 30, y: 50 } } }, { frame: { origin: { x: 191, y: 0.5 } } }]);
    expect([...mask].sort((a, b) => a - b)).toEqual([1 * 8 + 2, 7 * 8 + 0].sort((a, b) => a - b));
  });
  it('generateScenery drops placements withinBlock rejects', () => {
    const lb = { terrain: new Array(81).fill(1 << 2), heights: new Array(81).fill(10) };
    const region = {
      terrainInfo: { terrainTypes: [{ sceneTypes: [] }, { sceneTypes: [0] }] },
      sceneInfo: { sceneTypes: [{ scenes: [0x12000001] }] },
      landDefs: { landHeightTable: null },
    };
    const d = new ObjectDesc();
    d.objId = GFX_TREE; d.freq = 1; d.displaceX = 20; d.displaceY = 20; d.maxSlope = 1; d.maxRotation = 360;
    const scene = new Scene(); scene.objects = [d];
    const sampler = { sample: () => ({ z: 20, normalZ: 1, normal: { x: 0, y: 0, z: 1 } }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = generateScenery(0x1234ffff, lb as any, region as any, () => scene, sampler);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kept = generateScenery(0x1234ffff, lb as any, region as any, () => scene, sampler, { withinBlock: (_id, o) => o.x < 96 });
    expect(all.length).toBeGreaterThan(kept.length);
    expect(kept.every(p => p.x < 96)).toBe(true);
    expect(all.every(p => p.quat !== undefined)).toBe(true);
  });
});

const REPO = resolve(__dirname, '..');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('Holtburg south slope (0xA9B3) — the reproduced pin spot', () => {
  // The live repro (tools/probe-holtburg-pin.ts) pinned the player at world
  // (32512.21, 34446.81) against an obstacle of r = 1.31, z 97.3..118.3 —
  // exactly the old invented one for the tree Setup 0x020002D3 placed there
  // at scale 0.6076 (Setup bounding Radius 2.1637 · 0.6076 = 1.31, Height
  // 34.606 · 0.6076 = 21.0). Retail/ACE collide with its DAT CylSphere
  // instead: LowPoint z −3.8, Radius 1.53, Height 34.606, all · scale.
  let dc: DungeonCollision;
  let tree: SceneryPlacement;
  let groundY = 0;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { makeTerrainSampler } = await import('../packages/renderer/src/terrain/SceneryGenerator.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    dc = new DungeonCollision();
    const id = 0xa9b3ffff;
    const lb = CellLandblock.read(new DatReader(cellDb.getFileData(id)!));
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(0xa9b3fffe)!));
    const sampler = makeTerrainSampler(id, lb, region);
    const placements = generateScenery(id, lb, region, (sid) => {
      const data = portalDb.getFileData(sid);
      return data ? Scene.read(new DatReader(data)) : null;
    }, sampler, {
      excludeCells: buildingCellMask(info.buildings),
      withinBlock: (objId, o, q) => { const m = resolveObjectPhysics(objId, src); return !m || objWithinBlock(m, o, q); },
    });
    placements.forEach((p, i) => {
      const m = resolveObjectPhysics(p.objId, src);
      if (m) addObjectCollision(dc, (k, j) => collisionKey.scenery(id, i, k, j), m, p, p.quat!, p.scale, 0xa9 * 192, 0xb3 * 192);
    });
    const px = 32512.21 - 0xa9 * 192, py = 34446.81 - 0xb3 * 192;
    tree = placements.reduce((a, b) => (Math.hypot(a.x - px, a.y - py) < Math.hypot(b.x - px, b.y - py) ? a : b));
    groundY = tree.z;
  }, 60_000);

  it('the object at the pin is the tree Setup 0x020002D3 with a DAT cylsphere (not a bare GfxObj)', () => {
    expect(tree.objId).toBe(0x020002d3);
    expect(tree.scale).toBeCloseTo(0.6076, 3);
  });

  it('from the pinned position every heading moves (an overlapped obstacle never traps the body)', () => {
    const pos = new THREE.Vector3(32512.21, groundY, 34446.81);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const dx = Math.sin(a) * 0.5, dz = Math.cos(a) * 0.5;
      expect(dc.getAdjustedMovement(pos, dx, dz)).toEqual([dx, dz]);
    }
  });

  it('the trunk blocks at its DAT radius (1.53 · 0.6076 + body 0.48 ≈ 1.41 m), not the old 1.31 + 0.68 ≈ 1.99 m', () => {
    const cx = 0xa9 * 192 + tree.x, cz = 0xb3 * 192 + tree.y;
    const reach = 1.53 * tree.scale + 0.48;
    const from = new THREE.Vector3(cx, groundY, cz - 2.5);
    // Stop 1.6 m from the axis: inside the old invented reach, outside the DAT one.
    expect(dc.getAdjustedMovement(from, 0, 0.9)).toEqual([0, 0.9]);
    // Stop 1.3 m from the axis: inside the trunk's reach → blocked.
    expect(reach).toBeGreaterThan(1.3);
    expect(dc.getAdjustedMovement(from, 0, 1.2)).toEqual([0, 0]);
  });
});
