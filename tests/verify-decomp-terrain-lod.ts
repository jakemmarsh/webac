/**
 * DECOMP.terrain-lod (decomp-diff sweep 2026-09-30, S1) — retail draws
 * distant landblocks at reduced resolution:
 *  - LScape::get_block_orient @ 00504f90: Chebyshev block distance d ≤ 1 →
 *    8 cells per side, d = 2 → 4, d = 3..4 → 2, d ≥ 5 → 1; a direction only
 *    on the outer ring of each band.
 *  - CLandBlockStruct::generate @ 00532bb0 → ConstructVertices (stride
 *    sampling), TransAdjust @ 005323d0 (seams), ConstructPolygons (split
 *    keyed on the coarse index).
 *  - The renderer re-LODs when the viewer's block changes, skipping blocks
 *    whose LOD is unchanged.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeCellSplitDir } from '../packages/shared/src/index.js';
import {
  LandblockMesh, BlockDirection, buildLandblockLod, retailBlockLod,
  type LandblockData,
} from '../packages/renderer/src/terrain/LandblockMesh.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';

const D = BlockDirection;

function bumpy(id: number): LandblockData {
  const heights: number[] = [];
  for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) heights.push((x * 37 + y * 11 + x * y * 5) % 97);
  return { heights, terrain: new Array(81).fill(1 << 2), landblockId: id };
}

const H = (pos: Float32Array, side: number, x: number, y: number): number => pos[(x * (side + 1) + y) * 3 + 1];

describe('S1 — LScape::get_block_orient', () => {
  it.each([
    [0, 0, 8, D.IN_VIEWER_BLOCK], [1, 0, 8, D.EAST_OF_VIEWER], [-1, -1, 8, D.SOUTHWEST_OF_VIEWER],
    [2, 0, 4, D.EAST_OF_VIEWER], [2, 2, 4, D.NORTHEAST_OF_VIEWER], [-2, 1, 4, D.WEST_OF_VIEWER],
    [1, -2, 4, D.SOUTH_OF_VIEWER], [-2, 2, 4, D.NORTHWEST_OF_VIEWER],
    [3, 0, 2, D.IN_VIEWER_BLOCK], [3, -3, 2, D.IN_VIEWER_BLOCK], [4, 0, 2, D.EAST_OF_VIEWER],
    [-4, -4, 2, D.SOUTHWEST_OF_VIEWER], [0, 4, 2, D.NORTH_OF_VIEWER], [4, -4, 2, D.SOUTHEAST_OF_VIEWER],
    [5, 0, 1, D.IN_VIEWER_BLOCK], [8, 3, 1, D.IN_VIEWER_BLOCK],
  ])('offset (%i, %i) → %i cells per side, direction %i', (dx, dy, side, dir) => {
    expect(retailBlockLod(dx, dy)).toEqual({ sideCells: side, dir });
  });
});

describe('S1 — CLandBlockStruct::generate at a reduced LOD', () => {
  const id = 0x3a5cffff;
  const data = bumpy(id);
  const full = new LandblockMesh(data);

  it('samples the full-resolution heights at the stride and cuts triangles 128 → 32 → 8 → 2', () => {
    for (const side of [4, 2, 1] as const) {
      const lod = buildLandblockLod(data, { sideCells: side, dir: D.IN_VIEWER_BLOCK });
      expect(lod.geometry.indices.length / 3).toBe(side * side * 2);
      const stride = 8 / side;
      for (let x = 0; x <= side; x++) for (let y = 0; y <= side; y++) {
        expect(H(lod.geometry.positions, side, x, y)).toBe(H(full.geometry.positions, 8, x * stride, y * stride));
      }
    }
  });

  it('each reduced cell\'s diagonal hashes the COARSE index (blockX·8 + i)', () => {
    const lod = buildLandblockLod(data, { sideCells: 4, dir: D.IN_VIEWER_BLOCK });
    const idx = lod.geometry.indices;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const cell = i * 4 + j;
      const nwToSe = computeCellSplitDir(0x3a, 0x5c, i, j);
      const ne = (i + 1) * 5 + j + 1;
      // NW→SE diagonal: the second triangle is (se, nw, ne); SW→NE: (sw, ne, se)
      const tri2 = [idx[cell * 6 + 3], idx[cell * 6 + 4], idx[cell * 6 + 5]];
      expect(tri2.includes(ne) && tri2.includes(i * 5 + j + 1)).toBe(nwToSe);
    }
  });

  it('TransAdjust (NORTH, 4 cells): the far north edge becomes the 2-cell line; the near south edge is lowered to the fine slope', () => {
    const adj = buildLandblockLod(data, { sideCells: 4, dir: D.NORTH_OF_VIEWER });
    const raw = buildLandblockLod(data, { sideCells: 4, dir: D.IN_VIEWER_BLOCK });
    const p = adj.geometry.positions;
    for (const i of [1, 3]) {
      expect(H(p, 4, i, 4)).toBeCloseTo((H(p, 4, i - 1, 4) + H(p, 4, i + 1, 4)) / 2, 5);
      const f = 2 * i;
      const h = (x: number): number => H(full.geometry.positions, 8, x, 0);
      const expected = Math.min(H(raw.geometry.positions, 4, i, 0), 2 * h(f - 1) - h(f - 2), 2 * h(f + 1) - h(f + 2));
      expect(H(p, 4, i, 0)).toBeCloseTo(expected, 5);
    }
    // even vertices are untouched
    expect(H(p, 4, 2, 4)).toBe(H(raw.geometry.positions, 4, 2, 4));
  });

  it('no crack: a 4-cell block\'s adjusted far edge lies on the next ring\'s 2-cell edge', () => {
    const inner = buildLandblockLod(data, { sideCells: 4, dir: D.EAST_OF_VIEWER });
    const outer = buildLandblockLod(data, { sideCells: 2, dir: D.IN_VIEWER_BLOCK });
    // inner east edge (x = 4) vs outer's west-edge line sampled at the same metres
    for (let y = 0; y <= 4; y++) {
      const m = y * 48;
      const t = (m % 96) / 96;
      const y0 = Math.floor(m / 96);
      const outerH = y0 >= 2
        ? H(outer.geometry.positions, 2, 2, 2)
        : H(outer.geometry.positions, 2, 2, y0) * (1 - t) + H(outer.geometry.positions, 2, 2, y0 + 1) * t;
      expect(H(inner.geometry.positions, 4, 4, y)).toBeCloseTo(outerH, 4);
    }
  });

  it('a 2-cell block on its ring edge averages its far edge; 1-cell and 8-cell blocks never adjust', () => {
    const two = buildLandblockLod(data, { sideCells: 2, dir: D.WEST_OF_VIEWER });
    expect(H(two.geometry.positions, 2, 0, 1)).toBeCloseTo((H(two.geometry.positions, 2, 0, 0) + H(two.geometry.positions, 2, 0, 2)) / 2, 5);
    const one = buildLandblockLod(data, { sideCells: 1, dir: D.EAST_OF_VIEWER });
    expect(H(one.geometry.positions, 1, 1, 1)).toBe(H(full.geometry.positions, 8, 8, 8));
  });
});

describe('S1 — TerrainRenderer re-LODs on a viewer block change', () => {
  function grid(center: number, r: number): Map<number, LandblockMesh> {
    const m = new Map<number, LandblockMesh>();
    for (let x = center - r; x <= center + r; x++) for (let y = center - r; y <= center + r; y++) {
      const id = TerrainManager.blockToFileId(x, y);
      m.set(id, new LandblockMesh(bumpy(id)));
    }
    return m;
  }
  function renderer(blocks: Map<number, LandblockMesh>) {
    let first = true;
    const manager = {
      clear: () => {},
      getLoadedMeshes: () => blocks,
      getMesh: (id: number) => blocks.get(id),
      update: () => {
        const loaded = first ? [...blocks.keys()] : [];
        first = false;
        return { loaded, unloaded: [] as number[] };
      },
    } as unknown as TerrainManager;
    return new TerrainRenderer(new THREE.Scene(), manager);
  }
  const tris = (m: THREE.Mesh | undefined): number => (m!.geometry.getIndex()!.count / 3);

  it('full detail on the 3×3, 32 / 8 / 2 triangles by ring; walking one block east re-LODs the rings', () => {
    const blocks = grid(0x40, 6);
    const tr = renderer(blocks);
    const at = (bx: number): number => bx * 192 + 96;
    tr.update(at(0x40), at(0x40));
    const id = (x: number, y: number): number => TerrainManager.blockToFileId(x, y);
    expect(tris(tr.getMesh(id(0x40, 0x40)))).toBe(128);
    expect(tris(tr.getMesh(id(0x41, 0x41)))).toBe(128);
    expect(tris(tr.getMesh(id(0x42, 0x40)))).toBe(32);
    expect(tris(tr.getMesh(id(0x44, 0x40)))).toBe(8);
    expect(tris(tr.getMesh(id(0x45, 0x40)))).toBe(2);
    expect(tr.getBlockLod(id(0x42, 0x40))).toEqual({ sideCells: 4, dir: D.EAST_OF_VIEWER });

    const unchanged = tr.getMesh(id(0x46, 0x40)); // d 6 → 5: still 1 cell
    const stale = tr.getMesh(id(0x42, 0x40));
    tr.update(at(0x41), at(0x40));
    expect(tris(tr.getMesh(id(0x42, 0x40)))).toBe(128);
    expect(tr.getMesh(id(0x42, 0x40))).not.toBe(stale);
    expect(tris(tr.getMesh(id(0x3f, 0x40)))).toBe(32);
    expect(tr.getMesh(id(0x46, 0x40))).toBe(unchanged); // generate's early-out
  });
});
