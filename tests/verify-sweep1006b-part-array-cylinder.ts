/**
 * SWEEP1006B.world-objects.remote-objects-radius-height-are — every server
 * object with a part array has the bounding cylinder retail's MoveToObject,
 * melee distance and object range checks measure from, not only creatures,
 * and it scales with ObjScale.
 *
 * Retail (acclient-decompiled.annotated.c):
 *  - MovementManager::unpack_movement @ 00524440 case 6 (MoveToObject) calls
 *    CPhysicsObj::MoveToObject @ 00512860 for ANY known object; that reads
 *    CPartArray::GetHeight / GetRadius when part_array != 0 (no ItemType test).
 *  - CPartArray::GetRadius @ 005180a0 = setup->radius * scale.z;
 *    CPartArray::GetHeight @ 005180b0 = setup->height * scale.z.
 *  - CPhysicsObj::GetRadius / GetHeight @ 0050e9c0 / 0050e9e0 return 0 with no
 *    part array — no 0.3 fallback anywhere.
 *  - CPhysicsObj::SetScaleInternal @ 00511bb0 feeds CPartArray.scale.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { partArrayCylinder } from '../packages/renderer/src/world/CreatureCollision.js';
import { MoveToManager, MoveFlag, defaultMovementParams, type MoveToHost } from '../packages/renderer/src/controllers/MoveToManager.js';

const CHEST_SETUP = { radius: 0.8, height: 1.1, cylSpheres: [], spheres: [{ radius: 0.7 }] };
const DRUDGE_SETUP = { radius: 0.62, height: 1.53, cylSpheres: [], spheres: [{ radius: 0.436 }] };

function som(setups: Record<number, unknown>, opts: { throwOnLoad?: boolean } = {}) {
  const smr = {
    createSetupMeshWithOverrides: () => new THREE.Group(),
    loadSetupModel: (id: number) => {
      if (opts.throwOnLoad) throw new Error('setup unavailable');
      return setups[id] ?? null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
}

const data = (guid: number, over: Record<string, unknown> = {}) => ({
  guid, name: 'x', weenieClassId: 1, itemType: 0x200 /* Container */,
  position: { landblock: 0xA9B40017, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 }, setupId: 0x02000001, motionTableId: 0, iconId: 0,
  physicsState: 0x408, objectDescFlags: 0, radarColor: 0, radarBehavior: 0, basePalette: 0, subPalettes: [],
  textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
  validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0,
  velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
  iconOverlayId: 0, iconUnderlayId: 0, ...over,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

describe('partArrayCylinder (CPartArray::GetRadius / GetHeight)', () => {
  it('Setup radius/height × scale; no Setup → 0', () => {
    expect(partArrayCylinder({ radius: 0.8, height: 1.1 }, 1)).toEqual({ radius: 0.8, height: 1.1 });
    const s = partArrayCylinder({ radius: 0.62, height: 1.53 }, 1.5);
    expect(s.radius).toBeCloseTo(0.93, 6);
    expect(s.height).toBeCloseTo(2.295, 6);
    expect(partArrayCylinder(null, 2)).toEqual({ radius: 0, height: 0 });
  });
});

describe('ServerObjectManager: every part-array object gets the scaled cylinder', () => {
  it('a chest (non-creature) reports its Setup radius/height to MoveTo, not 0', () => {
    const m = som({ 0x02000001: CHEST_SETUP });
    const chest = m.createObject(data(0x7a000001))!;
    expect(chest.collisionRadius).toBeCloseTo(0.8, 6);
    expect(chest.collisionHeight).toBeCloseTo(1.1, 6);
    expect(chest.blockRadius).toBe(0); // only creatures get the cylsphere blocking radius
    const t = m.targetInfo(0x7a000001)!;
    expect(t.radius).toBeCloseTo(0.8, 6);
    expect(t.height).toBeCloseTo(1.1, 6);
  });

  it('a creature at ObjScale 1.5 reports radius/height × 1.5 (block radius scaled too)', () => {
    const m = som({ 0x02000001: DRUDGE_SETUP });
    const d = m.createObject(data(0x80000001, { itemType: 0x10, objScale: 1.5 }))!;
    const t = m.targetInfo(0x80000001)!;
    expect(t.radius).toBeCloseTo(0.62 * 1.5, 6);
    expect(t.height).toBeCloseTo(1.53 * 1.5, 6);
    expect(d.blockRadius).toBeCloseTo(0.436 * 1.5, 6);
  });

  it('a Setup that will not load gives 0, not the invented 0.3', () => {
    for (const throwOnLoad of [false, true]) {
      const m = som({}, { throwOnLoad });
      const d = m.createObject(data(0x80000002, { itemType: 0x10 }))!;
      expect(d.mesh).toBeTruthy();
      expect(d.collisionRadius).toBe(0);
      expect(d.collisionHeight).toBe(0);
      expect(d.blockRadius).toBe(0);
    }
  });

  it('a live ObjScale change rescales the cylinder with the mesh (SetScaleInternal)', () => {
    const m = som({ 0x02000001: DRUDGE_SETUP });
    const d = m.createObject(data(0x80000003, { itemType: 0x10 }))!;
    m.setObjectScale(0x80000003, 2);
    expect(d.mesh!.scale.x).toBe(2);
    expect(d.collisionRadius).toBeCloseTo(1.24, 6);
    expect(d.collisionHeight).toBeCloseTo(3.06, 6);
    expect(d.blockRadius).toBeCloseTo(0.872, 6);
    m.setObjectScale(0x80000003, Number.NaN); // ignored
    expect(d.collisionRadius).toBeCloseTo(1.24, 6);
  });

  it('a MoveToObject toward the chest measures from its edge: centre distance − (player r + chest r)', () => {
    const m = som({ 0x02000001: CHEST_SETUP });
    m.createObject(data(0x7a000004));
    const target = m.targetInfo(0x7a000004)!;
    const me = { x: target.pos.x - 5, y: target.pos.y, z: target.pos.z };
    const host: MoveToHost = {
      position: () => me, heading: () => 90, setHeading: () => {}, radius: () => 0.48, height: () => 1.8,
      doMotion: () => 0, stopMotion: () => 0, stopCompletely: () => {}, motionsPending: () => false,
      hasContact: () => true, target: (id) => m.targetInfo(id), stickTo: () => {}, onComplete: () => {}, now: () => 0,
    };
    const mgr = new MoveToManager(host);
    mgr.moveToObject(0x7a000004, { ...defaultMovementParams(), flags: defaultMovementParams().flags | MoveFlag.UseSpheres });
    expect(mgr.getCurrentDistance()).toBeCloseTo(5 - (0.48 + 0.8), 6);
  });
});
