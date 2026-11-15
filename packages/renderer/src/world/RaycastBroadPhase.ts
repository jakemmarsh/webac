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
