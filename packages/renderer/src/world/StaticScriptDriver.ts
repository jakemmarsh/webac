import type * as THREE from 'three';

/**
 * VISUAL.dat-static-default-scripts — DAT static objects run their Setup's
 * DefaultScript.
 *
 * Retail: every CPhysicsObj runs CPartArray::InitDefaults @ 00518980 →
 * CPhysicsObj::InitDefaults @ 005139d0, which calls
 * `play_script_internal(setup->default_script_id)` when the Setup has one.
 * The landblock's static objects (LandBlockInfo objects) and the EnvCell
 * stabs are CPhysicsObjs like any server object, so their wall-torch flames,
 * brazier fire, lamp glows, chimney/oven smoke and ambient sound loops come
 * from that call. The server never sends these objects, so the client must
 * start the script itself when the object is built.
 *
 * The renderers tag one anchor per such static (the per-object mesh, or a
 * transform-only anchor at the instanced object's frame) with
 * tagStaticScriptAnchor. The owners of the object trees (the landblock
 * streamer, the dungeon streamer) hand each tree to attach() when it enters
 * the scene and to detach() before it is disposed.
 *
 * Particles follow the anchor's effective visibility each frame (sync()):
 * a static in a cell that is not drawn (portal/PVS gated) or on a block
 * outside the full-detail ring draws nothing, its emitters included — retail
 * only draws the objects of the cells it draws (CObjCell::draw_visible).
 */

/** userData key: the DefaultScript id (0x33…) to play on this anchor. */
export const STATIC_SCRIPT_KEY = 'staticDefaultScript';

/** Mark an anchor as a DAT static whose Setup DefaultScript plays while it is in the scene. */
export function tagStaticScriptAnchor(anchor: THREE.Object3D, setupId: number, scriptId: number): void {
  anchor.userData.setupId = setupId;
  anchor.userData[STATIC_SCRIPT_KEY] = scriptId;
}

export interface StaticScriptDriverDeps {
  /** Start the script on the anchor (PhysicsScriptPlayer.play). */
  play(scriptId: number, anchor: THREE.Object3D): void;
  /** Stop every script / emitter / timer the anchor owns (PhysicsScriptPlayer.stopForAnchor). */
  stop(anchor: THREE.Object3D): void;
  /** Show / hide the anchor's emitters (PhysicsScriptPlayer.setAnchorParticlesVisible). */
  setParticlesVisible(anchor: THREE.Object3D, visible: boolean): void;
  /**
   * Streamed DATs: null when the script (and the files it plays) are
   * resident, else a promise for their arrival — the static then starts on
   * arrival instead of playing a script that is not there (retail's
   * DBObj::Get blocks until the file is local). Absent → always resident.
   */
  scriptPending?(scriptId: number): Promise<void> | null;
}

/** Whether a node and every ancestor are visible, and the chain reaches a scene. */
function effectivelyVisible(node: THREE.Object3D): boolean {
  let n: THREE.Object3D = node;
  for (;;) {
    if (!n.visible) return false;
    if (!n.parent) return (n as THREE.Scene).isScene === true;
    n = n.parent;
  }
}

export class StaticScriptDriver {
  /** Tagged anchors that entered the scene and start on the next sync(). */
  private readonly pending = new Set<THREE.Object3D>();
  /** Running anchors → the visibility last applied to their emitters. */
  private readonly running = new Map<THREE.Object3D, boolean>();
  /**
   * FX.static-script-never-retried — statics waiting for their streamed
   * script → the arrival they wait on (only the latest counts).
   */
  private readonly waiting = new Map<THREE.Object3D, Promise<void>>();
  /** Statics whose wait ended: they play on the next sync without asking again (once). */
  private readonly arrived = new Set<THREE.Object3D>();

  /**
   * SWEEP1006B — the DefaultAnimation half of the same InitDefaults block
   * (StaticAnimationDriver): every tree handed to attach() / detach() goes to
   * it too, so the streamers wire one lifecycle for both.
   */
  animations: { attach(root: THREE.Object3D): void; detach(root: THREE.Object3D): void } | null = null;

  constructor(private readonly deps: StaticScriptDriverDeps) {}

  /** Number of statics whose DefaultScript is running. */
  get count(): number { return this.running.size; }

  /** Whether an anchor is one of this driver's (the server-object script cap ignores them). */
  owns(anchor: THREE.Object3D): boolean { return this.running.has(anchor) || this.pending.has(anchor) || this.waiting.has(anchor); }

  /**
   * A tree entered the scene: its tagged statics start their DefaultScript
   * on the next sync() (the frame loop, not the time-budgeted load step).
   */
  attach(root: THREE.Object3D): void {
    this.animations?.attach(root);
    root.traverse(node => {
      if (node.userData[STATIC_SCRIPT_KEY] && !this.running.has(node)) this.pending.add(node);
    });
  }

  /** A tree is leaving the scene: stop its statics' scripts and emitters. */
  detach(root: THREE.Object3D): void {
    this.animations?.detach(root);
    if (this.running.size === 0 && this.pending.size === 0 && this.waiting.size === 0) return;
    root.traverse(node => {
      this.pending.delete(node);
      this.waiting.delete(node);
      this.arrived.delete(node);
      if (this.running.delete(node)) this.deps.stop(node);
    });
  }

  /** Per frame: start what entered the scene; emitters draw exactly while their static does. */
  sync(): void {
    if (this.pending.size > 0) {
      for (const anchor of this.pending) {
        const scriptId = anchor.userData[STATIC_SCRIPT_KEY] as number;
        const wait = this.arrived.delete(anchor) ? null : this.deps.scriptPending?.(scriptId) ?? null;
        if (wait) {
          // Started once the files land (next sync), unless it left the
          // scene; a failed fetch falls through to a plain play once.
          this.waiting.set(anchor, wait);
          const retry = (): void => {
            if (this.waiting.get(anchor) !== wait) return;
            this.waiting.delete(anchor);
            this.arrived.add(anchor);
            this.pending.add(anchor);
          };
          wait.then(retry, retry);
          continue;
        }
        this.deps.play(scriptId, anchor);
        this.running.set(anchor, true);
      }
      this.pending.clear();
    }
    for (const [anchor, was] of this.running) {
      const visible = effectivelyVisible(anchor);
      if (visible === was) continue;
      this.running.set(anchor, visible);
      this.deps.setParticlesVisible(anchor, visible);
    }
  }
}
