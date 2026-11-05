/**
 * webac#22 — the AC1999 world showed no status and no player count in the
 * launcher. No feed reports AC1999 (TreeStats doesn't watch it; the 1999
 * server exposes no count without a login), so the bridge probes it itself
 * with the server-tracker login and lists a real `online`; its population
 * stays unknown (null, never an invented 0); the launcher's dot and details
 * chip carry the status. Drives the real modules (worldProbe.ts,
 * serverDirectory.ts) and a real UDP socket.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as dgram from 'dgram';
import type { AddressInfo } from 'net';
import { parseServersXml, ac1999Overlay, type ServerEntry } from '../services/ws-tcp-bridge/src/serverList';
import { ServerDirectory, TREESTATS_STATUS_URL } from '../services/ws-tcp-bridge/src/serverDirectory';
import {
  WorldReachability, trackerLoginProbe, UNKNOWN_AFTER_MISSES, WORLD_PROBE_MIN_INTERVAL_MS,
} from '../services/ws-tcp-bridge/src/worldProbe';
import { AC1999_TRACKER_LOGIN } from '../services/ws-tcp-bridge/src/egress';

const AC1999 = ac1999Overlay({}).servers[0];
const ACE_XML = `<ArrayOfServerItem><ServerItem><id>c0ldeve</id><name>Coldeve</name><emu>ACE</emu>
  <server_host>play.coldeve.ac</server_host><server_port>9000</server_port></ServerItem></ArrayOfServerItem>`;
const STATUS = { servers: [{ guid: 'c0ldeve', status: { online: true, last_seen: '2026-11-04T00:00:00Z' } }] };
const COUNTS = [{ server: 'Coldeve', count: 660, date: '2026-11-04 00:00:00 UTC' }];

function clock(start = Date.parse('2026-11-04T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('WorldReachability', () => {
  it('unknown until the first probe; a reply is online with its time as lastSeen', async () => {
    const c = clock();
    const r = new WorldReachability({ probe: async () => true, resolve: async () => '203.0.113.9', now: c.now });
    expect(r.get('ac1999')).toBeUndefined();
    await r.sweep([AC1999]);
    expect(r.get('AC1999')).toEqual({ online: true, lastSeen: new Date(c.now()).toISOString() });
  });

  it('one miss keeps online; UNKNOWN_AFTER_MISSES in a row is unknown (never offline); a reply brings it back', async () => {
    const c = clock();
    let up = true;
    const r = new WorldReachability({ probe: async () => up, resolve: async () => '203.0.113.9', now: c.now, minIntervalMs: 0 });
    await r.sweep([AC1999]);
    const seen = r.get('ac1999')!.lastSeen;
    up = false;
    for (let i = 1; i < UNKNOWN_AFTER_MISSES; i++) {
      c.advance(1000);
      await r.sweep([AC1999]);
      expect(r.get('ac1999')).toEqual({ online: true, lastSeen: seen });
    }
    for (let i = 0; i < 5; i++) {
      c.advance(1000);
      await r.sweep([AC1999]);
      expect(r.get('ac1999')).toBeUndefined(); // unknown, however long it stays silent
    }
    up = true;
    c.advance(1000);
    await r.sweep([AC1999]);
    expect(r.get('ac1999')?.online).toBe(true);
  });

  it('a world that never answered stays unknown, never offline; an unresolvable host is a miss', async () => {
    const c = clock();
    const probed: string[] = [];
    const r = new WorldReachability({ probe: async (a) => { probed.push(a); return false; }, resolve: async () => null, now: c.now, minIntervalMs: 0 });
    for (let i = 0; i < UNKNOWN_AFTER_MISSES + 3; i++) { await r.sweep([AC1999]); expect(r.get('ac1999')).toBeUndefined(); }
    expect(probed).toEqual([]); // nothing sent without an address
  });

  it('is rate-limited per world, joins a running sweep, and skips SPP worlds', async () => {
    const c = clock();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = new WorldReachability({
      probe: async () => { calls++; await gate; return true; }, resolve: async () => '203.0.113.9', now: c.now,
      skip: (s) => s.id === 'spp-world',
    });
    const a = r.sweep([AC1999, { ...AC1999, id: 'spp-world' }]);
    const b = r.sweep([AC1999]);
    expect(b).toBe(a);
    release();
    await a;
    expect(calls).toBe(1);
    expect(r.get('spp-world')).toBeUndefined();
    c.advance(WORLD_PROBE_MIN_INTERVAL_MS - 1);
    await r.sweep([AC1999]);
    expect(calls).toBe(1);
    c.advance(1);
    await r.sweep([AC1999]);
    expect(calls).toBe(2);
  });
});

describe('trackerLoginProbe (real UDP)', () => {
  let sock: dgram.Socket | null = null;
  afterEach(() => { try { sock?.close(); } catch { /* closed */ } sock = null; });

  async function server(reply: boolean): Promise<{ port: number; got: Buffer[] }> {
    const s = dgram.createSocket('udp4');
    sock = s;
    const got: Buffer[] = [];
    s.on('message', (msg, rinfo) => { got.push(msg); if (reply) s.send(Buffer.from([1, 2, 3]), rinfo.port, rinfo.address); });
    await new Promise<void>((res) => s.bind(0, '127.0.0.1', () => res()));
    return { port: (s.address() as AddressInfo).port, got };
  }

  it('sends the tracker login and is true on the first reply', async () => {
    const srv = await server(true);
    expect(await trackerLoginProbe(2000)('127.0.0.1', srv.port)).toBe(true);
    expect(srv.got[0].equals(AC1999_TRACKER_LOGIN)).toBe(true);
    expect(srv.got.length).toBe(1);
  });

  it('is false when the world never answers', async () => {
    const srv = await server(false);
    expect(await trackerLoginProbe(400)('127.0.0.1', srv.port)).toBe(false);
    expect(srv.got.length).toBeGreaterThan(0);
  });
});

describe('GET /servers rows for AC1999', () => {
  function directory(probe: (a: string, p: number) => Promise<boolean>, minIntervalMs?: number) {
    const probed: string[] = [];
    const reachability = new WorldReachability({
      probe: async (a, p) => { probed.push(`${a}:${p}`); return probe(a, p); }, resolve: async (h) => `ip-of-${h}`, minIntervalMs,
    });
    const servers = (): ServerEntry[] => [...parseServersXml(ACE_XML).servers, AC1999];
    const d = new ServerDirectory({
      servers, refreshMs: 0, reachability,
      fetchText: async (url) => JSON.stringify(url === TREESTATS_STATUS_URL ? STATUS : COUNTS),
    });
    return { d, probed, reachability };
  }

  it('AC1999 gets a probed online with population unknown (null, never 0); only AC1999 is probed; ACE rows unchanged', async () => {
    const { d, probed, reachability } = directory(async () => true);
    const before = d.body().servers.find((s) => s.id === 'ac1999')!;
    expect(before).toMatchObject({ online: null, population: null });
    await d.refresh();
    await reachability.sweep([]); // the refresh's sweep runs in the background; this joins it
    expect(probed).toEqual(['ip-of-ac1999.cobradragon.com:9110']);
    const rows = d.body().servers;
    expect(rows.find((s) => s.id === 'ac1999')).toMatchObject({ online: true, population: null, era: 'ac1999-retail' });
    expect(rows.find((s) => s.id === 'c0ldeve')).toMatchObject({ online: true, population: 660 });
  });

  it('a silent AC1999 stays online: null (row blank, still enterable), never offline', async () => {
    let up = true;
    const { d, reachability, probed } = directory(async () => up, 0);
    const row = () => d.body().servers.find((s) => s.id === 'ac1999')!;
    await d.refresh();
    await reachability.sweep([]);
    expect(row().online).toBe(true);
    up = false;
    for (let i = 0; i < UNKNOWN_AFTER_MISSES + 2; i++) {
      await d.refresh();
      await reachability.sweep([]);
      expect(row().online).not.toBe(false);
    }
    expect(probed.length).toBe(UNKNOWN_AFTER_MISSES + 3);
    expect(row()).toMatchObject({ online: null, population: null });
  });

  it('a status-feed row, if one ever appears, wins over the probe (and the world is no longer probed)', async () => {
    const { d, probed } = directory(async () => true);
    const status = { servers: [...STATUS.servers, { guid: 'ac1999', status: { online: false, last_seen: null } }] };
    const d2 = new ServerDirectory({
      servers: () => [AC1999], refreshMs: 0,
      reachability: new WorldReachability({ probe: async () => { probed.push('x'); return true; }, resolve: async () => '1.2.3.4' }),
      fetchText: async (url) => JSON.stringify(url === TREESTATS_STATUS_URL ? status : COUNTS),
    });
    await d2.refresh();
    expect(d2.unwatched()).toEqual([]);
    expect(probed).toEqual([]);
    expect(d2.body().servers[0]).toMatchObject({ online: false, population: null });
    expect(d.unwatched().map((s) => s.id)).toEqual(['ac1999']);
  });
});
