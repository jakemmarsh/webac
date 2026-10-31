/**
 * PERF.terrain-base-pool — every landblock's base terrain triangles draw
 * from one world-space mesh per material, and the pool always holds exactly
 * the triangles of the blocks loaded, at their LOD.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BaseTerrainPool, BASE_TERRAIN_POOL_NAME } from '../packages/renderer/src/terrain/BaseTerrainPool.js';
import { LandblockMesh, type LandblockData } from '../packages/renderer/src/terrain/LandblockMesh.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';
import { TERRAIN_RENDER_ORDER } from '../packages/renderer/src/world/PortalPunch.js';

type Tri = string;

/** Every triangle of `mesh` drawn with `material`, as world-space vertex (position, normal, uv) keys. */
function trianglesOf(mesh: THREE.Mesh, material: THREE.Material): Tri[] {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry;
  const idx = g.getIndex()!;
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), uv = g.getAttribute('uv');
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = g.groups.length ? g.groups : [{ start: 0, count: idx.count, materialIndex: 0 }];
  const v = new THREE.Vector3();
  const out: Tri[] = [];
  for (const gr of groups) {
    if (mats[gr.materialIndex ?? 0] !== material) continue;
    for (let i = gr.start; i < gr.start + gr.count; i += 3) {
      const corners: string[] = [];
      for (let k = 0; k < 3; k++) {
        const vi = idx.getX(i + k);
        v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        corners.push([v.x, v.y, v.z, nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi), uv.getX(vi), uv.getY(vi)].map(n => Math.fround(n).toFixed(4)).join(','));
      }
      out.push(corners.join('|'));
    }
  }
  return out;
}

function blockMesh(bx: number, by: number, mats: THREE.Material[], cellMat: (c: number) => number): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  for (let x = 0; x <= 2; x++) for (let y = 0; y <= 2; y++) {
    positions.push(x * 96, (x * 7 + y * 3) % 11, y * 96); normals.push(0, 1, 0); uvs.push(x / 2, y / 2);
  }
  const at = (x: number, y: number) => x * 3 + y;
  const byMat: number[][] = mats.map(() => []);
  for (let c = 0; c < 4; c++) {
    const x = c >> 1, y = c & 1;
    byMat[cellMat(c)].push(at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
  }
  const index: number[] = [];
  byMat.forEach((list, m) => { if (list.length) geom.addGroup(index.length, list.length, m); index.push(...list); });
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(index);
  const mesh = new THREE.Mesh(geom, mats);
  mesh.position.set(bx * 192, 0, by * 192);
  return mesh;
}

describe('BaseTerrainPool', () => {
  const grass = new THREE.MeshLambertMaterial();
  const dirt = new THREE.MeshLambertMaterial();

  it('draws each material once, with exactly the blocks\' world-space triangles', () => {
    const scene = new THREE.Scene();
    const pool = new BaseTerrainPool(scene);
    const blocks = [
      blockMesh(100, 100, [grass, dirt], c => (c === 3 ? 1 : 0)),
      blockMesh(101, 100, [grass, dirt], c => (c % 2)),
      blockMesh(100, 101, [grass], () => 0),
    ];
    blocks.forEach((m, i) => pool.addBlock(i, m));
    pool.flush();
    expect(scene.children).toHaveLength(2);
    for (const material of [grass, dirt]) {
      const poolMesh = pool.meshes.find(m => m.material === material)!;
      expect(poolMesh.name).toBe(BASE_TERRAIN_POOL_NAME);
      expect(poolMesh.renderOrder).toBe(TERRAIN_RENDER_ORDER);
      const expected = blocks.flatMap(b => trianglesOf(b, material)).sort();
      expect(trianglesOf(poolMesh, material).sort()).toEqual(expected);
    }
  });

  it('removing a block takes its triangles out; a material left with none is removed from the scene', () => {
    const scene = new THREE.Scene();
    const pool = new BaseTerrainPool(scene);
    const a = blockMesh(10, 10, [grass, dirt], c => (c === 0 ? 1 : 0));
    const b = blockMesh(11, 10, [grass], () => 0);
    pool.addBlock(1, a); pool.addBlock(2, b); pool.flush();
    pool.removeBlock(1); pool.flush();
    expect(pool.meshes.map(m => m.material)).toEqual([grass]);
    expect(trianglesOf(pool.meshes[0], grass).sort()).toEqual(trianglesOf(b, grass).sort());
    expect(scene.children).toEqual(pool.meshes);
  });

  it('keeps world positions exact when the block set (and so the mesh origin) moves', () => {
    const scene = new THREE.Scene();
    const pool = new BaseTerrainPool(scene);
    const far = blockMesh(170, 180, [grass], () => 0);
    pool.addBlock(1, blockMesh(160, 180, [grass], () => 0));
    pool.addBlock(2, far);
    pool.flush();
    const before = pool.meshes[0].position.x;
    pool.removeBlock(1); pool.flush();
    expect(pool.meshes[0].position.x).not.toBe(before);
    expect(pool.meshes[0].matrixAutoUpdate).toBe(false);
    // Read the frozen world matrix as drawn (no forced update).
    const m = pool.meshes[0];
    const v = new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, 0).applyMatrix4(m.matrixWorld);
    const w = new THREE.Vector3().fromBufferAttribute(far.geometry.getAttribute('position') as THREE.BufferAttribute, 0).add(far.position);
    expect(v.distanceTo(w)).toBeLessThan(1e-3);
    // Vertices stay near the mesh origin, not at world scale.
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(Math.abs(pos.getX(i))).toBeLessThan(400);
  });

  it('hides and shows with the landscape, including meshes made while hidden', () => {
    const scene = new THREE.Scene();
    const pool = new BaseTerrainPool(scene);
    pool.setVisible(false);
    pool.addBlock(1, blockMesh(5, 5, [grass], () => 0)); pool.flush();
    expect(pool.meshes[0].visible).toBe(false);
    pool.setVisible(true);
    expect(pool.meshes[0].visible).toBe(true);
  });

  it('switches to 32-bit indices past 65,535 vertices', () => {
    const scene = new THREE.Scene();
    const pool = new BaseTerrainPool(scene);
    for (let i = 0; i < 7300; i++) pool.addBlock(i, blockMesh(i % 100, Math.floor(i / 100), [grass], () => 0));
    pool.flush();
    const idx = pool.meshes[0].geometry.getIndex()!;
    expect(idx.array).toBeInstanceOf(Uint32Array);
    expect(idx.count).toBe(7300 * 24);
    expect((idx.array as Uint32Array).reduce((a, b) => Math.max(a, b), 0)).toBe(7300 * 9 - 1);
  });
});

describe('TerrainRenderer draws its blocks through the base pool', () => {
  function bumpy(id: number): LandblockData {
    const heights: number[] = [];
    for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) heights.push((x * 37 + y * 11 + x * y * 5) % 97);
    return { heights, terrain: new Array(81).fill(1 << 2), landblockId: id };
  }

  it('the pool holds exactly the loaded blocks\' triangles at their LOD as the viewer moves', () => {
    const blocks = new Map<number, LandblockMesh>();
    for (let x = 0x40 - 6; x <= 0x40 + 6; x++) for (let y = 0x40 - 6; y <= 0x40 + 6; y++) {
      const id = TerrainManager.blockToFileId(x, y);
      blocks.set(id, new LandblockMesh(bumpy(id)));
    }
    let first = true;
    const manager = {
      clear: () => {},
      getLoadedMeshes: () => blocks,
      getMesh: (id: number) => blocks.get(id),
      update: () => { const loaded = first ? [...blocks.keys()] : []; first = false; return { loaded, unloaded: [] as number[] }; },
    } as unknown as TerrainManager;
    const scene = new THREE.Scene();
    const tr = new TerrainRenderer(scene, manager);
    const check = () => {
      expect(scene.children.filter(c => c.name === BASE_TERRAIN_POOL_NAME)).toEqual(tr.baseTerrainPool.meshes);
      const material = tr.baseTerrainPool.meshes[0].material as THREE.Material;
      const expected = [...blocks.keys()].flatMap(id => trianglesOf(tr.getMesh(id)!, material)).sort();
      const got = tr.baseTerrainPool.meshes.flatMap(m => trianglesOf(m, material)).sort();
      expect(got).toEqual(expected);
      for (const id of blocks.keys()) expect(tr.getMesh(id)!.parent).toBeNull();
    };
    tr.update(0x40 * 192 + 96, 0x40 * 192 + 96);
    check();
    tr.update(0x41 * 192 + 96, 0x40 * 192 + 96); // re-LODs the rings
    check();
    tr.setLandscapeVisible(false);
    expect(tr.baseTerrainPool.meshes.every(m => !m.visible)).toBe(true);
    tr.setLandscapeVisible(true);
    tr.clear();
    expect(scene.children.filter(c => c.name === BASE_TERRAIN_POOL_NAME)).toHaveLength(0);
  });
});
