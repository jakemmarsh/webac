import * as THREE from 'three';

/**
 * PERF.integrated-gpu-cpu-bound (2026-11-15) — debug-only live check that the
 * per-frame scene-graph work still produces three.js's world matrices.
 *
 * Off by default. On with `?matrixInvariant` (where page debug tools are
 * enabled) or `acDebug.matrixInvariant(true)`. After every world render it
 * walks the scene the way three's own updateMatrixWorld would, recomputing
 * each node's world matrix from scratch the stock way (local = compose(position,
 * quaternion, scale) for matrixAutoUpdate nodes, else `matrix`; world =
 * parent world × local), and compares it with the node's matrixWorld.
 * Any element off by more than `tolerance` (1e-5, scaled by the element's
 * magnitude above 1 so a 30 km world coordinate gets float64 room) is
 * counted and logged once per node path with the error.
 *
 * Checked: every node whose whole ancestor chain is visible (hidden subtrees
 * are skipped by PERF.hidden-subtree-matrix-skip until they are shown, and
 * three draws nothing there). Trusted as-is, with their subtree compared
 * against them: nodes whose world matrix three never writes
 * (matrixWorldAutoUpdate false: frozen statics, the warm-up root) and nodes
 * that replace updateMatrixWorld (ObjectLightCarrier copies its owner's).
 * Runs after the indoor view's second pass too (it renders with the scene's
 * auto-update off, after the first pass updated everything).
 */

export interface MatrixInvariantStats {
  frames: number;
  checked: number;
  bad: number;
  maxErr: number;
  /** First mismatches: node path + error. */
  samples: string[];
}

const baseUpdateMatrixWorld = THREE.Object3D.prototype.updateMatrixWorld;

/** `scene > parent > … > node` names (type when unnamed). */
export function nodePath(o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let n: THREE.Object3D | null = o; n; n = n.parent) parts.unshift(n.name || n.type);
  return parts.join(' > ');
}

export class MatrixInvariant {
  readonly stats: MatrixInvariantStats = { frames: 0, checked: 0, bad: 0, maxErr: 0, samples: [] };
  private readonly logged = new Set<string>();
  private readonly local = new THREE.Matrix4();
  private readonly stack: THREE.Matrix4[] = [];

  constructor(
    readonly tolerance = 1e-5,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
    private readonly maxSamples = 20,
  ) {}

  /** Check every visible node under `scene`; returns the mismatches found this call. */
  check(scene: THREE.Object3D): number {
    this.stats.frames++;
    let bad = 0;
    const visit = (o: THREE.Object3D, parentWorld: THREE.Matrix4 | null, depth: number): void => {
      if (!o.visible) return;
      let expected = this.stack[depth];
      if (!expected) { expected = new THREE.Matrix4(); this.stack[depth] = expected; }
      const trusted = o.matrixWorldAutoUpdate === false || (o.updateMatrixWorld !== baseUpdateMatrixWorld && !(o as THREE.Scene).isScene);
      if (trusted || parentWorld === null && (o as THREE.Scene).isScene) {
        expected.copy(o.matrixWorld);
      } else {
        if (o.matrixAutoUpdate) this.local.compose(o.position, o.quaternion, o.scale);
        else this.local.copy(o.matrix);
        if (parentWorld) expected.multiplyMatrices(parentWorld, this.local);
        else expected.copy(this.local);
        this.stats.checked++;
        const e = expected.elements, a = o.matrixWorld.elements;
        let err = 0;
        for (let i = 0; i < 16; i++) {
          const d = Math.abs(e[i] - a[i]) / Math.max(1, Math.abs(e[i]));
          if (!(d <= err)) err = d; // NaN counts as a mismatch
        }
        if (!(err <= this.tolerance)) {
          bad++;
          this.stats.bad++;
          if (!(err <= this.stats.maxErr)) this.stats.maxErr = err;
          const path = nodePath(o);
          if (!this.logged.has(path)) {
            this.logged.add(path);
            const line = `[matrix-invariant] ${path}: max relative error ${err.toExponential(2)}`;
            if (this.stats.samples.length < this.maxSamples) this.stats.samples.push(line);
            this.log(line);
          }
        } else if (err > this.stats.maxErr) {
          this.stats.maxErr = err;
        }
      }
      const children = o.children;
      for (let i = 0; i < children.length; i++) visit(children[i], expected, depth + 1);
    };
    visit(scene, null, 0);
    return bad;
  }
}

/** `?matrixInvariant` in the page query. */
export function matrixInvariantRequested(search: string): boolean {
  return new URLSearchParams(search).has('matrixInvariant');
}
