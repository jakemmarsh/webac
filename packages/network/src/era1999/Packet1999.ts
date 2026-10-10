/**
 * The 1999 retail transport's packet layer (client.exe "4.35752"): header,
 * flags, checksums and fragments. docs/ac1999-support.md has the measured
 * wire; the authority is the real client's capture
 * (tests/fixtures/ac1999-session-001.jsonl.gz) and the AC1999 server
 * (reference/ac1999/Server/Source, AGPL: NetworkDefs.h, crc.cpp,
 * PacketController.cpp).
 *
 * Header (20 bytes, little-endian) — the 2017 header with recipient and
 * checksum swapped and time/table narrowed to bytes:
 *   0x00 u32 sequence   0x04 u32 flags   0x08 u32 recipient   0x0C u32 checksum
 *   0x10 u16 size       0x12 u8 time     0x13 u8 table (0)
 * `size` counts the body after the header. On client→server data (0x20 /
 * 0x800 carriers) the body starts with a u32 "flow" word that `size` does
 * NOT count (PacketController.cpp ProcessBlob skips it; capture: a 416-byte
 * datagram carries size 392).
 *
 * Fragments are the 2017 layout exactly: u32 sequence, u32 id (0x80000000),
 * u16 count, u16 size (header included), u16 index, u16 group.
 */

/** Header flags this client sends or reads. */
import { hash32 } from '../Hash32.js';

export const F1999 = {
  /** A retransmitted packet. */
  Resent: 0x1,
  /** Checksum present (set on every packet). */
  Checksum: 0x2,
  /** "Resend these sequences": [u32 flow/len][u32 count][u32 seq × count]. The AC1999 server also uses it as its ack. */
  ResendList: 0x8,
  /** TimeSync request (client→server; the server does not answer it). */
  TimeSyncRequest: 0x10,
  /** The client's reliable carrier (heartbeat). */
  OrderedData: 0x20,
  /** Client "received these" list ([flow][count][seqs]); the AC1999 server ignores it. */
  AckList: 0x80,
  /** ServerSwitch: the connect-progress step; an 8-byte zero body. Answered with a bare 0x102. */
  ServerSwitch: 0x100,
  /** The connect grant (with a body) / connection ack and keepalive (bare). */
  Connect: 0x200,
  /** Application data: a run of fragments (server→client), or [flow] + fragments (client→server). */
  Referral: 0x800,
  /** Flow value (u32). */
  Flow: 0x1000,
  /** Server ack of a client sequence (u32), read before the time update. */
  AckSequence: 0x4000,
  Disconnect: 0x8000,
  /** Login failure: [u32 stringId][u32 table], connectionless. */
  NetError: 0x100000,
  /** Server time update (f64 world clock); the 1999 client ignores it, we feed the day/night clock. */
  TimeUpdate: 0x1000000,
  /** Client pre-login strobe (with Checksum: 0x8002). */
  Strobe: 0x8000,
} as const;

export const HEADER_SIZE_1999 = 20;
export const FRAGMENT_HEADER_SIZE_1999 = 16;
/** Every era's datagram limit (KB networking/fragment-transport.md; NetworkDefs.h MAX_BLOB_LEN). */
export const MAX_DATAGRAM_1999 = 0x1e4;
/** Client→server fragment data stride (0x1BC, the real client's). */
export const MAX_C2S_FRAGMENT_DATA_1999 = 0x1bc;
/** The checksum seed written into the checksum field while hashing (2017: 0xBADD70DD). */
export const CHECKSUM_SEED_1999 = 0x3291975;
/** The fragment id every message uses. */
export const FRAGMENT_ID_1999 = 0x80000000;

export interface Header1999 {
  sequence: number;
  flags: number;
  recipient: number;
  checksum: number;
  size: number;
  time: number;
  table: number;
}

export function readHeader1999(b: Uint8Array): Header1999 {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    sequence: v.getUint32(0, true),
    flags: v.getUint32(4, true),
    recipient: v.getUint32(8, true),
    checksum: v.getUint32(12, true),
    size: v.getUint16(16, true),
    time: v.getUint8(18),
    table: v.getUint8(19),
  };
}

/**
 * GetMagicNumber (crc.cpp): the sum of the little-endian dwords, trailing bytes
 * added big-endian-shifted (the first at <<24), plus length<<16 when asked.
 * With the length it is end of retail's Hash32 (the same algorithm), so it is
 * computed by it; without, the length term is taken back out.
 */
export function magic1999(b: Uint8Array, includeLength: boolean): number {
  const h = hash32(b);
  return includeLength ? h : (h - ((b.length << 16) >>> 0)) >>> 0;
}

/** The header hash: the 20 header bytes with the checksum field set to the seed, length included. */
export function headerHash1999(packet: Uint8Array): number {
  // A copy, never a view: Node Buffer.slice returns a view, and the seed write below would corrupt the packet.
  const head = new Uint8Array(packet.subarray(0, HEADER_SIZE_1999));
  new DataView(head.buffer).setUint32(12, CHECKSUM_SEED_1999, true);
  return magic1999(head, true);
}

/** Option headers that lead a server body, in read order, with their sizes (crc.cpp BlobCRC). */
const OPTION_SIZES_1999: Array<[number, number]> = [
  [0x4000, 4], // AckSequence
  [0x1000000, 8], // TimeUpdate
  [0x2000000, 4], // EchoRequest
  [0x4000000, 8], // EchoResponse
  [0x8000000, 6], // Flow (2017-style)
];

/** Bytes of option headers a body starts with, for these flags. */
export function optionBytes1999(flags: number): number {
  let n = 0;
  for (const [bit, size] of OPTION_SIZES_1999) if (flags & bit) n += size;
  return n;
}

/**
 * The wire checksum, measured against every packet of the real client's
 * session (tests/verify-ac1999-transport.ts):
 *   header hash (the 20 header bytes, checksum field = seed, length folded in)
 *   + magic(flow word, no length)                         — client data only
 *   + (magic(options, length) + Σ fragments) ^ xor        — fragment/option packets
 * or, for any other body, + magic(body, no length) ^ xor.
 * Each fragment hashes as (its header, length) + (its data, length).
 * `xor` is isaac[seq-2] of the sender's zero-seeded ISAAC stream for a
 * checksummed sequenced packet (seq >= 2) — on the client side only its 0x800
 * data, never the 0x22 heartbeat — else 0. `flowLen` is 4 for client
 * data (0x20 / 0x800) with its uncounted flow word, else 0.
 */
export function checksum1999(packet: Uint8Array, xor = 0, flowLen = 0): number {
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = v.getUint32(4, true);
  let sum = headerHash1999(packet);
  let o = HEADER_SIZE_1999;
  if (flowLen) {
    sum += magic1999(packet.subarray(o, o + flowLen), false);
    o += flowLen;
  }
  // A packet without the checksum flag (the server's bare 0x4000 AckSequence) hashes its
  // body plainly, options and all; the option-with-length form needs the flag (measured).
  const opt = flags & F1999.Checksum ? optionBytes1999(flags) : 0;
  const fragments = (flags & (0x4 | F1999.Referral)) !== 0;
  if (!opt && !fragments) return (sum + ((magic1999(packet.subarray(o), false) ^ xor) >>> 0)) >>> 0;
  let rest = 0;
  if (opt) {
    rest = magic1999(packet.subarray(o, o + opt), true);
    o += opt;
  }
  if (fragments) {
    const body = packet.subarray(o);
    let f = 0;
    while (f + FRAGMENT_HEADER_SIZE_1999 <= body.length) {
      const size = body[f + 10] | (body[f + 11] << 8);
      if (size < FRAGMENT_HEADER_SIZE_1999 || f + size > body.length) break;
      rest = (rest + magic1999(body.subarray(f, f + FRAGMENT_HEADER_SIZE_1999), true)
        + magic1999(body.subarray(f + FRAGMENT_HEADER_SIZE_1999, f + size), true)) >>> 0;
      f += size;
    }
  }
  return (sum + ((rest ^ xor) >>> 0)) >>> 0;
}

/**
 * The ISAAC word that keys a sequenced packet's checksum: isaac[seq-2] of a
 * zero-seeded stream (the grant's seeds are 0 both ways). Measured:
 * server isaac[0] = 0x182600f3, isaac[1] = 0x300b4a8d; the client's own
 * outbound stream is the same sequence.
 */
export class Isaac1999Keys {
  private readonly words: number[] = [];
  constructor(private readonly next: () => number) {}
  forSequence(seq: number): number {
    if (seq < 2) return 0;
    while (this.words.length <= seq - 2) this.words.push(this.next() >>> 0);
    return this.words[seq - 2];
  }
}

/**
 * Build a packet. `body` is everything after the header; `flowWord` (client
 * data carriers) goes first and is not counted in `size` nor hashed as a fragment.
 */
export function buildPacket1999(opts: {
  sequence: number; flags: number; recipient: number; time: number; body?: Uint8Array; flowWord?: number; xor?: number;
}): Uint8Array {
  const body = opts.body ?? new Uint8Array(0);
  const flowLen = opts.flowWord === undefined ? 0 : 4;
  const out = new Uint8Array(HEADER_SIZE_1999 + flowLen + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, opts.sequence >>> 0, true);
  v.setUint32(4, opts.flags >>> 0, true);
  v.setUint32(8, opts.recipient >>> 0, true);
  v.setUint16(16, body.length, true);
  v.setUint8(18, opts.time & 0xff);
  v.setUint8(19, 0);
  if (flowLen) v.setUint32(HEADER_SIZE_1999, opts.flowWord! >>> 0, true);
  out.set(body, HEADER_SIZE_1999 + flowLen);
  v.setUint32(12, checksum1999(out, opts.xor ?? 0, flowLen), true);
  return out;
}

export interface Fragment1999 {
  sequence: number;
  id: number;
  count: number;
  index: number;
  group: number;
  data: Uint8Array;
}

/** The fragments in a server→client 0x800 body (in order). */
export function readFragments1999(body: Uint8Array): Fragment1999[] {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Fragment1999[] = [];
  let o = 0;
  while (o + FRAGMENT_HEADER_SIZE_1999 <= body.length) {
    const size = v.getUint16(o + 10, true);
    if (size < FRAGMENT_HEADER_SIZE_1999 || o + size > body.length) break;
    out.push({
      sequence: v.getUint32(o, true),
      id: v.getUint32(o + 4, true),
      count: v.getUint16(o + 8, true),
      index: v.getUint16(o + 12, true),
      group: v.getUint16(o + 14, true),
      data: body.slice(o + FRAGMENT_HEADER_SIZE_1999, o + size),
    });
    o += size;
  }
  return out;
}

/** Split one message into fragments (client stride 0x1BC), serialized back to back. */
export function fragmentMessage1999(message: Uint8Array, fragmentSequence: number, group: number): Uint8Array[] {
  const count = Math.max(1, Math.ceil(message.length / MAX_C2S_FRAGMENT_DATA_1999));
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = message.subarray(i * MAX_C2S_FRAGMENT_DATA_1999, (i + 1) * MAX_C2S_FRAGMENT_DATA_1999);
    const f = new Uint8Array(FRAGMENT_HEADER_SIZE_1999 + chunk.length);
    const v = new DataView(f.buffer);
    v.setUint32(0, fragmentSequence >>> 0, true);
    v.setUint32(4, FRAGMENT_ID_1999, true);
    v.setUint16(8, count, true);
    v.setUint16(10, f.length, true);
    v.setUint16(12, i, true);
    v.setUint16(14, group, true);
    f.set(chunk, FRAGMENT_HEADER_SIZE_1999);
    out.push(f);
  }
  return out;
}

/** A [u32 len][u32 count][u32 seq × count] list body (the 0x8 resend list; the server's ack shape). */
export function buildSeqList1999(seqs: number[]): Uint8Array {
  const out = new Uint8Array(8 + seqs.length * 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, seqs.length * 4 + 4, true);
  v.setUint32(4, seqs.length, true);
  seqs.forEach((s, i) => v.setUint32(8 + i * 4, s >>> 0, true));
  return out;
}

/** Read a [u32 flow/len][u32 count][seqs] list; null when the body doesn't hold one. */
export function readSeqList1999(body: Uint8Array): number[] | null {
  if (body.length < 8) return null;
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = v.getUint32(4, true);
  if (count > 0x71 || body.length < 8 + count * 4) return null;
  return Array.from({ length: count }, (_, i) => v.getUint32(8 + i * 4, true));
}
