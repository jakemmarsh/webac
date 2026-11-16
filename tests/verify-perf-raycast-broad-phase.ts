/**
 * PERF.integrated-gpu-cpu-bound (2026-11-15) — DungeonCollision's render-mesh
 * casts (camera boom every frame, outdoor ray fallbacks) run three's own
 * bounding-sphere early-out first (world/RaycastBroadPhase.ts) and flip /
 * cast only the meshes it keeps.
 *
 * Same hits: a town of building-like meshes (shared single-sided materials,
 * rotated / scaled parents, a multi-material mesh, an InstancedMesh pool
 * spread over the region, one mesh with no bounding sphere yet) is cast with
 * 3,000 random rays at boom-like and long reaches, once through the old path
 * (flip every material, intersectObjects on all) and once through
 * intersectRenderMeshes: distance, point, object, faceIndex and instanceId
 * agree hit for hit, and every material's side is restored. Less work:
 * per cast, Mesh/InstancedMesh.raycast runs only for the kept meshes and
 * only their materials are flipped (counts asserted below).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { rayMayHit, rayCandidates, StaticRayGrid } from '../packages/renderer/src/world/RaycastBroadPhase.js';
import { freezeStaticTransform, refreeze } from '../packages/renderer/src/utils/freezeStatic.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

interface Town { objects: THREE.Object3D[]; materials: THREE.Material[]; meshCount: number }

function buildTown(r: () => number): Town {
  const materials = [THREE.FrontSide, THREE.BackSide, THREE.FrontSide, THREE.DoubleSide].map((side) => new THREE.MeshLambertMaterial({ side }));
  const geos = [new THREE.BoxGeometry(8, 6, 10), new THREE.BoxGeometry(3, 12, 3), new THREE.CylinderGeometry(2, 3, 5, 8)];
  const objects: THREE.Object3D[] = [];
  let meshCount = 0;
  for (let i = 0; i < 300; i++) {
    const building = new THREE.Group();
    building.position.set(r() * 600, r() * 4, r() * 600);
    building.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
    if (i % 7 === 0) building.scale.setScalar(0.5 + r() * 1.5);
    const parts = 1 + Math.floor(r() * 3);
    for (let p = 0; p < parts; p++) {
      // a multi-material building: the box's six groups over three single-sided materials
      const g = i % 11 === 0 ? geos[0] : geos[Math.floor(r() * geos.length)];
      const mat = i % 11 === 0 ? [0, 1, 2, 0, 1, 2].map((k) => materials[k]) : materials[Math.floor(r() * materials.length)];
      const mesh = new THREE.Mesh(i === 5 ? g.clone() : g, mat as THREE.Material);
      mesh.position.set(r() * 4 - 2, r() * 2, r() * 4 - 2);
      building.add(mesh);
      meshCount++;
    }
    objects.push(building);
  }
  // A pooled building: one InstancedMesh, instances over the whole region.
  const pool = new THREE.InstancedMesh(geos[0], materials[0], 40);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 40; i++) pool.setMatrixAt(i, m.compose(new THREE.Vector3(r() * 600, 0, r() * 600), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6), new THREE.Vector3(1, 1, 1)));
  objects.push(pool);
  meshCount++;
  return { objects, materials, meshCount };
}

/** The pre-change intersectRenderMeshes: flip every material, cast against every mesh. */
function oldCast(meshes: THREE.Mesh[], raycaster: THREE.Raycaster): THREE.Intersection[] {
  const restore: Array<[THREE.Material, THREE.Side]> = [];
  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m.side !== THREE.DoubleSide) { restore.push([m, m.side]); m.side = THREE.DoubleSide; }
  }
  try { return raycaster.intersectObjects(meshes, false); } finally { for (const [m, side] of restore) m.side = side; }
}

function key(h: THREE.Intersection): string {
  return [h.distance, h.point.x, h.point.y, h.point.z, h.object.uuid, h.faceIndex, h.instanceId].join('|');
}

describe('RaycastBroadPhase — DungeonCollision casts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the old path\'s hits, hit for hit, and raycasts / flips only the kept meshes', () => {
    const r = rng(42);
    const town = buildTown(r);
    const dc = new DungeonCollision();
    dc.setMeshes(town.objects);
    const meshes = (dc as unknown as { renderMeshes: THREE.Mesh[] }).renderMeshes;
    expect(meshes.length).toBe(town.meshCount);
    const raycaster = (dc as unknown as { raycaster: THREE.Raycaster }).raycaster;
    const cast = () => (dc as unknown as { intersectRenderMeshes(): THREE.Intersection[] }).intersectRenderMeshes();
    const sides = town.materials.map((m) => m.side);

    let hitsSeen = 0, oldRaycasts = 0, newRaycasts = 0;
    // Work = objects handed to Raycaster.intersectObjects (each costs a raycast call and, before, a material flip).
    // (Spying on Mesh.prototype.raycast would replace the very method the broad phase recognises.)
    // (counted at call time: the broad phase reuses and clears its candidate array afterwards)
    const origIO = raycaster.intersectObjects.bind(raycaster);
    let handedCount = 0;
    vi.spyOn(raycaster, 'intersectObjects').mockImplementation((objs, rec, out) => { handedCount += objs.length; return origIO(objs, rec, out); });
    const handed = () => { const n = handedCount; handedCount = 0; return n; };
    const dir = new THREE.Vector3();
    for (let i = 0; i < 3000; i++) {
      const origin = new THREE.Vector3(r() * 600, r() * 8, r() * 600);
      dir.set(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5).normalize();
      raycaster.set(origin, dir);
      raycaster.near = i % 13 === 0 ? 0.5 : 0;
      raycaster.far = i % 5 === 0 ? 400 : 3 + r() * 20; // the boom reach, and long fallbacks
      const before = oldCast(meshes, raycaster).map(key);
      oldRaycasts += handed();
      const after = cast().map(key);
      newRaycasts += handed();
      expect(after).toEqual(before);
      hitsSeen += before.length;
      expect(town.materials.map((m) => m.side)).toEqual(sides);
    }
    // the comparison saw real hits, including the pool's and the multi-material mesh's
    expect(hitsSeen).toBeGreaterThan(200);
    expect(oldRaycasts).toBe(3000 * town.meshCount);
    // the boom-length casts keep a handful of the ~600 meshes
    expect(newRaycasts).toBeLessThan(oldRaycasts / 10);
    console.log(`broad phase: ${oldRaycasts} -> ${newRaycasts} objects cast over 3,000 rays (${town.meshCount} meshes)`);
  });

  it('rayMayHit is false only where three would return before testing triangles', () => {
    const r = rng(5);
    const town = buildTown(r);
    const all: THREE.Mesh[] = [];
    for (const o of town.objects) { o.updateMatrixWorld(true); o.traverse((c) => { if ((c as THREE.Mesh).isMesh) all.push(c as THREE.Mesh); }); }
    const raycaster = new THREE.Raycaster();
    for (let i = 0; i < 2000; i++) {
      raycaster.set(new THREE.Vector3(r() * 600, r() * 8, r() * 600), new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize());
      raycaster.far = 2 + r() * 50;
      for (const m of all) {
        if (rayMayHit(m, raycaster)) continue;
        const hits: THREE.Intersection[] = [];
        m.raycast(raycaster, hits);
        expect(hits.length).toBe(0);
      }
    }
  });

  it('keeps objects with any other raycast, and drops a material-less mesh without computing its sphere', () => {
    const raycaster = new THREE.Raycaster(new THREE.Vector3(1e6, 0, 0), new THREE.Vector3(1, 0, 0), 0, 1);
    const points = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)));
    expect(rayMayHit(points, raycaster)).toBe(true);
    const bare = new THREE.Mesh(new THREE.BoxGeometry());
    (bare as unknown as { material: undefined }).material = undefined;
    expect(rayMayHit(bare, raycaster)).toBe(false);
    expect(bare.geometry.boundingSphere).toBeNull();
  });

  // PERF.ray-grid (2026-11-15) — StaticRayGrid: frozen meshes are found through an x / z grid; the survivors
  // are rayCandidates' own, in the same order, so the casts' hits cannot change.
  it("StaticRayGrid keeps rayCandidates' plain-mesh survivors in order, and the same hits, for frozen and moving meshes", () => {
    const r = rng(77);
    const town = buildTown(r);
    // A cell's furniture pool: a small InstancedMesh (identity) under a frozen cell group.
    for (let c = 0; c < 40; c++) {
      const cell = new THREE.Group();
      cell.position.set(r() * 600, r() * 4, r() * 600);
      const pool = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 4);
      const m = new THREE.Matrix4();
      for (let k = 0; k < 4; k++) pool.setMatrixAt(k, m.makeTranslation(r() * 8 - 4, 0, r() * 8 - 4));
      cell.add(pool);
      town.objects.push(cell);
    }
    // Most buildings are placed once and frozen (as the game's cells and shells are); some stay live.
    town.objects.forEach((o, i) => { if (i % 4 !== 0) freezeStaticTransform(o); else o.updateMatrixWorld(true); });
    const all: THREE.Mesh[] = [];
    for (const o of town.objects) o.traverse((c) => { if ((c as THREE.Mesh).isMesh || (c as THREE.InstancedMesh).isInstancedMesh) all.push(c as THREE.Mesh); });
    const grid = new StaticRayGrid<THREE.Mesh>();
    grid.build(all);
    const raycaster = new THREE.Raycaster();
    const a: THREE.Mesh[] = [], b: THREE.Mesh[] = [];
    const plain = (m: THREE.Mesh) => !(m as unknown as THREE.InstancedMesh).isInstancedMesh;
    const hits = (list: THREE.Mesh[]) => raycaster.intersectObjects(list, false).map(key);
    let kept = 0, hitCount = 0;
    for (let i = 0; i < 4000; i++) {
      // A live (unfrozen) building moves between casts: it must be found wherever it is.
      if (i % 50 === 0) { const live = town.objects[((i / 50) % 75) * 4]; live.position.x += 30; live.updateMatrixWorld(true); }
      raycaster.set(new THREE.Vector3(r() * 600, r() * 8, r() * 600), new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5).normalize());
      raycaster.near = i % 13 === 0 ? 0.5 : 0;
      raycaster.far = i % 7 === 0 ? 1000 : i % 11 === 0 ? Infinity : 3 + r() * 30;
      grid.candidates(raycaster, b); rayCandidates(all, raycaster, a);
      expect(b.filter(plain).map((m) => m.uuid)).toEqual(a.filter(plain).map((m) => m.uuid));
      const h = hits(a);
      expect(hits(b)).toEqual(h);
      kept += a.length; hitCount += h.length;
    }
    expect(kept).toBeGreaterThan(4000);
    expect(hitCount).toBeGreaterThan(300);
    expect(grid.gridCasts).toBeGreaterThan(3000);
    expect(grid.linearCasts).toBeGreaterThan(0); // the infinite / very long casts
  });

  it('a frozen mesh re-placed by refreeze is found again by the periodic rebuild', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshLambertMaterial());
    mesh.position.set(100, 0, 100);
    freezeStaticTransform(mesh);
    const grid = new StaticRayGrid<THREE.Mesh>();
    grid.build([mesh]);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(300, 0, 290), new THREE.Vector3(0, 0, 1), 0, 20);
    const out: THREE.Mesh[] = [];
    expect(grid.candidates(raycaster, out).length).toBe(0);
    mesh.position.set(300, 0, 300);
    refreeze(mesh);
    let found = false;
    for (let i = 0; i <= StaticRayGrid.REBUILD_EVERY && !found; i++) found = grid.candidates(raycaster, out).length === 1;
    expect(found).toBe(true);
  });

  it("DungeonCollision casts through the grid with the old path's hits (frozen town)", () => {
    const r = rng(9);
    const town = buildTown(r);
    for (const o of town.objects) freezeStaticTransform(o);
    const dc = new DungeonCollision();
    dc.setMeshes(town.objects);
    const meshes = (dc as unknown as { renderMeshes: THREE.Mesh[] }).renderMeshes;
    const raycaster = (dc as unknown as { raycaster: THREE.Raycaster }).raycaster;
    const grid = (dc as unknown as { rayGrid: StaticRayGrid<THREE.Mesh> }).rayGrid;
    const cast = () => (dc as unknown as { intersectRenderMeshes(): THREE.Intersection[] }).intersectRenderMeshes();
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      raycaster.set(new THREE.Vector3(r() * 600, r() * 8, r() * 600), new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5).normalize());
      raycaster.near = 0;
      raycaster.far = i % 5 === 0 ? 400 : 3 + r() * 20;
      const before = oldCast(meshes, raycaster).map(key);
      expect(cast().map(key)).toEqual(before);
      hits += before.length;
    }
    expect(hits).toBeGreaterThan(100);
    expect(grid.gridCasts).toBeGreaterThan(1500);
  });
});
