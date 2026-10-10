/**
 * BUG.setstate-sequence-guard-not-enforced — SetState's `stateSequence`
 * (FAITHFUL.338) must gate whether the physics state is actually applied,
 * matching the retail client's stale-packet-drop behavior.
 *
 * ACE ground truth:
 *  - ACE.Server/Network/GameMessages/Messages/GameMessageSetState.cs:8-15 —
 *    the server writes GetNextSequence(SequenceType.ObjectState) on every
 *    SetState send, i.e. it's a monotonic per-connection counter.
 *  - reference/client-eol/decomp/acclient-decompiled.c, SmartBox::DoSetState
 *    @0x004520d0 (lines 85161-85190) — the real client compares the
 *    incoming stateSequence against the object's last-applied one with a
 *    wraparound-aware half-range gate, calling CPhysicsObj::set_state only
 *    when the incoming sequence is strictly newer; otherwise the update is
 *    silently dropped.
 *
 * Before the fix, ServerMessageHandler parsed `stateSequence` off the wire
 * (SetStateData) but nothing ever read it again — main.ts's onSetState
 * handler called setPhysicsState(guid, physicsState) with no sequence
 * argument, and ServerObjectManager.setPhysicsState(guid, state)
 * unconditionally overwrote obj.physicsState on every call, so a
 * stale/out-of-order SetState (e.g. a delayed "Dead" flag arriving just
 * after a fresh post-respawn "alive" one) could clobber newer state.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsState } from '@ac/shared';
import {
  ServerObjectManager,
  isSequenceNewer,
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

describe('isSequenceNewer (FAITHFUL.338 wraparound-aware ushort comparison)', () => {
  it('a strictly larger sequence (no wrap) is newer', () => {
    expect(isSequenceNewer(6, 5)).toBe(true);
  });

  it('an equal or smaller sequence (no wrap) is not newer', () => {
    expect(isSequenceNewer(5, 5)).toBe(false);
    expect(isSequenceNewer(3, 5)).toBe(false);
  });

  it('a small sequence after a wrap past 0xFFFF is newer', () => {
    // lastSeq=0xFFFE, newSeq=1 — 3 steps forward across the 16-bit wrap.
    expect(isSequenceNewer(1, 0xfffe)).toBe(true);
  });

  it('a large sequence is not newer than a small one it wrapped past (backward-looking)', () => {
    // lastSeq=1, newSeq=0xFFFE would be going backward through the wrap.
    expect(isSequenceNewer(0xfffe, 1)).toBe(false);
  });
});

describe('BUG.setstate-sequence-guard-not-enforced', () => {
  it('the first-ever SetState for an object is always applied, even with sequence 0', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);

    som.setPhysicsState(obj.guid, PhysicsState.Static, 0);

    expect(obj.physicsState).toBe(PhysicsState.Static);
    expect(obj.lastStateSequence).toBe(0);
  });

  it('a strictly newer stateSequence is applied and updates lastStateSequence', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, PhysicsState.Static, 5);

    som.setPhysicsState(obj.guid, PhysicsState.Gravity, 6);

    expect(obj.physicsState).toBe(PhysicsState.Gravity);
    expect(obj.lastStateSequence).toBe(6);
  });

  it('a stale (older/equal) stateSequence is dropped — physicsState and lastStateSequence stay unchanged', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, PhysicsState.Static, 5);

    // Simulates a delayed "Dead" flag arriving after a fresher packet.
    som.setPhysicsState(obj.guid, PhysicsState.Hidden, 3);

    expect(obj.physicsState).toBe(PhysicsState.Static);
    expect(obj.lastStateSequence).toBe(5);
  });

  it('a forward wraparound stateSequence is still applied', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, PhysicsState.Static, 0xfffe);

    som.setPhysicsState(obj.guid, PhysicsState.Gravity, 1);

    expect(obj.physicsState).toBe(PhysicsState.Gravity);
    expect(obj.lastStateSequence).toBe(1);
  });

  it('omitting stateSequence always applies unconditionally (legacy call-site compatibility)', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, PhysicsState.Static, 10);

    som.setPhysicsState(obj.guid, PhysicsState.Gravity);

    expect(obj.physicsState).toBe(PhysicsState.Gravity);
    // No sequence was offered, so the tracked last-applied sequence is untouched.
    expect(obj.lastStateSequence).toBe(10);
  });

  it('mesh visibility still reflects an applied (non-stale) Hidden state change', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);

    som.setPhysicsState(obj.guid, PhysicsState.Hidden, 1);

    expect(obj.mesh?.visible).toBe(false);
  });

  it('mesh visibility is untouched by a dropped stale SetState', () => {
    const som = makeSOM();
    const obj = baseObj(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj.mesh = { visible: true, userData: {} } as any;
    som.getAllObjects().set(obj.guid, obj);
    som.setPhysicsState(obj.guid, 0, 5);

    // Stale Hidden flag from before the object's respawn arrives late.
    som.setPhysicsState(obj.guid, PhysicsState.Hidden, 2);

    expect(obj.mesh?.visible).toBe(true);
  });

  it('an unknown guid is a no-op and does not throw', () => {
    const som = makeSOM();
    expect(() => som.setPhysicsState(0x999999, PhysicsState.Static, 1)).not.toThrow();
  });
});
