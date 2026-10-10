import type * as THREE from 'three';

/**
 * Whether `occluder` (the player's own model) is hit nearer along the ray than
 * `target`. SmartBox's find takes the nearest object under the mouse, and our
 * own character is one of them — server objects behind it are not "under the
 * mouse" (the hover tooltip / blink must not find them).
 */
export function occluderIsNearer(raycaster: THREE.Raycaster, occluder: THREE.Object3D | null | undefined, target: THREE.Object3D | null | undefined): boolean {
  if (!occluder || !occluder.visible || !target) return false;
  const self = raycaster.intersectObject(occluder, true)[0];
  if (!self) return false;
  const other = raycaster.intersectObject(target, true)[0];
  return !!other && self.distance < other.distance;
}

/**
 * SWEEP1006B.player-input.player-own-body-can-t — whether SmartBox's find
 * under the ray is the player itself. Retail's mouse-select test
 * (CPhysicsPart::Draw @ 0050d7a0 → Render's hit test) checks every drawn
 * part with a physics id, the player's included, and keeps the nearest, so
 * the player is found when its model is hit and nearer than `target` (the
 * nearest server object's mesh; none = the player wins). The model is only
 * drawn in third person: an invisible model is never found.
 */
export function findsSelf(raycaster: THREE.Raycaster, playerModel: THREE.Object3D | null | undefined, target: THREE.Object3D | null | undefined): boolean {
  const other = target ? raycaster.intersectObject(target, true)[0] : undefined;
  return !!selfHitUnderRay(raycaster, playerModel, other?.distance);
}

/**
 * findsSelf against the nearest object's hit distance (none = the player
 * wins), returning the hit on the player's model: a hit on one of its held
 * copies finds that item (heldCopyGuidAt), as on any holder.
 */
export function selfHitUnderRay(raycaster: THREE.Raycaster, playerModel: THREE.Object3D | null | undefined, targetDistance: number | undefined): THREE.Intersection | null {
  if (!playerModel || !playerModel.visible) return null;
  const self = raycaster.intersectObject(playerModel, true)[0];
  if (!self) return null;
  return targetDistance === undefined || self.distance < targetDistance ? self : null;
}
