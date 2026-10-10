/**
 * ASSESS: network hardening — ClientConnection integration tests.
 *
 * Drives the real ClientConnection.handlePacket with hand-built server packet
 * bytes and asserts observable behavior ('message' events, packets written to
 * a stubbed WebSocket):
 *   - ordered + deduped packet processing (ACE NetworkSession.cs ~336-397)
 *   - fragment-walk corrupt-size guard (no infinite loop)
 *   - duplicate fragment indices ignored (ACE MessageBuffer.cs:22-30)
 *   - stale partial-message eviction
 *   - RejectRetransmit sent for NAKed-but-uncached sequences
 *     (ACE Packets/PacketRejectRetransmit.cs:7-17 format)
 *   - EchoResponse optional header is 8 bytes (NetworkSession.cs ~941-947)
 *   - pre-handshake sendMessage queueing (ACE ClientPacket.cs VerifyCRC)
 *   - dead-server 'serverTimeout' one-shot event
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  ClientConnection, ConnectionEvent,
  PacketHeaderFlags, PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, readPacketHeader,
  fragmentMessage, writeFragment,
  FragmentAssembler,
  GameMessageGroup, SessionState,
} from '@ac/network';

// Node 20 has no global WebSocket — ClientConnection references WebSocket.OPEN
// inside methods, so provide a minimal stand-in before driving it.
beforeAll(() => {
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
    };
  }
});

function buildServerPacket(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = {
    sequence: seq, flags, checksum: 0, id: 0x42, time: 0,
    size: payload.length, iteration: 1,
  };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

/**
 * Build a server packet carrying one single-fragment message with the given
 * opcode. Packet sequence and fragment sequence are independent counters on
 * the wire (BUG.fragment-sequence-not-reordered) — fragSeq must reflect the
 * message's actual position in the fragment-sequence stream (starting at 0
 * for a fresh ClientConnection), NOT the packet sequence it happens to ride
 * in, or ClientConnection's fragment-ordering gate will buffer it forever.
 */
function buildMessagePacket(seq: number, opcode: number, fragSeq: number, extraFlags: number = 0, prefix: Uint8Array = new Uint8Array(0)): Uint8Array {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(0, opcode, true);
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, fragSeq);
  const payload = new Uint8Array(prefix.length + FRAGMENT_HEADER_SIZE + frag.data.length);
  payload.set(prefix, 0);
  writeFragment(frag, payload, prefix.length);
  return buildServerPacket(seq, PacketHeaderFlags.BlobFragments | extraFlags, payload);
}

interface Harness {
  conn: ClientConnection;
  events: ConnectionEvent[];
  opcodes: number[];
  sent: Uint8Array[];
}

function makeHarness(): Harness {
  const conn = new ClientConnection('ws://test-not-connected');
  const events: ConnectionEvent[] = [];
  const opcodes: number[] = [];
  const sent: Uint8Array[] = [];
  conn.on(e => {
    events.push(e);
    if (e.type === 'message') opcodes.push((e.data as { opcode: number }).opcode);
  });
  (conn as any).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (b: ArrayBuffer | Uint8Array) => sent.push(new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))),
    close: () => {},
  };
  return { conn, events, opcodes, sent };
}

function feed(h: Harness, pkt: Uint8Array): void {
  (h.conn as any).handlePacket(pkt);
}

const OP = 0x00112200; // arbitrary opcodes not handled specially by processMessage

describe('ClientConnection — ordered + deduped packet processing', () => {
  it('processes in-order packets immediately', () => {
    const h = makeHarness();
    feed(h, buildMessagePacket(2, OP + 2, 0));
    feed(h, buildMessagePacket(3, OP + 3, 1));
    expect(h.opcodes).toEqual([OP + 2, OP + 3]);
  });

  it('buffers out-of-order packets and replays them strictly in order', () => {
    const h = makeHarness();
    feed(h, buildMessagePacket(2, OP + 2, 0));
    feed(h, buildMessagePacket(5, OP + 5, 3)); // gap: 3, 4 missing
    feed(h, buildMessagePacket(4, OP + 4, 2));
    expect(h.opcodes).toEqual([OP + 2]); // nothing past the gap yet
    feed(h, buildMessagePacket(3, OP + 3, 1));
    expect(h.opcodes).toEqual([OP + 2, OP + 3, OP + 4, OP + 5]);
  });

  it('discards duplicate packets (immediate and very old)', () => {
    const h = makeHarness();
    feed(h, buildMessagePacket(2, OP + 2, 0));
    feed(h, buildMessagePacket(2, OP + 2, 0)); // immediate dup
    feed(h, buildMessagePacket(3, OP + 3, 1));
    feed(h, buildMessagePacket(4, OP + 4, 2));
    feed(h, buildMessagePacket(2, OP + 2, 0)); // very old dup
    expect(h.opcodes).toEqual([OP + 2, OP + 3, OP + 4]);
  });

  it('handles an out-of-order burst', () => {
    const h = makeHarness();
    // packet identity s → fragment sequence s-2, so the fragment stream is
    // 0,1,2,3,4 once packet-level reordering restores ascending seq order.
    for (const s of [6, 4, 3, 5]) feed(h, buildMessagePacket(s, OP + s, s - 2));
    expect(h.opcodes).toEqual([]);
    feed(h, buildMessagePacket(2, OP + 2, 0));
    expect(h.opcodes).toEqual([OP + 2, OP + 3, OP + 4, OP + 5, OP + 6]);
  });
});

describe('ClientConnection — fragment-walk corrupt-size guard', () => {
  it('aborts the packet on a fragment size below the 16-byte header (no infinite loop)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      // Hand-built fragment header with size=8 (< FRAGMENT_HEADER_SIZE)
      const payload = new Uint8Array(FRAGMENT_HEADER_SIZE);
      const v = new DataView(payload.buffer);
      v.setUint32(0, 1, true);  // fragment sequence
      v.setUint32(4, 1, true);  // id
      v.setUint16(8, 1, true);  // count
      v.setUint16(10, 8, true); // size — corrupt, below header size
      v.setUint16(12, 0, true); // index
      v.setUint16(14, 9, true); // queue
      feed(h, buildServerPacket(2, PacketHeaderFlags.BlobFragments, payload));
      expect(h.opcodes).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Corrupt fragment size=8'));
      // connection still works afterwards
      feed(h, buildMessagePacket(3, OP + 3, 0));
      expect(h.opcodes).toEqual([OP + 3]);
    } finally {
      warn.mockRestore();
    }
  });

  it('aborts when a fragment size runs past the packet end', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const payload = new Uint8Array(FRAGMENT_HEADER_SIZE);
      const v = new DataView(payload.buffer);
      v.setUint32(0, 1, true);
      v.setUint32(4, 1, true);
      v.setUint16(8, 1, true);
      v.setUint16(10, 400, true); // claims 400 bytes; only 16 present
      v.setUint16(12, 0, true);
      v.setUint16(14, 9, true);
      feed(h, buildServerPacket(2, PacketHeaderFlags.BlobFragments, payload));
      expect(h.opcodes).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Corrupt fragment size=400'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ClientConnection — multi-fragment reassembly robustness', () => {
  // 600-byte message → 2 fragments (448 + 152), each delivered in its own packet
  function twoFragmentMessage(): { msg: Uint8Array; packets: Uint8Array[]; dupPacket: Uint8Array } {
    const msg = new Uint8Array(600);
    new DataView(msg.buffer).setUint32(0, OP + 99, true);
    for (let i = 4; i < 600; i++) msg[i] = i & 0xff;
    // Fragment sequence 0 (not the 0x77 message id) — this is the only
    // message this fresh harness's fragment-ordering gate will ever see.
    const frags = fragmentMessage(msg, 0x77, GameMessageGroup.WeenieQueue, 0);
    expect(frags.length).toBe(2);
    const wrap = (seq: number, fragIdx: number) => {
      const f = frags[fragIdx];
      const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + f.data.length);
      writeFragment(f, payload, 0);
      return buildServerPacket(seq, PacketHeaderFlags.BlobFragments, payload);
    };
    return { msg, packets: [wrap(2, 0), wrap(4, 1)], dupPacket: wrap(3, 0) };
  }

  it('ignores a duplicate fragment index instead of dropping the message', () => {
    const h = makeHarness();
    const { packets, dupPacket } = twoFragmentMessage();
    const received: Uint8Array[] = [];
    h.conn.on(e => {
      if (e.type === 'message') received.push((e.data as { payload: Uint8Array }).payload);
    });
    feed(h, packets[0]);   // seq 2: index 0
    feed(h, dupPacket);    // seq 3: index 0 AGAIN (re-bundled by server)
    expect(h.opcodes).toEqual([]); // pre-fix: dup made length==count → null → message lost
    feed(h, packets[1]);   // seq 4: index 1 — completes
    expect(h.opcodes).toEqual([OP + 99]);
    expect(received[0].length).toBe(596); // 600 - 4 opcode bytes
  });

  it('evicts stale partial messages after 30s via the assembler', () => {
    const asm = new FragmentAssembler();
    const msg = new Uint8Array(600);
    const frags = fragmentMessage(msg, 5, GameMessageGroup.WeenieQueue, 5);
    expect(asm.add(frags[0], 1_000)).toBeNull();
    expect(asm.pendingCount).toBe(1);
    expect(asm.evictStale(30_000, 20_000)).toEqual([]); // still fresh
    expect(asm.evictStale(30_000, 32_000)).toEqual([5]); // > 30s old
    expect(asm.pendingCount).toBe(0);
    // a late-arriving second fragment no longer completes anything
    expect(asm.add(frags[1], 33_000)).toBeNull();
  });

  it('FragmentAssembler reassembles out-of-order fragments byte-exactly', () => {
    const asm = new FragmentAssembler();
    const msg = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) msg[i] = (i * 7) & 0xff;
    const frags = fragmentMessage(msg, 9, GameMessageGroup.WeenieQueue, 9);
    expect(frags.length).toBe(3);
    expect(asm.add(frags[2])).toBeNull();
    expect(asm.add(frags[0])).toBeNull();
    const out = asm.add(frags[1]);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual(Array.from(msg));
  });
});

describe('ClientConnection — RejectRetransmit on uncached NAK', () => {
  function buildNak(seqs: number[]): Uint8Array {
    const payload = new Uint8Array(4 + seqs.length * 4);
    const v = new DataView(payload.buffer);
    v.setUint32(0, seqs.length, true);
    seqs.forEach((s, i) => v.setUint32(4 + i * 4, s, true));
    return buildServerPacket(0, PacketHeaderFlags.RequestRetransmit, payload);
  }

  it('retransmits cached sequences and sends RejectRetransmit for uncached ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const cachedBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      (h.conn as any).sentPacketCache.set(5, cachedBytes);
      feed(h, buildNak([5, 99]));

      // cached seq 5 → exact bytes resent
      expect(h.sent.some(p => p.length === 4 && p[0] === 0xde)).toBe(true);

      // uncached seq 99 → RejectRetransmit (PacketRejectRetransmit.cs: count + seqs)
      const reject = h.sent.find(p => {
        if (p.length < PACKET_HEADER_SIZE) return false;
        return readPacketHeader(p, 0).flags === PacketHeaderFlags.RejectRetransmit;
      });
      expect(reject).toBeDefined();
      const view = new DataView(reject!.buffer, reject!.byteOffset + PACKET_HEADER_SIZE);
      expect(view.getUint32(0, true)).toBe(1);  // count
      expect(view.getUint32(4, true)).toBe(99); // rejected sequence
    } finally {
      warn.mockRestore();
    }
  });

  it('server RejectRetransmit unblocks ordered processing past the lost gap', () => {
    const h = makeHarness();
    feed(h, buildMessagePacket(2, OP + 2, 0));
    // packet seq 3 lost on the wire — its fragment (which would have been
    // sequence 1) is gone forever too.
    feed(h, buildMessagePacket(4, OP + 4, 2));
    expect(h.opcodes).toEqual([OP + 2]);
    // server says it can't resend seq 3
    const payload = new Uint8Array(8);
    const v = new DataView(payload.buffer);
    v.setUint32(0, 1, true);
    v.setUint32(4, 3, true);
    feed(h, buildServerPacket(5, PacketHeaderFlags.RejectRetransmit, payload));
    expect(h.opcodes).toEqual([OP + 2, OP + 4]);
    // and the stream continues normally
    feed(h, buildMessagePacket(6, OP + 6, 3));
    expect(h.opcodes).toEqual([OP + 2, OP + 4, OP + 6]);
  });
});

describe('ClientConnection — EchoResponse optional header is 8 bytes', () => {
  it('parses fragments correctly after an EchoResponse header (two float32s — ACE NetworkSession.cs ~941-947)', () => {
    const h = makeHarness();
    const echo = new Uint8Array(8);
    const v = new DataView(echo.buffer);
    v.setFloat32(0, 123.5, true); // ClientTime echo
    v.setFloat32(4, 0.25, true);  // serverTime - ClientTime
    feed(h, buildMessagePacket(2, OP + 7, 0, PacketHeaderFlags.EchoResponse, echo));
    // a 12-byte skip would misread the fragment header and drop the message
    expect(h.opcodes).toEqual([OP + 7]);
  });
});

describe('ClientConnection — pre-handshake send queueing', () => {
  function buildConnectRequest(): Uint8Array {
    const payload = new Uint8Array(32);
    const v = new DataView(payload.buffer);
    v.setFloat64(0, 12345.0, true);            // serverTime
    for (let i = 8; i < 16; i++) payload[i] = 0x11; // cookie
    v.setUint32(16, 0x0421, true);             // clientId
    payload.set([1, 2, 3, 4], 20);             // serverSeed
    payload.set([5, 6, 7, 8], 24);             // clientSeed
    return buildServerPacket(0, PacketHeaderFlags.ConnectRequest, payload);
  }

  it('queues sendMessage before the handshake and flushes it after (ACE VerifyCRC would drop the early packet)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const msg = new Uint8Array(8);
      new DataView(msg.buffer).setUint32(0, 0xF7C8, true);

      h.conn.sendMessage(msg);
      // nothing hit the wire — no burned sequence number
      expect(h.sent.length).toBe(0);
      expect((h.conn as any).packetSequence).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('queueing until ISAAC is keyed'));

      feed(h, buildConnectRequest());
      expect(h.conn.state).toBe(SessionState.AuthConnected);

      // the queued message went out as an encrypted fragment packet, seq 2
      const fragPackets = h.sent
        .filter(p => p.length >= PACKET_HEADER_SIZE)
        .map(p => readPacketHeader(p, 0))
        .filter(hd => (hd.flags & PacketHeaderFlags.BlobFragments) !== 0);
      expect(fragPackets.length).toBe(1);
      expect(fragPackets[0].sequence).toBe(2);
      expect((fragPackets[0].flags & PacketHeaderFlags.EncryptedChecksum) !== 0).toBe(true);

      h.conn.disconnect(); // clear keepalive/retry timers
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ClientConnection — dead-server detection (serverTimeout)', () => {
  it('emits a one-shot serverTimeout after 30s of silence post-handshake, re-arming on traffic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      (h.conn as any).connectionData.state = SessionState.AuthConnected;
      (h.conn as any).lastPacketReceivedAt = Date.now() - 31_000;

      (h.conn as any).checkServerTimeout();
      expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(1);

      // one-shot: doesn't repeat while silence continues
      (h.conn as any).checkServerTimeout();
      expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(1);

      // traffic resumes → re-arms
      feed(h, buildMessagePacket(2, OP + 2, 0));
      (h.conn as any).checkServerTimeout();
      expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(1); // fresh traffic, no fire

      (h.conn as any).lastPacketReceivedAt = Date.now() - 31_000;
      (h.conn as any).checkServerTimeout();
      expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not fire pre-handshake', () => {
    const h = makeHarness();
    (h.conn as any).lastPacketReceivedAt = Date.now() - 120_000;
    (h.conn as any).checkServerTimeout();
    expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(0);
  });
});

/**
 * BUG.8 — fragment assembly must key partials by fragment SEQUENCE, not id.
 *
 * ACE stamps EVERY server fragment with the constant Id 0x80000000
 * (MessageFragment.cs:94); the per-message discriminator is Header.Sequence
 * (one FragmentSequence++ per message, NetworkSession.cs:821), and ACE's own
 * receive side buckets partials by it (NetworkSession.cs:495). Pre-fix our
 * assembler keyed by id, so ALL in-flight multi-fragment messages shared one
 * bucket: a second message's index-0 was dedup-dropped, counts cross-checked
 * against the wrong message, and payloads could splice across messages —
 * observed live 2026-07-04 as "[AC:FRAG] Evicting stale partial message
 * id=2147483648" on every world entry with interleaved traffic.
 */
describe('BUG.8 — fragment keying by sequence (ACE NetworkSession.cs:495)', () => {
  const ACE_SERVER_FRAG_ID = 0x80000000;

  function makeFrags(fill: number, bytes: number, fragSeq: number) {
    const msg = new Uint8Array(bytes).fill(fill);
    new DataView(msg.buffer).setUint32(0, 0xf7b0, true);
    const frags = fragmentMessage(msg, ACE_SERVER_FRAG_ID, GameMessageGroup.WeenieQueue, fragSeq);
    // simulate ACE server traffic: constant id, per-message sequence
    for (const f of frags) f.header.id = ACE_SERVER_FRAG_ID;
    return { msg, frags };
  }

  it('two interleaved multi-fragment messages with the constant server id both complete intact', () => {
    const asm = new FragmentAssembler();
    const a = makeFrags(0xaa, 900, 101); // 3 fragments
    const b = makeFrags(0xbb, 600, 102); // 2 fragments
    expect(a.frags.length).toBe(3);
    expect(b.frags.length).toBe(2);

    // interleave: A0, B0, A1, B1(completes B), A2(completes A)
    expect(asm.add(a.frags[0], 0)).toBeNull();
    expect(asm.add(b.frags[0], 1)).toBeNull(); // pre-fix: dedup-dropped as "duplicate index 0"
    expect(asm.add(a.frags[1], 2)).toBeNull();
    const bOut = asm.add(b.frags[1], 3);
    expect(bOut).not.toBeNull();
    expect(Array.from(bOut!.slice(4))).toEqual(Array.from(b.msg.slice(4)));
    const aOut = asm.add(a.frags[2], 4);
    expect(aOut).not.toBeNull();
    expect(Array.from(aOut!.slice(4))).toEqual(Array.from(a.msg.slice(4)));
    expect(asm.pendingCount).toBe(0); // nothing left to evict — no stale partials
  });

  it('all fragments of one outbound message share ONE fragment sequence (ACE MessageFragment.cs:93)', () => {
    const msg = new Uint8Array(1200);
    const frags = fragmentMessage(msg, 7, GameMessageGroup.WeenieQueue, 7);
    expect(frags.length).toBeGreaterThan(1);
    for (const f of frags) expect(f.header.sequence).toBe(7);
    // indices still enumerate the pieces
    expect(frags.map(f => f.header.index)).toEqual(frags.map((_, i) => i));
  });
});
