/**
 * tools/lib/ac-wire.ts — the decoder tools/retail-movement-ab.ts judges both
 * clients with. Feeds it datagrams built around our real MoveToState
 * serializer and checks it reads them the way ACE does (RawMotionState.cs,
 * MoveToState.cs, PacketHeaderOptional.cs, PacketFragmentHeader.cs).
 */
import { describe, expect, it } from 'vitest';
import { buildMoveToStatePayload } from '../packages/network/src/MessageSerializer.ts';
import { type CaptureLine, decodeCapture, decodeServerTexts, globalXY, headingOf } from '../tools/lib/ac-wire.ts';

function message(type: number, payload: Uint8Array, seq = 7): Uint8Array {
  const m = new Uint8Array(12 + payload.length);
  const v = new DataView(m.buffer);
  v.setUint32(0, 0xf7b1, true); v.setUint32(4, seq, true); v.setUint32(8, type, true);
  m.set(payload, 12);
  return m;
}

/** A packet: header (flags), optional AckSequence, then the given fragments. */
function packet(flags: number, frags: Array<{ seq: number; id: number; count: number; index: number; data: Uint8Array }>, opt: Uint8Array = new Uint8Array(0)): Buffer {
  const body = frags.reduce((n, f) => n + 16 + f.data.length, 0);
  const b = Buffer.alloc(20 + opt.length + body);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(flags, 4);
  b.writeUInt16LE(opt.length + body, 16);
  b.set(opt, 20);
  let o = 20 + opt.length;
  for (const f of frags) {
    b.writeUInt32LE(f.seq, o); b.writeUInt32LE(f.id, o + 4); b.writeUInt16LE(f.count, o + 8);
    b.writeUInt16LE(16 + f.data.length, o + 10); b.writeUInt16LE(f.index, o + 12);
    b.set(f.data, o + 16); o += 16 + f.data.length;
  }
  return b;
}
const line = (b: Buffer, d: 'c2s' | 's2c' = 'c2s', t = 1000): CaptureLine => ({ t, d, c: '127.0.0.1:5000', p: 0, b: b.toString('base64') });

const POS = { landblockId: 0xa9b40019, x: 85, y: 20.5, z: 94, qw: Math.SQRT1_2, qx: 0, qy: 0, qz: Math.SQRT1_2,
  instanceSequence: 3, serverControlSequence: 4, teleportSequence: 5, forcePositionSequence: 6, contact: true };

describe('ac-wire decodes client movement as ACE reads it', () => {
  it('MoveToState from our serializer, behind an AckSequence optional header', () => {
    const payload = buildMoveToStatePayload(
      { running: true, currentStance: 0x80000049, forwardCommand: 0x45000005, sidestepCommand: 0x6500000f, turnCommand: 0x6500000d, turnSpeed: 1.5, commands: [] },
      POS,
    );
    const ack = Buffer.alloc(4); ack.writeUInt32LE(99, 0);
    const acts = decodeCapture([line(packet(0x4004, [{ seq: 1, id: 10, count: 1, index: 0, data: message(0xf61c, payload) }], ack))]);
    expect(acts).toHaveLength(1);
    const a = acts[0].a;
    if (a.kind !== 'moveToState') throw new Error(a.kind);
    expect(a.raw.holdKey).toBe(2);               // HoldKey.Run
    expect(a.raw.style).toBe(0x80000049);        // Magic: not NonCombat, so packed
    expect(a.raw.forward).toBe(0x45000005);
    expect(a.raw.sidestep).toBe(0x6500000f);
    expect(a.raw.turn).toBe(0x6500000d);
    expect(a.raw.turnSpeed).toBeCloseTo(1.5);
    expect(a.raw.forwardSpeed).toBeUndefined();  // 1.0 is never packed (RawMotionState::Pack)
    expect(a.pos.cell).toBe(0xa9b40019);
    expect(a.seqs).toEqual([3, 4, 5, 6]);
    expect(headingOf(a.pos)).toBeCloseTo(270, 3);  // +90° about Z = facing west
    expect(globalXY(a.pos)).toEqual({ x: 0xa9 * 192 + 85, y: 0xb4 * 192 + 20.5 });
  });

  it('reassembles a two-part message and drops a retransmitted fragment', () => {
    // The parts of one message share its fragment Sequence (ACE NetworkSession
    // keys partialFragments by fragment.Header.Sequence).
    const msg = message(0xf753, (() => { const p = Buffer.alloc(32 + 8 + 1); p.writeUInt32LE(0xa9b40019, 0); p.writeFloatLE(10, 4); p.writeFloatLE(1, 16); p.writeUInt8(1, 40); return p; })());
    const a = msg.subarray(0, 20), b = msg.subarray(20);
    const p1 = packet(0x4, [{ seq: 1, id: 11, count: 2, index: 0, data: a }]);
    const p2 = packet(0x4, [{ seq: 1, id: 11, count: 2, index: 1, data: b }]);
    const acts = decodeCapture([line(p1), line(p2), line(p2)]);
    expect(acts).toHaveLength(1);
    expect(acts[0].a.kind).toBe('autoPos');
    if (acts[0].a.kind === 'autoPos') { expect(acts[0].a.pos.x).toBe(10); expect(acts[0].a.contact).toBe(1); }
  });

  it('keeps two interleaved multi-part server messages apart (ACE gives every server fragment Id 0x80000000)', () => {
    // MOVE.run-turn-collision-stop: keyed by the fragment Id, the parts of
    // different server messages were spliced together, and a multi-part
    // ObjectCreate (Pathwarden Thorolf, standing in the run-turn path) never decoded.
    const chat = (text: string): Buffer => {
      const b = Buffer.alloc(4 + 2 + text.length + 4); b.writeUInt32LE(0xf7e0, 0); b.writeUInt16LE(text.length, 4); b.write(text, 6, 'latin1');
      return b;
    };
    const one = chat('the first message, sent in two parts');
    const two = chat('a second message, also in two parts');
    const ID = 0x80000000;
    const got = decodeServerTexts([
      line(packet(0x4, [{ seq: 5, id: ID, count: 2, index: 0, data: one.subarray(0, 16) }, { seq: 6, id: ID, count: 2, index: 0, data: two.subarray(0, 16) }]), 's2c'),
      line(packet(0x4, [{ seq: 6, id: ID, count: 2, index: 1, data: two.subarray(16) }, { seq: 5, id: ID, count: 2, index: 1, data: one.subarray(16) }]), 's2c'),
    ]);
    expect(got.map((g) => g.text)).toEqual(['a second message, also in two parts', 'the first message, sent in two parts']);
  });

  it('reads system chat and WeenieError events the server sends', () => {
    const text = 'Your movement disrupted spell casting!';
    const chat = Buffer.alloc(4 + 2 + text.length + 4); chat.writeUInt32LE(0xf7e0, 0); chat.writeUInt16LE(text.length, 4); chat.write(text, 6, 'latin1');
    const err = Buffer.alloc(20); err.writeUInt32LE(0xf7b0, 0); err.writeUInt32LE(0x028a, 12); err.writeUInt32LE(0x0402, 16); // opcode, guid, sequence, event, error
    const got = decodeServerTexts([line(packet(0x4, [{ seq: 1, id: 1, count: 1, index: 0, data: chat }, { seq: 1, id: 2, count: 1, index: 0, data: err }]), 's2c')]);
    expect(got.map((g) => g.text)).toEqual([text, 'WeenieError 0x402']);
    expect(got[1].error).toBe(0x0402);  // YourSpellFizzled
  });
});
