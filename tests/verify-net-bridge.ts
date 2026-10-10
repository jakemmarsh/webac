/**
 * ASSESS: network hardening — ws-tcp-bridge helper tests.
 *
 * bridge.ts starts a WebSocket server on import, so the testable logic lives
 * in bridgeUtil.ts (config resolution, backpressure guard, rate-limited warn,
 * packet helpers) — these tests execute that shipped module directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveBridgeConfig,
  shouldDropForBackpressure,
  WS_BACKPRESSURE_LIMIT,
  makeRateLimitedWarn,
  hash32 as bridgeHash32,
  buildDisconnectPacket,
  readPacketFlags,
  readPacketId,
  readConnectRequestClientId,
  isOriginAllowed,
  isFromAce,
  initialAceAddresses,
  normalizeAddress,
  resolveImpairment,
  makeImpairedLink,
  seededRandom,
  FLAG_DISCONNECT,
  FLAG_CONNECT_REQUEST,
  FLAG_CONNECT_RESPONSE,
  CHECKSUM_SENTINEL,
  DEFAULT_WS_MAX_PAYLOAD,
  DEFAULT_MAX_CONNECTIONS,
} from '../services/ws-tcp-bridge/src/bridgeUtil';
import {
  hash32 as networkHash32, readPacketHeader, writePacketHeader, PacketHeaderFlags,
  ConnectionData, PACKET_HEADER_SIZE,
} from '@ac/network';

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveBridgeConfig', () => {
  it('defaults to localhost-only bind and debug off', () => {
    const cfg = resolveBridgeConfig([], {});
    // The public-hosting fields (mode, limits, server list, ...) are covered
    // in verify-bridge-hosting.ts; these are the historical local-dev values.
    expect(cfg).toMatchObject({
      wsPort: 9090,
      wsHost: '127.0.0.1',
      aceHost: '127.0.0.1',
      aceAuthPort: 9000,
      aceWorldPort: 9001,
      debug: false,
      allowedOrigins: [],
      maxPayload: DEFAULT_WS_MAX_PAYLOAD,
      maxConnections: DEFAULT_MAX_CONNECTIONS,
      allowAnyUdpSource: false,
      impairment: null,
    });
    expect(DEFAULT_WS_MAX_PAYLOAD).toBe(64 * 1024);
  });

  it('honors the hardening env overrides', () => {
    const cfg = resolveBridgeConfig([], {
      BRIDGE_ALLOWED_ORIGINS: 'http://192.168.1.5:5173/, https://ac.example.com',
      BRIDGE_MAX_PAYLOAD: '4096',
      BRIDGE_MAX_CONNECTIONS: '4',
      BRIDGE_ALLOW_ANY_UDP_SOURCE: '1',
    });
    expect(cfg.allowedOrigins).toEqual(['http://192.168.1.5:5173', 'https://ac.example.com']);
    expect(cfg.maxPayload).toBe(4096);
    expect(cfg.maxConnections).toBe(4);
    expect(cfg.allowAnyUdpSource).toBe(true);
    expect(resolveBridgeConfig([], { BRIDGE_ALLOWED_ORIGINS: '*' }).allowedOrigins).toBe('*');
    // garbage numbers fall back to the defaults
    expect(resolveBridgeConfig([], { BRIDGE_MAX_PAYLOAD: 'lots' }).maxPayload).toBe(DEFAULT_WS_MAX_PAYLOAD);
    expect(resolveBridgeConfig([], { BRIDGE_MAX_CONNECTIONS: '0' }).maxConnections).toBe(DEFAULT_MAX_CONNECTIONS);
  });

  it('honors BRIDGE_HOST and BRIDGE_DEBUG env overrides', () => {
    expect(resolveBridgeConfig([], { BRIDGE_HOST: '0.0.0.0' }).wsHost).toBe('0.0.0.0');
    expect(resolveBridgeConfig([], { BRIDGE_DEBUG: '1' }).debug).toBe(true);
    expect(resolveBridgeConfig([], { BRIDGE_DEBUG: 'true' }).debug).toBe(true);
    expect(resolveBridgeConfig([], { BRIDGE_DEBUG: '0' }).debug).toBe(false);
    expect(resolveBridgeConfig([], { BRIDGE_DEBUG: undefined }).debug).toBe(false);
  });

  it('keeps positional argv overrides (wsPort, aceHost, ports)', () => {
    const cfg = resolveBridgeConfig(['9999', '10.0.0.5', '9100', '9101'], {});
    expect(cfg.wsPort).toBe(9999);
    expect(cfg.aceHost).toBe('10.0.0.5');
    expect(cfg.aceAuthPort).toBe(9100);
    expect(cfg.aceWorldPort).toBe(9101);
  });
});

describe('shouldDropForBackpressure', () => {
  it('drops only above the 1MB limit', () => {
    expect(WS_BACKPRESSURE_LIMIT).toBe(1024 * 1024);
    expect(shouldDropForBackpressure(0)).toBe(false);
    expect(shouldDropForBackpressure(WS_BACKPRESSURE_LIMIT)).toBe(false);
    expect(shouldDropForBackpressure(WS_BACKPRESSURE_LIMIT + 1)).toBe(true);
  });

  it('supports a custom limit', () => {
    expect(shouldDropForBackpressure(11, 10)).toBe(true);
    expect(shouldDropForBackpressure(10, 10)).toBe(false);
  });
});

describe('makeRateLimitedWarn', () => {
  it('logs at most once per interval and reports suppressed count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const limited = makeRateLimitedWarn(1000);
      limited('drop');
      limited('drop');
      limited('drop');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith('drop');

      vi.setSystemTime(101_001);
      limited('drop');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith('drop (+2 suppressed)');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('bridge packet helpers', () => {
  it('hash32 matches the @ac/network implementation byte-for-byte', () => {
    const cases = [
      Buffer.from([]),
      Buffer.from([0x01]),
      Buffer.from([0x01, 0x02, 0x03]),
      Buffer.from(Array.from({ length: 37 }, (_, i) => (i * 13) & 0xff)),
    ];
    for (const buf of cases) {
      expect(bridgeHash32(buf, 0, buf.length)).toBe(networkHash32(new Uint8Array(buf), 0, buf.length));
    }
  });

  it('buildDisconnectPacket produces a valid AC Disconnect with correct checksum', () => {
    const pkt = buildDisconnectPacket(0x1234);
    expect(pkt.length).toBe(20);
    expect(readPacketFlags(pkt)).toBe(FLAG_DISCONNECT);
    expect(FLAG_DISCONNECT).toBe(PacketHeaderFlags.Disconnect);
    expect(readPacketId(pkt)).toBe(0x1234);

    const header = readPacketHeader(new Uint8Array(pkt), 0);
    expect(header.sequence).toBe(0);
    expect(header.size).toBe(0);

    // checksum = hash32(header with sentinel in the checksum field)
    const copy = Buffer.from(pkt);
    copy.writeUInt32LE(CHECKSUM_SENTINEL, 8);
    expect(header.checksum).toBe(bridgeHash32(copy, 0, 20));
  });
});

/**
 * NET.bridge-disconnect-wrong-session-id — the bridge's Disconnect must carry
 * the CLIENT's ACE session id (NetworkManager sessionMap index, from the
 * ConnectRequest), not a server header Id (always ServerId 0xB).
 */
describe('readConnectRequestClientId', () => {
  function serverConnectRequest(clientId: number): Buffer {
    const cd = new ConnectionData(clientId);
    const payload = cd.buildConnectRequest(1234.5); // ACE PacketOutboundConnectRequest layout
    const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
    writePacketHeader({ sequence: 0, flags: PacketHeaderFlags.ConnectRequest, checksum: 0, id: 0xB, time: 0, size: payload.length, iteration: 0 }, buf, 0);
    buf.set(payload, PACKET_HEADER_SIZE);
    return Buffer.from(buf);
  }

  it('reads the clientId from the ConnectRequest payload, not the ServerId header', () => {
    expect(FLAG_CONNECT_REQUEST).toBe(PacketHeaderFlags.ConnectRequest);
    const pkt = serverConnectRequest(0x0123);
    expect(readPacketId(pkt)).toBe(0xB); // what the old code captured
    expect(readConnectRequestClientId(pkt)).toBe(0x0123);
  });

  it('treats session index 0 as a real id (ACE session indices start at 0)', () => {
    expect(readConnectRequestClientId(serverConnectRequest(0))).toBe(0);
    // and the Disconnect built for it addresses session 0
    expect(readPacketId(buildDisconnectPacket(0))).toBe(0);
  });

  it('returns null for every other server packet (they all carry ServerId)', () => {
    const buf = new Uint8Array(PACKET_HEADER_SIZE + 64);
    writePacketHeader({ sequence: 5, flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, checksum: 0, id: 0xB, time: 0, size: 64, iteration: 1 }, buf, 0);
    expect(readConnectRequestClientId(Buffer.from(buf))).toBeNull();
    expect(readConnectRequestClientId(Buffer.alloc(24))).toBeNull();
    expect(FLAG_CONNECT_RESPONSE).toBe(PacketHeaderFlags.ConnectResponse);
  });
});

describe('isOriginAllowed (NET.receive-validation-and-bridge-hardening)', () => {
  it('allows non-browser clients (no Origin header) and loopback page origins by default', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
    expect(isOriginAllowed('', [])).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', [])).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:4173', [])).toBe(true);
    expect(isOriginAllowed('https://LOCALHOST', [])).toBe(true);
    expect(isOriginAllowed('http://[::1]:5173', [])).toBe(true);
  });

  it('rejects other web origins unless listed, and non-http schemes', () => {
    expect(isOriginAllowed('https://evil.example.com', [])).toBe(false);
    expect(isOriginAllowed('http://localhost.evil.example.com', [])).toBe(false);
    expect(isOriginAllowed('null', [])).toBe(false);
    expect(isOriginAllowed('file://localhost', [])).toBe(false);
    expect(isOriginAllowed('http://192.168.1.5:5173', ['http://192.168.1.5:5173'])).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', '*')).toBe(true);
  });
});

describe('isFromAce (NET.receive-validation-and-bridge-hardening)', () => {
  it('accepts only the ACE host on its auth/world ports', () => {
    const addrs = initialAceAddresses('127.0.0.1');
    expect(isFromAce({ address: '127.0.0.1', port: 9000 }, addrs, [9000, 9001])).toBe(true);
    expect(isFromAce({ address: '::ffff:127.0.0.1', port: 9001 }, addrs, [9000, 9001])).toBe(true);
    expect(isFromAce({ address: '127.0.0.1', port: 5555 }, addrs, [9000, 9001])).toBe(false);
    expect(isFromAce({ address: '10.0.0.9', port: 9000 }, addrs, [9000, 9001])).toBe(false);
  });

  it('knows localhost\'s loopback aliases before DNS answers', () => {
    const addrs = initialAceAddresses('localhost');
    expect(isFromAce({ address: '127.0.0.1', port: 9000 }, addrs, [9000, 9001])).toBe(true);
    expect(isFromAce({ address: '::1', port: 9001 }, addrs, [9000, 9001])).toBe(true);
    expect(normalizeAddress('::FFFF:10.1.2.3')).toBe('10.1.2.3');
  });
});

describe('network impairment (HARNESS.bridge-network-impairment)', () => {
  it('is off unless an impairment env var is set, and clamps loss to 100%', () => {
    expect(resolveImpairment({})).toBeNull();
    expect(resolveImpairment({ BRIDGE_LATENCY_MS: '0', BRIDGE_LOSS_PCT: 'abc' })).toBeNull();
    expect(resolveImpairment({ BRIDGE_LATENCY_MS: '75', BRIDGE_JITTER_MS: '15', BRIDGE_LOSS_PCT: '250' }))
      .toEqual({ latencyMs: 75, jitterMs: 15, lossPct: 100, seed: 1 });
    expect(resolveBridgeConfig([], { BRIDGE_LOSS_PCT: '2', BRIDGE_IMPAIR_SEED: '7' }).impairment)
      .toEqual({ latencyMs: 0, jitterMs: 0, lossPct: 2, seed: 7 });
  });

  it('delivers immediately with no impairment', () => {
    const got: number[] = [];
    const link = makeImpairedLink(null);
    expect(link.send(() => got.push(1))).toBe('sent');
    expect(got).toEqual([1]);
  });

  it('delays each datagram by latency ± jitter, and jitter reorders them', () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const link = makeImpairedLink({ latencyMs: 100, jitterMs: 40, lossPct: 0, seed: 3 });
    for (let i = 0; i < 50; i++) expect(link.send(() => got.push(i))).toBe('delayed');
    vi.advanceTimersByTime(59);
    expect(got).toEqual([]); // nothing arrives before latency − jitter
    vi.advanceTimersByTime(82);
    expect(got.length).toBe(50); // everything by latency + jitter
    expect(got).not.toEqual([...got].sort((a, b) => a - b)); // reordered
  });

  it('drops close to lossPct of datagrams, and the same seed drops the same ones', () => {
    vi.useFakeTimers();
    const run = (seed: number) => {
      const link = makeImpairedLink({ latencyMs: 0, jitterMs: 0, lossPct: 10, seed });
      return Array.from({ length: 5000 }, () => link.send(() => {}));
    };
    const a = run(42);
    const drops = a.filter(r => r === 'dropped').length;
    expect(drops).toBeGreaterThan(400);
    expect(drops).toBeLessThan(600);
    expect(run(42)).toEqual(a);
    expect(run(43)).not.toEqual(a);
  });

  it('close() cancels pending deliveries and drops later sends', () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const link = makeImpairedLink({ latencyMs: 50, jitterMs: 0, lossPct: 0, seed: 1 });
    link.send(() => got.push(1));
    link.close();
    expect(link.send(() => got.push(2))).toBe('dropped');
    vi.advanceTimersByTime(1000);
    expect(got).toEqual([]);
  });

  it('seededRandom stays in [0, 1)', () => {
    const r = seededRandom(9);
    for (let i = 0; i < 1000; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
