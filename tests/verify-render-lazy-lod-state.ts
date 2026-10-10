/**
 * RENDER.lazy-lod-misses-state — DegradeLod builds a part's degrade level
 * meshes the first time the level is drawn. Retail's levels share the part's
 * surface array and CMaterial (CPhysicsPart::SetGfxObjArray @ 0050e2e0), so
 * a level drawn later must already carry the object's light set (the cell
 * pass's `cellobject` variant, setCellLighting), the part's translucency /
 * no-draw (setObjectTranslucency) and a script's luminosity / diffuse
 * (PhysicsScriptPlayer → setPartMaterialValue). Before the fix the lazily
 * built level came up landscape-lit, opaque and un-glowing.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DegradeLod, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import { applyRetailLighting, retailLightingKindOf, setCellLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { setObjectTranslucency } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { setPartMaterialValue } from '../packages/renderer/src/models/PartMaterialState.js';
import { markSharedMaterial } from '../packages/renderer/src/models/MaterialOwnership.js';

const GFX = 0x01003769;
const L1 = 0x0100376e;
const chain: DegradeChain = {
  infoId: 0x11000000,
  degrades: [
    { gfxObjId: GFX, degradeMode: 1, minDist: 10, idealDist: 25, maxDist: 50 },
    { gfxObjId: L1, degradeMode: 1, minDist: 25, idealDist: 50, maxDist: 1e38 },
  ],
  levelIds: [GFX, L1],
  sortCenter: new THREE.Vector3(),
};

/** A cached-style (shared) lit material, as MaterialFactory hands out. */
const litMaterial = () => markSharedMaterial(applyRetailLighting(new THREE.MeshLambertMaterial(), 'object'));

/** The fake level builder: one fresh mesh per call, like ModelRenderer.createMesh. */
const build = () => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), litMaterial()));
  return g;
};

function setup() {
  const lod = new DegradeLod(null);
  lod.setChain(GFX, chain);
  const scene = new THREE.Scene();
  const obj = new THREE.Group();
  obj.position.set(100, 0, 0); // 100 − 50 = 50 m → level 1
  const part = new THREE.Group();
  part.name = 'part_0';
  part.add(new THREE.Mesh(new THREE.BoxGeometry(), litMaterial()));
  obj.add(part);
  scene.add(obj);
  lod.attachPart(part, GFX, build, obj);
  return { lod, scene, obj, part };
}

function levelOneMaterial(lod: DegradeLod, scene: THREE.Scene, part: THREE.Object3D): THREE.MeshLambertMaterial {
  scene.updateMatrixWorld(true);
  lod.updateParts(new THREE.Vector3());
  expect(part.userData.acDegrade.level).toBe(1);
  const mesh = part.getObjectByName('lod_1')!.children[0] as THREE.Mesh;
  return mesh.material as THREE.MeshLambertMaterial;
}

describe('a lazily built degrade level inherits the part state', () => {
  it('the cell light set of an object already switched into a cell', () => {
    const { lod, scene, obj, part } = setup();
    setCellLighting(obj, true);
    expect(retailLightingKindOf(levelOneMaterial(lod, scene, part))).toBe('cellobject');
  });

  it('the part translucency (blended, no depth write)', () => {
    const { lod, scene, obj, part } = setup();
    setObjectTranslucency(obj, 0.6);
    const m = levelOneMaterial(lod, scene, part);
    expect(m.opacity).toBeCloseTo(0.4, 6);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
  });

  it('a part at translucency 1 stays undrawn', () => {
    const { lod, scene, obj, part } = setup();
    setObjectTranslucency(obj, 1);
    levelOneMaterial(lod, scene, part);
    expect((part.getObjectByName('lod_1')!.children[0] as THREE.Mesh).visible).toBe(false);
  });

  it('a script luminosity and diffuse', () => {
    const { lod, scene, part } = setup();
    setPartMaterialValue('luminous', part, 0.75);
    setPartMaterialValue('diffuse', part, 0.5);
    const m = levelOneMaterial(lod, scene, part);
    expect(m.emissive.r).toBeCloseTo(0.75, 6);
    expect(m.color.r).toBeCloseTo(0.5, 6);
  });

  it('an untouched part builds its level as authored (and never writes the shared material)', () => {
    const { lod, scene, part } = setup();
    const m = levelOneMaterial(lod, scene, part);
    expect(retailLightingKindOf(m)).toBe('object');
    expect(m.opacity).toBe(1);
    expect(m.depthWrite).toBe(true);
  });
});
