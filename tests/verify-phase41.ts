/**
 * Phase 41 Verification — Network Packet Layer + Message Serialization
 *
 * Tests:
 * - Hash32 checksum algorithm
 * - PacketHeaderFlags enum values
 * - PacketHeader read/write round-trip
 * - PacketFragment read/write round-trip
 * - Fragment message splitting and reassembly
 * - Full packet build/parse round-trip with checksum verification
 * - Optional headers read/write
 * - GameMessageOpcode enum coverage
 * - GameActionType enum coverage
 * - GameMessageGroup enum coverage
 * - BinaryWriter / BinaryReader round-trip
 * - GameEvent / GameAction / DirectMessage serialization
 * - Position payload serialization
 * - Speech payload serialization
 */
import { describe, it, expect } from 'vitest';
import {
  // Enums
  PacketHeaderFlags,
  GameMessageOpcode,
  GameActionType,
  GameMessageGroup,
  // Hash
  hash32, CHECKSUM_SENTINEL,
  // Packet header
  PACKET_HEADER_SIZE,
  readPacketHeader, writePacketHeader,
  calculateHeaderChecksum, hasFlag,
  // Fragments
  FRAGMENT_HEADER_SIZE, MAX_FRAGMENT_SIZE, MAX_FRAGMENT_DATA_SIZE,
  readFragmentHeader, writeFragmentHeader,
  readFragment, writeFragment, hashFragment,
  fragmentMessage, reassembleFragments,
  // Packet builder
  MAX_SERVER_PACKET_SIZE, MAX_CLIENT_PACKET_SIZE,
  optionalHeadersSize, writeOptionalHeaders, readOptionalHeaders,
  buildPacket, parsePacket, verifyPacketChecksum,
  // Message serialization
  BinaryWriter, BinaryReader,
  serializeGameEvent, serializeGameAction, serializeDirectMessage,
  deserializeMessage,
  buildPositionPayload, parsePositionPayload,
  buildSpeechPayload, parseSpeechPayload,
} from '@ac/network';
import type {
  PacketHeaderData, FragmentHeaderData, Fragment,
  OptionalHeaders, PacketData,
  GameEventMessage, GameActionMessage, DirectMessage, GameMessage,
} from '@ac/network';

// ─── Hash32 ──────────────────────────────────────────────

describe('Hash32', () => {
  it('calculates checksum with length prefix', () => {
    // Empty data: result = (0 << 16) = 0
    const empty = new Uint8Array(0);
    expect(hash32(empty)).toBe(0);
  });

  it('hashes 4-byte aligned data correctly', () => {
    // 4 bytes: checksum = (4 << 16) + value
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const value = new DataView(data.buffer).getUint32(0, true); // 0x04030201
    const expected = ((4 << 16) + value) >>> 0;
    expect(hash32(data)).toBe(expected);
  });

  it('hashes unaligned data with remainder bytes', () => {
    // 5 bytes: (5<<16) + uint32(bytes 0-3) + (byte[4] << 24)
    const data = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const view = new DataView(data.buffer);
    const word = view.getUint32(0, true); // 0x40302010
    const remain = (0x50 << 24) >>> 0;
    const expected = ((5 << 16) + word + remain) >>> 0;
    expect(hash32(data)).toBe(expected);
  });

  it('supports offset and length parameters', () => {
    const data = new Uint8Array([0xFF, 0x01, 0x02, 0x03, 0x04, 0xFF]);
    // Hash bytes 1-4 only (length=4)
    const inner = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(hash32(data, 1, 4)).toBe(hash32(inner));
  });

  it('handles 2-byte remainder correctly', () => {
    // 6 bytes: 1 full word + 2 remainder bytes
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xAA, 0xBB]);
    const view = new DataView(data.buffer);
    const word = view.getUint32(0, true);
    // Remainder: shift=3 for byte[4]=0xAA → 0xAA<<24, shift=2 for byte[5]=0xBB → 0xBB<<16
    const r0 = (0xAA << 24) >>> 0;
    const r1 = (0xBB << 16) >>> 0;
    const expected = ((6 << 16) + word + r0 + r1) >>> 0;
    expect(hash32(data)).toBe(expected);
  });

  it('CHECKSUM_SENTINEL is 0xBADD70DD', () => {
    expect(CHECKSUM_SENTINEL).toBe(0xBADD70DD);
  });
});

// ─── PacketHeaderFlags ──────────────────────────────────

describe('PacketHeaderFlags', () => {
  it('has correct flag values', () => {
    expect(PacketHeaderFlags.None).toBe(0);
    expect(PacketHeaderFlags.Retransmission).toBe(0x00000001);
    expect(PacketHeaderFlags.EncryptedChecksum).toBe(0x00000002);
    expect(PacketHeaderFlags.BlobFragments).toBe(0x00000004);
    expect(PacketHeaderFlags.ServerSwitch).toBe(0x00000100);
    expect(PacketHeaderFlags.RequestRetransmit).toBe(0x00001000);
    expect(PacketHeaderFlags.RejectRetransmit).toBe(0x00002000);
    expect(PacketHeaderFlags.AckSequence).toBe(0x00004000);
    expect(PacketHeaderFlags.Disconnect).toBe(0x00008000);
    expect(PacketHeaderFlags.LoginRequest).toBe(0x00010000);
    expect(PacketHeaderFlags.ConnectRequest).toBe(0x00040000);
    expect(PacketHeaderFlags.ConnectResponse).toBe(0x00080000);
    expect(PacketHeaderFlags.TimeSync).toBe(0x01000000);
    expect(PacketHeaderFlags.EchoRequest).toBe(0x02000000);
    expect(PacketHeaderFlags.EchoResponse).toBe(0x04000000);
    expect(PacketHeaderFlags.Flow).toBe(0x08000000);
  });

  it('supports bitwise combination', () => {
    const combined = PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence;
    expect(combined).toBe(0x00004004);
    expect(combined & PacketHeaderFlags.BlobFragments).toBe(PacketHeaderFlags.BlobFragments);
    expect(combined & PacketHeaderFlags.AckSequence).toBe(PacketHeaderFlags.AckSequence);
    expect(combined & PacketHeaderFlags.Disconnect).toBe(0);
  });
});

// ─── PacketHeader ──────────────────────────────────────

describe('PacketHeader', () => {
  it('PACKET_HEADER_SIZE is 20', () => {
    expect(PACKET_HEADER_SIZE).toBe(20);
  });

  it('round-trips read/write correctly', () => {
    const header: PacketHeaderData = {
      sequence: 42,
      flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence,
      checksum: 0x12345678,
      id: 100,
      time: 200,
      size: 300,
      iteration: 5,
    };

    const buf = new Uint8Array(PACKET_HEADER_SIZE);
    writePacketHeader(header, buf);
    const parsed = readPacketHeader(buf);

    expect(parsed.sequence).toBe(42);
    expect(parsed.flags).toBe(PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence);
    expect(parsed.checksum).toBe(0x12345678);
    expect(parsed.id).toBe(100);
    expect(parsed.time).toBe(200);
    expect(parsed.size).toBe(300);
    expect(parsed.iteration).toBe(5);
  });

  it('writes correct byte layout (little-endian)', () => {
    const header: PacketHeaderData = {
      sequence: 1,
      flags: PacketHeaderFlags.BlobFragments, // 0x00000004
      checksum: 0xDEADBEEF,
      id: 0x1234,
      time: 0x5678,
      size: 0x0100,
      iteration: 0x0001,
    };

    const buf = new Uint8Array(PACKET_HEADER_SIZE);
    writePacketHeader(header, buf);
    const view = new DataView(buf.buffer);

    expect(view.getUint32(0, true)).toBe(1);           // sequence
    expect(view.getUint32(4, true)).toBe(0x00000004);   // flags
    expect(view.getUint32(8, true)).toBe(0xDEADBEEF);   // checksum
    expect(view.getUint16(12, true)).toBe(0x1234);       // id
    expect(view.getUint16(14, true)).toBe(0x5678);       // time
    expect(view.getUint16(16, true)).toBe(0x0100);       // size
    expect(view.getUint16(18, true)).toBe(0x0001);       // iteration
  });

  it('calculateHeaderChecksum uses sentinel value', () => {
    const header: PacketHeaderData = {
      sequence: 10,
      flags: PacketHeaderFlags.BlobFragments,
      checksum: 0x99999999, // should be replaced by sentinel
      id: 1,
      time: 2,
      size: 0,
      iteration: 3,
    };

    const cs1 = calculateHeaderChecksum(header);
    // Change checksum to something else — should give same result
    header.checksum = 0x11111111;
    const cs2 = calculateHeaderChecksum(header);
    expect(cs1).toBe(cs2);
  });

  it('hasFlag checks individual flags', () => {
    const header: PacketHeaderData = {
      sequence: 0,
      flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.AckSequence,
      checksum: 0, id: 0, time: 0, size: 0, iteration: 0,
    };

    expect(hasFlag(header, PacketHeaderFlags.BlobFragments)).toBe(true);
    expect(hasFlag(header, PacketHeaderFlags.AckSequence)).toBe(true);
    expect(hasFlag(header, PacketHeaderFlags.Disconnect)).toBe(false);
    expect(hasFlag(header, PacketHeaderFlags.None)).toBe(false);
  });
});

// ─── PacketFragment ─────────────────────────────────────

describe('PacketFragment', () => {
  it('constants are correct', () => {
    expect(FRAGMENT_HEADER_SIZE).toBe(16);
    expect(MAX_FRAGMENT_SIZE).toBe(464);
    expect(MAX_FRAGMENT_DATA_SIZE).toBe(448);
  });

  it('round-trips fragment header read/write', () => {
    const header: FragmentHeaderData = {
      sequence: 100,
      id: 0xABCD0001,
      count: 3,
      size: 100,
      index: 1,
      queue: GameMessageGroup.WeenieQueue,
    };

    const buf = new Uint8Array(FRAGMENT_HEADER_SIZE);
    writeFragmentHeader(header, buf);
    const parsed = readFragmentHeader(buf);

    expect(parsed.sequence).toBe(100);
    expect(parsed.id).toBe(0xABCD0001);
    expect(parsed.count).toBe(3);
    expect(parsed.size).toBe(100);
    expect(parsed.index).toBe(1);
    expect(parsed.queue).toBe(GameMessageGroup.WeenieQueue);
  });

  it('round-trips complete fragment (header + data)', () => {
    const fragData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fragment: Fragment = {
      header: {
        sequence: 1,
        id: 42,
        count: 1,
        size: FRAGMENT_HEADER_SIZE + fragData.length,
        index: 0,
        queue: GameMessageGroup.EventQueue,
      },
      data: fragData,
    };

    const buf = new Uint8Array(FRAGMENT_HEADER_SIZE + fragData.length);
    writeFragment(fragment, buf);
    const parsed = readFragment(buf);

    expect(parsed.header.sequence).toBe(1);
    expect(parsed.header.id).toBe(42);
    expect(parsed.header.count).toBe(1);
    expect(parsed.header.size).toBe(FRAGMENT_HEADER_SIZE + 8);
    expect(parsed.header.index).toBe(0);
    expect(parsed.data).toEqual(fragData);
  });

  it('hashFragment produces consistent checksum', () => {
    const fragment: Fragment = {
      header: {
        sequence: 5,
        id: 99,
        count: 1,
        size: FRAGMENT_HEADER_SIZE + 4,
        index: 0,
        queue: GameMessageGroup.ControlQueue,
      },
      data: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
    };

    const h1 = hashFragment(fragment);
    const h2 = hashFragment(fragment);
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThan(0);
  });
});

// ─── Fragment Message Splitting / Reassembly ─────────────

describe('fragmentMessage / reassembleFragments', () => {
  it('small message produces single fragment', () => {
    const payload = new Uint8Array(100);
    payload.fill(0xAB);

    const fragments = fragmentMessage(payload, 1, GameMessageGroup.WeenieQueue, 0);
    expect(fragments.length).toBe(1);
    expect(fragments[0].header.count).toBe(1);
    expect(fragments[0].header.index).toBe(0);
    expect(fragments[0].header.id).toBe(1);
    expect(fragments[0].data).toEqual(payload);
  });

  it('large message splits into multiple fragments', () => {
    // 1000 bytes > 448 MAX_FRAGMENT_DATA_SIZE → 3 fragments
    const payload = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) payload[i] = i & 0xFF;

    const fragments = fragmentMessage(payload, 42, GameMessageGroup.EventQueue, 10);
    expect(fragments.length).toBe(3); // ceil(1000/448) = 3

    // First fragment: 448 bytes
    expect(fragments[0].data.length).toBe(448);
    expect(fragments[0].header.index).toBe(0);
    expect(fragments[0].header.count).toBe(3);
    expect(fragments[0].header.sequence).toBe(10);

    // BUG.8 — every fragment of one message shares the SAME fragment
    // sequence (ACE MessageFragment.cs:93 stamps the message's Sequence on
    // each piece; ACE's receive side buckets partials by it,
    // NetworkSession.cs:495). The old expectation (10,11,12) pinned a
    // divergence that made count>1 outbound messages unassemblable by ACE.
    // Second fragment: 448 bytes
    expect(fragments[1].data.length).toBe(448);
    expect(fragments[1].header.index).toBe(1);
    expect(fragments[1].header.sequence).toBe(10);

    // Third fragment: 104 bytes (1000 - 448 - 448)
    expect(fragments[2].data.length).toBe(104);
    expect(fragments[2].header.index).toBe(2);
    expect(fragments[2].header.sequence).toBe(10);
  });

  it('reassembles fragments in order', () => {
    const payload = new Uint8Array(600);
    for (let i = 0; i < 600; i++) payload[i] = i & 0xFF;

    const fragments = fragmentMessage(payload, 1, GameMessageGroup.WeenieQueue, 0);
    const reassembled = reassembleFragments(fragments);

    expect(reassembled).not.toBeNull();
    expect(reassembled!.length).toBe(600);
    expect(reassembled).toEqual(payload);
  });

  it('reassembles out-of-order fragments', () => {
    const payload = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) payload[i] = (i * 7) & 0xFF;

    const fragments = fragmentMessage(payload, 1, GameMessageGroup.WeenieQueue, 0);
    // Shuffle fragments
    const shuffled = [fragments[2], fragments[0], fragments[1]];
    const reassembled = reassembleFragments(shuffled);

    expect(reassembled).not.toBeNull();
    expect(reassembled).toEqual(payload);
  });

  it('returns null for incomplete fragments', () => {
    const payload = new Uint8Array(1000);
    const fragments = fragmentMessage(payload, 1, GameMessageGroup.WeenieQueue, 0);
    // Remove one fragment
    const incomplete = [fragments[0], fragments[2]]; // missing index 1
    expect(reassembleFragments(incomplete)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(reassembleFragments([])).toBeNull();
  });
});

// ─── Full Packet Build / Parse ──────────────────────────

describe('Packet build/parse round-trip', () => {
  it('builds and parses packet with fragments', () => {
    const fragData = new Uint8Array([10, 20, 30, 40]);
    const fragment: Fragment = {
      header: {
        sequence: 1,
        id: 99,
        count: 1,
        size: FRAGMENT_HEADER_SIZE + fragData.length,
        index: 0,
        queue: GameMessageGroup.WeenieQueue,
      },
      data: fragData,
    };

    const packet: PacketData = {
      header: {
        sequence: 5,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0, // will be calculated
        id: 1,
        time: 100,
        size: 0, // will be calculated
        iteration: 1,
      },
      optionalHeaders: {},
      fragments: [fragment],
    };

    const buf = buildPacket(packet);
    expect(buf.length).toBe(PACKET_HEADER_SIZE + FRAGMENT_HEADER_SIZE + fragData.length);

    const parsed = parsePacket(buf);
    expect(parsed.header.sequence).toBe(5);
    expect(parsed.header.flags).toBe(PacketHeaderFlags.BlobFragments);
    expect(parsed.fragments.length).toBe(1);
    expect(parsed.fragments[0].data).toEqual(fragData);
    expect(parsed.fragments[0].header.id).toBe(99);
  });

  it('verifies checksum on built packet', () => {
    const fragment: Fragment = {
      header: {
        sequence: 1,
        id: 1,
        count: 1,
        size: FRAGMENT_HEADER_SIZE + 8,
        index: 0,
        queue: GameMessageGroup.EventQueue,
      },
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };

    const packet: PacketData = {
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments: [fragment],
    };

    const buf = buildPacket(packet);
    expect(verifyPacketChecksum(buf)).toBe(true);

    // Corrupt one byte — checksum should fail
    const corrupted = new Uint8Array(buf);
    corrupted[PACKET_HEADER_SIZE + FRAGMENT_HEADER_SIZE] ^= 0xFF;
    expect(verifyPacketChecksum(corrupted)).toBe(false);
  });

  it('builds packet with ack sequence', () => {
    const packet: PacketData = {
      header: {
        sequence: 10,
        flags: PacketHeaderFlags.AckSequence,
        checksum: 0,
        id: 2, time: 50, size: 0, iteration: 1,
      },
      optionalHeaders: { ackSequence: 42 },
      fragments: [],
    };

    const buf = buildPacket(packet);
    const parsed = parsePacket(buf);
    expect(parsed.optionalHeaders.ackSequence).toBe(42);
    expect(verifyPacketChecksum(buf)).toBe(true);
  });

  it('builds packet with multiple optional headers', () => {
    const flags = PacketHeaderFlags.AckSequence | PacketHeaderFlags.TimeSync | PacketHeaderFlags.Flow;
    const packet: PacketData = {
      header: {
        sequence: 1,
        flags,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {
        ackSequence: 100,
        timeSync: 12345.6789,
        flowBytes: 1024,
        flowInterval: 50,
      },
      fragments: [],
    };

    const buf = buildPacket(packet);
    const parsed = parsePacket(buf);
    expect(parsed.optionalHeaders.ackSequence).toBe(100);
    expect(parsed.optionalHeaders.timeSync).toBeCloseTo(12345.6789, 3);
    expect(parsed.optionalHeaders.flowBytes).toBe(1024);
    expect(parsed.optionalHeaders.flowInterval).toBe(50);
    expect(verifyPacketChecksum(buf)).toBe(true);
  });

  it('builds packet with request retransmit sequences', () => {
    const packet: PacketData = {
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.RequestRetransmit,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {
        retransmitSequences: [5, 10, 15],
      },
      fragments: [],
    };

    const buf = buildPacket(packet);
    const parsed = parsePacket(buf);
    expect(parsed.optionalHeaders.retransmitSequences).toEqual([5, 10, 15]);
    expect(verifyPacketChecksum(buf)).toBe(true);
  });
});

// ─── Optional Headers Size Calculation ──────────────────

describe('optionalHeadersSize', () => {
  it('returns 0 for no flags', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.None, {})).toBe(0);
  });

  it('returns correct size for ackSequence', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.AckSequence, {})).toBe(4);
  });

  it('returns correct size for timeSync', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.TimeSync, {})).toBe(8);
  });

  it('returns correct size for echoRequest', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.EchoRequest, {})).toBe(4);
  });

  it('returns correct size for echoResponse', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.EchoResponse, {})).toBe(12);
  });

  it('returns correct size for flow', () => {
    expect(optionalHeadersSize(PacketHeaderFlags.Flow, {})).toBe(6);
  });

  it('returns correct size for requestRetransmit with sequences', () => {
    const size = optionalHeadersSize(PacketHeaderFlags.RequestRetransmit, {
      retransmitSequences: [1, 2, 3],
    });
    expect(size).toBe(4 + 3 * 4); // count + 3 uint32s
  });

  it('sums multiple optional headers', () => {
    const flags = PacketHeaderFlags.AckSequence | PacketHeaderFlags.TimeSync;
    expect(optionalHeadersSize(flags, {})).toBe(4 + 8);
  });
});

// ─── Constants ──────────────────────────────────────────

describe('Packet constants', () => {
  it('MAX_SERVER_PACKET_SIZE is 464', () => {
    expect(MAX_SERVER_PACKET_SIZE).toBe(464);
  });

  it('MAX_CLIENT_PACKET_SIZE is 1024', () => {
    expect(MAX_CLIENT_PACKET_SIZE).toBe(1024);
  });

  it('MAX_FRAGMENT_DATA_SIZE = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE', () => {
    expect(MAX_FRAGMENT_DATA_SIZE).toBe(MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE);
  });
});

// ─── GameMessageOpcode ──────────────────────────────────

describe('GameMessageOpcode', () => {
  it('has core opcodes', () => {
    expect(GameMessageOpcode.None).toBe(0x0000);
    expect(GameMessageOpcode.ObjectCreate).toBe(0xF745);
    expect(GameMessageOpcode.PlayerCreate).toBe(0xF746);
    expect(GameMessageOpcode.ObjectDelete).toBe(0xF747);
    expect(GameMessageOpcode.UpdatePosition).toBe(0xF748);
    expect(GameMessageOpcode.MovementEvent).toBe(0xF74C);
    expect(GameMessageOpcode.GameEvent).toBe(0xF7B0);
    expect(GameMessageOpcode.GameAction).toBe(0xF7B1);
  });

  it('has character management opcodes', () => {
    expect(GameMessageOpcode.CharacterCreateResponse).toBe(0xF643);
    expect(GameMessageOpcode.CharacterList).toBe(0xF658);
    expect(GameMessageOpcode.CharacterEnterWorld).toBe(0xF657);
    expect(GameMessageOpcode.CharacterDelete).toBe(0xF655);
    expect(GameMessageOpcode.CharacterError).toBe(0xF659);
  });

  it('has property update opcodes', () => {
    expect(GameMessageOpcode.PrivateUpdatePropertyInt).toBe(0x02CD);
    expect(GameMessageOpcode.PublicUpdatePropertyInt).toBe(0x02CE);
    expect(GameMessageOpcode.PrivateUpdatePropertyFloat).toBe(0x02D3);
    expect(GameMessageOpcode.PrivateUpdatePropertyString).toBe(0x02D5);
    expect(GameMessageOpcode.PrivateUpdatePropertyDataID).toBe(0x02D7);
    expect(GameMessageOpcode.PrivateUpdatePropertyInstanceID).toBe(0x02D9);
  });

  it('has at least 40 opcodes', () => {
    const opcodeCount = Object.keys(GameMessageOpcode)
      .filter(k => typeof GameMessageOpcode[k as keyof typeof GameMessageOpcode] === 'number')
      .length;
    expect(opcodeCount).toBeGreaterThanOrEqual(40);
  });
});

// ─── GameActionType ─────────────────────────────────────

describe('GameActionType', () => {
  it('has combat action types', () => {
    expect(GameActionType.TargetedMeleeAttack).toBe(0x0008);
    expect(GameActionType.TargetedMissileAttack).toBe(0x000A);
    expect(GameActionType.CastTargetedSpell).toBe(0x004A);
    expect(GameActionType.CastUntargetedSpell).toBe(0x0048);
    expect(GameActionType.ChangeCombatMode).toBe(0x0053);
    expect(GameActionType.CancelAttack).toBe(0x01B7);
  });

  it('has inventory action types', () => {
    expect(GameActionType.PutItemInContainer).toBe(0x0019);
    expect(GameActionType.GetAndWieldItem).toBe(0x001A);
    expect(GameActionType.DropItem).toBe(0x001B);
    expect(GameActionType.StackableMerge).toBe(0x0054);
    expect(GameActionType.StackableSplitToContainer).toBe(0x0055);
    expect(GameActionType.Use).toBe(0x0036);
    expect(GameActionType.UseWithTarget).toBe(0x0035);
  });

  it('has social action types', () => {
    expect(GameActionType.Talk).toBe(0x0015);
    expect(GameActionType.Tell).toBe(0x005D);
    expect(GameActionType.Emote).toBe(0x01DF);
    expect(GameActionType.FellowshipCreate).toBe(0x00A2);
    expect(GameActionType.FellowshipRecruit).toBe(0x00A5);
    expect(GameActionType.SwearAllegiance).toBe(0x001D);
    expect(GameActionType.BreakAllegiance).toBe(0x001E);
  });

  it('has vendor/trade action types', () => {
    expect(GameActionType.Buy).toBe(0x005F);
    expect(GameActionType.Sell).toBe(0x0060);
    expect(GameActionType.OpenTradeNegotiations).toBe(0x01F6);
    expect(GameActionType.AcceptTrade).toBe(0x01FA);
    expect(GameActionType.DeclineTrade).toBe(0x01FB);
  });

  it('has housing action types', () => {
    expect(GameActionType.BuyHouse).toBe(0x021C);
    expect(GameActionType.AbandonHouse).toBe(0x021F);
    expect(GameActionType.RentHouse).toBe(0x0221);
    expect(GameActionType.TeleToHouse).toBe(0x0262);
    expect(GameActionType.AddPermanentGuest).toBe(0x0245);
    expect(GameActionType.BootEveryone).toBe(0x025F);
  });

  it('has movement action types', () => {
    expect(GameActionType.Jump).toBe(0xF61B);
    expect(GameActionType.MoveToState).toBe(0xF61C);
    expect(GameActionType.TurnTo).toBe(0xF649);
  });

  it('has at least 100 action types', () => {
    const actionCount = Object.keys(GameActionType)
      .filter(k => typeof GameActionType[k as keyof typeof GameActionType] === 'number')
      .length;
    expect(actionCount).toBeGreaterThanOrEqual(100);
  });
});

// ─── GameMessageGroup ───────────────────────────────────

describe('GameMessageGroup', () => {
  it('has all queue types', () => {
    expect(GameMessageGroup.InvalidQueue).toBe(0x00);
    expect(GameMessageGroup.EventQueue).toBe(0x01);
    expect(GameMessageGroup.ControlQueue).toBe(0x02);
    expect(GameMessageGroup.WeenieQueue).toBe(0x03);
    expect(GameMessageGroup.LoginQueue).toBe(0x04);
    expect(GameMessageGroup.DatabaseQueue).toBe(0x05);
    expect(GameMessageGroup.SecureControlQueue).toBe(0x06);
    expect(GameMessageGroup.SecureWeenieQueue).toBe(0x07);
    expect(GameMessageGroup.SecureLoginQueue).toBe(0x08);
    expect(GameMessageGroup.UIQueue).toBe(0x09);
    expect(GameMessageGroup.SmartboxQueue).toBe(0x0A);
    expect(GameMessageGroup.ObserverQueue).toBe(0x0B);
    expect(GameMessageGroup.QueueMax).toBe(0x0C);
  });
});

// ─── BinaryWriter / BinaryReader ────────────────────────

describe('BinaryWriter / BinaryReader', () => {
  it('round-trips uint8', () => {
    const w = new BinaryWriter();
    w.writeUInt8(0); w.writeUInt8(127); w.writeUInt8(255);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt8()).toBe(0);
    expect(r.readUInt8()).toBe(127);
    expect(r.readUInt8()).toBe(255);
  });

  it('round-trips uint16', () => {
    const w = new BinaryWriter();
    w.writeUInt16(0); w.writeUInt16(1000); w.writeUInt16(65535);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt16()).toBe(0);
    expect(r.readUInt16()).toBe(1000);
    expect(r.readUInt16()).toBe(65535);
  });

  it('round-trips uint32', () => {
    const w = new BinaryWriter();
    w.writeUInt32(0); w.writeUInt32(0xDEADBEEF); w.writeUInt32(0xFFFFFFFF);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readUInt32()).toBe(0);
    expect(r.readUInt32()).toBe(0xDEADBEEF);
    expect(r.readUInt32()).toBe(0xFFFFFFFF);
  });

  it('round-trips int32', () => {
    const w = new BinaryWriter();
    w.writeInt32(-1); w.writeInt32(0); w.writeInt32(2147483647);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readInt32()).toBe(-1);
    expect(r.readInt32()).toBe(0);
    expect(r.readInt32()).toBe(2147483647);
  });

  it('round-trips float32', () => {
    const w = new BinaryWriter();
    w.writeFloat32(0); w.writeFloat32(3.14); w.writeFloat32(-1.5);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readFloat32()).toBeCloseTo(0, 5);
    expect(r.readFloat32()).toBeCloseTo(3.14, 2);
    expect(r.readFloat32()).toBeCloseTo(-1.5, 5);
  });

  it('round-trips float64', () => {
    const w = new BinaryWriter();
    w.writeFloat64(0); w.writeFloat64(3.141592653589793); w.writeFloat64(-99.99);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readFloat64()).toBe(0);
    expect(r.readFloat64()).toBe(3.141592653589793);
    expect(r.readFloat64()).toBe(-99.99);
  });

  it('round-trips bytes', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const w = new BinaryWriter();
    w.writeBytes(data);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readBytes(5)).toEqual(data);
  });

  it('round-trips string16 with alignment', () => {
    const w = new BinaryWriter();
    w.writeString16('Hello');
    w.writeString16('AB');
    w.writeUInt32(42); // should be properly aligned

    const r = new BinaryReader(w.toBuffer());
    expect(r.readString16()).toBe('Hello');
    expect(r.readString16()).toBe('AB');
    expect(r.readUInt32()).toBe(42);
  });

  it('auto-grows buffer', () => {
    const w = new BinaryWriter(4); // tiny initial size
    for (let i = 0; i < 100; i++) {
      w.writeUInt32(i);
    }
    const r = new BinaryReader(w.toBuffer());
    for (let i = 0; i < 100; i++) {
      expect(r.readUInt32()).toBe(i);
    }
  });

  it('tracks position and remaining', () => {
    const w = new BinaryWriter();
    w.writeUInt32(1);
    w.writeUInt32(2);
    const buf = w.toBuffer();

    const r = new BinaryReader(buf);
    expect(r.position).toBe(0);
    expect(r.remaining).toBe(8);

    r.readUInt32();
    expect(r.position).toBe(4);
    expect(r.remaining).toBe(4);

    r.skip(2);
    expect(r.position).toBe(6);
    expect(r.remaining).toBe(2);
  });
});

// ─── Message Serialization ──────────────────────────────

describe('Message serialization', () => {
  it('serializes and deserializes GameEvent', () => {
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const buf = serializeGameEvent(42, 0x0022, payload);

    const msg = deserializeMessage(buf);
    expect(msg.type).toBe('event');

    const event = msg as GameEventMessage;
    expect(event.opcode).toBe(GameMessageOpcode.GameEvent);
    expect(event.sequence).toBe(42);
    expect(event.eventType).toBe(0x0022);
    expect(event.payload).toEqual(payload);
  });

  it('serializes and deserializes GameAction', () => {
    const payload = new Uint8Array([0x01, 0x02]);
    const buf = serializeGameAction(10, GameActionType.Use, payload);

    const msg = deserializeMessage(buf);
    expect(msg.type).toBe('action');

    const action = msg as GameActionMessage;
    expect(action.opcode).toBe(GameMessageOpcode.GameAction);
    expect(action.sequence).toBe(10);
    expect(action.actionType).toBe(GameActionType.Use);
    expect(action.payload).toEqual(payload);
  });

  it('serializes and deserializes DirectMessage', () => {
    const payload = new Uint8Array([0xFF]);
    const buf = serializeDirectMessage(GameMessageOpcode.ObjectCreate, payload);

    const msg = deserializeMessage(buf);
    expect(msg.type).toBe('direct');

    const direct = msg as DirectMessage;
    expect(direct.opcode).toBe(GameMessageOpcode.ObjectCreate);
    expect(direct.payload).toEqual(payload);
  });

  it('serializes GameEvent with empty payload', () => {
    const buf = serializeGameEvent(1, 0x0001);
    const msg = deserializeMessage(buf) as GameEventMessage;
    expect(msg.type).toBe('event');
    expect(msg.sequence).toBe(1);
    expect(msg.eventType).toBe(0x0001);
    expect(msg.payload.length).toBe(0);
  });

  it('serializes GameAction with empty payload', () => {
    const buf = serializeGameAction(1, GameActionType.LoginComplete);
    const msg = deserializeMessage(buf) as GameActionMessage;
    expect(msg.type).toBe('action');
    expect(msg.actionType).toBe(GameActionType.LoginComplete);
    expect(msg.payload.length).toBe(0);
  });
});

// ─── Position Payload ───────────────────────────────────

describe('Position payload', () => {
  it('round-trips position data', () => {
    const buf = buildPositionPayload(
      0xA9B4001F,
      100.5, 200.25, 10.0,
      1.0, 0.0, 0.0, 0.0,
      1, 5, 0, 0,
    );

    const pos = parsePositionPayload(buf);
    expect(pos.objCellId).toBe(0xA9B4001F);
    expect(pos.x).toBeCloseTo(100.5, 2);
    expect(pos.y).toBeCloseTo(200.25, 2);
    expect(pos.z).toBeCloseTo(10.0, 2);
    expect(pos.qw).toBeCloseTo(1.0, 5);
    expect(pos.qx).toBeCloseTo(0.0, 5);
    expect(pos.qy).toBeCloseTo(0.0, 5);
    expect(pos.qz).toBeCloseTo(0.0, 5);
    expect(pos.instanceSeq).toBe(1);
    expect(pos.positionSeq).toBe(5);
    expect(pos.teleportSeq).toBe(0);
    expect(pos.forcePositionSeq).toBe(0);
  });

  it('position payload is 40 bytes', () => {
    // 4 (cellId) + 12 (xyz) + 16 (quat) + 8 (4×uint16 sequences) = 40
    const buf = buildPositionPayload(0, 0, 0, 0, 1, 0, 0, 0);
    expect(buf.length).toBe(40);
  });
});

// ─── Speech Payload ─────────────────────────────────────

describe('Speech payload', () => {
  it('round-trips speech data', () => {
    const buf = buildSpeechPayload('Hello world!', 'TestPlayer', 1);
    const parsed = parseSpeechPayload(buf);

    expect(parsed.message).toBe('Hello world!');
    expect(parsed.senderName).toBe('TestPlayer');
    expect(parsed.chatType).toBe(1);
  });

  it('handles empty strings', () => {
    const buf = buildSpeechPayload('', '', 0);
    const parsed = parseSpeechPayload(buf);
    expect(parsed.message).toBe('');
    expect(parsed.senderName).toBe('');
    expect(parsed.chatType).toBe(0);
  });
});

// ─── Integration ────────────────────────────────────────

describe('Integration: full message → fragment → packet → parse', () => {
  it('end-to-end: serialize message, fragment, build packet, parse, reassemble, deserialize', () => {
    // 1. Serialize a game event message
    const eventPayload = new Uint8Array(100);
    for (let i = 0; i < 100; i++) eventPayload[i] = i;
    const msgBytes = serializeGameEvent(7, 0x0022, eventPayload);

    // 2. Fragment the message
    const fragments = fragmentMessage(msgBytes, 1, GameMessageGroup.EventQueue, 0);
    expect(fragments.length).toBe(1); // small enough for 1 fragment

    // 3. Build packet with the fragment
    const packet: PacketData = {
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 1, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments,
    };
    const packetBuf = buildPacket(packet);

    // 4. Verify checksum
    expect(verifyPacketChecksum(packetBuf)).toBe(true);

    // 5. Parse packet back
    const parsed = parsePacket(packetBuf);
    expect(parsed.fragments.length).toBe(1);

    // 6. Reassemble fragments
    const reassembled = reassembleFragments(parsed.fragments);
    expect(reassembled).not.toBeNull();

    // 7. Deserialize message
    const msg = deserializeMessage(reassembled!);
    expect(msg.type).toBe('event');
    const event = msg as GameEventMessage;
    expect(event.sequence).toBe(7);
    expect(event.eventType).toBe(0x0022);
    expect(event.payload).toEqual(eventPayload);
  });

  it('end-to-end with large message spanning multiple fragments', () => {
    // Create a large payload that requires multiple fragments
    const largePayload = new Uint8Array(900);
    for (let i = 0; i < 900; i++) largePayload[i] = (i * 13) & 0xFF;
    const msgBytes = serializeGameAction(99, GameActionType.Talk, largePayload);

    // Fragment
    const fragments = fragmentMessage(msgBytes, 42, GameMessageGroup.WeenieQueue, 100);
    expect(fragments.length).toBeGreaterThan(1);

    // We can't fit multiple fragments in a single 464-byte server packet,
    // but we can build separate packets for each fragment.
    const packetBufs: Uint8Array[] = [];
    for (let i = 0; i < fragments.length; i++) {
      const pkt: PacketData = {
        header: {
          sequence: i + 1,
          flags: PacketHeaderFlags.BlobFragments,
          checksum: 0,
          id: 1, time: 0, size: 0, iteration: 0,
        },
        optionalHeaders: {},
        fragments: [fragments[i]],
      };
      packetBufs.push(buildPacket(pkt));
    }

    // Parse each packet, collect fragments
    const collectedFragments: Fragment[] = [];
    for (const buf of packetBufs) {
      expect(verifyPacketChecksum(buf)).toBe(true);
      const parsed = parsePacket(buf);
      collectedFragments.push(...parsed.fragments);
    }

    // Reassemble
    const reassembled = reassembleFragments(collectedFragments);
    expect(reassembled).not.toBeNull();

    // Deserialize
    const msg = deserializeMessage(reassembled!) as GameActionMessage;
    expect(msg.type).toBe('action');
    expect(msg.sequence).toBe(99);
    expect(msg.actionType).toBe(GameActionType.Talk);
    expect(msg.payload).toEqual(largePayload);
  });
});
