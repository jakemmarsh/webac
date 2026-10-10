/**
 * FAITHFUL.338 — GameMessageSetState parser reads the missing stateSequence.
 *
 * Per `reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/
 * GameMessageSetState.cs:9-15` the wire format is:
 *   uint32 guid
 *   uint32 physicsState
 *   ushort instanceSequence  (UShortSequence — 2 bytes via
 *                             BitConverter.GetBytes(ushort), per
 *                             SequenceManager.cs:170-171 +
 *                             UShortSequence.cs:42-44)
 *   ushort stateSequence     (UShortSequence — 2 bytes)
 *
 * Total payload: 12 bytes.
 *
 * Pre-FAITHFUL.338 parser at `ServerMessageHandler.ts` correctly read
 * the first ushort instanceSequence but DROPPED stateSequence entirely.
 *
 * Real-world impact: out-of-order state packets can apply a stale
 * "you are dead" PhysicsState AFTER the server's "you respawned" packet,
 * because the consumer can't see stateSequence to compare.
 *
 * Sequence-type width verification anchored to:
 *   reference/ACE/Source/ACE.Server/Network/Sequence/SequenceManager.cs:160-181
 *   reference/ACE/Source/ACE.Server/Network/Sequence/UShortSequence.cs
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('SetState parses 4 fields per ACE wire format (FAITHFUL.338)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onSetState: d => calls.push(d) });
  });

  it('reads guid u32 + physicsState u32 + instanceSequence u16 + stateSequence u16', () => {
    const GUID = 0x80000123;
    const PHYS = 0x00000844;
    const INSTSEQ = 42;
    const STATESEQ = 7;
    const payload = concat(u32(GUID), u32(PHYS), u16(INSTSEQ), u16(STATESEQ));
    expect(payload.length).toBe(12);
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.SetState,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      guid: GUID,
      physicsState: PHYS,
      instanceSequence: INSTSEQ,
      stateSequence: STATESEQ,
    });
  });

  it('stateSequence is no longer dropped — verifies it survives the parse', () => {
    const payload = concat(u32(0), u32(0), u16(0), u16(0xBEEF));
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.SetState,
      payload,
    } as any);
    expect(calls[0].stateSequence).toBe(0xBEEF);
  });

  it('instanceSequence reads the canonical ushort width (max 65535)', () => {
    const payload = concat(u32(1), u32(0), u16(0xFFFF), u16(1));
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.SetState,
      payload,
    } as any);
    expect(calls[0].instanceSequence).toBe(0xFFFF);
  });

  it('gracefully handles a truncated 10-byte payload (no stateSequence)', () => {
    // Legacy ACE forks may ship the old 10-byte SetState without the
    // trailing stateSequence ushort. Our guard returns 0.
    const payload = concat(u32(1), u32(0x4), u16(99));
    expect(payload.length).toBe(10);
    expect(() => {
      handler.handleMessage({
        type: 'direct',
        opcode: GameMessageOpcode.SetState,
        payload,
      } as any);
    }).not.toThrow();
    expect(calls[0]).toEqual({
      guid: 1, physicsState: 0x4,
      instanceSequence: 99, stateSequence: 0,
    });
  });
});
