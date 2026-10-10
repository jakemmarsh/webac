/**
 * BUG.objdescevent-sequence-not-enforced — ObjDescEvent's `visualDescSequence`
 * (ACE SequenceManager.cs registers ObjectVisualDesc as a UShortSequence,
 * same family as ObjectState/ObjectInstance/ObjectPosition) must gate
 * whether an appearance update is actually applied, matching the
 * setPhysicsState/stateSequence guard fixed by
 * BUG.setstate-sequence-guard-not-enforced.
 *
 * ACE ground truth:
 *  - ACE.Server/WorldObjects/WorldObject_Networking.cs:48-54 —
 *    SerializeUpdateModelData writes GetCurrentSequence(ObjectInstance) then
 *    GetNextSequence(ObjectVisualDesc) after SerializeModelData.
 *  - ACE.Server/Network/Sequence/SequenceManager.cs:160-181 — ObjectVisualDesc
 *    is registered as a UShortSequence, exactly like ObjectState.
 *
 * Before the fix, ServerMessageHandler parsed `visualDescSequence` off the
 * wire (ObjDescEventData) but nothing ever read it again —
 * ServerObjectManager.updateAppearance(data) unconditionally overwrote
 * basePalette/subPalettes/textureChanges/animPartChanges on every call, so
 * an appearance change arriving out of server-send order (e.g. an unwield
 * undoing a wield's texture swap) could clobber a newer appearance with a
 * stale one.
 */
import { describe, it, expect } from 'vitest';
import {
  ServerObjectManager,
  isSequenceNewer,
  type ServerObject,
} from '../packages/renderer/src/world/ServerObjectManager.js';
import type { ObjDescEventData } from '../packages/renderer/src/network/ServerMessageHandler.js';

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

function objDesc(guid: number, visualDescSequence: number, overrides: Partial<ObjDescEventData> = {}): ObjDescEventData {
  return {
    guid, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    instanceSequence: 0, visualDescSequence, ...overrides,
  };
}

describe('BUG.objdescevent-sequence-not-enforced', () => {
  it('the first-ever ObjDescEvent for an object is always applied, even with sequence 0', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);

    som.updateAppearance(objDesc(obj.guid, 0, { basePalette: 0x1000 }));

    expect(obj.basePalette).toBe(0x1000);
    expect(obj.lastVisualDescSeq).toBe(0);
  });

  it('a strictly newer visualDescSequence is applied and updates lastVisualDescSeq', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.updateAppearance(objDesc(obj.guid, 5, { basePalette: 0x1000 }));

    som.updateAppearance(objDesc(obj.guid, 6, { basePalette: 0x2000 }));

    expect(obj.basePalette).toBe(0x2000);
    expect(obj.lastVisualDescSeq).toBe(6);
  });

  it('a stale (older/equal) visualDescSequence is dropped — appearance fields and lastVisualDescSeq stay unchanged', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    // A wield's texture swap arrives first.
    som.updateAppearance(objDesc(obj.guid, 5, {
      textureChanges: [{ partIndex: 0, oldTexture: 0x100, newTexture: 0x200 }],
    }));

    // A delayed/out-of-order duplicate of an earlier (already-superseded)
    // unwield event arrives after it — must not revert the wield's texture.
    som.updateAppearance(objDesc(obj.guid, 3, {
      textureChanges: [{ partIndex: 0, oldTexture: 0x200, newTexture: 0x100 }],
    }));

    expect(obj.textureChanges).toEqual([{ partIndex: 0, oldTexture: 0x100, newTexture: 0x200 }]);
    expect(obj.lastVisualDescSeq).toBe(5);
  });

  it('a forward wraparound visualDescSequence is still applied', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.updateAppearance(objDesc(obj.guid, 0xfffe, { basePalette: 0x1000 }));

    som.updateAppearance(objDesc(obj.guid, 1, { basePalette: 0x2000 }));

    expect(obj.basePalette).toBe(0x2000);
    expect(obj.lastVisualDescSeq).toBe(1);
  });

  it('an unknown guid is a no-op and does not throw', () => {
    const som = makeSOM();
    expect(() => som.updateAppearance(objDesc(0x999999, 1))).not.toThrow();
  });

  it('shares the same wraparound-aware comparison as the SetState guard (isSequenceNewer)', () => {
    // Both BUG.setstate-sequence-guard-not-enforced and this fix are the
    // same defect class per ACE's SequenceManager.cs (ObjectState and
    // ObjectVisualDesc are both UShortSequence) — confirm updateAppearance
    // doesn't reimplement its own (possibly divergent) comparison.
    expect(isSequenceNewer(6, 5)).toBe(true);
    expect(isSequenceNewer(5, 5)).toBe(false);
    expect(isSequenceNewer(1, 0xfffe)).toBe(true);
  });
});
