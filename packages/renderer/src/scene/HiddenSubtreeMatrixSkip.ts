import * as THREE from 'three';

/**
 * PERF.hidden-subtree-matrix-skip (2026-10-31) — the per-frame matrix walk
 * skips what nothing draws.
 *
 * `WebGLRenderer.render` calls `scene.updateMatrixWorld()` every frame, and
 * three walks EVERY node, visible or not: it re-composes each local matrix
 * and re-multiplies each world matrix. At Holtburg 4,672 of 7,714 nodes sit
 * under hidden top-level objects (interior cells out of the PVS, NPCs in
 * those cells, static setups past their degrade distance, idle emitters,
 * portal punches), and the walk was 8% of a 4× CPU-throttled town frame.
 * projectObject already skips them for drawing.
 *
 * Here the scene's own walk stops at a HIDDEN TOP-LEVEL child: that child's
 * own matrices stay current (anything reading an object's root position —
 * DegradeLod.objectPosition, cell visibility — sees this frame's value),
 * but its descendants are left as they were and the child is marked stale.
 * The descendants are brought up to date the moment the child is shown
 * again (an accessor on `visible`: a forced subtree update, before any
 * consumer that frame reads them — DegradeLod, picking, the indoor view's
 * second pass, which renders with scene.matrixWorldAutoUpdate off), and the
 * walk forces them on the next frame anyway.
 *
 * Kept exactly as three does it:
 *   - nodes whose class overrides updateMatrixWorld (ParticleSystem's
 *     object, ObjectLights) run their override every frame, hidden or not:
 *     those overrides re-sync their own visibility and instances;
 *   - hidden nodes BELOW a visible top-level object (degrade-level holders
 *     inside a drawn NPC) are walked as before, so picking, which ray-casts
 *     a visible object's whole subtree, never meets a stale matrix;
 *   - an explicit `scene.updateMatrixWorld(true)` updates everything;
 *   - `getWorldPosition` / `updateWorldMatrix(true, …)` walk the parent chain
 *     themselves and stay exact.
 */

const STALE = Symbol('acSubtreeStale');
const VISIBLE = Symbol('acVisible');
const HOOKED = Symbol('acVisibleHooked');

type Node = THREE.Object3D & { [STALE]?: boolean; [VISIBLE]?: boolean; [HOOKED]?: boolean };

const baseUpdateMatrixWorld = THREE.Object3D.prototype.updateMatrixWorld;

/** True when this node's class (or the node itself) replaces three's updateMatrixWorld. */
function overridesUpdate(o: THREE.Object3D): boolean {
  return o.updateMatrixWorld !== baseUpdateMatrixWorld;
}

/** Update `o`'s own local / world matrices exactly as Object3D.updateMatrixWorld does, without its children. Returns the force to hand them. */
function updateOwn(o: THREE.Object3D, force: boolean): boolean {
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.matrixWorldNeedsUpdate || force) {
    if (o.matrixWorldAutoUpdate === true) {
      if (o.parent === null) o.matrixWorld.copy(o.matrix);
      else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    }
    o.matrixWorldNeedsUpdate = false;
    return true;
  }
  return force;
}

/** Shown again after a skipped stretch: bring the whole subtree up to date now. */
function hookVisible(child: Node): void {
  if (child[HOOKED]) return;
  child[HOOKED] = true;
  child[VISIBLE] = child.visible;
  Object.defineProperty(child, 'visible', {
    configurable: true,
    enumerable: true,
    get(this: Node) { return this[VISIBLE] === true; },
    set(this: Node, v: boolean) {
      const was = this[VISIBLE] === true;
      this[VISIBLE] = v;
      if (v && !was && this[STALE]) {
        this[STALE] = false;
        this.updateMatrixWorld(true);
      }
    },
  });
}

/** Number of top-level subtrees the last walk skipped (diagnostics / tests). */
export function skippedSubtreeCount(scene: THREE.Scene): number {
  return (scene.userData.acSkippedSubtrees as number | undefined) ?? 0;
}

/** Install the hidden-subtree skip on the world scene. Idempotent. */
export function installHiddenSubtreeMatrixSkip(scene: THREE.Scene): void {
  if (scene.userData.acHiddenSubtreeSkip) return;
  scene.userData.acHiddenSubtreeSkip = true;
  for (const c of scene.children) hookVisible(c as Node);
  scene.addEventListener('childadded', (e) => hookVisible((e as unknown as { child: Node }).child));

  scene.updateMatrixWorld = function updateMatrixWorldSkippingHidden(this: THREE.Scene, force?: boolean): void {
    if (force) { baseUpdateMatrixWorld.call(this, true); return; }
    const childForce = updateOwn(this, false);
    let skipped = 0;
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i++) {
      const child = children[i] as Node;
      if (child.visible || overridesUpdate(child)) {
        const stale = child[STALE] === true;
        child[STALE] = false;
        child.updateMatrixWorld(childForce || stale);
      } else {
        updateOwn(child, childForce);
        if (child.children.length > 0) { child[STALE] = true; skipped++; }
      }
    }
    this.userData.acSkippedSubtrees = skipped;
  };
}
