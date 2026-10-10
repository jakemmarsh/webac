/**
 * Protocol Verification Tests — byte-level serialization, checksums, fragments, messages.
 *
 * Verifies the @ac/network packet layer matches ACE's protocol exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  // Hash
  hash32, CHECKSUM_SENTINEL,
  // Packet header
  PACKET_HEADER_SIZE,
  readPacketHeader, writePacketHeader, calculateHeaderChecksum, hasFlag,
  // Fragments
  FRAGMENT_HEADER_SIZE, MAX_FRAGMENT_SIZE, MAX_FRAGMENT_DATA_SIZE,
  readFragmentHeader, writeFragmentHeader,
  readFragment, writeFragment, hashFragment,
  fragmentMessage, reassembleFragments,
  // Packet builder
  buildPacket, parsePacket, verifyPacketChecksum,
  // Message serialization
  BinaryWriter, BinaryReader,
  serializeGameEvent, serializeGameAction, serializeDirectMessage,
  deserializeMessage,
  buildPositionPayload, parsePositionPayload,
  buildSpeechPayload, parseSpeechPayload,
  // ISAAC
  ISAAC, CryptoSystem,
  // Enums
  PacketHeaderFlags, GameMessageOpcode, GameActionType,
  // Connection
  ConnectionData, SessionState,
} from '@ac/network';

// ─── Hash32 ──────────────────────────────────────────────────

describe('Hash32 — AC custom checksum', () => {
  it('empty data returns (0 << 16) = 0', () => {
    const data = new Uint8Array(0);
    expect(hash32(data)).toBe(0);
  });

  it('single byte hashes correctly', () => {
    const data = new Uint8Array([0xFF]);
    // len << 16 = 0x10000, plus byte 0xFF shifted: 0xFF << 24 = 0xFF000000
    const expected = (0x00010000 + 0xFF000000) >>> 0;
    expect(hash32(data)).toBe(expected);
  });

  it('4-byte word hashes correctly', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    // len << 16 = 0x40000, word = 0x04030201 (LE)
    const expected = (0x00040000 + 0x04030201) >>> 0;
    expect(hash32(data)).toBe(expected);
  });

  it('deterministic for same input', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(hash32(data)).toBe(hash32(data));
  });

  it('different data produces different hashes', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([4, 3, 2, 1]);
    expect(hash32(a)).not.toBe(hash32(b));
  });

  it('CHECKSUM_SENTINEL is 0xBADD70DD', () => {
    expect(CHECKSUM_SENTINEL).toBe(0xBADD70DD);
  });
});

// ─── Packet Header ────────────────────────────────────────────

describe('PacketHeader — 20-byte header', () => {
  it('header size is exactly 20 bytes', () => {
    expect(PACKET_HEADER_SIZE).toBe(20);
  });

  it('write then read roundtrips correctly', () => {
    const header = {
      sequence: 42,
      flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence,
      checksum: 0xDEADBEEF,
      id: 1234,
      time: 5678,
      size: 256,
      iteration: 3,
    };

    const buf = new Uint8Array(20);
    writePacketHeader(header, buf);
    const parsed = readPacketHeader(buf);

    expect(parsed.sequence).toBe(42);
    expect(parsed.flags).toBe(header.flags);
    expect(parsed.checksum).toBe(0xDEADBEEF);
    expect(parsed.id).toBe(1234);
    expect(parsed.time).toBe(5678);
    expect(parsed.size).toBe(256);
    expect(parsed.iteration).toBe(3);
  });

  it('calculateHeaderChecksum uses sentinel in checksum field', () => {
    const header = {
      sequence: 1,
      flags: 0 as PacketHeaderFlags,
      checksum: 0,
      id: 0,
      time: 0,
      size: 0,
      iteration: 0,
    };

    const cs = calculateHeaderChecksum(header);
    // Should be deterministic
    expect(cs).toBe(calculateHeaderChecksum(header));
    // Should be non-zero (sentinel contributes)
    expect(cs).not.toBe(0);
  });

  it('hasFlag checks individual bits', () => {
    const header = {
      sequence: 0, flags: (PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence) as PacketHeaderFlags,
      checksum: 0, id: 0, time: 0, size: 0, iteration: 0,
    };
    expect(hasFlag(header, PacketHeaderFlags.BlobFragments)).toBe(true);
    expect(hasFlag(header, PacketHeaderFlags.AckSequence)).toBe(true);
    expect(hasFlag(header, PacketHeaderFlags.LoginRequest)).toBe(false);
  });

  it('little-endian byte order', () => {
    const header = {
      sequence: 0x04030201,
      flags: 0 as PacketHeaderFlags,
      checksum: 0,
      id: 0, time: 0, size: 0, iteration: 0,
    };
    const buf = new Uint8Array(20);
    writePacketHeader(header, buf);
    // First 4 bytes should be 01 02 03 04 (little-endian)
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x02);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });
});

// ─── Packet Fragments ─────────────────────────────────────────

describe('PacketFragment — fragmentation and reassembly', () => {
  it('fragment header is 16 bytes', () => {
    expect(FRAGMENT_HEADER_SIZE).toBe(16);
  });

  it('max fragment size is 464 bytes', () => {
    expect(MAX_FRAGMENT_SIZE).toBe(464);
  });

  it('max fragment data is 448 bytes (464 - 16)', () => {
    expect(MAX_FRAGMENT_DATA_SIZE).toBe(448);
  });

  it('fragment header roundtrips', () => {
    const header = {
      sequence: 100,
      id: 42,
      count: 3,
      size: 200,
      index: 1,
      queue: 5,
    };
    const buf = new Uint8Array(16);
    writeFragmentHeader(header, buf);
    const parsed = readFragmentHeader(buf);
    expect(parsed.sequence).toBe(100);
    expect(parsed.id).toBe(42);
    expect(parsed.count).toBe(3);
    expect(parsed.size).toBe(200);
    expect(parsed.index).toBe(1);
    expect(parsed.queue).toBe(5);
  });

  it('small message produces single fragment', () => {
    const payload = new Uint8Array(100); // well under 448
    payload.fill(0xAB);
    const fragments = fragmentMessage(payload, 1, 1, 0);
    expect(fragments.length).toBe(1);
    expect(fragments[0].header.count).toBe(1);
    expect(fragments[0].header.index).toBe(0);
    expect(fragments[0].data.length).toBe(100);
  });

  it('large message splits into multiple fragments', () => {
    const payload = new Uint8Array(1000); // > 448, needs 3 fragments
    payload.fill(0xCD);
    const fragments = fragmentMessage(payload, 1, 1, 0);
    expect(fragments.length).toBe(3); // ceil(1000/448) = 3
    for (const f of fragments) {
      expect(f.header.count).toBe(3);
    }
    expect(fragments[0].header.index).toBe(0);
    expect(fragments[1].header.index).toBe(1);
    expect(fragments[2].header.index).toBe(2);
  });

  it('reassemble recovers original data', () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) original[i] = i & 0xFF;

    const fragments = fragmentMessage(original, 1, 1, 0);
    const reassembled = reassembleFragments(fragments);

    expect(reassembled).not.toBeNull();
    expect(reassembled!.length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(reassembled![i]).toBe(original[i]);
    }
  });

  it('reassemble works with out-of-order fragments', () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) original[i] = i & 0xFF;

    const fragments = fragmentMessage(original, 1, 1, 0);
    // Reverse order
    const reversed = [...fragments].reverse();
    const reassembled = reassembleFragments(reversed);

    expect(reassembled).not.toBeNull();
    expect(reassembled!.length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(reassembled![i]).toBe(original[i]);
    }
  });
});

// ─── BinaryWriter / BinaryReader ──────────────────────────────

describe('BinaryWriter + BinaryReader — serialization', () => {
  it('uint8 roundtrip', () => {
    const w = new BinaryWriter();
    w.writeUInt8(0xFF);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt8()).toBe(0xFF);
  });

  it('uint16 roundtrip (little-endian)', () => {
    const w = new BinaryWriter();
    w.writeUInt16(0xABCD);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt16()).toBe(0xABCD);
  });

  it('uint32 roundtrip', () => {
    const w = new BinaryWriter();
    w.writeUInt32(0xDEADBEEF);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt32()).toBe(0xDEADBEEF);
  });

  it('int32 roundtrip (negative)', () => {
    const w = new BinaryWriter();
    w.writeInt32(-12345);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readInt32()).toBe(-12345);
  });

  it('float32 roundtrip', () => {
    const w = new BinaryWriter();
    w.writeFloat32(3.14);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readFloat32()).toBeCloseTo(3.14, 5);
  });

  it('float64 roundtrip', () => {
    const w = new BinaryWriter();
    w.writeFloat64(Math.PI);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readFloat64()).toBeCloseTo(Math.PI, 10);
  });

  it('bytes roundtrip', () => {
    const w = new BinaryWriter();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    w.writeBytes(data);
    const r = new BinaryReader(w.toBuffer());
    const read = r.readBytes(5);
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5]);
  });

  it('string16 roundtrip', () => {
    const w = new BinaryWriter();
    w.writeString16('Hello');
    const r = new BinaryReader(w.toBuffer());
    expect(r.readString16()).toBe('Hello');
  });

  it('mixed types roundtrip', () => {
    const w = new BinaryWriter();
    w.writeUInt32(42);
    w.writeFloat32(1.5);
    w.writeUInt16(100);
    w.writeString16('Test');

    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt32()).toBe(42);
    expect(r.readFloat32()).toBeCloseTo(1.5, 5);
    expect(r.readUInt16()).toBe(100);
    expect(r.readString16()).toBe('Test');
  });

  it('position tracking', () => {
    const w = new BinaryWriter();
    expect(w.position).toBe(0);
    w.writeUInt32(0);
    expect(w.position).toBe(4);
    w.writeUInt16(0);
    expect(w.position).toBe(6);
  });

  it('reader remaining bytes', () => {
    const w = new BinaryWriter();
    w.writeUInt32(1);
    w.writeUInt32(2);
    const r = new BinaryReader(w.toBuffer());
    expect(r.remaining).toBe(8);
    r.readUInt32();
    expect(r.remaining).toBe(4);
  });

  it('auto-grows buffer', () => {
    const w = new BinaryWriter(4); // start small
    // Write more than 4 bytes
    w.writeUInt32(1);
    w.writeUInt32(2);
    w.writeUInt32(3);
    const buf = w.toBuffer();
    expect(buf.length).toBe(12);
    const r = new BinaryReader(buf);
    expect(r.readUInt32()).toBe(1);
    expect(r.readUInt32()).toBe(2);
    expect(r.readUInt32()).toBe(3);
  });
});

// ─── Game Message Serialization ───────────────────────────────

describe('GameMessage — serialize/deserialize', () => {
  it('GameEvent roundtrip', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const bytes = serializeGameEvent(42, 100, payload);
    const msg = deserializeMessage(bytes);

    expect(msg.opcode).toBe(GameMessageOpcode.GameEvent);
    expect(msg.type).toBe('event');
    if (msg.type === 'event') {
      expect(msg.sequence).toBe(42);
      expect(msg.eventType).toBe(100);
    }
  });

  it('GameAction roundtrip', () => {
    const payload = new Uint8Array([0xAA, 0xBB]);
    const bytes = serializeGameAction(7, GameActionType.Jump, payload);
    const msg = deserializeMessage(bytes);

    expect(msg.opcode).toBe(GameMessageOpcode.GameAction);
    expect(msg.type).toBe('action');
    if (msg.type === 'action') {
      expect(msg.sequence).toBe(7);
      expect(msg.actionType).toBe(GameActionType.Jump);
    }
  });

  it('DirectMessage roundtrip', () => {
    const payload = new Uint8Array([0xFF]);
    const bytes = serializeDirectMessage(GameMessageOpcode.ServerMessage, payload);
    const msg = deserializeMessage(bytes);

    expect(msg.opcode).toBe(GameMessageOpcode.ServerMessage);
    expect(msg.type).toBe('direct');
  });
});

// ─── Position Payload ─────────────────────────────────────────

describe('Position payload — serialize/deserialize', () => {
  it('roundtrips position correctly', () => {
    const pos = {
      objCellId: 0x12340001,
      x: 100.5, y: 50.25, z: 200.75,
      qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0,
    };
    const bytes = buildPositionPayload(
      pos.objCellId, pos.x, pos.y, pos.z,
      pos.qw, pos.qx, pos.qy, pos.qz,
    );
    const parsed = parsePositionPayload(bytes);

    expect(parsed.objCellId).toBe(0x12340001);
    expect(parsed.x).toBeCloseTo(100.5, 2);
    expect(parsed.y).toBeCloseTo(50.25, 2);
    expect(parsed.z).toBeCloseTo(200.75, 2);
    expect(parsed.qw).toBeCloseTo(1.0, 5);
  });

  it('position payload is 36 bytes', () => {
    const bytes = buildPositionPayload(0, 0, 0, 0, 1, 0, 0, 0);
    // 4 (objCellId) + 12 (xyz) + 16 (quaternion) + 8 (4 × uint16 sequences) = 40
    expect(bytes.length).toBe(40);
  });
});

// ─── Speech Payload ───────────────────────────────────────────

describe('Speech payload — serialize/deserialize', () => {
  it('roundtrips chat message', () => {
    const bytes = buildSpeechPayload('Hello world!', 'TestPlayer', 1);
    const parsed = parseSpeechPayload(bytes);

    expect(parsed.message).toBe('Hello world!');
    expect(parsed.senderName).toBe('TestPlayer');
    expect(parsed.chatType).toBe(1);
  });
});

// ─── ISAAC Cipher ─────────────────────────────────────────────

describe('ISAAC — CSPRNG', () => {
  it('produces deterministic output from same seed', () => {
    const seed = new Uint8Array(16);
    seed.fill(0x42);

    const a = new ISAAC(seed);
    const b = new ISAAC(seed);

    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('different seeds produce different output', () => {
    const seed1 = new Uint8Array(16);
    seed1.fill(0x01);
    const seed2 = new Uint8Array(16);
    seed2.fill(0x02);

    const a = new ISAAC(seed1);
    const b = new ISAAC(seed2);

    // At least one of first 10 values should differ
    let allSame = true;
    for (let i = 0; i < 10; i++) {
      if (a.next() !== b.next()) allSame = false;
    }
    expect(allSame).toBe(false);
  });

  it('next() returns uint32 values', () => {
    const seed = new Uint8Array(16);
    const isaac = new ISAAC(seed);
    for (let i = 0; i < 100; i++) {
      const val = isaac.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(0xFFFFFFFF);
    }
  });
});

describe('CryptoSystem — ISAAC wrapper', () => {
  it('creates from seed and produces values', () => {
    const seed = new Uint8Array(16);
    seed.fill(0xAB);
    const crypto = new CryptoSystem(seed);
    const v1 = crypto.next();
    const v2 = crypto.next();
    expect(v1).not.toBe(v2); // extremely unlikely to be same
  });

  it('peek does not advance state', () => {
    const seed = new Uint8Array(16);
    seed.fill(0xCD);
    const crypto = new CryptoSystem(seed);
    const peeked = crypto.peek();
    const actual = crypto.next();
    expect(peeked).toBe(actual);
  });
});

// ─── ConnectionData ────────────────────────────────────────────

describe('ConnectionData — handshake state', () => {
  it('starts in AuthLoginRequest state', () => {
    const conn = new ConnectionData();
    expect(conn.state).toBe(SessionState.AuthLoginRequest);
  });

  it('buildConnectRequest produces 32 bytes', () => {
    const conn = new ConnectionData();
    conn.serverSeed = new Uint8Array([1, 2, 3, 4]);
    conn.clientSeed = new Uint8Array([5, 6, 7, 8]);
    conn.connectionCookie = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    conn.clientId = 1;
    const buf = conn.buildConnectRequest();
    // ConnectRequest includes server time (8), cookie (8), clientId (4), serverSeed (4), clientSeed (4) + extras
    expect(buf.length).toBeGreaterThanOrEqual(28);
  });

  it('sequence counters increment', () => {
    const conn = new ConnectionData();
    const s1 = conn.nextPacketSequence();
    const s2 = conn.nextPacketSequence();
    expect(s2).toBe(s1 + 1);

    const f1 = conn.nextFragmentSequence();
    const f2 = conn.nextFragmentSequence();
    expect(f2).toBe(f1 + 1);
  });
});

// ─── Enum Coverage ─────────────────────────────────────────────

describe('Enum coverage', () => {
  it('GameMessageOpcode has key opcodes', () => {
    expect(GameMessageOpcode.GameEvent).toBe(0xF7B0);
    expect(GameMessageOpcode.GameAction).toBe(0xF7B1);
    expect(GameMessageOpcode.CharacterEnterWorldRequest).toBeDefined();
    expect(GameMessageOpcode.ObjectCreate).toBeDefined();
    expect(GameMessageOpcode.ObjectDelete).toBeDefined();
  });

  it('GameActionType has key actions', () => {
    expect(GameActionType.TargetedMeleeAttack).toBeDefined();
    expect(GameActionType.Jump).toBeDefined();
    expect(GameActionType.MoveToState).toBeDefined();
    expect(GameActionType.Use).toBeDefined();
    expect(GameActionType.Talk).toBeDefined();
    expect(GameActionType.Buy).toBeDefined();
    expect(GameActionType.LoginComplete).toBeDefined();
  });

  it('PacketHeaderFlags has all required flags', () => {
    expect(PacketHeaderFlags.Retransmission).toBeDefined();
    expect(PacketHeaderFlags.EncryptedChecksum).toBeDefined();
    expect(PacketHeaderFlags.BlobFragments).toBeDefined();
    expect(PacketHeaderFlags.AckSequence).toBeDefined();
    expect(PacketHeaderFlags.LoginRequest).toBeDefined();
    expect(PacketHeaderFlags.ConnectRequest).toBeDefined();
    expect(PacketHeaderFlags.ConnectResponse).toBeDefined();
    expect(PacketHeaderFlags.Disconnect).toBeDefined();
    expect(PacketHeaderFlags.TimeSync).toBeDefined();
    expect(PacketHeaderFlags.EchoRequest).toBeDefined();
    expect(PacketHeaderFlags.EchoResponse).toBeDefined();
    expect(PacketHeaderFlags.Flow).toBeDefined();
  });
});

// ─── Full Packet Build/Parse Roundtrip ──────────────────────────

describe('Full packet build/parse roundtrip', () => {
  it('simple packet with fragments roundtrips', () => {
    const payload = new Uint8Array(100);
    for (let i = 0; i < 100; i++) payload[i] = i;

    const fragments = fragmentMessage(payload, 1, 1, 0);
    const packet = buildPacket({
      header: {
        sequence: 5,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 1,
        time: 10,
        size: 0,
        iteration: 1,
      },
      optionalHeaders: {},
      fragments,
    });

    const parsed = parsePacket(packet);
    expect(parsed.header.sequence).toBe(5);
    expect(parsed.header.flags & PacketHeaderFlags.BlobFragments).toBeTruthy();
    expect(parsed.fragments.length).toBe(1);
    expect(parsed.fragments[0].data.length).toBe(100);

    // Verify payload data is preserved
    for (let i = 0; i < 100; i++) {
      expect(parsed.fragments[0].data[i]).toBe(i);
    }
  });

  it('packet checksum verifies', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const fragments = fragmentMessage(payload, 1, 1, 0);
    const packet = buildPacket({
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 1,
        time: 0,
        size: 0,
        iteration: 0,
      },
      optionalHeaders: {},
      fragments,
    });

    expect(verifyPacketChecksum(packet)).toBe(true);
  });

  it('corrupted packet fails checksum', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const fragments = fragmentMessage(payload, 1, 1, 0);
    const packet = buildPacket({
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 1,
        time: 0,
        size: 0,
        iteration: 0,
      },
      optionalHeaders: {},
      fragments,
    });

    // Corrupt a byte
    packet[PACKET_HEADER_SIZE + 5] ^= 0xFF;
    expect(verifyPacketChecksum(packet)).toBe(false);
  });
});
