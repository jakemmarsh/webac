/**
 * FAITHFUL.336 — HearRangedSpeech parser aligned with ACE source.
 *
 * Pre-FAITHFUL.336 `handleHearSpeech` used the same parse shape for both
 * regular speech (opcode 0x02BB) and ranged speech (opcode 0x02BC):
 *   message + senderName + senderID + chatType.
 *
 * But ACE's `GameMessageHearRangedSpeech.cs:9-15` inserts a `float range`
 * field between senderID and chatMessageType:
 *   message + senderName + senderID + range (f32) + chatType
 *
 * For /shout (the only ACE call site that uses HearRangedSpeech in retail),
 * the pre-fix parser read the float bits as `chatType` (e.g. 200.0f =
 * 0x43480000), missed the actual chatType entirely, and rendered the
 * message with the default grey color instead of the canonical retail
 * color for that ChatMessageType subtype.
 *
 * Sibling local-radius HearSpeech (0x02BB) is untouched — same shape both
 * before and after this fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';

function string16L(s: string): Uint8Array {
  const bytes = Array.from(s, c => c.charCodeAt(0));
  const total = 2 + bytes.length;
  const pad = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + pad);
  out[0] = bytes.length & 0xff;
  out[1] = (bytes.length >> 8) & 0xff;
  for (let i = 0; i < bytes.length; i++) out[2 + i] = bytes[i];
  return out;
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

describe('HearRangedSpeech parses message + senderName + senderID + range + chatType (FAITHFUL.336)', () => {
  let handler: ServerMessageHandler;
  let calls: any[];

  beforeEach(() => {
    calls = [];
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onHearSpeech: d => calls.push({ kind: 'speech', ...d }),
      onHearRangedSpeech: d => calls.push({ kind: 'ranged', ...d }),
    });
  });

  it('ranged speech exposes the range float distinct from chatType', () => {
    const payload = concat(
      string16L('I am yelling across the landblock!'),
      string16L('Shouter'),
      u32(0x50000042),
      f32(200.0),            // range in meters
      u32(10),               // ChatMessageType.Speech
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.HearRangedSpeech,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: 'ranged',
      message: 'I am yelling across the landblock!',
      senderName: 'Shouter',
      senderGuid: 0x50000042,
      range: 200,
      chatType: 10,
    });
  });

  it('ranged speech with chatType=0 ALSO reads range field (no off-by-4)', () => {
    // Pre-fix this scenario would have read the float bits as chatType,
    // i.e. 200.0 → 0x43480000 → chatType = 1128464384. Post-fix chatType
    // must be exactly 0 (the wire value) and range = 50.5.
    const payload = concat(
      string16L('Hello'),
      string16L('Bob'),
      u32(0x80000001),
      f32(50.5),
      u32(0),
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.HearRangedSpeech,
      payload,
    } as any);
    expect(calls[0].chatType).toBe(0);
    expect(calls[0].range).toBeCloseTo(50.5, 5);
  });

  it('plain HearSpeech (no range field) still parses with 4 fields', () => {
    const payload = concat(
      string16L('Local chatter'),
      string16L('Alice'),
      u32(0x80000002),
      u32(10), // Speech
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.HearSpeech,
      payload,
    } as any);
    expect(calls[0]).toMatchObject({
      kind: 'speech',
      message: 'Local chatter',
      senderName: 'Alice',
      senderGuid: 0x80000002,
      chatType: 10,
    });
    expect(calls[0].range).toBeUndefined();
  });
});
