import { DatReader } from '../DatReader.js';

/**
 * GfxObjDegradeInfo — portal.dat files starting with 0x11.
 *
 * LOD (level of detail) info per GfxObj. AC's renderer used this to swap
 * to lower-poly variants at distance for performance. Each entry maps a
 * GfxObj ID to its degrade-mode + the 3 distance thresholds (min/ideal/max).
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/GfxObjDegradeInfo.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/GfxObjInfo.cs
 */
export interface GfxObjLOD {
  /** Variant GfxObj ID to swap to at this distance band. */
  gfxObjId: number;
  /** Degrade-mode flag (0 = standard, see ACE Render code). */
  degradeMode: number;
  /** Minimum distance at which this LOD is used (meters). */
  minDist: number;
  /** Optimal distance for this LOD. */
  idealDist: number;
  /** Maximum distance — beyond this swap to next LOD. */
  maxDist: number;
}

export class GfxObjDegradeInfo {
  id: number = 0;
  degrades: GfxObjLOD[] = [];

  static read(reader: DatReader): GfxObjDegradeInfo {
    const t = new GfxObjDegradeInfo();
    t.id = reader.readUInt32();
    const count = reader.readUInt32();
    for (let i = 0; i < count; i++) {
      t.degrades.push({
        gfxObjId: reader.readUInt32(),
        degradeMode: reader.readUInt32(),
        minDist: reader.readFloat32(),
        idealDist: reader.readFloat32(),
        maxDist: reader.readFloat32(),
      });
    }
    return t;
  }

  /** Pick the appropriate LOD entry for a given distance from the camera. */
  pickLOD(distance: number): GfxObjLOD | null {
    for (const lod of this.degrades) {
      if (distance >= lod.minDist && distance <= lod.maxDist) return lod;
    }
    return this.degrades[this.degrades.length - 1] ?? null;
  }
}
