/**
 * PERF.restored-copy-release (2026-11-16, docs/perf-pass-2026-11-15.md) —
 * CPhysicsPart::RestoreMaterial @ 0050df70: when a part's translucency is back
 * at the default (CurSettingsAreDefault @ 0050d9e0), retail releases the part's
 * CopyMaterial copy and the part draws the GfxObj's shared material again. We
 * used to restore the copy's authored values but keep the copy, so every part
 * that ever faded (a materializing creature, a player portalling in) drew its
 * own material for the rest of its life.
 * Drives the real ObjectTranslucency / MaterialOwnership / PartMaterialState code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { isSharedMaterial, ownedCopyState, releaseRestoredCopies } from '../packages/renderer/src/models/MaterialOwnership.js';
import { setObjectTranslucency, setServerTranslucency } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { setPartMaterialValue } from '../packages/renderer/src/models/PartMaterialState.js';
import { cellObjectVariantOf } from '../packages/renderer/src/models/RetailLighting.js';

const SURFACE = 0x08000123;

function factory(): MaterialFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MaterialFactory({ getFileData: () => null } as any, {} as any);
}

/** An object root with two parts, each one mesh on the shared material. */
function object(shared: THREE.Material): { root: THREE.Group; meshes: THREE.Mesh[] } {
  const root = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const part = new THREE.Group();
    part.name = `part_${i}`;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), shared);
    part.add(mesh);
    root.add(part);
    meshes.push(mesh);
  }
  return { root, meshes };
}

function disposed(mat: THREE.Material): () => boolean {
  let n = 0;
  mat.addEventListener('dispose', () => { n++; });
  return () => n > 0;
}

afterEach(() => { delete (globalThis as { __acKeepRestoredCopies?: boolean }).__acKeepRestoredCopies; });

describe('PERF.restored-copy-release — RestoreMaterial drops the part copy', () => {
  it('a fade back to the default puts the shared material back and frees the copies', () => {
    const shared = factory().getMaterial(SURFACE);
    const { root, meshes } = object(shared);
    setObjectTranslucency(root, 0.5);
    const copies = meshes.map((m) => m.material as THREE.Material);
    for (const c of copies) { expect(c).not.toBe(shared); expect(c.opacity).toBeCloseTo(0.5, 6); }
    const freed = copies.map(disposed);
    setObjectTranslucency(root, 0);
    for (const m of meshes) expect(m.material).toBe(shared);
    for (const f of freed) expect(f()).toBe(true);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
    // A second fade copies again (CopyMaterial), and releases again.
    setObjectTranslucency(root, 0.25);
    expect(meshes[0].material).not.toBe(shared);
    setObjectTranslucency(root, 0);
    expect(meshes[0].material).toBe(shared);
  });

  it('identical objects that both faded draw ONE material again (the sort groups them)', () => {
    const shared = factory().getMaterial(SURFACE);
    const a = object(shared);
    const b = object(shared);
    for (const o of [a, b]) { setServerTranslucency(o.root, 0); setObjectTranslucency(o.root, 0.9); setObjectTranslucency(o.root, 0); }
    const mats = new Set([...a.meshes, ...b.meshes].map((m) => m.material));
    expect(mats.size).toBe(1);
  });

  it('a cell-pass (cellobject) copy is released to the shared variant and its own base is freed too', () => {
    const shared = factory().getMaterial(SURFACE);
    const variant = cellObjectVariantOf(shared);
    const { root, meshes } = object(variant);
    setObjectTranslucency(root, 0.5);
    const copy = meshes[0].material as THREE.Material;
    expect(copy).not.toBe(variant);
    setObjectTranslucency(root, 0);
    expect(meshes[0].material).toBe(variant);
    expect(isSharedMaterial(meshes[0].material as THREE.Material)).toBe(true);
  });

  it('a part a PhysicsScript set luminosity on keeps its copy (CurSettingsAreDefault is false)', () => {
    const shared = factory().getMaterial(SURFACE);
    const { root, meshes } = object(shared);
    setPartMaterialValue('luminous', root.children[0], 0.5);
    setObjectTranslucency(root, 0.5);
    setObjectTranslucency(root, 0);
    expect(meshes[0].material).not.toBe(shared); // the scripted part
    expect(meshes[1].material).toBe(shared); // its sibling only faded
  });

  it('a mesh whose material was swapped since (selection lighting, a re-equip) keeps what it has', () => {
    const shared = factory().getMaterial(SURFACE);
    const { root, meshes } = object(shared);
    setObjectTranslucency(root, 0.5);
    const other = new THREE.MeshLambertMaterial();
    meshes[0].material = other;
    setObjectTranslucency(root, 0);
    expect(meshes[0].material).toBe(other);
    expect(releaseRestoredCopies(meshes[0])).toBe(false);
  });

  it('the probe switch keeps the copies (the pre-fix state) and ownedCopyState names both sides', () => {
    (globalThis as { __acKeepRestoredCopies?: boolean }).__acKeepRestoredCopies = true;
    const shared = factory().getMaterial(SURFACE);
    const { root, meshes } = object(shared);
    setObjectTranslucency(root, 0.5);
    setObjectTranslucency(root, 0);
    const copy = meshes[0].material as THREE.Material;
    expect(copy).not.toBe(shared);
    expect(copy.opacity).toBe(1); // restored to the authored look
    expect(ownedCopyState(meshes[0])).toEqual({ originals: shared, copies: copy });
  });
});
