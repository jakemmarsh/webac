/**
 * PERF (2026-09-30) — static meshes (terrain blocks, merged overlays, the
 * instancing pools) skip the per-frame matrix walk (~4% of the main thread).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { freezeStaticTransform, refreeze } from '../packages/renderer/src/utils/freezeStatic.js';
import { SceneryInstancer } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';

describe('freezeStaticTransform', () => {
  it('bakes the current world matrix and the per-frame scene walk then leaves it alone', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.position.set(192, 0, 384);
    scene.add(mesh);
    freezeStaticTransform(mesh);
    expect(mesh.matrixWorld.elements[12]).toBe(192);
    expect(mesh.matrixWorld.elements[14]).toBe(384);
    mesh.position.set(1, 2, 3); // a stray write is NOT picked up by the frame walk
    scene.updateMatrixWorld();
    expect(mesh.matrixWorld.elements[12]).toBe(192);
    refreeze(mesh); // a deliberate move re-bakes
    expect(mesh.matrixWorld.elements[12]).toBe(1);
  });

  it('pooled InstancedMeshes frozen by a root-level onMeshAdded (main.ts poolAdd) keep their world placement', () => {
    const createMesh = (id: number) => { if (id !== 0x01000001) return null; const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())); return g; };
    const scene = new THREE.Scene();
    const pool = new SceneryInstancePool(new SceneryInstancer({ createMesh }, { loadSetupModel: () => null }), 'sceneryinst', (m) => { scene.add(m); freezeStaticTransform(m); }, (m) => scene.remove(m));
    pool.addBlock(1, [{ objId: 0x01000001, matrix: new THREE.Matrix4().makeTranslation(5, 0, 5) }]);
    const meshes = scene.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) { expect(m.matrixAutoUpdate).toBe(false); expect(m.matrixWorldAutoUpdate).toBe(false); }
  });

  it('the pool itself does not freeze (a per-cell pool mesh is parented after creation)', () => {
    const createMesh = (id: number) => { if (id !== 0x01000001) return null; const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())); return g; };
    const cell = new THREE.Group(); cell.position.set(100, 0, 50);
    const pool = new SceneryInstancePool(new SceneryInstancer({ createMesh }, { loadSetupModel: () => null }), 'envfurninst', (m) => cell.add(m), (m) => cell.remove(m));
    pool.addBlock(1, [{ objId: 0x01000001, matrix: new THREE.Matrix4() }]);
    cell.updateMatrixWorld(true);
    const m = cell.children[0];
    expect(m.matrixWorld.elements[12]).toBe(100);
  });
});
