/**
 * AC1999 Phase 3, the bridge: each session has a wire protocol
 * (services/ws-tcp-bridge/src/protocol.ts), end of retail by default. A 1999
 * session (its directory row's era, BRIDGE_ERA when pinned, or ?proto=ac1999)
 * uses the server's ONE port both ways, takes its slot from the connect grant
 * and closes with a checksummed 1999 Disconnect. Drives the real bridge
 * against fake UDP servers, with an end-of-retail session beside the 1999 one
 * in the same bridge to prove the default path is untouched.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import {
  resolveBridgeConfig, buildDisconnectPacket, FLAG_CONNECT_REQUEST, FLAG_CONNECT_RESPONSE, type BridgeConfig,
} from '../services/ws-tcp-bridge/src/bridgeUtil';
import { ServerRegistry, type ServerEntry } from '../services/ws-tcp-bridge/src/serverList';
import { ServerDirectory } from '../services/ws-tcp-bridge/src/serverDirectory';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { EraDetector } from '../services/ws-tcp-bridge/src/eraDetect';
import type { CompatOverlay } from '../services/ws-tcp-bridge/src/serverCompat';
import {
  sessionProtocol, readGrant1999Ids, buildDisconnectPacket1999, isAc1999Era,
} from '../services/ws-tcp-bridge/src/protocol';
import { buildPacket1999, checksum1999, readHeader1999, F1999 } from '../packages/network/src/era1999/Packet1999';
import { readGrant1999 } from '../packages/network/src/era1999/Login1999';

// ─── Fixtures ─────────────────────────────────────────

/** The server's connect grant: f64 0, f64 delta, u32 slot, u32 versionLength, version, u32 seed ×2. */
function grant(slot: number, serverRecipient = 0x0b, time = 7): Buffer {
  const version = Buffer.from('4.35752\0', 'latin1');
  const body = Buffer.alloc(24 + version.length + 8);
  body.writeDoubleLE(0, 0);
  body.writeDoubleLE(1234.5, 8);
  body.writeUInt32LE(slot, 16);
  body.writeUInt32LE(version.length, 20);
  version.copy(body, 24);
  return Buffer.from(buildPacket1999({ sequence: 0, flags: F1999.Connect | F1999.Checksum, recipient: serverRecipient, time, body }));
}

/** The client's LoginRequest shape (seq 1, flags 0x2, recipient 0). */
function login1999(): Buffer {
  return Buffer.from(buildPacket1999({ sequence: 1, flags: F1999.Checksum, recipient: 0, time: 0, body: new Uint8Array(40) }));
}

function eorPacket(flags: number, len = 24, seq = 1): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(seq, 0);
  b.writeUInt32LE(flags, 4);
  return b;
}

function connectRequest(clientId: number): Buffer {
  const b = Buffer.alloc(20 + 32);
  b.writeUInt32LE(FLAG_CONNECT_REQUEST, 4);
  b.writeUInt16LE(0xB, 12);
  b.writeUInt32LE(clientId, 20 + 16);
  return b;
}

/** A 1999 Disconnect is valid: flags 0x8002, recipient = slot, sequence 0, no body, checksum per checksum1999. */
function expectValid1999Disconnect(msg: Buffer, slot: number, time: number): void {
  const h = readHeader1999(msg);
  expect(msg.length).toBe(20);
  expect(h).toMatchObject({ sequence: 0, flags: F1999.Disconnect | F1999.Checksum, recipient: slot, size: 0, time, table: 0 });
  // A fresh Uint8Array copy: checksum1999's header hash takes `.slice()` as a copy, which a pooled Buffer's isn't.
  expect(checksum1999(new Uint8Array(msg))).toBe(h.checksum);
}

// ─── Fake servers / bridge plumbing ───────────────────

interface FakeServer {
  port: number;
  auth: dgram.Socket;
  /** port + 1, bound so a stray world-port send would be seen. */
  world: dgram.Socket;
  authMsgs: { msg: Buffer; rinfo: dgram.RemoteInfo }[];
  worldMsgs: { msg: Buffer; rinfo: dgram.RemoteInfo }[];
  close(): void;
}

function bindUdp(port: number): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(port, '127.0.0.1', () => { s.off('error', reject); resolve(s); });
  });
}

async function fakeServer(): Promise<FakeServer> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const auth = await bindUdp(0);
    const port = auth.address().port;
    if (port >= 65535) { auth.close(); continue; }
    let world: dgram.Socket;
    try { world = await bindUdp(port + 1); } catch { auth.close(); continue; }
    const f: FakeServer = {
      port, auth, world, authMsgs: [], worldMsgs: [],
      close: () => { try { auth.close(); } catch { /* */ } try { world.close(); } catch { /* */ } },
    };
    auth.on('message', (msg, rinfo) => f.authMsgs.push({ msg, rinfo }));
    world.on('message', (msg, rinfo) => f.worldMsgs.push({ msg, rinfo }));
    return f;
  }
  throw new Error('could not bind a port pair');
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function collect(ws: WebSocket): Buffer[] {
  const got: Buffer[] = [];
  ws.on('message', (d: Buffer, isBinary) => { if (isBinary) got.push(Buffer.from(d)); });
  return got;
}

function baseConfig(env: Record<string, string>, argv: string[] = []): BridgeConfig {
  const c = resolveBridgeConfig(argv, { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', ...env });
  c.wsPort = 0;
  return c;
}

const silent = () => {};

// ─── Units ────────────────────────────────────────────

describe('session protocol selection (end of retail by default)', () => {
  it('a 1999 era or ?proto=ac1999 makes a 1999 session; anything else stays end of retail', () => {
    expect(isAc1999Era('ac1999-retail')).toBe(true);
    expect(sessionProtocol('ac1999-retail', '/connect?server=x')).toBe('ac1999');
    expect(sessionProtocol(null, '/?proto=ac1999')).toBe('ac1999');
    expect(sessionProtocol(undefined, '/connect?server=x&proto=AC1999')).toBe('ac1999');
    expect(sessionProtocol(null, '/')).toBe('eor');
    expect(sessionProtocol(undefined, undefined)).toBe('eor');
    expect(sessionProtocol('classic-dereth', '/')).toBe('eor');
    expect(sessionProtocol('classicace-customdm', '/?proto=eor')).toBe('eor');
    expect(sessionProtocol(null, '/?proto=1999')).toBe('eor');
  });

  it('reads the slot and server recipient from a grant only', () => {
    const g = grant(0x15, 0x0b);
    expect(readGrant1999(g.subarray(20))?.adoptRecipient).toBe(0x15); // the client's own reader agrees
    expect(readGrant1999Ids(g)).toEqual({ slot: 0x15, serverRecipient: 0x0b });
    // A bare 0x202 keepalive, a sequenced packet and an EoL ConnectRequest are not grants.
    expect(readGrant1999Ids(Buffer.from(buildPacket1999({ sequence: 0, flags: 0x202, recipient: 0x0b, time: 1 })))).toBeNull();
    const seq = Buffer.from(g); seq.writeUInt32LE(5, 0);
    expect(readGrant1999Ids(seq)).toBeNull();
    expect(readGrant1999Ids(connectRequest(0x2a))).toBeNull();
  });

  it('builds the client\'s 1999 Disconnect with a valid checksum', () => {
    const pkt = buildDisconnectPacket1999(0x15, 9);
    expectValid1999Disconnect(pkt, 0x15, 9);
    // Byte-identical to what Connection1999.disconnect sends for the same slot/time.
    expect(pkt.equals(Buffer.from(buildPacket1999({ sequence: 0, flags: 0x8002, recipient: 0x15, time: 9 })))).toBe(true);
  });
});

// ─── End to end: both protocols in one multi-mode bridge ──

describe('bridge end to end: a 1999 world beside an end-of-retail one (multi mode)', () => {
  let eor: FakeServer;
  let old: FakeServer;
  let bridge: BridgeServer | null = null;
  const sockets: WebSocket[] = [];
  beforeAll(async () => { eor = await fakeServer(); old = await fakeServer(); });
  afterAll(() => { eor.close(); old.close(); });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    if (bridge) await bridge.shutdown();
    bridge = null;
    for (const f of [eor, old]) { f.authMsgs.length = 0; f.worldMsgs.length = 0; }
  });

  async function start(withDirectory: boolean): Promise<string> {
    const servers: ServerEntry[] = [
      { id: 'local', name: 'Local Fake', emu: 'ACE', host: '127.0.0.1', port: eor.port, source: 'overlay' },
      // Era from the compat overlay's emu "AC1999" row (serverCompat.ts), as serverList.ac1999Overlay lists them.
      { id: 'ac1999-local', name: 'AC1999 (local)', emu: 'AC1999', host: '127.0.0.1', port: old.port, source: 'overlay' },
    ];
    const registry = new ServerRegistry({ url: null, refreshMs: 0, cachePath: null, overlay: { servers, deny: [] } });
    await registry.start();
    const directory = withDirectory ? new ServerDirectory({ servers: () => registry.all(), statusUrl: null, countsUrl: null }) : undefined;
    if (directory) expect(directory.body().servers.find(s => s.id === 'ac1999-local')?.era).toBe('ac1999-retail');
    bridge = createBridgeServer(baseConfig({ BRIDGE_MODE: 'multi', BRIDGE_ALLOW_PRIVATE_TARGETS: '1' }), { registry, directory, log: silent });
    return `127.0.0.1:${await bridge.listen()}`;
  }
  async function connect(url: string): Promise<WebSocket> {
    const ws = await open(url);
    sockets.push(ws);
    return ws;
  }

  for (const withDirectory of [true, false]) {
    it(`1999: one port both ways, grant relayed, 1999 Disconnect on close; EoL still routes ConnectResponse to port+1 (${withDirectory ? 'directory row' : 'overlay only'})`, async () => {
      const host = await start(withDirectory);
      const ws99 = await connect(`ws://${host}/connect?server=ac1999-local`);
      const wsEor = await connect(`ws://${host}/connect?server=local`);
      const got99 = collect(ws99);
      const gotEor = collect(wsEor);

      // 1999: the login, then a packet that happens to carry the EoL ConnectResponse bit — both to the one port.
      ws99.send(login1999());
      const odd = Buffer.from(buildPacket1999({ sequence: 2, flags: F1999.Checksum | FLAG_CONNECT_RESPONSE, recipient: 0, time: 0 }));
      ws99.send(odd);
      await until(() => old.authMsgs.length === 2);
      expect(old.authMsgs[0].msg.equals(login1999())).toBe(true);
      expect(old.authMsgs[1].msg.equals(odd)).toBe(true);
      const r99 = old.authMsgs[0].rinfo;

      // The grant comes back byte for byte.
      const g = grant(0x15, 0x0b, 7);
      old.auth.send(g, r99.port, r99.address);
      await until(() => got99.length === 1);
      expect(got99[0].equals(g)).toBe(true);

      // A 1999 server speaks from its one port: a datagram from port+1 is foreign.
      const drops = bridge!.metrics.drops.foreign_udp ?? 0;
      old.world.send(grant(0x99), r99.port, r99.address);
      await until(() => (bridge!.metrics.drops.foreign_udp ?? 0) === drops + 1);
      expect(got99.length).toBe(1);

      // End of retail in the same bridge: unchanged.
      wsEor.send(eorPacket(0x1, 30, 7));
      await until(() => eor.authMsgs.length === 1);
      const rEor = eor.authMsgs[0].rinfo;
      eor.auth.send(connectRequest(0x2A), rEor.port, rEor.address);
      await until(() => gotEor.length === 1);
      eor.world.send(eorPacket(0x4, 28), rEor.port, rEor.address); // ACE answers from port+1 too
      await until(() => gotEor.length === 2);
      wsEor.send(eorPacket(FLAG_CONNECT_RESPONSE, 28, 2));
      await until(() => eor.worldMsgs.length === 1);
      expect(eor.worldMsgs[0].msg.readUInt32LE(4)).toBe(FLAG_CONNECT_RESPONSE);

      // Close both: each server gets its own protocol's Disconnect.
      ws99.close();
      wsEor.close();
      await until(() => old.authMsgs.length === 3 && eor.authMsgs.length === 2);
      expectValid1999Disconnect(old.authMsgs[2].msg, 0x15, 7);
      expect(eor.authMsgs[1].msg.equals(buildDisconnectPacket(0x2A))).toBe(true);
      await until(() => bridge!.snapshot().sessions === 0);
      await sleep(50);
      expect(old.worldMsgs).toEqual([]); // nothing of the 1999 session ever went to port+1
    });
  }

  it('a 1999 session closed before its grant sends nothing (no slot to free)', async () => {
    const host = await start(true);
    const ws = await connect(`ws://${host}/connect?server=ac1999-local`);
    ws.send(login1999());
    await until(() => old.authMsgs.length === 1);
    ws.close();
    await until(() => bridge!.snapshot().sessions === 0);
    await sleep(50);
    expect(old.authMsgs.length).toBe(1);
  });

  it('graceful shutdown sends a 1999 session its 1999 Disconnect', async () => {
    const host = await start(true);
    const ws = await connect(`ws://${host}/connect?server=ac1999-local`);
    ws.send(login1999());
    await until(() => old.authMsgs.length === 1);
    const r = old.authMsgs[0].rinfo;
    old.auth.send(grant(0x2, 0x0b, 3), r.port, r.address);
    await until(() => bridge!.metrics.bytes.ws_out > 0);
    await bridge!.shutdown();
    bridge = null;
    await until(() => old.authMsgs.length === 2);
    expectValid1999Disconnect(old.authMsgs[1].msg, 0x2, 3);
  });
});

// ─── Pinned mode: BRIDGE_ERA, and ?proto for Custom… worlds ──

describe('bridge end to end (pinned): BRIDGE_ERA=ac1999-retail and ?proto=ac1999', () => {
  let srv: FakeServer;
  beforeAll(async () => { srv = await fakeServer(); });
  afterAll(() => srv.close());
  afterEach(() => { srv.authMsgs.length = 0; srv.worldMsgs.length = 0; });

  async function session(env: Record<string, string>, path: string): Promise<void> {
    const bridge = createBridgeServer(baseConfig(env, ['0', '127.0.0.1', String(srv.port)]), { log: silent });
    const port = await bridge.listen();
    try {
      const ws = await open(`ws://127.0.0.1:${port}${path}`);
      const got = collect(ws);
      ws.send(login1999());
      await until(() => srv.authMsgs.length === 1);
      const r = srv.authMsgs[0].rinfo;
      srv.auth.send(grant(0x0c, 0x0b, 4), r.port, r.address);
      await until(() => got.length === 1);
      ws.send(Buffer.from(buildPacket1999({ sequence: 2, flags: F1999.Checksum | FLAG_CONNECT_RESPONSE, recipient: 0x0c, time: 4 })));
      await until(() => srv.authMsgs.length === 2);
      ws.close();
      await until(() => srv.authMsgs.length === 3);
      expectValid1999Disconnect(srv.authMsgs[2].msg, 0x0c, 4);
      expect(srv.worldMsgs).toEqual([]);
    } finally {
      await bridge.shutdown();
    }
  }

  it('BRIDGE_ERA=ac1999-retail pins every session to the 1999 protocol', async () => {
    await session({ BRIDGE_ERA: 'ac1999-retail' }, '/');
  });

  it('?proto=ac1999 makes one session 1999 on an end-of-retail bridge', async () => {
    await session({}, '/?proto=ac1999');
  });

  it('without either, the same pinned bridge routes ConnectResponse to port+1 as before', async () => {
    const bridge = createBridgeServer(baseConfig({}, ['0', '127.0.0.1', String(srv.port)]), { log: silent });
    const port = await bridge.listen();
    try {
      const ws = await open(`ws://127.0.0.1:${port}/`);
      ws.send(eorPacket(FLAG_CONNECT_RESPONSE));
      await until(() => srv.worldMsgs.length === 1);
      expect(srv.authMsgs).toEqual([]);
      ws.terminate();
    } finally {
      await bridge.shutdown();
    }
  });
});

// ─── Era detection never probes a 1999 world ─────────

describe('era detection skips 1999 worlds on the bridge side too', () => {
  it('a server whose overlay era is ac1999-retail is never probed, even with emu ACE', async () => {
    const calls: string[] = [];
    const compat: CompatOverlay = { byId: { sneaky: { compat: 'beta', era: 'ac1999-retail' } }, byEmu: {} };
    const detector = new EraDetector({
      probe: async (address) => { calls.push(address); return { kind: 'accepted' as const }; },
      resolve: async (h) => h,
      sleep: async () => {},
      compat,
    });
    const servers: ServerEntry[] = [
      { id: 'sneaky', name: 'Sneaky', emu: 'ACE', host: 'old.example.org', port: 9110, source: 'overlay' },
      { id: 'normal', name: 'Normal', emu: 'ACE', host: 'new.example.org', port: 9000, source: 'overlay' },
    ];
    await detector.sweep(servers, () => true);
    expect(calls).toEqual(['new.example.org']);
    expect(detector.get('sneaky')).toBeUndefined();
  });
});
