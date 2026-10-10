import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import type { AnimationHook, AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';

/**
 * Quaternion multiplication for combining rotations.
 */
function multiplyQuaternions(
  a: { w: number; x: number; y: number; z: number },
  b: { w: number; x: number; y: number; z: number },
): { w: number; x: number; y: number; z: number } {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * Rotate a vector by a quaternion.
 */
function rotateByQuaternion(
  v: { x: number; y: number; z: number },
  q: { w: number; x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  // v' = q * v * q^-1
  const vq = { w: 0, x: v.x, y: v.y, z: v.z };
  const qConj = { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  const result = multiplyQuaternions(multiplyQuaternions(q, vq), qConj);
  return { x: result.x, y: result.y, z: result.z };
}

/**
 * Combine parent and child frames: child's local transform applied relative to parent.
 */
function combineFrames(parent: Frame, child: Frame): Frame {
  const rotatedOrigin = rotateByQuaternion(child.origin, parent.orientation);
  return {
    origin: {
      x: parent.origin.x + rotatedOrigin.x,
      y: parent.origin.y + rotatedOrigin.y,
      z: parent.origin.z + rotatedOrigin.z,
    },
    orientation: multiplyQuaternions(parent.orientation, child.orientation),
  };
}

export type HookTypeCallback = (hook: AnimationHook, frameIndex: number, boneIndex: number) => void;

const IDENTITY_FRAME: Frame = {
  origin: { x: 0, y: 0, z: 0 },
  orientation: { w: 1, x: 0, y: 0, z: 0 },
};

/**
 * SkeletonSystem — manages bone hierarchy, forward kinematics,
 * and hook event dispatch.
 */
export class SkeletonSystem {
  private partIds: number[] = [];
  private parentIndices: number[] = [];
  private localTransforms: Frame[] = [];
  private worldTransforms: Frame[] = [];
  private hookListeners = new Map<number, HookTypeCallback[]>();
  private globalHookListeners: HookTypeCallback[] = [];

  get numBones(): number {
    return this.partIds.length;
  }

  get parts(): readonly number[] {
    return this.partIds;
  }

  /**
   * Initialize skeleton from a SetupModel.
   */
  initFromSetupModel(setup: SetupModel): void {
    this.partIds = [...setup.parts];
    this.parentIndices = setup.parentIndex ? [...setup.parentIndex] : [];
    this.localTransforms = this.partIds.map(() => ({ ...IDENTITY_FRAME }));
    this.worldTransforms = this.partIds.map(() => ({ ...IDENTITY_FRAME }));
  }

  /**
   * Initialize skeleton manually.
   */
  setBones(partIds: number[], parentIndices: number[]): void {
    this.partIds = [...partIds];
    this.parentIndices = [...parentIndices];
    this.localTransforms = partIds.map(() => ({
      origin: { x: 0, y: 0, z: 0 },
      orientation: { w: 1, x: 0, y: 0, z: 0 },
    }));
    this.worldTransforms = partIds.map(() => ({
      origin: { x: 0, y: 0, z: 0 },
      orientation: { w: 1, x: 0, y: 0, z: 0 },
    }));
  }

  /**
   * Apply per-part local transforms from an animation frame.
   */
  applyFrame(frames: Frame[]): void {
    for (let i = 0; i < Math.min(frames.length, this.localTransforms.length); i++) {
      this.localTransforms[i] = frames[i];
    }
  }

  /**
   * Compute world transforms using forward kinematics.
   * Must call applyFrame first.
   */
  computeWorldTransforms(): Frame[] {
    for (let i = 0; i < this.partIds.length; i++) {
      const parentIdx = this.parentIndices[i] ?? -1;
      if (parentIdx < 0 || parentIdx >= i) {
        // Root bone: world = local
        this.worldTransforms[i] = {
          origin: { ...this.localTransforms[i].origin },
          orientation: { ...this.localTransforms[i].orientation },
        };
      } else {
        // Child bone: world = parent_world × local
        this.worldTransforms[i] = combineFrames(
          this.worldTransforms[parentIdx],
          this.localTransforms[i],
        );
      }
    }
    return this.worldTransforms;
  }

  /**
   * Get the local transforms.
   */
  getLocalTransforms(): readonly Frame[] {
    return this.localTransforms;
  }

  /**
   * Get the world transforms (must call computeWorldTransforms first).
   */
  getWorldTransforms(): readonly Frame[] {
    return this.worldTransforms;
  }

  /**
   * Register a callback for a specific hook type.
   */
  registerHookListener(hookType: AnimationHookType, callback: HookTypeCallback): void {
    let list = this.hookListeners.get(hookType);
    if (!list) {
      list = [];
      this.hookListeners.set(hookType, list);
    }
    list.push(callback);
  }

  /**
   * Register a callback for all hook types.
   */
  registerGlobalHookListener(callback: HookTypeCallback): void {
    this.globalHookListeners.push(callback);
  }

  /**
   * Dispatch a hook event. Called by the AnimationPlayer hook callback.
   */
  dispatchHook(hook: AnimationHook, frameIndex: number): void {
    // Global listeners
    for (const listener of this.globalHookListeners) {
      listener(hook, frameIndex, -1);
    }

    // Type-specific listeners
    const typeListeners = this.hookListeners.get(hook.hookType);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener(hook, frameIndex, -1);
      }
    }
  }

  /**
   * Get the world position of a specific bone.
   */
  getBoneWorldPosition(boneIndex: number): { x: number; y: number; z: number } | null {
    if (boneIndex < 0 || boneIndex >= this.worldTransforms.length) return null;
    return this.worldTransforms[boneIndex].origin;
  }
}

export { combineFrames, multiplyQuaternions, rotateByQuaternion, IDENTITY_FRAME };
