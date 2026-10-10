/**
 * PERF.1 (town-facing part-bucket slice) — building-exterior pooling
 * behavioral verification.
 *
 * Building exteriors move from one Mesh per SetupModel part per building
 * (the largest town-facing draw-call bucket: `part(nosrv)` = 792 calls at
 * Holtburg) into a SceneryInstancePool keyed per landblock. The covenant
 * (docs/performance-budgets.md) requires pixel- and behavior-identical
 * output, so these tests assert:
 *   - SceneryInstancer.getWorldBBox === Box3.setFromObject on the old
 *     per-object group (building shells keep the exact same walk-in
 *     footprints without a live mesh);
 *   - pooled instance matrices equal the old path's position/quaternion
 *     world transforms, including Setup part placement frames and scales;
 *   - pooled InstancedMeshes are raycastable at the same hit distances the
 *     per-object meshes gave (camera pull-in behind building walls).
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';

const GFX_A = 0x01000001;
const GFX_B = 0x01000002;
const SETUP_A = 0x02000001;
const MISSING = 0x01ffffff;

/** Fake ModelRenderer: per-surface child meshes like the real one. The
 *  geometry is offset from the origin so bbox/transform mistakes (ignoring
 *  rotation or part frames) actually change the numbers. */
function makeModelSource() {
  const createMesh = vi.fn((gfxObjId: number): THREE.Group | null => {
    if (gfxObjId === MISSING) return null;
    const group = new THREE.Group();
    const geomA = new THREE.BoxGeometry(2, 4, 6);
    geomA.translate(1, 2, 3);
    group.add(new THREE.Mesh(geomA, new THREE.MeshLambertMaterial()));
    if (gfxObjId === GFX_B) {
      const geomB = new THREE.BoxGeometry(1, 1, 1);
      geomB.translate(-5, 0.5, 2);
      group.add(new THREE.Mesh(geomB, new THREE.MeshLambertMaterial()));
    }
    return group;
  });
  return { createMesh };
}

/** Fake SetupModel with placement frames + a per-part scale, shaped like
 *  the real parser output that getPartPlacements consumes. */
const SETUP_SOURCE = {
  loadSetupModel: (setupId: number) => {
    if (setupId !== SETUP_A) return null;
    return {
      parts: [GFX_A, GFX_B],
      placementFrames: new Map([[0, {
        frames: [
          { origin: { x: 1, y: 2, z: 3 }, orientation: { w: 0.7071068, x: 0, y: 0, z: 0.7071068 } },
          { origin: { x: -4, y: 0, z: 1.5 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
        ],
      }]]),
      defaultScale: [{ x: 2, y: 2, z: 2 }],
      parentIndex: [],
    } as never;
  },
};

/**
 * The OLD un-batched building path, reproduced with live Object3Ds:
 * SetupModelRenderer.createSetupMeshWithOverrides part transforms (AC Z-up →
 * three Y-up swaps) under a root with the building's position/quaternion —
 * exactly what main.ts applied before pooling.
 */
function buildOldPathGroup(
  instancerSource: ReturnType<typeof makeModelSource>,
  objId: number,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): THREE.Group {
  const root = new THREE.Group();
  root.position.copy(position);
  root.quaternion.copy(quaternion);
  if ((objId >>> 24) === 0x01) {
    const mesh = instancerSource.createMesh(objId);
    if (mesh) root.add(mesh);
  } else {
    const setup = SETUP_SOURCE.loadSetupModel(objId) as unknown as {
      parts: number[];
      placementFrames: Map<number, { frames: { origin: { x: number; y: number; z: number }; orientation: { w: number; x: number; y: number; z: number } }[] }>;
      defaultScale: { x: number; y: number; z: number }[];
    };
    const frames = setup.placementFrames.get(0)!.frames;
    for (let i = 0; i < setup.parts.length; i++) {
      const partMesh = instancerSource.createMesh(setup.parts[i]);
      if (!partMesh) continue;
      const f = frames[i];
      partMesh.position.set(f.origin.x, f.origin.z, f.origin.y);
      partMesh.quaternion.set(-f.orientation.x, -f.orientation.z, -f.orientation.y, f.orientation.w);
      const s = setup.defaultScale[i];
      if (s) partMesh.scale.set(s.x, s.z, s.y);
      root.add(partMesh);
    }
  }
  root.updateMatrixWorld(true);
  return root;
}

function buildingMatrix(position: THREE.Vector3, quaternion: THREE.Quaternion): THREE.Matrix4 {
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
}

const POS = new THREE.Vector3(1234.5, 42, -678.25);
const QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);

describe('SceneryInstancer.getWorldBBox — building shell footprint parity', () => {
  it('equals Box3.setFromObject on the old per-object group (plain GfxObj)', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, SETUP_SOURCE);
    const old = buildOldPathGroup(makeModelSource(), GFX_B, POS, QUAT);
    const expected = new THREE.Box3().setFromObject(old);
    const actual = inst.getWorldBBox(GFX_B, buildingMatrix(POS, QUAT))!;
    expect(actual).not.toBeNull();
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual.min[axis]).toBeCloseTo(expected.min[axis], 5);
      expect(actual.max[axis]).toBeCloseTo(expected.max[axis], 5);
    }
  });

  it('equals Box3.setFromObject for a Setup with placement frames + part scale', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, SETUP_SOURCE);
    const old = buildOldPathGroup(makeModelSource(), SETUP_A, POS, QUAT);
    const expected = new THREE.Box3().setFromObject(old);
    const actual = inst.getWorldBBox(SETUP_A, buildingMatrix(POS, QUAT))!;
    expect(actual).not.toBeNull();
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual.min[axis]).toBeCloseTo(expected.min[axis], 5);
      expect(actual.max[axis]).toBeCloseTo(expected.max[axis], 5);
    }
  });

  it('returns null when the model has no renderable parts', () => {
    const inst = new SceneryInstancer(makeModelSource(), SETUP_SOURCE);
    expect(inst.getWorldBBox(MISSING, new THREE.Matrix4())).toBeNull();
    expect(inst.getWorldBBox(0x02999999, new THREE.Matrix4())).toBeNull();
  });
});

describe('Pooled building exteriors — transform parity with the per-object path', () => {
  it('pooled instance matrices equal the old path part matrixWorlds (Setup building)', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, SETUP_SOURCE);
    const inScene = new Set<THREE.Object3D>();
    const pool = new SceneryInstancePool(inst, 'bldginst', m => inScene.add(m), m => inScene.delete(m));

    const entries: InstanceEntry[] = [{ objId: SETUP_A, matrix: buildingMatrix(POS, QUAT) }];
    pool.addBlock(0xa9b4, entries);

    // Old path: each part child's matrixWorld is the reference transform.
    const old = buildOldPathGroup(makeModelSource(), SETUP_A, POS, QUAT);
    const refByGfx = new Map<number, THREE.Matrix4[]>();
    old.children.forEach((child, i) => {
      const gfxId = [GFX_A, GFX_B][i];
      (refByGfx.get(gfxId) ?? refByGfx.set(gfxId, []).get(gfxId)!).push(child.matrixWorld.clone());
    });

    for (const mesh of inScene) {
      const im = mesh as THREE.InstancedMesh;
      const gfxId = parseInt(im.name.replace('bldginst_', ''), 16);
      const refs = refByGfx.get(gfxId)!;
      expect(im.count).toBe(refs.length);
      const got = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, got);
        // InstancedMesh matrices are stored float32 — compare at float32
        // precision (translation ~675 has a ~6e-5 ulp; the un-pooled path's
        // float64 matrixWorld quantizes identically on GPU upload).
        for (let e = 0; e < 16; e++) expect(got.elements[e]).toBeCloseTo(refs[i].elements[e], 3);
      }
    }
    // 1 GfxObj with 1 submesh + 1 with 2 submeshes = 3 pooled meshes.
    expect(inScene.size).toBe(3);
  });

  it('pooled InstancedMesh raycasts at the same distance as the per-object mesh (camera pull-in)', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, SETUP_SOURCE);
    const inScene = new Set<THREE.Object3D>();
    const pool = new SceneryInstancePool(inst, 'bldginst', m => inScene.add(m), m => inScene.delete(m));
    pool.addBlock(0xa9b4, [{ objId: GFX_A, matrix: buildingMatrix(POS, QUAT) }]);

    const old = buildOldPathGroup(makeModelSource(), GFX_A, POS, QUAT);
    const oldMeshes: THREE.Mesh[] = [];
    old.traverse(c => { if (c instanceof THREE.Mesh) oldMeshes.push(c); });

    // Ray toward the building from outside it, as getCameraDistance casts.
    const origin = new THREE.Vector3(POS.x + 30, POS.y + 2, POS.z);
    const dir = new THREE.Vector3(-1, 0, 0);
    const ray = new THREE.Raycaster(origin, dir, 0, 100);

    const oldHits = ray.intersectObjects(oldMeshes, false);
    const pooled: THREE.Object3D[] = [...inScene];
    pooled.forEach(m => m.updateMatrixWorld(true));
    const pooledHits = ray.intersectObjects(pooled, false);

    expect(oldHits.length).toBeGreaterThan(0);
    expect(pooledHits.length).toBeGreaterThan(0);
    expect(pooledHits[0].distance).toBeCloseTo(oldHits[0].distance, 4);
  });

  it('removeBlock retires a block’s building instances (unload parity)', () => {
    const inst = new SceneryInstancer(makeModelSource(), SETUP_SOURCE);
    const inScene = new Set<THREE.Object3D>();
    const pool = new SceneryInstancePool(inst, 'bldginst', m => inScene.add(m), m => inScene.delete(m));
    pool.addBlock(0xa9b4, [{ objId: GFX_A, matrix: buildingMatrix(POS, QUAT) }]);
    pool.addBlock(0xa9b5, [{ objId: GFX_A, matrix: buildingMatrix(new THREE.Vector3(0, 0, 0), QUAT) }]);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    pool.removeBlock(0xa9b4);
    expect(mesh.count).toBe(1);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(0, 5); // the surviving instance is block 0xa9b5's
  });
});
