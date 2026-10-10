/**
 * Whether, and how wide, a server creature / player blocks our character —
 * ACE PhysicsObj.FindObjCollisions (Physics/PhysicsObj.cs:381-455) for a
 * moving player against a live object:
 *
 *  - an Ethereal object (PhysicsState 0x4) never stops us (the collision is
 *    recorded as ObstructionEthereal and passed through);
 *  - player vs player is exempt unless both are PK or both PK-Lite
 *    (`exemption`, PhysicsObj.cs:402-404) — non-PKs walk through each other;
 *  - otherwise the object's Setup CylSpheres, else its Spheres, scaled by the
 *    object's scale (CylSphere/Sphere.IntersectsSphere(pos, scale)); an
 *    object with neither is walk-through. NOT the Setup's bounding Radius —
 *    that is PartArray.GetRadius, the melee/use distance term.
 */
import { ObjectDescriptionFlag, PhysicsState } from '@ac/shared';
import type { CollisionKey, DungeonCollision } from './DungeonCollision.js';
import { addObjectCollision, type AcQuat, type AcVec3, type ObjectPhysicsModel } from './ObjectCollision.js';

export interface CollisionShapeSource {
  cylSpheres: { radius: number }[];
  spheres: { radius: number }[];
}

/** The horizontal blocking radius (metres): the widest cylsphere, else sphere, × scale. */
export function creatureBlockRadius(setup: CollisionShapeSource | null, scale = 1): number {
  if (!setup) return 0;
  const shapes = setup.cylSpheres.length ? setup.cylSpheres : setup.spheres;
  let r = 0;
  for (const s of shapes) r = Math.max(r, s.radius);
  return r * (scale || 1);
}

/**
 * SWEEP1006B.world-objects.remote-objects-radius-height-are — the object's
 * bounding cylinder as retail's physics reads it for EVERY object with a part
 * array (not only creatures): CPartArray::GetRadius @ 005180a0 /
 * GetHeight @ 005180b0 return `setup->radius|height * scale.z`, where scale is
 * the ObjScale (CPhysicsObj::SetScaleInternal @ 00511bb0). No part array
 * (Setup unresolved) → 0 (CPhysicsObj::GetRadius/GetHeight @ 0050e9c0/0050e9e0).
 * This is the MoveToObject / melee / range-check distance term
 * (CPhysicsObj::MoveToObject @ 00512860), not the blocking shape.
 */
export function partArrayCylinder(
  setup: { radius?: number; height?: number } | null | undefined,
  scale = 1,
): { radius: number; height: number } {
  if (!setup) return { radius: 0, height: 0 };
  const s = scale || 1;
  return { radius: (setup.radius ?? 0) * s, height: (setup.height ?? 0) * s };
}

const PK = ObjectDescriptionFlag.PlayerKiller;
const PKL = ObjectDescriptionFlag.PkLiteStatus;

/** Does this object stop our character at all (before its shape is tested)? */
export function blocksLocalPlayer(obj: { physicsState: number; objectDescFlags: number }, localDescFlags: number): boolean {
  if (obj.physicsState & PhysicsState.Ethereal) return false;
  if (obj.objectDescFlags & ObjectDescriptionFlag.Player) {
    const bothPk = (obj.objectDescFlags & PK) !== 0 && (localDescFlags & PK) !== 0;
    const bothPkl = (obj.objectDescFlags & PKL) !== 0 && (localDescFlags & PKL) !== 0;
    return bothPk || bothPkl;
  }
  return true;
}

/** A blocking object near the player — a creature, a closed door, a chest — posed for collision (ServerObjectManager.getBlockersNear). */
export interface CreatureBlocker {
  guid: number;
  /** THREE world position (worldY = height). */
  worldX: number;
  worldY: number;
  worldZ: number;
  /** Widest blocking radius (prefilter / diagnostics). */
  collisionRadius: number;
  setupId: number;
  /** AC-axes orientation (THREE mesh quaternion (x, y, z, w) = AC (−x, −z, −y, w)). */
  quat: AcQuat;
  scale: number;
  /** The object's PhysicsState as last set by the server (HasPhysicsBSP picks part BSPs over shapes). */
  physicsState: number;
  /**
   * BUG.door-collision-static-pose-no-hold — each part's frame (AC axes,
   * object-local, unscaled) at the object's current animation frame, for an
   * object with a sequence: CPartArray::SetFrame → UpdateParts @ 005190f0
   * places every part at `object frame × get_curr_animframe` before
   * CPartArray::FindObjCollisions @ 00518180 tests `part->pos`, so an open
   * door collides as its swung leaf, not as the closed slab of the Setup's
   * placement frame. Absent (no sequence), or for a missing index, the part
   * keeps its placement frame.
   */
  partFrames?: readonly ({ origin: AcVec3; orientation: AcQuat } | undefined)[];
}

/**
 * VERIFY.position-drift-beside-fighting-creature.a.a — register the blockers'
 * shapes in `collision` for one player transition, as ACE
 * PhysicsObj.FindObjCollisions tests them inside the mover's own transition
 * (CylSphere/Sphere.IntersectsSphere → StepSphereUp / SlideSphere,
 * Physics/CylSphere.cs:222-295): every Setup CylSphere at the object's frame
 * and scale (LowPoint .. LowPoint + Height), else every Sphere. The collider
 * then stops or slides the body spheres at contact, or steps up onto a
 * cylinder short enough, like scenery — no push-out afterwards. Returns the
 * keys registered, for DungeonCollision.removeKey once the step is done.
 */
export function addCreatureObstacles(
  collision: DungeonCollision,
  blockers: Iterable<CreatureBlocker>,
  physics: (setupId: number) => ObjectPhysicsModel | null,
): CollisionKey[] {
  const keys: CollisionKey[] = [];
  for (const b of blockers) {
    const model = physics(b.setupId);
    if (!model) continue;
    // RECON.closed-doors-walkthrough — CPhysicsObj::FindObjCollisions
    // @ 0050f050 branches on the object's own PhysicsState HasPhysicsBSP
    // (0x10000, the state the server sent: set_state @ 00514dd0 replaces it
    // whole): set → the part BSPs (a closed door or gate); clear → its
    // CylSpheres, else its Spheres (a creature). Not the part array's own
    // BSPs: a creature whose parts carry one still collides by its shapes.
    const hasPhysicsBSP = (b.physicsState & PhysicsState.HasPhysicsBSP) !== 0 && model.hasPhysicsBSP;
    if (!hasPhysicsBSP && model.cylSpheres.length === 0 && model.spheres.length === 0) continue;
    const frames = hasPhysicsBSP ? b.partFrames : undefined;
    const shapes: ObjectPhysicsModel = frames
      ? { ...model, hasPhysicsBSP, parts: model.parts.map((p, i) => (frames[i] ? { ...p, frame: frames[i]! } : p)) }
      : { ...model, hasPhysicsBSP };
    keys.push(...addObjectCollision(collision, (kind, i) => `creature:${b.guid}:${kind}${i}`, shapes,
      { x: b.worldX, y: b.worldZ, z: b.worldY }, b.quat, b.scale || 1, 0, 0));
  }
  return keys;
}
