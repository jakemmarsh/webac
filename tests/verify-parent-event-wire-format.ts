/**
 * FAITHFUL.339 — GameMessageParentEvent parser uses ushort widths for the
 * two trailing sequences (matches UShortSequence wire encoding).
 *
 * ACE `GameMessageParentEvent.cs:11-17` writes:
 *   u32 creatureGuid
 *   u32 wieldedGuid
 *   i32 parentLocation       (ParentLocation enum)
 *   i32 placement            (Placement enum)
 *   u16 instanceSequence     (ObjectInstance — UShortSequence per
 *                             SequenceManager.cs:170-171)
 *   u16 positionSequence     (ObjectPosition — UShortSequence)
 *
 * Total payload: 20 bytes.
 *
 * Pre-FAITHFUL.339 parser read uint32 for instanceSequence and uint32
 * for positionSequence — that consumed the WHOLE 4-byte trailer as one
 * value (instanceSequence got `(positionSequence << 16) | actualInst`)
 * and then the `r.remaining >= 4` guard returned 0 for positionSequence.
 * Consumer (attachWieldedToPlayer) doesn't sequence-check, but the wire-
 * format truth was wrong and any future sequence-gating logic would have
 * silently been broken.
 *
 * Same UShortSequence width family as FAITHFUL.338 (SetState).
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

describe('ParentEvent parses 6 fields with ushort sequence widths (FAITHFUL.339)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onParentEvent: d => calls.push(d) });
  });

  it('reads creatureGuid + wieldedGuid + parentLocation + placement + instSeq + posSeq', () => {
    const CREATURE = 0x80000042;
    const WIELDED  = 0x50000123;
    const PARENT_LOC = 1; // ParentLocation.RightHand
    const PLACEMENT  = 0; // Placement.Default
    const INST_SEQ = 17;
    const POS_SEQ  = 5;
    const payload = concat(
      u32(CREATURE), u32(WIELDED),
      u32(PARENT_LOC), u32(PLACEMENT),
      u16(INST_SEQ), u16(POS_SEQ),
    );
    expect(payload.length).toBe(20);
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.ParentEvent,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      creatureGuid: CREATURE,
      wieldedGuid: WIELDED,
      parentLocation: PARENT_LOC,
      placement: PLACEMENT,
      instanceSequence: INST_SEQ,
      positionSequence: POS_SEQ,
    });
  });

  it('positionSequence is no longer collapsed into instanceSequence', () => {
    // Concrete demonstration of the pre-fix bug: instSeq=0x1234, posSeq=0xABCD.
    // Pre-fix readUInt32 here would yield 0xABCD1234 as instanceSequence,
    // and positionSequence would be 0 from the guard.
    const payload = concat(
      u32(1), u32(2), u32(0), u32(0),
      u16(0x1234), u16(0xABCD),
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.ParentEvent,
      payload,
    } as any);
    expect(calls[0].instanceSequence).toBe(0x1234);
    expect(calls[0].positionSequence).toBe(0xABCD);
  });

  it('cleanly handles a truncated 18-byte payload (missing posSeq trailer)', () => {
    const payload = concat(u32(1), u32(2), u32(3), u32(4), u16(99));
    expect(payload.length).toBe(18);
    expect(() => {
      handler.handleMessage({
        type: 'direct',
        opcode: GameMessageOpcode.ParentEvent,
        payload,
      } as any);
    }).not.toThrow();
    expect(calls[0].instanceSequence).toBe(99);
    expect(calls[0].positionSequence).toBe(0);
  });
});
