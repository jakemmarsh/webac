/**
 * PERF.1: the terrain landblock mesh emits ONE geometry group per material
 * instead of one per cell. three.js issues a draw call per group, so per-cell
 * grouping cost 64 draws per landblock (~1,700/frame across the loaded region
 * at Holtburg — the largest single draw-call bucket). The index buffer is
 * permuted so same-material cells are contiguous; these tests drive the real
 * LandblockMesh + TerrainRenderer and assert the drawn triangles are EXACTLY
 * the old per-cell mapping (same 6-index runs, same material per cell), just
 * regrouped — the covenant's "visually identical" in index-buffer form.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TerrainRenderer } from '@ac/renderer/terrain/TerrainRenderer.js';
import { LandblockMesh, type LandblockData } from '@ac/renderer/terrain/LandblockMesh.js';
import type { TerrainManager } from '@ac/renderer/terrain/TerrainManager.js';

/** Terrain uint16 with the given type in bits 2-6 (road bits 0-1 zero). */
function terrainWord(type: number): number {
  return (type & 0x1f) << 2;
}

/** Build a real LandblockMesh whose 64 cells have the given per-cell types.
 *  cellTypes is in the same col*8+row order LandblockMesh extracts. */
function makeLbMesh(cellTypes: number[]): LandblockMesh {
  const terrain = new Array(81).fill(0);
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 8; row++) {
      terrain[col * 9 + row] = terrainWord(cellTypes[col * 8 + row]);
    }
  }
  const heights: number[] = [];
  for (let i = 0; i < 81; i++) heights.push((i * 7) % 11); // bumpy, deterministic
  const data: LandblockData = { heights, terrain, landblockId: 0xa9b4ffff };
  const mesh = LandblockMesh.create(data);
  // A cell's material is its TexMerge::GetTerrain base type, which reads all
  // four corners (VISUAL.terrain-type-blending-vs-retail); these tests are
  // about grouping, so pin each cell's type directly.
  mesh.cellTerrainTypes = cellTypes.slice();
  return mesh;
}

function makeRenderer(typeMaterials: Map<number, THREE.Material>): TerrainRenderer {
  const renderer = new TerrainRenderer(
    new THREE.Scene(),
    { clear: () => {} } as unknown as TerrainManager,
  );
  // Multi-material mode is normally armed from Region TMTerrainDesc data;
  // arm it directly with known materials so material→type mapping is testable.
  for (const [tt, mat] of typeMaterials) renderer['terrainMaterials'].set(tt, mat);
  renderer['useMultiMaterial'] = true;
  return renderer;
}

function buildMesh(renderer: TerrainRenderer, lbMesh: LandblockMesh): THREE.Mesh {
  return renderer['createMultiMaterialMesh'](lbMesh);
}

/** The 6-index run the ORIGINAL geometry assigns to a cell. */
function cellRun(lbMesh: LandblockMesh, cellIdx: number): number[] {
  return Array.from(lbMesh.geometry.indices.slice(cellIdx * 6, cellIdx * 6 + 6));
}

describe('terrain landblock mesh — one draw group per material (PERF.1)', () => {
  const matA = new THREE.MeshLambertMaterial();
  const matB = new THREE.MeshLambertMaterial();
  const matC = new THREE.MeshLambertMaterial();

  it('a landblock with 3 terrain types gets 3 groups, not 64', () => {
    const cellTypes = new Array(64).fill(1);
    for (let i = 0; i < 64; i += 3) cellTypes[i] = 2;
    for (let i = 1; i < 64; i += 7) cellTypes[i] = 5;
    const lbMesh = makeLbMesh(cellTypes);
    const mesh = buildMesh(makeRenderer(new Map([[1, matA], [2, matB], [5, matC]])), lbMesh);

    expect(mesh.geometry.groups.length).toBe(3);
    expect((mesh.material as THREE.Material[]).length).toBe(3);
  });

  it('a single-type landblock collapses to ONE group covering all 384 indices', () => {
    const lbMesh = makeLbMesh(new Array(64).fill(4));
    const mesh = buildMesh(makeRenderer(new Map([[4, matA]])), lbMesh);

    expect(mesh.geometry.groups).toEqual([{ start: 0, count: 384, materialIndex: 0 }]);
    expect((mesh.material as THREE.Material[])[0]).toBe(matA);
  });

  it('groups tile the whole index buffer exactly once (no gaps, no overlap)', () => {
    const cellTypes = new Array(64).fill(1).map((_, i) => [1, 2, 5, 9][i % 4]);
    const lbMesh = makeLbMesh(cellTypes);
    const mesh = buildMesh(
      makeRenderer(new Map([[1, matA], [2, matB], [5, matC], [9, matA]])),
      lbMesh,
    );

    const groups = [...mesh.geometry.groups].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const g of groups) {
      expect(g.start).toBe(cursor);
      cursor += g.count;
    }
    expect(cursor).toBe(384);
  });

  it('every cell draws its exact original 6-index run under its exact original material', () => {
    // Scatter 4 types over the block, one cell per type in odd spots too.
    const cellTypes = new Array(64).fill(2);
    cellTypes[0] = 7; cellTypes[13] = 7; cellTypes[63] = 7;
    for (let i = 16; i < 32; i++) cellTypes[i] = 11;
    cellTypes[40] = 30;
    const typeMats = new Map<number, THREE.Material>([[2, matA], [7, matB], [11, matC], [30, matA]]);
    const lbMesh = makeLbMesh(cellTypes);
    const mesh = buildMesh(makeRenderer(typeMats), lbMesh);
    const geom = mesh.geometry;
    const materials = mesh.material as THREE.Material[];
    const newIdx = geom.getIndex()!.array;

    // Slice the new index buffer into per-cell 6-index runs and match each
    // against the original cell runs — every original run must appear exactly
    // once, inside a group whose material is the cell's type material.
    const runsSeen = new Map<string, THREE.Material>();
    for (const g of geom.groups) {
      expect(g.count % 6).toBe(0);
      for (let s = g.start; s < g.start + g.count; s += 6) {
        const run = Array.from(newIdx.slice(s, s + 6)).join(',');
        expect(runsSeen.has(run)).toBe(false); // no duplicated cell
        runsSeen.set(run, materials[g.materialIndex!]);
      }
    }
    expect(runsSeen.size).toBe(64);
    for (let cellIdx = 0; cellIdx < 64; cellIdx++) {
      const run = cellRun(lbMesh, cellIdx).join(',');
      const mat = runsSeen.get(run);
      expect(mat, `cell ${cellIdx} run missing from merged buffer`).toBeDefined();
      expect(mat).toBe(typeMats.get(cellTypes[cellIdx]));
    }
  });

  it('vertex attributes (positions/normals/uvs) are byte-identical to the unmerged geometry', () => {
    const cellTypes = new Array(64).fill(1).map((_, i) => (i % 2 ? 1 : 3));
    const lbMesh = makeLbMesh(cellTypes);
    const mesh = buildMesh(makeRenderer(new Map([[1, matA], [3, matB]])), lbMesh);
    const reference = TerrainRenderer.toBufferGeometry(lbMesh.geometry);

    for (const attr of ['position', 'normal', 'uv'] as const) {
      expect(Array.from(mesh.geometry.getAttribute(attr).array))
        .toEqual(Array.from(reference.getAttribute(attr).array));
    }
    // Index is a permutation of cell runs: same multiset of indices overall.
    const sortedNew = Array.from(mesh.geometry.getIndex()!.array).sort((a, b) => a - b);
    const sortedRef = Array.from(reference.getIndex()!.array).sort((a, b) => a - b);
    expect(sortedNew).toEqual(sortedRef);
  });

  it('unknown terrain types fall back to the default material, still merged into one group each', () => {
    // Type 6 has no material registered — old code fell back to this.material.
    const cellTypes = new Array(64).fill(6);
    cellTypes[5] = 1;
    const lbMesh = makeLbMesh(cellTypes);
    const renderer = makeRenderer(new Map([[1, matA]]));
    const mesh = buildMesh(renderer, lbMesh);

    expect(mesh.geometry.groups.length).toBe(2);
    const materials = mesh.material as THREE.Material[];
    const fallbackGroup = mesh.geometry.groups.find(g => g.count === 63 * 6)!;
    expect(fallbackGroup).toBeDefined();
    expect(materials[fallbackGroup.materialIndex!]).toBe(renderer['material']);
  });
});
