/**
 * Network reliability: the real ClientConnection, driven end to end over a
 * fake WebSocket by a simulated ACE server that behaves like
 * reference/ACE/Source/ACE.Server/Network/NetworkSession.cs:
 *   - FlushPackets: real packets take PacketSequence.NextValue; ACK-only and
 *     NAK packets are stamped with CurrentValue (the last real packet's seq)
 *   - SendBundle: one ≤464-byte fragment per packet for large messages
 *   - cachedPackets: retransmit on a client NAK (with the Retransmission
 *     flag), RejectRetransmit for anything no longer cached, prune on the
 *     client's ACK (keys < ack — AcknowledgeSequence)
 *   - an ACK-only packet every 2 s (timeBetweenAck)
 *
 * Covers NET.ack-only-seq-marks-lost-received, NET.ooo-overflow-acked-but-
 * dropped, NET.giveup-evict-no-fragment-unstick, NET.nak-latency-5s,
 * NET.outbound-multifragment-exceeds-1024 and NET.duplicate-connectrequest-
 * rekeys. Retail client references (decompiled acclient.exe):
 * SharedNet::ProcessNewestSeqNum @ 00541930, SharedNet::EnqueueNaks
 * @ 00543bd0 (0.6 s), SharedNet::EnqueuePak @ 00543b10 (2.0 s),
 * ReceiverData::GetNaks @ 005490c0 (≤ 0x72 ids), ClientNet::ProcessConnection
 * @ 00545450 (140 s dead-server drop).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClientConnection, type ConnectionEvent,
  PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, readPacketHeader, calculateHeaderChecksum,
  fragmentMessage, writeFragment, readFragment, hashFragment, reassembleFragments,
  GameMessageGroup, CryptoSystem, MAX_CLIENT_PACKET_SIZE, MAX_SEQUENCE_WINDOW,
  type Fragment, hash32,
} from '@ac/network';

// ─── Fake WebSocket (so connect()/onopen/onmessage/onclose run for real) ───

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice());
  }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => this.onclose?.({}), 0);
  }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.onmessage?.({ data: copy.buffer });
  }
}

let savedWebSocket: unknown;
beforeEach(() => {
  savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  vi.restoreAllMocks();
});

// ─── Packet helpers ────────────────────────────────────────────────────────

const ACE_SERVER_ID = 0xB; // NetworkManager.ServerId
const CLIENT_SEED = new Uint8Array([5, 6, 7, 8]);
const UNHANDLED_OPCODE = 0xdead;

function packet(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: ACE_SERVER_ID, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

function connectRequest(cookieByte = 0x11): Uint8Array {
  const payload = new Uint8Array(32);
  const v = new DataView(payload.buffer);
  v.setFloat64(0, 12345.0, true);
  payload.fill(cookieByte, 8, 16);
  v.setUint32(16, 0x0007, true); // clientId (session index)
  payload.set([1, 2, 3, 4], 20); // serverSeed
  payload.set(CLIENT_SEED, 24);  // clientSeed
  return packet(0, PacketHeaderFlags.ConnectRequest, payload);
}

function u32List(values: number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, values.length, true);
  values.forEach((x, i) => v.setUint32(4 + i * 4, x, true));
  return out;
}

function readU32List(p: Uint8Array): number[] {
  const v = new DataView(p.buffer, p.byteOffset + PACKET_HEADER_SIZE);
  const n = v.getUint32(0, true);
  return Array.from({ length: n }, (_, i) => v.getUint32(4 + i * 4, true));
}

/** A game message: unhandled opcode + a uint32 tag, padded to `size` bytes. */
function message(tag: number, size = 8): Uint8Array {
  const m = new Uint8Array(Math.max(8, size));
  const v = new DataView(m.buffer);
  v.setUint32(0, UNHANDLED_OPCODE, true);
  v.setUint32(4, tag, true);
  for (let i = 8; i < m.length; i++) m[i] = (tag + i) & 0xff;
  return m;
}

// ─── Simulated ACE server (NetworkSession semantics) ───────────────────────

class SimAceServer {
  /** PacketSequence.CurrentValue — the last real packet's sequence. */
  current = 1;
  private fragSeq = 0;
  readonly cache = new Map<number, Uint8Array>();
  /** Highest client packet sequence ACKed back (cleartext control only here). */
  clientAck = 0;
  naksReceived: number[][] = [];
  acksReceived: number[] = [];
  private clientPacketsSeen = 0;

  /** One message → one packet per ≤464-byte fragment (SendBundle, large-message path). */
  messagePackets(tag: number, size = 8): Uint8Array[] {
    const frags = fragmentMessage(message(tag, size), 0x80000000, GameMessageGroup.UIQueue, this.fragSeq++);
    return frags.map(f => this.dataPacket([f]));
  }

  /** Several small messages bundled into one packet (SendBundle, small-message path). */
  bundlePacket(tags: number[]): Uint8Array {
    const frags = tags.map(t => fragmentMessage(message(t), 0x80000000, GameMessageGroup.UIQueue, this.fragSeq++)[0]);
    return this.dataPacket(frags);
  }

  private dataPacket(frags: Fragment[]): Uint8Array {
    const size = frags.reduce((n, f) => n + FRAGMENT_HEADER_SIZE + f.data.length, 0);
    expect(size).toBeLessThanOrEqual(464);
    const payload = new Uint8Array(size);
    let off = 0;
    for (const f of frags) { writeFragment(f, payload, off); off += FRAGMENT_HEADER_SIZE + f.data.length; }
    const seq = ++this.current; // NextValue
    const p = packet(seq, PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, payload);
    this.cache.set(seq, p);
    return p;
  }

  /** ACK-only packet: flags exactly AckSequence, stamped with CurrentValue. */
  ackOnly(): Uint8Array {
    const ack = new Uint8Array(4);
    new DataView(ack.buffer).setUint32(0, this.clientAck, true);
    return packet(this.current, PacketHeaderFlags.AckSequence, ack);
  }

  /**
   * Consume the client's new outgoing packets: NAK → retransmits (+ a
   * RejectRetransmit for uncached seqs), ACK → prune the cache.
   */
  processClient(ws: FakeWebSocket, lose: () => boolean = () => false): Uint8Array[] {
    const replies: Uint8Array[] = [];
    for (const p of ws.sent.slice(this.clientPacketsSeen)) {
      this.clientPacketsSeen++;
      if (p.length < PACKET_HEADER_SIZE) continue;
      const h = readPacketHeader(p, 0);
      if (lose()) continue;
      if (h.flags === PacketHeaderFlags.RequestRetransmit) {
        const seqs = readU32List(p);
        this.naksReceived.push(seqs);
        const uncached: number[] = [];
        for (const s of seqs) {
          const cached = this.cache.get(s);
          if (!cached) { uncached.push(s); continue; }
          const re = cached.slice();
          const v = new DataView(re.buffer);
          v.setUint32(4, v.getUint32(4, true) | PacketHeaderFlags.Retransmission, true);
          replies.push(re);
        }
        if (uncached.length) {
          const seq = ++this.current;
          replies.push(packet(seq, PacketHeaderFlags.RejectRetransmit, u32List(uncached)));
        }
      } else if (h.flags === PacketHeaderFlags.AckSequence) {
        const ack = new DataView(p.buffer, p.byteOffset + PACKET_HEADER_SIZE).getUint32(0, true);
        this.acksReceived.push(ack);
        for (const k of [...this.cache.keys()]) if (k < ack) this.cache.delete(k);
      }
    }
    return replies;
  }
}

// ─── Harness ───────────────────────────────────────────────────────────────

interface Harness {
  conn: ClientConnection;
  ws: FakeWebSocket;
  server: SimAceServer;
  tags: number[];
  events: ConnectionEvent[];
  /** Server sequences that actually reached the client (any arrival). */
  delivered: Set<number>;
  deliver(p: Uint8Array): void;
  acksSent(): number[];
  naksSent(): number[][];
}

function connectHarness(): Harness {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const conn = new ClientConnection('ws://sim');
  conn.autoReconnect = false;
  const tags: number[] = [];
  const events: ConnectionEvent[] = [];
  conn.on(e => {
    events.push(e);
    if (e.type !== 'message') return;
    const msg = e.data as { type: string; opcode: number; payload: Uint8Array };
    if (msg.type === 'direct' && msg.opcode === UNHANDLED_OPCODE) {
      tags.push(new DataView(msg.payload.buffer, msg.payload.byteOffset).getUint32(0, true));
    }
  });
  conn.connect('acct', 'pw');
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.receive(connectRequest());
  // The server's first packet (ACE's first flush after the ConnectResponse)
  // moves the client to cs_Connected (CONN.charlist-wait-timeout); its first
  // service pass then ACKs, and the shared ACK/NAK stamp (retail
  // ReceiverData::timeStamp_) holds NAKs for 0.6 s — start past it.
  const server = new SimAceServer();
  ws.receive(server.ackOnly());
  vi.advanceTimersByTime(700);
  const delivered = new Set<number>();
  const clientPackets = () => ws.sent.filter(p => p.length >= PACKET_HEADER_SIZE).map(p => ({ h: readPacketHeader(p, 0), p }));
  return {
    conn, ws, server, tags, events, delivered,
    deliver(p) { delivered.add(readPacketHeader(p, 0).sequence); ws.receive(p); },
    acksSent: () => clientPackets().filter(x => x.h.flags === PacketHeaderFlags.AckSequence)
      .map(x => new DataView(x.p.buffer, x.p.byteOffset + PACKET_HEADER_SIZE).getUint32(0, true)),
    naksSent: () => clientPackets().filter(x => x.h.flags === PacketHeaderFlags.RequestRetransmit).map(x => readU32List(x.p)),
  };
}

/** Every ACK the client sent must cover only sequences that reached it. */
function expectAcksOnlyReceived(h: Harness, lostForGood: Set<number> = new Set()): void {
  for (const ack of h.acksSent()) {
    for (let s = 2; s <= ack; s++) {
      if (!h.delivered.has(s) && !lostForGood.has(s)) {
        throw new Error(`client ACKed ${ack} but seq ${s} never reached it`);
      }
    }
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('NET.ack-only-seq-marks-lost-received — ACK-only/NAK packets announce, never count as received', () => {
  it('a lost tail packet is NAKed (not ACKed) when the 2 s ACK-only packet stamped with its seq arrives', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(0);
    const [p3] = h.server.messagePackets(1);
    const [p4] = h.server.messagePackets(2); // lost on the wire
    h.deliver(p2);
    h.deliver(p3);
    expect(h.tags).toEqual([0, 1]);

    // ACE's 2 s ACK-only packet carries CurrentValue = 4 — the lost packet's seq.
    h.deliver(h.server.ackOnly());
    expect(h.naksSent().at(-1)).toEqual([4]); // NAKed at once, like retail ProcessNewestSeqNum
    vi.advanceTimersByTime(5000);
    expect(Math.max(...h.acksSent())).toBeLessThan(4); // pre-fix: ACKed 4 → ACE pruned it → wedge
    expect(h.server.processClient(h.ws).length).toBeGreaterThan(0);
    expect(h.server.cache.has(4)).toBe(true);

    // The retransmit arrives; the message is delivered and only now ACKed.
    for (const r of h.server.processClient(h.ws)) h.deliver(r);
    h.deliver(Uint8Array.from(p4)); // (or the original, late — either way exactly once)
    expect(h.tags).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(2100);
    expect(h.acksSent().at(-1)).toBe(4);
    expectAcksOnlyReceived(h);
  });

  it('an ACK-only packet stamped ahead of a gap never takes the real packet\'s reorder slot', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(10);
    const [p3] = h.server.messagePackets(11); // lost
    const [p4] = h.server.messagePackets(12); // lost
    h.deliver(p2);
    h.deliver(h.server.ackOnly()); // stamped 4 while we expect 3
    expect(h.naksSent().at(-1)).toEqual([3, 4]);
    // Retransmits arrive out of order: 4 first, then 3.
    h.deliver(p4);
    expect(h.tags).toEqual([10]);
    h.deliver(p3);
    // Pre-fix the ACK-only packet sat in slot 4, the real 4 was discarded as
    // "already buffered", and message 12 was lost forever.
    expect(h.tags).toEqual([10, 11, 12]);
  });

  it('a cleartext server NAK (stamped CurrentValue) also announces, and is still answered', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(1);
    h.server.messagePackets(2); // seq 3, lost
    h.deliver(p2);
    // ACE's NAK of our packets, stamped with its CurrentValue (3)
    h.deliver(packet(h.server.current, PacketHeaderFlags.RequestRetransmit, u32List([99])));
    expect(h.naksSent().at(-1)).toEqual([3]);
    // and our RejectRetransmit for the uncached 99 went out
    const reject = h.ws.sent.map(p => readPacketHeader(p, 0)).find(x => x.flags === PacketHeaderFlags.RejectRetransmit);
    expect(reject).toBeDefined();
  });
});

describe('NET.nak-latency-5s — NAK promptly, rate-limited like retail EnqueueNaks', () => {
  it('NAKs a gap immediately, repeats no faster than every 0.6 s, and holds ACKs while anything is missing', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(0);
    h.server.messagePackets(1); // seq 3 lost
    const [p4] = h.server.messagePackets(2);
    h.deliver(p2);
    vi.advanceTimersByTime(700); // let the post-handshake ACK stamp age
    const before = h.naksSent().length;
    h.deliver(p4);
    expect(h.naksSent().length).toBe(before + 1); // same call, not a 5 s timer
    expect(h.naksSent().at(-1)).toEqual([3]);
    const acksBefore = h.acksSent().length;
    vi.advanceTimersByTime(500);
    expect(h.naksSent().length).toBe(before + 1); // < 0.6 s later: no repeat
    vi.advanceTimersByTime(200);
    expect(h.naksSent().length).toBe(before + 2); // > 0.6 s: repeated
    vi.advanceTimersByTime(3000);
    expect(h.acksSent().length).toBe(acksBefore); // no PAK while NAKing (ProcessConnection)
  });

  it('ACKs every 2 s when nothing is missing (retail EnqueuePak)', () => {
    const h = connectHarness();
    h.deliver(h.server.messagePackets(0)[0]);
    const n = h.acksSent().length;
    vi.advanceTimersByTime(2100);
    expect(h.acksSent().length).toBe(n + 1);
    vi.advanceTimersByTime(2000);
    expect(h.acksSent().length).toBe(n + 2);
    expect(h.acksSent().at(-1)).toBe(2);
  });

  it('caps one NAK at 114 ids (ReceiverData::GetNaks 0x72) and never scans past the reorder window', () => {
    const h = connectHarness();
    // A garbage ACK-only sequence far beyond the window is ignored…
    h.deliver(packet(0x7fffffff, PacketHeaderFlags.AckSequence, new Uint8Array(4)));
    expect(h.naksSent().length).toBe(0);
    // …and a real 200-packet gap is NAKed oldest-first, 114 at a time.
    for (let i = 0; i < 200; i++) h.server.messagePackets(i);
    h.deliver(h.server.ackOnly());
    const nak = h.naksSent().at(-1)!;
    expect(nak.length).toBe(114);
    expect(nak[0]).toBe(2);
    expect(nak[113]).toBe(115);
    expect(MAX_SEQUENCE_WINDOW).toBe(256);
  });
});

describe('NET.ooo-overflow-acked-but-dropped — a packet not kept is never ACKed and is re-requested', () => {
  it('packets past the reorder window are dropped unACKed, then NAKed and delivered once the window reaches them', () => {
    const h = connectHarness();
    const packets: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) packets.push(...h.server.messagePackets(i));
    // seq 2 is lost; 3..301 arrive — those beyond 1 + 256 cannot be kept.
    for (const p of packets.slice(1)) h.deliver(p);
    expect(h.tags).toEqual([]);
    // retransmit of 2 → 2..257 flush
    h.deliver(packets[0]);
    expect(h.tags.length).toBe(256);
    // No ACK past what was kept, even though 258..301 "arrived".
    vi.advanceTimersByTime(2100);
    expect(Math.max(...h.acksSent())).toBe(257);
    // ACE's next ACK-only packet (CurrentValue 301) exposes the dropped tail.
    h.deliver(h.server.ackOnly());
    for (let round = 0; round < 5 && h.tags.length < 300; round++) {
      for (const r of h.server.processClient(h.ws)) h.deliver(r);
      vi.advanceTimersByTime(700);
    }
    expect(h.tags).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });
});

describe('NET.giveup-evict-no-fragment-unstick — lost packets never wedge the fragment gate', () => {
  it('after a RejectRetransmit, a message that arrives LATER is still delivered (fragment-stall unstick)', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(0);
    h.server.messagePackets(1); // seq 3 (fragSeq 1) lost
    h.server.cache.delete(3);   // …and gone from ACE's cache
    h.deliver(p2);
    h.deliver(h.server.ackOnly());           // announces 3 → NAK [3]
    for (const r of h.server.processClient(h.ws)) h.deliver(r); // RejectRetransmit(3)
    expect(h.tags).toEqual([0]);
    // A later message (fragSeq 2) arrives after the loss was accepted.
    h.deliver(h.server.messagePackets(2)[0]);
    expect(h.tags).toEqual([0]); // held: fragSeq 1 is missing
    vi.advanceTimersByTime(2500);
    expect(h.tags).toEqual([0, 2]);
    h.deliver(h.server.messagePackets(3)[0]);
    expect(h.tags).toEqual([0, 2, 3]);
    expectAcksOnlyReceived(h, new Set([3]));
  });

  it('an unanswered sequence is NAKed until it arrives, never given up on a timer (retail m_SeqIDsWeNAKed)', () => {
    const h = connectHarness();
    const [p2] = h.server.messagePackets(0);
    h.server.messagePackets(1); // seq 3 lost; the server has not answered yet
    const [p4] = h.server.messagePackets(2);
    h.deliver(p2);
    h.deliver(p4);
    expect(h.tags).toEqual([0]);
    // Retail keeps seq 3 in m_SeqIDsWeNAKed until it arrives or an EmptyAck
    // drops it (SharedNet::HandleEmptyAck @ 005448f0); ClientNet::ProcessConnection
    // re-sends the NAK every 0.6 s (EnqueueNaks). No 30 s give-up.
    vi.advanceTimersByTime(60_000);
    expect(h.tags).toEqual([0]);
    const before = h.naksSent().length;
    vi.advanceTimersByTime(6_000);
    const recent = h.naksSent().slice(before);
    expect(recent.length).toBeGreaterThanOrEqual(8);
    expect(recent.length).toBeLessThanOrEqual(10);
    for (const nak of recent) expect(nak).toEqual([3]);
    expect(Math.max(...h.acksSent())).toBeLessThan(3); // never ACKs past the hole
    // The retransmit finally lands: both ordering stages release in order.
    for (const r of h.server.processClient(h.ws)) h.deliver(r);
    expect(h.tags).toEqual([0, 1, 2]);
    h.deliver(h.server.messagePackets(3)[0]);
    expect(h.tags).toEqual([0, 1, 2, 3]);
    expectAcksOnlyReceived(h, new Set());
  });

  it('an evicted partial message (FragmentAssembler.evictStale) releases the messages held behind it', () => {
    const h = connectHarness();
    const big = h.server.messagePackets(0, 900); // fragSeq 0 in 3 packets (2,3,4)
    const [small] = h.server.messagePackets(1);  // fragSeq 1 in packet 5
    h.deliver(big[0]);
    h.deliver(big[1]);
    // packet 4 (the last piece) is lost and the server has nothing to resend
    h.server.cache.delete(4);
    h.deliver(small);
    for (const r of h.server.processClient(h.ws)) h.deliver(r);
    vi.advanceTimersByTime(40_000);
    expect(h.tags).toEqual([1]);
    // the partial is gone — a late last piece can't resurrect it out of order
    h.deliver(big[2]);
    expect(h.tags).toEqual([1]);
  });
});

describe('ClientConnection under deterministic loss / duplication / reordering', () => {
  it('delivers every message exactly once, in order, and never ACKs what it has not received', () => {
    let seed = 0x5eed1234;
    const rand = () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const h = connectHarness();
    const total = 120;
    const sizes = [8, 40, 600, 12, 1300, 8, 200, 470];
    let held: Uint8Array | null = null;
    const wire = (p: Uint8Array) => {
      if (rand() < 0.2) return;                // lost
      if (rand() < 0.1) { if (held) h.deliver(held); held = p; return; } // reordered
      h.deliver(p);
      if (rand() < 0.05) h.deliver(p);          // duplicated
      if (held && rand() < 0.5) { h.deliver(held); held = null; }
    };
    let tag = 0;
    for (let step = 0; step < 600 && h.tags.length < total; step++) {
      if (tag < total) {
        if (tag % 7 === 3 && tag + 1 < total) {
          wire(h.server.bundlePacket([tag, tag + 1]));
          tag += 2;
        } else {
          for (const p of h.server.messagePackets(tag, sizes[tag % sizes.length])) wire(p);
          tag++;
        }
      }
      if (step % 20 === 0) wire(h.server.ackOnly());
      for (const r of h.server.processClient(h.ws, () => rand() < 0.1)) wire(r);
      vi.advanceTimersByTime(100);
      for (const r of h.server.processClient(h.ws, () => rand() < 0.1)) wire(r);
    }
    expect(h.tags).toEqual(Array.from({ length: total }, (_, i) => i));
    expectAcksOnlyReceived(h);
    vi.advanceTimersByTime(2100);
    expect(h.acksSent().at(-1)).toBe(h.server.current);
  });
});

describe('NET.outbound-multifragment-exceeds-1024 — outgoing messages packed like ACE packs its own', () => {
  it('splits a large message into ≤464-byte-fragment packets, each with its own sequence and ISAAC key', () => {
    const h = connectHarness();
    const before = h.ws.sent.length;
    const msg = new Uint8Array(2000);
    new DataView(msg.buffer).setUint32(0, 0xF7B1, true);
    for (let i = 4; i < msg.length; i++) msg[i] = (i * 31) & 0xff;
    h.conn.sendMessage(msg);

    const out = h.ws.sent.slice(before).filter(p => (readPacketHeader(p, 0).flags & PacketHeaderFlags.BlobFragments) !== 0);
    expect(out.length).toBe(Math.ceil(2000 / 448));
    const crypto = new CryptoSystem(CLIENT_SEED); // ACE's CryptoClient for this session
    const frags: Fragment[] = [];
    out.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(MAX_CLIENT_PACKET_SIZE);
      const hdr = readPacketHeader(p, 0);
      expect(hdr.size).toBeLessThanOrEqual(464);
      expect(hdr.sequence).toBe(2 + i);
      expect(hdr.id).toBe(0x0007);
      const f = readFragment(p, PACKET_HEADER_SIZE);
      frags.push(f);
      // ClientPacket.VerifyCRC: key = (Checksum - headerChecksum) ^ payloadChecksum
      const key = (((hdr.checksum - calculateHeaderChecksum(hdr)) >>> 0) ^ hashFragment(f)) >>> 0;
      expect(key).toBe(crypto.next() >>> 0);
    });
    expect(Array.from(reassembleFragments(frags)!)).toEqual(Array.from(msg));
  });
});

describe('NET.duplicate-connectrequest-rekeys + session end', () => {
  function connectResponsesIn(h: Harness, ms: number): number {
    const n0 = h.ws.sent.filter(p => readPacketHeader(p, 0).flags === PacketHeaderFlags.ConnectResponse).length;
    vi.advanceTimersByTime(ms);
    return h.ws.sent.filter(p => readPacketHeader(p, 0).flags === PacketHeaderFlags.ConnectResponse).length - n0;
  }

  it('ignores a duplicate ConnectRequest for the same cookie: no re-key, no extra retry timer', () => {
    const h = connectHarness();
    h.conn.sendMessage(message(1));
    const lastSeq = () => readPacketHeader(h.ws.sent.at(-1)!, 0).sequence;
    expect(lastSeq()).toBe(2);
    h.ws.receive(connectRequest(0x11)); // same cookie
    expect(connectResponsesIn(h, 1000)).toBe(0); // no resend timer restarted on a joined session
    h.conn.sendMessage(message(2));
    expect(lastSeq()).toBe(3); // sequence (and ISAAC stream) continued
    const crypto = new CryptoSystem(CLIENT_SEED);
    const keyOf = (p: Uint8Array) => {
      const hdr = readPacketHeader(p, 0);
      return (((hdr.checksum - calculateHeaderChecksum(hdr)) >>> 0) ^ hashFragment(readFragment(p, PACKET_HEADER_SIZE))) >>> 0;
    };
    const frags = h.ws.sent.filter(p => (readPacketHeader(p, 0).flags & PacketHeaderFlags.BlobFragments) !== 0);
    expect(keyOf(frags[0])).toBe(crypto.next() >>> 0);
    expect(keyOf(frags[1])).toBe(crypto.next() >>> 0); // pre-fix: key 0 again (re-keyed)
  });

  it('a ConnectRequest with a NEW cookie starts the new session from scratch', () => {
    const h = connectHarness();
    h.conn.sendMessage(message(1));
    h.ws.receive(connectRequest(0x22));
    h.conn.sendMessage(message(2));
    const frags = h.ws.sent.filter(p => (readPacketHeader(p, 0).flags & PacketHeaderFlags.BlobFragments) !== 0);
    expect(readPacketHeader(frags.at(-1)!, 0).sequence).toBe(2);
  });

  it('a server Disconnect is reported exactly once (not again by the socket close that follows)', () => {
    const h = connectHarness();
    h.deliver(packet(0, PacketHeaderFlags.Disconnect));
    vi.advanceTimersByTime(10);
    const d = h.events.filter(e => e.type === 'disconnected');
    expect(d.length).toBe(1);
    expect(d[0].everOpened).toBe(true);
    expect(d[0].deliberate).toBe(false);
  });

  it('our own disconnect() still reports one deliberate disconnect', () => {
    const h = connectHarness();
    h.conn.disconnect();
    vi.advanceTimersByTime(10);
    const d = h.events.filter(e => e.type === 'disconnected');
    expect(d.length).toBe(1);
    expect(d[0].deliberate).toBe(true);
  });

  it('a silent server: serverTimeout at 30 s, then the session ends (one ServerDied-shaped disconnect) at 140 s', () => {
    const h = connectHarness();
    h.deliver(h.server.messagePackets(0)[0]);
    vi.advanceTimersByTime(31_000);
    expect(h.events.filter(e => e.type === 'serverTimeout').length).toBe(1);
    expect(h.events.filter(e => e.type === 'disconnected').length).toBe(0);
    vi.advanceTimersByTime(110_000);
    const d = h.events.filter(e => e.type === 'disconnected');
    expect(d.length).toBe(1);
    expect(d[0]).toMatchObject({ everOpened: true, deliberate: false });
    expect(h.conn.isConnected).toBe(false);
    vi.advanceTimersByTime(200_000);
    expect(h.events.filter(e => e.type === 'disconnected').length).toBe(1);
  });

  it('does not log a per-message hex dump on every send (gated behind PKT_DEBUG)', () => {
    const h = connectHarness();
    const log = console.log as unknown as ReturnType<typeof vi.fn>;
    log.mockClear();
    h.conn.sendMessage(message(1, 64));
    expect(log.mock.calls.some(c => String(c[0]).includes('[AC:MSG] sendMessage'))).toBe(false);
  });
});

describe('RELEASE.gdle-30s-idle-drop — retail\'s ~3 s sequenced TimeSync + EchoRequest keepalive', () => {
  const KEEPALIVE = PacketHeaderFlags.TimeSync | PacketHeaderFlags.EchoRequest | PacketHeaderFlags.EncryptedChecksum;
  const keepalives = (h: Harness) => h.ws.sent
    .filter(p => p.length >= PACKET_HEADER_SIZE && readPacketHeader(p, 0).flags === KEEPALIVE);
  /** ACE PacketHeaderOptional.Unpack order: TimeSync float64, then EchoRequest float32. */
  const times = (p: Uint8Array) => {
    const v = new DataView(p.buffer, p.byteOffset + PACKET_HEADER_SIZE);
    return { timeSync: v.getFloat64(0, true), echo: v.getFloat32(8, true) };
  };

  it('every 3 s (ClientFlowQueue::IncrementLocalInterval) a sequenced packet carries both headers, ISAAC-checksummed like ACE verifies', () => {
    const h = connectHarness();
    expect(keepalives(h)).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    vi.advanceTimersByTime(3000);
    const ka = keepalives(h);
    expect(ka).toHaveLength(2);
    const crypto = new CryptoSystem(CLIENT_SEED);
    ka.forEach((p, i) => {
      const hdr = readPacketHeader(p, 0);
      expect(hdr.sequence).toBe(2 + i); // in order: GDLE ThinkInbound counts it as activity
      expect(hdr.size).toBe(12);
      // ClientPacket.VerifyCRC: payloadChecksum = the optional headers' Hash32.
      const key = (((hdr.checksum - calculateHeaderChecksum(hdr)) >>> 0) ^ hash32(p, PACKET_HEADER_SIZE, 12)) >>> 0;
      expect(key).toBe(crypto.next() >>> 0);
    });
    // The client clock is seconds since the handshake, monotonic (ACE VerifyEcho).
    const [a, b] = ka.map(times);
    expect(a.timeSync).toBeCloseTo(a.echo, 3);
    expect(b.echo - a.echo).toBeCloseTo(3, 1);
  });

  it('shares the sequence and ISAAC stream with game messages, in order', () => {
    const h = connectHarness();
    vi.advanceTimersByTime(3000); // keepalive → seq 2
    const msg = new Uint8Array(16);
    new DataView(msg.buffer).setUint32(0, 0xF7B1, true);
    h.conn.sendMessage(msg); // → seq 3
    vi.advanceTimersByTime(3000); // keepalive → seq 4
    const seqd = h.ws.sent.filter(p => p.length >= PACKET_HEADER_SIZE && readPacketHeader(p, 0).sequence > 0);
    expect(seqd.map(p => readPacketHeader(p, 0).sequence)).toEqual([2, 3, 4]);
    const crypto = new CryptoSystem(CLIENT_SEED);
    for (const p of seqd) {
      const hdr = readPacketHeader(p, 0);
      const payloadCk = hdr.flags === KEEPALIVE
        ? hash32(p, PACKET_HEADER_SIZE, hdr.size)
        : hashFragment(readFragment(p, PACKET_HEADER_SIZE));
      expect((((hdr.checksum - calculateHeaderChecksum(hdr)) >>> 0) ^ payloadCk) >>> 0).toBe(crypto.next() >>> 0);
    }
  });

  it('a server NAK for a keepalive sequence is answered with the cached packet', () => {
    const h = connectHarness();
    vi.advanceTimersByTime(3000);
    const [ka] = keepalives(h);
    const before = h.ws.sent.length;
    h.ws.receive(packet(h.server.current, PacketHeaderFlags.RequestRetransmit, u32List([2])));
    vi.advanceTimersByTime(100);
    const resent = h.ws.sent.slice(before).filter(p => readPacketHeader(p, 0).sequence === 2);
    expect(resent).toHaveLength(1);
    expect(readPacketHeader(resent[0], 0).flags & ~PacketHeaderFlags.Retransmission).toBe(KEEPALIVE);
    expect(resent[0].slice(PACKET_HEADER_SIZE)).toEqual(ka.slice(PACKET_HEADER_SIZE));
  });

  // NET.impaired-tell-trade-tail: a lone lost action (a /r, a double-click
  // Use) is recovered only through the server's NAK. Retail resends on a NAK
  // alone (RecipientData::ProcessNaks @ 00547010 → FlowQueue::EnqueueAcks →
  // TransmitAcks @ 005485b0; no resend timer), and ACE NAKs a client gap only
  // once a packet two past it arrives (NetworkSession.cs: desiredSeq + 2 <=
  // seq, at most once a second). With nothing else to send, the keepalives
  // carry those sequences, so recovery takes two keepalives (~6 s) plus a
  // round trip: the floor any live probe's wait over a lossy link must clear.
  it('a lone lost action is resent only on the NAK that the second later keepalive draws from ACE', () => {
    const h = connectHarness();
    const seqd = () => h.ws.sent.filter(p => p.length >= PACKET_HEADER_SIZE && readPacketHeader(p, 0).sequence > 0);
    const msg = new Uint8Array(16);
    new DataView(msg.buffer).setUint32(0, 0xF7B1, true);
    h.conn.sendMessage(msg); // seq 2: lost on the wire
    const [action] = seqd();
    expect(readPacketHeader(action, 0).sequence).toBe(2);

    // ACE's reordering stage over what arrived (everything after the lost one).
    let nakAt = -1, keepalivesAtNak = 0;
    const aceNak = (t: number) => {
      const got = seqd().map(p => readPacketHeader(p, 0).sequence).filter(s => s !== 2);
      if (got.length && nakAt < 0) expect(got[0]).toBe(3); // the first keepalive alone draws no NAK
      if (nakAt < 0 && got.some(s => s >= 2 + 2)) {
        nakAt = t;
        keepalivesAtNak = keepalives(h).length;
        h.ws.receive(packet(h.server.current, PacketHeaderFlags.RequestRetransmit, u32List([2])));
      }
    };
    for (let t = 100; t <= 6000; t += 100) {
      vi.advanceTimersByTime(100);
      if (nakAt < 0) {
        // No client-side resend timer: seq 2 goes out once until NAKed.
        expect(seqd().filter(p => readPacketHeader(p, 0).sequence === 2)).toHaveLength(1);
      }
      aceNak(t);
    }
    // The second keepalive (seq 4) is the first packet ACE NAKs on: >3 s of silence.
    expect(keepalivesAtNak).toBe(2);
    expect(nakAt).toBeGreaterThan(3000);
    vi.advanceTimersByTime(100);
    const resent = seqd().filter(p => readPacketHeader(p, 0).sequence === 2);
    expect(resent).toHaveLength(2);
    expect(resent[1].slice(PACKET_HEADER_SIZE)).toEqual(action.slice(PACKET_HEADER_SIZE));
  });
});

// CONN.charlist-wait-timeout — retail's handshake half-state. After the
// ConnectAck the receiver stays in cs_ConnectionRequestAcked until the
// server's first packet without the ConnectRequest flag
// (ClientNet::ProcessPacket @ 00545100); meanwhile ClientNet::ProcessConnection
// @ 00545450 only resends the ConnectAck every 0.333 s
// (HANDSHAKE_WAIT_FOR_CONNECTION_TIMEOUT), uncapped, with no PAK and no
// keepalive, bounded by the 140 s no-data drop. Modclaim (2026-10-12) left
// char select on "Please Wait" for good: our ACK + TimeSync/Echo traffic
// kept a server session that never took the ConnectResponse alive.
describe('CONN.charlist-wait-timeout — cs_ConnectionRequestAcked until the server\'s first packet', () => {
  function handshakeOnly(): { conn: ClientConnection; ws: FakeWebSocket; events: ConnectionEvent[] } {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const conn = new ClientConnection('ws://sim');
    conn.autoReconnect = false;
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    conn.connect('acct', 'pw');
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.receive(connectRequest());
    return { conn, ws, events };
  }
  const flagsSent = (ws: FakeWebSocket, from = 0) =>
    ws.sent.slice(from).filter(p => p.length >= PACKET_HEADER_SIZE).map(p => readPacketHeader(p, 0).flags);

  it('resends the ConnectResponse every 0.333 s with no cap, and sends nothing else', () => {
    const { ws, events } = handshakeOnly();
    const start = ws.sent.length;
    vi.advanceTimersByTime(60_000);
    const sent = flagsSent(ws, start);
    expect(sent.every(f => f === PacketHeaderFlags.ConnectResponse)).toBe(true);
    // 60 s / 0.333 s = 180 resends; the old client gave up after 20 (10 s).
    expect(sent.length).toBeGreaterThanOrEqual(179);
    expect(sent.length).toBeLessThanOrEqual(181);
    expect(events.some(e => e.type === 'handshakeComplete')).toBe(true);
    expect(events.some(e => e.type === 'disconnected')).toBe(false);
  });

  it('a server that never answers the handshake ends in one ServerDied-shaped disconnect at 140 s', () => {
    const { conn, ws, events } = handshakeOnly();
    vi.advanceTimersByTime(139_000);
    expect(events.filter(e => e.type === 'disconnected')).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    const d = events.filter(e => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ everOpened: true, deliberate: false });
    expect(conn.isConnected).toBe(false);
    const n = ws.sent.length;
    vi.advanceTimersByTime(10_000);
    expect(ws.sent.length).toBe(n); // resends stopped with the session
  });

  it('the first non-ConnectRequest server packet stops the resends and starts the ACK + keepalive service', () => {
    const { ws } = handshakeOnly();
    vi.advanceTimersByTime(1_000);
    const server = new SimAceServer();
    ws.receive(server.ackOnly()); // any packet, not only a blob (ACE's first flush may be a TimeSync)
    const from = ws.sent.length;
    vi.advanceTimersByTime(7_000);
    const sent = flagsSent(ws, from);
    expect(sent).not.toContain(PacketHeaderFlags.ConnectResponse);
    expect(sent).toContain(PacketHeaderFlags.AckSequence);
    expect(sent.filter(f => f === (PacketHeaderFlags.TimeSync | PacketHeaderFlags.EchoRequest | PacketHeaderFlags.EncryptedChecksum))).toHaveLength(2);
  });

  it('a duplicate ConnectRequest during the half-state does not stack a second resend timer', () => {
    const { ws } = handshakeOnly();
    ws.receive(connectRequest()); // same cookie
    const from = ws.sent.length;
    vi.advanceTimersByTime(3_330);
    const n = flagsSent(ws, from).filter(f => f === PacketHeaderFlags.ConnectResponse).length;
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(10);
  });
});
