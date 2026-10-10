import type * as THREE from 'three';

/**
 * PERF (2026-09-30) — freeze the transform of an object that never moves.
 *
 * `WebGLRenderer.render` calls `scene.updateMatrixWorld()` every frame, which
 * re-composes every object's local matrix and re-multiplies its world matrix
 * (~4% of the main thread at Holtburg). Terrain blocks, merged overlays and
 * the instancing pools (whose instances move through instanceMatrix, never
 * the mesh) are placed once: compute their matrices now, then let the
 * per-frame walk skip them (Object3D.matrixWorldAutoUpdate = false skips the
 * whole subtree). Anything that later changes position/rotation/scale on a
 * frozen object must call `refreeze` (no current caller does).
 */
export function freezeStaticTransform(obj: THREE.Object3D): void {
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/** Re-derive a frozen object's matrices after a deliberate move. */
export function refreeze(obj: THREE.Object3D): void {
  obj.traverse((o) => { o.matrixAutoUpdate = true; o.matrixWorldAutoUpdate = true; });
  freezeStaticTransform(obj);
}
