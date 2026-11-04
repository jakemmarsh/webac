/**
 * PERF.cache-read-slower-than-network — a slow object-cache read no longer
 * holds the boot: once it passes its deadline the network is asked too, and
 * the first verified payload wins. A prerendered page neither hedges nor
 * reports boot_slow before it is shown (Chrome holds OPFS until then).
 *
 * Production (bridge, 2026-11-04 01:32Z, build 8658ebcf): a warm boot read
 * 37,168,872 B / 111 objects from the cache with cacheReadMaxMs 19158 —
 * one read (the 18.6 MB worldLand pack) held 'world_cache' for 21 s.
 * 2026-11-02 22:19Z: dirMs 129384 with hiddenMs 129346, a prerender.
 *
 * Drives the real DatStore over a fake content-addressed bucket (real gzip,
 * real hashes) with a cache whose reads are held by hand, the real
 * prerenderAwareWait, BootWatch and PreworldReporter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_HEDGE_BASE_MS, CACHE_HEDGE_BYTES_PER_MS, type CacheHedgePolicy, DEFAULT_CACHE_HEDGE, DatStore, FetchPriority, type ObjectFetcher, prerenderAwareWait,
} from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache, NullObjectCache, type ObjectCache, SlowReadObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { openStreamingDats } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import { type BootWatchEnv, startBootWatch } from '../packages/renderer/src/dat/streaming/BootWatch.js';
import { BOOT_SLOW_MS, BOOT_STREAM_PHASE_KEYS, PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { BOOT_STREAM_PHASE_KEYS as BRIDGE_PHASE_KEYS } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { type DatBlobStore, type DatCacheMeta, loadDatWithCache } from '../packages/renderer/src/dat/DatCache.js';
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
  return { bucket, pointer, packs };
}
const pointerOf = (set: ReturnType<typeof makeSet>) => async () => JSON.parse(JSON.stringify(set.pointer));

/** A cache warmed with the whole set whose reads of `slow` hashes wait until released (or return what `slowResult` says). */
class HeldCache implements ObjectCache {
  readonly persistent = true;
  readonly inner = new MemoryObjectCache();
  readonly slow = new Set<string>();
  readonly puts: string[] = [];
  private readonly waiting: Array<() => void> = [];
  /** What a released slow read returns: the stored bytes, or null (an unreadable file). */
  slowResult: 'bytes' | 'null' = 'bytes';
  async get(hash: string): Promise<Uint8Array | null> {
    if (this.slow.has(hash)) {
      await new Promise<void>((r) => this.waiting.push(r));
      if (this.slowResult === 'null') return null;
    }
    return this.inner.get(hash);
  }
  async put(hash: string, gz: Uint8Array): Promise<void> { this.puts.push(hash); await this.inner.put(hash, gz); }
  async has(hash: string): Promise<boolean> { return this.inner.has(hash); }
  release(): void { for (const r of this.waiting.splice(0)) r(); }
  get held(): number { return this.waiting.length; }
}

/** Hedge after `ms` of real time (tests use a few ms). */
const fastHedge = (ms = 20): CacheHedgePolicy => ({
  delayMs: () => ms,
  wait: (t, fire) => { const id = setTimeout(fire, t); return () => clearTimeout(id); },
});

async function warmCache(set: ReturnType<typeof makeSet>, cache: HeldCache): Promise<void> {
  for (const [hash, gz] of set.bucket.objects) await cache.inner.put(hash, gz);
}

async function openStore(set: ReturnType<typeof makeSet>, cache: ObjectCache, cacheHedge: CacheHedgePolicy | null, fetchObject: ObjectFetcher = set.bucket.fetch) {
  return DatStore.open({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject, cache, packs: ['boot'], cacheHedge, retries: 1 });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PERF.cache-read-slower-than-network: a stalled cache read is raced against the network', () => {
  it('a world-pack read stuck past its deadline is served by the network, and the cache copy is left alone', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    cache.slow.add(set.packs.world.hash);
    const store = await openStore(set, cache, fastHedge());
    set.bucket.requests = [];
    await store.ensurePack('world', FetchPriority.Prefetch); // resolves although the cache read never returned
    expect(store.isPackResident('world')).toBe(true);
    expect(store.db('portal').getFileData(0x06000200)).not.toBeNull();
    expect(cache.held).toBe(1);
    expect(set.bucket.requests).toEqual([set.packs.world.hash]);
    expect(store.stats.cacheHedges).toBe(1);
    expect(store.stats.cacheHedgeWins).toBe(1);
    expect(store.stats.netObjects).toBe(1);
    // The cache has it (it was only slow): no rewrite of an 18 MB file onto a struggling disk.
    expect(cache.puts).toEqual([]);
    cache.release();
    await flush();
    expect(cache.puts).toEqual([]);
    expect(store.stats.cacheMisses).toBe(0);
  });

  it('inverse: a cache read inside its deadline never touches the network (a warm boot downloads nothing)', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    const store = await openStore(set, cache, fastHedge(200));
    set.bucket.requests = [];
    await Promise.all((['world', 'terrain', 'local', 'skeleton'] as const).map((r) => store.ensurePack(r)));
    await new Promise((r) => setTimeout(r, 250)); // past every deadline: a cancelled timer must not fire a download
    expect(set.bucket.requests).toEqual([]);
    expect(store.stats.cacheHedges).toBe(0);
    expect(store.stats.netBytes).toBe(0);
  });

  it('the cache delivering first after the hedge began aborts the download: no failure, no retry, no second copy', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    cache.slow.add(set.packs.world.hash);
    let signal: AbortSignal | undefined;
    let releaseNet: () => void = () => undefined;
    const fetchObject = async (url: string, o: { signal?: AbortSignal }) => {
      if (!url.endsWith(set.packs.world.hash)) return set.bucket.fetch(url);
      signal = o.signal;
      await new Promise<void>((resolve, reject) => {
        releaseNet = resolve;
        o.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return set.bucket.fetch(url);
    };
    const store = await openStore(set, cache, fastHedge(), fetchObject);
    const errors: string[] = [];
    (store as unknown as { onError: (d: string) => void }).onError = (d) => { errors.push(d); };
    const landed = store.ensurePack('world');
    await vi.waitFor(() => expect(signal).toBeDefined());
    cache.release();
    await landed;
    expect(signal!.aborted).toBe(true);
    releaseNet();
    await flush();
    expect(store.stats.cacheHedges).toBe(1);
    expect(store.stats.cacheHedgeWins).toBe(0);
    expect(store.stats.cacheObjects).toBeGreaterThan(0);
    expect(store.stats.failures).toBe(0);
    expect(store.stats.retries).toBe(0);
    expect(store.stats.netObjects).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a slow read that comes back unusable after the network won stores the good copy', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    cache.slow.add(set.packs.world.hash);
    cache.slowResult = 'null';
    const store = await openStore(set, cache, fastHedge());
    await store.ensurePack('world');
    expect(cache.puts).toEqual([]);
    cache.release();
    await vi.waitFor(() => expect(cache.puts).toEqual([set.packs.world.hash]));
    expect(store.stats.cacheMisses).toBe(1);
  });

  it('a failed hedge download leaves the slow cache read to deliver (the boot never fails for it)', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    cache.slow.add(set.packs.world.hash);
    set.bucket.failing.set(set.packs.world.hash, 99);
    const store = await openStore(set, cache, fastHedge());
    (store as unknown as { onError: () => void }).onError = () => undefined;
    const landed = store.ensurePack('world');
    await vi.waitFor(() => expect(store.stats.failures).toBe(1)); // the hedge gave up (retries: 1)
    let done = false;
    void landed.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    cache.release();
    await landed;
    expect(store.isPackResident('world')).toBe(true);
    expect(store.stats.cacheHedgeWins).toBe(0);
  });

  it('a cache with nothing to hedge (no persistence, ?nocache) and a null policy go straight to the network / wait it out', async () => {
    const set = makeSet();
    const store = await openStore(set, new NullObjectCache(), DEFAULT_CACHE_HEDGE);
    await store.ensurePack('world');
    expect(store.stats.cacheHedges).toBe(0);
    expect(store.stats.netObjects).toBeGreaterThan(0);

    const set2 = makeSet();
    const cache = new HeldCache();
    await warmCache(set2, cache);
    cache.slow.add(set2.packs.world.hash);
    const store2 = await openStore(set2, cache, null);
    set2.bucket.requests = [];
    const landed = store2.ensurePack('world');
    await new Promise((r) => setTimeout(r, 60));
    expect(set2.bucket.requests).toEqual([]);
    cache.release();
    await landed;
    expect(store2.stats.cacheHedges).toBe(0);
  });

  it('the default deadline: 3 s plus the object at 8 MB/s; a healthy read (the slowest seen in 213 boots: 1.97 s) never hedges', () => {
    expect(DEFAULT_CACHE_HEDGE.delayMs(0)).toBe(CACHE_HEDGE_BASE_MS);
    // worldLand, 18,630,144 B gzip: ~5.3 s, against the 19.2 s read that held the boot.
    const worldLand = DEFAULT_CACHE_HEDGE.delayMs(18_630_144);
    expect(worldLand).toBeCloseTo(CACHE_HEDGE_BASE_MS + 18_630_144 / CACHE_HEDGE_BYTES_PER_MS, 5);
    expect(worldLand).toBeGreaterThan(1969);
    expect(worldLand).toBeLessThan(19_158);
  });

  it('openStreamingDats reports the hedges in its phases, and the bridge keeps them', async () => {
    const set = makeSet();
    const cache = new HeldCache();
    await warmCache(set, cache);
    cache.slow.add(set.packs.world.hash);
    const s = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, cacheHedge: fastHedge() });
    expect(s.bootReport.worldCached).toBe(true);
    expect(s.bootReport.phases.hedges).toBe(1);
    expect(s.bootReport.phases.hedgeWins).toBe(1);
    cache.release();
    for (const k of ['hedges', 'hedgeWins', 'prerenderMs'] as const) {
      expect(BOOT_STREAM_PHASE_KEYS).toContain(k);
      expect(BRIDGE_PHASE_KEYS).toContain(k);
    }
  });

  it('SlowReadObjectCache (dev ?cacheReadDelayMs) slows only big reads', async () => {
    vi.useFakeTimers();
    try {
      const inner = new MemoryObjectCache();
      await inner.put('big', new Uint8Array(2 << 20));
      await inner.put('small', new Uint8Array(10));
      const slow = new SlowReadObjectCache(inner, 5000);
      let big = false;
      void slow.get('big').then(() => { big = true; });
      expect(await slow.get('small')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(4999);
      expect(big).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(big).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PERF.cache-read-slower-than-network: a prerendered page', () => {
  afterEach(() => { vi.useRealTimers(); });

  function fakeDoc(prerendering: boolean) {
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      prerendering,
      visibilityState: prerendering ? 'hidden' : 'visible',
      addEventListener: (t: string, l: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l); },
      removeEventListener: (t: string, l: () => void) => { listeners.get(t)?.delete(l); },
      activate() { doc.prerendering = false; doc.visibilityState = 'visible'; for (const t of ['prerenderingchange', 'visibilitychange']) for (const l of [...(listeners.get(t) ?? [])]) { listeners.get(t)!.delete(l); l(); } },
    };
    return doc;
  }

  it('the hedge clock does not run while prerendering: it starts again on activation', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc(true);
    let fired = 0;
    prerenderAwareWait(3000, () => { fired++; }, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(120_000); // the 2026-11-02 prerender sat 129 s
    expect(fired).toBe(0);
    doc.activate();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fired).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(1);
  });

  it('a visible page fires on time; a cancelled wait never fires', async () => {
    vi.useFakeTimers();
    let fired = 0;
    prerenderAwareWait(3000, () => { fired++; }, fakeDoc(false) as unknown as Document);
    const cancel = prerenderAwareWait(3000, () => { fired += 10; }, fakeDoc(false) as unknown as Document);
    cancel();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fired).toBe(1);
  });

  it('BootWatch reports the prerendered time beside the hidden time', () => {
    const clock = { t: 0 };
    const doc = fakeDoc(true);
    const env: BootWatchEnv = { now: () => clock.t, setInterval: () => 1, clearInterval: () => undefined, doc: doc as unknown as BootWatchEnv['doc'] };
    const watch = startBootWatch(env);
    clock.t = 129_346;
    doc.activate();
    clock.t = 129_702;
    const r = watch.stop();
    expect(r.prerenderMs).toBe(129_346);
    expect(r.hiddenMs).toBe(129_346);
  });

  it('boot_slow counts from when the page was shown, not from the prerender', () => {
    const clock = { t: 0 };
    let prerendering = true;
    const sent: PreworldEvent[] = [];
    const rep = new PreworldReporter({
      endpoint: 'https://bridge.test/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null, screen: () => 'boot',
      now: () => clock.t, prerendering: () => prerendering,
      send: (_u: string, body: string) => { sent.push(JSON.parse(body) as PreworldEvent); return true; },
    });
    for (clock.t = 0; clock.t <= 129_000; clock.t += 1000) rep.tick();
    expect(sent.filter((e) => e.outcome === 'boot_slow')).toEqual([]);
    prerendering = false;
    for (; clock.t < 129_000 + BOOT_SLOW_MS; clock.t += 1000) rep.tick();
    expect(sent.filter((e) => e.outcome === 'boot_slow')).toEqual([]);
    clock.t += 1000;
    rep.tick();
    expect(sent.filter((e) => e.outcome === 'boot_slow')).toHaveLength(1);
  });

  it('inverse: a page that was never prerendered still reports boot_slow at BOOT_SLOW_MS', () => {
    const clock = { t: 0 };
    const sent: PreworldEvent[] = [];
    const rep = new PreworldReporter({
      endpoint: 'https://bridge.test/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null, screen: () => 'boot',
      now: () => clock.t, prerendering: () => false,
      send: (_u: string, body: string) => { sent.push(JSON.parse(body) as PreworldEvent); return true; },
    });
    for (clock.t = 0; clock.t <= BOOT_SLOW_MS; clock.t += 1000) rep.tick();
    expect(sent.filter((e) => e.outcome === 'boot_slow')).toHaveLength(1);
  });
});

describe('PERF.cache-read-slower-than-network: the whole-DAT cache (AC1999 world DATs) takes the same race', () => {
  /** A DatBlobStore holding one valid DAT whose data read is held until released (or comes back as `result`). */
  function heldStore(bytes: ArrayBuffer) {
    const puts: string[] = [];
    let release: () => void = () => undefined;
    let result: 'bytes' | 'null' = 'bytes';
    const held = new Promise<void>((r) => { release = r; });
    let slow = true;
    const store: DatBlobStore = {
      available: true,
      getMeta: async () => ({ size: bytes.byteLength, lastModified: null, etag: 'e1' }),
      getData: async () => { if (slow) await held; return result === 'null' ? null : bytes; },
      put: async (k) => { puts.push(k); },
      remove: async () => undefined,
      clear: async () => undefined,
    };
    return { store, puts, release: () => release(), setResult: (r: 'bytes' | 'null') => { result = r; }, setFast: () => { slow = false; } };
  }
  const head = async (): Promise<DatCacheMeta> => ({ size: 1000, lastModified: null, etag: 'e1' });

  it('a stalled read is overtaken by the download; the valid cached copy is not rewritten', async () => {
    const h = heldStore(new ArrayBuffer(1000));
    const fetchData = vi.fn(async () => new ArrayBuffer(1000));
    const sources: string[] = [];
    const r = await loadDatWithCache('/client_portal.dat', { store: h.store, headMeta: head, fetchData, hedge: fastHedge(), onSource: (s) => sources.push(s) });
    expect(r.fromCache).toBe(false);
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(sources).toEqual(['network']);
    h.release();
    await flush();
    expect(h.puts).toEqual([]);
  });

  it('inverse: a read inside its deadline never downloads', async () => {
    const h = heldStore(new ArrayBuffer(1000));
    h.setFast();
    const fetchData = vi.fn(async () => new ArrayBuffer(1000));
    const r = await loadDatWithCache('/client_portal.dat', { store: h.store, headMeta: head, fetchData, hedge: fastHedge(200) });
    await new Promise((res) => setTimeout(res, 250));
    expect(r.fromCache).toBe(true);
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('the cache finishing first aborts the download', async () => {
    const h = heldStore(new ArrayBuffer(1000));
    let signal: AbortSignal | undefined;
    const fetchData = vi.fn((_u: string, _p?: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise<ArrayBuffer>((_res, rej) => s?.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    const p = loadDatWithCache('/client_portal.dat', { store: h.store, headMeta: head, fetchData, hedge: fastHedge() });
    await vi.waitFor(() => expect(signal).toBeDefined());
    h.release();
    const r = await p;
    expect(r.fromCache).toBe(true);
    expect(signal!.aborted).toBe(true);
  });

  it('an unusable cached copy found after the hedge began is replaced by the downloaded one', async () => {
    const h = heldStore(new ArrayBuffer(1000));
    h.setResult('null');
    let finish: (b: ArrayBuffer) => void = () => undefined;
    const fetchData = vi.fn(() => new Promise<ArrayBuffer>((res) => { finish = res; }));
    const p = loadDatWithCache('/client_portal.dat', { store: h.store, headMeta: head, fetchData, hedge: fastHedge() });
    await vi.waitFor(() => expect(fetchData).toHaveBeenCalled());
    h.release();
    await flush();
    finish(new ArrayBuffer(1000));
    const r = await p;
    expect(r.fromCache).toBe(false);
    expect(r.buffer.byteLength).toBe(1000);
    await flush();
    expect(h.puts).toEqual(['client_portal.dat']);
  });
});
