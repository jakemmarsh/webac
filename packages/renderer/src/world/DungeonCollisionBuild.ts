/**
 * The collision of an interior landblock the player enters (login or
 * teleport into a dungeon / sealed building): every interior cell's physics
 * BSP, each cell static's GfxObj physics BSPs (a Setup's parts composed with
 * its default placement frame), and the landblock's building exteriors, so
 * windows and outer walls block from inside (BuildingObj
 * find_building_collisions). Both entry paths used to inline this.
 *
 * RELEASE.dat-streaming — every add is keyed (DungeonCollision.registerCell /
 * addGfxObjCollision), so running it again once streamed files land fills
 * in whatever a miss left out without duplicating anything.
 */
import type { CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { placementFrameOf } from '../models/SetupModelGroup.js';
import type { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import type { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { DungeonCollision, collisionKey } from './DungeonCollision.js';
import { landblockX, landblockY } from '@ac/shared';

export interface DungeonCollisionSources {
  findInteriorCells(landblockId: number): number[];
  getCellCollisionData(cellId: number): { cellStruct: CellStruct; position: Frame } | null;
  loadEnvCell(cellId: number): Pick<EnvCell, 'staticObjects'> | null;
  loadSetupModel(setupId: number): Pick<SetupModel, 'parts' | 'placementFrames'> | null;
  loadGfxObj(gfxObjId: number): GfxObj | null;
  loadLandblockInfo(landblockId: number): Pick<LandblockInfo, 'buildings'> | null;
}

type Vec3 = { x: number; y: number; z: number };
type Quat = { w: number; x: number; y: number; z: number };

/** Add `collision` for interior landblock `geoLb` (0xXXYYFFFF). */
export function populateDungeonCollision(collision: DungeonCollision, geoLb: number, src: DungeonCollisionSources): void {
  const offX = landblockX(geoLb) * 192;
  const offY = landblockY(geoLb) * 192;

  /** One model (a Setup's parts at its default placement, or a lone GfxObj) at a frame. */
  const addModel = (modelId: number, origin: Vec3, quat: Quat, key: (part: number) => ReturnType<typeof collisionKey.cellStatic>, building = false): void => {
    const hb = (modelId >> 24) & 0xff;
    if (hb === PortalFileType.Setup) {
      const setup = src.loadSetupModel(modelId);
      if (!setup) return;
      const placement = placementFrameOf(setup);
      for (let gi = 0; gi < setup.parts.length; gi++) {
        try {
          const gfx = src.loadGfxObj(setup.parts[gi]);
          if (!gfx?.physicsBSP || gfx.physicsPolygons.size === 0) continue;
          let partOrigin = origin;
          let partQuat = quat;
          const frame = placement?.frames[gi];
          if (frame) {
            const composed = DungeonCollision.composeFrames(origin, quat, frame.origin, frame.orientation);
            partOrigin = composed.origin;
            partQuat = composed.orientation;
          }
          collision.addGfxObjCollision(key(gi), gfx, partOrigin, partQuat, offX, offY, 1, { building });
        } catch { /* skip */ }
      }
    } else if (hb === PortalFileType.GraphicsObject) {
      try {
        const gfx = src.loadGfxObj(modelId);
        if (gfx?.physicsBSP && gfx.physicsPolygons.size > 0) {
          collision.addGfxObjCollision(key(0), gfx, origin, quat, offX, offY, 1, { building });
        }
      } catch { /* skip */ }
    }
  };

  // Interior cells (wall collision + floor detection) and their statics
  // (furniture, columns, …).
  for (const cid of src.findInteriorCells(geoLb)) {
    try {
      const collData = src.getCellCollisionData(cid);
      if (!collData) continue;
      collision.addCell(cid, collData.cellStruct, collData.position);
      const envCell = src.loadEnvCell(cid);
      if (!envCell) continue;
      for (let si = 0; si < envCell.staticObjects.length; si++) {
        const stab = envCell.staticObjects[si];
        addModel(stab.id, stab.frame.origin, stab.frame.orientation, (part) => collisionKey.cellStatic(cid, si, 'p', part));
      }
    } catch { /* skip */ }
  }

  // Building exteriors (windows, outer walls) from inside.
  try {
    const info = src.loadLandblockInfo(geoLb);
    if (!info) return;
    for (let bi = 0; bi < info.buildings.length; bi++) {
      const building = info.buildings[bi];
      if (!building.modelId) continue;
      addModel(building.modelId, building.frame.origin, building.frame.orientation, (part) => collisionKey.building(-1, bi, 'p', part), true);
    }
  } catch { /* skip LandblockInfo parse errors */ }
}
