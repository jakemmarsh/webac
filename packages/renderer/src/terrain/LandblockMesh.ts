/**
 * LandblockMesh — generates terrain geometry from a CellLandblock.
 *
 * 9×9 vertices → 81 positions
 * 8×8 quads → 128 triangles → 384 indices
 * Each vertex spans 24m (192m / 8 divisions)
 * Height = byte value × 2
 *
 * This class produces a pure-data geometry representation that works
 * in both Node.js (tests) and browser (Three.js conversion).
 */

import { computeCellSplitDir, landblockX, landblockY } from '@ac/shared';
import { cellBaseTerrainType } from './TexMergeCodes.js';

interface BoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

interface BufferAttribute {
  array: Float32Array;
  count: number;
}

interface IndexAttribute {
  array: Uint16Array;
  count: number;
}

export class LandblockGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  boundingBox: BoundingBox | null = null;

  constructor(positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array) {
    this.positions = positions;
    this.normals = normals;
    this.uvs = uvs;
    this.indices = indices;
  }

  getAttribute(name: string): BufferAttribute | null {
    switch (name) {
      case 'position':
        return { array: this.positions, count: this.positions.length / 3 };
      case 'normal':
        return { array: this.normals, count: this.normals.length / 3 };
      case 'uv':
        return { array: this.uvs, count: this.uvs.length / 2 };
      default:
        return null;
    }
  }

  getIndex(): IndexAttribute {
    return { array: this.indices, count: this.indices.length };
  }

  computeBoundingBox(): void {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };

    for (let i = 0; i < this.positions.length; i += 3) {
      const x = this.positions[i];
      const y = this.positions[i + 1];
      const z = this.positions[i + 2];
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }

    this.boundingBox = { min, max };
  }
}

export interface LandblockData {
  heights: number[];
  terrain?: number[];
  /** If provided, heights are looked up via this table instead of multiplied by 2 */
  landHeightTable?: Float32Array;
  /** Landblock file ID (0xXXYYFFFF) — needed for PRNG triangle split direction */
  landblockId?: number;
}

export class LandblockMesh {
  geometry: LandblockGeometry;
  /** Per-cell terrain type index (64 cells, 8x8 grid). Extracted from terrain bits 2-6. */
  cellTerrainTypes: number[];
  /**
   * Per-cell road mask (64 cells, 8x8 grid).
   * 4-bit mask: bit0=NW corner, bit1=NE, bit2=SE, bit3=SW.
   * Non-zero means the cell has road data.
   */
  cellRoadMasks: number[];
  /**
   * Per-cell 4-corner terrain types (64 cells × 4 corners = 256 entries).
   * Order per cell: [SW, SE, NE, NW] matching ACE's t1/t2/t3/t4.
   * Index: cellIdx * 4 + cornerIdx.
   */
  cellCornerTerrainTypes: number[];
  /**
   * Per-cell 4-corner road bits (64 cells × 4 corners = 256 entries).
   * Order per cell: [SW, SE, NE, NW] matching ACE's r1/r2/r3/r4.
   */
  cellCornerRoadBits: number[];
  /**
   * Raw 9×9 per-vertex terrain uint16 words (81 entries, index = col*9 + row).
   * Retained because scene-type bits 11-15 drive the ambient STB selection
   * and are not recoverable from the extracted per-cell arrays.
   */
  terrain: number[];
  /**
   * DECOMP.terrain-lod — the source data, kept so the renderer can rebuild
   * the block at a reduced retail LOD (buildLandblockLod) when the viewer
   * moves; this full-resolution mesh stays the collision/sampling source.
   */
  readonly source: LandblockData;

  constructor(landblock: LandblockData) {
    this.source = landblock;
    this.geometry = LandblockMesh.buildGeometry(landblock);
    this.terrain = landblock.terrain ?? [];
    this.cellTerrainTypes = LandblockMesh.extractCellTerrainTypes(landblock.terrain);
    this.cellRoadMasks = LandblockMesh.extractCellRoadMasks(landblock.terrain);
    const corners = LandblockMesh.extractCellCornerData(landblock.terrain);
    this.cellCornerTerrainTypes = corners.terrainTypes;
    this.cellCornerRoadBits = corners.roadBits;
  }

  static create(landblock: LandblockData): LandblockMesh {
    return new LandblockMesh(landblock);
  }

  /**
   * Extract terrain type for each cell (8x8 = 64 cells): the cell's BASE
   * terrain as TexMerge::GetTerrain picks it (the first corner type two
   * corners share, else SW), which the blend overlays are merged over.
   */
  private static extractCellTerrainTypes(terrain?: number[]): number[] {
    if (!terrain || terrain.length < 81) {
      return new Array(64).fill(0);
    }
    const types: number[] = [];
    for (let col = 0; col < 8; col++) {
      for (let row = 0; row < 8; row++) {
        const ty = (i: number): number => (terrain[i] >> 2) & 0x1f;
        types.push(cellBaseTerrainType(
          ty(col * 9 + row), ty((col + 1) * 9 + row), ty((col + 1) * 9 + row + 1), ty(col * 9 + row + 1),
        ));
      }
    }
    return types;
  }

  /**
   * Extract road mask for each cell (8x8 = 64 cells).
   * For each cell, check all 4 corners for road data (terrain bits 0-1).
   * Returns 4-bit mask: bit0=NW, bit1=NE, bit2=SE, bit3=SW.
   * Layout: vertex at (col, row) = terrain index col*9 + row.
   * Cell (col, row) corners: SW=col*9+row, SE=(col+1)*9+row, NW=col*9+(row+1), NE=(col+1)*9+(row+1).
   */
  private static extractCellRoadMasks(terrain?: number[]): number[] {
    if (!terrain || terrain.length < 81) {
      return new Array(64).fill(0);
    }
    const masks: number[] = [];
    for (let col = 0; col < 8; col++) {
      for (let row = 0; row < 8; row++) {
        const sw = terrain[col * 9 + row] & 0x3;
        const se = terrain[(col + 1) * 9 + row] & 0x3;
        const nw = terrain[col * 9 + (row + 1)] & 0x3;
        const ne = terrain[(col + 1) * 9 + (row + 1)] & 0x3;

        let mask = 0;
        if (nw !== 0) mask |= 1;  // bit 0 = NW (upper left)
        if (ne !== 0) mask |= 2;  // bit 1 = NE (upper right)
        if (se !== 0) mask |= 4;  // bit 2 = SE (lower right)
        if (sw !== 0) mask |= 8;  // bit 3 = SW (lower left)

        masks.push(mask);
      }
    }
    return masks;
  }

  /**
   * Extract 4-corner terrain type and road data for each cell.
   * Order per cell: SW, SE, NE, NW (matching ACE's t1/t2/t3/t4, r1/r2/r3/r4).
   * Cell (col, row) corners: SW=col*9+row, SE=(col+1)*9+row, NE=(col+1)*9+(row+1), NW=col*9+(row+1).
   */
  private static extractCellCornerData(terrain?: number[]): { terrainTypes: number[]; roadBits: number[] } {
    if (!terrain || terrain.length < 81) {
      return { terrainTypes: new Array(256).fill(0), roadBits: new Array(256).fill(0) };
    }
    const terrainTypes: number[] = [];
    const roadBits: number[] = [];
    for (let col = 0; col < 8; col++) {
      for (let row = 0; row < 8; row++) {
        const swIdx = col * 9 + row;
        const seIdx = (col + 1) * 9 + row;
        const neIdx = (col + 1) * 9 + (row + 1);
        const nwIdx = col * 9 + (row + 1);

        terrainTypes.push(
          (terrain[swIdx] & 0x7F) >> 2,
          (terrain[seIdx] & 0x7F) >> 2,
          (terrain[neIdx] & 0x7F) >> 2,
          (terrain[nwIdx] & 0x7F) >> 2,
        );
        roadBits.push(
          terrain[swIdx] & 3,
          terrain[seIdx] & 3,
          terrain[neIdx] & 3,
          terrain[nwIdx] & 3,
        );
      }
    }
    return { terrainTypes, roadBits };
  }

  /**
   * Determine triangle split direction for a cell using AC's PRNG.
   * Uses global cell coordinates derived from the landblock ID.
   * Single source of truth lives in `computeCellSplitDir`.
   */
  static getSplitDir(landblockId: number, cellX: number, cellY: number): boolean {
    return computeCellSplitDir(landblockX(landblockId), landblockY(landblockId), cellX, cellY);
  }

  private static buildGeometry(landblock: LandblockData): LandblockGeometry {
    const GRID = 9;
    const CELL_SIZE = 24; // 192m / 8 = 24m per cell
    const vertexCount = GRID * GRID; // 81
    const quadCount = (GRID - 1) * (GRID - 1); // 64
    const triCount = quadCount * 2; // 128
    const indexCount = triCount * 3; // 384

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint16Array(indexCount);

    // Generate vertex positions
    // AC layout: index 0-8 is western edge (x=0), going south-to-north (y increases)
    // index 9-17 is next strip east, etc.
    // So: vertex at (col, row) = index col*9 + row
    // Position: x = col * 24, y = row * 24, z = height * 2
    for (let col = 0; col < GRID; col++) {
      for (let row = 0; row < GRID; row++) {
        const idx = col * GRID + row;
        const vi = idx * 3;
        positions[vi] = col * CELL_SIZE;     // x
        // Use LandHeightTable lookup if available, otherwise multiply by 2
        const rawHeight = landblock.heights[idx];
        positions[vi + 1] = landblock.landHeightTable
          ? landblock.landHeightTable[rawHeight]
          : rawHeight * 2;
        positions[vi + 2] = row * CELL_SIZE; // z

        // UVs: map to 0-1 range across the landblock, v running SOUTHWARD:
        // CLandBlockStruct::ConstructUVs @ 005329a0 lays each cell's surface
        // with land_uvs {(0,1),(1,1),(1,0),(0,0)} (SW, SE, NE, NW), so a
        // texture's row 0 is the cell's NORTH edge (VISUAL.terrain-type-
        // blending-vs-retail.a; matches the overlay uv1 + cellAlphaUVs).
        const ui = idx * 2;
        uvs[ui] = col / (GRID - 1);
        uvs[ui + 1] = 1 - row / (GRID - 1);
      }
    }

    const hasLandblockId = landblock.landblockId !== undefined;

    // Generate triangle indices (two triangles per quad)
    // Split direction varies per cell using PRNG when landblock ID is available
    let ii = 0;
    for (let col = 0; col < GRID - 1; col++) {
      for (let row = 0; row < GRID - 1; row++) {
        const sw = col * GRID + row;
        const se = (col + 1) * GRID + row;
        const nw = col * GRID + (row + 1);
        const ne = (col + 1) * GRID + (row + 1);

        // Determine split direction via PRNG (or default if no landblock ID)
        const splitNWtoSE = hasLandblockId
          ? LandblockMesh.getSplitDir(landblock.landblockId!, col, row)
          : true;

        if (splitNWtoSE) {
          // Diagonal from NW to SE
          indices[ii++] = sw;
          indices[ii++] = nw;
          indices[ii++] = se;

          indices[ii++] = se;
          indices[ii++] = nw;
          indices[ii++] = ne;
        } else {
          // Diagonal from SW to NE
          indices[ii++] = sw;
          indices[ii++] = nw;
          indices[ii++] = ne;

          indices[ii++] = sw;
          indices[ii++] = ne;
          indices[ii++] = se;
        }
      }
    }

    // Compute normals from triangles
    // Initialize to zero
    for (let i = 0; i < normals.length; i++) normals[i] = 0;

    for (let i = 0; i < indexCount; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      const ax = positions[i1] - positions[i0];
      const ay = positions[i1 + 1] - positions[i0 + 1];
      const az = positions[i1 + 2] - positions[i0 + 2];

      const bx = positions[i2] - positions[i0];
      const by = positions[i2 + 1] - positions[i0 + 1];
      const bz = positions[i2 + 2] - positions[i0 + 2];

      // Cross product, made a unit plane normal: CLandBlockStruct::
      // calc_lighting @ 00531700 adds each polygon's plane.N (unit length)
      // to its vertices, so every adjacent face weighs the same
      // (SWEEP1006 terrain normals) — not by its area.
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const cl = Math.hypot(cx, cy, cz) || 1;
      const nx = cx / cl, ny = cy / cl, nz = cz / cl;

      // Accumulate
      normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
      normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
      normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
    }

    // Normalize
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) {
        normals[i] /= len;
        normals[i + 1] /= len;
        normals[i + 2] /= len;
      } else {
        normals[i + 1] = 1; // default up normal
      }
    }

    return new LandblockGeometry(positions, normals, uvs, indices);
  }
}

// ─── DECOMP.terrain-lod — retail reduced-resolution landscape blocks ───────

/**
 * Retail `Direction` (the `trans_dir` of a CLandBlockStruct): which side of
 * the viewer a transitional block lies on. IN_VIEWER_BLOCK = no seam work.
 */
export const BlockDirection = {
  IN_VIEWER_BLOCK: 0,
  NORTH_OF_VIEWER: 1,
  SOUTH_OF_VIEWER: 2,
  EAST_OF_VIEWER: 3,
  WEST_OF_VIEWER: 4,
  NORTHWEST_OF_VIEWER: 5,
  SOUTHWEST_OF_VIEWER: 6,
  NORTHEAST_OF_VIEWER: 7,
  SOUTHEAST_OF_VIEWER: 8,
} as const;
export type BlockDirection = typeof BlockDirection[keyof typeof BlockDirection];

/** A block's retail level of detail: cells per side and seam direction. */
export interface BlockLod {
  /** `CLandBlockStruct::side_cell_count` = 8 / lod: 8, 4, 2 or 1. */
  sideCells: 8 | 4 | 2 | 1;
  /** `trans_dir`. */
  dir: BlockDirection;
}

/**
 * `LScape::get_block_orient` @ 00504f90 — a block's LOD from its offset
 * (dx east, dy north, in blocks) to the viewer's block. With d the
 * Chebyshev distance: d ≤ 1 → lod 1 (8×8 cells), d = 2 → lod 2 (4×4),
 * d = 3..4 → lod 4 (2×2), d ≥ 5 → lod 8 (1 cell, IN_VIEWER_BLOCK). The
 * direction is set only for a block ON the ring |dx| = lod or |dy| = lod —
 * the outer edge of its LOD band — so a d = 3 block gets none.
 */
export function retailBlockLod(dx: number, dy: number): BlockLod {
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  let lod: 1 | 2 | 4;
  if (d < 2) lod = 1;
  else if (d < 3) lod = 2;
  else if (d > 4) return { sideCells: 1, dir: BlockDirection.IN_VIEWER_BLOCK };
  else lod = 4;
  const sideCells = (8 / lod) as 8 | 4 | 2;
  let dir: BlockDirection;
  if (dx === lod) {
    dir = dy === lod ? BlockDirection.NORTHEAST_OF_VIEWER
      : dy === -lod ? BlockDirection.SOUTHEAST_OF_VIEWER : BlockDirection.EAST_OF_VIEWER;
  } else if (dx !== -lod) {
    dir = dy === lod ? BlockDirection.NORTH_OF_VIEWER
      : dy === -lod ? BlockDirection.SOUTH_OF_VIEWER : BlockDirection.IN_VIEWER_BLOCK;
  } else {
    dir = dy === lod ? BlockDirection.NORTHWEST_OF_VIEWER
      : dy === -lod ? BlockDirection.SOUTHWEST_OF_VIEWER : BlockDirection.WEST_OF_VIEWER;
  }
  return { sideCells, dir };
}

/**
 * One landblock rendered at a retail LOD: the geometry of
 * `CLandBlockStruct::generate` @ 00532bb0 plus the per-cell texturing inputs
 * `GetCellRotation` @ 00532170 reads — all at the reduced cell size.
 */
export interface LandblockLodMesh extends BlockLod {
  geometry: LandblockGeometry;
  /** Per cell (index x·side + y): base terrain type (TexMerge::GetTerrain). */
  cellTerrainTypes: number[];
  /** Per cell road mask (bit0 NW, bit1 NE, bit2 SE, bit3 SW). */
  cellRoadMasks: number[];
  /** Per cell SW, SE, NE, NW terrain types (index cell·4 + corner). */
  cellCornerTerrainTypes: number[];
  /** Per cell SW, SE, NE, NW road bits. */
  cellCornerRoadBits: number[];
}

/**
 * Build a landblock at a retail LOD — `CLandBlockStruct::generate`:
 *
 * - `ConstructVertices` @ 005328d0: (side+1)² vertices, x-major (index
 *   x·(side+1) + y), each the full-resolution height at (x·stride,
 *   y·stride), stride = 8 / side; spacing 192 m / side.
 * - `TransAdjust` @ 005323d0 when trans_dir ≠ IN_VIEWER_BLOCK and
 *   1 < side < 8 (see transAdjust).
 * - `ConstructPolygons` @ 00531d10: each cell's diagonal from the same hash
 *   as full resolution but keyed on the COARSE cell index added to the
 *   block's cell origin (blockX·8 + i, blockY·8 + j) — retail does not
 *   scale the index by the stride.
 * - `GetCellRotation`: a cell's corner terrain words are the full-res words
 *   at its corner vertices (index (x·9 + y)·stride).
 *
 * UVs are in CELL units (0..side across the block): a reduced block draws
 * one TexMerge surface per cell, built at the reduced size (TerrainRenderer).
 */
export function buildLandblockLod(landblock: LandblockData, lod: BlockLod): LandblockLodMesh {
  const side = lod.sideCells;
  const stride = 8 / side;
  const svc = side + 1;
  const cellSize = 192 / side;
  const heightAt = (fx: number, fy: number): number => {
    const raw = landblock.heights[fx * 9 + fy];
    return landblock.landHeightTable ? landblock.landHeightTable[raw] : raw * 2;
  };

  const positions = new Float32Array(svc * svc * 3);
  const uvs = new Float32Array(svc * svc * 2);
  for (let x = 0; x < svc; x++) {
    for (let y = 0; y < svc; y++) {
      const v = x * svc + y;
      positions[v * 3] = x * cellSize;
      positions[v * 3 + 1] = heightAt(x * stride, y * stride);
      positions[v * 3 + 2] = y * cellSize;
      uvs[v * 2] = x;
      uvs[v * 2 + 1] = side - y; // row 0 = a cell's north edge (land_uvs)
    }
  }

  if (lod.dir !== BlockDirection.IN_VIEWER_BLOCK && side > 1 && side < 8) {
    transAdjust(positions, side, lod.dir, heightAt);
  }

  const indices = new Uint16Array(side * side * 6);
  const hasId = landblock.landblockId !== undefined;
  const bx = hasId ? landblockX(landblock.landblockId!) : 0;
  const by = hasId ? landblockY(landblock.landblockId!) : 0;
  let ii = 0;
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      const sw = x * svc + y;
      const se = (x + 1) * svc + y;
      const nw = x * svc + y + 1;
      const ne = (x + 1) * svc + y + 1;
      const splitNWtoSE = hasId ? computeCellSplitDir(bx, by, x, y) : true;
      if (splitNWtoSE) {
        indices[ii++] = sw; indices[ii++] = nw; indices[ii++] = se;
        indices[ii++] = se; indices[ii++] = nw; indices[ii++] = ne;
      } else {
        indices[ii++] = sw; indices[ii++] = nw; indices[ii++] = ne;
        indices[ii++] = sw; indices[ii++] = ne; indices[ii++] = se;
      }
    }
  }

  const normals = computeSmoothNormals(positions, indices);
  const geometry = new LandblockGeometry(positions, normals, uvs, indices);

  // Per-cell texturing inputs from the corner vertices' terrain words.
  const terrain = landblock.terrain ?? [];
  const word = (fx: number, fy: number): number => terrain[fx * 9 + fy] ?? 0;
  const cellTerrainTypes: number[] = [];
  const cellRoadMasks: number[] = [];
  const cellCornerTerrainTypes: number[] = [];
  const cellCornerRoadBits: number[] = [];
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      const wSW = word(x * stride, y * stride);
      const wSE = word((x + 1) * stride, y * stride);
      const wNE = word((x + 1) * stride, (y + 1) * stride);
      const wNW = word(x * stride, (y + 1) * stride);
      cellTerrainTypes.push(cellBaseTerrainType((wSW >> 2) & 0x1f, (wSE >> 2) & 0x1f, (wNE >> 2) & 0x1f, (wNW >> 2) & 0x1f));
      let mask = 0;
      if (wNW & 3) mask |= 1;
      if (wNE & 3) mask |= 2;
      if (wSE & 3) mask |= 4;
      if (wSW & 3) mask |= 8;
      cellRoadMasks.push(mask);
      cellCornerTerrainTypes.push((wSW & 0x7f) >> 2, (wSE & 0x7f) >> 2, (wNE & 0x7f) >> 2, (wNW & 0x7f) >> 2);
      cellCornerRoadBits.push(wSW & 3, wSE & 3, wNE & 3, wNW & 3);
    }
  }
  return { ...lod, geometry, cellTerrainTypes, cellRoadMasks, cellCornerTerrainTypes, cellCornerRoadBits };
}

/**
 * `CLandBlockStruct::TransAdjust` @ 005323d0 — stitch a reduced block to its
 * coarser outer neighbour and hide the crack toward its finer inner one.
 * Vertex (x, y) is `positions[(x·(side+1) + y)·3 + 1]` (height).
 *
 * 1. The FAR edge(s) the direction names (north for N/NW/NE, west for
 *    NW/W/SW, south for SW/S/SE, east for SE/E/NE): every odd vertex
 *    becomes the mean of its two neighbours along the edge, so the edge is
 *    the half-resolution line the next ring draws.
 * 2. A 4-cell block (pure N / S / E / W only) also lowers each odd vertex
 *    of its NEAR edge (facing the 8-cell ring) to at most 2·h(±1) − h(±2)
 *    of the full-resolution heights either side of it (the finer ring's
 *    slope extended), so the coarse edge never rides above the fine one.
 */
function transAdjust(
  positions: Float32Array, side: number, dir: BlockDirection,
  heightAt: (fx: number, fy: number) => number,
): void {
  const svc = side + 1;
  const spc = side;
  const H = (x: number, y: number): number => positions[(x * svc + y) * 3 + 1];
  const setH = (x: number, y: number, h: number): void => { positions[(x * svc + y) * 3 + 1] = h; };
  const D = BlockDirection;
  if ((dir === D.NORTHWEST_OF_VIEWER || dir === D.NORTH_OF_VIEWER || dir === D.NORTHEAST_OF_VIEWER) && spc > 1) {
    for (let i = 1; i < spc; i += 2) setH(i, spc, (H(i - 1, spc) + H(i + 1, spc)) * 0.5);
  }
  if ((dir === D.NORTHWEST_OF_VIEWER || dir === D.WEST_OF_VIEWER || dir === D.SOUTHWEST_OF_VIEWER) && spc > 1) {
    for (let i = 1; i < spc; i += 2) setH(0, i, (H(0, i - 1) + H(0, i + 1)) * 0.5);
  }
  if ((dir === D.SOUTHWEST_OF_VIEWER || dir === D.SOUTH_OF_VIEWER || dir === D.SOUTHEAST_OF_VIEWER) && spc > 1) {
    for (let i = 1; i < spc; i += 2) setH(i, 0, (H(i - 1, 0) + H(i + 1, 0)) * 0.5);
  }
  if ((dir === D.SOUTHEAST_OF_VIEWER || dir === D.EAST_OF_VIEWER || dir === D.NORTHEAST_OF_VIEWER) && spc > 1) {
    for (let i = 1; i < spc; i += 2) setH(spc, i, (H(spc, i - 1) + H(spc, i + 1)) * 0.5);
  }
  if (side !== 4) return;
  const clamp = (x: number, y: number, a: number, b: number): void => {
    let z = H(x, y);
    if (a < z) z = a;
    if (b < z) z = b;
    setH(x, y, z);
  };
  for (let i = 1; i < spc; i += 2) {
    const f = 2 * i; // the full-resolution index of coarse vertex i
    if (dir === D.NORTH_OF_VIEWER) {
      clamp(i, 0, 2 * heightAt(f - 1, 0) - heightAt(f - 2, 0), 2 * heightAt(f + 1, 0) - heightAt(f + 2, 0));
    } else if (dir === D.SOUTH_OF_VIEWER) {
      clamp(i, spc, 2 * heightAt(f - 1, 8) - heightAt(f - 2, 8), 2 * heightAt(f + 1, 8) - heightAt(f + 2, 8));
    } else if (dir === D.EAST_OF_VIEWER) {
      clamp(0, i, 2 * heightAt(0, f - 1) - heightAt(0, f - 2), 2 * heightAt(0, f + 1) - heightAt(0, f + 2));
    } else if (dir === D.WEST_OF_VIEWER) {
      clamp(spc, i, 2 * heightAt(8, f - 1) - heightAt(8, f - 2), 2 * heightAt(8, f + 1) - heightAt(8, f + 2));
    }
  }
}

/** Vertex normals from the unit face normals (calc_lighting's equal weights, as buildGeometry). */
export function computeSmoothNormals(positions: Float32Array, indices: Uint16Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    const ax = positions[i1] - positions[i0];
    const ay = positions[i1 + 1] - positions[i0 + 1];
    const az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0];
    const by = positions[i2 + 1] - positions[i0 + 1];
    const bz = positions[i2 + 2] - positions[i0 + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const nx = cx / cl, ny = cy / cl, nz = cz / cl;
    normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
    normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
    normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 0) { normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len; } else normals[i + 1] = 1;
  }
  return normals;
}
