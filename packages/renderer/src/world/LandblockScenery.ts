/**
 * PERF.5 — one landblock's landscape scenery (trees, rocks, plants), built
 * for the landblock OBJECT streamer instead of for every terrain block.
 *
 * Retail: scenery is CLandBlock::get_land_scenes @ 00530460, called only from
 * CLandBlock::init_static_objs @ 00530a40 inside its `side_cell_count == 8`
 * branch (decomp :297062) — the same full-detail gate as the block's statics
 * and buildings (see LandscapeDrawDistance.RETAIL_FULL_DETAIL_RADIUS). It was
 * previously attached by the terrain renderer to every block of the
 * Landscape Draw Distance grid (289 at the retail default 8), which is the
 * area-scaling PERF.5 measured.
 *
 * The placement + collision rules are unchanged from the terrain attacher
 * this replaces (lifted verbatim out of main.ts):
 *  - CSortCell::has_building — scenery never lands in a land cell that holds
 *    a building (get_land_scenes; ACE Landblock.get_land_scenes,
 *    Common/Landblock.cs:244). Buildings only.
 *  - CPhysicsObj::obj_within_block @ 00511030 — scenery whose footprint
 *    crosses the block edge is destroyed (before it is scaled).
 *  - Collision is ACE PhysicsObj.FindObjCollisions' rule (ObjectCollision.ts):
 *    part BSPs, else CylSpheres, else Spheres, else nothing
 *    (BUG.movement-pinned-south-holtburg-slope).
 *  - Instances are SceneryInstancer.placementMatrix transforms (FAITHFUL.199
 *    ground-origin convention), pooled by the caller (PERF.1).
 */
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import type { RegionDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import { Scene as SceneFile } from '@ac/dat-parser/file-types/Scene.js';
import { generateScenery, makeTerrainSampler, buildingCellMask } from '../terrain/SceneryGenerator.js';
import { SceneryInstancer, type InstanceEntry } from '../terrain/SceneryInstancer.js';
import { collisionKey, type CollisionKey, type DungeonCollision } from './DungeonCollision.js';
import { addObjectCollision, objWithinBlock, type ObjectPhysicsModel } from './ObjectCollision.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

export interface LandblockSceneryDeps {
  cellDb: { getFileData(fileId: number): ArrayBuffer | null };
  portalDb: { getFileData(fileId: number): ArrayBuffer | null };
  regionDesc: RegionDesc;
  /** SceneryInstancer.hasModel — placements the instancer cannot resolve are skipped. */
  hasModel(objId: number): boolean;
  /** Scenery physics models, per object id (null = unresolvable). */
  objectPhysics(objId: number): ObjectPhysicsModel | null;
  /** The outdoor collision world the scenery obstacles register into. */
  collision: DungeonCollision;
  warn: { warn(detail: string, err?: unknown): void };
}

export interface LandblockSceneryResult {
  /** World-space instances for the scenery pool. */
  entries: InstanceEntry[];
  /** Collision keys registered for this block's scenery (retired with the block). */
  collisionKeys: CollisionKey[];
}

/** Build a per-block scenery function with its own Scene (0x12) decode cache. */
export function createLandblockSceneryBuilder(
  d: LandblockSceneryDeps,
): (blockX: number, blockY: number) => LandblockSceneryResult | null {
  const sceneCache = new Map<number, SceneFile | null>();
  const loadScene = (sceneId: number): SceneFile | null => {
    const cached = sceneCache.get(sceneId);
    if (cached !== undefined) return cached;
    try {
      const epoch = datMissEpoch();
      const data = d.portalDb.getFileData(sceneId);
      const parsed = data ? SceneFile.read(new DatReader(data)) : null;
      if (noDatMissSince(epoch)) sceneCache.set(sceneId, parsed);
      return parsed;
    } catch (err) {
      d.warn.warn(`Scene 0x${(sceneId >>> 0).toString(16)} unreadable — its scenery is skipped`, err);
      sceneCache.set(sceneId, null);
      return null;
    }
  };

  return (blockX: number, blockY: number): LandblockSceneryResult | null => {
    // The cell.dat landblock entry id (0xXXYYFFFF) is the placement hash seed.
    const landblockId = (((blockX & 0xff) << 24) | ((blockY & 0xff) << 16) | 0xffff) >>> 0;
    const worldOffsetX = blockX * 192;
    const worldOffsetZ = blockY * 192;
    let landblock: CellLandblock;
    try {
      const data = d.cellDb.getFileData(landblockId);
      if (!data) return null;
      landblock = CellLandblock.read(new DatReader(data));
    } catch (err) {
      d.warn.warn(`landblock 0x${landblockId.toString(16)} unreadable — no scenery`, err);
      return null;
    }
    const sampler = makeTerrainSampler(landblockId, landblock, d.regionDesc);

    const excludeCells = new Set<number>();
    if (landblock.hasObjects) {
      const lbInfoId = ((landblockId & 0xffff0000) | 0xfffe) >>> 0;
      try {
        const lbInfoData = d.cellDb.getFileData(lbInfoId);
        if (lbInfoData) {
          const info = new LandblockInfo(new DatReader(lbInfoData));
          for (const c of buildingCellMask(info.buildings)) excludeCells.add(c);
        }
      } catch (err) {
        d.warn.warn(`LandblockInfo 0x${lbInfoId.toString(16)} unreadable for the scenery building mask`, err);
      }
    }

    const placements = generateScenery(landblockId, landblock, d.regionDesc, loadScene, sampler, {
      excludeCells,
      withinBlock: (objId, origin, quat) => {
        const model = d.objectPhysics(objId);
        return !model || objWithinBlock(model, origin, quat);
      },
    });

    const collisionKeys: CollisionKey[] = [];
    let placementIdx = 0;
    for (const p of placements) {
      if (!d.hasModel(p.objId)) continue;
      placementIdx++;
      const model = d.objectPhysics(p.objId);
      if (!model) continue;
      try {
        const quat = p.quat ?? { w: 1, x: 0, y: 0, z: 0 };
        const idx = placementIdx;
        collisionKeys.push(...addObjectCollision(
          d.collision,
          (kind, i) => collisionKey.scenery(landblockId, idx, kind, i),
          model, { x: p.x, y: p.y, z: p.z }, quat, p.scale, worldOffsetX, worldOffsetZ,
        ));
      } catch (err) {
        d.warn.warn(`scenery collision for 0x${(p.objId >>> 0).toString(16)} in 0x${landblockId.toString(16)} failed`, err);
      }
    }

    return {
      entries: placements.map(p => ({
        objId: p.objId,
        matrix: SceneryInstancer.placementMatrix(p, worldOffsetX, worldOffsetZ),
      })),
      collisionKeys,
    };
  };
}
