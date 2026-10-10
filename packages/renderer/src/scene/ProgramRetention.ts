/**
 * PERF.gpu-soak-frame-hitches-28a525da — keep every compiled shader program
 * for the session.
 *
 * three.js reference-counts a WebGLProgram by the materials using it
 * (WebGLPrograms.acquireProgram / releaseProgram) and destroys it when the
 * last one is disposed. Our materials come and go with the world: the
 * resource sweep (models/ResourceSweep.ts) disposes a town's materials after
 * a teleport, a despawned monster takes its own, the paperdoll's copies go
 * when the panel closes. The next material with the same program key then
 * compiles and links it again, synchronously, on the frame it first draws
 * (WebGLProgram.getUniforms → getProgramInfoLog). A two-town SwiftShader
 * probe (tools/hitch-probe.ts) recompiled 14 of its 63 program keys during
 * play, and each relink is a frame of 100–850 ms on the real-GPU soak.
 *
 * The set of distinct keys is small and bounded (one per lighting kind ×
 * map/alpha/vertex-colour combination, ~60-100 in a session), so the fix is
 * to hold one extra reference on each program the first time it appears:
 * usedTimes never returns to 0, releaseProgram never destroys it, and
 * acquireProgram finds it again by key. Nothing drawn changes. Materials,
 * textures and geometries are still freed by the sweep.
 */

/** The part of three.js's WebGLProgram this touches. */
export interface RetainableProgram {
  usedTimes: number;
}

export class ProgramRetention {
  private readonly retained = new WeakSet<RetainableProgram>();
  private count = 0;

  /** `programs` returns the renderer's live program list (`renderer.info.programs`). */
  constructor(private readonly programs: () => readonly RetainableProgram[] | null | undefined) {}

  /**
   * Retain every program compiled since the last call; returns how many were
   * new. A retained program is never removed from the list, so the list holds
   * the `count` retained ones plus any new ones, and an unchanged length means
   * nothing new (the per-frame call costs one comparison).
   */
  retainNew(): number {
    const list = this.programs();
    if (!list || list.length === this.count) return 0;
    let added = 0;
    for (const p of list) {
      if (this.retained.has(p)) continue;
      this.retained.add(p);
      p.usedTimes++;
      added++;
    }
    this.count += added;
    return added;
  }

  /** Programs held so far. */
  get size(): number { return this.count; }
}
