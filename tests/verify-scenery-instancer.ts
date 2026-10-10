/**
 * CORE.14 / PERF.1 — SceneryInstancer behavioral verification.
 *
 * The instancer replaces the one-Mesh-per-part scenery path (~19.7k meshes,
 * ~10.7k draw calls, 11 fps on a real GPU at Holtburg) with one
 * THREE.InstancedMesh per (GfxObj, surface submesh) per landblock. The
 * covenant (docs/performance-budgets.md) requires the output be pixel-
 * identical, so these tests assert the instance matrices equal the exact
 * world transforms the old per-object path produced (same quaternion
 * composition, same AC Z-up → three Y-up swaps, same FAITHFUL.199
 * ground-origin convention), that geometry/materials are shared rather than
 * duplicated, and that landblock disposal never disposes shared resources.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SceneryInstancer } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import type { SceneryPlacement } from '../packages/renderer/src/terrain/SceneryGenerator.js';
import type { ObjectDesc } from '@ac/dat-parser';

const GFX_A = 0x01000001;
const GFX_B = 0x01000002;
const SETUP_A = 0x02000001;
const MISSING = 0x01ffffff;

/** Minimal ObjectDesc stand-in — the instancer only reads baseLoc.orientation. */
function makeDesc(orientation = { w: 1, x: 0, y: 0, z: 0 }): ObjectDesc {
  return { baseLoc: { origin: { x: 0, y: 0, z: 0 }, orientation } } as unknown as ObjectDesc;
}

function makePlacement(objId: number, over: Partial<SceneryPlacement> = {}): SceneryPlacement {
  return {
    objId,
    x: 10, y: 20, z: 5,
    scale: 1,
    heading: 0,
    desc: makeDesc(),
    ...over,
  };
}

/** Fake ModelRenderer: each createMesh call returns a FRESH group whose
 *  children are per-surface meshes, like the real ModelRenderer. */
function makeModelSource(submeshesPerGfx = 1) {
  const createMesh = vi.fn((gfxObjId: number): THREE.Group | null => {
    if (gfxObjId === MISSING) return null;
    const group = new THREE.Group();
    for (let i = 0; i < submeshesPerGfx; i++) {
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
    }
    return group;
  });
  return { createMesh };
}

const NO_SETUPS = { loadSetupModel: () => null };

/** The old un-batched path's transform, reproduced with a real Object3D. */
function oldPathWorldMatrix(p: SceneryPlacement, wx: number, wz: number): THREE.Matrix4 {
  const obj = new THREE.Object3D();
  if (p.scale !== 1) obj.scale.setScalar(p.scale);
  const baseRot = p.desc.baseLoc.orientation;
  const baseQuat = new THREE.Quaternion(-baseRot.x, -baseRot.z, -baseRot.y, baseRot.w);
  const headingQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), p.heading * Math.PI / 180,
  );
  obj.quaternion.copy(headingQuat).multiply(baseQuat);
  obj.position.set(wx + p.x, p.z, wz + p.y);
  obj.updateMatrixWorld(true);
  return obj.matrixWorld.clone();
}

function expectMatrixClose(actual: THREE.Matrix4, expected: THREE.Matrix4): void {
  for (let i = 0; i < 16; i++) {
    expect(actual.elements[i]).toBeCloseTo(expected.elements[i], 6);
  }
}

describe('SceneryInstancer — batching identical models', () => {
  it('collapses N placements of one GfxObj into a single InstancedMesh with N instances', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const placements = [
      makePlacement(GFX_A, { x: 1 }),
      makePlacement(GFX_A, { x: 2 }),
      makePlacement(GFX_A, { x: 3 }),
    ];
    const out = inst.buildLandblockInstances(placements, 0, 0);
    expect(out).toHaveLength(1);
    const im = out[0] as THREE.InstancedMesh;
    expect(im).toBeInstanceOf(THREE.InstancedMesh);
    expect(im.count).toBe(3);
    expect(im.userData.sharedResources).toBe(true);
  });

  it('creates one InstancedMesh per surface submesh of the GfxObj', () => {
    const inst = new SceneryInstancer(makeModelSource(3), NO_SETUPS);
    const out = inst.buildLandblockInstances([makePlacement(GFX_A)], 0, 0);
    expect(out).toHaveLength(3);
    for (const o of out) expect((o as THREE.InstancedMesh).count).toBe(1);
  });

  it('separates different GfxObjs into different InstancedMeshes', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const out = inst.buildLandblockInstances(
      [makePlacement(GFX_A), makePlacement(GFX_B), makePlacement(GFX_A)], 0, 0,
    );
    expect(out).toHaveLength(2);
    const counts = out.map(o => (o as THREE.InstancedMesh).count).sort();
    expect(counts).toEqual([1, 2]);
  });

  it('skips unloadable models and reports hasModel=false for them', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    expect(inst.hasModel(MISSING)).toBe(false);
    expect(inst.hasModel(GFX_A)).toBe(true);
    const out = inst.buildLandblockInstances([makePlacement(MISSING)], 0, 0);
    expect(out).toHaveLength(0);
  });
});

describe('SceneryInstancer — transform fidelity vs the un-batched path', () => {
  it('plain placement: instance matrix equals the old Object3D transform', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const p = makePlacement(GFX_A, { x: 33.5, y: 71.25, z: 12.125 });
    const out = inst.buildLandblockInstances([p], 960, 1152);
    const m = new THREE.Matrix4();
    (out[0] as THREE.InstancedMesh).getMatrixAt(0, m);
    expectMatrixClose(m, oldPathWorldMatrix(p, 960, 1152));
  });

  it('FAITHFUL.199 — placement Y is exact ground z, no baseLift', () => {
    // Tree GfxObjs carry shadow polygons below local Z=0; a bbox.min-based
    // "baseLift" floated trunks ~1m off the ground. The instanced path must
    // keep the model-local origin exactly at the sampled ground height.
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const p = makePlacement(GFX_A, { z: 41.625 });
    const out = inst.buildLandblockInstances([p], 0, 0);
    const m = new THREE.Matrix4();
    (out[0] as THREE.InstancedMesh).getMatrixAt(0, m);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    expect(pos.y).toBe(41.625);
  });

  it('scaled + rotated placement (heading × baseLoc orientation) matches', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    // Non-trivial base orientation: 90° about AC Z (yaw)
    const s = Math.SQRT1_2;
    const p = makePlacement(GFX_A, {
      scale: 1.75,
      heading: 137,
      desc: makeDesc({ w: s, x: 0, y: 0, z: s }),
    });
    const out = inst.buildLandblockInstances([p], 192, 384);
    const m = new THREE.Matrix4();
    (out[0] as THREE.InstancedMesh).getMatrixAt(0, m);
    expectMatrixClose(m, oldPathWorldMatrix(p, 192, 384));
  });

  it('SetupModel parts: instance matrices equal objectMatrix × part frame, per SetupModelRenderer conventions', () => {
    // Fake setup: two parts of the same GfxObj at different frames, one scaled.
    const frameA = { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };
    const s = Math.SQRT1_2;
    const frameB = { origin: { x: 1, y: 2, z: 3 }, orientation: { w: s, x: s, y: 0, z: 0 } };
    const setup = {
      parts: [GFX_A, GFX_A],
      placementFrames: new Map([[0, { frames: [frameA, frameB] }]]),
      defaultScale: [undefined, { x: 2, y: 3, z: 4 }],
      parentIndex: [],
    };
    const inst = new SceneryInstancer(makeModelSource(), {
      loadSetupModel: (id: number) => (id === SETUP_A ? setup as never : null),
    });
    const p = makePlacement(SETUP_A, { heading: 45, scale: 1.2 });
    const out = inst.buildLandblockInstances([p], 0, 0);
    expect(out).toHaveLength(1);
    const im = out[0] as THREE.InstancedMesh;
    expect(im.count).toBe(2);

    // Reference: parent Object3D (old scenery transform) with part children
    // positioned exactly as SetupModelRenderer.createSetupMeshWithOverrides does.
    const parent = new THREE.Object3D();
    parent.applyMatrix4(oldPathWorldMatrix(p, 0, 0));
    const mk = (frame: typeof frameB, scale?: { x: number; y: number; z: number }) => {
      const part = new THREE.Object3D();
      part.position.set(frame.origin.x, frame.origin.z, frame.origin.y);
      part.quaternion.set(
        -frame.orientation.x, -frame.orientation.z, -frame.orientation.y, frame.orientation.w,
      );
      if (scale) part.scale.set(scale.x, scale.z, scale.y);
      parent.add(part);
      return part;
    };
    const refA = mk(frameA);
    const refB = mk(frameB, { x: 2, y: 3, z: 4 });
    parent.updateMatrixWorld(true);

    const mA = new THREE.Matrix4();
    const mB = new THREE.Matrix4();
    im.getMatrixAt(0, mA);
    im.getMatrixAt(1, mB);
    expectMatrixClose(mA, refA.matrixWorld);
    expectMatrixClose(mB, refB.matrixWorld);
  });
});

describe('SceneryInstancer — CORE.14.a landblock statics (buildInstances)', () => {
  /** The static path's transform: Object3D at world pos (+ a test offset)
   *  with the AC Z-up → three Y-up quaternion swap, scale 1. */
  function oldStaticWorldMatrix(
    pos: { x: number; y: number; z: number },
    rot: { w: number; x: number; y: number; z: number },
    lift: number, wx: number, wz: number,
  ): THREE.Matrix4 {
    const obj = new THREE.Object3D();
    obj.position.set(wx + pos.x, pos.z + lift, wz + pos.y);
    obj.quaternion.set(-rot.x, -rot.z, -rot.y, rot.w);
    obj.updateMatrixWorld(true);
    return obj.matrixWorld.clone();
  }

  it('batches arbitrary matrix entries by GfxObj with the exact given matrices', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const pos = { x: 33.5, y: 71.25, z: 12.125 };
    const s = Math.SQRT1_2;
    const rot = { w: s, x: 0, y: 0, z: s };
    const expected = oldStaticWorldMatrix(pos, rot, 0.5, 960, 1152);
    const out = inst.buildInstances([
      { objId: GFX_A, matrix: expected.clone() },
      { objId: GFX_A, matrix: new THREE.Matrix4() },
    ], 'staticinst') as THREE.InstancedMesh[];
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    const m = new THREE.Matrix4();
    out[0].getMatrixAt(0, m);
    expectMatrixClose(m, expected);
  });

  it('names instanced meshes with the caller prefix and flags sharedResources', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const out = inst.buildInstances([{ objId: GFX_A, matrix: new THREE.Matrix4() }], 'staticinst');
    expect(out[0].name).toBe('staticinst_01000001');
    expect(out[0].userData.sharedResources).toBe(true);
  });

  it('buildLandblockInstances still routes through the generic path (sceneryinst prefix, same matrices)', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const p = makePlacement(GFX_A, { x: 12.5, heading: 90 });
    const out = inst.buildLandblockInstances([p], 192, 384) as THREE.InstancedMesh[];
    expect(out[0].name).toBe('sceneryinst_01000001');
    const m = new THREE.Matrix4();
    out[0].getMatrixAt(0, m);
    expectMatrixClose(m, oldPathWorldMatrix(p, 192, 384));
  });

});

describe('SceneryInstancer — resource sharing across landblocks', () => {
  it('reuses the same geometry and material for the same GfxObj in different landblocks', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, NO_SETUPS);
    const a = inst.buildLandblockInstances([makePlacement(GFX_A)], 0, 0) as THREE.InstancedMesh[];
    const b = inst.buildLandblockInstances([makePlacement(GFX_A)], 192, 0) as THREE.InstancedMesh[];
    expect(a[0].geometry).toBe(b[0].geometry);
    expect(a[0].material).toBe(b[0].material);
    // Template built exactly once — repeated landblocks never re-create meshes.
    expect(source.createMesh).toHaveBeenCalledTimes(1);
  });

  it('computes an instance-aware bounding sphere so frustum culling stays correct', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const out = inst.buildLandblockInstances(
      [makePlacement(GFX_A, { x: 0 }), makePlacement(GFX_A, { x: 100 })], 0, 0,
    ) as THREE.InstancedMesh[];
    const sphere = out[0].boundingSphere!;
    expect(sphere).not.toBeNull();
    // Sphere must span both instances (x=0 and x=100 world) — radius > 45.
    expect(sphere.radius).toBeGreaterThan(45);
  });
});

describe('TerrainRenderer.disposeAttachment — shared-resource guard', () => {
  it('does NOT dispose geometry/material of sharedResources meshes, but frees instance buffers', () => {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    const geomSpy = vi.spyOn(geom, 'dispose');
    const matSpy = vi.spyOn(mat, 'dispose');
    const im = new THREE.InstancedMesh(geom, mat, 2);
    im.userData.sharedResources = true;
    const imSpy = vi.spyOn(im, 'dispose');

    TerrainRenderer.disposeAttachment(im);
    expect(geomSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(imSpy).toHaveBeenCalledTimes(1);
  });

  it('still fully disposes ordinary (non-shared) meshes', () => {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    const geomSpy = vi.spyOn(geom, 'dispose');
    const matSpy = vi.spyOn(mat, 'dispose');
    const mesh = new THREE.Mesh(geom, mat);

    TerrainRenderer.disposeAttachment(mesh);
    expect(geomSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
  });
});
