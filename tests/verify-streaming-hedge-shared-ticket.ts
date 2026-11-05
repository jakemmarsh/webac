/**
 * BUG.streaming-hedge-shared-ticket — one object load's Ticket waiting in two
 * limiters at once (the disk limiter for a hedged cache read, and the network
 * limiter for the hedge's download) must keep a separate wait in each.
 *
 * Production (build 4d9548a52, Windows Chrome, in the world, 2026-11-05
 * 13:12Z): unhandledrejection `TypeError: n is not a function` at Limiter.pump,
 * from NetworkLink.holdBackground's release. The Ticket held ONE wake and ONE
 * queuedIn; PERF.cache-read-slower-than-network (f41b81b80) let a ticket queued
 * in the disk limiter (all 32 read slots held by a stalled disk) also queue in
 * the network limiter. The second queue overwrote the first's resolver, so the
 * disk limiter's pump started the network wait (past the link's rules) and
 * leaked a disk slot, and the network limiter later popped a ticket whose wake
 * was already null and threw.
 *
 * Drives the real DatStore (fake bucket, real gzip / hashes, a cache whose
 * reads are held by hand) and the real Limiter / Ticket.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type CacheHedgePolicy, DatStore, FetchPriority, Limiter, NetworkLink, type ObjectFetcher, Ticket,
} from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache, type ObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack, type Obj } from './_harness/datSet.js';

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = 'https://dats.test';
const POINTER_URL = `${BASE}/v1/sets/test-set.json`;
/** More leaves than the disk limiter's 32 read slots. */
const LEAVES = 40;
const leafId = (i: number) => 0x06001000 + i;

function makeSet() {
  const bucket = new FakeBucket();
  const pack = (files: Array<[number, string]>) => ({ ...bucket.put(buildPack(files.map(([id, s]) => ({ id, data: enc(s) })))), files: files.length });
  const packs = {
    boot: pack([[0x06000100, 'boot-texture']]),
    local: pack([[0x23000001, 'strings']]),
    skeleton: pack([[0x02000001, 'setup']]),
  };
  const role = { boot: 1, skeleton: 3, local: 5 } as const;
  const leaves: Array<{ id: number } & Obj> = [];
  for (let i = 0; i < LEAVES; i++) leaves.push({ id: leafId(i), ...bucket.put(enc(`leaf-${i}-`.repeat(20))) });
  const manifest = bucket.put(buildManifest({
    leaves: { portal: leaves, highres: [] },
    packs: (Object.entries(packs) as Array<[keyof typeof role, Obj & { files: number }]>).map(([r, p]) => ({ role: role[r], ...p })),
    bundles: [],
  }));
  const pointer = {
    format: 1, set: 'test-set', iterations: { portal: 2072, cell: 982, highres: 497, local: 994 },
    manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
    packs: Object.fromEntries(Object.entries(packs).map(([r, p]) => [r, { key: `v1/o/${p.hash}`, size: p.size, gzSize: p.gzSize, files: p.files }])),
  };
  return { bucket, pointer, leaves };
}

/** A warm cache whose reads of `slow` hashes wait until released. */
class HeldCache implements ObjectCache {
  readonly persistent = true;
  readonly inner = new MemoryObjectCache();
  readonly slow = new Set<string>();
  readonly gets: string[] = [];
  private readonly waiting: Array<() => void> = [];
  async get(hash: string): Promise<Uint8Array | null> {
    this.gets.push(hash);
    if (this.slow.has(hash)) await new Promise<void>((r) => this.waiting.push(r));
    return this.inner.get(hash);
  }
  async put(hash: string, gz: Uint8Array): Promise<void> { await this.inner.put(hash, gz); }
  async has(hash: string): Promise<boolean> { return this.inner.has(hash); }
  release(): void { for (const r of this.waiting.splice(0)) r(); }
  get held(): number { return this.waiting.length; }
}

const fastHedge = (ms = 20): CacheHedgePolicy => ({
  delayMs: () => ms,
  wait: (t, fire) => { const id = setTimeout(fire, t); return () => clearTimeout(id); },
});

/** A fetcher whose downloads wait until released (aborts reject), counting starts per hash. */
function heldFetcher(bucket: FakeBucket) {
  const starts = new Map<string, number>();
  const signals = new Map<string, AbortSignal>();
  let releases: Array<() => void> = [];
  let holding = true;
  const fetch: ObjectFetcher = async (url, o) => {
    const hash = url.slice(url.lastIndexOf('/') + 1);
    starts.set(hash, (starts.get(hash) ?? 0) + 1);
    if (o.signal) signals.set(hash, o.signal);
    if (holding) {
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        o.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return bucket.fetch(url);
  };
  return {
    fetch, starts, signals,
    release(): void { holding = false; const r = releases; releases = []; for (const f of r) f(); },
  };
}

async function openStore(set: ReturnType<typeof makeSet>, cache: ObjectCache, fetchObject: ObjectFetcher, network: NetworkLink) {
  // Open with the plain bucket (the boot packs), then route leaf downloads through `fetchObject`.
  let fetcher: ObjectFetcher = set.bucket.fetch;
  const store = await DatStore.open({
    pointerUrl: POINTER_URL, fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
    fetchObject: (u, o) => fetcher(u, o), cache, packs: ['boot'], cacheHedge: fastHedge(), retries: 1, network,
  });
  fetcher = fetchObject;
  return store;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BUG.streaming-hedge-shared-ticket: a hedged load queued in the disk AND network limiters', () => {
  it('reproduces the prod path: 33+ stalled reads, every hedge download queued; nothing throws, hangs or leaks a slot', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    for (const [hash, gz] of set.bucket.objects) await cache.inner.put(hash, gz);
    for (const l of set.leaves) cache.slow.add(l.hash);
    const net = heldFetcher(set.bucket);
    const network = new NetworkLink({ maxConcurrent: 1 });
    const store = await openStore(set, cache, net.fetch, network);
    const errors: string[] = [];
    (store as unknown as { onError: (d: string) => void }).onError = (d) => { errors.push(d); };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const loads = set.leaves.map((l) => store.request('portal', l.id, FetchPriority.Prefetch));
      // 32 reads hold every disk slot; the other 8 queue in the disk limiter. Then every load hedges:
      // one download runs (maxConcurrent 1), 39 queue in the network limiter. 8 tickets are in both queues.
      await vi.waitFor(() => expect(store.stats.cacheHedges).toBe(LEAVES));
      expect(cache.held).toBe(32);
      expect(network.running).toBe(1);
      expect(network.pending).toBe(LEAVES - 1);
      // The stalled disk recovers: the 32 reads deliver, the 8 queued reads start (and are slow again).
      cache.release();
      await vi.waitFor(() => expect(cache.held).toBe(LEAVES - 32));
      // A portal-space gate holds and releases (the prod call chain: holdBackground's release pumps).
      const release = network.holdBackground();
      expect(() => release()).not.toThrow();
      cache.release();
      net.release();
      const got = await Promise.all(loads);
      expect(got.every(Boolean)).toBe(true);
      await vi.waitFor(() => expect(network.running + network.pending).toBe(0));
      // Every read ran exactly once (none skipped for a wrong wake), and each slot came back.
      const gets = cache.gets.filter((h) => set.leaves.some((l) => l.hash === h));
      expect(new Set(gets).size).toBe(LEAVES);
      expect(gets.length).toBe(LEAVES);
      const disk = (store as unknown as { disk: Limiter }).disk;
      expect(disk.running).toBe(0);
      expect(disk.pending).toBe(0);
      // No download started twice, and no download ever ran past the link's one slot.
      for (const n of net.starts.values()) expect(n).toBe(1);
      await flush();
      expect(errors).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('inverse: the cache winning still aborts each hedge download, and a download wins when the disk stays stuck', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    for (const [hash, gz] of set.bucket.objects) await cache.inner.put(hash, gz);
    for (const l of set.leaves) cache.slow.add(l.hash);
    const net = heldFetcher(set.bucket);
    const network = new NetworkLink({ maxConcurrent: 4 });
    const store = await openStore(set, cache, net.fetch, network);
    const loads = set.leaves.map((l) => store.request('portal', l.id, FetchPriority.Prefetch));
    await vi.waitFor(() => expect(network.running).toBe(4));
    const first4 = [...net.signals.keys()];
    expect(first4.length).toBe(4);
    cache.release(); // the 32 running reads deliver
    await vi.waitFor(() => expect(cache.held).toBe(LEAVES - 32));
    // The running downloads whose cache delivered were aborted.
    for (const h of first4) {
      const idx = set.leaves.findIndex((l) => l.hash === h);
      if (idx < 32) expect(net.signals.get(h)!.aborted).toBe(true);
    }
    // The last 8 stay stuck on the disk; their downloads win.
    net.release();
    const got = await Promise.all(loads);
    expect(got.every(Boolean)).toBe(true);
    expect(store.stats.cacheHedgeWins).toBe(LEAVES - 32);
    expect(store.stats.failures).toBe(0);
    cache.release();
    await flush();
    const disk = (store as unknown as { disk: Limiter }).disk;
    await vi.waitFor(() => expect(disk.running + disk.pending).toBe(0));
    expect(network.running + network.pending).toBe(0);
  });
});

/** A run whose fn waits until released; records when it started. */
function blocked(limiter: Limiter, ticket: Ticket, log: string[], name: string) {
  let release: () => void = () => undefined;
  const done = limiter.run(ticket, async () => {
    log.push(name);
    await new Promise<void>((r) => { release = r; });
    return name;
  });
  return { done, release: () => release() };
}

describe('BUG.streaming-hedge-shared-ticket: Limiter keeps one wait per limiter', () => {
  it('a ticket queued in two limiters is started by each one only for its own wait', async () => {
    const a = new Limiter(1), b = new Limiter(1);
    const log: string[] = [];
    const blockA = blocked(a, new Ticket(FetchPriority.Prefetch), log, 'blockA');
    const blockB = blocked(b, new Ticket(FetchPriority.Prefetch), log, 'blockB');
    await flush();
    const t = new Ticket(FetchPriority.Prefetch);
    const inA = blocked(a, t, log, 'tA');
    const inB = blocked(b, t, log, 'tB');
    await flush();
    expect(a.pending).toBe(1);
    expect(b.pending).toBe(1);
    blockA.release();
    await blockA.done;
    await flush();
    expect(log).toEqual(['blockA', 'blockB', 'tA']); // B's wait is untouched: B is still full
    expect(b.pending).toBe(1);
    expect(b.running).toBe(1);
    blockB.release();
    await blockB.done;
    await flush();
    expect(log).toEqual(['blockA', 'blockB', 'tA', 'tB']);
    inA.release(); inB.release();
    expect(await inA.done).toBe('tA');
    expect(await inB.done).toBe('tB');
    expect(a.running + a.pending + b.running + b.pending).toBe(0);
  });

  it('promote moves the ticket ahead in every limiter it waits in, once each', async () => {
    const a = new Limiter(1), b = new Limiter(1);
    const log: string[] = [];
    const blockA = blocked(a, new Ticket(FetchPriority.Critical), log, 'blockA');
    const blockB = blocked(b, new Ticket(FetchPriority.Critical), log, 'blockB');
    await flush();
    const otherA = blocked(a, new Ticket(FetchPriority.Prefetch), log, 'otherA');
    const otherB = blocked(b, new Ticket(FetchPriority.Prefetch), log, 'otherB');
    const t = new Ticket(FetchPriority.Background);
    const tA = blocked(a, t, log, 'tA');
    const tB = blocked(b, t, log, 'tB');
    await flush();
    t.promote(FetchPriority.Critical);
    t.promote(FetchPriority.Critical); // again: no duplicate entry
    expect(t.priority).toBe(FetchPriority.Critical);
    expect(a.pending).toBe(2);
    expect(b.pending).toBe(2);
    blockA.release(); blockB.release();
    await Promise.all([blockA.done, blockB.done]);
    await flush();
    expect(log.slice(2).sort()).toEqual(['tA', 'tB']);
    tA.release(); tB.release();
    await Promise.all([tA.done, tB.done]);
    await flush();
    otherA.release(); otherB.release();
    await Promise.all([otherA.done, otherB.done]);
    expect(log.filter((n) => n === 'tA' || n === 'tB').length).toBe(2);
    expect(a.running + a.pending + b.running + b.pending).toBe(0);
  });

  it('promote of a ticket no limiter is holding only raises its priority (no stray queue entry)', async () => {
    const a = new Limiter(1);
    const t = new Ticket(FetchPriority.Background);
    t.promote(FetchPriority.Prefetch);
    expect(t.priority).toBe(FetchPriority.Prefetch);
    expect(a.pending).toBe(0);
    // A running ticket promoted mid-run is not queued again.
    const log: string[] = [];
    const run = blocked(a, t, log, 't');
    await flush();
    t.promote(FetchPriority.Critical);
    expect(a.pending).toBe(0);
    expect(a.running).toBe(1);
    run.release();
    await run.done;
    expect(a.running + a.pending).toBe(0);
  });

  it('a ticket cannot wait twice in the same limiter', async () => {
    const a = new Limiter(1);
    const log: string[] = [];
    const block = blocked(a, new Ticket(FetchPriority.Prefetch), log, 'block');
    await flush();
    const t = new Ticket(FetchPriority.Prefetch);
    const first = blocked(a, t, log, 't1');
    await flush();
    await expect(a.run(t, async () => 'again')).rejects.toThrow(/already waiting/);
    expect(a.pending).toBe(1);
    block.release();
    await block.done;
    await flush();
    first.release();
    expect(await first.done).toBe('t1');
    expect(a.running + a.pending).toBe(0);
  });
});
