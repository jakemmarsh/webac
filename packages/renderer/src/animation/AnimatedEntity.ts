import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { MotionManager } from './MotionManager.js';
import type { SequenceMotion } from './SequenceFrame.js';

/**
 * Collect a setup group's DIRECT `part_N` children, indexed by N (holes are
 * null). SetupModelRenderer adds every part straight to the root group
 * (placement frames are model-local absolute, not nested), while wielded-
 * item meshes attached UNDER a part carry their own `part_N`-named
 * sub-parts — a deep traverse would let an item's `part_0` shadow the
 * owner's `part_0` (BUG.own-objdescevent-dropped).
 */
export function collectPartObjects(group: THREE.Object3D): (THREE.Object3D | null)[] {
  const partMap = new Map<number, THREE.Object3D>();
  let maxIndex = -1;
  for (const child of group.children) {
    const match = child.name.match(/^part_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      partMap.set(idx, child);
      if (idx > maxIndex) maxIndex = idx;
    }
  }
  const parts: (THREE.Object3D | null)[] = [];
  for (let i = 0; i <= maxIndex; i++) parts.push(partMap.get(i) ?? null);
  return parts;
}

/**
 * Apply per-part Frame transforms (AC axes, model-local — what
 * CPartArray::SetFrame writes into each CPhysicsPart) to the collected part
 * objects, converting AC Z-up to Three.js Y-up (swap Y and Z).
 */
export function applyPartTransforms(partObjects: readonly (THREE.Object3D | null)[], transforms: readonly Frame[]): void {
  const count = Math.min(transforms.length, partObjects.length);
  for (let i = 0; i < count; i++) {
    const obj = partObjects[i];
    const frame = transforms[i];
    if (!obj || !frame) continue;
    obj.position.set(frame.origin.x, frame.origin.z, frame.origin.y);
    obj.quaternion.set(
      -frame.orientation.x,
      -frame.orientation.z,
      -frame.orientation.y,
      frame.orientation.w,
    );
  }
}

/**
 * AnimatedEntity — bridges animation playback to a Three.js Group.
 *
 * Takes a Three.js Group (from SetupModelRenderer) whose children are
 * named `part_0`, `part_1`, etc., and a MotionManager that produces
 * per-part Frame transforms each tick. Applies interpolated transforms
 * to child meshes each frame.
 */
export class AnimatedEntity {
  group: THREE.Group;
  readonly motionManager: MotionManager;
  private partObjects: THREE.Object3D[] = [];

  constructor(group: THREE.Group, portalDb: DatDatabase) {
    this.group = group;
    this.motionManager = new MotionManager(portalDb);

    // Collect part children sorted by part index
    this.collectParts();
  }

  /**
   * Initialize animation from the model's default MotionTable.
   * Returns true if MotionTable was loaded and default stance started.
   */
  initFromMotionTable(motionTableId: number): boolean {
    if (!motionTableId) return false;

    const mt = this.motionManager.loadMotionTable(motionTableId);
    if (!mt) return false;

    return this.motionManager.setDefaultStance(1.0);
  }

  /**
   * Advance animation by deltaTime and apply part transforms to meshes.
   * `motion` collects the object's root motion (see AnimationPlayer.update).
   */
  update(deltaTime: number, motion?: SequenceMotion): void {
    this.motionManager.update(deltaTime, motion);

    const transforms = this.motionManager.getPartTransforms();
    if (transforms.length === 0) return;

    this.applyPartTransforms(transforms);
  }

  /**
   * Apply per-part Frame transforms to Three.js child objects.
   * Converts AC coordinate system (Z-up) to Three.js (Y-up).
   */
  private applyPartTransforms(transforms: Frame[]): void {
    applyPartTransforms(this.partObjects, transforms);
  }

  /**
   * Re-collect part bindings after the group's `part_N` children were
   * replaced in place (BUG.own-objdescevent-dropped — appearance updates
   * transplant new part meshes into the same Group; without this the
   * animation keeps posing the removed, disposed parts).
   */
  refreshParts(): void {
    this.collectParts();
  }

  /**
   * Drive a rebuilt Group (a remote object's appearance update builds a new
   * one — ServerObjectManager.updateAppearance) with the same MotionManager:
   * retail DoObjDescChanges swaps only the parts, the CPhysicsObj's motion
   * state carries on. Without this the animation keeps posing the discarded
   * group and the visible character slides around in its rest pose.
   */
  rebind(group: THREE.Group): void {
    this.group = group;
    this.collectParts();
  }

  /**
   * Collect child objects sorted by part index from the group.
   *
   * Only DIRECT children are considered: SetupModelRenderer adds all parts
   * straight to the root group (placement frames are model-local absolute,
   * not nested), while wielded-item meshes attached UNDER a part carry
   * their own `part_N`-named sub-parts — a deep traverse would let an
   * item's `part_0` shadow the player's `part_0` when parts are collected
   * after a wield attachment (BUG.own-objdescevent-dropped).
   */
  private collectParts(): void {
    // Parts are named 'part_0', 'part_1', etc.
    this.partObjects = collectPartObjects(this.group).map((p) => p ?? null!);
  }
}
