/**
 * WaterMap — GAP.6: outdoor water classification + wading depth,
 * mirroring ACE's landscape water physics exactly.
 *
 * AC1 has NO swimming (zero swim MotionCommands in the entire retail
 * enum set). Landscape water is water-textured terrain; the player
 * WADES: the resting plane sinks `waterDepth` below the water surface
 * (ACE ObjectInfo.ValidateWalkable, ObjectInfo.cs:124 adds waterDepth
 * to the contact-plane distance), and cells whose four corner vertices
 * are ALL water ("EntirelyWater") are impassable for players
 * (LandCell.FindEnvCollisions, LandCell.cs:55-59 → TransitionState.Collided).
 *
 * Sources:
 *  - ACE Physics/Common/LandDefs.cs:25 WaterType enum
 *  - ACE Physics/Common/LandblockStruct.cs:62 SurfChar (terrain types
 *    0x10 WaterRunning … 0x14 WaterDeepSea are water) + :145 CalcWater
 *    (cell = EntirelyWater iff all 4 corner vertices water, Partially if any)
 *  - ACE Physics/Common/ObjCell.cs:473 get_water_depth (EntirelyWater →
 *    0.9; Partially → calc_water_depth)
 *  - ACE Physics/Common/LandblockStruct.cs:655 calc_water_depth (nearest
 *    corner vertex of the 24m cell: water → 0.45, dry → 0.1; chosen by
 *    +9 when X%24 ≥ 12, +1 when Y%24 ≥ 12 in the 9×9 vertex grid)
 */

export enum LandWaterType {
  NotWater = 0,
  PartiallyWater = 1,
  EntirelyWater = 2,
}

/** ACE ObjCell.get_water_depth constants. */
export const WATER_DEPTH_ENTIRELY = 0.89999998;
export const WATER_DEPTH_PARTIAL_WATER_VERTEX = 0.44999999;
export const WATER_DEPTH_PARTIAL_DRY_VERTEX = 0.1;

/**
 * ACE LandblockStruct.SurfChar: 1 for terrain-type indices 16–20
 * (WaterRunning, WaterStandingFresh, WaterShallowSea, WaterShallowStillSea,
 * WaterDeepSea), 0 for everything else.
 */
export function isWaterTerrainType(terrainType: number): boolean {
  return terrainType >= 0x10 && terrainType <= 0x14;
}

const CELL_SIZE = 24;
const BLOCK_SIZE = 192;

/**
 * Per-landblock water data derived from the cell-corner terrain types the
 * terrain mesh already extracts (LandblockMesh.cellCornerTerrainTypes:
 * 64 cells × [SW, SE, NE, NW], cell index = col*8 + row).
 */
export class WaterMap {
  /** key (bx<<8|by) → 256-entry corner terrain-type array. */
  private blocks = new Map<number, number[]>();

  setLandblock(blockX: number, blockY: number, cellCornerTerrainTypes: number[]): void {
    this.blocks.set((blockX << 8) | blockY, cellCornerTerrainTypes);
  }

  removeLandblock(blockX: number, blockY: number): void {
    this.blocks.delete((blockX << 8) | blockY);
  }

  /** The 4 corner terrain types [SW, SE, NE, NW] of the cell under a world position, or null if unloaded. */
  private cornersAt(worldX: number, worldZ: number): number[] | null {
    const bx = Math.floor(worldX / BLOCK_SIZE);
    const by = Math.floor(worldZ / BLOCK_SIZE);
    const corners = this.blocks.get((bx << 8) | by);
    if (!corners) return null;
    const col = Math.max(0, Math.min(7, Math.floor((worldX - bx * BLOCK_SIZE) / CELL_SIZE)));
    const row = Math.max(0, Math.min(7, Math.floor((worldZ - by * BLOCK_SIZE) / CELL_SIZE)));
    const base = (col * 8 + row) * 4;
    return [corners[base], corners[base + 1], corners[base + 2], corners[base + 3]];
  }

  /**
   * ACE LandblockStruct.CalcCellWater — all 4 corner vertices water →
   * EntirelyWater; any water → PartiallyWater; else NotWater.
   * Returns null when the landblock isn't loaded.
   */
  cellWaterTypeAt(worldX: number, worldZ: number): LandWaterType | null {
    const c = this.cornersAt(worldX, worldZ);
    if (!c) return null;
    const waterCount = c.filter(isWaterTerrainType).length;
    if (waterCount === 4) return LandWaterType.EntirelyWater;
    if (waterCount > 0) return LandWaterType.PartiallyWater;
    return LandWaterType.NotWater;
  }

  /**
   * ACE ObjCell.get_water_depth + LandblockStruct.calc_water_depth —
   * how far below the water-textured terrain surface the resting plane
   * sits (ObjectInfo.ValidateWalkable adds this to the plane distance).
   * 0 on dry cells / unloaded blocks.
   */
  waterDepthAt(worldX: number, worldZ: number): number {
    const type = this.cellWaterTypeAt(worldX, worldZ);
    if (type === null || type === LandWaterType.NotWater) return 0;
    if (type === LandWaterType.EntirelyWater) return WATER_DEPTH_ENTIRELY;
    const c = this.cornersAt(worldX, worldZ)!;
    // calc_water_depth picks the NEAREST corner vertex: base index +9 when
    // X%24 ≥ 12 (east half), +1 when Y%24 ≥ 12 (north half) — i.e.
    // (east, north) → [SW, SE, NE, NW][...]
    const east = ((worldX % BLOCK_SIZE) % CELL_SIZE) >= 12;
    const north = ((worldZ % BLOCK_SIZE) % CELL_SIZE) >= 12;
    const nearest = east ? (north ? c[2] : c[1]) : (north ? c[3] : c[0]);
    return isWaterTerrainType(nearest)
      ? WATER_DEPTH_PARTIAL_WATER_VERTEX
      : WATER_DEPTH_PARTIAL_DRY_VERTEX;
  }

  get loadedCount(): number {
    return this.blocks.size;
  }

  clear(): void {
    this.blocks.clear();
  }
}
