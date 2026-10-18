/**
 * RELEASE.launcher-screen — the bridge's GET /servers world list: Servers.xml
 * details + TreeStats live status + TreeStats player counts + the committed
 * era/compat overlay, merged, sorted and served with CORS `*`. Drives the
 * real modules with fixtures (2026-10-04 shapes), no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { gunzipSync } from 'zlib';
import { parseServersXml, normalizeLinkUrl, type ServerEntry } from '../services/ws-tcp-bridge/src/serverList';
import {
  parseTreeStatsStatus, parsePlayerCounts, buildDirectory, compareEntries, ServerDirectory, withDetection,
  POPULATION_MAX_AGE_MS, TREESTATS_STATUS_URL, TREESTATS_COUNTS_URL, type DirectoryEntry,
} from '../services/ws-tcp-bridge/src/serverDirectory';
import { compatFor, SERVER_COMPAT, VPN_BLOCK } from '../services/ws-tcp-bridge/src/serverCompat';
import { BridgeMetrics, makeHttpHandler, type BridgeSnapshot } from '../services/ws-tcp-bridge/src/metrics';

const NOW = Date.parse('2026-10-04T16:15:00Z');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfServerItem>
  <ServerItem><id>c0ldeve</id><name>Coldeve</name><description>A PVE AC Server</description><emu>ACE</emu>
    <server_host>play.coldeve.ac</server_host><server_port>9000</server_port><type>PvE</type>
    <website_url></website_url><discord_url>https://discord.gg/nUR4PHe</discord_url></ServerItem>
  <ServerItem><id>394C58D0-885D-466B-B17F-D7E0B96FE3E2</id><name>Seedsow</name>
    <description>A PVE Dark Majesty server must use classic AC .dats</description><emu>GDL</emu>
    <server_host>serafino.ddns.net</server_host><server_port>9060</server_port><type>PvE</type></ServerItem>
  <ServerItem><id>reef</id><name>Reefcull</name><emu>GDL</emu><server_host>reefcull.gdleac.com</server_host>
    <server_port>9000</server_port><type>PvE</type></ServerItem>
  <ServerItem><id>harvest</id><name>Harvestbud</name><emu>GDLE</emu><server_host>harvestbud.gdleac.com</server_host>
    <server_port>9010</server_port><website_url>gdleac.com</website_url><discord_url>javascript:alert(1)</discord_url></ServerItem>
  <ServerItem><id>funky</id><name>FunkyTown 2.0</name><emu>GDL</emu><server_host>funkytownac.com</server_host>
    <server_port>9050</server_port></ServerItem>
  <ServerItem><id>aprime</id><name>ACPrime</name><emu>ACE</emu><server_host>asheronscall.hopto.org</server_host>
    <server_port>9000</server_port></ServerItem>
  <ServerItem><id>leaf</id><name>LeafDawn</name><emu>ACE</emu><server_host>leafdawn.example.org</server_host>
    <server_port>9000</server_port></ServerItem>
</ArrayOfServerItem>`;

const STATUS = {
  last_checked: '2026-10-04T16:13:47Z',
  count: 6,
  servers: [
    { guid: 'C0LDEVE', name: 'Coldeve', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: '394c58d0-885d-466b-b17f-d7e0b96fe3e2', name: 'Seedsow', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: 'reef', name: 'Reefcull', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: 'harvest', name: 'Harvestbud', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: 'funky', name: 'FunkyTown 2.0', status: { online: false, last_seen: '2026-09-01T00:00:00Z' } },
    { guid: 'aprime', name: 'ACPrime', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: 'leaf', name: 'LeafDawn', status: { online: true, last_seen: '2026-10-04T16:13:47Z' } },
    { guid: 'broken' },
  ],
};

const COUNTS = [
  { server: 'Coldeve', count: 691, date: '2026-10-04 16:09:42 UTC', age: '3 minutes ago' },
  { server: 'Seedsow', count: 35, date: '2026-10-03 10:00:00 UTC', age: 'a day ago' },
  { server: 'Reefcull', count: 164, date: '2026-10-04 15:00:00 UTC', age: 'an hour ago' },
  { server: 'Harvestbud', count: 5, date: '2026-09-20 00:00:00 UTC', age: '2 weeks ago' }, // stale
  { server: 'FunkyTown 2.0', count: 9, date: '2026-10-04 15:00:00 UTC', age: 'an hour ago' }, // offline
  { server: 'LeafDawn', count: 63, date: '2026-10-04 15:00:00 UTC', age: 'an hour ago' },
  { server: 'nope', count: -3 },
];

function fixtureServers(): ServerEntry[] { return parseServersXml(XML).servers; }

describe('Servers.xml details', () => {
  it('parses description / type / website / discord; links must be http(s), scheme-less gets https', () => {
    const s = fixtureServers();
    expect(s[0]).toMatchObject({ name: 'Coldeve', description: 'A PVE AC Server', type: 'PvE', discord: 'https://discord.gg/nUR4PHe' });
    expect(s[0].website).toBeUndefined();
    const harvest = s.find(x => x.id === 'harvest')!;
    expect(harvest.website).toBe('https://gdleac.com/');
    expect(harvest.discord).toBeUndefined();
    expect(normalizeLinkUrl('ftp://x.org')).toBeUndefined();
    expect(normalizeLinkUrl('http://a-chard.ddns.net/')).toBe('http://a-chard.ddns.net/');
  });
});

describe('TreeStats feeds', () => {
  it('status is keyed by lower-cased guid; malformed rows skipped', () => {
    const m = parseTreeStatsStatus(STATUS);
    expect(m.get('c0ldeve')).toEqual({ online: true, lastSeen: '2026-10-04T16:13:47Z' });
    expect(m.get('funky')?.online).toBe(false);
    expect(m.has('broken')).toBe(false);
    expect(parseTreeStatsStatus({ nope: 1 }).size).toBe(0);
    expect(parseTreeStatsStatus(null).size).toBe(0);
  });

  it('player counts are keyed by lower-cased name with a parsed UTC date', () => {
    const m = parsePlayerCounts(COUNTS);
    expect(m.get('coldeve')).toEqual({ count: 691, at: Date.parse('2026-10-04T16:09:42Z') });
    expect(m.has('nope')).toBe(false);
    expect(parsePlayerCounts({}).size).toBe(0);
  });
});

describe('compat overlay', () => {
  it('undetectable classic servers name their era by id; GDL/GDLE are beta by emu; the rest ok', () => {
    // ERA.dm-support: the client loads the era's DATs and login for these.
    // Seedsow and Snowreap (same host) run Classic Dereth 1.0 data (no Salvaging): the 1.1 set
    // minus that skill. Seedsow answered a 1.1 create with Corrupt on 2026-10-12.
    expect(compatFor('394C58D0-885D-466B-B17F-D7E0B96FE3E2', 'GDL')).toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classic-dereth-1-0' });
    expect(compatFor('eea962c0-cf9f-481e-9736-0eb058acc1d8', 'GDL')).toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classic-dereth-1-0' });
    // ClassicACE worlds keep a fallback era until live detection (eraDetect.ts) answers.
    expect(compatFor('4db379b0-587a-4775-9b7f-879e0f15ba4b', 'ACE')).toEqual({ compat: 'beta', note: 'Dark Majesty era', era: 'classicace-customdm' }); // Dekarutide
    expect(compatFor('3f1f41ec-c7fd-4ed9-b47d-25b0d94219c1', 'ACE').era).toBe('classicace-customdm'); // Unfamiliar Shores
    expect(compatFor('anything', 'ACE').era).toBeUndefined();
    expect(compatFor('anything', 'gdle')).toEqual({ compat: 'beta', note: 'GDLE: beta' });
    expect(compatFor('anything', 'ACE')).toEqual({ compat: 'ok' });
    // Every committed id key is lower-case (lookups lower-case the id).
    for (const k of Object.keys(SERVER_COMPAT.byId)) expect(k).toBe(k.toLowerCase());
  });

  it('Reefcull and Harvestbud (web-form registration only) carry a registration line and their own form, and stay GDLE beta', () => {
    // gdleac.com "Step 4: Account Creation" links each world's form; docs/gdle-compat.md.
    expect(compatFor('A7502AC9-0CEC-4CAF-B81C-B3EB40A4689A', 'GDL')).toEqual({
      compat: 'beta', note: 'GDLE: beta',
      registration: 'Register on the Reefcull website first (lower-case names only).',
      registrationUrl: 'http://reefcull.gdleac.com/',
    });
    expect(compatFor('f023fbf9-caab-4745-8205-81c4d7c061ad', 'GDLE')).toMatchObject({
      compat: 'beta', note: 'GDLE: beta', registrationUrl: 'http://harvestbud.gdleac.com/',
    });
    expect(compatFor('f023fbf9-caab-4745-8205-81c4d7c061ad', 'GDLE').registration).toMatch(/^Register on the Harvestbud website first/);
    // Other worlds create accounts on first login: no registration.
    expect(compatFor('anything', 'GDLE').registrationUrl).toBeUndefined();
    expect(compatFor('anything', 'ACE').registration).toBeUndefined();
  });
});

describe('worlds whose VPN check refuses the bridge (survey 2026-10-12, docs/operators.md)', () => {
  const CONQUEST = '2d7bfb40-7726-4951-b65f-b4948807e602';
  const ACHARD = '9D17CE44-7DB5-40C1-B7BB-A01C9DE21D00'; // Servers.xml spells it upper-case

  it('Conquest and AChard are refused with a reason; no other world is', () => {
    for (const id of [CONQUEST, ACHARD]) {
      expect(compatFor(id, 'ACE')).toEqual({
        compat: 'incompatible', note: 'Blocks webAC', reason: "Its VPN check refuses webAC players. We're working on a fix.",
      });
    }
    const blocked = Object.entries(SERVER_COMPAT.byId).filter(([, c]) => c === VPN_BLOCK).map(([id]) => id).sort();
    expect(blocked).toEqual([CONQUEST, ACHARD.toLowerCase()].sort());
    // Only a refused world carries a reason.
    for (const c of [...Object.values(SERVER_COMPAT.byId), ...Object.values(SERVER_COMPAT.byEmu)]) {
      if (c.reason) expect(c.compat).toBe('incompatible');
    }
  });

  it('their /servers rows say why; open worlds carry compatReason null', () => {
    const servers: ServerEntry[] = [
      ...fixtureServers(),
      { id: ACHARD, name: 'AChard', emu: 'ACE', host: 'achard.example.org', port: 9000, source: 'list' },
      { id: CONQUEST, name: 'Conquest', emu: 'ACE', host: 'conquest.example.org', port: 9000, source: 'list' },
    ];
    const byName = Object.fromEntries(buildDirectory(servers, new Map(), new Map(), { now: NOW }).map(e => [e.name, e]));
    for (const n of ['AChard', 'Conquest']) {
      expect(byName[n]).toMatchObject({
        compat: 'incompatible', compatNote: 'Blocks webAC', compatReason: "Its VPN check refuses webAC players. We're working on a fix.", era: null,
      });
    }
    expect(byName.Coldeve.compatReason).toBeNull();
    expect(byName.Seedsow.compatReason).toBeNull();
  });

  it('the block stands over live era detection (AChard boots the probe as it boots players)', () => {
    const blocked = { ...VPN_BLOCK };
    // The probe is booted for every literal: still the VPN reason, not "Unsupported client version".
    expect(withDetection(blocked, { kind: 'unsupported', classicAce: false, at: 0 }))
      .toEqual({ compat: 'incompatible', note: 'Blocks webAC', reason: "Its VPN check refuses webAC players. We're working on a fix." });
    // Detected end of retail, or a classic era: the era is kept, the block too.
    expect(withDetection(blocked, { kind: 'era', era: null, version: '1802', note: null, at: 0 }))
      .toMatchObject({ compat: 'incompatible', note: 'Blocks webAC', reason: "Its VPN check refuses webAC players. We're working on a fix." });
    expect(withDetection(blocked, { kind: 'era', era: 'classicace-customdm', version: 'c118', note: 'Dark Majesty era', at: 0 }))
      .toEqual({ compat: 'incompatible', note: 'Blocks webAC', reason: "Its VPN check refuses webAC players. We're working on a fix.", era: 'classicace-customdm' });
    // A detection-only refusal (no overlay reason) is unchanged.
    expect(withDetection({ compat: 'ok' }, { kind: 'unsupported', classicAce: false, at: 0 }))
      .toEqual({ compat: 'incompatible', note: 'Unsupported client version' });
  });
});

describe('buildDirectory registration', () => {
  it('the /servers rows of the real Reefcull and Harvestbud ids carry registration + registrationUrl; others null', () => {
    const real: Record<string, string> = { reef: 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a', harvest: 'f023fbf9-caab-4745-8205-81c4d7c061ad' };
    const servers = fixtureServers().map((s) => ({ ...s, id: real[s.id] ?? s.id }));
    const rows = buildDirectory(servers, new Map(), new Map(), { now: NOW });
    const byName = Object.fromEntries(rows.map(e => [e.name, e]));
    expect(byName.Reefcull).toMatchObject({ compat: 'beta', compatNote: 'GDLE: beta', registrationUrl: 'http://reefcull.gdleac.com/' });
    expect(byName.Reefcull.registration).toMatch(/Register on the Reefcull website first/);
    expect(byName.Harvestbud).toMatchObject({ registrationUrl: 'http://harvestbud.gdleac.com/' });
    expect(byName.Coldeve).toMatchObject({ registration: null, registrationUrl: null });
    expect(byName['FunkyTown 2.0']).toMatchObject({ compat: 'beta', registration: null, registrationUrl: null });
  });
});

describe('buildDirectory', () => {
  const dir = (): DirectoryEntry[] =>
    buildDirectory(fixtureServers(), parseTreeStatsStatus(STATUS), parsePlayerCounts(COUNTS), { now: NOW });

  it('merges status, fresh population and compat per server', () => {
    const byName = Object.fromEntries(dir().map(e => [e.name, e]));
    expect(byName.Coldeve).toMatchObject({ online: true, population: 691, compat: 'ok', compatNote: null, emu: 'ACE', type: 'PvE' });
    expect(byName.Seedsow).toMatchObject({ online: true, population: 35, compat: 'beta', compatNote: 'Dark Majesty era', era: 'classic-dereth-1-0' });
    expect(byName.Coldeve.era).toBeNull();
    expect(byName.Reefcull).toMatchObject({ population: 164, compat: 'beta', compatNote: 'GDLE: beta' });
    expect(byName.Harvestbud.population).toBeNull(); // count older than POPULATION_MAX_AGE_MS
    expect(byName['FunkyTown 2.0']).toMatchObject({ online: false, population: null });
    expect(byName.ACPrime).toMatchObject({ online: true, population: null }); // no count row
    expect(POPULATION_MAX_AGE_MS).toBe(3 * 24 * 3600 * 1000);
  });

  it('sorts online by population (incompatible in place), unknown status next, offline last', () => {
    const extra: ServerEntry = { id: 'mine', name: 'Overlay Local', emu: 'ACE', host: 'x.org', port: 9000, source: 'overlay' };
    const names = buildDirectory([...fixtureServers(), extra], parseTreeStatsStatus(STATUS), parsePlayerCounts(COUNTS), { now: NOW })
      .map(e => e.name);
    expect(names).toEqual(['Coldeve', 'Reefcull', 'LeafDawn', 'Seedsow', 'ACPrime', 'Harvestbud', 'Overlay Local', 'FunkyTown 2.0']);
  });

  it('compareEntries breaks population ties by name', () => {
    const e = (name: string, population: number | null, online: boolean | null) =>
      ({ name, population, online } as DirectoryEntry);
    expect([e('b', 5, true), e('a', 5, true)].sort(compareEntries).map(x => x.name)).toEqual(['a', 'b']);
  });
});

describe('ServerDirectory (cached feeds)', () => {
  it('fetches both feeds, serves the merged body, and keeps the last good copy on failure', async () => {
    let fail = false;
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (fail) throw new Error('HTTP 503');
      return JSON.stringify(url === TREESTATS_STATUS_URL ? STATUS : COUNTS);
    };
    const logs: string[] = [];
    const d = new ServerDirectory({ servers: fixtureServers, fetchText, now: () => NOW, refreshMs: 0, log: (_l, ev) => { logs.push(ev); } });
    expect(d.body().updatedAt).toBeNull();
    expect(d.body().servers.every(s => s.online === null)).toBe(true);
    await d.refresh();
    expect(calls).toEqual([TREESTATS_STATUS_URL, TREESTATS_COUNTS_URL]);
    const first = d.body();
    expect(first.mode).toBe('multi');
    expect(first.updatedAt).toBe(new Date(NOW).toISOString());
    expect(first.servers[0]).toMatchObject({ name: 'Coldeve', population: 691 });
    fail = true;
    await d.refresh();
    expect(d.body().servers[0]).toMatchObject({ name: 'Coldeve', population: 691, online: true });
    expect(logs).toEqual(['servers_status_fetch_failed', 'servers_counts_fetch_failed']);
  });
});

describe('GET /servers and /healthz (HTTP handler)', () => {
  let server: http.Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = null; });

  async function serve(mode: 'pinned' | 'multi', servers: (() => unknown) | null): Promise<string> {
    const snap = (): BridgeSnapshot => ({ mode, sessions: 0, perServer: [], serversList: null, uptimeSeconds: 1 });
    server = http.createServer(makeHttpHandler(new BridgeMetrics(), snap, { metricsToken: 'secret', servers }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('multi mode answers the directory body with CORS *, no auth needed', async () => {
    const d = new ServerDirectory({ servers: fixtureServers, fetchText: async (u) => JSON.stringify(u === TREESTATS_STATUS_URL ? STATUS : COUNTS), now: () => NOW, refreshMs: 0 });
    await d.refresh();
    const base = await serve('multi', () => d.body());
    const res = await fetch(`${base}/servers`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json() as { mode: string; servers: DirectoryEntry[] };
    expect(body.mode).toBe('multi');
    expect(body.servers.map(s => s.name).slice(0, 2)).toEqual(['Coldeve', 'Reefcull']);
    expect(Object.keys(body.servers[0]).sort()).toEqual([
      'compat', 'compatNote', 'compatReason', 'compatWarning', 'description', 'discord', 'emu', 'era', 'id', 'lastSeen', 'name', 'online', 'perIpLimits', 'population', 'registration', 'registrationUrl', 'type', 'website',
    ]);
    // An ordinary world carries neither the warning nor per-address caps.
    expect(body.servers[0]).toMatchObject({ compatWarning: null, perIpLimits: null });
    // /metrics stays behind its token
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
  });

  it('pinned mode: /servers is an empty pinned list and /healthz carries the mode, both CORS *', async () => {
    const base = await serve('pinned', null);
    const s = await fetch(`${base}/servers`);
    expect(s.headers.get('access-control-allow-origin')).toBe('*');
    expect(await s.json()).toEqual({ mode: 'pinned', updatedAt: null, servers: [] });
    const h = await fetch(`${base}/healthz`);
    expect(h.headers.get('access-control-allow-origin')).toBe('*');
    expect((await h.json() as { mode: string }).mode).toBe('pinned');
  });

  it('/servers goes gzipped to a client that accepts it and plain to one that does not, the same JSON either way', async () => {
    const list = { mode: 'multi', updatedAt: '2026-10-17T00:00:00Z', servers: [{ name: 'Coldeve' }] };
    const base = await serve('multi', () => list);
    const raw = (encoding: string | null) => new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http.get(`${base}/servers`, { headers: encoding ? { 'accept-encoding': encoding } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    const zipped = await raw('gzip, deflate, br');
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers['vary']).toBe('accept-encoding');
    expect(zipped.headers['access-control-allow-origin']).toBe('*');
    expect(JSON.parse(gunzipSync(zipped.body).toString('utf8'))).toEqual(list);
    const plain = await raw(null);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['vary']).toBe('accept-encoding');
    expect(JSON.parse(plain.body.toString('utf8'))).toEqual(list);
  });
});
