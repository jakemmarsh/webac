/**
 * BUG.physics-script-player-despawn-leak — PhysicsScriptPlayer.stopForAnchor()
 * existed (packages/renderer/src/effects/PhysicsScriptPlayer.ts) but nothing
 * ever called it on object despawn. ServerObjectManager.deleteObject() /
 * forceDelete() disposed a ServerObject's mesh geometry/materials without
 * telling the PhysicsScript runtime, so update() kept running
 * dispatchHook/applyTween against the disposed mesh every frame, and a
 * pending CallPES setTimeout could re-add the stale anchor even after
 * cleanup (ACE PhysicsObj.cs:167-181 Destroy() nulls MovementManager/
 * ScriptManager/Hooks so nothing pending fires against a dead object).
 *
 * Fix: ServerObjectManager gained a new onObjectDeleted callback (mirroring
 * the existing onObjectCreated) invoked just before mesh disposal in both
 * deleteObject() and forceDelete(); main.ts wires it to
 * physicsScriptPlayer.stopForAnchor(obj.mesh). PhysicsScriptPlayer's CallPES
 * handler now tracks its setTimeout handle per-anchor so stopForAnchor()
 * can cancel a still-pending nested-script timer.
 *
 * This suite drives the real shipped ServerObjectManager end to end: create
 * an object with a mesh, register an onObjectDeleted callback, delete the
 * object via both the normal (deleteObject) and force (missile) paths, and
 * confirm the callback fires with the still-populated ServerObject before
 * the mesh reference is nulled out.
 */
import { describe, it, expect } from 'vitest';
import { Group } from 'three';

async function makeSOM() {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const scene = { add: () => {}, remove: () => {} };
  const setupModelRenderer = {
    createSetupMeshWithOverrides: () => new Group(),
    loadSetupModel: () => null,
  };
  const appearanceManager = { loadPaletteColors: () => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    guid: 0x80007777, name: 'Test Ambient Object', weenieClassId: 400, itemType: 0,
    position: null, setupId: 0x02001111, motionTableId: 0, iconId: 0x06000001,
    physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
    soundTableId: 0, objScale: 1.0, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1.0, iconOverlayId: 0, iconUnderlayId: 0,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('BUG.physics-script-player-despawn-leak — ServerObjectManager.onObjectDeleted', () => {
  it('deleteObject() fires onObjectDeleted with the still-meshed object before disposal', async () => {
    const som = await makeSOM();
    const obj = som.createObject(baseData());
    expect(obj).not.toBeNull();
    expect(obj!.mesh).not.toBeNull();

    const deleted: unknown[] = [];
    som.onObjectDeleted = (o) => deleted.push(o.mesh);

    som.deleteObject(obj!.guid);

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toBeNull();
    expect(som.getObject(obj!.guid)).toBeUndefined();
  });

  it('forceDelete() (missile path) also fires onObjectDeleted before mesh disposal', async () => {
    const som = await makeSOM();
    // PhysicsState.Missile bit (0x40) + nonzero velocity registers the
    // object as a projectile, routing deleteObject() through forceDelete().
    const obj = som.createObject(baseData({ guid: 0x80008888, physicsState: 0x40, velocityX: 5 }));
    expect(obj).not.toBeNull();
    expect(obj!.mesh).not.toBeNull();

    const deleted: unknown[] = [];
    som.onObjectDeleted = (o) => deleted.push(o.mesh);

    som.deleteObject(obj!.guid);

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toBeNull();
  });

  it('does not throw when onObjectDeleted is unset (default null)', async () => {
    const som = await makeSOM();
    const obj = som.createObject(baseData({ guid: 0x80009999 }));
    expect(obj).not.toBeNull();
    expect(() => som.deleteObject(obj!.guid)).not.toThrow();
  });

  it('a callback that throws never blocks mesh teardown', async () => {
    const som = await makeSOM();
    const obj = som.createObject(baseData({ guid: 0x8000aaaa }));
    expect(obj).not.toBeNull();
    som.onObjectDeleted = () => { throw new Error('boom'); };

    expect(() => som.deleteObject(obj!.guid)).not.toThrow();
    expect(som.getObject(obj!.guid)).toBeUndefined();
  });
});
