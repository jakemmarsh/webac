/**
 * BUG.ac1999-slow-login-ddd-push — a first 1999 visit already at the server's patch level.
 *
 * The AC1999 server pushes its whole patched-DAT difference to any client reporting another
 * iteration (Client.cpp UpdateLoginScreen → PlanDatSync; the rule is TurbineData.cpp
 * GetSyncPlan), so a fresh browser (the world set's 102 / 67) waits 10-14 s. A seed is that push
 * prepared ahead (dat-parser era1999 ServerPatchSeed), listed per server in the 1999 world set's
 * pointer (`serverSeeds`), applied by Ac1999World.restore where nothing is stored.
 *
 * Pinned against the shipped code:
 * - the format round-trips and refuses damage; the plan is GetSyncPlan's rule;
 * - a capture of what a browser stored (the real OpfsDatBlobStore + Ac1999World.persist, read
 *   back by the real CAPTURE_SNIPPET) compares byte for byte with the seed, and one changed
 *   byte is reported;
 * - restore: the newest state fully held wins (a seed above an unseeded stored state replaces it,
 *   BUG.ac1999-stored-patches-beat-newer-seed; one equal or past it is kept unfetched); a state
 *   built on a seed comes back only with that seed, never mixed with another; a server that
 *   moved on gets its diff applied and stored over the seed; a seed from other base iterations
 *   is refused;
 * - the pointer / DatStore / ac1999SeedSource path end to end, and refusals;
 * - end of retail / Dark Majesty: a pointer without the key parses exactly as before, and a set
 *   with no seed for the server offers none.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import {
  crc32, decodeServerPatchSeed, encodeServerPatchSeed, planDatSync, stampOf, DDD_MAX_FILE_BYTES,
  type DatManifest, type PatchRecord, type ServerPatchSeed,
} from '../packages/dat-parser/src/era1999/ServerPatchSeed.js';
import { parseSetPointer, type DatSetPointer } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatStore } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { OpfsDatBlobStore, type DatBlobStore, type DatCacheMeta } from '../packages/renderer/src/dat/DatCache.js';
import {
  Ac1999World, ac1999SeedFromPayload, ac1999SeedSource, type Ac1999PatchEvent, type Ac1999Seed,
} from '../packages/renderer/src/era/Ac1999World.js';
import {
  CAPTURE_SNIPPET, checkPristineAgainstManifests, compareSeeds, gzipObject, parseCapture, planSeedFromDats,
  pointerWithServerSeed, readSeedFile, seedFromCapture, seedHash, verifyAgainstServerManifests,
} from '../tools/lib/ac1999-seed.js';

const SERVER_KEY = 'bridge.playwebac.com__server_ac1999';
const bytes = (...v: number[]) => new Uint8Array(v);
const rec = (dat: 'portal' | 'cell', id: number, ...v: number[]): PatchRecord => ({ dat, id, bytes: bytes(...v) });

/** A 10006-like push: a changed spell table, added portal records, added cell records. */
function sampleSeed(): ServerPatchSeed {
  return {
    base: { portal: 102, cell: 67 },
    iterations: { portal: 10006, cell: 10006 },
    records: [
      rec('cell', 0xd755fffe, 9, 9, 9),
      rec('portal', 0x0e00000e, 1, 2, 3, 4),
      rec('portal', 0x01001932, 5, 6),
      rec('cell', 0x8dd1fffe, 7),
    ],
  };
}

describe('ServerPatchSeed format', () => {
  it('round-trips in canonical order, so equal content has one encoding (and one hash)', () => {
    const a = encodeServerPatchSeed(sampleSeed());
    const shuffled = { ...sampleSeed(), records: [...sampleSeed().records].reverse() };
    expect([...encodeServerPatchSeed(shuffled)]).toEqual([...a]);
    const back = decodeServerPatchSeed(a);
    expect(back.base).toEqual({ portal: 102, cell: 67 });
    expect(back.iterations).toEqual({ portal: 10006, cell: 10006 });
    expect(back.records.map((r) => `${r.dat}:${r.id.toString(16)}`)).toEqual(['portal:1001932', 'portal:e00000e', 'cell:8dd1fffe', 'cell:d755fffe']);
    expect([...back.records[1].bytes]).toEqual([1, 2, 3, 4]);
  });

  it('refuses a damaged payload: a flipped record byte fails its crc32, a truncation runs short', () => {
    const a = encodeServerPatchSeed(sampleSeed());
    const flipped = a.slice();
    flipped[flipped.length - 1] ^= 1;
    expect(() => decodeServerPatchSeed(flipped)).toThrow(/crc32/);
    expect(() => decodeServerPatchSeed(a.slice(0, a.length - 1))).toThrow(/past the payload/);
    expect(() => decodeServerPatchSeed(bytes(1, 2, 3))).toThrow(/ACSS/);
    expect(() => encodeServerPatchSeed({ ...sampleSeed(), records: [rec('portal', 1, 1), rec('portal', 1, 2)] })).toThrow(/twice/);
  });

  it('crc32 is zlib\'s (the server manifests\' column)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('planDatSync = TurbineData.cpp GetSyncPlan', () => {
  const m = (entries: Array<[number, number[]]>): DatManifest => new Map(entries.map(([id, b]) => [id, stampOf(bytes(...b))]));
  it('pushes changed and missing records in id order, keeps the client\'s extras, skips identical ones', () => {
    const server = m([[3, [1]], [1, [2, 2]], [2, [5]], [9, [4]]]);
    const client = m([[1, [2, 2]], [2, [6]], [7, [0]]]);
    expect(planDatSync(server, client)).toEqual({ files: [2, 3, 9], rawBytes: 3, unremovable: 1 });
  });
  it('a record at the client\'s DDD limit stops the sync (the server leaves the client at its own iteration)', () => {
    const server: DatManifest = new Map([[1, { size: DDD_MAX_FILE_BYTES, crc: 0 }]]);
    expect(planDatSync(server, new Map())).toBeNull();
  });
});

// ── an in-memory OPFS root behind the real OpfsDatBlobStore ─────────────────
function memoryOpfs() {
  const files = new Map<string, Uint8Array>();
  const toBytes = (x: unknown): Uint8Array => typeof x === 'string' ? new TextEncoder().encode(x)
    : x instanceof ArrayBuffer ? new Uint8Array(x.slice(0)) : new Uint8Array((x as Uint8Array).slice());
  const handle = (name: string) => ({
    kind: 'file' as const,
    name,
    async getFile() {
      const d = files.get(name);
      if (!d) throw new Error('NotFoundError');
      return { async arrayBuffer() { return d.slice().buffer; }, async text() { return new TextDecoder().decode(d); } };
    },
    async createWritable() {
      let buf = new Uint8Array();
      return {
        async write(x: unknown) { const b = toBytes(x); const n = new Uint8Array(buf.length + b.length); n.set(buf); n.set(b, buf.length); buf = n; },
        async close() { files.set(name, buf); },
        async abort() { /* nothing written */ },
      };
    },
  });
  const root = {
    async getFileHandle(name: string, o?: { create?: boolean }) {
      if (!files.has(name)) { if (!o?.create) throw new Error('NotFoundError'); files.set(name, new Uint8Array()); }
      return handle(name);
    },
    async removeEntry(name: string) { files.delete(name); },
    async *entries() { for (const name of [...files.keys()]) yield [name, handle(name)] as const; },
  };
  return { files, root };
}

function withOpfs(): { store: DatBlobStore; root: ReturnType<typeof memoryOpfs>['root']; files: Map<string, Uint8Array> } {
  const { files, root } = memoryOpfs();
  class FakeHandle { createWritable() { /* feature-detected only */ } }
  vi.stubGlobal('FileSystemFileHandle', FakeHandle);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const store = OpfsDatBlobStore.create();
  expect(store.available).toBe(true);
  return { store, root, files };
}

/** Run the shipped snippet against an OPFS root, as DevTools would on the page. */
async function runSnippet(root: unknown): Promise<unknown> {
  const clicked: string[] = [];
  const doc = { createElement: () => ({ href: '', download: '', click() { clicked.push(this.download); }, remove() { /* gone */ } }), body: { appendChild() { /* added */ } } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function('navigator', 'document', 'location', `return ${CAPTURE_SNIPPET}`) as (n: unknown, d: unknown, l: unknown) => Promise<unknown>;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const capture = await run({ storage: { getDirectory: async () => root } }, doc, { origin: 'https://playwebac.com' });
    expect(clicked).toEqual(['ac1999-push-capture.json']);
    return JSON.parse(JSON.stringify(capture));
  } finally {
    log.mockRestore();
  }
}

/** The push a server at `seed`'s level sends a pristine client, as Connection1999 emits it (zlib, as SendDatFile). */
function pushEvent(seed: ServerPatchSeed): Ac1999PatchEvent {
  return {
    portalIteration: seed.iterations.portal, cellIteration: seed.iterations.cell,
    patches: seed.records.map((r) => ({ dat: r.dat, fileId: r.id, compressed: new Uint8Array(deflateSync(r.bytes, { level: 9 })), rawLength: r.bytes.length })),
  };
}

// ── a streamed 1999 world (DatStore + its resident DBs), with a seed in the pointer ─
function pointerFor(extra: Partial<DatSetPointer> = {}): DatSetPointer {
  return {
    format: 1, set: 'ac1999-retail-world-p102-c67', iterations: { portal: 102, cell: 67, local: 0, highres: 0 },
    manifest: { hash: '0000000000000000', size: 0, gzSize: 0 }, packs: {}, ...extra,
  };
}
const emptyManifest = () => ({ leaves: { portal: new Map(), highres: new Map() }, packs: new Map(), bundles: new Map() });

/** A world set whose pointer lists `seedPayload` for "ac1999", objects served from memory. */
function worldSet(seedPayload: Uint8Array | null) {
  const objects = new Map<string, Uint8Array>();
  let pointer: DatSetPointer = pointerFor();
  if (seedPayload) {
    const raw = pointerWithServerSeed({ ...pointer }, 'ac1999', seedPayload, (p) => { const o = gzipObject(p); objects.set(o.key, o.gz); return o; });
    pointer = parseSetPointer(JSON.parse(JSON.stringify(raw)));
  }
  const fetches: string[] = [];
  const store = DatStore.fromParts('https://dats.example', pointer, emptyManifest(), {
    fetchObject: async (url) => { fetches.push(url); const o = objects.get(url.slice('https://dats.example/'.length)); if (!o) throw new Error(`404 ${url}`); return o; },
    retries: 0, onError: () => {},
  });
  return { store, pointer, fetches };
}

function world(store: DatStore): Ac1999World {
  return new Ac1999World(store.db('portal'), store.db('cell'), { translatedBase: true });
}

/** The raw (1999) bytes the world serves for a file: a patch, else nothing (the test sets hold no base files). */
function served(w: Ac1999World, dat: 'portal' | 'cell', id: number): number[] | null {
  const b = (dat === 'portal' ? w.portal : w.cell).getUntranslatedFileData(id);
  return b ? [...new Uint8Array(b)] : null;
}

function seedOf(payload: Uint8Array): Ac1999Seed {
  return ac1999SeedFromPayload(seedHash(payload), payload);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a capture of a real push compares byte for byte with the seed', () => {
  it('persist (real OpfsDatBlobStore) → the shipped snippet → parseCapture → IDENTICAL; one changed byte is reported', async () => {
    const { store, root } = withOpfs();
    const { store: set } = worldSet(null);
    const w = world(set);
    expect(await w.restore(store, SERVER_KEY)).toBe(0);
    expect(w.iterations).toEqual({ portal: 102, cell: 67 });
    const files = await w.applyEvent(pushEvent(sampleSeed()));
    await w.persist(store, SERVER_KEY, files);

    const capture = parseCapture(await runSnippet(root), 'server_ac1999');
    expect(capture.serverKey).toBe(SERVER_KEY);
    expect(capture.seedId).toBeNull();
    const fromCapture = seedFromCapture(capture, { portal: 102, cell: 67 });
    const r = compareSeeds({ label: 'capture', seed: fromCapture }, { label: 'seed', seed: decodeServerPatchSeed(encodeServerPatchSeed(sampleSeed())) });
    expect(r.lines.at(-1)).toBe('IDENTICAL');
    expect(r.identical).toBe(true);
    // The capture rebuilds the very seed (same bytes, same id).
    expect(seedHash(encodeServerPatchSeed(fromCapture))).toBe(seedHash(encodeServerPatchSeed(sampleSeed())));

    const off = sampleSeed();
    off.records[1] = rec('portal', 0x0e00000e, 1, 2, 3, 5);
    const bad = compareSeeds({ label: 'capture', seed: fromCapture }, { label: 'seed', seed: off });
    expect(bad.identical).toBe(false);
    expect(bad.lines.join('\n')).toMatch(/DIFFERENT bytes 1: portal:0e00000e \(4 vs 4 bytes, first difference at byte 3\)/);
    const fewer = compareSeeds({ label: 'capture', seed: fromCapture }, { label: 'seed', seed: { ...sampleSeed(), records: sampleSeed().records.slice(1) } });
    expect(fewer.lines.join('\n')).toMatch(/only in capture 1: cell:d755fffe/);
    const later = compareSeeds({ label: 'capture', seed: fromCapture }, { label: 'seed', seed: { ...sampleSeed(), iterations: { portal: 10007, cell: 10006 } } });
    expect(later.identical).toBe(false);
    expect(later.lines[0]).toMatch(/DIFFERENT/);
  });

  it('a capture from a seeded profile rebuilds the whole push only with that seed', async () => {
    const { store, root } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    const { store: set } = worldSet(payload);
    const w = world(set);
    await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'));
    // The server moved on (10007): it sends the seed's iteration's diff, one new record.
    const diff = await w.applyEvent(pushEvent({ base: { portal: 10006, cell: 10006 }, iterations: { portal: 10007, cell: 10006 }, records: [rec('portal', 0x02000984, 8, 8)] }));
    await w.persist(store, SERVER_KEY, diff);
    const capture = parseCapture(await runSnippet(root));
    expect(capture.seedId).toBe(seedHash(payload));
    expect(() => seedFromCapture(capture, { portal: 102, cell: 67 })).toThrow(/pass that seed/);
    const full = seedFromCapture(capture, { portal: 102, cell: 67 }, readSeedFile(payload));
    expect(full.iterations).toEqual({ portal: 10007, cell: 10006 });
    expect(full.records.map((r) => r.id.toString(16))).toEqual(['1001932', '2000984', 'e00000e', '8dd1fffe', 'd755fffe']);
  });

  it('an incomplete store is refused, not compared', () => {
    const json = { format: 'acjs-ac1999-patch-capture', version: 1, servers: { [SERVER_KEY]: { manifest: { portalIteration: 10006, cellIteration: 10006, files: [{ dat: 'portal', id: 5 }] }, files: {} } } };
    expect(() => parseCapture(json)).toThrow(/incomplete/);
  });
});

describe('Ac1999World.restore with a seed', () => {
  it('a fresh profile applies the seed and reports the server\'s iteration; an up-to-date login stores it by reference', async () => {
    const { store } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    const { store: set } = worldSet(payload);
    const w = world(set);
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
    expect(served(w, 'portal', 0x0e00000e)).toEqual([1, 2, 3, 4]);
    expect(served(w, 'cell', 0xd755fffe)).toEqual([9, 9, 9]);
    // The server is at the seed's level: an empty push. The manifest names the seed, not its files.
    await w.persist(store, SERVER_KEY, await w.applyEvent({ patches: [], portalIteration: 10006, cellIteration: 10006 }));
    const next = world(worldSet(payload).store);
    expect(await next.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    expect(next.iterations).toEqual({ portal: 10006, cell: 10006 });
    expect(served(next, 'portal', 0x01001932)).toEqual([5, 6]);
  });

  it('a server that moved on: its diff is applied over the seed, stored, and comes back over it', async () => {
    const { store } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    const { store: set } = worldSet(payload);
    const w = world(set);
    await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'));
    // 10007 changes one seed record back and adds one.
    const files = await w.applyEvent(pushEvent({ base: { portal: 10006, cell: 10006 }, iterations: { portal: 10007, cell: 10006 }, records: [rec('portal', 0x0e00000e, 4, 4), rec('portal', 0x02000984, 8)] }));
    await w.persist(store, SERVER_KEY, files);
    expect(w.iterations).toEqual({ portal: 10007, cell: 10006 });
    const next = world(worldSet(payload).store);
    expect(await next.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(6);
    expect(next.iterations).toEqual({ portal: 10007, cell: 10006 });
    expect(served(next, 'portal', 0x0e00000e)).toEqual([4, 4]);
    expect(served(next, 'portal', 0x02000984)).toEqual([8]);
    expect(served(next, 'cell', 0xd755fffe)).toEqual([9, 9, 9]);
  });

  /** An unseeded stored state, as a browser from before seeds wrote it: `records` pushed at `iterations`. */
  async function storeUnseeded(store: DatBlobStore, iterations: { portal: number; cell: number }, records: PatchRecord[]): Promise<void> {
    const old = world(worldSet(null).store);
    await old.restore(store, SERVER_KEY);
    await old.persist(store, SERVER_KEY, await old.applyEvent(pushEvent({ base: { portal: 102, cell: 67 }, iterations, records })));
  }
  const manifestOf = (opfs: Map<string, Uint8Array>) => JSON.parse(new TextDecoder().decode(opfs.get(`ac1999-patch__${SERVER_KEY}__manifest.datcache`)!));
  const quiet = () => { const l = vi.spyOn(console, 'log').mockImplementation(() => {}); const w = vi.spyOn(console, 'warn').mockImplementation(() => {}); return () => { l.mockRestore(); w.mockRestore(); }; };

  it('BUG.ac1999-stored-patches-beat-newer-seed: an unseeded stored state below the seed (prod: 10006 under a 10007 seed) takes the seed', async () => {
    const { store, files: opfs } = withOpfs();
    // Stored on an earlier visit, before seeds: 10006, with a record 10007 no longer has.
    await storeUnseeded(store, { portal: 10006, cell: 10006 }, [rec('portal', 0x0e00000e, 1, 1), rec('portal', 0x0200dead, 6, 6)]);
    expect(opfs.has(`ac1999-patch__${SERVER_KEY}__0200dead.datcache`)).toBe(true);

    const newer = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
    const { store: set, fetches } = worldSet(newer);
    const w = world(set);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    done();
    expect(fetches).toHaveLength(1);
    expect(w.iterations).toEqual({ portal: 10007, cell: 10007 });
    expect(served(w, 'portal', 0x0e00000e)).toEqual([1, 2, 3, 4]);
    // The stored files are set aside, not layered over the seed.
    expect(served(w, 'portal', 0x0200dead)).toBeNull();
    // The up-to-date login stores the seeded state by reference and drops the set-aside files.
    await w.persist(store, SERVER_KEY, await w.applyEvent({ patches: [], portalIteration: 10007, cellIteration: 10007 }));
    expect(manifestOf(opfs)).toEqual({ portalIteration: 10007, cellIteration: 10007, files: [], seed: seedHash(newer) });
    expect(opfs.has(`ac1999-patch__${SERVER_KEY}__0200dead.datcache`)).toBe(false);
    expect(opfs.has(`ac1999-patch__${SERVER_KEY}__0e00000e.datcache`)).toBe(false);
    // And it comes back next visit.
    const next = world(worldSet(newer).store);
    expect(await next.restore(store, SERVER_KEY, ac1999SeedSource(worldSet(newer).store, 'ac1999'))).toBe(4);
    expect(next.iterations).toEqual({ portal: 10007, cell: 10007 });
  });

  it('a seed above the stored state in one DAT only (cell) still takes the seed', async () => {
    const { store } = withOpfs();
    await storeUnseeded(store, { portal: 10007, cell: 10006 }, [rec('portal', 0x0e00000e, 1, 1)]);
    const newer = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
    const set = worldSet(newer).store;
    const w = world(set);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    done();
    expect(w.iterations).toEqual({ portal: 10007, cell: 10007 });
  });

  it('a mixed pair (stored portal above the seed, cell below: a server reset) takes the whole seed, never a blend', async () => {
    const { store } = withOpfs();
    await storeUnseeded(store, { portal: 10009, cell: 10006 }, [rec('portal', 0x0e00000e, 9, 9)]);
    const seedBytes = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
    const set = worldSet(seedBytes).store;
    const w = world(set);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    done();
    expect(w.iterations).toEqual({ portal: 10007, cell: 10007 });
    expect(served(w, 'portal', 0x0e00000e)).toEqual([1, 2, 3, 4]);
  });

  it('the inverse: an unseeded stored state equal to or past the seed is kept, and the seed is never fetched', async () => {
    for (const at of [{ portal: 10007, cell: 10007 }, { portal: 10008, cell: 10007 }, { portal: 10008, cell: 10008 }]) {
      const { store } = withOpfs();
      await storeUnseeded(store, at, [rec('portal', 0x0e00000e, 7, 7)]);
      const seedBytes = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
      const { store: set, fetches } = worldSet(seedBytes);
      const w = world(set);
      expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(1);
      expect(fetches).toEqual([]);
      expect(w.iterations).toEqual(at);
      expect(served(w, 'portal', 0x0e00000e)).toEqual([7, 7]);
      expect(served(w, 'portal', 0x01001932)).toBeNull();
    }
  });

  it('a seed source with no pointer description is loaded to compare: equal keeps the stored state, newer replaces it', async () => {
    const { store } = withOpfs();
    await storeUnseeded(store, { portal: 10007, cell: 10007 }, [rec('portal', 0x0e00000e, 7, 7)]);
    const same = seedOf(encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } }));
    const w = world(worldSet(null).store);
    expect(await w.restore(store, SERVER_KEY, async () => same)).toBe(1);
    expect(w.iterations).toEqual({ portal: 10007, cell: 10007 });
    const newer = seedOf(encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10008, cell: 10007 } }));
    const x = world(worldSet(null).store);
    const done = quiet();
    expect(await x.restore(store, SERVER_KEY, async () => newer)).toBe(4);
    done();
    expect(x.iterations).toEqual({ portal: 10008, cell: 10007 });
  });

  it('a newer seed the pointer lists but that fails to load leaves the stored state (the newest one fully held)', async () => {
    const { store } = withOpfs();
    await storeUnseeded(store, { portal: 10006, cell: 10006 }, [rec('portal', 0x0e00000e, 1, 1)]);
    const newer = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
    const { pointer } = worldSet(newer);
    const broken = DatStore.fromParts('https://dats.example', pointer, emptyManifest(), { fetchObject: async () => { throw new Error('offline'); }, retries: 0, onError: () => {} });
    const w = world(broken);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(broken, 'ac1999'))).toBe(1);
    done();
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
    expect(served(w, 'portal', 0x0e00000e)).toEqual([1, 1]);
  });

  it('a partial unseeded state (a listed file missing) takes the newer seed, and the next persist neither lists nor keeps it', async () => {
    const { store, files: opfs } = withOpfs();
    await storeUnseeded(store, { portal: 10006, cell: 10006 }, [rec('portal', 0x0e00000e, 1, 1), rec('cell', 0xd755fffe, 3)]);
    opfs.delete(`ac1999-patch__${SERVER_KEY}__d755fffe.datcache`);
    const newer = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10007, cell: 10007 } });
    const set = worldSet(newer).store;
    const w = world(set);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    done();
    expect(w.iterations).toEqual({ portal: 10007, cell: 10007 });
    await w.persist(store, SERVER_KEY, []);
    expect(manifestOf(opfs).files).toEqual([]);
    expect(opfs.has(`ac1999-patch__${SERVER_KEY}__0e00000e.datcache`)).toBe(false);
  });

  it('a seed-built state below its own seed\'s level (a damaged manifest) is set aside for the seed', async () => {
    const { store, files: opfs } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    opfs.set(`ac1999-patch__${SERVER_KEY}__manifest.datcache`, new TextEncoder().encode(JSON.stringify({ portalIteration: 10005, cellIteration: 10006, files: [], seed: seedHash(payload) })));
    const set = worldSet(payload).store;
    const w = world(set);
    const done = quiet();
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    done();
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
  });

  it('a push with a file that fails to inflate does not adopt the server\'s iterations and says it is incomplete', async () => {
    const { store } = withOpfs();
    await storeUnseeded(store, { portal: 10006, cell: 10006 }, [rec('portal', 0x0e00000e, 1, 1)]);
    const w = world(worldSet(null).store);
    await w.restore(store, SERVER_KEY);
    const ev = pushEvent({ base: { portal: 10006, cell: 10006 }, iterations: { portal: 10007, cell: 10006 }, records: [rec('portal', 0x02000984, 8, 8)] });
    ev.patches.push({ dat: 'portal', fileId: 0x02000985, compressed: bytes(0xff, 0xfe, 0xfd), rawLength: 40 });
    const done = quiet();
    const files = await w.applyEvent(ev);
    done();
    expect(files.complete).toBe(false);
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
    const ok = await w.applyEvent(pushEvent({ base: { portal: 10006, cell: 10006 }, iterations: { portal: 10007, cell: 10006 }, records: [rec('portal', 0x02000984, 8, 8)] }));
    expect(ok.complete).toBe(true);
    expect(w.iterations).toEqual({ portal: 10007, cell: 10006 });
  });

  it('a state built on another seed is set aside, the offered seed applies, and the next persist drops the old files', async () => {
    const { store, files: opfs } = withOpfs();
    const first = encodeServerPatchSeed(sampleSeed());
    const a = worldSet(first).store;
    const w = world(a);
    await w.restore(store, SERVER_KEY, ac1999SeedSource(a, 'ac1999'));
    await w.persist(store, SERVER_KEY, await w.applyEvent(pushEvent({ base: { portal: 10006, cell: 10006 }, iterations: { portal: 10007, cell: 10006 }, records: [rec('portal', 0x02000984, 8)] })));

    // The set now offers a seed rebuilt at 10008 (without 0x02000984).
    const second = encodeServerPatchSeed({ ...sampleSeed(), iterations: { portal: 10008, cell: 10006 } });
    const b = worldSet(second).store;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const x = world(b);
    expect(await x.restore(store, SERVER_KEY, ac1999SeedSource(b, 'ac1999'))).toBe(4);
    log.mockRestore();
    expect(x.iterations).toEqual({ portal: 10008, cell: 10006 });
    expect(served(x, 'portal', 0x02000984)).toBeNull();
    await x.persist(store, SERVER_KEY, await x.applyEvent({ patches: [], portalIteration: 10008, cellIteration: 10006 }));
    const m = JSON.parse(new TextDecoder().decode(opfs.get(`ac1999-patch__${SERVER_KEY}__manifest.datcache`)!));
    expect(m).toEqual({ portalIteration: 10008, cellIteration: 10006, files: [], seed: seedHash(second) });
  });

  it('a seed-built state with no seed on offer (fetch failed, or the set dropped it) reports the base, so the server resends', async () => {
    const { store } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    const a = worldSet(payload).store;
    const w = world(a);
    await w.restore(store, SERVER_KEY, ac1999SeedSource(a, 'ac1999'));
    await w.persist(store, SERVER_KEY, []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failing = world(worldSet(null).store);
    expect(await failing.restore(store, SERVER_KEY, async () => { throw new Error('network'); })).toBe(0);
    expect(failing.iterations).toEqual({ portal: 102, cell: 67 });
    const none = world(worldSet(null).store);
    expect(await none.restore(store, SERVER_KEY)).toBe(0);
    expect(none.iterations).toEqual({ portal: 102, cell: 67 });
    warn.mockRestore(); log.mockRestore();
  });

  it('an incomplete store or an empty baseline manifest takes the seed', async () => {
    const { store, files: opfs } = withOpfs();
    const payload = encodeServerPatchSeed(sampleSeed());
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    opfs.set(`ac1999-patch__${SERVER_KEY}__manifest.datcache`, enc({ portalIteration: 10006, cellIteration: 10006, files: [{ dat: 'portal', id: 7 }] }));
    const set = worldSet(payload).store;
    const w = world(set);
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
    // The next persist starts fresh: the missing file is not listed again.
    await w.persist(store, SERVER_KEY, []);
    expect(JSON.parse(new TextDecoder().decode(opfs.get(`ac1999-patch__${SERVER_KEY}__manifest.datcache`)!)).files).toEqual([]);

    opfs.set(`ac1999-patch__${SERVER_KEY}__manifest.datcache`, enc({ portalIteration: 102, cellIteration: 67, files: [] }));
    const v = world(worldSet(payload).store);
    expect(await v.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
  });

  it('a seed diffed from other base iterations is refused (the world reports its own)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = withOpfs();
    const other = seedOf(encodeServerPatchSeed({ ...sampleSeed(), base: { portal: 103, cell: 67 } }));
    const w = world(worldSet(null).store);
    expect(await w.restore(store, SERVER_KEY, async () => other)).toBe(0);
    expect(w.iterations).toEqual({ portal: 102, cell: 67 });
    expect(warn.mock.calls.join(' ')).toMatch(/diffed from 103/);
    warn.mockRestore();
  });

  it('without OPFS the seed still applies, every visit', async () => {
    const store: DatBlobStore = {
      available: false, getMeta: async (): Promise<DatCacheMeta | null> => null, getData: async () => null,
      put: async () => {}, remove: async () => {}, clear: async () => {},
    };
    const payload = encodeServerPatchSeed(sampleSeed());
    const set = worldSet(payload).store;
    const w = world(set);
    expect(await w.restore(store, SERVER_KEY, ac1999SeedSource(set, 'ac1999'))).toBe(4);
    expect(w.iterations).toEqual({ portal: 10006, cell: 10006 });
  });
});

describe('the pointer → DatStore → ac1999SeedSource path', () => {
  it('lists the seed under the server id, fetches it hash-verified, and refuses a pointer that misdescribes it', async () => {
    const payload = encodeServerPatchSeed(sampleSeed());
    const { store, pointer, fetches } = worldSet(payload);
    expect(pointer.serverSeeds?.ac1999).toEqual({ hash: seedHash(payload), size: payload.length, gzSize: gzipSync(payload, { level: 9 }).length, base: { portal: 102, cell: 67 }, iterations: { portal: 10006, cell: 10006 } });
    const seed = await ac1999SeedSource(store, 'ac1999')!();
    expect(seed?.id).toBe(seedHash(payload));
    expect(seed?.files).toHaveLength(4);
    expect(fetches).toEqual([`https://dats.example/v1/o/${seedHash(payload)}`]);
    expect(await ac1999SeedSource(store, 'ac1999-local')!()).toBeNull();
    expect(ac1999SeedSource(store, null)).toBeUndefined();
    expect(ac1999SeedSource(null, 'ac1999')).toBeUndefined();

    const lying = parseSetPointer(JSON.parse(JSON.stringify({ ...pointer, serverSeeds: { ac1999: { ...pointer.serverSeeds!.ac1999, iterations: { portal: 10007, cell: 10006 } } } })));
    const objects = new Map([[`v1/o/${seedHash(payload)}`, new Uint8Array(gzipSync(payload, { level: 9 }))]]);
    const liar = DatStore.fromParts('https://dats.example', lying, emptyManifest(), { fetchObject: async (u) => objects.get(u.slice(21))!, retries: 0, onError: () => {} });
    await expect(ac1999SeedSource(liar, 'ac1999')!()).rejects.toThrow(/set pointer says otherwise/);
  });

  it('a seed is staged only over the set\'s own iterations', () => {
    const payload = encodeServerPatchSeed({ ...sampleSeed(), base: { portal: 102, cell: 68 } });
    expect(() => pointerWithServerSeed(pointerFor(), 'ac1999', payload, gzipObject)).toThrow(/diffed from 102 \/ 68; this set is 102 \/ 67/);
    expect(() => pointerWithServerSeed(pointerFor(), 'bad id!', encodeServerPatchSeed(sampleSeed()), gzipObject)).toThrow(/launcher world id/);
  });

  it('end of retail / Dark Majesty: a pointer without the key parses exactly as before, and offers no seed', async () => {
    const eol = { format: 1, set: 'eol-p2072-c982-h497-l994', iterations: { portal: 2072, cell: 982, local: 994, highres: 497 },
      manifest: { key: 'v1/o/0123456789abcdef', size: 1, gzSize: 1 }, packs: {}, created: '2026-10-04T00:00:00.000Z' };
    const p = parseSetPointer(eol);
    expect(p).toEqual({ format: 1, set: eol.set, iterations: eol.iterations, manifest: { hash: '0123456789abcdef', size: 1, gzSize: 1 }, packs: {}, created: eol.created });
    expect('serverSeeds' in p).toBe(false);
    const store = DatStore.fromParts('https://dats.example', p, emptyManifest(), { fetchObject: async () => { throw new Error('no fetch expected'); } });
    expect(await store.loadServerSeed('ac1999')).toBeNull();
  });
});

// ── the real DATs: our reading of the pristine 1999 files is the server's ───
const PRISTINE = process.env.ACJS_AC1999_DAT_DIR ?? join(__dirname, '..', 'dat-sets', 'ac1999-retail');
const MANIFESTS = join(__dirname, '..', 'reference', 'ac1999', 'Server', 'Bin', 'ServerModes', 'Release', 'Data', 'manifests');
const haveDats = existsSync(join(PRISTINE, 'portal.dat')) && existsSync(join(PRISTINE, 'cell.dat'));

describe.skipIf(!haveDats || !existsSync(MANIFESTS))('the pristine 1999 DATs against the server\'s own manifests (reference/ac1999)', () => {
  let problems: string[] = [];
  beforeAll(() => { problems = checkPristineAgainstManifests(PRISTINE, MANIFESTS); }, 120_000);
  it('every record\'s size and crc32 match portal-102.manifest / cell-67.manifest', () => {
    expect(problems).toEqual([]);
  });
});

describe.skipIf(!haveDats)('planSeedFromDats over the real 1999 DATs', () => {
  it('a server at the pristine iterations pushes nothing', () => {
    const { seed, plans } = planSeedFromDats(PRISTINE, PRISTINE);
    expect(seed.base).toEqual({ portal: 102, cell: 67 });
    expect(seed.iterations).toEqual({ portal: 102, cell: 67 });
    expect(seed.records).toEqual([]);
    expect(plans.portal.files).toEqual([]);
  }, 120_000);
});

describe.skipIf(!haveDats || !existsSync(MANIFESTS))('verify: a seed against the server\'s own manifests for its iterations', () => {
  let dir = '';
  beforeAll(() => {
    // A server at 10006: the spell table changed, one portal record added; cell untouched (67).
    dir = mkdtempSync(join(tmpdir(), 'acjs-seed-manifests-'));
    const lines = readFileSync(join(MANIFESTS, 'portal-102.manifest'), 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('0E00000E'));
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
    const spell = stampOf(bytes(1, 2, 3, 4));
    const added = stampOf(bytes(5, 6));
    lines.push(`0E00000E ${hex(spell.size)} ${hex(spell.crc)}`, `01001932 ${hex(added.size)} ${hex(added.crc)}`);
    writeFileSync(join(dir, 'portal-10006.manifest'), `# dat-manifest portal.dat iteration=10006\n${lines.join('\n')}\n`);
  }, 120_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const seed = (spellLast: number): ServerPatchSeed => ({
    base: { portal: 102, cell: 67 }, iterations: { portal: 10006, cell: 67 },
    records: [rec('portal', 0x0e00000e, 1, 2, 3, spellLast), rec('portal', 0x01001932, 5, 6)],
  });
  it('exactly the records the server pushes, with its sizes and crc32s: no problems', () => {
    expect(verifyAgainstServerManifests(seed(4), PRISTINE, dir)).toEqual([]);
  }, 120_000);
  it('one byte off, a record missing, or one too many: each is named', () => {
    expect(verifyAgainstServerManifests(seed(5), PRISTINE, dir)).toEqual([expect.stringMatching(/^portal 0x0e00000e: seed 4\//)]);
    const short = { ...seed(4), records: seed(4).records.slice(1) };
    expect(verifyAgainstServerManifests(short, PRISTINE, dir)).toEqual(['portal 0x0e00000e: the server pushes it, the seed lacks it']);
    const extra = { ...seed(4), records: [...seed(4).records, rec('cell', 0xd755fffe, 1)] };
    expect(verifyAgainstServerManifests(extra, PRISTINE, dir)).toEqual(['cell: the server is at the pristine iteration, but the seed holds 1 record(s)']);
  }, 120_000);
});
