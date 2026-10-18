/**
 * BUG.physicsstate-nodraw-ignored — PhysicsState.NoDraw (0x20) must hide
 * the mesh exactly like Hidden (0x4000) does.
 *
 * Ground truth:
 *  - ACE.Entity/Enum/PhysicsState.cs:13 — NoDraw = 0x00000020, distinct
 *    from Hidden = 0x00004000 (:22).
 *  - ACE.Server/WorldObjects/Hook.cs:241-258 — UpdateHookVisibility sets
 *    NoDraw=true on empty hooks when HouseHooksVisible is false and
 *    broadcasts the physics state; the object stays alive, the client must
 *    stop drawing it.
 *  - ACE.Server/WorldObjects/Player_Tracking.cs:196-202 — @cloak sets
 *    NoDraw=true and broadcasts.
 *  - ACE.Server/WorldObjects/WorldObject_Networking.cs:615-616 — NoDraw is
 *    merged into the wire physicsState.
 *  - Retail client honors the bit: CPhysicsObj::set_nodraw
 *    (reference/client-eol/symbols/demangled.txt:70648).
 *
 * Before the fix, both mesh-visibility gates in ServerObjectManager
 * (setPhysicsState and updateInteriorVisibility) tested only Hidden, so
 * empty hidden house hooks and cloaked admins rendered fully visible.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsState } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';
import {
  ServerObjectManager,
  PHYSICS_HIDE_MASK,
  type ServerObject,
} from '../packages/renderer/src/world/ServerObjectManager.js';

function baseObj(guid: number): ServerObject {
  return {
    guid, name: '', weenieClassId: 0, setupId: 0, iconId: 0, itemType: 0,
    physicsState: 0, position: null, worldX: 0, worldY: 0, worldZ: 0,
    radarColor: 0, radarBehavior: 0, usable: 0, targetType: 0, useRadius: 0.6, stackSize: 0, mesh: null, basePalette: 0,
    subPalettes: [], textureChanges: [], animPartChanges: [], motionTableId: 0,
    soundTableId: 0, objectDescFlags: 0, wielderId: 0, wieldedLocation: 0,
    parentLocation: 0,
    collisionRadius: 0, blockRadius: 0, collisionHeight: 0,
    cellId: 0, healthCurrent: 0, healthMax: 0, staminaCurrent: 0,
    staminaMax: 0, manaCurrent: 0, manaMax: 0, lastStateSequence: -1, lastVisualDescSeq: -1,
  };
}

function makeSOM(): ServerObjectManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
}

function makeCreateData(guid: number, physicsState: number): CreateObjectData {
  return {
    guid, name: 'Hook', weenieClassId: 2472, itemType: 0x8000 /* Misc */,
    position: { landblock: 0x00000001, x: 0, y: 0, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } /* a world object has a cell (HandleCreateObject enter_world) */, setupId: 0x02000001, motionTableId: 0, iconId: 0,
    physicsState, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
    objScale: 1.0, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1.0,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
  };
}

describe('PHYSICS_HIDE_MASK', () => {
  it('covers exactly Hidden (0x4000) and NoDraw (0x20) per ACE PhysicsState.cs', () => {
    expect(PHYSICS_HIDE_MASK).toBe(0x4000 | 0x20);
    expect(PHYSICS_HIDE_MASK & PhysicsState.Hidden).toBeTruthy();
    expect(PHYSICS_HIDE_MASK & PhysicsState.NoDraw).toBeTruthy();
  });
});

describe('BUG.physicsstate-nodraw-ignored — setPhysicsState', () => {
  it('a SetState carrying NoDraw hides the mesh (empty hidden house hook)', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.setPhysicsState(obj.guid, PhysicsState.Static | PhysicsState.NoDraw, 1);

    expect(obj.mesh?.visible).toBe(false);
  });

  it('clearing NoDraw re-shows the mesh (hook becomes visible again)', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, PhysicsState.Static | PhysicsState.NoDraw, 1);
    expect(obj.mesh?.visible).toBe(false);

    som.setPhysicsState(obj.guid, PhysicsState.Static, 2);

    expect(obj.mesh?.visible).toBe(true);
  });

  it('Hidden alone still hides (pre-existing behavior preserved)', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.setPhysicsState(obj.guid, PhysicsState.Hidden, 1);

    expect(obj.mesh?.visible).toBe(false);
  });
});

describe('BUG.physicsstate-nodraw-ignored — updateInteriorVisibility', () => {
  it('preserves NoDraw hiding for an outdoor (land-cell) object', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    obj.cellId = 0xFFFF; // outdoor — not cell-culled
    obj.physicsState = PhysicsState.NoDraw;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.updateInteriorVisibility(() => undefined);

    expect(obj.mesh?.visible).toBe(false);
  });

  it('preserves NoDraw hiding for an object in a drawn interior cell (house hook case)', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    obj.cellId = 0x0123; // interior — its cell is drawn, so not culled
    obj.objCellId = 0xA9B40123;
    obj.physicsState = PhysicsState.NoDraw;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.updateInteriorVisibility(() => true);

    expect(obj.mesh?.visible).toBe(false);
  });

  it('still shows a clean (no hide bits) object', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    obj.cellId = 0xFFFF;
    obj.physicsState = PhysicsState.Static | PhysicsState.Gravity;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: false, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.updateInteriorVisibility(() => undefined);

    expect(obj.mesh?.visible).toBe(true);
  });
});

describe('BUG.physicsstate-nodraw-ignored — creation-time visibility (no one-frame flash)', () => {
  function fakeMesh() {
    return {
      visible: true,
      name: '',
      position: { set: () => {}, copy: () => {}, clone: () => ({}) },
      quaternion: { set: () => {}, copy: () => {} },
      scale: { setScalar: () => {}, x: 1 },
      traverse: () => {},
    };
  }

  it('an object arriving with NoDraw already set in CreateObject builds its mesh invisible', () => {
    const som = makeSOM();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();

    const obj = som.createObject(makeCreateData(0x80000001, PhysicsState.Static | PhysicsState.NoDraw));

    expect(obj?.mesh).toBeTruthy();
    expect(obj?.mesh?.visible).toBe(false);
  });

  it('an object arriving with Hidden already set builds its mesh invisible', () => {
    const som = makeSOM();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();

    const obj = som.createObject(makeCreateData(0x80000002, PhysicsState.Hidden));

    expect(obj?.mesh?.visible).toBe(false);
  });

  it('a normal object builds its mesh visible', () => {
    const som = makeSOM();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();

    const obj = som.createObject(makeCreateData(0x80000003, PhysicsState.Static | PhysicsState.Gravity));

    expect(obj?.mesh?.visible).toBe(true);
  });
});
