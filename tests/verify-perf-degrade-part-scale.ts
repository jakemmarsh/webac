/**
 * PERF.integrated-gpu-cpu-bound (2026-11-15) — DegradeLod.updateParts reads a
 * part's gfxobj_scale.z (three.js scale.y) straight from its world matrix
 * instead of decomposing it every frame.
 *
 * Proven two ways with the real modules:
 *   1. partScaleZ returns exactly (Object.is) the scale.y Matrix4.decompose
 *      returns, over random TRS matrices, mirrored (negative determinant),
 *      sheared parent chains and the degenerate det = 0 case;
 *   2. updateParts picks the same levels as the decompose path (a reference
 *      selection built on decompose), while Matrix4.decompose and
 *      Quaternion.setFromRotationMatrix run 0 times for non-billboard parts
 *      (they ran once per part per frame before).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  DegradeLod, DegradeMode, partScaleZ, selectDegradeLevel, RETAIL_DEGRADE_PREFS, type DegradeChain,
} from '../packages/renderer/src/models/DegradeLod.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function randomMatrix(r: () => number): THREE.Matrix4 {
  const q = new THREE.Quaternion(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
  const s = new THREE.Vector3(0.1 + r() * 3, 0.1 + r() * 3, 0.1 + r() * 3);
  if (r() < 0.3) s.x = -s.x; // mirrored: decompose flips sx, never sy
  return new THREE.Matrix4().compose(new THREE.Vector3(r() * 40000, r() * 200, r() * 40000), q, s);
}

describe('partScaleZ — the scale.y of Matrix4.decompose, bit for bit', () => {
  it('matches decompose on random, mirrored and chained (sheared) matrices', () => {
    const r = rng(7);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < 5000; i++) {
      // a product of two TRS matrices with non-uniform scale is a sheared world matrix
      const m = randomMatrix(r).multiply(randomMatrix(r));
      m.decompose(p, q, s);
      expect(Object.is(partScaleZ(m), s.y)).toBe(true);
    }
  });

  it('det = 0 gives 1, as decompose does', () => {
    const m = new THREE.Matrix4().makeScale(2, 3, 0);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    expect(s.y).toBe(1);
    expect(partScaleZ(m)).toBe(1);
  });
});

const GFX = 0x01000001;
const LEVELS = [
  { gfxObjId: GFX, degradeMode: DegradeMode.Normal, minDist: 10, idealDist: 25, maxDist: 50 },
  { gfxObjId: 0x01000002, degradeMode: DegradeMode.Normal, minDist: 25, idealDist: 50, maxDist: 100 },
  { gfxObjId: 0x01000003, degradeMode: DegradeMode.Normal, minDist: 50, idealDist: 100, maxDist: 200 },
  { gfxObjId: 0, degradeMode: DegradeMode.Normal, minDist: 3e38, idealDist: 3e38, maxDist: 3e38 },
];
const CHAIN: DegradeChain = { infoId: 0x11000000, degrades: LEVELS, levelIds: LEVELS.map(l => l.gfxObjId), sortCenter: new THREE.Vector3(0.3, 1.2, -0.4) };

describe('DegradeLod.updateParts — same levels, no per-part decompose', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picks the decompose path\'s levels for 200 scaled parts and never decomposes a non-billboard part', () => {
    const lodSys = new DegradeLod(null);
    lodSys.setChain(GFX, CHAIN);
    const scene = new THREE.Scene();
    const r = rng(11);
    const parts: THREE.Object3D[] = [];
    for (let i = 0; i < 200; i++) {
      const obj = new THREE.Group();
      obj.position.set((r() - 0.5) * 600, r() * 5, (r() - 0.5) * 600);
      obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6);
      const sc = 0.5 + r() * 2;
      obj.scale.set(sc, 0.5 + r() * 2, sc);
      const part = new THREE.Group();
      part.name = 'part_0';
      part.position.set(r(), r(), r());
      part.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      obj.add(part);
      scene.add(obj);
      expect(lodSys.attachPart(part, GFX, () => new THREE.Group())).toBe(true);
      parts.push(part);
    }
    scene.updateMatrixWorld(true);
    const viewer = new THREE.Vector3(10, 2, -20);

    // Reference: the pre-change scale source (decompose), same distance rule.
    const expected = parts.map((part) => {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      part.matrixWorld.decompose(p, q, s);
      const scaleZ = s.y > 1e-6 ? s.y : 1;
      const e = part.parent!.matrixWorld.elements;
      const op = new THREE.Vector3(e[12], e[13], e[14]);
      // parts are not LAND_CELL-tagged: the object / part distance only
      const dx = op.x - viewer.x, dz = op.z - viewer.z;
      const dist = dx * dx + dz * dz >= lodSys.objectDistance2dSq
        ? op.distanceTo(viewer) / scaleZ
        : CHAIN.sortCenter.clone().applyMatrix4(part.matrixWorld).distanceTo(viewer) / scaleZ;
      return selectDegradeLevel(LEVELS, dist, RETAIL_DEGRADE_PREFS.degradeDistance, lodSys.bias, -1, false);
    });

    const decompose = vi.spyOn(THREE.Matrix4.prototype, 'decompose');
    const fromRot = vi.spyOn(THREE.Quaternion.prototype, 'setFromRotationMatrix');
    lodSys.updateParts(viewer, scene);
    expect(decompose).toHaveBeenCalledTimes(0);
    expect(fromRot).toHaveBeenCalledTimes(0);
    expect(parts.map((p) => p.userData.acDegrade.level)).toEqual(expected);
    // a spread of levels, so the comparison means something
    expect(new Set(expected).size).toBeGreaterThan(2);
  });
});
