import { DatReader } from '../DatReader.js';

/**
 * Scene — portal.dat files starting with 0x12.
 *
 * Each Scene contains a list of ObjectDesc placement descriptors. The terrain
 * cell bits 11-15 of a CellLandblock vertex index into one of these Scenes
 * (via RegionDesc.TerrainInfo → SceneTypes), and each ObjectDesc inside the
 * Scene is placed deterministically using the cell coordinates as a seed.
 *
 * Reference: ACE.DatLoader/FileTypes/Scene.cs
 *            ACViewer/Physics/Common/Landblock.cs `get_land_scenes`
 *            ACE.Server/Physics/Common/ObjectDesc.cs (Displace/Scale/Rotate/CheckSlope)
 */
export class Scene {
  id: number = 0;
  objects: ObjectDesc[] = [];

  static read(reader: DatReader): Scene {
    const s = new Scene();
    s.id = reader.readUInt32();
    const numObjects = reader.readUInt32();
    for (let i = 0; i < numObjects; i++) {
      s.objects.push(ObjectDesc.read(reader));
    }
    return s;
  }
}

/**
 * One placement descriptor inside a Scene. Encodes:
 *  - which GfxObj / SetupModel to place (objId)
 *  - base offset within the cell (baseLoc origin)
 *  - randomization parameters (displaceX/Y, minScale/maxScale, maxRotation)
 *  - slope constraints (minSlope/maxSlope)
 *  - alignment + orientation flags
 *  - weenieObj (non-zero = server-spawned, client skips placement)
 *
 * Reference: ACE.DatLoader/Entity/ObjectDesc.cs
 */
export class ObjectDesc {
  objId: number = 0;
  baseLoc: {
    origin: { x: number; y: number; z: number };
    orientation: { w: number; x: number; y: number; z: number };
  } = {
    origin: { x: 0, y: 0, z: 0 },
    orientation: { w: 1, x: 0, y: 0, z: 0 },
  };
  freq: number = 0;
  displaceX: number = 0;
  displaceY: number = 0;
  minScale: number = 1;
  maxScale: number = 1;
  maxRotation: number = 0;
  minSlope: number = 0;
  maxSlope: number = 0;
  align: number = 0;
  orient: number = 0;
  weenieObj: number = 0;

  static read(reader: DatReader): ObjectDesc {
    const o = new ObjectDesc();
    o.objId = reader.readUInt32();
    // Frame: origin (3 floats) then orientation quaternion (w,x,y,z = 4 floats)
    o.baseLoc.origin.x = reader.readFloat32();
    o.baseLoc.origin.y = reader.readFloat32();
    o.baseLoc.origin.z = reader.readFloat32();
    o.baseLoc.orientation.w = reader.readFloat32();
    o.baseLoc.orientation.x = reader.readFloat32();
    o.baseLoc.orientation.y = reader.readFloat32();
    o.baseLoc.orientation.z = reader.readFloat32();
    o.freq = reader.readFloat32();
    o.displaceX = reader.readFloat32();
    o.displaceY = reader.readFloat32();
    o.minScale = reader.readFloat32();
    o.maxScale = reader.readFloat32();
    o.maxRotation = reader.readFloat32();
    o.minSlope = reader.readFloat32();
    o.maxSlope = reader.readFloat32();
    o.align = reader.readUInt32();
    o.orient = reader.readUInt32();
    o.weenieObj = reader.readUInt32();
    return o;
  }

  /**
   * Deterministic pseudo-random noise in [0, 1) for a given cell + scene-object index.
   *
   * Mirrors the inline expressions in ACE.Server.Physics.Common.ObjectDesc using
   * uint32-modular integer arithmetic (Math.imul for the multiplies, `>>> 0` to
   * read the final 32-bit value as unsigned), then scaled by 2^-32 ≈ 2.3283064e-10
   * to produce a fractional value matching ACE's `(uint)expr * 2.3283064e-10` cast.
   *
   * @param ix global cell X-offset (landblock blockX × 8 + cellX)
   * @param iy global cell Y-offset (landblock blockY × 8 + cellY)
   * @param k  scene-object index `j` plus a per-axis offset constant
   */
  static noiseFor(ix: number, iy: number, k: number): number {
    // 1813693831 * iy
    const a = Math.imul(1813693831, iy) | 0;
    // 1360117743 * iy * ix + 1888038839
    const inner = (Math.imul(Math.imul(iy, ix) | 0, 1360117743) + 1888038839) | 0;
    // k * inner
    const b = Math.imul(k | 0, inner) | 0;
    // 1109124029 * ix
    const c = Math.imul(1109124029, ix) | 0;
    // Combine: a - b - c, treat as uint32
    const r = ((a - b - c) | 0) >>> 0;
    return r * 2.3283064e-10;
  }

  /**
   * Displaces a scenery object into a pseudo-randomized location within its cell.
   * Mirrors ACE.Server.Physics.Common.ObjectDesc.Displace.
   *
   * @param ix global cell X-offset
   * @param iy global cell Y-offset
   * @param iq scene-object index within the Scene
   */
  static displace(obj: ObjectDesc, ix: number, iy: number, iq: number): { x: number; y: number; z: number } {
    const loc = obj.baseLoc.origin;
    const x = obj.displaceX <= 0 ? loc.x : (ObjectDesc.noiseFor(ix, iy, iq + 45773) * obj.displaceX + loc.x);
    const y = obj.displaceY <= 0 ? loc.y : (ObjectDesc.noiseFor(ix, iy, iq + 72719) * obj.displaceY + loc.y);
    const z = loc.z;

    // Quadrant rotation uses a different hash (no per-object offset; ix multiplied by 1870387557)
    // ACE: (1813693831*iy - ix*(1870387557*iy + 1109124029) - 402451965) * 2^-32
    const a = Math.imul(1813693831, iy) | 0;
    const inner = (Math.imul(1870387557, iy) + 1109124029) | 0;
    const b = Math.imul(ix, inner) | 0;
    const r = ((a - b - 402451965) | 0) >>> 0;
    const quadrant = r * 2.3283064e-10;

    if (quadrant >= 0.75) return { x: y, y: -x, z };
    if (quadrant >= 0.5) return { x: -x, y: -y, z };
    if (quadrant >= 0.25) return { x: -y, y: x, z };
    return { x, y, z };
  }

  /**
   * Pseudo-random uniform scale for a scenery object.
   * Mirrors ACE.Server.Physics.Common.ObjectDesc.ScaleObj.
   */
  static scaleObj(obj: ObjectDesc, ix: number, iy: number, k: number): number {
    if (obj.minScale === obj.maxScale) return obj.maxScale;
    if (obj.minScale <= 0) return obj.maxScale; // avoid log(0)
    const noise = ObjectDesc.noiseFor(ix, iy, k + 32593);
    return Math.pow(obj.maxScale / obj.minScale, noise) * obj.minScale;
  }

  /**
   * Pseudo-random heading (degrees) for a scenery object.
   * Mirrors ACE.Server.Physics.Common.ObjectDesc.RotateObj — returns degrees in
   * [0, obj.maxRotation). Callers convert to a quaternion around the +Z axis.
   */
  static rotateObj(obj: ObjectDesc, ix: number, iy: number, k: number): number {
    if (obj.maxRotation <= 0) return 0;
    return ObjectDesc.noiseFor(ix, iy, k + 63127) * obj.maxRotation;
  }

  /** Returns true if the floor slope (plane normal Z) is within bounds for this object. */
  static checkSlope(obj: ObjectDesc, normalZ: number): boolean {
    return normalZ >= obj.minSlope && normalZ <= obj.maxSlope;
  }
}

/** Constants from ACE LandDefs — used by scenery placement. */
export const SCENERY_CELL_LENGTH = 24;
export const SCENERY_BLOCK_LENGTH = 192;
export const SCENERY_BLOCK_SIDE = 8;
export const SCENERY_VERTEX_DIM = 9;
export const SCENERY_ROAD_WIDTH = 5.0;

/**
 * Returns TRUE if the local (x, y) — within a landblock's 192m × 192m extent —
 * falls within ROAD_WIDTH meters of a road cell.
 *
 * Ported from ACViewer.Physics.Common.Landblock.OnRoad. `terrain` is the 9×9
 * terrain uint16 array from a CellLandblock. Each cell's road bits live in
 * the low 2 bits of each terrain vertex (road type 0 = no road).
 */
export function onRoad(terrain: number[] | undefined, x: number, y: number): boolean {
  if (!terrain || terrain.length < 81) return false;
  const tile = SCENERY_CELL_LENGTH;
  const rMin = SCENERY_ROAD_WIDTH;
  const rMax = tile - SCENERY_ROAD_WIDTH;

  const x0 = Math.floor(x / tile);
  const y0 = Math.floor(y / tile);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const getRoad = (cx: number, cy: number): number => {
    if (cx < 0 || cy < 0 || cx > 8 || cy > 8) return 0;
    return terrain[cx * 9 + cy] & 0x3;
  };

  const r0 = getRoad(x0, y0);
  const r1 = getRoad(x0, y1);
  const r2 = getRoad(x1, y0);
  const r3 = getRoad(x1, y1);

  if (r0 === 0 && r1 === 0 && r2 === 0 && r3 === 0) return false;

  const dx = x - x0 * tile;
  const dy = y - y0 * tile;

  if (r0 > 0) {
    if (r1 > 0) {
      if (r2 > 0) {
        if (r3 > 0) return true;
        return dx < rMin || dy < rMin;
      } else {
        if (r3 > 0) return dx < rMin || dy > rMax;
        return dx < rMin;
      }
    } else {
      if (r2 > 0) {
        if (r3 > 0) return dx > rMax || dy < rMin;
        return dy < rMin;
      } else {
        if (r3 > 0) return Math.abs(dx - dy) < rMin;
        return dx + dy < rMin;
      }
    }
  } else {
    if (r1 > 0) {
      if (r2 > 0) {
        if (r3 > 0) return dx > rMax || dy > rMax;
        return Math.abs(dx + dy - tile) < rMin;
      } else {
        if (r3 > 0) return dy > rMax;
        return tile + dx - dy < rMin;
      }
    } else {
      if (r2 > 0) {
        if (r3 > 0) return dx > rMax;
        return tile - dx + dy < rMin;
      } else {
        if (r3 > 0) return tile * 2 - dx - dy < rMin;
        return false;
      }
    }
  }
}
