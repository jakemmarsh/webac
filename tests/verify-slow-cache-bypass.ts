/**
 * PERF.slow-cache-bypass — a browser cache that keeps answering slowly is
 * bounded, then bypassed, for every awaited cache operation on the boot path.
 *
 * Production (bridge, 2026-11-06, one player in Brazil on builds 491864d24 and
 * 5a407a377, the read hedge already shipped): streamed boots took 12-46 s
 * while the network delivered the same bytes in 3-4 s. The OPFS directory took
 * 12-46 s to open (dirMs 12525 / 22100 / 46097) and one has() check 5.5 s with
 * the directory open in 22 ms. Each read paid its 3 s deadline; the has()
 * checks (the warm-profile check, hasMs 9203; the split-pack check, untimed:
 * 18 s and 40 s of the 22.6 s / 46.6 s boots) were not raced at all.
 *
 * Drives the real DatStore / openStreamingDats / CacheHealth / boundedHas over
 * a fake content-addressed bucket (real gzip, real hashes) and a cache whose
 * operations are held by hand.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_HAS_BOUND_MS, CACHE_SLOW_OPS_TO_BYPASS, CacheHealth, type CacheHedgePolicy, DEFAULT_CACHE_HEDGE, DatStore, FetchPriority,
  boundedHas, pageCacheHealth,
} from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache, type ObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { openStreamingDats } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import { BOOT_STREAM_PHASE_KEYS, boundBootStreamPhases } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { BOOT_STREAM_PHASE_KEYS as BRIDGE_PHASE_KEYS, streamPhasesField } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { FakeBucket, buildManifest, buildPack, type Obj } from './_harness/datSet.js';

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = 'https://dats.test';
const POINTER_URL = `${BASE}/v1/sets/test-set.json`;

function makeSet() {
  const bucket = new FakeBucket();
  const pack = (files: Array<[number, string]>) => ({ ...bucket.put(buildPack(files.map(([id, s]) => ({ id, data: enc(s) })))), files: files.length });
  const packs = {
    boot: pack([[0x06000100, 'boot-texture']]),
    local: pack([[0x23000001, 'strings']]),
    skeleton: pack([[0x02000001, 'setup']]),
    world: pack([[0x06000200, 'world-texture'.repeat(50)]]),
    terrain: pack([[0xA9B4FFFF, 'land-a9b4']]),
  };
  const role = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5 } as const;
  const manifest = bucket.put(buildManifest({
    leaves: { portal: [], highres: [] },
    packs: (Object.entries(packs) as Array<[keyof typeof role, Obj & { files: number }]>).map(([r, p]) => ({ role: role[r], ...p })),
    bundles: [],
  }));
  const pointer = {
    format: 1, set: 'test-set', iterations: { portal: 2072, cell: 982, highres: 497, local: 994 },
    manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
    packs: Object.fromEntries(Object.entries(packs).map(([r, p]) => [r, { key: `v1/o/${p.hash}`, size: p.size, gzSize: p.gzSize, files: p.files }])),
  };
  return { bucket, pointer, packs, manifest };
}
type TestSet = ReturnType<typeof makeSet>;
const pointerOf = (set: TestSet) => async () => JSON.parse(JSON.stringify(set.pointer));

/**
 * A warm cache whose operations can stall. `stallAll`: every get / has waits until release()
 * (an OPFS directory that will not open); else only gets of `slow` hashes and has() of `slowHas`.
 */
class StallCache implements ObjectCache {
  readonly persistent = true;
  readonly inner = new MemoryObjectCache();
  readonly slow = new Set<string>();
  readonly slowHas = new Set<string>();
  stallAll = false;
  /** Writes never finish (a stalled disk's write). */
  stallPuts = false;
  readonly gets: string[] = [];
  readonly hasCalls: string[] = [];
  readonly puts: string[] = [];
  private readonly waiting: Array<() => void> = [];
  private hold(): Promise<void> { return new Promise<void>((r) => this.waiting.push(r)); }
  async get(hash: string): Promise<Uint8Array | null> {
    this.gets.push(hash);
    if (this.stallAll || this.slow.has(hash)) await this.hold();
    return this.inner.get(hash);
  }
  async has(hash: string): Promise<boolean> {
    this.hasCalls.push(hash);
    if (this.stallAll || this.slowHas.has(hash)) await this.hold();
    return this.inner.has(hash);
  }
  async put(hash: string, gz: Uint8Array): Promise<void> {
    this.puts.push(hash);
    if (this.stallAll || this.stallPuts) await this.hold(); // a stalled disk's write: never awaited by a load
    await this.inner.put(hash, gz);
  }
  release(): void { for (const r of this.waiting.splice(0)) r(); }
  get held(): number { return this.waiting.length; }
}

async function warm(set: TestSet, cache: StallCache): Promise<void> {
  for (const [hash, gz] of set.bucket.objects) await cache.inner.put(hash, gz);
}

/** Deadlines of a few ms of real time, with this test's own CacheHealth. */
const policy = (health = new CacheHealth(), ms = 20, hasMs = 30): CacheHedgePolicy => ({
  delayMs: () => ms,
  wait: (t, fire) => { const id = setTimeout(fire, t); return () => clearTimeout(id); },
  health,
  hasBoundMs: hasMs,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PERF.slow-cache-bypass: CacheHealth and boundedHas', () => {
  it('the cache is bypassed after CACHE_SLOW_OPS_TO_BYPASS slow operations; listeners hear it once', () => {
    const h = new CacheHealth();
    let heard = 0;
    h.onBypass(() => { heard++; });
    for (let i = 1; i < CACHE_SLOW_OPS_TO_BYPASS; i++) h.noteSlow();
    expect(h.bypassed).toBe(false);
    expect(heard).toBe(0);
    h.noteSlow();
    expect(h.bypassed).toBe(true);
    h.noteSlow();
    expect(heard).toBe(1);
    let late = 0;
    h.onBypass(() => { late++; });
    expect(late).toBe(1); // already bypassed: at once
  });

  it('a has() past its bound answers "not stored" and counts as slow; a fast one answers true; a bypassed cache is not asked', async () => {
    const h = new CacheHealth(3);
    const p = policy(h, 20, 25);
    let release: () => void = () => undefined;
    const stalled = () => new Promise<boolean>((r) => { release = () => r(true); });
    let timeouts = 0;
    expect(await boundedHas(stalled, 'x', p, h, () => { timeouts++; })).toBe(false);
    expect(h.hasTimeouts).toBe(1);
    expect(h.slowOps).toBe(1);
    expect(timeouts).toBe(1);
    release(); // the late answer is dropped
    await flush();
    expect(await boundedHas(async () => true, 'y', p, h)).toBe(true);
    expect(h.slowOps).toBe(1);
    h.noteSlow(); h.noteSlow();
    let asked = 0;
    expect(await boundedHas(async () => { asked++; return true; }, 'z', p, h)).toBe(false);
    expect(asked).toBe(0);
  });

  it('a null policy (dev ?noCacheHedge) waits a has() out', async () => {
    let release: () => void = () => undefined;
    let done = false;
    const got = boundedHas(() => new Promise<boolean>((r) => { release = () => r(true); }), 'x', null, null);
    void got.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    release();
    expect(await got).toBe(true);
  });

  it('the default policy: one page-wide CacheHealth, has() bound 1.5 s (p99 of 677 production boots 605 ms)', () => {
    expect(DEFAULT_CACHE_HEDGE.health).toBe(pageCacheHealth);
    expect(DEFAULT_CACHE_HEDGE.hasBoundMs).toBe(CACHE_HAS_BOUND_MS);
    expect(CACHE_HAS_BOUND_MS).toBeGreaterThan(649); // the slowest healthy has() seen
    expect(CACHE_HAS_BOUND_MS).toBeLessThan(3899); // the fastest stalled one
  });
});

describe('PERF.slow-cache-bypass: DatStore reads', () => {
  it('after two slow reads the cache is bypassed: later reads go to the network without asking the cache, and nothing is written to it', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    cache.slow.add(set.packs.world.hash);
    cache.slow.add(set.packs.terrain.hash);
    const health = new CacheHealth();
    const store = await DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, packs: ['boot'], cacheHedge: policy(health), retries: 1 });
    await Promise.all([store.ensurePack('world'), store.ensurePack('terrain')]);
    expect(store.stats.cacheHedges).toBe(2);
    expect(health.bypassed).toBe(true);
    const getsBefore = cache.gets.length;
    set.bucket.requests = [];
    await store.ensurePack('skeleton', FetchPriority.Critical);
    expect(cache.gets.length).toBe(getsBefore);
    expect(set.bucket.requests).toEqual([set.packs.skeleton.hash]);
    expect(store.stats.cacheBypassReads).toBe(1);
    expect(health.bypassReads).toBe(1);
    expect(cache.puts).toEqual([]);
    expect(store.db('portal').getFileData(0x02000001)).not.toBeNull();
    // The two slow reads land late: no second apply, no write, the packs stay as they are, and they
    // are not counted as served from the cache. Wait for their checks (inflate + hash) to finish, not a tick.
    const s = store as unknown as { inflateChecked: (gz: Uint8Array, ref: unknown) => Promise<Uint8Array> };
    const inflate = s.inflateChecked.bind(store);
    const lateChecks: Array<Promise<unknown>> = [];
    s.inflateChecked = (gz, ref) => { const p = inflate(gz, ref); lateChecks.push(p.catch(() => null)); return p; };
    cache.release();
    await vi.waitFor(() => expect(lateChecks).toHaveLength(2));
    await Promise.all(lateChecks);
    await flush(); // the .then that receives each check's result
    expect(cache.puts).toEqual([]);
    expect(store.isPackResident('world')).toBe(true);
    expect(store.stats.cacheObjects).toBe(2); // the manifest and the boot pack (read in time); the late copies were dropped
  });

  it('reads waiting on their deadline ask the network as soon as the bypass begins', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    cache.slow.add(set.packs.world.hash);
    const health = new CacheHealth();
    // A long read deadline: only the bypass can start this hedge in time.
    const store = await DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, packs: ['boot'], cacheHedge: policy(health, 60_000), retries: 1 });
    set.bucket.requests = [];
    const landed = store.ensurePack('world');
    await flush();
    expect(set.bucket.requests).toEqual([]);
    health.noteSlow(); health.noteSlow(); // e.g. two has() checks ran over
    await landed;
    expect(set.bucket.requests).toEqual([set.packs.world.hash]);
    expect(store.stats.cacheHedges).toBe(1);
    expect(store.stats.cacheHedgeWins).toBe(1);
    expect(health.slowOps).toBe(2); // a hedge started by the bypass is not another slow operation
    cache.release();
  });

  it('offline: a bypassed read whose download fails is served by the cache after all', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    const health = new CacheHealth();
    health.noteSlow(); health.noteSlow();
    const store = await DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, packs: ['boot'], cacheHedge: policy(health), retries: 1 });
    (store as unknown as { onError: () => void }).onError = () => undefined;
    set.bucket.failing.set(set.packs.world.hash, 99);
    await store.ensurePack('world');
    expect(store.isPackResident('world')).toBe(true);
    expect(store.stats.failures).toBe(1);
    expect(store.stats.cacheObjects).toBeGreaterThan(0);
    // An object neither side has still fails.
    set.bucket.failing.set(set.packs.terrain.hash, 99);
    cache.inner.map.delete(set.packs.terrain.hash);
    await expect(store.ensurePack('terrain')).rejects.toThrow();
  });

  it('inverse: a healthy cache is never bypassed and a warm store downloads nothing', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    const health = new CacheHealth();
    const store = await DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, packs: ['boot'], cacheHedge: policy(health, 200), retries: 1 });
    set.bucket.requests = [];
    await Promise.all((['world', 'terrain', 'local', 'skeleton'] as const).map((r) => store.ensurePack(r)));
    await new Promise((r) => setTimeout(r, 250));
    expect(set.bucket.requests).toEqual([]);
    expect(health.slowOps).toBe(0);
    expect(health.bypassed).toBe(false);
    expect(store.stats.cacheBypassReads).toBe(0);
  });

  it('a cold cache still stores what the network brings (writes are not awaited)', async () => {
    const set = makeSet();
    const cache = new StallCache();
    const store = await DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, packs: ['boot'], cacheHedge: policy(), retries: 1 });
    cache.stallPuts = true; // every write from here on never finishes
    await store.ensurePack('world');
    expect(store.isPackResident('world')).toBe(true);
    expect(cache.puts).toContain(set.packs.world.hash);
    cache.release();
  });
});

describe('PERF.slow-cache-bypass: openStreamingDats', () => {
  it('a stalled OPFS (every operation hangs): the boot finishes from the network, reports the bypass, and the bridge keeps it', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    cache.stallAll = true;
    const health = new CacheHealth();
    const s = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, cacheHedge: policy(health) });
    // The warm-profile check could not answer: the cold path (world packs behind char select).
    expect(s.bootReport.worldCached).toBe(false);
    await s.worldPacks;
    const p = s.bootReport.phases;
    expect(p.cacheBypassed).toBe(1);
    expect(p.hedges).toBeGreaterThanOrEqual(1);
    expect(p.bypassReads).toBeGreaterThanOrEqual(1);
    expect(p.hasTimeouts).toBe(0); // bypassed before the check: answered at once
    expect(s.store.isPackResident('world')).toBe(true);
    expect(cache.puts).toEqual([]);
    cache.release();
    await flush();
    const sane = streamPhasesField(p).phases;
    for (const k of ['splitMs', 'hasTimeouts', 'bypassReads', 'cacheBypassed'] as const) {
      expect(BOOT_STREAM_PHASE_KEYS).toContain(k);
      expect(BRIDGE_PHASE_KEYS).toContain(k);
      expect(sane?.[k]).toBe(p[k]);
      expect(boundBootStreamPhases(p)?.[k]).toBe(p[k]);
    }
  });

  it('only the has() checks stall: they answer "not stored" at their bound and are counted', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    cache.slowHas.add(set.packs.world.hash);
    const health = new CacheHealth(5);
    const s = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, cacheHedge: policy(health) });
    expect(s.bootReport.worldCached).toBe(false);
    expect(s.bootReport.phases.hasTimeouts).toBe(1);
    expect(s.bootReport.phases.cacheBypassed).toBe(0);
    // The world packs still come from the (fast-reading) cache, behind char select.
    set.bucket.requests = [];
    await s.worldPacks;
    expect(set.bucket.requests).toEqual([]);
    cache.release();
  });

  it('inverse: a healthy warm cache is still found warm (worldCached), with nothing timed out or bypassed', async () => {
    const set = makeSet();
    const cache = new StallCache();
    await warm(set, cache);
    const s = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, cacheHedge: policy() });
    expect(s.bootReport.worldCached).toBe(true);
    expect(s.bootReport.netBytes).toBe(0);
    expect(s.bootReport.phases.hasTimeouts).toBe(0);
    expect(s.bootReport.phases.cacheBypassed).toBe(0);
    expect(s.bootReport.phases.bypassReads).toBe(0);
  });
});
