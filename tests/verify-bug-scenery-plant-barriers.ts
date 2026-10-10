/**
 * BUG.scenery-plant-barriers — "bushes/plants near Holtburg seem to have
 * invisible barriers". Retail rule (CLandBlock::get_land_scenes @ 00530460 →
 * CPhysicsObj::makeObject(obj_id, 0, static) → CPhysicsObj::FindObjCollisions
 * @ 0050f050; ACE Landblock.get_land_scenes + PhysicsObj.FindObjCollisions):
 * a scenery object collides ONLY through its DAT physics — a part GfxObj
 * physics BSP, else the Setup's CylSpheres, else its Spheres — and is
 * walk-through otherwise. Its draw mesh / bounding radius is never an obstacle.
 *
 * Holtburg-area DAT ground truth (landblocks 0xA8B4 / 0xA9B3 / 0xA9B5 / 0xAAB4):
 *  - walk-through (no physics BSP, no CylSphere, no Sphere): the big leafy bush
 *    0x020002F2, bushes 0x020007A2, the 3-frond fern 0x02001063, plant
 *    0x020002F5 and 0x02000240 (the same five parts as tree 0x02000246, minus
 *    its cylsphere);
 *  - solid by DAT design: tree 0x02000246 (CylSphere r 0.85 h 3.334) and the
 *    6-frond fern clump 0x02001064 (Sphere r 0.961 at z 0.961 — top 1.92·scale,
 *    far above the human StepUpHeight 0.6, so CSphere::step_sphere_up
 *    @ 00537900 slides instead of stepping up).
 * Behavioural: real SceneryGenerator placements, ObjectCollision and
 * DungeonCollision movement on the real DATs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene } from '@ac/dat-parser';
import { DungeonCollision, collisionKey, type CollisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import {
  resolveObjectPhysics, addObjectCollision, objWithinBlock, type ObjectCollisionSources,
} from '../packages/renderer/src/world/ObjectCollision.js';
import {
  generateScenery, buildingCellMask, makeTerrainSampler, type SceneryPlacement,
} from '../packages/renderer/src/terrain/SceneryGenerator.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

const BLOCKS = [0xa8b4, 0xa9b3, 0xa9b5, 0xaab4];
const WALK_THROUGH = [0x020002f2, 0x020007a2, 0x02001063, 0x020002f5, 0x02000240];
const TREE_CYL = 0x02000246;
const FERN_SPHERE = 0x02001064;
/** Human Setup 0x02000001 (the player body): spheres r 0.48 at z 0.475 / 1.35, StepUpHeight 0.6. */
const HUMAN = 0x02000001;

interface Placed { block: number; p: SceneryPlacement }

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('Holtburg-area scenery plants collide only through DAT physics', () => {
  let src: ObjectCollisionSources;
  let human: { radius: number; height: number; stepUpHeight: number; spheres: { origin: { z: number }; radius: number }[] };
  let bodyRadius = 0;
  const placed: Placed[] = [];

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    human = sr.loadSetupModel(HUMAN)!;
    bodyRadius = human.spheres[0].radius;
    for (const block of BLOCKS) {
      const id = ((block << 16) | 0xffff) >>> 0;
      const lb = CellLandblock.read(new DatReader(cellDb.getFileData(id)!));
      const infoData = lb.hasObjects ? cellDb.getFileData(((id & 0xffff0000) | 0xfffe) >>> 0) : null;
      const excludeCells = infoData ? buildingCellMask(new LandblockInfo(new DatReader(infoData)).buildings) : new Set<number>();
      const placements = generateScenery(id, lb, region, (sid) => {
        const data = portalDb.getFileData(sid);
        return data ? Scene.read(new DatReader(data)) : null;
      }, makeTerrainSampler(id, lb, region), {
        excludeCells,
        withinBlock: (objId, o, q) => { const m = resolveObjectPhysics(objId, src); return !m || objWithinBlock(m, o, q); },
      });
      for (const p of placements) placed.push({ block, p });
    }
  }, 120_000);

  /** A fresh outdoor collision world holding just this placement, with the human body. */
  function worldWith(pl: Placed): { dc: DungeonCollision; keys: CollisionKey[]; cx: number; cz: number } {
    const dc = new DungeonCollision();
    dc.setPlayerDimensions(human, 1);
    const model = resolveObjectPhysics(pl.p.objId, src)!;
    const ox = (pl.block >> 8) * 192, oy = (pl.block & 0xff) * 192;
    const keys = addObjectCollision(dc, (k, i) => collisionKey.scenery(pl.block, 0, k, i), model,
      { x: pl.p.x, y: pl.p.y, z: pl.p.z }, pl.p.quat!, pl.p.scale, ox, oy);
    return { dc, keys, cx: ox + pl.p.x, cz: oy + pl.p.y };
  }

  /** Walk north through the placement's centre in 0.25 m steps; returns how far short of the centre the body stopped (0 = passed through). */
  function walkThrough(dc: DungeonCollision, cx: number, cz: number, feetY: number): number {
    const pos = new THREE.Vector3(cx, feetY, cz - 4);
    for (let i = 0; i < 32; i++) {
      const [, dz] = dc.getAdjustedMovement(pos, 0, 0.25);
      if (dz === 0) return cz - pos.z;
      pos.z += dz;
    }
    return 0;
  }

  it('the body is the DAT human: two r 0.48 spheres, StepUpHeight 0.6', () => {
    expect(human.spheres).toHaveLength(2);
    expect(bodyRadius).toBeCloseTo(0.48, 5);
    expect(human.stepUpHeight).toBeCloseTo(0.6, 5);
  });

  it('the survey covers every class named above', () => {
    const ids = new Set(placed.map(x => x.p.objId));
    for (const id of [...WALK_THROUGH, TREE_CYL, FERN_SPHERE]) expect(ids.has(id), `0x${id.toString(16)}`).toBe(true);
  });

  it('walk-through plants register NO collision and the body walks straight through their centre', () => {
    let checked = 0;
    for (const pl of placed.filter(x => WALK_THROUGH.includes(x.p.objId))) {
      const { dc, keys, cx, cz } = worldWith(pl);
      expect(keys, `0x${pl.p.objId.toString(16)} in 0x${pl.block.toString(16)}`).toEqual([]);
      expect(walkThrough(dc, cx, cz, pl.p.z)).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('tree 0x02000246 blocks at its DAT CylSphere (0.85 · scale + body 0.48), not at its canopy', () => {
    for (const pl of placed.filter(x => x.p.objId === TREE_CYL)) {
      const { dc, keys, cx, cz } = worldWith(pl);
      expect(keys).toHaveLength(1);
      const stop = walkThrough(dc, cx, cz, pl.p.z);
      const reach = 0.85 * pl.p.scale + bodyRadius;
      expect(stop).toBeGreaterThan(reach - 0.3);
      expect(stop).toBeLessThanOrEqual(reach + 0.25);
    }
  });

  it('fern clump 0x02001064 blocks at its DAT Sphere (0.961 · scale) — too tall to step up', () => {
    for (const pl of placed.filter(x => x.p.objId === FERN_SPHERE)) {
      const { dc, keys, cx, cz } = worldWith(pl);
      expect(keys).toHaveLength(1);
      const stop = walkThrough(dc, cx, cz, pl.p.z);
      expect(stop).toBeGreaterThan(0.961 * pl.p.scale);
      expect(stop).toBeLessThanOrEqual(0.961 * pl.p.scale + bodyRadius + 0.25);
      expect(dc.lastStepUp).toBe(0);
    }
  });

  it('every placement registers collision iff its DAT model carries a physics BSP, CylSphere or Sphere', () => {
    for (const pl of placed) {
      const m = resolveObjectPhysics(pl.p.objId, src);
      if (!m) continue;
      const hasPhysics = m.hasPhysicsBSP || m.cylSpheres.length > 0 || m.spheres.length > 0;
      const { keys } = worldWith(pl);
      expect(keys.length > 0, `0x${pl.p.objId.toString(16)}`).toBe(hasPhysics);
    }
  });
});
