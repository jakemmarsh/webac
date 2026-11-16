import * as THREE from 'three';

/**
 * PERF.integrated-gpu-cpu-bound (2026-11-15) — the exact early-out three.js
 * itself takes before it reads a mesh's triangles or material, run ahead of
 * Raycaster.intersectObjects so a caller can leave out the meshes that
 * cannot be hit.
 *
 * DungeonCollision casts the camera boom (every frame) and its outdoor ray
 * fallbacks against every building shell and interior mesh of the loaded
 * landblocks, and before each cast flips every one of their materials to
 * DoubleSide and back. Almost none of them is near a 5–20 m ray: three
 * rejects them on its bounding-sphere test, but only after the flip loop and
 * the Raycaster's per-object call. Here the same test runs first and only
 * the survivors are flipped and cast.
 *
 * Identical hits by construction: `rayMayHit` is false only where three's
 * own raycast returns before reading the material or pushing a hit, with
 * the same arithmetic (three r186):
 *   - Mesh.raycast: material undefined → return; else the geometry's
 *     bounding sphere (computed when null, as three does) in world space;
 *     when it does not contain the ray origin (recast to `near`), a ray that
 *     misses it or meets it farther than far − near → return.
 *   - InstancedMesh.raycast: material undefined → return; the instanced
 *     bounding sphere (computed when null) in world space, missed by the
 *     infinite ray → return.
 * Any other raycast implementation (subclasses, Points, Lines, sprites) is
 * always kept. Raycaster.intersectObjects sorts by distance with a stable
 * sort, so dropping objects that contribute nothing leaves the survivors'
 * hits in the same order.
 */

const MESH_RAYCAST = THREE.Mesh.prototype.raycast;
const INSTANCED_RAYCAST = THREE.InstancedMesh.prototype.raycast;

const _sphere = new THREE.Sphere();
const _ray = new THREE.Ray();
const _hitAt = new THREE.Vector3();

/** False only when three's own raycast of `o` would return without a hit before testing any triangle. */
export function rayMayHit(o: THREE.Object3D, raycaster: THREE.Raycaster): boolean {
  const raycast = (o as THREE.Mesh).raycast;
  if (raycast === INSTANCED_RAYCAST) {
    const m = o as THREE.InstancedMesh;
    if (m.material === undefined) return false;
    if (m.boundingSphere === null) m.computeBoundingSphere();
    _sphere.copy(m.boundingSphere!);
    _sphere.applyMatrix4(m.matrixWorld);
    return raycaster.ray.intersectsSphere(_sphere);
  }
  if (raycast === MESH_RAYCAST) {
    const m = o as THREE.Mesh;
    if (m.material === undefined) return false;
    const geometry = m.geometry;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    _sphere.copy(geometry.boundingSphere!);
    _sphere.applyMatrix4(m.matrixWorld);
    _ray.copy(raycaster.ray).recast(raycaster.near);
    if (_sphere.containsPoint(_ray.origin) === false) {
      if (_ray.intersectSphere(_sphere, _hitAt) === null) return false;
      if (_ray.origin.distanceToSquared(_hitAt) > (raycaster.far - raycaster.near) ** 2) return false;
    }
    return true;
  }
  return true;
}

/** The objects of `objects` rayMayHit keeps, in order, into `out` (cleared first). */
export function rayCandidates<T extends THREE.Object3D>(objects: readonly T[], raycaster: THREE.Raycaster, out: T[]): T[] {
  out.length = 0;
  for (let i = 0; i < objects.length; i++) if (rayMayHit(objects[i], raycaster)) out.push(objects[i]);
  return out;
}

/**
 * PERF.ray-grid (2026-11-15) — rayCandidates over a static set without
 * visiting every member. DungeonCollision casts the camera boom every frame
 * (and its ray fallbacks) against every building shell and interior-cell mesh
 * of the loaded landblocks; outdoors at Holtburg the linear rayMayHit pass
 * alone was ~7 % of a 10x-throttled frame (tools/hitch-probe.ts --run).
 *
 * A uniform grid over THREE x / z holds each plain Mesh whose transform is
 * frozen (it and every ancestor up to the root: matrixAutoUpdate off, or an
 * identity local transform), and each such InstancedMesh small enough
 * (MAX_CELLS), under the cells its world bounding-sphere box covers. A cast with a finite reach visits only the cells under its
 * segment's box and keeps the same rayMayHit test for each mesh found there,
 * in the original order; everything else (the region-wide pools, other
 * raycasts, any mesh that can move) is tested on every cast as before.
 *
 * Same hits as rayCandidates: a plain Mesh rayMayHit keeps has a world sphere
 * that contains the ray origin (recast to `near`) or meets the ray within
 * far − near of it, so the sphere overlaps the segment [near, far] and its box
 * overlaps the segment's box: the plain-mesh survivors are rayCandidates' own.
 * An InstancedMesh (a cell's furniture pool) is kept by rayMayHit when the
 * INFINITE ray meets its instances' sphere; the grid also drops one whose
 * sphere lies wholly outside the segment, which three's raycast could only
 * have tested for hits outside [near, far] — and it reports none there
 * (Mesh.raycast's per-instance distance check). An infinite or very long cast
 * falls back to the linear pass. The sphere is read when the grid is built: `build` runs on
 * every set change, and the grid rebuilds itself every REBUILD_EVERY casts as
 * a backstop should a frozen mesh ever be re-placed (refreeze) in between.
 */
export class StaticRayGrid<T extends THREE.Object3D> {
  static readonly CELL = 16;
  /** A segment box covering more cells than this falls back to the linear pass. */
  static readonly MAX_CELLS = 256;
  static readonly REBUILD_EVERY = 120;
  private objects: readonly T[] = [];
  private readonly cells = new Map<number, number[]>();
  private always: number[] = [];
  private stamp = new Uint32Array(0);
  private epoch = 0;
  private casts = 0;
  private readonly picked: number[] = [];
  /** Casts answered from the grid / by the linear fallback (tests, probes). */
  gridCasts = 0;
  linearCasts = 0;

  build(objects: readonly T[]): void {
    this.objects = objects;
    this.cells.clear();
    this.always = [];
    this.casts = 0;
    if (this.stamp.length < objects.length) this.stamp = new Uint32Array(objects.length);
    const C = StaticRayGrid.CELL;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const m = o as unknown as THREE.Mesh;
      const instanced = m.raycast === INSTANCED_RAYCAST;
      if ((m.raycast !== MESH_RAYCAST && !instanced) || m.material === undefined || !frozenChain(o)) { this.always.push(i); continue; }
      if (instanced) {
        const im = o as unknown as THREE.InstancedMesh;
        if (im.boundingSphere === null) im.computeBoundingSphere();
        _sphere.copy(im.boundingSphere!).applyMatrix4(im.matrixWorld);
      } else {
        if (m.geometry.boundingSphere === null) m.geometry.computeBoundingSphere();
        _sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
      }
      const r = _sphere.radius;
      if (!(r >= 0) || !Number.isFinite(_sphere.center.x + _sphere.center.z + r)) { this.always.push(i); continue; }
      const x0 = Math.floor((_sphere.center.x - r) / C), x1 = Math.floor((_sphere.center.x + r) / C);
      const z0 = Math.floor((_sphere.center.z - r) / C), z1 = Math.floor((_sphere.center.z + r) / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > StaticRayGrid.MAX_CELLS) { this.always.push(i); continue; }
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = cellKey(x, z);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(i);
      }
    }
  }

  /** rayCandidates(objects, raycaster, out) for the built set: the same objects, in the same order. */
  candidates(raycaster: THREE.Raycaster, out: T[]): T[] {
    if (++this.casts > StaticRayGrid.REBUILD_EVERY) this.build(this.objects);
    const { origin, direction } = raycaster.ray;
    const near = raycaster.near, far = raycaster.far;
    const C = StaticRayGrid.CELL;
    const ax = origin.x + direction.x * near, az = origin.z + direction.z * near;
    const bx = origin.x + direction.x * far, bz = origin.z + direction.z * far;
    const x0 = Math.floor(Math.min(ax, bx) / C), x1 = Math.floor(Math.max(ax, bx) / C);
    const z0 = Math.floor(Math.min(az, bz) / C), z1 = Math.floor(Math.max(az, bz) / C);
    if (!Number.isFinite(x0 + x1 + z0 + z1) || (x1 - x0 + 1) * (z1 - z0 + 1) > StaticRayGrid.MAX_CELLS) {
      this.linearCasts++;
      return rayCandidates(this.objects, raycaster, out);
    }
    this.gridCasts++;
    if (++this.epoch === 0xffffffff) { this.stamp.fill(0); this.epoch = 1; }
    const e = this.epoch;
    const picked = this.picked;
    picked.length = 0;
    for (const i of this.always) { this.stamp[i] = e; picked.push(i); }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const list = this.cells.get(cellKey(x, z));
      if (!list) continue;
      for (const i of list) if (this.stamp[i] !== e) { this.stamp[i] = e; picked.push(i); }
    }
    picked.sort((a, b) => a - b);
    out.length = 0;
    for (const i of picked) if (rayMayHit(this.objects[i], raycaster)) out.push(this.objects[i]);
    return out;
  }
}

function cellKey(x: number, z: number): number {
  return (x + 0x8000) * 0x10000 + (z + 0x8000);
}

/** True when nothing can move `o` short of a refreeze: it and every ancestor are frozen or sit at identity. */
function frozenChain(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    if (n.matrixAutoUpdate === false) continue;
    if (n.position.x !== 0 || n.position.y !== 0 || n.position.z !== 0) return false;
    const q = n.quaternion;
    if (q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 1) return false;
    if (n.scale.x !== 1 || n.scale.y !== 1 || n.scale.z !== 1) return false;
  }
  return true;
}
