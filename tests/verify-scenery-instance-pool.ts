/**
 * PERF.1 — SceneryInstancePool behavioral verification.
 *
 * The pool replaces the per-landblock instanced batches (one InstancedMesh
 * per (GfxObj, submesh) per landblock — ~1,220 meshes / 941–1,313 draw calls
 * at Holtburg) with ONE InstancedMesh per distinct pair across all loaded
 * landblocks (~56 at Holtburg). The covenant (docs/performance-budgets.md)
 * requires pixel-identical output, so these tests assert the pooled instance
 * matrices are exactly the ones the per-landblock path produced, that block
 * unload retires exactly that block's instances, and that shared
 * geometry/materials survive pool growth and removal.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import type { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';

const GFX_A = 0x01000001;
const GFX_B = 0x01000002;

function makeModelSource(submeshesPerGfx = 1) {
  const createMesh = vi.fn((): THREE.Group | null => {
    const group = new THREE.Group();
    for (let i = 0; i < submeshesPerGfx; i++) {
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
    }
    return group;
  });
  return { createMesh };
}

const NO_SETUPS = { loadSetupModel: () => null };

function entry(objId: number, x: number, y = 0, z = 0): InstanceEntry {
  return { objId, matrix: new THREE.Matrix4().makeTranslation(x, y, z) };
}

/** Pool + a scene-membership tracker wired through the add/remove callbacks. */
function makePool(instancer: SceneryInstancer, prefix = 'sceneryinst') {
  const inScene = new Set<THREE.Object3D>();
  const pool = new SceneryInstancePool(
    instancer, prefix,
    m => inScene.add(m),
    m => inScene.delete(m),
  );
  return { pool, inScene };
}

function matricesOf(mesh: THREE.InstancedMesh): string[] {
  const out: string[] = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    out.push(m.elements.map(e => e.toFixed(5)).join(','));
  }
  return out.sort();
}

describe('SceneryInstancePool — cross-landblock batching', () => {
  it('pools the same GfxObj from multiple blocks into ONE InstancedMesh', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 1), entry(GFX_A, 2)]);
    pool.addBlock(0x0102, [entry(GFX_A, 3)]);
    expect(inScene.size).toBe(1);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(mesh.count).toBe(3);
    expect(pool.drawableMeshCount).toBe(1);
  });

  it('keeps one pooled mesh per (GfxObj, submesh) pair', () => {
    const inst = new SceneryInstancer(makeModelSource(2), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 1), entry(GFX_B, 2)]);
    pool.addBlock(0x0102, [entry(GFX_A, 3)]);
    // 2 GfxObjs × 2 submeshes = 4 pooled meshes regardless of block count.
    expect(inScene.size).toBe(4);
    expect(pool.drawableMeshCount).toBe(4);
  });

  it('covenant: pooled matrices are exactly the per-landblock batch matrices', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, NO_SETUPS);
    const entriesA = [entry(GFX_A, 10, 5, -3), entry(GFX_A, -7, 2, 8)];
    const entriesB = [entry(GFX_A, 100, 0, 42)];

    // Reference: the per-landblock batches for the same entries.
    const refA = inst.buildInstances(entriesA, 'ref')[0] as THREE.InstancedMesh;
    const refB = inst.buildInstances(entriesB, 'ref')[0] as THREE.InstancedMesh;
    const expected = [...matricesOf(refA), ...matricesOf(refB)].sort();

    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, entriesA);
    pool.addBlock(0x0102, entriesB);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(matricesOf(mesh)).toEqual(expected);
  });

  it('shares the template geometry/material with the per-landblock path (no duplication)', () => {
    const source = makeModelSource();
    const inst = new SceneryInstancer(source, NO_SETUPS);
    const perBlock = inst.buildInstances([entry(GFX_A, 1)], 'ref')[0] as THREE.InstancedMesh;
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 2)]);
    const pooled = [...inScene][0] as THREE.InstancedMesh;
    expect(pooled.geometry).toBe(perBlock.geometry);
    expect(pooled.material).toBe(perBlock.material);
    expect(source.createMesh).toHaveBeenCalledTimes(1);
    expect(pooled.userData.sharedResources).toBe(true);
    expect(pooled.name).toBe('sceneryinst_01000001');
  });
});

describe('SceneryInstancePool — block unload (removeBlock)', () => {
  it('retires exactly the unloaded block’s instances, preserving the rest', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    const keepEntries = [entry(GFX_A, 1), entry(GFX_A, 2)];
    pool.addBlock(0x0101, keepEntries);
    pool.addBlock(0x0102, [entry(GFX_A, 50), entry(GFX_A, 60), entry(GFX_A, 70)]);
    pool.removeBlock(0x0102);

    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    const ref = new SceneryInstancer(makeModelSource(), NO_SETUPS)
      .buildInstances(keepEntries, 'ref')[0] as THREE.InstancedMesh;
    expect(matricesOf(mesh)).toEqual(matricesOf(ref));
    expect(pool.instanceCountFor(0x0102)).toBe(0);
    expect(pool.instanceCountFor(0x0101)).toBe(2);
  });

  it('survives interleaved add/remove across many blocks (streaming walk)', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    // Simulate a walk: window of 3 blocks sliding over 10.
    for (let b = 0; b < 10; b++) {
      pool.addBlock(b, [entry(GFX_A, b * 10), entry(GFX_A, b * 10 + 1)]);
      if (b >= 3) pool.removeBlock(b - 3);
    }
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(6); // blocks 7, 8, 9 × 2 instances
    const expected = new SceneryInstancer(makeModelSource(), NO_SETUPS).buildInstances(
      [7, 8, 9].flatMap(b => [entry(GFX_A, b * 10), entry(GFX_A, b * 10 + 1)]), 'ref',
    )[0] as THREE.InstancedMesh;
    expect(matricesOf(mesh)).toEqual(matricesOf(expected));
  });

  it('hides (not draws) a pooled mesh whose instances are all retired, and revives it on re-add', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 1)]);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.visible).toBe(true);
    pool.removeBlock(0x0101);
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    expect(pool.drawableMeshCount).toBe(0);
    pool.addBlock(0x0103, [entry(GFX_A, 9)]);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(1);
  });

  it('re-adding a block replaces its previous contribution (no duplicates)', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 1), entry(GFX_A, 2)]);
    pool.addBlock(0x0101, [entry(GFX_A, 3)]);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(1);
    expect(pool.instanceCountFor(0x0101)).toBe(1);
  });
});

describe('SceneryInstancePool — capacity growth', () => {
  it('grows the pooled mesh preserving matrices; old mesh leaves the scene, shared resources survive', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    // First block small; second block large enough to force a grow past the
    // initial capacity (max(16, first-add size)).
    const small = [entry(GFX_A, 0)];
    const big = Array.from({ length: 40 }, (_, i) => entry(GFX_A, i + 100));
    pool.addBlock(0x0101, small);
    const before = [...inScene][0] as THREE.InstancedMesh;
    const geom = before.geometry;
    const mat = before.material as THREE.Material;
    const geomSpy = vi.spyOn(geom, 'dispose');
    const matSpy = vi.spyOn(mat, 'dispose');

    pool.addBlock(0x0102, big);
    expect(inScene.size).toBe(1);
    const after = [...inScene][0] as THREE.InstancedMesh;
    expect(after).not.toBe(before); // swapped for a larger buffer
    expect(after.count).toBe(41);
    expect(after.geometry).toBe(geom); // shared resources untouched
    expect(after.material).toBe(mat);
    expect(geomSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();

    const expected = new SceneryInstancer(makeModelSource(), NO_SETUPS)
      .buildInstances([...small, ...big], 'ref')[0] as THREE.InstancedMesh;
    expect(matricesOf(after)).toEqual(matricesOf(expected));
  });

  it('computes an all-blocks bounding sphere so frustum culling stays correct', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 0)]);
    pool.addBlock(0x0102, [entry(GFX_A, 500)]);
    const mesh = [...inScene][0] as THREE.InstancedMesh;
    expect(mesh.boundingSphere).not.toBeNull();
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(240);
  });
});

describe('SceneryInstancePool — sealed-interior visibility toggle', () => {
  it('setVisible(false) hides all pooled meshes; blocks added while hidden stay hidden; restore shows only non-empty pools', () => {
    const inst = new SceneryInstancer(makeModelSource(), NO_SETUPS);
    const { pool, inScene } = makePool(inst);
    pool.addBlock(0x0101, [entry(GFX_A, 1)]);
    pool.addBlock(0x0102, [entry(GFX_B, 2)]);
    pool.setVisible(false);
    for (const m of inScene) expect(m.visible).toBe(false);

    pool.addBlock(0x0103, [entry(GFX_A, 3)]);
    for (const m of inScene) expect(m.visible).toBe(false);

    pool.removeBlock(0x0102); // GFX_B pool now empty
    pool.setVisible(true);
    const byName = new Map([...inScene].map(m => [m.name, m]));
    expect(byName.get('sceneryinst_01000001')!.visible).toBe(true);
    expect(byName.get('sceneryinst_01000002')!.visible).toBe(false); // empty stays hidden
  });
});

describe('TerrainRenderer — landblock detacher hook', () => {
  it('fires the detacher for every unloaded landblock id during update()', () => {
    const unloadedIds = [0x0102ffff, 0x0203ffff];
    const fakeManager = {
      update: () => ({ loaded: [], unloaded: unloadedIds }),
      getMesh: () => undefined,
      getLoadedMeshes: () => new Map(),
      clear: () => undefined,
    } as unknown as TerrainManager;
    const renderer = new TerrainRenderer(new THREE.Scene(), fakeManager);
    const detached: number[] = [];
    renderer.setLandblockDetacher(id => detached.push(id));
    renderer.update(0, 0);
    expect(detached).toEqual(unloadedIds);
  });

  it('fires the detacher for every still-loaded landblock on clear()', () => {
    const loaded = new Map([[0x0102ffff, {}], [0x0203ffff, {}]]);
    const fakeManager = {
      update: () => ({ loaded: [], unloaded: [] }),
      getMesh: () => undefined,
      getLoadedMeshes: () => loaded,
      clear: () => undefined,
    } as unknown as TerrainManager;
    const renderer = new TerrainRenderer(new THREE.Scene(), fakeManager);
    const detached: number[] = [];
    renderer.setLandblockDetacher(id => detached.push(id));
    renderer.clear();
    expect(detached).toEqual([0x0102ffff, 0x0203ffff]);
  });
});
