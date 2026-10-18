/**
 * TerrainCollision — samples terrain height and provides collision
 * against the terrain surface.
 *
 * Uses triangle interpolation matching the AC mesh split direction.
 * Each landblock is 192m x 192m, divided into 8x8 cells of 24m each.
 * Each cell is split into two triangles; the split direction is determined
 * by the same PRNG that the renderer uses (delegates to computeCellSplitDir).
 * Heights are expected in world units (already processed via LandHeightTable).
 */

import { computeCellSplitDir } from './CellSplitDir.js';

export interface TerrainHeightData {
  heights: number[];  // 81 values (9x9 grid)
  blockX: number;     // landblock grid X coordinate (0-255)
  blockY: number;     // landblock grid Y coordinate (0-255)
}

export interface LandblockHeightMap {
  blockX: number;
  blockY: number;
  data: TerrainHeightData;
}

/** acclient.exe .rdata F_EPSILON (0x007c84ec) = 0.0002f. */
const F_EPSILON = 0.0002;

/**
 * BUG.bunker-camera-in-head — OBJECTINFO::validate_walkable @ 0050d010, the
 * IsViewer branch (ACE ObjectInfo.ValidateWalkable): whether one step of the
 * camera's viewer sphere collides with a terrain plane. `dist` / `prevDist`
 * are n·c + d − radius at the step's end / start. The sphere must dip into
 * the plane (dist <= −F_EPSILON). A viewer whose path began outdoors then
 * collides; one that began in an env cell (begin_pos cell & 0xffff >= 0x100)
 * collides only when the step crossed the plane, i.e. the crossing fraction
 * dist / (offset·N) lies in (0, 1]. A sphere already under the ground (a
 * bunker, the drudge statues' ramps) passes on.
 */
export function viewerTerrainStepCollides(dist: number, prevDist: number, beganIndoors: boolean): boolean {
  if (!(dist <= -F_EPSILON)) return false;
  if (!beganIndoors) return true;
  const angle = dist / (dist - prevDist);
  return angle > 0 && angle <= 1;
}

export class TerrainCollision {
  private heightMaps = new Map<number, TerrainHeightData>();

  static readonly LANDBLOCK_SIZE = 192;
  static readonly GRID_SIZE = 9;
  static readonly CELL_SIZE = 24; // 192 / 8

  /**
   * Register a landblock's height data.
   */
  setLandblock(blockX: number, blockY: number, data: TerrainHeightData): void {
    const key = (blockX << 8) | blockY;
    this.heightMaps.set(key, data);
  }

  /**
   * Remove a landblock's height data.
   */
  removeLandblock(blockX: number, blockY: number): void {
    const key = (blockX << 8) | blockY;
    this.heightMaps.delete(key);
  }

  /**
   * Sample the terrain height at an arbitrary world position using
   * triangle interpolation matching the AC mesh split direction.
   *
   * Returns null if the landblock is not loaded.
   */
  getHeightAt(worldX: number, worldZ: number): number | null {
    const blockX = Math.floor(worldX / TerrainCollision.LANDBLOCK_SIZE);
    const blockY = Math.floor(worldZ / TerrainCollision.LANDBLOCK_SIZE);
    const key = (blockX << 8) | blockY;

    const data = this.heightMaps.get(key);
    if (!data) return null;

    // Local position within the landblock (0 to 192)
    const localX = worldX - blockX * TerrainCollision.LANDBLOCK_SIZE;
    const localZ = worldZ - blockY * TerrainCollision.LANDBLOCK_SIZE;

    return TerrainCollision.sampleHeight(data.heights, localX, localZ, data.blockX, data.blockY);
  }

  /**
   * Determine the triangle split direction for a cell, matching AC's PRNG.
   * Returns true for NW-to-SE diagonal, false for SW-to-NE diagonal.
   * Single source of truth lives in `computeCellSplitDir`.
   */
  static getSplitDir(blockX: number, blockY: number, cellX: number, cellY: number): boolean {
    return computeCellSplitDir(blockX, blockY, cellX, cellY);
  }

  /**
   * Sample height from a 9x9 grid using triangle interpolation.
   *
   * The AC height grid layout: vertex at (col, row) = index col*9 + row
   * Position: x = col * 24, z = row * 24
   *
   * Each cell is split into two triangles. The split direction is determined
   * by the AC PRNG. We interpolate within the correct triangle (barycentric)
   * to match the actual rendered mesh surface exactly.
   */
  static sampleHeight(
    heights: number[],
    localX: number,
    localZ: number,
    blockX: number = 0,
    blockY: number = 0,
  ): number {
    const CELL = TerrainCollision.CELL_SIZE;
    const GRID = TerrainCollision.GRID_SIZE;

    // Convert local position to grid coordinates
    const gx = localX / CELL; // 0 to 8
    const gz = localZ / CELL; // 0 to 8

    // Clamp to grid bounds
    const col = Math.max(0, Math.min(GRID - 2, Math.floor(gx)));
    const row = Math.max(0, Math.min(GRID - 2, Math.floor(gz)));

    // Fractional position within the cell (0 to 1)
    const fx = Math.max(0, Math.min(1, gx - col));
    const fz = Math.max(0, Math.min(1, gz - row));

    // Four corner heights: SW(col,row), SE(col+1,row), NW(col,row+1), NE(col+1,row+1)
    const hSW = heights[col * GRID + row];
    const hSE = heights[(col + 1) * GRID + row];
    const hNW = heights[col * GRID + (row + 1)];
    const hNE = heights[(col + 1) * GRID + (row + 1)];

    // Determine which triangle we're in based on AC's split direction
    const splitNWtoSE = TerrainCollision.getSplitDir(blockX, blockY, col, row);

    if (splitNWtoSE) {
      // Diagonal goes from NW to SE
      // Triangle 1: SW, NW, SE (below the NW-SE diagonal: fx > fz means SE side)
      // Triangle 2: SE, NW, NE (above the NW-SE diagonal: fx < fz means NW side)
      // The NW-SE diagonal line is where fx + fz = 1... no wait.
      // NW is at (0,1), SE is at (1,0). The diagonal line is fx + fz = 1.
      // Below diagonal (fx + fz <= 1): triangle SW-NW-SE
      // Above diagonal (fx + fz > 1): triangle SE-NW-NE
      if (fx + fz <= 1) {
        // Triangle: SW(0,0), NW(0,1), SE(1,0)
        // Height = hSW + (hSE - hSW) * fx + (hNW - hSW) * fz
        return hSW + (hSE - hSW) * fx + (hNW - hSW) * fz;
      } else {
        // Triangle: NE(1,1), SE(1,0), NW(0,1)
        // Use NE as base, go backwards
        // Height = hNE + (hNW - hNE) * (1 - fx) + (hSE - hNE) * (1 - fz)
        return hNE + (hNW - hNE) * (1 - fx) + (hSE - hNE) * (1 - fz);
      }
    } else {
      // Diagonal goes from SW to NE
      // SW is at (0,0), NE is at (1,1). The diagonal line is fx = fz.
      // Left of diagonal (fz > fx): triangle SW-NW-NE
      // Right of diagonal (fz <= fx): triangle SW-NE-SE
      if (fz >= fx) {
        // Triangle: SW(0,0), NW(0,1), NE(1,1)
        // Height = hSW + (hNE - hNW) * fx + (hNW - hSW) * fz
        return hSW + (hNE - hNW) * fx + (hNW - hSW) * fz;
      } else {
        // Triangle: SW(0,0), NE(1,1), SE(1,0)
        // Height = hSW + (hSE - hSW) * fx + (hNE - hSE) * fz
        return hSW + (hSE - hSW) * fx + (hNE - hSE) * fz;
      }
    }
  }

  /**
   * The exact plane normal (Three.js Y-up) of the terrain triangle under a
   * world position — the polygon CLandCell::find_terrain_poly returns and
   * the physics reads `walkable.Plane` from (ACE LandCell.FindEnvCollisions),
   * using the same per-cell split as getHeightAt. Null when unloaded.
   */
  getTriangleNormalAt(worldX: number, worldZ: number): { x: number; y: number; z: number } | null {
    const blockX = Math.floor(worldX / TerrainCollision.LANDBLOCK_SIZE);
    const blockY = Math.floor(worldZ / TerrainCollision.LANDBLOCK_SIZE);
    const data = this.heightMaps.get((blockX << 8) | blockY);
    if (!data) return null;
    const [dhdx, dhdz] = TerrainCollision.sampleGradient(
      data.heights,
      worldX - blockX * TerrainCollision.LANDBLOCK_SIZE,
      worldZ - blockY * TerrainCollision.LANDBLOCK_SIZE,
      data.blockX, data.blockY,
    );
    const len = Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    return { x: -dhdx / len, y: 1 / len, z: -dhdz / len };
  }

  /** Height gradient (dh/dx, dh/dz per metre) of the sampleHeight triangle under a local position. */
  static sampleGradient(
    heights: number[], localX: number, localZ: number, blockX: number = 0, blockY: number = 0,
  ): [number, number] {
    const CELL = TerrainCollision.CELL_SIZE;
    const GRID = TerrainCollision.GRID_SIZE;
    const gx = localX / CELL;
    const gz = localZ / CELL;
    const col = Math.max(0, Math.min(GRID - 2, Math.floor(gx)));
    const row = Math.max(0, Math.min(GRID - 2, Math.floor(gz)));
    const fx = Math.max(0, Math.min(1, gx - col));
    const fz = Math.max(0, Math.min(1, gz - row));
    const hSW = heights[col * GRID + row];
    const hSE = heights[(col + 1) * GRID + row];
    const hNW = heights[col * GRID + (row + 1)];
    const hNE = heights[(col + 1) * GRID + (row + 1)];
    let gfx: number;
    let gfz: number;
    if (TerrainCollision.getSplitDir(blockX, blockY, col, row)) {
      if (fx + fz <= 1) { gfx = hSE - hSW; gfz = hNW - hSW; } else { gfx = hNE - hNW; gfz = hNE - hSE; }
    } else if (fz >= fx) {
      gfx = hNE - hNW; gfz = hNW - hSW;
    } else {
      gfx = hSE - hSW; gfz = hNE - hSE;
    }
    return [gfx / CELL, gfz / CELL];
  }

  /**
   * Get the surface normal at a world position.
   * Useful for slope detection.
   */
  getNormalAt(worldX: number, worldZ: number): { x: number; y: number; z: number } | null {
    const epsilon = 0.5;
    const hC = this.getHeightAt(worldX, worldZ);
    const hR = this.getHeightAt(worldX + epsilon, worldZ);
    const hF = this.getHeightAt(worldX, worldZ + epsilon);

    if (hC === null || hR === null || hF === null) {
      return null;
    }

    // Cross product of two tangent vectors to get normal
    // tangentX = (epsilon, hR - hC, 0)
    // tangentZ = (0, hF - hC, epsilon)
    const nx = -(hR - hC) / epsilon;
    const ny = 1;
    const nz = -(hF - hC) / epsilon;

    // Normalize
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /**
   * Calculate the slope angle at a position (in radians).
   * 0 = flat, PI/2 = vertical wall.
   */
  getSlopeAngle(worldX: number, worldZ: number): number | null {
    const normal = this.getNormalAt(worldX, worldZ);
    if (!normal) return null;
    // Angle between normal and up vector (0,1,0) = acos(dot(n, up))
    return Math.acos(Math.max(-1, Math.min(1, normal.y)));
  }

  /**
   * GAP.5 — ACE-exact walkability: a surface is walkable when its normal's
   * up-component is >= PhysicsGlobals.FloorZ = 0.66417414618662751
   * (PhysicsGlobals.cs:50; PhysicsObj.is_valid_walkable, PhysicsObj.cs:2861).
   * The previous default here (45° slope cap) was an invented threshold.
   * Our normals are Three.js Y-up, so normal.y carries AC's normal.Z.
   */
  static readonly ACE_FLOOR_Z = 0.66417414618662751;

  isWalkable(worldX: number, worldZ: number): boolean {
    // The terrain polygon's own plane (is_valid_walkable(walkable.Plane.N)),
    // not a finite difference that straddles triangle edges.
    const normal = this.getTriangleNormalAt(worldX, worldZ);
    if (!normal) return false;
    return normal.y >= TerrainCollision.ACE_FLOOR_Z;
  }

  /**
   * CORE.8 — retail camera-boom radius. The EoL client sweeps the camera as a
   * collision sphere through the physics world: SmartBox::update_viewer builds
   * a CTransition with init_sphere(1, &viewer_sphere, 1.0) where
   * viewer_sphere.radius = 0.3 (acclient decomp @ 00453ce0 / init @ 004541xx),
   * flags 0x5c = IsViewer|PathClipped|FreeRotate|PerfectClip (ObjectInfoState
   * values per ACE ObjectInfo.cs). PathClipped stops the sweep at the FIRST
   * collision (ACE Transition.cs:590 port of the same code), so the camera
   * boom is clipped where the sphere meets the ground instead of clipping
   * through hillsides.
   */
  static readonly VIEWER_SPHERE_RADIUS = 0.3;

  /**
   * CORE.8 — terrain collision on the camera boom. Sweeps the retail
   * viewer sphere from the boom start (player eye) along the horizontal
   * boom vector (behindX, behindZ) and returns the distance at which the
   * sphere first contacts the terrain surface (center closer than
   * VIEWER_SPHERE_RADIUS above the ground), or maxDist if the whole boom
   * is clear. Mirrors DungeonCollision.getCameraDistance's contract so the
   * caller can Math.min the two.
   *
   * Steps at sphere-radius increments (the retail transition also steps the
   * path by the sphere radius) with a bisection refine at the contact step
   * (retail PerfectClip resolves the exact contact point).
   *
   * Unloaded landblocks (null height) never clip — matching current behavior
   * where unloaded terrain has no geometry to clip against.
   *
   * BUG.bunker-camera-in-head — `viewer` carries the cell rule for a viewer
   * whose path began in an env cell (SmartBox::update_viewer @ 00453ce0 starts
   * it in the player's cell): the terrain is a land cell's, reached only from
   * `landFrom` along the boom (where the sphere first comes within its radius
   * of an outside portal plane, viewerLandFrom), and with `beganIndoors` a
   * step meets the terrain only when it crosses the terrain plane
   * (viewerTerrainStepCollides). Omitted: the outdoor viewer, as before.
   */
  getCameraDistance(
    startX: number,
    startY: number,
    startZ: number,
    behindX: number,
    behindZ: number,
    maxDist: number,
    behindY = 0,
    viewer?: { landFrom: number; beganIndoors: boolean },
  ): number {
    const r = TerrainCollision.VIEWER_SPHERE_RADIUS;
    // CORE.18.b — the boom may rise (behindY); distances run along the 3D boom.
    const len = Math.sqrt(behindX * behindX + behindY * behindY + behindZ * behindZ);
    if (len < 0.001 || maxDist <= 0) return maxDist;
    const landFrom = viewer?.landFrom ?? 0;
    if (!(landFrom <= maxDist)) return maxDist;
    const dirX = behindX / len;
    const dirY = behindY / len;
    const dirZ = behindZ / len;

    const penetrates = (t: number): boolean => {
      const h = this.getHeightAt(startX + dirX * t, startZ + dirZ * t);
      return h !== null && startY + dirY * t - h < r;
    };
    // The step from boom distance `t0` to `t` meets the terrain (the plane of
    // the triangle under the step's end, as LandCell.FindEnvCollisions tests it).
    const stepContact = (t0: number, t: number): boolean => {
      if (t < landFrom) return false;
      if (!viewer?.beganIndoors) return penetrates(t);
      const x = startX + dirX * t, z = startZ + dirZ * t;
      const h = this.getHeightAt(x, z);
      const n = h === null ? null : this.getTriangleNormalAt(x, z);
      if (h === null || !n) return false;
      const planeDist = (s: number) =>
        n.x * (dirX * s + startX - x) + n.y * (dirY * s + startY - h) + n.z * (dirZ * s + startZ - z) - r;
      return viewerTerrainStepCollides(planeDist(t), planeDist(t0), true);
    };

    // Walk outward in sphere-radius steps; on first penetrating step, bisect
    // between the last clear distance and the contact step for the boundary.
    let lastClear = 0;
    for (let t = Math.min(r, maxDist); ; t = Math.min(t + r, maxDist)) {
      if (stepContact(lastClear, t)) {
        let lo = lastClear;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (penetrates(mid)) hi = mid;
          else lo = mid;
        }
        return lo;
      }
      lastClear = t;
      if (t >= maxDist) return maxDist;
    }
  }

  /**
   * Number of loaded landblocks.
   */
  get loadedCount(): number {
    return this.heightMaps.size;
  }

  clear(): void {
    this.heightMaps.clear();
  }
}
