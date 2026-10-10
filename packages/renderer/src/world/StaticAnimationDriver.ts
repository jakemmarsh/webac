import type * as THREE from 'three';
import type { Animation } from '@ac/dat-parser/file-types/Animation.js';
import type { AnimationHook } from '@ac/dat-parser/file-types/AnimationHook.js';
import { AnimationPlayer } from '../animation/AnimationPlayer.js';
import { collectPartObjects, applyPartTransforms } from '../animation/AnimatedEntity.js';

/**
 * SWEEP1006B.world-objects.dat-static-objects-dungeon-building — DAT static
 * objects loop their Setup's DefaultAnimation.
 *
 * Retail (acclient-decompiled.annotated.c):
 *  - Every DAT static is built through CPhysicsObj::makeObject @ 00513970
 *    (CEnvCell::init_static_objects @ 0052c350 for cell stabs,
 *    CLandBlock::init_static_objs @ 00530a40 for landblock objects,
 *    CLandBlock::get_land_scenes @ 00530460 for scenery) with
 *    InitObjectBegin(.., 0, 0), which sets state |= 1 (STATIC).
 *  - InitPartArrayObject → CPartArray::CreateSetup → SetSetupID →
 *    CPartArray::InitDefaults @ 00518980: a Setup default_anim_id is appended
 *    as AnimData(anim, low 0, high -1, 30 fps) — frame 0 at build time.
 *  - CPhysicsObj::InitDefaults @ 005139d0: a STATIC object with a default
 *    anim gets state |= 0x40000 and joins CPhysics::AddStaticAnimatingObject.
 *  - CPhysics::UseTime @ 00509950 calls animate_static_object @ 00513df0 on
 *    every listed object each quantum while it has a cell (drawn or not):
 *    CPartArray::Update(dt) (no root motion), the parts' frames, then
 *    process_hooks — the animation's hooks run on the object. A step longer
 *    than HUGE_QUANTUM (2 s) only resets the clock.
 *
 * The renderers build such a static per-object (never instanced: its parts
 * move) and tag it with tagStaticDefaultAnimation. The owners of the object
 * trees hand each tree to attach() when it enters the scene and to detach()
 * before it is disposed (the same calls StaticScriptDriver receives).
 */

/** userData key: the Setup DefaultAnimation id (0x03…) this static loops. */
export const STATIC_ANIM_KEY = 'staticDefaultAnimation';

/** CPhysicsObj::animate_static_object: a step longer than HUGE_QUANTUM resets the clock without advancing. */
export const HUGE_QUANTUM = 2;

/** Mark a per-object DAT static whose Setup DefaultAnimation loops while it is in the scene. */
export function tagStaticDefaultAnimation(obj: THREE.Object3D, setupId: number, animId: number): void {
  obj.userData.setupId = setupId;
  obj.userData[STATIC_ANIM_KEY] = animId;
}

export interface StaticAnimationDriverDeps {
  /** The Animation (0x03…) for an id; null when it is not (yet) readable. */
  loadAnimation(animId: number): Animation | null;
  /** An animation hook fired on the static (PhysicsScriptPlayer.executeHook). */
  onHook?(hook: AnimationHook, anchor: THREE.Object3D): void;
  /**
   * Streamed DATs: after loadAnimation returned null, a promise for the
   * animation's arrival, or null when it will not arrive (absent from the
   * DAT, or not streaming) — the static then never animates.
   */
  animationPending?(animId: number): Promise<void> | null;
}

interface Running {
  player: AnimationPlayer;
  parts: (THREE.Object3D | null)[];
}

export class StaticAnimationDriver {
  private readonly running = new Map<THREE.Object3D, Running>();
  /**
   * STATIC.anim-retry-cap — tagged statics whose animation was not readable
   * yet → the arrival they wait on; started on the update after it lands
   * (retail's DBObj::Get blocks until the file is local).
   */
  private readonly pending = new Map<THREE.Object3D, Promise<void>>();
  /** Statics whose animation arrived: started on the next update. */
  private readonly arrived = new Set<THREE.Object3D>();

  constructor(private readonly deps: StaticAnimationDriverDeps) {}

  /** Number of statics whose DefaultAnimation is looping. */
  get count(): number { return this.running.size; }

  /** Whether a node is one of this driver's looping statics. */
  isAnimating(node: THREE.Object3D): boolean { return this.running.has(node); }

  /** A tree entered the scene: its tagged statics start their DefaultAnimation at frame 0. */
  attach(root: THREE.Object3D): void {
    root.traverse(node => {
      if (node.userData[STATIC_ANIM_KEY] && !this.running.has(node)) this.start(node);
    });
  }

  /** A tree is leaving the scene: its statics stop animating. */
  detach(root: THREE.Object3D): void {
    if (this.running.size === 0 && this.pending.size === 0 && this.arrived.size === 0) return;
    root.traverse(node => {
      this.running.delete(node);
      this.pending.delete(node);
      this.arrived.delete(node);
    });
  }

  /** Per frame (CPhysics::UseTime): advance every looping static and pose its parts. */
  update(dt: number): void {
    if (this.arrived.size > 0) {
      const nodes = [...this.arrived];
      this.arrived.clear();
      for (const node of nodes) if (!this.running.has(node)) this.start(node);
    }
    if (!(dt > 0) || dt > HUGE_QUANTUM) return;
    for (const r of this.running.values()) {
      r.player.update(dt);
      applyPartTransforms(r.parts, r.player.getPartTransforms());
    }
  }

  private start(node: THREE.Object3D): void {
    const animId = node.userData[STATIC_ANIM_KEY] as number;
    let anim: Animation | null = null;
    try { anim = this.deps.loadAnimation(animId); } catch { anim = null; }
    if (!anim) {
      // A streamed miss waits for the file however long it takes; a file
      // that will not arrive (absent, or a failed fetch) is given up.
      let wait: Promise<void> | null = null;
      try { wait = this.deps.animationPending?.(animId) ?? null; } catch { wait = null; }
      if (!wait) return;
      this.pending.set(node, wait);
      wait.then(() => {
        if (this.pending.get(node) !== wait) return;
        this.pending.delete(node);
        this.arrived.add(node);
      }, () => { if (this.pending.get(node) === wait) this.pending.delete(node); });
      return;
    }
    if (anim.numFrames === 0) return;
    const player = new AnimationPlayer();
    // CPartArray::InitDefaults: AnimData(default_anim_id, low 0, high -1, 30 fps), looping.
    player.play(anim, 0, -1, 30, 1.0, true);
    const onHook = this.deps.onHook;
    if (onHook) player.onHook(hook => onHook(hook, node));
    const parts = collectPartObjects(node);
    applyPartTransforms(parts, player.getPartTransforms());
    this.running.set(node, { player, parts });
  }
}
