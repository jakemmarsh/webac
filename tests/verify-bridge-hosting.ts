/**
 * RELEASE Phase 2 — the bridge ready for public hosting. Exercises the real
 * modules: Servers.xml allowlist parsing + registry (fail closed, disk
 * cache, overlay/deny), private-target rejection, rate limiters, per-IP and
 * per-server caps, /healthz + /metrics, and end-to-end WS→UDP round trips
 * against fake UDP game servers on 127.0.0.1 (multi mode with the
 * private-targets dev flag, and the legacy pinned mode).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import {
  resolveBridgeConfig, parseHostPort, buildDisconnectPacket, FLAG_CONNECT_REQUEST, FLAG_CONNECT_RESPONSE,
  DEFAULT_MAX_CONNECTIONS, DEFAULT_LIMITS, type BridgeConfig,
} from '../services/ws-tcp-bridge/src/bridgeUtil';
import {
  parseServersXml, parseOverlay, mergeOverlays, decodeXmlText, isValidHost, ServerRegistry, DEFAULT_SERVERS_URL,
  type ServerOverlay,
} from '../services/ws-tcp-bridge/src/serverList';
import { isPublicIPv4, parseIPv4, resolveTarget } from '../services/ws-tcp-bridge/src/targets';
import {
  TokenBucket, SlidingWindowCounter, KeyedCounter, AbuseMeter, clientIp, isLoopbackAddress,
} from '../services/ws-tcp-bridge/src/limits';
import { BridgeMetrics, renderPrometheus, healthzBody } from '../services/ws-tcp-bridge/src/metrics';
import { formatLogLine, rateLimitedLog, type LogLevel } from '../services/ws-tcp-bridge/src/log';
import { createBridgeServer, CLOSE_IP_CAP, CLOSE_IP_CAP_REASON, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { BRIDGE_CLOSE_IP_CAP } from '../packages/network/src/BridgeRefusal';
import { sanitizeClientError, scrubText } from '../services/ws-tcp-bridge/src/clientErrors';

const FIXTURE = path.join(__dirname, 'fixtures', 'servers-list-sample.xml');
let fixtureXml = '';
beforeAll(() => { fixtureXml = fs.readFileSync(FIXTURE, 'utf8'); });

// ─── Allowlist ─────────────────────────────────────────

describe('parseServersXml', () => {
  it('reads id/name/emu/host/port, decodes entities, skips invalid + duplicate items', () => {
    const { servers, skipped } = parseServersXml(fixtureXml);
    expect(servers.map(s => s.id)).toEqual([
      '59544be2-9435-400d-a589-30b2a39ed071', '99b5533c-196a-4d38-8db1-dbad7a91d7a2', 'gdle-reefcull',
    ]);
    expect(skipped).toBe(4); // port 65535 (no room for port+1), bad host, empty id, duplicate id (case-insensitive)
    expect(servers[0]).toEqual({
      id: '59544be2-9435-400d-a589-30b2a39ed071', name: 'Newfoundland', emu: 'ACE',
      host: 'rftc.duckdns.org', port: 9000, source: 'list',
      description: 'End of retail server. All Weclome', type: 'PvE', discord: 'https://discord.gg/A5AHWZFUAa',
    });
    expect(servers[1].description).toBe('PvP/PvE hybrid <custom>');
    expect(servers[1].name).toBe('Nexus & Friends');
    expect(servers[2]).toMatchObject({ emu: 'GDL', host: 'reefcull.gdleac.com' }); // hosts lower-cased
  });

  it('returns nothing for garbage', () => {
    expect(parseServersXml('<html>rate limited</html>').servers).toEqual([]);
    expect(parseServersXml('').servers).toEqual([]);
  });

  it('decodes XML text and validates hosts', () => {
    expect(decodeXmlText(' a &amp; b &#65;&#x42; ')).toBe('a & b AB');
    expect(decodeXmlText('<![CDATA[x<y]]>')).toBe('x<y');
    expect(isValidHost('play.example.org')).toBe(true);
    expect(isValidHost('1.2.3.4')).toBe(true);
    expect(isValidHost('-bad.org')).toBe(false);
    expect(isValidHost('a..b')).toBe(false);
    expect(isValidHost('has space')).toBe(false);
    expect(isValidHost('[::1]')).toBe(false);
  });
});

describe('parseOverlay', () => {
  it('parses servers + deny and throws loudly on bad entries', () => {
    const o = parseOverlay(JSON.stringify({ servers: [{ id: 'mine', host: 'Play.Example.org', port: 9050, emu: 'GDLE' }], deny: ['ABC', ' bad.host '] }));
    expect(o.servers).toEqual([{ id: 'mine', name: 'mine', emu: 'GDLE', host: 'play.example.org', port: 9050, source: 'overlay' }]);
    expect(o.deny).toEqual(['abc', 'bad.host']);
    expect(() => parseOverlay('{not json')).toThrow();
    expect(() => parseOverlay(JSON.stringify({ servers: [{ id: 'x', host: 'ok.org', port: 0 }] }))).toThrow(/port/);
    expect(() => parseOverlay(JSON.stringify({ servers: [{ host: 'ok.org', port: 9000 }] }))).toThrow(/id/);
    expect(() => parseOverlay(JSON.stringify({ deny: 'x' }))).toThrow(/deny/);
    expect(mergeOverlays(o, { servers: [], deny: ['z'] }).deny).toEqual(['abc', 'bad.host', 'z']);
  });
});

describe('ServerRegistry', () => {
  let dir = '';
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acjs-bridge-reg-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const noOverlay: ServerOverlay = { servers: [], deny: [] };

  it('fails closed with no list: list ids do not resolve, overlay ids still do', async () => {
    const reg = new ServerRegistry({
      url: 'https://example.invalid/Servers.xml', refreshMs: 0, cachePath: null,
      overlay: { servers: [{ id: 'mine', name: 'Mine', emu: 'ACE', host: 'play.example.org', port: 9000, source: 'overlay' }], deny: [] },
      fetchText: async () => { throw new Error('network down'); },
    });
    await reg.start();
    expect(reg.lookup('59544be2-9435-400d-a589-30b2a39ed071')).toBeNull();
    expect(reg.lookup('mine')?.host).toBe('play.example.org');
    expect(reg.status()).toMatchObject({ source: 'none', ageSeconds: null, lastError: 'network down' });
  });

  it('caches the last good list to disk and keeps it when later fetches fail or return garbage', async () => {
    const cachePath = path.join(dir, 'cache', 'servers.xml');
    let t = 1_000_000;
    let answer: () => Promise<string> = async () => fixtureXml;
    const opts = { url: DEFAULT_SERVERS_URL, refreshMs: 0, cachePath, overlay: noOverlay, now: () => t, fetchText: () => answer() };
    const reg = new ServerRegistry(opts);
    await reg.start();
    expect(reg.status()).toMatchObject({ source: 'remote', servers: 3, ageSeconds: 0 });
    expect(fs.readFileSync(cachePath, 'utf8')).toBe(fixtureXml);

    answer = async () => '<html>oops</html>';
    t += 60_000;
    expect(await reg.refresh()).toBe(false);
    expect(reg.lookup('gdle-reefcull')?.port).toBe(9000);
    expect(reg.status().ageSeconds).toBe(60);
    expect(fs.readFileSync(cachePath, 'utf8')).toBe(fixtureXml); // garbage never overwrites the cache

    // A fresh process with the network down starts from the cache.
    const cold = new ServerRegistry({ ...opts, fetchText: async () => { throw new Error('down'); } });
    await cold.start();
    expect(cold.status().source).toBe('cache');
    expect(cold.lookup('99B5533C-9435-400D-A589-30B2A39ED071'.toLowerCase())).toBeNull();
    expect(cold.lookup('99b5533c-196a-4d38-8db1-dbad7a91d7a2')?.host).toBe('135.148.136.179');
  });

  it('overlay servers win on id clashes; deny removes by id or host', async () => {
    const reg = new ServerRegistry({
      url: 'x', refreshMs: 0, cachePath: null,
      overlay: {
        servers: [{ id: 'gdle-reefcull', name: 'Override', emu: 'GDLE', host: 'other.example.org', port: 9010, source: 'overlay' }],
        deny: ['59544be2-9435-400d-a589-30b2a39ed071', '135.148.136.179'],
      },
      fetchText: async () => fixtureXml,
    });
    await reg.start();
    expect(reg.lookup('gdle-reefcull')).toMatchObject({ name: 'Override', port: 9010 });
    expect(reg.lookup('59544be2-9435-400d-a589-30b2a39ed071')).toBeNull();
    expect(reg.lookup('99b5533c-196a-4d38-8db1-dbad7a91d7a2')).toBeNull();
    expect(reg.all().map(s => s.id)).toEqual(['gdle-reefcull']);
    expect(reg.lookup('')).toBeNull();
  });
});

// ─── Target guard ──────────────────────────────────────

describe('private-target rejection', () => {
  it('classifies IPv4 addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1']) {
      expect([ip, isPublicIPv4(ip)]).toEqual([ip, false]);
    }
    for (const ip of ['135.148.136.179', '8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1']) {
      expect([ip, isPublicIPv4(ip)]).toEqual([ip, true]);
    }
    expect(isPublicIPv4('256.1.1.1')).toBe(false);
    expect(isPublicIPv4('example.org')).toBe(false);
    expect(parseIPv4('1.2.3')).toBeNull();
  });

  it('resolves to the first public address; rejects private-only, IPv6 literals and DNS failures', async () => {
    const lookup = async (h: string) => ({
      mixed: ['10.0.0.5', '135.148.136.179'], internal: ['169.254.169.254', '127.0.0.1'], none: [] as string[],
    } as Record<string, string[]>)[h] ?? Promise.reject(new Error('ENOTFOUND'));
    expect(await resolveTarget('mixed', { allowPrivate: false, lookup })).toEqual({ ok: true, address: '135.148.136.179' });
    expect(await resolveTarget('internal', { allowPrivate: false, lookup })).toMatchObject({ ok: false, reason: 'private_target' });
    expect(await resolveTarget('internal', { allowPrivate: true, lookup })).toEqual({ ok: true, address: '169.254.169.254' });
    expect(await resolveTarget('none', { allowPrivate: false, lookup })).toMatchObject({ ok: false, reason: 'dns_failed' });
    expect(await resolveTarget('missing', { allowPrivate: false, lookup })).toMatchObject({ ok: false, reason: 'dns_failed' });
    expect(await resolveTarget('::1', { allowPrivate: true, lookup })).toMatchObject({ ok: false, reason: 'ipv6_unsupported' });
    const hang = () => new Promise<string[]>(() => {});
    expect(await resolveTarget('slow', { allowPrivate: false, lookup: hang, timeoutMs: 20 })).toMatchObject({ ok: false, reason: 'dns_failed' });
  });

  it('the real system resolver refuses a loopback literal without the dev flag', async () => {
    expect(await resolveTarget('127.0.0.1', { allowPrivate: false })).toMatchObject({ ok: false, reason: 'private_target' });
    expect(await resolveTarget('127.0.0.1', { allowPrivate: true })).toEqual({ ok: true, address: '127.0.0.1' });
  });
});

// ─── Limiters ──────────────────────────────────────────

describe('rate limiters', () => {
  it('TokenBucket allows the burst, then refills at the rate', () => {
    let t = 0;
    const b = new TokenBucket(10, 5, () => t);
    for (let i = 0; i < 5; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t += 100; // +1 token
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t += 10_000; // refill caps at the burst
    expect(b.tryTake(5)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
    expect(new TokenBucket(1, 100, () => t).tryTake(101)).toBe(false);
  });

  it('SlidingWindowCounter limits per key and forgets old hits', () => {
    let t = 0;
    const c = new SlidingWindowCounter(2, 1000, () => t);
    expect(c.hit('a')).toBe(true);
    expect(c.hit('a')).toBe(true);
    expect(c.hit('a')).toBe(false);
    expect(c.hit('b')).toBe(true);
    t = 1001;
    expect(c.hit('a')).toBe(true);
    t = 5000;
    c.sweep();
    expect(c.size).toBe(0);
  });

  it('AbuseMeter trips only on sustained drops inside the window', () => {
    let t = 0;
    const m = new AbuseMeter(3, 1000, () => t);
    expect([m.recordDrop(), m.recordDrop(), m.recordDrop()]).toEqual([false, false, false]);
    t = 2000; // old drops expire
    expect(m.recordDrop()).toBe(false);
    expect([m.recordDrop(), m.recordDrop(), m.recordDrop()]).toEqual([false, false, true]);
  });

  it('KeyedCounter counts up and down and forgets zero keys', () => {
    const k = new KeyedCounter();
    k.inc('a'); k.inc('a'); k.inc('b');
    expect(k.get('a')).toBe(2);
    k.dec('a'); k.dec('a'); k.dec('a');
    expect(k.get('a')).toBe(0);
    expect(k.entries()).toEqual([['b', 1]]);
  });

  it('clientIp ignores X-Forwarded-For unless a proxy is trusted, then takes the Nth from the right', () => {
    const h = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' };
    expect(clientIp('::ffff:10.0.0.1', h, 0)).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', h, 1)).toBe('10.0.0.2');
    expect(clientIp('10.0.0.1', h, 2)).toBe('203.0.113.9');
    expect(clientIp('10.0.0.1', h, 5)).toBe('10.0.0.1'); // header shorter than the hop count
    expect(clientIp('10.0.0.1', {}, 1)).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }, 1)).toBe('2.2.2.2');
    // Railway: X-Forwarded-For's last hop was Railway's own edge (every player
    // looked like 152.233.47.x on playwebac.com); x-real-ip carries the client.
    const railway = { 'x-forwarded-for': '198.51.100.7, 152.233.47.65', 'x-real-ip': '198.51.100.7' };
    expect(clientIp('10.0.0.1', railway, 1, 'x-real-ip')).toBe('198.51.100.7');
    expect(clientIp('10.0.0.1', railway, 1)).toBe('152.233.47.65');
    // The header is ignored without proxy trust, and garbage falls back to XFF.
    expect(clientIp('10.0.0.1', railway, 0, 'x-real-ip')).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', { ...railway, 'x-real-ip': 'not an ip' }, 1, 'x-real-ip')).toBe('152.233.47.65');
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });
});

// ─── Config ────────────────────────────────────────────

describe('hosting config', () => {
  it('no args/env = the historical local-dev bridge: pinned 127.0.0.1:9000/9001 on 127.0.0.1:9090', () => {
    const c = resolveBridgeConfig([], {});
    expect(c).toMatchObject({ mode: 'pinned', wsPort: 9090, wsHost: '127.0.0.1', aceHost: '127.0.0.1', aceAuthPort: 9000, aceWorldPort: 9001, trustProxyHops: 0, capturePath: null, captureRefused: false });
    expect(c.maxConnections).toBe(DEFAULT_MAX_CONNECTIONS);
    expect(c.limits).toEqual(DEFAULT_LIMITS);
  });

  it('BRIDGE_MODE=multi only without a pinned target; args or BRIDGE_TARGET pin and win', () => {
    expect(resolveBridgeConfig([], { BRIDGE_MODE: 'multi' }).mode).toBe('multi');
    expect(resolveBridgeConfig(['9090', 'play.example.org'], { BRIDGE_MODE: 'multi' })).toMatchObject({ mode: 'pinned', aceHost: 'play.example.org', aceAuthPort: 9000, aceWorldPort: 9001 });
    expect(resolveBridgeConfig([], { BRIDGE_MODE: 'multi', BRIDGE_TARGET: 'play.example.org:9050' })).toMatchObject({ mode: 'pinned', aceHost: 'play.example.org', aceAuthPort: 9050, aceWorldPort: 9051 });
    expect(resolveBridgeConfig(['9090', 'h', '9100'], {}).aceWorldPort).toBe(9101); // world = base + 1
    expect(() => resolveBridgeConfig([], { BRIDGE_TARGET: 'nope' })).toThrow(/host:port/);
    expect(parseHostPort('a.b:65535')).toBeNull();
  });

  it('PORT (Railway) sets the listen port; argv and BRIDGE_PORT win', () => {
    expect(resolveBridgeConfig([], { PORT: '8080' }).wsPort).toBe(8080);
    expect(resolveBridgeConfig([], { PORT: '8080', BRIDGE_PORT: '7000' }).wsPort).toBe(7000);
    expect(resolveBridgeConfig(['9091'], { PORT: '8080' }).wsPort).toBe(9091);
  });

  it('refuses BRIDGE_CAPTURE in production', () => {
    expect(resolveBridgeConfig([], { BRIDGE_CAPTURE: '/tmp/x.bin' })).toMatchObject({ capturePath: '/tmp/x.bin', captureRefused: false });
    expect(resolveBridgeConfig([], { BRIDGE_CAPTURE: '/tmp/x.bin', NODE_ENV: 'production' })).toMatchObject({ capturePath: null, captureRefused: true });
  });

  it('parses trust-proxy, limits, server-list and private-target env', () => {
    expect(resolveBridgeConfig([], { BRIDGE_TRUST_PROXY: 'true' }).trustProxyHops).toBe(1);
    expect(resolveBridgeConfig([], { BRIDGE_TRUST_PROXY: '2' }).trustProxyHops).toBe(2);
    expect(resolveBridgeConfig([], { BRIDGE_TRUST_PROXY: '0' }).trustProxyHops).toBe(0);
    const c = resolveBridgeConfig([], {
      BRIDGE_MAX_SESSIONS_PER_IP: '3', BRIDGE_MSG_RATE: '50', BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: '/data/s.xml',
      BRIDGE_ALLOW_PRIVATE_TARGETS: '1', BRIDGE_SERVERS_OVERLAY: '/etc/overlay.json', BRIDGE_METRICS_TOKEN: 's3cret',
    });
    expect(c.limits.maxSessionsPerIp).toBe(3);
    expect(c.limits.msgRatePerSec).toBe(50);
    expect(c.serverList).toMatchObject({ url: null, cachePath: '/data/s.xml', overlayPath: '/etc/overlay.json' });
    expect(c.allowPrivateTargets).toBe(true);
    expect(c.metricsToken).toBe('s3cret');
    expect(resolveBridgeConfig([], {}).serverList.url).toBe(DEFAULT_SERVERS_URL);
  });
});

// ─── Logs + metrics renderers ──────────────────────────

describe('logs and metrics', () => {
  it('formats one-line JSON logs', () => {
    const line = formatLogLine('info', 'session_close', { session: 3, error: new Error('boom') }, new Date(0));
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ t: '1970-01-01T00:00:00.000Z', level: 'info', event: 'session_close', session: 3, error: 'boom' });
  });

  it('rate-limits a log stream and reports suppressed lines', () => {
    const lines: [LogLevel, string, Record<string, unknown> | undefined][] = [];
    let t = 0;
    const l = rateLimitedLog((lv, e, f) => lines.push([lv, e, f]), 1000, () => t);
    l('warn', 'x', { a: 1 }); l('warn', 'x', { a: 2 }); l('warn', 'x', { a: 3 });
    t = 1000;
    l('warn', 'x', { a: 4 });
    expect(lines).toEqual([['warn', 'x', { a: 1 }], ['warn', 'x', { a: 4, suppressed: 2 }]]);
  });

  it('renders Prometheus text and the healthz body', () => {
    const m = new BridgeMetrics(() => 0);
    m.connects = 2; m.reject('ip_cap'); m.reject('ip_cap'); m.addBytes('ws_out', 500); m.drop('rate_limited'); m.close('ws_close');
    const snap = { mode: 'multi' as const, sessions: 1, perServer: [{ id: 's1', name: 'Nexus "PvP"', sessions: 1 }], serversList: { source: 'remote', servers: 40, ageSeconds: 12, lastError: null }, uptimeSeconds: 5 };
    const text = renderPrometheus(m, snap);
    expect(text).toContain('acbridge_sessions_active 1\n');
    expect(text).toContain('acbridge_server_sessions_active{server="s1",name="Nexus \\"PvP\\""} 1');
    expect(text).toContain('acbridge_rejects_total{reason="ip_cap"} 2');
    expect(text).toContain('acbridge_bytes_total{direction="ws_out"} 500');
    expect(text).toContain('acbridge_dropped_messages_total{reason="rate_limited"} 1');
    expect(text).toContain('acbridge_servers_list_age_seconds 12');
    expect(text).toContain('# TYPE acbridge_connects_total counter');
    expect(healthzBody(snap)).toMatchObject({ up: true, sessions: 1, perServer: { s1: { sessions: 1 } }, serversList: { ageSeconds: 12 } });
  });
});

// ─── End to end: real bridge, fake UDP game servers ────

interface FakeServer {
  port: number;
  auth: dgram.Socket;
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

/** Fake ACE/GDLE: base port + base+1, recording what arrives. */
async function fakeServer(): Promise<FakeServer> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const auth = await bindUdp(0);
    const port = auth.address().port;
    if (port >= 65535) { auth.close(); continue; }
    let world: dgram.Socket;
    try { world = await bindUdp(port + 1); } catch { auth.close(); continue; }
    const fs_: FakeServer = {
      port, auth, world, authMsgs: [], worldMsgs: [],
      close: () => { try { auth.close(); } catch { /* */ } try { world.close(); } catch { /* */ } },
    };
    auth.on('message', (msg, rinfo) => fs_.authMsgs.push({ msg, rinfo }));
    world.on('message', (msg, rinfo) => fs_.worldMsgs.push({ msg, rinfo }));
    return fs_;
  }
  throw new Error('could not bind a port pair');
}

function packet(flags: number, len = 24, seq = 1): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(seq, 0);
  b.writeUInt32LE(flags, 4);
  return b;
}

/** A server ConnectRequest carrying clientId at payload offset 16. */
function connectRequest(clientId: number): Buffer {
  const b = Buffer.alloc(20 + 32);
  b.writeUInt32LE(0, 0);
  b.writeUInt32LE(FLAG_CONNECT_REQUEST, 4);
  b.writeUInt16LE(0xB, 12);
  b.writeUInt32LE(clientId, 20 + 16);
  return b;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
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

const silent = () => {};

function baseConfig(env: Record<string, string>, argv: string[] = []): BridgeConfig {
  const c = resolveBridgeConfig(argv, { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', ...env });
  c.wsPort = 0;
  return c;
}

async function registryFor(srv: FakeServer, extra: ServerOverlay['servers'] = []): Promise<ServerRegistry> {
  const reg = new ServerRegistry({
    url: null, refreshMs: 0, cachePath: null,
    overlay: { servers: [{ id: 'local', name: 'Local Fake', emu: 'ACE', host: '127.0.0.1', port: srv.port, source: 'overlay' }, ...extra], deny: [] },
  });
  await reg.start();
  return reg;
}

describe('bridge end to end (multi mode)', () => {
  let srv: FakeServer;
  let bridge: BridgeServer | null = null;
  const sockets: WebSocket[] = [];
  beforeAll(async () => { srv = await fakeServer(); });
  afterAll(() => srv.close());
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    if (bridge) await bridge.shutdown();
    bridge = null;
    srv.authMsgs.length = 0;
    srv.worldMsgs.length = 0;
  });

  async function start(env: Record<string, string> = {}): Promise<string> {
    const config = baseConfig({ BRIDGE_MODE: 'multi', BRIDGE_ALLOW_PRIVATE_TARGETS: '1', ...env });
    bridge = createBridgeServer(config, { registry: await registryFor(srv), log: silent });
    const port = await bridge.listen();
    return `127.0.0.1:${port}`;
  }
  async function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
    const ws = await open(url, headers);
    sockets.push(ws);
    return ws;
  }

  it('round-trips WS→UDP→WS, routes ConnectResponse to port+1, drops foreign datagrams, Disconnects on close', async () => {
    const host = await start();
    const ws = await connect(`ws://${host}/connect?server=local`);
    const got = collect(ws);

    ws.send(packet(0x1, 30, 7));
    await until(() => srv.authMsgs.length === 1);
    expect(srv.authMsgs[0].msg.readUInt32LE(0)).toBe(7);
    const bridgeUdp = srv.authMsgs[0].rinfo;

    // Server → browser (from the base port, as GDLE does), with the client's session id.
    srv.auth.send(connectRequest(0x2A), bridgeUdp.port, bridgeUdp.address);
    await until(() => got.length === 1);
    expect(got[0].readUInt32LE(4)).toBe(FLAG_CONNECT_REQUEST);
    // ...and from the world port (ACE answers from both).
    srv.world.send(packet(0x4, 28), bridgeUdp.port, bridgeUdp.address);
    await until(() => got.length === 2);

    ws.send(packet(FLAG_CONNECT_RESPONSE, 28, 2));
    await until(() => srv.worldMsgs.length === 1);
    expect(srv.worldMsgs[0].rinfo.port).toBe(bridgeUdp.port); // same per-session socket

    // A third party poking the session's UDP port is dropped.
    const stranger = await bindUdp(0);
    stranger.send(packet(0x4, 28), bridgeUdp.port, bridgeUdp.address);
    await until(() => bridge!.metrics.drops.foreign_udp === 1);
    stranger.close();
    expect(got.length).toBe(2);

    // healthz shows the session against its server
    const health = await (await fetch(`http://${host}/healthz`)).json() as Record<string, any>;
    expect(health).toMatchObject({ up: true, mode: 'multi', sessions: 1, perServer: { local: { name: 'Local Fake', sessions: 1 } } });

    ws.close();
    await until(() => srv.authMsgs.length === 2);
    expect(srv.authMsgs[1].msg.equals(buildDisconnectPacket(0x2A))).toBe(true);
    await until(() => bridge!.snapshot().sessions === 0);

    const m = bridge!.metrics;
    expect(m.bytes).toEqual({ ws_in: 58, udp_out: 58, udp_in: 52 + 28, ws_out: 52 + 28 });
    expect(m.connects).toBe(1);
    expect(m.closes.get('ws_close')).toBe(1);
  });

  it('rejects private targets without the dev flag, unknown ids, and answers probe-only sessions', async () => {
    const host = await start({ BRIDGE_ALLOW_PRIVATE_TARGETS: '0' });
    await expect(open(`ws://${host}/connect?server=local`)).rejects.toThrow('status 403');
    await expect(open(`ws://${host}/connect?server=nope`)).rejects.toThrow('status 404');
    expect(bridge!.metrics.rejects.get('private_target')).toBe(1);
    expect(bridge!.metrics.rejects.get('unknown_server')).toBe(1);

    // No ?server: a probe-only session — "health" works, binary is never forwarded.
    const probe = await connect(`ws://${host}/`);
    probe.send(packet(0x1, 30));
    const reply = await new Promise<string>((resolve) => {
      probe.on('message', (d, isBinary) => { if (!isBinary) resolve(d.toString()); });
      probe.send('health');
    });
    expect(JSON.parse(reply)).toMatchObject({ bridge: 'ok', ace: 'unknown' });
    await new Promise(r => setTimeout(r, 50));
    expect(srv.authMsgs.length).toBe(0);
  });

  it('caps concurrent sessions per client IP (X-Forwarded-For behind a trusted proxy)', async () => {
    const host = await start({ BRIDGE_TRUST_PROXY: '1', BRIDGE_MAX_SESSIONS_PER_IP: '2' });
    const url = `ws://${host}/connect?server=local`;
    const a = { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' };
    await connect(url, a);
    const second = await connect(url, a);
    // BUG.multi-tab-login-pingpong — refused with a close the browser can read
    // (an HTTP 429 on the upgrade reached the page as a bare socket failure).
    const refused = await open(url, a);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      refused.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed).toEqual({ code: CLOSE_IP_CAP, reason: CLOSE_IP_CAP_REASON });
    expect(CLOSE_IP_CAP).toBe(BRIDGE_CLOSE_IP_CAP); // the client maps the same code
    expect(bridge!.snapshot().sessions).toBe(2); // never counted as a session
    await connect(url, { 'x-forwarded-for': '198.51.100.8' }); // another player is fine
    expect(bridge!.metrics.rejects.get('ip_cap')).toBe(1);
    second.close();
    await until(() => bridge!.snapshot().sessions === 2);
    await connect(url, a); // a slot freed
  });

  it('limits new connections per IP per window', async () => {
    const host = await start({ BRIDGE_TRUST_PROXY: '1', BRIDGE_CONNECT_RATE_PER_IP: '3' });
    const h = { 'x-forwarded-for': '198.51.100.9' };
    for (let i = 0; i < 3; i++) (await connect(`ws://${host}/`, h)).close();
    await expect(open(`ws://${host}/`, h)).rejects.toThrow('status 429');
    expect(bridge!.metrics.rejects.get('ip_rate')).toBe(1);
  });

  it('loopback peers skip per-IP limits when no proxy is trusted (local dev)', async () => {
    const host = await start({ BRIDGE_MAX_SESSIONS_PER_IP: '1', BRIDGE_CONNECT_RATE_PER_IP: '1' });
    await connect(`ws://${host}/`);
    await connect(`ws://${host}/`);
    await connect(`ws://${host}/`);
    expect(bridge!.snapshot().sessions).toBe(3);
  });

  it('caps sessions per target server and globally', async () => {
    const host = await start({ BRIDGE_MAX_SESSIONS_PER_SERVER: '1', BRIDGE_MAX_CONNECTIONS: '2' });
    await connect(`ws://${host}/connect?server=local`);
    await expect(open(`ws://${host}/connect?server=local`)).rejects.toThrow('status 503');
    expect(bridge!.metrics.rejects.get('server_cap')).toBe(1);
    await connect(`ws://${host}/`); // probe-only: not counted against the server
    await expect(open(`ws://${host}/`)).rejects.toThrow('status 503');
    expect(bridge!.metrics.rejects.get('global_cap')).toBe(1);
  });

  it('drops over-rate messages and closes a session on sustained flooding (1008)', async () => {
    const host = await start({ BRIDGE_MSG_RATE: '5', BRIDGE_MSG_BURST: '5', BRIDGE_ABUSE_MAX_DROPS: '10' });
    const ws = await connect(`ws://${host}/connect?server=local`);
    const closed = new Promise<number>(r => ws.once('close', (code) => r(code)));
    for (let i = 0; i < 40; i++) ws.send(packet(0x1, 24, i));
    expect(await closed).toBe(1008);
    expect(srv.authMsgs.length).toBeLessThanOrEqual(6); // the burst (+ refill) got through, the flood did not
    expect(bridge!.metrics.drops.rate_limited).toBeGreaterThanOrEqual(10);
    expect(bridge!.metrics.closes.get('abuse')).toBe(1);
  });

  it('enforces the byte-rate limit independently of the message rate', async () => {
    const host = await start({ BRIDGE_BYTE_RATE: '1000', BRIDGE_BYTE_BURST: '1000' });
    const ws = await connect(`ws://${host}/connect?server=local`);
    for (let i = 0; i < 5; i++) ws.send(packet(0x1, 400, i));
    await until(() => bridge!.metrics.drops.rate_limited === 3);
    expect(srv.authMsgs.length).toBe(2);
  });

  it('serves /metrics (Prometheus + JSON, optional bearer token) and 404s unknown paths', async () => {
    const host = await start({ BRIDGE_METRICS_TOKEN: 'tok' });
    await expect(open(`ws://${host}/connect?server=nope`)).rejects.toThrow('status 404');
    expect((await fetch(`http://${host}/metrics`)).status).toBe(401);
    const res = await fetch(`http://${host}/metrics`, { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('acbridge_rejects_total{reason="unknown_server"} 1');
    const json = await (await fetch(`http://${host}/metrics?format=json`, { headers: { authorization: 'Bearer tok' } })).json() as Record<string, any>;
    expect(json).toMatchObject({ up: true, rejects: { unknown_server: 1 }, bytes: { ws_in: 0 }, serversList: { source: 'none', servers: 1 } });
    expect((await fetch(`http://${host}/healthz`)).status).toBe(200);
    expect((await fetch(`http://${host}/nope`)).status).toBe(404);
    expect((await fetch(`http://${host}/connect`)).status).toBe(426);
  });

  it('rejects disallowed browser Origins', async () => {
    const host = await start();
    await expect(open(`ws://${host}/`, { origin: 'https://evil.example' })).rejects.toThrow('status 403');
    await connect(`ws://${host}/`, { origin: 'http://localhost:5173' });
    expect(bridge!.metrics.rejects.get('origin')).toBe(1);
  });

  it('graceful shutdown sends each session\'s Disconnect to its server', async () => {
    const host = await start();
    const ws = await connect(`ws://${host}/connect?server=local`);
    const closed = new Promise<number>(r => ws.once('close', (code) => r(code)));
    ws.send(packet(0x1));
    await until(() => srv.authMsgs.length === 1);
    const r = srv.authMsgs[0].rinfo;
    srv.auth.send(connectRequest(0x33), r.port, r.address);
    await until(() => bridge!.metrics.bytes.ws_out > 0);
    await bridge!.shutdown();
    bridge = null;
    await until(() => srv.authMsgs.length === 2);
    expect(srv.authMsgs[1].msg.equals(buildDisconnectPacket(0x33))).toBe(true);
    expect(await closed).toBe(1001);
  });
});

describe('RELEASE.error-reporting — POST /client-errors', () => {
  it('scrubs query strings and credential-shaped pairs; keeps only known fields within their caps', () => {
    expect(scrubText('at https://playwebac.com/?account=bob&password=hunter2:12:3')).toBe('at https://playwebac.com/:12:3');
    expect(scrubText('login failed password=hunter2; account: "bob"')).toBe('login failed password=[redacted]; account: "[redacted]"');
    const r = sanitizeClientError({
      kind: 'error', message: 'TypeError: x is undefined', stack: 'at f (https://a.example/assets/index.js?v=1:1:2)',
      source: 'https://a.example/assets/index.js', line: 1, column: 2, build: 'abc123', screen: 'world',
      userAgent: 'UA', count: 3, password: 'nope', extra: { big: true },
    });
    expect(r).toEqual({
      kind: 'error', message: 'TypeError: x is undefined', stack: 'at f (https://a.example/assets/index.js:1:2)',
      source: 'https://a.example/assets/index.js', line: 1, column: 2, build: 'abc123', screen: 'world', userAgent: 'UA', count: 3,
    });
    expect(sanitizeClientError({ kind: 'nope', message: 'x' })).toBeNull();
    expect(sanitizeClientError({ kind: 'error' })).toBeNull();
    expect(sanitizeClientError('str')).toBeNull();
    expect(sanitizeClientError({ kind: 'boot', message: 'm'.repeat(2000) })!.message.length).toBe(501);
  });

  it('accepts a report (204, CORS, logged as client_error, counted), rejects junk (400) and floods (429)', async () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const config = baseConfig({});
    const bridge = createBridgeServer(config, { log: (level: string, event: string, fields?: Record<string, unknown>) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const post = (body: string) => fetch(`http://127.0.0.1:${port}/client-errors`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
      const ok = await post(JSON.stringify({ kind: 'webglcontextlost', message: 'WebGL context lost', screen: 'world' }));
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('*');
      const entry = logs.find(l => l[1] === 'client_error');
      expect(entry?.[0]).toBe('warn');
      expect(entry?.[2]).toMatchObject({ kind: 'webglcontextlost', message: 'WebGL context lost', screen: 'world' });
      expect(bridge.metrics.clientErrors.get('webglcontextlost')).toBe(1);
      expect((await post('not json')).status).toBe(400);
      for (let i = 0; i < 28; i++) await post('{}');
      expect((await post(JSON.stringify({ kind: 'error', message: 'x' }))).status).toBe(429);
      const pre = await fetch(`http://127.0.0.1:${port}/client-errors`, { method: 'OPTIONS' });
      expect(pre.status).toBe(204);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe('bridge end to end (legacy pinned mode)', () => {
  it('bridges to the CLI-pinned target and ignores ?server', async () => {
    const srv = await fakeServer();
    const config = baseConfig({}, ['0', '127.0.0.1', String(srv.port)]);
    config.wsPort = 0;
    expect(config).toMatchObject({ mode: 'pinned', aceWorldPort: srv.port + 1 });
    const bridge = createBridgeServer(config, { log: silent });
    const port = await bridge.listen();
    try {
      const ws = await open(`ws://127.0.0.1:${port}/?server=does-not-matter`);
      const got = collect(ws);
      ws.send(packet(0x1, 24, 9));
      await until(() => srv.authMsgs.length === 1);
      const r = srv.authMsgs[0].rinfo;
      srv.auth.send(packet(0x4, 40), r.port, r.address);
      await until(() => got.length === 1);
      ws.send(packet(FLAG_CONNECT_RESPONSE));
      await until(() => srv.worldMsgs.length === 1);
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Record<string, any>;
      expect(health).toMatchObject({ mode: 'pinned', sessions: 1, perServer: { pinned: { sessions: 1 } }, serversList: null });
      ws.terminate();
    } finally {
      await bridge.shutdown();
      srv.close();
    }
  });

  it('refuses to build multi mode without a registry', () => {
    expect(() => createBridgeServer(baseConfig({ BRIDGE_MODE: 'multi' }), { log: silent })).toThrow(/ServerRegistry/);
  });
});

describe('ERA.dm-support: a pinned bridge names its server\'s era (docs/dark-majesty-support.md)', () => {
  let srv: FakeServer;
  let bridge: BridgeServer | null = null;
  beforeAll(async () => { srv = await fakeServer(); });
  afterAll(async () => { if (bridge) await bridge.shutdown(); srv.close(); });

  it('BRIDGE_ERA reaches the WebSocket "health" answer (what the hosted page may read) and /healthz', async () => {
    const config = baseConfig({ BRIDGE_ERA: 'classic-dereth' }, ['0', '127.0.0.1', String(srv.port), String(srv.port + 1)]);
    bridge = createBridgeServer(config, { log: silent });
    const host = `127.0.0.1:${await bridge.listen()}`;
    const probe = await open(`ws://${host}/`);
    const reply = await new Promise<string>((resolve) => {
      probe.on('message', (d, isBinary) => { if (!isBinary) resolve(d.toString()); });
      probe.send('health');
    });
    expect(JSON.parse(reply)).toMatchObject({ bridge: 'ok', era: 'classic-dereth' });
    expect(await (await fetch(`http://${host}/healthz`)).json()).toMatchObject({ mode: 'pinned', era: 'classic-dereth' });
  });
});

describe('ERA.dm-support: the web entrypoint passes ACJS_ERA_ASSET_BASES through, strictly', () => {
  const run = (value: string | undefined, eraDatSets?: string): { config: Record<string, unknown>; csp: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acjs-ep-'));
    fs.mkdirSync(path.join(dir, 'srv'));
    const script = fs.readFileSync(path.resolve(__dirname, '../deploy/web/entrypoint.sh'), 'utf8')
      .replaceAll('/srv/', `${dir}/srv/`)
      .replace(/^exec caddy.*$/m, 'printf "%s" "$ACJS_CSP" > "' + dir + '/csp"');
    fs.writeFileSync(path.join(dir, 'ep.sh'), script);
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', ACJS_ASSET_BASE: 'https://dats.example.org/raw' };
    if (value !== undefined) env.ACJS_ERA_ASSET_BASES = value;
    if (eraDatSets !== undefined) env.ACJS_ERA_DAT_SETS = eraDatSets;
    try {
      execFileSync('sh', [path.join(dir, 'ep.sh')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
      return { config: JSON.parse(fs.readFileSync(path.join(dir, 'srv/config.json'), 'utf8')), csp: fs.readFileSync(path.join(dir, 'csp'), 'utf8') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a valid object lands in config.json and its origins in connect-src', () => {
    const r = run('{"classic-dereth":"https://cd.example.org/sets/cd"}');
    expect(r.config.eraAssetBases).toEqual({ 'classic-dereth': 'https://cd.example.org/sets/cd' });
    expect(r.csp).toMatch(/connect-src [^;]*https:\/\/cd\.example\.org/);
  });

  it('unset or malformed values become {} and config.json stays valid JSON', () => {
    expect(run(undefined).config.eraAssetBases).toEqual({});
    expect(run('{"x":"https://a.org/\\"}evil"}').config.eraAssetBases).toEqual({});
    expect(run('{"classic-dereth":"https://x.org","bad":1}').config.eraAssetBases).toEqual({});
    expect(run('nope').config).toMatchObject({ assetBase: 'https://dats.example.org/raw', eraAssetBases: {} });
  });

  it('ACJS_ERA_DAT_SETS: classic eras\' streamed set pointers land in config.json and connect-src; malformed → {}', () => {
    const ok = run(undefined, '{"classicace-infiltration":"https://sets.example.org/v1/sets/classicace-infiltration-1.9.json"}');
    expect(ok.config.eraDatSets).toEqual({ 'classicace-infiltration': 'https://sets.example.org/v1/sets/classicace-infiltration-1.9.json' });
    expect(ok.csp).toMatch(/connect-src [^;]*https:\/\/sets\.example\.org/);
    expect(run(undefined).config.eraDatSets).toEqual({});
    expect(run(undefined, '{"x":"https://a.org/\\"}evil"}').config.eraDatSets).toEqual({});
  });
});
