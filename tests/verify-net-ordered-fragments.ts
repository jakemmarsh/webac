/**
 * ASSESS: network hardening — OrderedFragmentBuffer unit tests, plus a
 * ClientConnection integration test proving the fix for
 * BUG.fragment-sequence-not-reordered.
 *
 * Mirrors ACE's inner fragment-sequence reordering stage
 * (reference/ACE/Source/ACE.Server/Network/NetworkSession.cs ~547-563 +
 * CheckOutOfOrderFragments ~592-600): a message whose fragment-sequence
 * arrives ahead of a predecessor is buffered and replayed strictly in order,
 * independent of the outer packet-sequence stream.
 */
import { describe, it, expect } from 'vitest';
import {
  OrderedFragmentBuffer,
  MAX_BUFFERED_FRAGMENT_MESSAGES,
  FragmentAssembler,
  fragmentMessage,
  ClientConnection,
  type ConnectionEvent,
  GameMessageGroup,
} from '@ac/network';

describe('OrderedFragmentBuffer — in-order delivery', () => {
  it('starts expecting fragSeq 0 (confirmed against a real captured ACE session — first BlobFragments fragment is fragSeq=0)', () => {
    const buf = new OrderedFragmentBuffer<string>();
    expect(buf.lastSequence).toBe(-1);
    const r = buf.submit(0, 'm0');
    expect(r.verdict).toBe('process');
    expect(r.ready).toEqual(['m0']);
  });

  it('processes consecutive sequences immediately', () => {
    const buf = new OrderedFragmentBuffer<string>();
    expect(buf.submit(0, 'm0').ready).toEqual(['m0']);
    expect(buf.submit(1, 'm1').ready).toEqual(['m1']);
    expect(buf.submit(2, 'm2').ready).toEqual(['m2']);
    expect(buf.lastSequence).toBe(2);
  });
});

describe('OrderedFragmentBuffer — out-of-order buffering + replay', () => {
  it('buffers a gap then replays in order when the gap fills (a later/smaller message packed ahead of an incomplete larger bundle-mate, per ACE SendBundle ~897-929)', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    expect(buf.submit(2, 'm2').verdict).toBe('buffered');
    expect(buf.submit(3, 'm3').verdict).toBe('buffered');
    expect(buf.bufferedCount).toBe(2);
    const fill = buf.submit(1, 'm1');
    expect(fill.verdict).toBe('process');
    expect(fill.ready).toEqual(['m1', 'm2', 'm3']);
    expect(buf.bufferedCount).toBe(0);
    expect(buf.lastSequence).toBe(3);
  });

  it('handles a fully reversed out-of-order burst', () => {
    const buf = new OrderedFragmentBuffer<string>();
    for (let s = 4; s >= 1; s--) {
      expect(buf.submit(s, `m${s}`).verdict).toBe('buffered');
    }
    const r = buf.submit(0, 'm0');
    expect(r.ready).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('a later duplicate of an already-buffered sequence overwrites rather than double-delivering', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(2, 'm2-first');
    buf.submit(2, 'm2-second');
    expect(buf.bufferedCount).toBe(1);
    const r0 = buf.submit(0, 'm0');
    expect(r0.ready).toEqual(['m0']); // 1 still missing
    const fill = buf.submit(1, 'm1');
    expect(fill.ready).toEqual(['m1', 'm2-second']);
  });

  it('reset() restores initial state', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    buf.submit(7, 'm7');
    buf.reset();
    expect(buf.lastSequence).toBe(-1);
    expect(buf.bufferedCount).toBe(0);
  });
});

// ─── ClientConnection integration ──────────────────────────────────────────
//
// Drives the real handlePacket()->handleFragment() path with two single-
// fragment GameEvent-shaped messages delivered inside one already-ordered
// packet-sequence stream, but with their fragment sequences swapped — the
// exact shape ACE's SendBundle can produce. Pre-fix, ClientConnection
// dispatched fragments unconditionally in arrival order (fragSeq 1 before 0);
// post-fix it must hold fragSeq 1 until fragSeq 0 arrives.

const PACKET_HEADER_SIZE = 20;
const FRAGMENT_HEADER_SIZE = 16;
const BlobFragments = 0x00000004; // PacketHeaderFlags.BlobFragments

/** PacketHeader layout (PacketHeader.ts readPacketHeader/writePacketHeader). */
function writePacketHeader(buf: Uint8Array, sequence: number, flags: number, size: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint32(0, sequence, true);
  view.setUint32(4, flags, true);
  view.setUint32(8, 0, true); // Checksum — unverified by handlePacket for cleartext frames
  view.setUint16(12, 0, true); // Id
  view.setUint16(14, 0, true); // Time
  view.setUint16(16, size, true); // Size
  view.setUint16(18, 0, true); // Iteration
}

/** An unhandled-opcode ClientMessage payload: 4-byte opcode + a 4-byte tag,
 *  so it falls through to the generic 'message' event with raw payload
 *  bytes instead of a specific parsed event shape. */
const UNHANDLED_OPCODE = 0xdead;
function buildDirectMessage(tag: number): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, UNHANDLED_OPCODE, true);
  view.setUint32(4, tag, true);
  return payload;
}

function writeFragment(buf: Uint8Array, offset: number, fragSeq: number, data: Uint8Array): void {
  const view = new DataView(buf.buffer, buf.byteOffset + offset);
  view.setUint32(0, fragSeq, true);
  view.setUint32(4, 0x80000000, true); // Id — ACE stamps every server fragment with this constant
  view.setUint16(8, 1, true); // Count — single fragment
  view.setUint16(10, FRAGMENT_HEADER_SIZE + data.length, true); // Size
  view.setUint16(12, 0, true); // Index
  view.setUint16(14, GameMessageGroup.UIQueue, true); // Queue
  buf.set(data, offset + FRAGMENT_HEADER_SIZE);
}

/** Builds one BlobFragments packet at the given packet sequence carrying a single fragment. */
function buildFragmentPacket(pktSeq: number, fragSeq: number, message: Uint8Array): Uint8Array {
  const fragSize = FRAGMENT_HEADER_SIZE + message.length;
  const buf = new Uint8Array(PACKET_HEADER_SIZE + fragSize);
  writePacketHeader(buf, pktSeq, BlobFragments, fragSize);
  writeFragment(buf, PACKET_HEADER_SIZE, fragSeq, message);
  return buf;
}

describe('ClientConnection — fragment-sequence reordering (BUG.fragment-sequence-not-reordered)', () => {
  beforeAllEnsureWebSocket();
  function beforeAllEnsureWebSocket(): void {
    const g = globalThis as { WebSocket?: unknown };
    if (typeof g.WebSocket === 'undefined') {
      g.WebSocket = class { static readonly OPEN = 1; };
    }
  }

  function makeConnection(): { conn: ClientConnection; tags: number[] } {
    const conn = new ClientConnection('ws://unit-test-not-connected');
    (conn as unknown as { ws: unknown }).ws = { readyState: 1, send: () => {}, close: () => {} };
    // A fresh ClientConnection's OrderedPacketBuffer already starts expecting
    // packet-sequence 2 (INITIAL_SEQUENCE=1), so packets 2/3 below land
    // in-order without going through the full connect handshake — this test
    // isolates the fragment layer, which OrderedPacketBuffer doesn't cover.
    const tags: number[] = [];
    conn.on((e: ConnectionEvent) => {
      if (e.type !== 'message') return;
      const msg = e.data as { type: string; opcode: number; payload: Uint8Array };
      if (msg.type === 'direct' && msg.opcode === UNHANDLED_OPCODE) {
        const view = new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength);
        tags.push(view.getUint32(0, true));
      }
    });
    return { conn, tags };
  }

  it('dispatches in fragment-sequence order even when packed into packets out of that order', () => {
    const { conn, tags } = makeConnection();
    // fragSeq 0 carries tag 100, fragSeq 1 carries tag 200 — but fragSeq 1's
    // packet is delivered (and packet-sequence-ordered) before fragSeq 0's.
    const msg0 = buildDirectMessage(100);
    const msg1 = buildDirectMessage(200);
    const pkt2 = buildFragmentPacket(2, 1, msg1); // fragSeq 1 arrives first
    const pkt3 = buildFragmentPacket(3, 0, msg0); // fragSeq 0 arrives second

    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(pkt2);
    // fragSeq 1 must NOT have dispatched yet — it's waiting on fragSeq 0.
    expect(tags).toEqual([]);

    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(pkt3);
    // Both now dispatch, in fragment-sequence order (100 before 200) despite
    // packet-sequence delivery order having been reversed.
    expect(tags).toEqual([100, 200]);
  });
});

describe('OrderedFragmentBuffer — lost sequences never wedge the gate (NET.giveup-evict-no-fragment-unstick)', () => {
  it("drops a message at or behind the gate as 'stale' instead of holding it forever", () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    buf.submit(1, 'm1');
    const r = buf.submit(0, 'm0-again');
    expect(r.verdict).toBe('stale');
    expect(r.ready).toEqual([]);
    expect(buf.bufferedCount).toBe(0);
  });

  it('skip(seq) marks one evicted sequence lost; the gate passes it when it gets there', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    buf.submit(3, 'm3'); // 1 and 2 outstanding
    expect(buf.skip(2)).toEqual([]); // 1 is still pending — not skipped
    expect(buf.lastSequence).toBe(0);
    const r = buf.submit(1, 'm1');
    expect(r.ready).toEqual(['m1', 'm3']);
    expect(buf.lastSequence).toBe(3);
  });

  it('skip of the next-expected sequence releases the held messages', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    buf.submit(2, 'm2');
    buf.submit(3, 'm3');
    expect(buf.skip(1)).toEqual(['m2', 'm3']);
    expect(buf.lastSequence).toBe(3);
  });

  it('acceptGap on a huge (garbage) sequence walks only the held keys', () => {
    const buf = new OrderedFragmentBuffer<string>();
    buf.submit(0, 'm0');
    buf.submit(5, 'm5');
    expect(buf.acceptGap(0xFFFFFFF0)).toEqual(['m5']);
    expect(buf.lastSequence).toBe(0xFFFFFFF0);
    expect(buf.bufferedCount).toBe(0);
  });

  it('is bounded: past MAX_BUFFERED_FRAGMENT_MESSAGES the gate skips to the lowest held message instead of growing', () => {
    const buf = new OrderedFragmentBuffer<number>();
    buf.submit(0, 0); // gate at 0; seq 1 never arrives
    let released: number[] = [];
    for (let s = 2; s <= MAX_BUFFERED_FRAGMENT_MESSAGES + 2; s++) {
      const r = buf.submit(s, s);
      released = released.concat(r.ready);
    }
    expect(buf.bufferedCount).toBe(0);
    expect(released[0]).toBe(2);
    expect(released.length).toBe(MAX_BUFFERED_FRAGMENT_MESSAGES + 1);
    expect(buf.lastSequence).toBe(MAX_BUFFERED_FRAGMENT_MESSAGES + 2);
  });
});

describe('FragmentAssembler.discardThrough', () => {
  it('drops only partials at or below the given fragment sequence', () => {
    const asm = new FragmentAssembler();
    const a = fragmentMessage(new Uint8Array(600), 1, GameMessageGroup.WeenieQueue, 4);
    const b = fragmentMessage(new Uint8Array(600), 1, GameMessageGroup.WeenieQueue, 9);
    asm.add(a[0]);
    asm.add(b[0]);
    expect(asm.discardThrough(5)).toEqual([4]);
    expect(asm.pendingCount).toBe(1);
    expect(asm.add(b[1])).not.toBeNull();
  });
});
