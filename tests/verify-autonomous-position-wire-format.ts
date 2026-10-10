/**
 * BUG.autonomous-position-wrong-wire-format — AutonomousPosition (server
 * broadcast of a peer's continuous-motion position, opcode 0xF753) was
 * parsed with UpdatePosition's PositionPack format, which it does not use.
 *
 * `GameMessageAutonomousPosition.cs`:
 *   Writer.WriteGuid(p.Guid);
 *   p.Location.Serialize(Writer, true, false);   // writeQuaternion=true, writeLandblock=false
 *   Writer.Write(...ObjectInstance...);           // ushort
 *   Writer.Write(...ObjectServerControl...);      // ushort
 *   Writer.Write(...ObjectTeleport...);            // ushort
 *   Writer.Write(...ObjectForcePosition...);       // ushort
 *   Writer.Write(1u);                              // contact
 *
 * `Position.Serialize(w, writeQuaternion=true, writeLandblock=false)`
 * (`reference/ACE/Source/ACE.Entity/Position.cs:361-377`) writes, with NO
 * flags field and NO landblock field at all: PositionX/Y/Z (3×float32) then
 * unconditionally RotationW/X/Y/Z (4×float32).
 *
 * This is a completely different shape from `UpdatePosition`'s PositionPack
 * (`PositionPack.cs`), which leads with a `flags` u32, a `landblock` u32,
 * then flag-gated rotation components. Pre-fix, `handleUpdatePosition` was
 * reused for both opcodes: it misread PositionX's float bits as `flags`,
 * PositionY's as `landblock`, and desynced every field after — including
 * driving out-of-range conditional reads with garbage flag bits.
 *
 * The 4 trailing sequences also differ: AutonomousPosition uses
 * ObjectServerControl where UpdatePosition uses ObjectPosition
 * (`SequenceManager.cs`'s factory confirms both are `UShortSequence`, so
 * the WIDTH pre-fix was accidentally correct — 4×u16 — only the semantic
 * labeling and the missing flags/landblock/trailing-contact fields were
 * wrong), and AutonomousPosition appends a trailing `contact` u32 that
 * UpdatePosition never writes.
 *
 * Two behavioral halves, driving the real shipped code:
 *  1. `ServerMessageHandler.handleMessage` with a constructed
 *     AutonomousPosition payload — proves the parser reads the confirmed
 *     field layout, not PositionPack's.
 *  2. `ServerObjectManager.updateAutonomousPosition` — proves the consumer
 *     correctly reconstructs the peer's landblock (absent from the wire)
 *     from its last known tracked world position, rather than requiring a
 *     landblock the message never carries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { GameMessageOpcode } from '@ac/network';
import type { CreateObjectData } from '@ac/network';

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}
function f32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, v, true);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('AutonomousPosition wire parse (BUG.autonomous-position-wrong-wire-format)', () => {
  let handler: ServerMessageHandler;
  let calls: any[];

  beforeEach(() => {
    calls = [];
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onAutonomousPosition: d => calls.push(d),
    });
  });

  it('reads guid + x/y/z + full wxyz quaternion + 4 sequences + contact, with no flags/landblock', () => {
    const payload = concat(
      u32(0x50001234),          // guid
      f32(12.5), f32(-3.25), f32(4.0),   // x, y, z
      f32(0.75), f32(0), f32(0), f32(0.25), // rw, rx, ry, rz
      u16(11), u16(22), u16(33), u16(44), // instance, serverControl, teleport, forcePosition
      u32(1),                    // contact
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.AutonomousPosition,
      payload,
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      guid: 0x50001234,
      x: 12.5, y: -3.25, z: 4.0,
      rw: 0.75, rx: 0, ry: 0, rz: 0.25,
      instanceSequence: 11,
      serverControlSequence: 22,
      teleportSequence: 33,
      forcePositionSequence: 44,
      contact: 1,
    });
    // No landblock/flags field exists on this shape at all.
    expect('landblock' in calls[0]).toBe(false);
    expect('flags' in calls[0]).toBe(false);
  });

  it('a second concatenated message parses cleanly (proves byte-length is exact, no drift)', () => {
    const one = concat(
      u32(0x1), f32(1), f32(2), f32(3), f32(1), f32(0), f32(0), f32(0),
      u16(1), u16(2), u16(3), u16(4), u32(1),
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.AutonomousPosition, payload: one } as any);

    const two = concat(
      u32(0x2), f32(9), f32(8), f32(7), f32(0), f32(1), f32(0), f32(0),
      u16(5), u16(6), u16(7), u16(8), u32(0),
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.AutonomousPosition, payload: two } as any);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ guid: 0x2, x: 9, y: 8, z: 7, contact: 0 });
  });
});

describe('ServerObjectManager.updateAutonomousPosition (BUG.autonomous-position-wrong-wire-format)', () => {
  async function makeSOM() {
    const scene = { add: () => {}, remove: () => {} };
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => new THREE.Group(),
      loadSetupModel: () => null,
    };
    const appearanceManager = { loadPaletteColors: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
  }

  function baseCreateObjectData(overrides: Partial<CreateObjectData> = {}): CreateObjectData {
    return {
      guid: 0x80009999,
      name: 'Test Peer',
      weenieClassId: 1,
      itemType: 0,
      position: null,
      setupId: 0,
      motionTableId: 0,
      iconId: 0,
      physicsState: 0,
      objectDescFlags: 0,
      radarColor: 0,
      radarBehavior: 0,
      basePalette: 0,
      subPalettes: [],
      textureChanges: [],
      animPartChanges: [],
      containerId: 0,
      wielderId: 0,
      currentWieldedLocation: 0,
      parentLocation: 0,
      validLocations: 0,
      stackSize: 0,
      maxStackSize: 0,
      value: 0,
      burden: 0,
      uiEffects: 0,
      usable: 0,
      useRadius: 0.6,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      soundTableId: 0,
      objScale: 1.0,
      translucency: 0,
      defaultScript: 0,
      defaultScriptIntensity: 1.0,
      iconOverlayId: 0,
      iconUnderlayId: 0,
      cooldownId: 0,
      cooldownDuration: 0,
      ...overrides,
    };
  }

  it('reconstructs the landblock from the peer\'s last known world position (wire carries no landblock)', async () => {
    const som = await makeSOM();
    // blockX=5, blockY=10, interior cellId (0x0102) so clampToTerrain (which
    // needs loaded DAT terrain) is skipped, same as an indoor peer.
    const landblock = (5 << 24) | (10 << 16) | 0x0102;
    som.createObject(baseCreateObjectData({
      position: { landblock, x: 50, y: 60, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } as any,
    }));

    som.updateAutonomousPosition({
      guid: 0x80009999,
      x: 55, y: 65, z: 1,
      rw: 0.707, rx: 0, ry: 0, rz: 0.707,
      instanceSequence: 1, serverControlSequence: 2, teleportSequence: 3, forcePositionSequence: 4,
      contact: 1,
    });

    const obj = som.getObject(0x80009999);
    expect(obj).not.toBeUndefined();
    // Same landblock grid (5,10) as before, combined with the NEW local x/y:
    // a grounded peer position is interpolated to (InterpolationManager queue).
    const target = obj!.physics!.interp.queue[obj!.physics!.interp.queue.length - 1].p;
    expect(target.pos.x).toBeCloseTo(5 * 192 + 55, 5);
    expect(target.pos.y).toBeCloseTo(10 * 192 + 65, 5);
    expect(obj!.cellId).toBe(0x0102);
  });

  it('is a no-op for an untracked guid (never throws)', async () => {
    const som = await makeSOM();
    expect(() => som.updateAutonomousPosition({
      guid: 0xDEADBEEF,
      x: 1, y: 2, z: 3, rw: 1, rx: 0, ry: 0, rz: 0,
      instanceSequence: 0, serverControlSequence: 0, teleportSequence: 0, forcePositionSequence: 0,
      contact: 0,
    })).not.toThrow();
  });
});
