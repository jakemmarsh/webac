/**
 * REND.shared-cached-material-disposed-faded — MaterialFactory hands ONE
 * cached material per (surface, palette) to every mesh drawing that surface
 * (retail: a GfxObj's CSurface is shared by every CPhysicsPart; a part only
 * gets its own through CPhysicsPart::CopyMaterial @ 0050d630). So:
 *  - no dispose path may dispose a shared material (object delete / force
 *    delete / appearance rebuild / landblock unload / terrain attachments);
 *  - per-object writes (death fade, translucency, hit flash, projectile glow,
 *    PhysicsScript tweens) copy the shared material first (clone-on-first-
 *    mutate), and the copies are freed with the object;
 *  - the cache never hands out a disposed material.
 * Drives the real MaterialFactory / MaterialOwnership / ServerObjectManager /
 * PhysicsScriptPlayer / TerrainRenderer code.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import {
  isSharedMaterial, disposeObjectTree, ownMeshMaterials, releaseOwnedCopies, disposeOwnedMaterials,
} from '../packages/renderer/src/models/MaterialOwnership.js';
import { cellObjectVariantOf } from '../packages/renderer/src/models/RetailLighting.js';
import { applyTranslucency, ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';

const SURFACE = 0x08000123;

/** A factory whose portal DB has no such surface: getMaterial caches its (shared) fallback. */
function factory(): MaterialFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MaterialFactory({ getFileData: () => null } as any, {} as any);
}

function meshWith(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BufferGeometry(), mat);
}

function disposeSpy(mat: THREE.Material): { count: number } {
  const c = { count: 0 };
  mat.addEventListener('dispose', () => { c.count++; });
  return c;
}

describe('MaterialFactory cache — shared materials are registered and never handed out disposed', () => {
  it('two getMaterial calls share one instance, registered as shared', () => {
    const mf = factory();
    const a = mf.getMaterial(SURFACE);
    const b = mf.getMaterial(SURFACE);
    expect(a).toBe(b);
    expect(isSharedMaterial(a)).toBe(true);
  });

  it('a disposed cached material is evicted — the next request builds a fresh one', () => {
    const mf = factory();
    const a = mf.getMaterial(SURFACE);
    a.dispose();
    const b = mf.getMaterial(SURFACE);
    expect(b).not.toBe(a);
    expect(isSharedMaterial(b)).toBe(true);
    expect(mf.getMaterial(SURFACE)).toBe(b);
  });

  it('override materials (palette/texture swaps) are NOT shared', () => {
    const mf = factory();
    const own = mf.getMaterial(SURFACE, undefined, undefined, [0xff0000]);
    expect(isSharedMaterial(own)).toBe(false);
  });

  it('the cached cellobject variant of a shared material counts as shared', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const variant = cellObjectVariantOf(shared);
    expect(variant).not.toBe(shared);
    expect(isSharedMaterial(variant)).toBe(true);
  });
});

describe('disposeObjectTree — one ownership rule for every dispose path', () => {
  it('disposing one of two objects sharing a cached material leaves the other untouched', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const spy = disposeSpy(shared);
    const a = meshWith(shared);
    const b = meshWith(shared);
    const own = new THREE.MeshBasicMaterial();
    const ownSpy = disposeSpy(own);
    const c = meshWith(own);
    const root = new THREE.Group().add(a, c);
    disposeObjectTree(root);
    expect(spy.count).toBe(0);
    expect(ownSpy.count).toBe(1);
    expect(b.material).toBe(shared);
    expect(mf.getMaterial(SURFACE)).toBe(shared);
  });

  it('instancer output (sharedResources) frees only its instance buffer', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const geom = new THREE.BufferGeometry();
    const im = new THREE.InstancedMesh(geom, shared, 2);
    im.userData.sharedResources = true;
    const geomSpy = vi.spyOn(geom, 'dispose');
    const imSpy = vi.spyOn(im, 'dispose');
    disposeObjectTree(im);
    expect(imSpy).toHaveBeenCalled();
    expect(geomSpy).not.toHaveBeenCalled();
  });

  it('TerrainRenderer.disposeAttachment skips a shared cached material', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const spy = disposeSpy(shared);
    TerrainRenderer.disposeAttachment(meshWith(shared));
    expect(spy.count).toBe(0);
  });

  it('an owned cellobject variant releases its owned base too', () => {
    const base = new THREE.MeshLambertMaterial();
    const variant = cellObjectVariantOf(base);
    const baseSpy = disposeSpy(base);
    const varSpy = disposeSpy(variant);
    disposeOwnedMaterials(variant);
    expect(varSpy.count).toBe(1);
    expect(baseSpy.count).toBe(1);
  });
});

describe('clone-on-first-mutate', () => {
  it('ownMeshMaterials swaps a shared material for a private copy once; owned ones are kept', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const m = meshWith(shared);
    const [copy] = ownMeshMaterials(m);
    expect(copy).not.toBe(shared);
    expect(m.material).toBe(copy);
    expect(isSharedMaterial(copy)).toBe(false);
    expect(ownMeshMaterials(m)[0]).toBe(copy); // second call: already owned
  });

  it('releaseOwnedCopies restores the shared original and frees the copy', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const m = meshWith(shared);
    const [copy] = ownMeshMaterials(m);
    const spy = disposeSpy(copy);
    releaseOwnedCopies(m);
    expect(m.material).toBe(shared);
    expect(spy.count).toBe(1);
  });

  it('applyTranslucency on one object never fades the other object sharing the surface', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const a = meshWith(shared);
    const b = meshWith(shared);
    applyTranslucency(a, 0.75);
    expect((a.material as THREE.Material).opacity).toBeCloseTo(0.25, 6);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
    expect(b.material).toBe(shared);
  });

  it('PhysicsScriptPlayer luminous / diffuse / transparent tweens write the anchor\'s own copy', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE) as THREE.MeshLambertMaterial;
    const anchor = new THREE.Group().add(meshWith(shared));
    const other = meshWith(shared);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = new PhysicsScriptPlayer({ getListenerPos: () => ({ x: 0, y: 0, z: 0 }) } as any);
    // Instant ramps (time 0 < F_EPSILON) apply their end values at once.
    player.executeHook({ hookType: AnimationHookType.Luminous, direction: 0, start: 0, end: 0.8, time: 0 } as never, anchor);
    player.executeHook({ hookType: AnimationHookType.Diffuse, direction: 0, start: 0, end: 0.3, time: 0 } as never, anchor);
    player.executeHook({ hookType: AnimationHookType.Transparent, direction: 0, start: 0, end: 0.5, time: 0 } as never, anchor);
    const own = (anchor.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
    expect(own).not.toBe(shared);
    expect(own.opacity).toBe(0.5);
    expect(own.color.r).toBeCloseTo(0.3, 6);
    expect(shared.opacity).toBe(1);
    expect(shared.color.r).toBe(1);
    expect(own.emissive.r).toBeCloseTo(0.8, 6);
    expect(shared.emissive.r).toBe(0);
    expect(other.material).toBe(shared);
  });
});

describe('ServerObjectManager — deleting a dying creature with shared materials', () => {
  const baseData = (guid: number) => ({
    guid, name: 'Drudge', weenieClassId: 1, itemType: 0, position: null, setupId: 0x02000001,
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  function somSharing(shared: THREE.Material) {
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => new THREE.Group().add(meshWith(shared)),
      loadSetupModel: () => null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ServerObjectManager(setupModelRenderer as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
  }

  it('BUG.double-corpse — deleting a dying creature removes it at once (no linger beside the corpse object) and leaves the shared material alone', () => {
    const mf = factory();
    const shared = mf.getMaterial(SURFACE);
    const spy = disposeSpy(shared);
    const som = somSharing(shared);
    const scene = (som as any).scene as THREE.Scene;
    const dying = som.createObject(baseData(1))!;
    const survivor = som.createObject(baseData(2))!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).dyingObjects.add(1);
    expect(som.isDying(1)).toBe(true);
    som.deleteObject(1); // ACE Creature_Death.cs: CreateCorpse + Destroy in one action
    expect(som.getObject(1)).toBeUndefined();
    expect(som.isDying(1)).toBe(false);
    expect(scene.children).not.toContain(dying.mesh ?? undefined);
    som.updateAnimations(5.0); // nothing left to fade back in or remove later
    expect(som.getObject(1)).toBeUndefined();
    expect(spy.count).toBe(0);
    expect(shared.opacity).toBe(1);
    expect((survivor.mesh!.children[0] as THREE.Mesh).material).toBe(shared);
    expect(mf.getMaterial(SURFACE)).toBe(shared);
  });

  it('BUG.invented-portal-burst-and-spell-effects — the invented hit flash is gone (no per-hit material write at all)', () => {
    const mf = factory();
    const som = somSharing(mf.getMaterial(SURFACE));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((som as any).flashHitIndicator).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((som as any).playHitRecoil).toBeUndefined();
  });
});
