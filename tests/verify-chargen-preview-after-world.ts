/**
 * BUG.chargen-preview-after-sweep (live, 2026-10-16): create a character,
 * play more than a minute, log out, Create Character again → the Summary /
 * Appearance 3D view shows only the head.
 *
 * Cause: the per-frame `DegradeLod.updateParts(viewer)` (main.ts) walks every
 * registered part in ANY THREE.Scene, the UI viewports' own CreatureMode
 * scenes included, and degrades it by its distance to the WORLD camera.
 * Before the first world session that camera sits near the origin, where the
 * chargen model is; after one it stays where the player was (Holtburg is tens
 * of kilometres out), so every body part with a DIDDegrade dropped to its
 * last level, INVALID (draw nothing). The head (a hair-style GfxObj with no
 * DIDDegrade) stayed. The resource sweep the lead saw in the log runs on the
 * same world frames, but it only evicts what it disposes; the rebuilt model
 * gets fresh materials, which this file also pins.
 *
 * Real CharacterModelBuilder → SetupModelRenderer → ModelRenderer →
 * MaterialFactory / TextureManager / DegradeLod over the EoL portal.dat, the
 * real buildCreatureModeScene and the real collectLiveResources sweep.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { Gender, Heritage } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { ModelRenderer } from '../packages/renderer/src/models/ModelRenderer.js';
import { SetupModelRenderer } from '../packages/renderer/src/models/SetupModelRenderer.js';
import { ClothingRenderer } from '../packages/renderer/src/models/ClothingRenderer.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';
import { DegradeLod } from '../packages/renderer/src/models/DegradeLod.js';
import { collectLiveResources } from '../packages/renderer/src/models/ResourceSweep.js';
import { buildCreatureModeScene } from '../packages/renderer/src/ui/CreatureViewRender.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const hasPortal = existsSync(DAT_PATHS.portal);

/** Meshes drawn: visible themselves and up every ancestor to `root`. */
function drawnMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}

const materialsOf = (meshes: THREE.Mesh[]): THREE.Material[] => meshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]));

describe('DegradeLod and a viewport scene (no DAT)', () => {
  it('a part in another scene is held at level 0 when the world scene is named; a world part still degrades', () => {
    // A two-level chain: level 0 to 10 m, then INVALID.
    const lod = new DegradeLod(null);
    const chain = {
      infoId: 0x11000001, levelIds: [0x01000001, 0], sortCenter: new THREE.Vector3(),
      degrades: [{ gfxobjId: 0x01000001, degradeMode: 1, minDist: 0, idealDist: 10, maxDist: 10 }, { gfxobjId: 0, degradeMode: 1, minDist: 0, idealDist: 3.4e38, maxDist: 3.4e38 }],
    } as any;
    lod.setChain(0x01000001, chain);
    const mk = (): THREE.Object3D => {
      const setup = new THREE.Group();
      const part = new THREE.Group();
      part.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      setup.add(part);
      lod.attachPart(part, 0x01000001, () => null);
      return setup;
    };
    const world = new THREE.Scene();
    const view = new THREE.Scene();
    const inWorld = mk(); world.add(inWorld);
    const inView = mk(); view.add(inView);
    const far = new THREE.Vector3(40000, 0, 40000);
    lod.updateParts(far, world);
    expect(drawnMeshes(inWorld)).toHaveLength(0); // the world object past its last level: nothing
    expect(drawnMeshes(inView)).toHaveLength(1); // the viewport's: level 0
  });
});

describe.skipIf(!hasPortal)('the chargen model after a world session (real builder, LOD and sweep)', () => {
  let tm: TextureManager; let mf: MaterialFactory; let lod: DegradeLod; let builder: CharacterModelBuilder;
  let appearance: AppearanceInfo;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    tm = new TextureManager(db);
    mf = new MaterialFactory(db, tm);
    const mr = new ModelRenderer(db, mf);
    const smr = new SetupModelRenderer(db, mr);
    lod = new DegradeLod(db);
    smr.setDegradeLod(lod);
    const clothing = new ClothingRenderer(db, smr, mr, mf);
    builder = new CharacterModelBuilder(db, smr, clothing, new AppearanceManager(db));
    appearance = {
      hairStyle: 1, hairColor: 0, eyesStrip: 0, eyeColor: 0, skinColor: 0, noseStyle: 0, mouthStyle: 0,
      headgearStyle: -1, headgearColor: 0, shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0,
      footwearStyle: 0, footwearColor: 0, skinHue: 0.5, hairHue: 0.5, headgearHue: 0, shirtHue: 0, pantsHue: 0, footwearHue: 0,
    } as AppearanceInfo;
  });

  function chargenView(): { scene: THREE.Scene; model: THREE.Group } {
    const model = builder.buildCharacterModel(Heritage.Aluvian, Gender.Male, appearance)!;
    expect(model).toBeTruthy();
    const scene = buildCreatureModeScene(model, [0.3, 1.9, 0.65], 2.0);
    scene.updateMatrixWorld(true);
    return { scene, model };
  }

  it('the body parts carry degrade chains (what made them vanish)', () => {
    const { model } = chargenView();
    const degraded = model.children.filter((p) => p.userData.acDegrade);
    expect(degraded.length).toBeGreaterThan(5);
  });

  it('the world camera hundreds of metres away no longer degrades the viewport model: every part still draws', () => {
    const { model } = chargenView();
    const before = drawnMeshes(model).length;
    expect(before).toBeGreaterThan(10);
    const world = new THREE.Scene();
    // Holtburg-ish: the camera after a session, far from the views' origin.
    lod.updateParts(new THREE.Vector3(42000, 60, 33000), world);
    expect(drawnMeshes(model).length).toBe(before);
    // The pre-fix call (no world scene): every scene counted, and the body went.
    lod.updateParts(new THREE.Vector3(42000, 60, 33000));
    expect(drawnMeshes(model).length).toBeLessThan(before);
    // Naming the world scene again brings the parts back to level 0.
    lod.updateParts(new THREE.Vector3(42000, 60, 33000), world);
    expect(drawnMeshes(model).length).toBe(before);
  });

  it('the in-world resource sweep (world hidden: an empty world scene) leaves the next chargen build with live materials and textures', () => {
    const first = chargenView();
    const disposedMats = new Set<THREE.Material>();
    const disposedTex = new Set<THREE.Texture>();
    for (const m of materialsOf(drawnMeshes(first.model))) {
      m.addEventListener('dispose', () => disposedMats.add(m));
      for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).addEventListener('dispose', () => disposedTex.add(v as THREE.Texture));
    }
    const live = collectLiveResources([new THREE.Scene()]);
    const released = mf.sweep(live.materials) + tm.sweep(live.textures);
    // The sweep does release the first build's textures (its composite-palette ones): nothing in the world uses them.
    expect(released).toBeGreaterThan(0);
    expect(disposedTex.size).toBeGreaterThan(0);
    const second = chargenView();
    lod.updateParts(new THREE.Vector3(42000, 60, 33000), new THREE.Scene());
    const meshes = drawnMeshes(second.model);
    expect(meshes.length).toBe(drawnMeshes(first.model).length);
    for (const m of materialsOf(meshes)) {
      expect(disposedMats.has(m)).toBe(false);
      for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) expect(disposedTex.has(v as THREE.Texture)).toBe(false);
    }
  });
});
