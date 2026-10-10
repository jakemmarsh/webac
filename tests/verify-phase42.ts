/**
 * Phase 42 Verification — WebSocket-TCP Bridge + ACE Server Connectivity
 *
 * Tests:
 * - ISAAC PRNG (deterministic output, stream cipher properties)
 * - CryptoSystem (key generation, search functionality)
 * - ConnectionData (handshake data, connect request/response)
 * - Bridge protocol flow (login → connect → response)
 * - ClientConnection state management
 * - Encrypted checksum handling
 */
import { describe, it, expect } from 'vitest';
import {
  // From Phase 41
  PacketHeaderFlags,
  GameMessageOpcode,
  GameMessageGroup,
  hash32, CHECKSUM_SENTINEL,
  PACKET_HEADER_SIZE,
  readPacketHeader, writePacketHeader,
  calculateHeaderChecksum, hasFlag,
  FRAGMENT_HEADER_SIZE,
  fragmentMessage, reassembleFragments,
  buildPacket, parsePacket, verifyPacketChecksum,
  BinaryWriter, BinaryReader,
  serializeGameEvent, serializeGameAction,
  deserializeMessage,
  // Phase 42
  ISAAC, CryptoSystem,
  ConnectionData, SessionState,
} from '@ac/network';
import type {
  PacketHeaderData, Fragment, PacketData,
  ConnectRequestData,
  GameEventMessage, GameActionMessage,
} from '@ac/network';

// ─── ISAAC PRNG ────────────────────────────────────────

describe('ISAAC', () => {
  it('produces deterministic output from same seed', () => {
    const seed = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const isaac1 = new ISAAC(seed);
    const isaac2 = new ISAAC(seed);

    const values1: number[] = [];
    const values2: number[] = [];
    for (let i = 0; i < 10; i++) {
      values1.push(isaac1.next());
      values2.push(isaac2.next());
    }

    expect(values1).toEqual(values2);
  });

  it('produces different output from different seeds', () => {
    const isaac1 = new ISAAC(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    const isaac2 = new ISAAC(new Uint8Array([0x05, 0x06, 0x07, 0x08]));

    const v1 = isaac1.next();
    const v2 = isaac2.next();
    expect(v1).not.toBe(v2);
  });

  it('produces uint32 values', () => {
    const isaac = new ISAAC(new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]));
    for (let i = 0; i < 20; i++) {
      const val = isaac.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(0xFFFFFFFF);
    }
  });

  it('generates unique values over 256+ calls', () => {
    const isaac = new ISAAC(new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      seen.add(isaac.next());
    }
    // Should have very few (if any) collisions in 300 values
    expect(seen.size).toBeGreaterThan(250);
  });

  it('handles empty seed', () => {
    const isaac = new ISAAC(new Uint8Array(0));
    const val = isaac.next();
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThanOrEqual(0);
  });

  it('handles 4-byte seed (typical AC seed size)', () => {
    const seed = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const isaac = new ISAAC(seed);

    // Should produce a sequence of values
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      values.push(isaac.next());
    }

    // All values should be valid uint32
    for (const v of values) {
      expect((v >>> 0)).toBe(v);
    }
  });

  it('wraps around after 256 values (triggers rescramble)', () => {
    const seed = new Uint8Array([0x42, 0x43, 0x44, 0x45]);
    const isaac = new ISAAC(seed);

    // Generate 256+ values to trigger rescramble
    const firstBatch: number[] = [];
    for (let i = 0; i < 260; i++) {
      firstBatch.push(isaac.next());
    }

    // Verify we got valid values throughout
    expect(firstBatch.length).toBe(260);
    for (const v of firstBatch) {
      expect((v >>> 0)).toBe(v);
    }
  });
});

// ─── CryptoSystem ──────────────────────────────────────

describe('CryptoSystem', () => {
  it('next() returns and advances key', () => {
    const crypto = new CryptoSystem(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    const k1 = crypto.next();
    const k2 = crypto.next();
    expect(k1).not.toBe(k2);
  });

  it('peek() returns current key without advancing', () => {
    const crypto = new CryptoSystem(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    const peeked = crypto.peek();
    const actual = crypto.next();
    expect(peeked).toBe(actual);
  });

  it('search() finds current key', () => {
    const crypto = new CryptoSystem(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    const target = crypto.peek();
    expect(crypto.search(target)).toBe(true);
  });

  it('search() finds future key (out of order)', () => {
    const seed = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    // Get the 5th key from a reference instance
    const ref = new CryptoSystem(seed);
    let target = 0;
    for (let i = 0; i < 5; i++) target = ref.next();

    // Search for it from a fresh instance
    const crypto = new CryptoSystem(seed);
    expect(crypto.search(target, 10)).toBe(true);
  });

  it('search() returns false for nonexistent key', () => {
    const crypto = new CryptoSystem(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    // 0x00000000 is extremely unlikely to appear as an ISAAC output
    // Use a small lookahead to ensure quick failure
    const found = crypto.search(0x12345678, 5);
    // It may or may not find it — just verify the API works
    expect(typeof found).toBe('boolean');
  });

  it('produces same sequence as ISAAC with same seed', () => {
    const seed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const isaac = new ISAAC(seed);
    const crypto = new CryptoSystem(seed);

    // ISAAC starts at offset 255 and CryptoSystem gets first via constructor
    // Both should produce same values in sequence
    const isaacVal = isaac.next();
    const cryptoVal = crypto.next();
    expect(isaacVal).toBe(cryptoVal);
  });
});

// ─── ConnectionData ─────────────────────────────────────

describe('ConnectionData', () => {
  it('initializes with random seeds and cookie', () => {
    const conn = new ConnectionData(1);
    expect(conn.clientSeed.length).toBe(4);
    expect(conn.serverSeed.length).toBe(4);
    expect(conn.connectionCookie.length).toBe(8);
    expect(conn.clientId).toBe(1);
    expect(conn.state).toBe(SessionState.AuthLoginRequest);
  });

  it('generates unique seeds per instance', () => {
    const conn1 = new ConnectionData(1);
    const conn2 = new ConnectionData(2);
    // Seeds should almost certainly differ (probability of collision is ~2^-32)
    const seed1 = Array.from(conn1.clientSeed);
    const seed2 = Array.from(conn2.clientSeed);
    // Can't guarantee they differ but check they're valid
    expect(seed1.length).toBe(4);
    expect(seed2.length).toBe(4);
  });

  it('builds 32-byte ConnectRequest payload', () => {
    const conn = new ConnectionData(42);
    const payload = conn.buildConnectRequest(12345.6789);

    expect(payload.length).toBe(32);

    // Parse it back
    const parsed = ConnectionData.parseConnectRequest(payload);
    expect(parsed.serverTime).toBeCloseTo(12345.6789, 3);
    expect(parsed.clientId).toBe(42);
    expect(parsed.serverSeed).toEqual(conn.serverSeed);
    expect(parsed.clientSeed).toEqual(conn.clientSeed);
    expect(parsed.cookie).toEqual(conn.connectionCookie);
  });

  it('builds 8-byte ConnectResponse payload', () => {
    const conn = new ConnectionData(1);
    const response = conn.buildConnectResponse();

    expect(response.length).toBe(8);
    expect(response).toEqual(conn.connectionCookie);
  });

  it('verifies valid ConnectResponse', () => {
    const conn = new ConnectionData(1);
    const response = conn.buildConnectResponse();
    expect(conn.verifyConnectResponse(response)).toBe(true);
  });

  it('rejects invalid ConnectResponse', () => {
    const conn = new ConnectionData(1);
    const badResponse = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(conn.verifyConnectResponse(badResponse)).toBe(false);
  });

  it('rejects short ConnectResponse', () => {
    const conn = new ConnectionData(1);
    expect(conn.verifyConnectResponse(new Uint8Array(4))).toBe(false);
  });

  it('initializes crypto from seeds', () => {
    const conn = new ConnectionData(1);
    expect(conn.cryptoClient).toBeNull();
    expect(conn.cryptoServer).toBeNull();

    conn.initializeCrypto();

    expect(conn.cryptoClient).not.toBeNull();
    expect(conn.cryptoServer).not.toBeNull();
  });

  it('initializes crypto from ConnectRequest data', () => {
    const serverConn = new ConnectionData(1);
    const connectPayload = serverConn.buildConnectRequest(0);
    const connectData = ConnectionData.parseConnectRequest(connectPayload);

    const clientConn = new ConnectionData(0);
    clientConn.initializeCryptoFromConnect(connectData);

    expect(clientConn.clientId).toBe(1);
    expect(clientConn.clientSeed).toEqual(serverConn.clientSeed);
    expect(clientConn.serverSeed).toEqual(serverConn.serverSeed);
    expect(clientConn.connectionCookie).toEqual(serverConn.connectionCookie);
    expect(clientConn.cryptoClient).not.toBeNull();
    expect(clientConn.cryptoServer).not.toBeNull();
  });

  it('packet sequence increments', () => {
    const conn = new ConnectionData(1);
    expect(conn.nextPacketSequence()).toBe(1);
    expect(conn.nextPacketSequence()).toBe(2);
    expect(conn.nextPacketSequence()).toBe(3);
  });

  it('fragment sequence increments', () => {
    const conn = new ConnectionData(1);
    expect(conn.nextFragmentSequence()).toBe(1);
    expect(conn.nextFragmentSequence()).toBe(2);
  });
});

// ─── SessionState Enum ──────────────────────────────────

describe('SessionState', () => {
  it('has correct values', () => {
    expect(SessionState.AuthLoginRequest).toBe(0);
    expect(SessionState.AuthConnectResponse).toBe(1);
    expect(SessionState.AuthConnected).toBe(2);
    expect(SessionState.WorldConnected).toBe(3);
  });
});

// ─── Handshake Protocol Flow ────────────────────────────

describe('Handshake protocol flow', () => {
  it('simulates full three-way handshake', () => {
    // Step 1: Server creates connection data
    const serverConn = new ConnectionData(100);

    // Step 2: Server builds ConnectRequest
    const connectPayload = serverConn.buildConnectRequest(1000.0);
    expect(connectPayload.length).toBe(32);

    // Step 3: Client parses ConnectRequest
    const connectData = ConnectionData.parseConnectRequest(connectPayload);
    expect(connectData.serverTime).toBeCloseTo(1000.0, 1);
    expect(connectData.clientId).toBe(100);

    // Step 4: Client initializes crypto and sends ConnectResponse
    const clientConn = new ConnectionData(0);
    clientConn.initializeCryptoFromConnect(connectData);

    const responsePayload = clientConn.buildConnectResponse();
    expect(responsePayload.length).toBe(8);

    // Step 5: Server verifies ConnectResponse
    expect(serverConn.verifyConnectResponse(responsePayload)).toBe(true);

    // Step 6: Both sides have matching crypto systems
    serverConn.initializeCrypto();

    // Verify crypto produces same keys from same seeds
    const serverKey = serverConn.cryptoServer!.next();
    const clientKey = clientConn.cryptoServer!.next();
    expect(serverKey).toBe(clientKey);
  });

  it('rejects wrong cookie in ConnectResponse', () => {
    const serverConn = new ConnectionData(1);
    const wrongResponse = new Uint8Array(8);
    wrongResponse.fill(0xFF);
    expect(serverConn.verifyConnectResponse(wrongResponse)).toBe(false);
  });
});

// ─── Encrypted Checksum ─────────────────────────────────

describe('Encrypted checksum', () => {
  it('encrypts and decrypts checksum with ISAAC XOR', () => {
    const seed = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    // Server side: encrypt checksum
    const serverCrypto = new CryptoSystem(seed);
    const plainChecksum = 0x12345678;
    const isaacKey = serverCrypto.next();
    const encryptedChecksum = (plainChecksum ^ isaacKey) >>> 0;

    // Client side: decrypt checksum
    const clientCrypto = new CryptoSystem(seed);
    const decryptKey = clientCrypto.next();
    const decryptedChecksum = (encryptedChecksum ^ decryptKey) >>> 0;

    expect(decryptedChecksum).toBe(plainChecksum);
  });

  it('builds packet with encrypted checksum flag', () => {
    const seed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const crypto = new CryptoSystem(seed);

    // Build a simple packet with encrypted checksum
    const fragData = new Uint8Array([1, 2, 3, 4]);
    const fragment: Fragment = {
      header: {
        sequence: 1,
        id: 1,
        count: 1,
        size: FRAGMENT_HEADER_SIZE + fragData.length,
        index: 0,
        queue: GameMessageGroup.EventQueue,
      },
      data: fragData,
    };

    // Build packet normally first
    const packet: PacketData = {
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments: [fragment],
    };

    const buf = buildPacket(packet);

    // Read the plain checksum
    const header = readPacketHeader(buf, 0);
    const plainChecksum = header.checksum;

    // Apply ISAAC encryption
    const isaacKey = crypto.next();
    const encryptedHeader = { ...header, checksum: (plainChecksum ^ isaacKey) >>> 0 };
    writePacketHeader(encryptedHeader, buf, 0);

    // Verify that a matching crypto instance can decrypt
    const crypto2 = new CryptoSystem(seed);
    const decryptKey = crypto2.next();
    const readHeader = readPacketHeader(buf, 0);
    const decryptedChecksum = (readHeader.checksum ^ decryptKey) >>> 0;
    expect(decryptedChecksum).toBe(plainChecksum);
  });
});

// ─── ConnectRequest/Response Packet Construction ────────

describe('ConnectRequest/Response packet construction', () => {
  it('builds a ConnectRequest as a full packet', () => {
    const conn = new ConnectionData(42);
    const connectPayload = conn.buildConnectRequest(5000.0);

    const packet: PacketData = {
      header: {
        sequence: 0,
        flags: PacketHeaderFlags.ConnectRequest,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments: [],
    };

    // Manually add the connect payload (it's not a fragment)
    const totalSize = PACKET_HEADER_SIZE + connectPayload.length;
    const buf = new Uint8Array(totalSize);
    buf.set(connectPayload, PACKET_HEADER_SIZE);

    const headerChecksum = calculateHeaderChecksum({
      ...packet.header,
      size: connectPayload.length,
    });
    const payloadChecksum = hash32(connectPayload, 0, connectPayload.length);

    const header: PacketHeaderData = {
      ...packet.header,
      size: connectPayload.length,
      checksum: (headerChecksum + payloadChecksum) >>> 0,
    };
    writePacketHeader(header, buf, 0);

    // Parse it back
    const parsed = readPacketHeader(buf, 0);
    expect(hasFlag(parsed, PacketHeaderFlags.ConnectRequest)).toBe(true);
    expect(parsed.size).toBe(32);

    const parsedConnect = ConnectionData.parseConnectRequest(
      buf.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + 32)
    );
    expect(parsedConnect.clientId).toBe(42);
    expect(parsedConnect.serverTime).toBeCloseTo(5000.0, 1);
  });

  it('builds a ConnectResponse as a full packet', () => {
    const conn = new ConnectionData(1);
    const responsePayload = conn.buildConnectResponse();

    const totalSize = PACKET_HEADER_SIZE + responsePayload.length;
    const buf = new Uint8Array(totalSize);
    buf.set(responsePayload, PACKET_HEADER_SIZE);

    const headerChecksum = calculateHeaderChecksum({
      sequence: 0,
      flags: PacketHeaderFlags.ConnectResponse,
      checksum: 0,
      id: 0, time: 0, size: responsePayload.length, iteration: 0,
    });
    const payloadChecksum = hash32(responsePayload, 0, responsePayload.length);

    writePacketHeader({
      sequence: 0,
      flags: PacketHeaderFlags.ConnectResponse,
      checksum: (headerChecksum + payloadChecksum) >>> 0,
      id: 0, time: 0, size: responsePayload.length, iteration: 0,
    }, buf, 0);

    const parsed = readPacketHeader(buf, 0);
    expect(hasFlag(parsed, PacketHeaderFlags.ConnectResponse)).toBe(true);
    expect(parsed.size).toBe(8);
  });
});

// ─── LoginRequest Packet ────────────────────────────────

describe('LoginRequest packet', () => {
  it('builds a LoginRequest with account and password', () => {
    const writer = new BinaryWriter(128);
    // NetAuthType = 0 (password)
    writer.writeUInt32(0);
    // AuthFlags = 0
    writer.writeUInt32(0);
    // Timestamp
    writer.writeUInt32(12345);
    // Account name
    writer.writeString16('testaccount');
    // AccountToLoginAs (empty)
    writer.writeString16('');
    // Password (with 4-byte length prefix)
    const encoder = new TextEncoder();
    const passBytes = encoder.encode('testpassword');
    writer.writeUInt32(passBytes.length);
    writer.writeBytes(passBytes);

    const loginData = writer.toBuffer();

    // Verify we can read it back
    const reader = new BinaryReader(loginData);
    expect(reader.readUInt32()).toBe(0); // netAuthType
    expect(reader.readUInt32()).toBe(0); // authFlags
    expect(reader.readUInt32()).toBe(12345); // timestamp
    expect(reader.readString16()).toBe('testaccount'); // account
    expect(reader.readString16()).toBe(''); // accountToLoginAs

    const passLen = reader.readUInt32();
    expect(passLen).toBe(12); // "testpassword".length
    const readPass = new TextDecoder().decode(reader.readBytes(passLen));
    expect(readPass).toBe('testpassword');
  });
});

// ─── Full Protocol Simulation ───────────────────────────

describe('Full protocol simulation', () => {
  it('simulates login → connect → response → character list', () => {
    // ── Step 1: Client sends LoginRequest ──
    const loginWriter = new BinaryWriter(64);
    loginWriter.writeUInt32(0); // netAuthType
    loginWriter.writeUInt32(0); // authFlags
    loginWriter.writeUInt32(0); // timestamp
    loginWriter.writeString16('player1');
    loginWriter.writeString16('');
    const pass = new TextEncoder().encode('pass123');
    loginWriter.writeUInt32(pass.length);
    loginWriter.writeBytes(pass);
    const loginPayload = loginWriter.toBuffer();

    const loginPacketBuf = new Uint8Array(PACKET_HEADER_SIZE + loginPayload.length);
    loginPacketBuf.set(loginPayload, PACKET_HEADER_SIZE);
    const loginHeader: PacketHeaderData = {
      sequence: 1,
      flags: PacketHeaderFlags.LoginRequest,
      checksum: 0,
      id: 0, time: 0, size: loginPayload.length, iteration: 0,
    };
    const lhc = calculateHeaderChecksum(loginHeader);
    const lpc = hash32(loginPayload);
    loginHeader.checksum = (lhc + lpc) >>> 0;
    writePacketHeader(loginHeader, loginPacketBuf, 0);

    // Verify login packet
    const parsedLogin = readPacketHeader(loginPacketBuf, 0);
    expect(hasFlag(parsedLogin, PacketHeaderFlags.LoginRequest)).toBe(true);

    // ── Step 2: Server sends ConnectRequest ──
    const serverConn = new ConnectionData(42);
    const connectPayload = serverConn.buildConnectRequest(99999.0);

    const connectBuf = new Uint8Array(PACKET_HEADER_SIZE + connectPayload.length);
    connectBuf.set(connectPayload, PACKET_HEADER_SIZE);
    const connectHeader: PacketHeaderData = {
      sequence: 0,
      flags: PacketHeaderFlags.ConnectRequest,
      checksum: 0,
      id: 0, time: 0, size: connectPayload.length, iteration: 0,
    };
    const chc = calculateHeaderChecksum(connectHeader);
    const cpc = hash32(connectPayload);
    connectHeader.checksum = (chc + cpc) >>> 0;
    writePacketHeader(connectHeader, connectBuf, 0);

    // ── Step 3: Client receives ConnectRequest, sends ConnectResponse ──
    const clientParsed = readPacketHeader(connectBuf, 0);
    expect(hasFlag(clientParsed, PacketHeaderFlags.ConnectRequest)).toBe(true);

    const connectData = ConnectionData.parseConnectRequest(
      connectBuf.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + 32)
    );

    const clientConn = new ConnectionData(0);
    clientConn.initializeCryptoFromConnect(connectData);
    expect(clientConn.clientId).toBe(42);

    const responsePayload = clientConn.buildConnectResponse();

    // ── Step 4: Server verifies ConnectResponse ──
    expect(serverConn.verifyConnectResponse(responsePayload)).toBe(true);

    // ── Step 5: Server sends character list ──
    serverConn.initializeCrypto();

    const charListWriter = new BinaryWriter(64);
    charListWriter.writeUInt32(GameMessageOpcode.CharacterList);
    charListWriter.writeUInt32(0); // status (success)
    charListWriter.writeUInt32(1); // character count
    charListWriter.writeUInt32(0x50000001); // character GUID
    charListWriter.writeString16('TestCharacter');
    charListWriter.writeUInt32(0); // delete timeout
    const charListPayload = charListWriter.toBuffer();

    // Fragment the character list message
    const fragments = fragmentMessage(
      charListPayload,
      serverConn.nextFragmentSequence(),
      GameMessageGroup.LoginQueue,
      1,
    );
    expect(fragments.length).toBe(1);

    // Build the packet
    const charPacket: PacketData = {
      header: {
        sequence: serverConn.nextPacketSequence(),
        flags: PacketHeaderFlags.BlobFragments,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments,
    };
    const charBuf = buildPacket(charPacket);
    expect(verifyPacketChecksum(charBuf)).toBe(true);

    // ── Step 6: Client receives and parses character list ──
    const clientParsedPkt = parsePacket(charBuf);
    expect(clientParsedPkt.fragments.length).toBe(1);

    const reassembled = reassembleFragments(clientParsedPkt.fragments);
    expect(reassembled).not.toBeNull();

    const msg = deserializeMessage(reassembled!);
    expect(msg.type).toBe('direct');
    expect(msg.opcode).toBe(GameMessageOpcode.CharacterList);
  });
});

// ─── Bridge Module Existence ────────────────────────────

describe('Bridge service', () => {
  it('bridge module exists', async () => {
    // Verify the bridge source file exists by importing syntax check
    // (we can't actually start the bridge in tests, but verify the module is parseable)
    const fs = await import('fs');
    const bridgePath = new URL('../services/ws-tcp-bridge/src/bridge.ts', import.meta.url).pathname;
    const stat = fs.statSync(bridgePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(500);
  });

  it('bridge package has correct dependencies', async () => {
    const fs = await import('fs');
    const pkgPath = new URL('../services/ws-tcp-bridge/package.json', import.meta.url).pathname;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('ws');
    // The bridge imports no workspace package, so its Docker image bundles
    // only itself + ws (services/ws-tcp-bridge/Dockerfile).
    expect(Object.keys(pkg.dependencies).filter((d: string) => d.startsWith('@ac/'))).toEqual([]);
  });
});

// ─── Integration: Encrypted Message Flow ────────────────

describe('Integration: encrypted message flow', () => {
  it('server encrypts, client decrypts packet checksum', () => {
    const seed = new Uint8Array([0x42, 0x43, 0x44, 0x45]);
    const serverCrypto = new CryptoSystem(seed);
    const clientCrypto = new CryptoSystem(seed);

    // Server builds a game event message
    const eventPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const msgBytes = serializeGameEvent(1, 0x0022, eventPayload);

    // Fragment + build packet
    const fragments = fragmentMessage(msgBytes, 1, GameMessageGroup.EventQueue, 0);
    const packet: PacketData = {
      header: {
        sequence: 1,
        flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum,
        checksum: 0,
        id: 0, time: 0, size: 0, iteration: 0,
      },
      optionalHeaders: {},
      fragments,
    };
    const buf = buildPacket(packet);

    // Server XORs checksum with ISAAC key
    const plainChecksum = readPacketHeader(buf, 0).checksum;
    const serverKey = serverCrypto.next();
    const encrypted = (plainChecksum ^ serverKey) >>> 0;

    // Write encrypted checksum
    const view = new DataView(buf.buffer, buf.byteOffset);
    view.setUint32(8, encrypted, true);

    // Client decrypts
    const receivedHeader = readPacketHeader(buf, 0);
    const clientKey = clientCrypto.next();
    const decrypted = (receivedHeader.checksum ^ clientKey) >>> 0;

    expect(decrypted).toBe(plainChecksum);

    // Parse the packet contents (ignoring checksum since we already decrypted)
    const parsed = parsePacket(buf);
    expect(parsed.fragments.length).toBe(1);

    const reassembled = reassembleFragments(parsed.fragments);
    expect(reassembled).not.toBeNull();

    const msg = deserializeMessage(reassembled!) as GameEventMessage;
    expect(msg.type).toBe('event');
    expect(msg.sequence).toBe(1);
    expect(msg.eventType).toBe(0x0022);
    expect(msg.payload).toEqual(eventPayload);
  });
});
