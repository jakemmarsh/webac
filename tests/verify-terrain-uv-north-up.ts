/**
 * VISUAL.terrain-type-blending-vs-retail.a — the landscape textures are laid
 * north-up, as CLandBlockStruct::ConstructUVs @ 005329a0 maps each cell with
 * land_uvs {(0,1),(1,1),(1,0),(0,0)} (SW, SE, NE, NW): texture row 0 sits on
 * the cell's NORTH edge. The base mesh (full and reduced LOD), the overlay
 * quads' unrotated uv1 and the alpha maps (cellAlphaUVs) must all agree, or
 * an overlay seams against the base under it.
 */
import { describe, it, expect } from 'vitest';
import { LandblockMesh, BlockDirection, buildLandblockLod, type LandblockData } from '../packages/renderer/src/terrain/LandblockMesh.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { OverlayMergePool, type PooledOverlayBucket } from '../packages/renderer/src/terrain/OverlayMergePool.js';
import { cellAlphaUVs } from '../packages/renderer/src/terrain/TexMergeCodes.js';
import type * as THREE from 'three';

function flat(id: number): LandblockData {
  return { heights: new Array(81).fill(0), terrain: new Array(81).fill(1 << 2), landblockId: id };
}

/** Base-mesh texture coordinates in CELL units for vertex (x, y) of a side×side block. */
function baseUV(uvs: Float32Array, side: number, x: number, y: number, cellsPerUV: number): [number, number] {
  const i = (x * (side + 1) + y) * 2;
  return [uvs[i] * cellsPerUV, uvs[i + 1] * cellsPerUV];
}

describe('VISUAL.terrain-type-blending-vs-retail.a — terrain UVs follow land_uvs (row 0 = north)', () => {
  it('the full-detail base mesh runs v southward: a cell\'s north edge is texture row 0', () => {
    const { uvs } = new LandblockMesh(flat(0xa9b4ffff)).geometry;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const [, vSouth] = baseUV(uvs, 8, x, y, 8);
        const [, vNorth] = baseUV(uvs, 8, x, y + 1, 8);
        expect(vSouth - vNorth).toBeCloseTo(1, 6);
        expect(Number.isInteger(Math.round(vNorth * 1e6) / 1e6)).toBe(true);
      }
    }
    // Block's north-west corner = (0, 0); south-west = (0, 8 cells).
    expect(baseUV(uvs, 8, 0, 8, 8)).toEqual([0, 0]);
    expect(baseUV(uvs, 8, 0, 0, 8)[1]).toBeCloseTo(8, 6);
  });

  it('a reduced-LOD block (cell-unit UVs) runs v southward too', () => {
    for (const side of [4, 2, 1] as const) {
      const { geometry } = buildLandblockLod(flat(0xa9b4ffff), { sideCells: side, dir: BlockDirection.IN_VIEWER_BLOCK });
      for (let x = 0; x <= side; x++) {
        for (let y = 0; y <= side; y++) {
          expect(baseUV(geometry.uvs, side, x, y, 1)).toEqual([x, side - y]);
        }
      }
    }
  });

  it('overlay uv1 at ROT_0 equals the base layout and the unrotated alpha UVs', () => {
    const b: PooledOverlayBucket = {
      verts: [], uvs: [], indices: [], quadCount: 0,
      material: {} as THREE.Material, layer: 0, rank: 0, name: 'blendmerge',
    };
    TerrainRenderer.appendOverlayQuad(b, 0, 0, 24, 0, 0, 0, 0, 1, true);
    const geom = OverlayMergePool.buildMergedGeometry([b]);
    const uv1 = Array.from(geom.getAttribute('uv1').array as Float32Array);
    expect(uv1).toEqual(cellAlphaUVs(0));

    // Same per-cell layout as the base mesh: corner (dx, dy) of a cell sits at
    // (dx, 1 - dy) in the cell's own texture space (SW, SE, NW, NE order).
    const { uvs } = new LandblockMesh(flat(0xa9b4ffff)).geometry;
    const cx = 3, cy = 5;
    const [, northV] = baseUV(uvs, 8, cx, cy + 1, 8);
    const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    corners.forEach(([dx, dy], k) => {
      const [u, v] = baseUV(uvs, 8, cx + dx, cy + dy, 8);
      expect(u - cx).toBeCloseTo(uv1[k * 2], 6);
      expect(v - northV).toBeCloseTo(uv1[k * 2 + 1], 6);
    });
  });
});
