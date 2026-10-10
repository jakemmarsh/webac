/**
 * BUG.paperdoll-empty-while-hidden (Jake 2026-10-01: "my character doesnt
 * appear in the paper doll area anymore"). Since DECOMP.login-complete-timing
 * the player stays Hidden (translucency 1 → its part materials not drawn)
 * through the login/portal fade; a paperdoll cloned in that window drew an
 * empty figure. The doll now draws authored copies of the materials.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { authoredMaterialCopy, setPartTranslucency, setServerTranslucency, setObjectTranslucency, morphTranslucencyToOriginal, TRANSLUCENCY_KEY } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { applyRetailLighting, retailLightingKindOf } from '../packages/renderer/src/models/RetailLighting.js';

describe('authoredMaterialCopy', () => {
  it('a part hidden at translucency 1 copies back to its drawn, authored look', () => {
    const mat = new THREE.MeshLambertMaterial({ opacity: 1, transparent: false });
    const part = new THREE.Group(); part.name = 'part_0';
    part.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
    setPartTranslucency(part, 0.5); // records the authored alpha, fades
    setPartTranslucency(part, 1);   // Hidden: not drawn
    const live = (part.children[0] as THREE.Mesh).material as THREE.Material;
    expect(part.children[0].visible).toBe(false); // SWEEP1006 part no-draw: the mesh, not the material
    const copy = authoredMaterialCopy(live);
    expect(copy).not.toBe(live);
    expect(copy.visible).toBe(true);
    expect(copy.opacity).toBe(1);
    expect(copy.transparent).toBe(false);
    expect(part.children[0].visible).toBe(false); // the world object is untouched
  });
  it('the copy keeps the retail-lighting patch (clone() alone drops onBeforeCompile)', () => {
    const lit = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const c = authoredMaterialCopy(lit);
    expect(retailLightingKindOf(c)).toBe('object');
    expect(c.customProgramCacheKey()).toBe(lit.customProgramCacheKey());
    expect(c.onBeforeCompile).toBe(lit.onBeforeCompile);
  });
  it('a never-faded material copies as-is but drawn', () => {
    const m = new THREE.MeshLambertMaterial({ opacity: 0.6, transparent: true });
    m.visible = false;
    const c = authoredMaterialCopy(m);
    expect(c.visible).toBe(true);
    expect(c.opacity).toBe(0.6);
  });
});

/**
 * BUG.examine-copies-live-pose — the examine portrait of a player who was
 * portaling in drew blank: the clone kept the live fade. Retail
 * MorphToExistingObject @ 0050fab0 copies translucencyOriginal only.
 */
describe('morphTranslucencyToOriginal (the examine clone)', () => {
  function figure(mat: THREE.Material): { root: THREE.Group; part: THREE.Group } {
    const root = new THREE.Group();
    const part = new THREE.Group(); part.name = 'part_0';
    part.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
    root.add(part);
    return { root, part };
  }
  const matOf = (part: THREE.Object3D) => (part.children[0] as THREE.Mesh).material as THREE.Material;

  it('a clone of a fully faded (Hidden) player draws whole; the live object is untouched', () => {
    const live = figure(new THREE.MeshLambertMaterial({ opacity: 1, transparent: false }));
    setObjectTranslucency(live.root, 1);
    const clone = live.root.clone(true);
    const copies = morphTranslucencyToOriginal(clone);
    const m = matOf(clone.children[0]);
    expect(copies).toContain(m);
    expect(m.visible).toBe(true);
    expect(m.opacity).toBe(1);
    expect(m.transparent).toBe(false);
    expect(clone.userData[TRANSLUCENCY_KEY]).toBe(0);
    expect(live.part.children[0].visible).toBe(false);
    expect(clone.children[0].children[0].visible).toBe(true); // drawAllParts
  });

  it('a mid-fade clone of a server-translucent creature lands on its original translucency', () => {
    const live = figure(new THREE.MeshLambertMaterial({ opacity: 1, transparent: false }));
    setServerTranslucency(live.root, 0.4);
    setObjectTranslucency(live.root, 0.9); // a fade in progress
    const clone = live.root.clone(true);
    morphTranslucencyToOriginal(clone);
    const m = matOf(clone.children[0]);
    expect(m.opacity).toBeCloseTo(0.6, 5);
    expect(m.transparent).toBe(true);
    expect(clone.userData[TRANSLUCENCY_KEY]).toBe(0.4);
    expect(matOf(live.part).opacity).toBeCloseTo(0.1, 5);
  });
});

/** SWEEP1006 part no-draw — a shared (cached) material is never hidden for another object's sake. */
describe('a part at translucency 1 does not hide a material it shares', () => {
  it('two parts drawing one material: hiding one leaves the other drawn', () => {
    const shared = new THREE.MeshLambertMaterial();
    const a = new THREE.Group(); a.name = 'part_0'; a.add(new THREE.Mesh(new THREE.BufferGeometry(), shared));
    const b = new THREE.Group(); b.name = 'part_0'; b.add(new THREE.Mesh(new THREE.BufferGeometry(), shared));
    setPartTranslucency(a, 1);
    expect(a.children[0].visible).toBe(false);
    expect(b.children[0].visible).toBe(true);
    expect(shared.visible).toBe(true);
    setPartTranslucency(a, 0);
    expect(a.children[0].visible).toBe(true);
  });
});
