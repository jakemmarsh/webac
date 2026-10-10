/**
 * ERA.live-detect — the bridge finds each ACE server's era from the login
 * version it accepts (services/ws-tcp-bridge/src/loginProbe.ts + eraDetect.ts)
 * instead of a per-server table. Drives the real modules: the probe's
 * LoginRequest against ClientConnection's own bytes, the verdict reader
 * against datagrams captured from live servers (Doctide = ClassicACE
 * Infiltration, Coldeve = stock ACE, 2026-10-06), a UDP round trip against a
 * local fake server, and the detector + directory merge with a scripted probe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as dgram from 'dgram';
import type { AddressInfo } from 'net';
import { ClientConnection } from '@ac/network';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ERA_PROFILES, EOR_ERA_ID, DAT_FILE_NAMES, datMismatch, type DatRole } from '../packages/renderer/src/era/EraProfiles';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { buildProbeLoginRequest, readLoginVerdict, udpProbeLogin, type LoginVerdict, type ProbeLogin } from '../services/ws-tcp-bridge/src/loginProbe';
import { ERA_LOGIN_LITERALS, EraDetector, DETECTION_TTL_MS, type Detection } from '../services/ws-tcp-bridge/src/eraDetect';
import { buildDirectory, withDetection, ServerDirectory } from '../services/ws-tcp-bridge/src/serverDirectory';
import { readPacketFlags } from '../services/ws-tcp-bridge/src/bridgeUtil';
import type { ServerEntry } from '../services/ws-tcp-bridge/src/serverList';

const hex = (s: string) => Buffer.from(s, 'hex');
/** Captured from doctide.online:9000 (ClassicACE Infiltration). */
const DOCTIDE_CONNECT_REQUEST = hex('0000000000000400a2ef28b70b000a8820000100aec4640a8834b241e38f4d33f23bbe9e010000008c18a00302a1455200000000');
const DOCTIDE_BOOT = hex('02000000060000008ed32abe0b000a886800010000000000000000800100680000000900dcf700005000206265636175736520796f7520617265206e6f742072756e6e696e672074686520636f72726563742065786563757461626c652066696c652076657273696f6e20666f722074686973207365727665720000');
const DOCTIDE_ACCOUNT_MISSING = hex('0200000006000000d2566c800b000b88180001000000000000000080010018000000090059f600000a000000');
/** Captured from play.coldeve.ac:9000 (stock ACE): boots before any ConnectRequest. */
const COLDEVE_BOOT = hex('00000000060000009c9dc9950b005c899400010000000000000000800100940000000900dcf700007c00206265636175736520796f757220636c69656e74206973206e6f742074686520636f72726563742076657273696f6e20666f722074686973207365727665722e20506c6561736520766973697420687474703a2f2f706c61792e656d752e61632f20746f2075706461746520746f206c617465737420636c69656e740000');

class FakeWebSocket {
  static readonly OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array): void { this.sent.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice()); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
}

/** The LoginRequest ClientConnection itself sends for this version/account and an empty password. */
function clientLoginRequest(version: string, account: string): Buffer {
  const g = globalThis as { WebSocket?: unknown };
  const saved = g.WebSocket;
  g.WebSocket = FakeWebSocket;
  try {
    const conn = new ClientConnection('ws://bridge.test', { loginProfile: { clientVersion: version, authStyle: 'account-password' } });
    conn.autoReconnect = false;
    conn.connect(account, '');
    FakeWebSocket.last!.open();
    const first = FakeWebSocket.last!.sent[0];
    conn.disconnect();
    return Buffer.from(first);
  } finally {
    g.WebSocket = saved;
  }
}

describe('probe LoginRequest', () => {
  it('is byte-for-byte the LoginRequest ClientConnection sends (every padding case)', () => {
    for (const [version, account] of [['1802', 'probeab12cd34'], ['i104', 'p'], ['c118', 'probe1'], ['1802', 'ab']]) {
      expect(buildProbeLoginRequest(version, account).equals(clientLoginRequest(version, account))).toBe(true);
    }
  });
});

describe('verdicts from captured server datagrams', () => {
  it('ClassicACE: the executable-version boot is a version rejection; AccountDoesntExist means the literal passed', () => {
    expect(readLoginVerdict(DOCTIDE_BOOT)).toEqual({
      kind: 'version-rejected', classicAce: true,
      reason: 'because you are not running the correct executable file version for this server',
    });
    expect(readLoginVerdict(DOCTIDE_ACCOUNT_MISSING)).toEqual({ kind: 'accepted' });
  });

  it('stock ACE: its own version wording is a version rejection too', () => {
    expect(readLoginVerdict(COLDEVE_BOOT)).toMatchObject({ kind: 'version-rejected', classicAce: false });
  });

  it('a ConnectRequest carries no verdict; any other CharacterError says nothing about the version', () => {
    expect(readLoginVerdict(DOCTIDE_CONNECT_REQUEST)).toBeNull();
    const full = Buffer.from(DOCTIDE_ACCOUNT_MISSING);
    full.writeUInt32LE(0x15, full.length - 4); // LogonServerFull
    expect(readLoginVerdict(full)).toEqual({ kind: 'other', detail: 'CharacterError 0x15' });
    expect(readLoginVerdict(Buffer.alloc(10))).toBeNull();
  });
});

describe('udpProbeLogin against a local server', () => {
  let server: dgram.Socket;
  let port = 0;
  const seen: { version: string; disconnects: number } = { version: '', disconnects: 0 };
  beforeAll(async () => {
    server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      if (readPacketFlags(msg) & 0x8000) { seen.disconnects++; return; }
      const n = msg.readUInt16LE(20);
      seen.version = msg.toString('latin1', 22, 22 + n);
      // ClassicACE order: ConnectRequest, then the verdict for the literal.
      server.send(DOCTIDE_CONNECT_REQUEST, rinfo.port, rinfo.address);
      server.send(seen.version === 'i104' ? DOCTIDE_ACCOUNT_MISSING : DOCTIDE_BOOT, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('sends the literal, reads the verdict, and closes the session the server opened', async () => {
    const probe = udpProbeLogin(2000);
    expect(await probe('127.0.0.1', port, '1802')).toMatchObject({ kind: 'version-rejected', classicAce: true });
    expect(seen.version).toBe('1802');
    expect(await probe('127.0.0.1', port, 'i104')).toEqual({ kind: 'accepted' });
    expect(seen.version).toBe('i104');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.disconnects).toBe(2);
  });

  it('times out on silence', async () => {
    const quiet = dgram.createSocket('udp4');
    await new Promise<void>((r) => quiet.bind(0, '127.0.0.1', () => r()));
    const p = (quiet.address() as AddressInfo).port;
    expect(await udpProbeLogin(200)('127.0.0.1', p, '1802')).toEqual({ kind: 'timeout' });
    quiet.close();
  });
});

describe('era literals', () => {
  it('match the client\'s era profiles exactly: every account-password profile, end of retail first', () => {
    expect(ERA_LOGIN_LITERALS[0]).toEqual({ version: '1802', era: null });
    const fromProfiles = Object.values(ERA_PROFILES)
      .filter((p) => p.id !== EOR_ERA_ID && p.login.authStyle === 'account-password')
      .map((p) => [p.login.clientVersion, p.id]).sort();
    const fromBridge = ERA_LOGIN_LITERALS.slice(1).map((l) => [l.version, l.era]).sort();
    expect(fromBridge).toEqual(fromProfiles);
    expect(new Set(ERA_LOGIN_LITERALS.map((l) => l.version)).size).toBe(ERA_LOGIN_LITERALS.length);
  });

  it('ClassicACE Infiltration: "i104" with portal 10006 / cell 10001 / language 10002', () => {
    const p = ERA_PROFILES['classicace-infiltration'];
    expect(p.login).toEqual({ clientVersion: 'i104', authStyle: 'account-password' });
    expect([p.own.portal!.iterations, p.own.cell!.iterations, p.own.local!.iterations]).toEqual([10006, 10001, 10002]);
    expect(p.own.highres).toBeUndefined();
  });
});

const srv = (id: string, emu = 'ACE', host = `${id}.example.org`): ServerEntry => ({ id, name: id, emu, host, port: 9000, source: 'list' });

/** A scripted server per address: the literal it accepts, or how it answers. */
function scriptedProbe(script: Record<string, string | 'timeout' | 'any'>, calls: string[]): ProbeLogin {
  return async (address, _port, version) => {
    calls.push(`${address}:${version}`);
    const want = script[address];
    if (want === 'timeout') return { kind: 'timeout' };
    if (want === 'any' || want === version) return { kind: 'accepted' };
    return { kind: 'version-rejected', classicAce: want !== '1802', reason: 'x' } as LoginVerdict;
  };
}

describe('EraDetector', () => {
  function detector(script: Record<string, string>, calls: string[], extra: { now?: () => number; busy?: (s: ServerEntry) => boolean } = {}) {
    return new EraDetector({
      probe: scriptedProbe(script, calls),
      resolve: async (host) => (host.startsWith('gone') ? null : host),
      sleep: async () => {},
      ...extra,
    });
  }

  it('stock ACE costs one probe; ClassicACE stops at its literal; refusing all is unsupported; silence records nothing', async () => {
    const calls: string[] = [];
    const d = detector({ 'a.example.org': '1802', 'b.example.org': 'i104', 'c.example.org': 'z999', 'd.example.org': 'timeout', 'e.example.org': 'any' }, calls);
    await d.sweep([srv('a'), srv('b'), srv('c'), srv('d'), srv('e')], () => true);
    expect(d.get('A')).toMatchObject({ kind: 'era', era: null, version: '1802' });
    expect(d.get('b')).toMatchObject({ kind: 'era', era: 'classicace-infiltration', version: 'i104', note: 'Dark Majesty era' });
    expect(d.get('c')).toMatchObject({ kind: 'unsupported', classicAce: true });
    expect(d.get('d')).toBeUndefined();
    expect(d.get('e')).toMatchObject({ kind: 'era', era: null });
    expect(calls.filter((c) => c.startsWith('a.'))).toEqual(['a.example.org:1802']);
    expect(calls.filter((c) => c.startsWith('b.'))).toEqual(['b.example.org:1802', 'b.example.org:i104']);
    expect(calls.filter((c) => c.startsWith('d.'))).toEqual(['d.example.org:1802']);
  });

  it('skips GDL/GDLE, servers TreeStats reports down, unresolvable hosts and busy slot-limited worlds', async () => {
    const calls: string[] = [];
    const d = detector({}, calls, { busy: (s) => s.id === 'busy' });
    await d.sweep([srv('g', 'GDL'), srv('h', 'GDLE'), srv('down'), srv('gone', 'ACE', 'gone.example.org'), srv('busy')], (id) => (id === 'down' ? false : null));
    expect(calls).toEqual([]);
  });

  it('keeps a result for the TTL, then probes again; concurrent sweeps share one run', async () => {
    let t = 1_000_000;
    const calls: string[] = [];
    const d = detector({ 'a.example.org': '1802' }, calls, { now: () => t });
    await Promise.all([d.sweep([srv('a')], () => true), d.sweep([srv('a')], () => true)]);
    expect(calls).toHaveLength(1);
    t += DETECTION_TTL_MS - 1;
    await d.sweep([srv('a')], () => true);
    expect(calls).toHaveLength(1);
    t += 2;
    await d.sweep([srv('a')], () => true);
    expect(calls).toHaveLength(2);
  });
});

describe('directory merge', () => {
  const era = (e: string | null, note: string | null = null): Detection => ({ kind: 'era', era: e, version: 'x', note, at: 0 });

  it('a detected classic era makes the world beta with its data note; end of retail changes nothing', () => {
    expect(withDetection({ compat: 'ok' }, era('classicace-infiltration', 'Dark Majesty era')))
      .toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classicace-infiltration' });
    expect(withDetection({ compat: 'ok', registration: 'Register on the website' }, era(null))).toEqual({ compat: 'ok', registration: 'Register on the website' });
    expect(withDetection({ compat: 'ok', registration: 'Register on the website' }, era('classicace-customdm', 'Dark Majesty era')))
      .toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classicace-customdm', registration: 'Register on the website' });
  });

  it('an overlay era is the fallback until detection answers; then detection decides', () => {
    const dekarutide = { compat: 'beta' as const, note: 'Dark Majesty era', era: 'classicace-customdm' };
    // Offline / not probed yet (and every GDL world, which is never probed): the overlay stands.
    expect(withDetection(dekarutide, undefined)).toBe(dekarutide);
    // It answered "c118": the same era.
    expect(withDetection(dekarutide, era('classicace-customdm', 'Dark Majesty era'))).toEqual(dekarutide);
    // It moved to another data release: detection's era and note replace the overlay's.
    expect(withDetection(dekarutide, era('classicace-infiltration', 'Dark Majesty era')))
      .toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classicace-infiltration' });
    // It now runs end of retail: no era, no classic label.
    expect(withDetection(dekarutide, era(null))).toEqual({ compat: 'ok' });
    // Refused every literal: incompatible, the overlay era dropped; other fields carry over.
    expect(withDetection({ ...dekarutide, registration: 'Register on the website' }, { kind: 'unsupported', classicAce: true, at: 0 }))
      .toEqual({ compat: 'incompatible', note: 'Unsupported client version', registration: 'Register on the website' });
    expect(withDetection({ compat: 'ok' }, undefined)).toEqual({ compat: 'ok' });
  });

  it('buildDirectory: an offline ClassicACE world keeps its fallback era; once probed, the detected one', () => {
    const dek: ServerEntry = { id: '4db379b0-587a-4775-9b7f-879e0f15ba4b', name: 'Dekarutide', emu: 'ACE', host: 'dekaru.ac', port: 9000, source: 'list' };
    expect(buildDirectory([dek], new Map(), new Map(), { now: 0, detected: () => undefined })[0])
      .toMatchObject({ era: 'classicace-customdm', compat: 'beta', compatNote: 'Dark Majesty era' });
    expect(buildDirectory([dek], new Map(), new Map(), { now: 0, detected: () => era('classicace-infiltration', 'Dark Majesty era') })[0])
      .toMatchObject({ era: 'classicace-infiltration', compat: 'beta', compatNote: 'Dark Majesty era' });
  });

  it('buildDirectory serves the detected era to the launcher', () => {
    const rows = buildDirectory([srv('doc'), srv('cold')], new Map(), new Map(), {
      now: 0, detected: (id) => (id === 'doc' ? era('classicace-infiltration', 'Dark Majesty era') : era(null)),
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.doc).toMatchObject({ era: 'classicace-infiltration', compat: 'beta', compatNote: 'Dark Majesty era' });
    expect(byId.cold).toMatchObject({ era: null, compat: 'ok', compatNote: null });
  });

  it('ServerDirectory sweeps after a feed refresh, passing TreeStats status', async () => {
    const calls: string[] = [];
    const detector = new EraDetector({ probe: scriptedProbe({ 'up.example.org': 'i104' }, calls), resolve: async (h) => h, sleep: async () => {} });
    const status = JSON.stringify({ servers: [{ guid: 'UP', status: { online: true } }, { guid: 'down', status: { online: false } }] });
    const dir = new ServerDirectory({
      servers: () => [srv('up'), srv('down')], countsUrl: null, statusUrl: 'https://status.test',
      fetchText: async () => status, detector,
    });
    await dir.refresh();
    await detector.sweep([], () => null); // joins the sweep refresh() started
    expect(calls).toEqual(['up.example.org:1802', 'up.example.org:i104']);
    expect(dir.body().servers.find((s) => s.id === 'up')).toMatchObject({ era: 'classicace-infiltration', compat: 'beta' });
  });
});

const INF = resolve(__dirname, '..', 'dat-sets/classicace-infiltration-1.9');
const hasInf = ['client_portal.dat', 'client_cell_1.dat', 'client_local_English.dat'].every((f) => existsSync(`${INF}/${f}`))
  && existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasInf)('ClassicACE Infiltration 1.9 DATs', () => {
  it('its own portal/cell/local are recognised; the end-of-retail files and the CustomDM portal are refused', () => {
    const p = ERA_PROFILES['classicace-infiltration'];
    const eor = { portal: DAT_PATHS.portal, cell: DAT_PATHS.cell, local: DAT_PATHS.local };
    for (const role of ['portal', 'cell', 'local'] as DatRole[]) {
      expect(datMismatch(p, role, openDat(`${INF}/${DAT_FILE_NAMES[role]}`))).toBeNull();
      expect(datMismatch(p, role, openDat(eor[role as 'portal' | 'cell' | 'local']))).not.toBeNull();
    }
    const cdm = resolve(__dirname, '..', 'dat-sets/classicace-customdm-1.60/client_portal.dat');
    if (existsSync(cdm)) expect(datMismatch(p, 'portal', openDat(cdm))).toMatch(/version 20044; ClassicACE Infiltration needs version 10006/);
  });
});
