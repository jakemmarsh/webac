import {
  ObjectDesc, onRoad, Scene,
  SCENERY_CELL_LENGTH, SCENERY_BLOCK_LENGTH, SCENERY_VERTEX_DIM, SCENERY_BLOCK_SIDE,
  RegionDesc, CellLandblock,
} from '@ac/dat-parser';
import { computeCellSplitDir } from '@ac/shared';

/**
 * One placed scenery object, in landblock-local coordinates.
 *
 *  - `objId` is the portal.dat ID to instantiate (GfxObj 0x01xxxxxx or
 *    SetupModel 0x02xxxxxx).
 *  - `x, y, z` are local to the landblock (0..192 on X/Y, ground-aligned Z).
 *  - `heading` is rotation around the +Z axis in degrees, applied from the
 *    object's BaseLoc orientation.
 *  - `scale` is uniform.
 */
export interface SceneryPlacement {
  objId: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  heading: number;
  /** Source ObjectDesc — caller may use BaseLoc orientation to compose the final quaternion. */
  desc: ObjectDesc;
  /**
   * The object's frame orientation (AC Z-up quaternion) exactly as retail
   * builds it — ObjectDesc::GetObjFrame @ 005a5d50 / ObjAlign @ 005a5e50 →
   * Frame::set_heading. Set by generateScenery; when absent, consumers fall
   * back to heading × BaseLoc orientation.
   */
  quat?: AcQuat;
}

/** AC (Z-up) quaternion, w-first like the DAT Frame. */
export interface AcQuat { w: number; x: number; y: number; z: number }

/** AC1Legacy::Vector3::normalize_check_small threshold (ACE PhysicsGlobals.EPSILON). */
const SMALL = 0.0002;

/**
 * `AC1Legacy::Vector3::get_heading @ 004575d0`: compass heading (degrees,
 * 0 = +Y/north, clockwise) of a vector's horizontal part; 0 when it has none.
 */
export function vectorHeadingDegrees(x: number, y: number): number {
  const len = Math.sqrt(x * x + y * y);
  if (len < SMALL) return 0;
  return (450 - Math.atan2(y / len, x / len) * 180 / Math.PI) % 360;
}

/**
 * `Frame::set_heading @ 00535e40` → `set_vector_heading @ 00535db0` →
 * `euler_set_rotate` (XYZ static order): the frame's orientation is
 * REPLACED by a heading about +Z plus the pitch of its current forward (+Y)
 * axis (m_fl2gv[5], the forward axis' z; retail multiplies the other two
 * terms by 0). A base orientation's own yaw/roll does not survive.
 */
export function frameSetHeading(base: AcQuat, degrees: number): AcQuat {
  const { w, x, y, z } = base;
  // Frame::cache: m_fl2gv[5] = 2(yz + wx).
  const fwdZ = 2 * (y * z + w * x);
  const r = degrees * Math.PI / 180;
  let hx = Math.sin(r);
  let hy = Math.cos(r);
  let hz = fwdZ;
  const len = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (len < SMALL) return base;
  hx /= len; hy /= len; hz /= len;
  const headingDeg = (450 - Math.atan2(hy, hx) * 180 / Math.PI) % 360;
  const az = -headingDeg * Math.PI / 180;
  const ax = Math.asin(Math.max(-1, Math.min(1, hz)));
  // euler_set_rotate(ax, 0, az), static XYZ: q = qz(az) · qx(ax).
  const ci = Math.cos(ax / 2), si = Math.sin(ax / 2);
  const ch = Math.cos(az / 2), sh = Math.sin(az / 2);
  return { w: ch * ci, x: si * ch, y: sh * si, z: ci * sh };
}

/**
 * The scenery object's frame orientation (CLandBlock::get_land_scenes @
 * 00530460): `align == 0` → ObjectDesc::GetObjFrame (BaseLoc, then
 * set_heading(noise · max_rot) only when max_rot > 0); otherwise
 * ObjectDesc::ObjAlign — set_heading(get_heading(−N)) of the walkable
 * terrain plane normal N.
 */
export function sceneryFrameQuat(
  desc: ObjectDesc,
  heading: number,
  groundNormal: { x: number; y: number; z: number },
): AcQuat {
  const base = desc.baseLoc.orientation;
  if (desc.align === 0) return desc.maxRotation > 0 ? frameSetHeading(base, heading) : { ...base };
  return frameSetHeading(base, vectorHeadingDegrees(-groundNormal.x, -groundNormal.y));
}

/**
 * Resolver for fetching a Scene (0x12xxxxxx) by ID from portal.dat.
 * Callers wire this to their portalDb / DatDatabase instance.
 */
export type SceneLoader = (sceneId: number) => Scene | null;

/**
 * Resolver for fetching the bilinear-interpolated terrain Z and surface
 * normal Z at a given landblock-local (lx, ly). Used for ground alignment
 * and slope filtering. Mirrors ACE's `walkable.Plane.set_height`.
 */
export interface TerrainSampler {
  /**
   * Local (lx, ly) → (z, normalZ) on the triangle that point falls in, plus
   * the triangle's upward unit normal (for ObjAlign) when the sampler has it.
   */
  sample(lx: number, ly: number): { z: number; normalZ: number; normal?: { x: number; y: number; z: number } } | null;
}

/**
 * Construct a TerrainSampler from a CellLandblock + RegionDesc. The sampler
 * uses the same triangle-split PRNG (`computeCellSplitDir`) as the terrain
 * mesh, so scenery sits on the visible ground rather than between triangles.
 */
export function makeTerrainSampler(
  landblockId: number,
  landblock: CellLandblock,
  regionDesc: RegionDesc | null,
): TerrainSampler {
  const heightTable = regionDesc?.landDefs.landHeightTable ?? null;
  const blockX = (landblockId >>> 24) & 0xff;
  const blockY = (landblockId >>> 16) & 0xff;

  const getHeight = (col: number, row: number): number => {
    const idx = col * SCENERY_VERTEX_DIM + row;
    const raw = landblock.heights[idx] ?? 0;
    return heightTable ? heightTable[raw] : raw * 2;
  };

  return {
    sample(lx, ly) {
      if (lx < 0 || ly < 0 || lx >= SCENERY_BLOCK_LENGTH || ly >= SCENERY_BLOCK_LENGTH) return null;
      const cellX = Math.floor(lx / SCENERY_CELL_LENGTH);
      const cellY = Math.floor(ly / SCENERY_CELL_LENGTH);
      if (cellX >= SCENERY_BLOCK_SIDE || cellY >= SCENERY_BLOCK_SIDE) return null;

      // Cell corner positions and heights
      const x0 = cellX * SCENERY_CELL_LENGTH;
      const y0 = cellY * SCENERY_CELL_LENGTH;
      const hSW = getHeight(cellX, cellY);
      const hSE = getHeight(cellX + 1, cellY);
      const hNW = getHeight(cellX, cellY + 1);
      const hNE = getHeight(cellX + 1, cellY + 1);

      // Triangle split via PRNG so we sample the same surface the mesh draws
      const splitNWtoSE = computeCellSplitDir(blockX, blockY, cellX, cellY);
      const u = lx - x0; // 0..24
      const v = ly - y0; // 0..24

      let A: { x: number; y: number; z: number };
      let B: { x: number; y: number; z: number };
      let C: { x: number; y: number; z: number };
      if (splitNWtoSE) {
        // diagonal SW→NE crosses through... actually splitNWtoSE means the diagonal
        // runs from NW to SE; lower triangle is (SW, NW, SE) and upper is (SE, NW, NE).
        // The diagonal line is v = 24 - u (i.e. u + v = 24).
        if (u + v <= SCENERY_CELL_LENGTH) {
          A = { x: x0,                   y: y0,                   z: hSW };
          B = { x: x0,                   y: y0 + SCENERY_CELL_LENGTH, z: hNW };
          C = { x: x0 + SCENERY_CELL_LENGTH, y: y0,                   z: hSE };
        } else {
          A = { x: x0 + SCENERY_CELL_LENGTH, y: y0,                   z: hSE };
          B = { x: x0,                   y: y0 + SCENERY_CELL_LENGTH, z: hNW };
          C = { x: x0 + SCENERY_CELL_LENGTH, y: y0 + SCENERY_CELL_LENGTH, z: hNE };
        }
      } else {
        // diagonal SW→NE; lower triangle is (SW, NE, SE), upper is (SW, NW, NE).
        // The diagonal line is v = u.
        if (v <= u) {
          A = { x: x0,                   y: y0,                   z: hSW };
          B = { x: x0 + SCENERY_CELL_LENGTH, y: y0 + SCENERY_CELL_LENGTH, z: hNE };
          C = { x: x0 + SCENERY_CELL_LENGTH, y: y0,                   z: hSE };
        } else {
          A = { x: x0,                   y: y0,                   z: hSW };
          B = { x: x0,                   y: y0 + SCENERY_CELL_LENGTH, z: hNW };
          C = { x: x0 + SCENERY_CELL_LENGTH, y: y0 + SCENERY_CELL_LENGTH, z: hNE };
        }
      }

      // Barycentric Z at (lx, ly) on triangle (A, B, C)
      const denom = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
      if (denom === 0) return null;
      const wA = ((B.y - C.y) * (lx - C.x) + (C.x - B.x) * (ly - C.y)) / denom;
      const wB = ((C.y - A.y) * (lx - C.x) + (A.x - C.x) * (ly - C.y)) / denom;
      const wC = 1 - wA - wB;
      const z = wA * A.z + wB * B.z + wC * C.z;

      // Plane normal (cross of two edges, normalized) — normalZ ∈ [0, 1] for upright triangles
      const ex = B.x - A.x, ey = B.y - A.y, ez = B.z - A.z;
      const fx = C.x - A.x, fy = C.y - A.y, fz = C.z - A.z;
      const nx = ey * fz - ez * fy;
      const ny = ez * fx - ex * fz;
      const nz = ex * fy - ey * fx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const normalZ = len > 0 ? Math.abs(nz) / len : 1;
      // Upward-facing unit normal (the walkable plane's N).
      const sgn = nz < 0 ? -1 : 1;
      const normal = len > 0 ? { x: sgn * nx / len, y: sgn * ny / len, z: normalZ } : { x: 0, y: 0, z: 1 };

      return { z, normalZ, normal };
    },
  };
}

/**
 * The land cells (index cellX·8 + cellY) that hold a building — the cells
 * `CSortCell::has_building` is true for (a building is added to the land
 * cell containing its origin; CLandBlock::init_buildings). Scenery never
 * lands in them (CLandBlock::get_land_scenes @ 00530460; ACE Landblock.
 * get_land_scenes, Common/Landblock.cs:244). Static objects do NOT mark
 * their cell — neither retail nor ACE drops scenery for them.
 */
export function buildingCellMask(buildings: readonly { frame: { origin: { x: number; y: number } } }[]): Set<number> {
  const cells = new Set<number>();
  for (const b of buildings) {
    const cellX = Math.floor(b.frame.origin.x / SCENERY_CELL_LENGTH);
    const cellY = Math.floor(b.frame.origin.y / SCENERY_CELL_LENGTH);
    if (cellX >= 0 && cellX < SCENERY_BLOCK_SIDE && cellY >= 0 && cellY < SCENERY_BLOCK_SIDE) {
      cells.add(cellX * SCENERY_BLOCK_SIDE + cellY);
    }
  }
  return cells;
}

/**
 * Per-landblock scenery generation, mirroring ACViewer.Physics.Common.Landblock.get_land_scenes.
 *
 * Walks all 81 vertices of the landblock terrain grid. For each vertex:
 *   1. Decode terrainType (bits 2-6) and sceneType (bits 11-15).
 *   2. Look up the sceneInfo via RegionDesc.terrainInfo.terrainTypes[terrainType].sceneTypes[sceneType].
 *   3. Get the candidate Scene ID list via RegionDesc.sceneInfo.sceneTypes[idx].scenes.
 *   4. Hash-pick a Scene file ID from that list using deterministic cell-coord noise.
 *   5. For each ObjectDesc in that Scene (skipping WeenieObj-tagged server spawns):
 *        - Hash a noise value, gate on `noise < freq`.
 *        - Displace the position by per-ObjectDesc rules.
 *        - Reject if outside the landblock or on a road.
 *        - Snap Z to the terrain triangle the point falls in.
 *        - Slope-check via the triangle normal's Z component.
 *        - Compute pseudo-random scale + heading.
 *
 * The algorithm is deterministic in (landblockId, vertex index, scene-object index)
 * so scenery placement is byte-identical between runs and between client+server,
 * matching ACE's authoritative placement.
 *
 * @returns Array of placements in landblock-local coordinates. Caller positions
 *          the landblock at world (blockX * 192, 0, blockY * 192).
 */
export function generateScenery(
  landblockId: number,
  landblock: CellLandblock,
  regionDesc: RegionDesc,
  loadScene: SceneLoader,
  terrain: TerrainSampler,
  options: {
    /**
     * Land cells (index cellX·8 + cellY) that hold a building — retail
     * `CSortCell::has_building` rejects scenery landing in them. Buildings
     * only: ACE Landblock.get_land_scenes / the retail loop never exclude a
     * cell for holding a static object.
     */
    excludeCells?: Set<number>;
    /**
     * `CPhysicsObj::obj_within_block @ 00511030` for the object at its
     * (unscaled) frame — retail destroys scenery whose footprint crosses the
     * landblock edge. Absent → every placement passes.
     */
    withinBlock?: (objId: number, origin: { x: number; y: number; z: number }, quat: AcQuat) => boolean;
  } = {},
): SceneryPlacement[] {
  const placements: SceneryPlacement[] = [];
  const sceneInfo = regionDesc.sceneInfo;
  const terrainInfo = regionDesc.terrainInfo;
  if (!sceneInfo) return placements;

  const blockX = (landblockId >>> 24) & 0xff;
  const blockY = (landblockId >>> 16) & 0xff;
  const baseCellX = blockX * SCENERY_BLOCK_SIDE;
  const baseCellY = blockY * SCENERY_BLOCK_SIDE;
  const excludeCells = options.excludeCells;

  for (let i = 0; i < landblock.terrain.length; i++) {
    const t = landblock.terrain[i];
    const terrainType = (t >> 2) & 0x1f;
    const sceneType = (t >> 11) & 0x1f;

    const ttRow = terrainInfo.terrainTypes[terrainType];
    if (!ttRow) continue;
    const sceneInfoIdx = ttRow.sceneTypes[sceneType];
    if (sceneInfoIdx === undefined) continue;
    const sceneTypeRow = sceneInfo.sceneTypes[sceneInfoIdx];
    if (!sceneTypeRow || sceneTypeRow.scenes.length === 0) continue;

    const cellX = Math.floor(i / SCENERY_VERTEX_DIM);
    const cellY = i % SCENERY_VERTEX_DIM;
    const globalCellX = (cellX + baseCellX) >>> 0;
    const globalCellY = (cellY + baseCellY) >>> 0;

    // Scene index hash: globalCellY * (712977289 * globalCellX + 1813693831) - 1109124029 * globalCellX + 2139937281
    const inner = (Math.imul(712977289, globalCellX) + 1813693831) | 0;
    const aRow = Math.imul(globalCellY, inner) | 0;
    const subRow = Math.imul(1109124029, globalCellX) | 0;
    const cellMat = ((aRow - subRow + 2139937281) | 0) >>> 0;
    const offset = cellMat * 2.3283064e-10;
    let sceneIdx = Math.floor(sceneTypeRow.scenes.length * offset);
    if (sceneIdx >= sceneTypeRow.scenes.length) sceneIdx = 0;

    const sceneId = sceneTypeRow.scenes[sceneIdx];
    const scene = loadScene(sceneId);
    if (!scene) continue;

    for (let j = 0; j < scene.objects.length; j++) {
      const obj = scene.objects[j];
      if (obj.weenieObj !== 0) continue; // server-spawned, not client-placed

      // Per-object noise gate against freq
      // ACE: noise = (cellXMat + cellYMat - cellMat * (23399 + j)) * 2^-32
      // where cellXMat = -1109124029 * globalCellX, cellYMat = 1813693831 * globalCellY,
      // cellMat = 1360117743 * globalCellX * globalCellY + 1888038839 (re-derived here).
      const cellXMat = Math.imul(-1109124029, globalCellX) | 0;
      const cellYMat = Math.imul(1813693831, globalCellY) | 0;
      const innerJ = (Math.imul(Math.imul(globalCellX, globalCellY) | 0, 1360117743) + 1888038839) | 0;
      const objHash = Math.imul((23399 + j) | 0, innerJ) | 0;
      const noiseRaw = ((cellXMat + cellYMat - objHash) | 0) >>> 0;
      const noise = noiseRaw * 2.3283064e-10;

      if (noise >= obj.freq) continue;

      const pos = ObjectDesc.displace(obj, globalCellX, globalCellY, j);
      const lx = cellX * SCENERY_CELL_LENGTH + pos.x;
      const ly = cellY * SCENERY_CELL_LENGTH + pos.y;

      if (lx < 0 || ly < 0 || lx >= SCENERY_BLOCK_LENGTH || ly >= SCENERY_BLOCK_LENGTH) continue;
      if (onRoad(landblock.terrain, lx, ly)) continue;

      const ground = terrain.sample(lx, ly);
      if (!ground) continue;
      if (!ObjectDesc.checkSlope(obj, ground.normalZ)) continue;

      // Optional: caller can mask out cells covered by buildings to prevent
      // trees inside houses. The mask is keyed by the local cell index 0..63.
      if (excludeCells) {
        const lcX = Math.floor(lx / SCENERY_CELL_LENGTH);
        const lcY = Math.floor(ly / SCENERY_CELL_LENGTH);
        if (excludeCells.has(lcX * SCENERY_BLOCK_SIDE + lcY)) continue;
      }

      const heading = ObjectDesc.rotateObj(obj, globalCellX, globalCellY, j);
      const quat = sceneryFrameQuat(obj, heading, ground.normal ?? { x: 0, y: 0, z: ground.normalZ });
      if (options.withinBlock && !options.withinBlock(obj.objId, { x: lx, y: ly, z: ground.z }, quat)) continue;
      const scale = ObjectDesc.scaleObj(obj, globalCellX, globalCellY, j);

      placements.push({
        objId: obj.objId,
        x: lx,
        y: ly,
        z: ground.z,
        scale,
        heading,
        desc: obj,
        quat,
      });
    }
  }

  return placements;
}
