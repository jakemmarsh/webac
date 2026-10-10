/**
 * BUG.server-object-manager-mesh-catch-silent — ServerObjectManager.createObject's
 * mesh-build try/catch was completely silent (no logging at all) and wrapped
 * far more surface than "missing DAT assets": objScale/translucency
 * application, tryInitAnimation, and corpse-pose detection all ran inside the
 * same try, so any exception anywhere in that broader surface vanished with
 * zero diagnostics — indistinguishable from a legitimate server-side despawn.
 *
 * Fix (packages/renderer/src/world/ServerObjectManager.ts, createObject):
 *  - The try/catch now wraps ONLY the this.buildMesh(data) call (the actual
 *    DAT-loading step that can legitimately fail on missing assets).
 *  - The catch now logs via console.warn(guid, setupId, err), matching the
 *    ~15 other parse/load catches in the codebase (see main.ts).
 *  - objScale/translucency/tryInitAnimation/corpse-pose/collision-radius all
 *    run outside the try, so a bug in that code now surfaces as a real
 *    exception instead of being silently absorbed.
 *
 * This suite drives the real ServerObjectManager end to end (no source-text
 * pins): a mocked SetupModelRenderer/scene is used to force each side of the
 * behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group } from 'three';

async function makeSOM(setupModelRenderer: Record<string, unknown>, scene: Record<string, unknown>) {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const appearanceManager = { loadPaletteColors: () => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    guid: 0x80007777, name: 'Test Mob', weenieClassId: 300, itemType: 0,
    position: null, setupId: 0x02000abc, motionTableId: 0, iconId: 0x06000001,
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

describe('BUG.server-object-manager-mesh-catch-silent — buildMesh failures', () => {
  let warnSpy: import('vitest').MockInstance;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('logs the error (guid + setupId) instead of swallowing it silently', async () => {
    const boom = new Error('missing DAT asset');
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => { throw boom; },
      loadSetupModel: () => null,
    };
    const scene = { add: vi.fn(), remove: vi.fn() };
    const som = await makeSOM(setupModelRenderer, scene);

    const obj = som.createObject(baseData());

    expect(obj).not.toBeNull();
    expect(obj!.mesh).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = warnSpy.mock.calls[0];
    expect(String(msg)).toContain('0x80007777');
    expect(String(msg)).toContain('0x2000abc');
    expect(err).toBe(boom);
  });

  it('does not add anything to the scene when buildMesh throws', async () => {
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => { throw new Error('bad SetupModel'); },
      loadSetupModel: () => null,
    };
    const scene = { add: vi.fn(), remove: vi.fn() };
    const som = await makeSOM(setupModelRenderer, scene);

    som.createObject(baseData());

    expect(scene.add).not.toHaveBeenCalled();
  });

  it('a buildMesh throw does not prevent the ServerObject itself from being created/tracked', async () => {
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => { throw new Error('bad SetupModel'); },
      loadSetupModel: () => null,
    };
    const scene = { add: vi.fn(), remove: vi.fn() };
    const som = await makeSOM(setupModelRenderer, scene);

    const obj = som.createObject(baseData({ guid: 0x80008888 }));

    expect(obj).not.toBeNull();
    expect(som.getObject(0x80008888)).toBe(obj);
  });
});

describe('BUG.server-object-manager-mesh-catch-silent — errors outside buildMesh are no longer swallowed', () => {
  it('an exception raised after a successful buildMesh() (e.g. scene.add) propagates instead of vanishing', async () => {
    const mesh = new Group();
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => mesh,
      loadSetupModel: () => null,
    };
    const boom = new Error('scene graph corrupted');
    const scene = { add: () => { throw boom; }, remove: vi.fn() };
    const som = await makeSOM(setupModelRenderer, scene);

    expect(() => som.createObject(baseData())).toThrow(boom);
  });
});

describe('BUG.server-object-manager-mesh-catch-silent — happy path unaffected', () => {
  it('a successful buildMesh() still applies scale/translucency and adds to the scene', async () => {
    const mesh = new Group();
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => mesh,
      loadSetupModel: () => null,
    };
    const scene = { add: vi.fn(), remove: vi.fn() };
    const som = await makeSOM(setupModelRenderer, scene);

    const obj = som.createObject(baseData({ objScale: 2.0 }));

    expect(obj).not.toBeNull();
    expect(obj!.mesh).toBe(mesh);
    expect(mesh.scale.x).toBeCloseTo(2.0);
    expect(scene.add).toHaveBeenCalledWith(mesh);
  });
});
