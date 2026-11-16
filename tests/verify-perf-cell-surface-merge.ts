/**
 * PERF.cell-surface-merge (2026-11-16, docs/perf-pass-2026-11-15.md) — an
 * EnvCell's surface batches draw from ONE mesh per renderOrder band, a
 * geometry group per batch, over one shared set of vertex attributes, instead
 * of a Mesh + BufferGeometry (+ its own copies of the cell's attributes) per
 * batch. What must not change is what three.js draws and in what order:
 *  - one material per batch, cloned per cell in the batches' order (the opaque
 *    sort key is material.id), with the same side / clamp / clip state;
 *  - the clip-list batches in their own mesh at CLIP_LIST_RENDER_ORDER;
 *  - the same bounding sphere (frustum cull + transparent z) as each old mesh;
 *  - ray casts hit the same triangles (camera boom, DungeonCollision);
 *  - disposal frees the cell's geometry and its cloned materials.
 * Drives the real EnvCellRenderer / DungeonCollision / MaterialOwnership code.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EnvCellRenderer, cellSurfaceBatches } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { CLIP_LIST_RENDER_ORDER } from '../packages/renderer/src/models/MaterialFactory.js';
import { applyRetailLighting, CLIP_LIST_KEY } from '../packages/renderer/src/models/RetailLighting.js';
import { disposeObjectTree } from '../packages/renderer/src/models/MaterialOwnership.js';

const v = (x: number, y: number, z: number) => ({ origin: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, uvs: [{ u: x, v: y }] });

/** A box-ish cell: floor (surface 0, single-sided), wall (surface 1, two-sided), a clip-list grate (surface 2). */
function cell() {
  const vertices = new Map([
    [0, v(0, 0, 0)], [1, v(4, 0, 0)], [2, v(4, 4, 0)], [3, v(0, 4, 0)],
    [4, v(0, 0, 3)], [5, v(4, 0, 3)], [6, v(0, 4, 3)], [7, v(4, 4, 3)],
  ]);
  const polygons = new Map([
    [0, { stippling: 0, sidesType: 0, vertexIndices: [0, 1, 2, 3], posUVIndices: [0, 0, 0, 0], posSurface: 0 }],
    [1, { stippling: 0, sidesType: 1, vertexIndices: [0, 1, 5, 4], posUVIndices: [0, 0, 0, 0], posSurface: 1 }],
    [2, { stippling: 0, sidesType: 0, vertexIndices: [3, 2, 7, 6], posUVIndices: [0, 0, 0, 0], posSurface: 2 }],
    [3, { stippling: 0, sidesType: 0, vertexIndices: [0, 3, 6, 4], posUVIndices: [0, 0, 0, 0], posSurface: 0 }],
  ]);
  return { vertexArray: { vertices }, polygons };
}

function renderer() {
  const base = new Map<number, THREE.Material>();
  const getMaterial = (id: number) => {
    let m = base.get(id);
    if (!m) {
      m = applyRetailLighting(new THREE.MeshLambertMaterial({ color: id & 0xffffff }), 'object');
      if (id === 0x08000003) m.userData[CLIP_LIST_KEY] = true;
      base.set(id, m);
    }
    return m;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { r: new EnvCellRenderer({} as any, {} as any, { getMaterial, getSurface: () => null } as any), base };
}

const SURFACES = [0x08000001, 0x08000002, 0x08000003];

describe('PERF.cell-surface-merge — one mesh per cell band, a group per surface batch', () => {
  it('batches keep their own per-cell material, in creation order, with the old side / clip state', () => {
    const { r, base } = renderer();
    const group = r.buildCellGeometry(cell() as never, SURFACES);
    const meshes = group.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2); // the normal band and the clip band
    const batches = cellSurfaceBatches(group);
    expect(batches).toHaveLength(3); // floor+side wall (surface 0), the two-sided wall, the grate
    // Every batch its own clone (never the factory's), ids ascending in batch order: the opaque sort key.
    const mats = batches.map((b) => b.material);
    expect(new Set(mats).size).toBe(3);
    for (const m of mats) expect([...base.values()]).not.toContain(m);
    const ids = mats.map((m) => (m as unknown as { id: number }).id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const bySurface = (c: number) => batches.find((b) => (b.material as THREE.MeshLambertMaterial).color.getHex() === c)!;
    expect(bySurface(0x000001).material.side).toBe(THREE.FrontSide);
    expect(bySurface(0x000002).material.side).toBe(THREE.DoubleSide);
    const clip = bySurface(0x000003);
    expect(clip.mesh.renderOrder).toBe(CLIP_LIST_RENDER_ORDER);
    expect(bySurface(0x000001).mesh.renderOrder).toBe(0);
    expect(bySurface(0x000001).mesh).toBe(bySurface(0x000002).mesh);
    // Floor + side wall: two quads = 12 indices in one group.
    expect(bySurface(0x000001).count).toBe(12);
    for (const m of meshes) expect(m.userData.cellGeometry).toBe(true);
  });

  it('the bands share one set of vertex attributes and the old bounding sphere', () => {
    const { r } = renderer();
    const group = r.buildCellGeometry(cell() as never, SURFACES);
    const [a, b] = group.children as THREE.Mesh[];
    for (const name of ['position', 'normal', 'uv']) expect(a.geometry.getAttribute(name)).toBe(b.geometry.getAttribute(name));
    // The per-batch meshes each computed their sphere from the whole position array — so does each band.
    const old = new THREE.BufferGeometry();
    old.setAttribute('position', new THREE.BufferAttribute(a.geometry.getAttribute('position').array as Float32Array, 3));
    old.computeBoundingSphere();
    a.geometry.computeBoundingSphere(); b.geometry.computeBoundingSphere();
    expect(a.geometry.boundingSphere!.equals(old.boundingSphere!)).toBe(true);
    expect(b.geometry.boundingSphere!.equals(old.boundingSphere!)).toBe(true);
  });

  it('a ray hits the same triangles as the per-batch meshes did, double-sided casts included', () => {
    const { r } = renderer();
    const group = r.buildCellGeometry(cell() as never, SURFACES);
    group.updateMatrixWorld(true);
    // The old structure, rebuilt from the batches: a mesh per batch over the same arrays.
    const old = cellSurfaceBatches(group).map((bt) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', bt.mesh.geometry.getAttribute('position'));
      g.setIndex(new THREE.BufferAttribute((bt.mesh.geometry.index!.array as Uint16Array).slice(bt.start, bt.start + bt.count), 1));
      return new THREE.Mesh(g, bt.material);
    });
    const ray = new THREE.Raycaster();
    const key = (h: THREE.Intersection) => `${h.distance.toFixed(5)}:${h.point.toArray().map((x) => x.toFixed(4))}`;
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const o = new THREE.Vector3(Math.random() * 6 - 1, Math.random() * 5 - 1, Math.random() * 6 - 1);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      ray.set(o, d);
      const now = ray.intersectObjects(group.children, false).map(key).sort();
      const before = ray.intersectObjects(old, false).map(key).sort();
      expect(now).toEqual(before);
      hits += now.length;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('disposal frees each band geometry and every per-cell material clone', () => {
    const { r, base } = renderer();
    const group = r.buildCellGeometry(cell() as never, SURFACES);
    let geoms = 0; let mats = 0;
    for (const m of group.children as THREE.Mesh[]) m.geometry.addEventListener('dispose', () => { geoms++; });
    for (const b of cellSurfaceBatches(group)) b.material.addEventListener('dispose', () => { mats++; });
    let shared = 0;
    for (const m of base.values()) m.addEventListener('dispose', () => { shared++; });
    disposeObjectTree(group);
    expect(geoms).toBe(2);
    expect(mats).toBe(3);
    expect(shared).toBe(0);
  });
});
