/**
 * STREAM.shared-network-link (2026-11-03, the throttled-login follow-ups): every streamed set on the page
 * fetches over one link, and a portal-space gate holds background warm-fill.
 *
 * Measured live (production build, CDP 150 ms + 10 Mbit/s, cold profile): the end-of-retail area common pack
 * (8.3 MB, Background) began 2 s before the login gate and downloaded beside the gate's own 7.7 MB for 14 s
 * (the limiter never pre-empts running work), and AC1999's two stores each ran their own 96-fetch limiter
 * and LinkMeter, so the world store saw half the link and called a 10 Mbit/s line slow.
 *
 * Drives the real DatStore + NetworkLink over FakeBucket objects with a fetcher that honours AbortSignal.
 */
import { describe, expect, it, vi } from 'vitest';
import { DatStore, FIRST_BYTE_STALL_MS, FetchPriority, NetworkLink, type ObjectFetcher } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest } from './_harness/datSet.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A fetcher whose responses wait for release(hash); an abort rejects at once. `started` lists starts in order. */
function controlled() {
  const started: string[] = [];
  const waiters = new Map<string, () => void>();
  const s = { armed: false };
  const make = (bucket: FakeBucket): ObjectFetcher => async (url, opts) => {
    if (!s.armed) return bucket.fetch(url);
    const hash = url.slice(url.lastIndexOf('/') + 1);
    started.push(hash);
    await new Promise<void>((resolve, reject) => {
      waiters.set(hash, resolve);
      opts.signal?.addEventListener('abort', () => { waiters.delete(hash); reject(new DOMException('aborted', 'AbortError')); });
    });
    opts.onBytes?.(10);
    return bucket.fetch(url);
  };
  const release = (hash: string) => { waiters.get(hash)?.(); waiters.delete(hash); };
  return { started, make, release, waiting: () => [...waiters.keys()], arm: () => { s.armed = true; } };
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

/** `n` incompressible bytes (gzip as big): a pack-sized object. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

/** `bigFirst`: leaf 0x01000001 is a 600 KB object (the common pack's stand-in). */
async function store(fetchObject: ObjectFetcher, bucket: FakeBucket, leaves: number, network?: NetworkLink, tag = 's', bigFirst = false) {
  const leafList = Array.from({ length: leaves }, (_, i) => ({ id: 0x01000001 + i, ...bucket.put(bigFirst && i === 0 ? noise(600_000, 7) : enc(`${tag} gfx ${i}`)) }));
  const manifest = bucket.put(buildManifest({ leaves: { portal: leafList }, packs: [], bundles: [] }));
  const pointer = {
    format: 1, set: tag, iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
    manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize }, packs: {},
  };
  return DatStore.open({
    pointerUrl: `https://d.test/v1/sets/${tag}.json`, fetchPointer: async () => pointer, fetchObject,
    cache: new MemoryObjectCache(), packs: [], retries: 0, onError: () => {}, ...(network ? { network } : {}),
  });
}
const hashOf = (s: DatStore, id: number) => s.manifest.leaves.portal.get(id)!.hash;

describe('one network link for every streamed set on the page', () => {
  it('two stores share one concurrency limit', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink({ maxConcurrent: 3 });
    const a = await store(c.make(bucket), bucket, 4, link, 'a');
    const b = await store(c.make(bucket), bucket, 4, link, 'b');
    c.arm();
    for (let i = 0; i < 4; i++) { void a.request('portal', 0x01000001 + i); void b.request('portal', 0x01000001 + i); }
    await settle();
    expect(c.started).toHaveLength(3); // not 3 per store
    expect(link.running).toBe(3);
    expect(link.pending).toBe(5);
    for (let n = 0; n < 8; n++) { for (const h of c.waiting()) c.release(h); await settle(); }
    expect(c.started).toHaveLength(8);
    expect(a.isResident('portal', 0x01000004) && b.isResident('portal', 0x01000004)).toBe(true);
  });

  it("one store's critical load holds the other's prefetch (the gate's critical-first rule sees both sets)", async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const world = await store(c.make(bucket), bucket, 2, link, 'world');
    const iface = await store(c.make(bucket), bucket, 2, link, 'iface');
    c.arm();
    void world.request('portal', 0x01000001, FetchPriority.Critical);
    await settle();
    void iface.request('portal', 0x01000001, FetchPriority.Prefetch);
    await settle();
    expect(c.started).toEqual([hashOf(world, 0x01000001)]);
    c.release(hashOf(world, 0x01000001));
    await settle();
    expect(c.started).toEqual([hashOf(world, 0x01000001), hashOf(iface, 0x01000001)]);
    c.release(hashOf(iface, 0x01000001));
  });

  it("background warm-fill starts only on an idle link: the 1999 world's common pack waits for the interface's world pack", async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const iface = await store(c.make(bucket), bucket, 1, link, 'iface');
    const world = await store(c.make(bucket), bucket, 1, link, 'world');
    c.arm();
    const worldPack = iface.request('portal', 0x01000001, FetchPriority.Prefetch);
    await settle();
    const common = world.request('portal', 0x01000001, FetchPriority.Background);
    await settle();
    expect(c.started).toEqual([hashOf(iface, 0x01000001)]);
    c.release(hashOf(iface, 0x01000001));
    expect(await worldPack).toBe(true);
    await settle();
    expect(c.started).toEqual([hashOf(iface, 0x01000001), hashOf(world, 0x01000001)]);
    c.release(hashOf(world, 0x01000001));
    expect(await common).toBe(true);
  });

  it('stores without a shared link keep their own (tests, tools: unchanged)', async () => {
    const bucket = new FakeBucket();
    const a = await store(bucket.fetch, bucket, 1, undefined, 'a');
    const b = await store(bucket.fetch, bucket, 1, undefined, 'b');
    expect(a.network).not.toBe(b.network);
    expect(a.link).toBe(a.network.meter);
  });
});

describe('a portal-space gate holds background warm-fill (NetworkLink.holdBackground)', () => {
  it('a running background download stops, waits out the hold, then lands; critical work runs meanwhile', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const s = await store(c.make(bucket), bucket, 3, link, 's', true);
    c.arm();
    const common = s.request('portal', 0x01000001, FetchPriority.Background); // the common pack's stand-in (600 KB)
    await settle();
    expect(c.started).toEqual([hashOf(s, 0x01000001)]);
    const release = link.holdBackground(); // the gate begins
    await settle();
    expect(c.waiting()).toEqual([]); // stopped
    expect(s.stats.yields).toBe(1);
    expect(s.stats.yieldedBytes).toBe(0);
    // Nothing background starts while held; the gate's critical loads go straight out.
    void s.request('portal', 0x01000003, FetchPriority.Background);
    const gateLoad = s.request('portal', 0x01000002, FetchPriority.Critical);
    await settle();
    expect(c.started.slice(1)).toEqual([hashOf(s, 0x01000002)]);
    c.release(hashOf(s, 0x01000002));
    expect(await gateLoad).toBe(true);
    await settle();
    expect(c.started).toHaveLength(2);
    release(); // the gate released
    release(); // idempotent
    await settle();
    expect(c.started.slice(2).sort()).toEqual([hashOf(s, 0x01000001), hashOf(s, 0x01000003)].sort());
    for (const h of c.waiting()) c.release(h);
    expect(await common).toBe(true);
    expect(s.stats.failures).toBe(0);
    expect(s.stats.retries).toBe(0);
  });

  it('a small background download (under BACKGROUND_YIELD_KEEP_BYTES to go) is left to finish', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const s = await store(c.make(bucket), bucket, 1, link);
    c.arm();
    const p = s.request('portal', 0x01000001, FetchPriority.Background);
    await settle();
    const release = link.holdBackground();
    await settle();
    expect(c.waiting()).toEqual([hashOf(s, 0x01000001)]);
    expect(s.stats.yields).toBe(0);
    c.release(hashOf(s, 0x01000001));
    expect(await p).toBe(true);
    release();
  });

  it('a background load the gate itself asks for (promoted to critical) keeps downloading', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const s = await store(c.make(bucket), bucket, 1, link, 's', true);
    c.arm();
    const p = s.request('portal', 0x01000001, FetchPriority.Background);
    await settle();
    void s.request('portal', 0x01000001, FetchPriority.Critical); // the gate's walk needs the same object
    const release = link.holdBackground();
    await settle();
    expect(c.waiting()).toEqual([hashOf(s, 0x01000001)]);
    expect(s.stats.yields).toBe(0);
    c.release(hashOf(s, 0x01000001));
    expect(await p).toBe(true);
    release();
  });

  it('prefetch work is not held (the world packs and UI art the login waits for)', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const link = new NetworkLink();
    const s = await store(c.make(bucket), bucket, 1, link);
    c.arm();
    const release = link.holdBackground();
    const p = s.request('portal', 0x01000001, FetchPriority.Prefetch);
    await settle();
    expect(c.waiting()).toEqual([hashOf(s, 0x01000001)]);
    c.release(hashOf(s, 0x01000001));
    expect(await p).toBe(true);
    release();
  });
});

describe('a fetch with no first byte while the link moves is asked again (STREAM.first-byte-stall)', () => {
  /** A's first attempt never answers (until aborted); B streams 70 KB after 1 s when `others` is set. */
  function stallFetcher(bucket: FakeBucket, aHash: () => string, others: boolean) {
    let aAttempts = 0;
    const f: ObjectFetcher = async (url, opts) => {
      const hash = url.slice(url.lastIndexOf('/') + 1);
      if (hash === aHash()) {
        aAttempts++;
        if (aAttempts === 1) {
          await new Promise<void>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        }
        return bucket.fetch(url);
      }
      if (others && aHash()) { await new Promise((r) => setTimeout(r, 1000)); opts.onBytes?.(70_000); }
      return bucket.fetch(url);
    };
    return { f, attempts: () => aAttempts };
  }

  it(`stopped after ${FIRST_BYTE_STALL_MS} ms and fetched again, once, without using a retry`, async () => {
    const bucket = new FakeBucket();
    let a = '';
    const sf = stallFetcher(bucket, () => a, true);
    const s = await store(sf.f, bucket, 2);
    a = hashOf(s, 0x01000001);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pa = s.request('portal', 0x01000001, FetchPriority.Critical);
      const pb = s.request('portal', 0x01000002, FetchPriority.Critical);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await pb).toBe(true);
      expect(sf.attempts()).toBe(1);
      await vi.advanceTimersByTimeAsync(FIRST_BYTE_STALL_MS);
      expect(await pa).toBe(true);
      expect(sf.attempts()).toBe(2);
      expect(s.stats.stalls).toBe(1);
      expect(s.stats.retries).toBe(0);
      expect(s.stats.failures).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('a slow link (nothing arriving for anyone) is not a stall: the fetch keeps waiting', async () => {
    const bucket = new FakeBucket();
    let a = '';
    const sf = stallFetcher(bucket, () => a, false);
    const s = await store(sf.f, bucket, 1);
    a = hashOf(s, 0x01000001);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void s.request('portal', 0x01000001, FetchPriority.Critical).catch(() => {});
      await vi.advanceTimersByTimeAsync(FIRST_BYTE_STALL_MS * 3);
      expect(sf.attempts()).toBe(1);
      expect(s.stats.stalls).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('a style\'s animations are fetched at once in a busy fight (STREAM.held-action-starved)', () => {
  const STYLE = 0x8000003e; // SwordCombat
  const anim = (i: number) => 0x03000570 + i;
  /** A table whose SwordCombat links play anim(0..2). */
  const table = () => ({
    id: 0x09000098, defaultStyle: 0x8000003d, styleDefaults: new Map(), modifiers: new Map(),
    cycles: new Map([[0x3e0003, { anims: [{ animId: anim(0) }] }]]),
    links: new Map([[0x3e0003, new Map([[0x10000062, { anims: [{ animId: anim(1) }] }], [0x10000060, { anims: [{ animId: anim(2) }] }]])]]),
  }) as unknown as import('@ac/dat-parser/file-types/MotionTable.js').MotionTable;

  async function animStore(c: ReturnType<typeof controlled>, bucket: FakeBucket) {
    const leafList = [0x06000001, anim(0), anim(1), anim(2)].map((id) => ({ id, ...bucket.put(enc(`file ${id.toString(16)}`)) }));
    const manifest = bucket.put(buildManifest({ leaves: { portal: leafList }, packs: [], bundles: [] }));
    const pointer = { format: 1, set: 'w', iterations: { portal: 1, cell: 1, local: 1, highres: 0 }, manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize }, packs: {} };
    return DatStore.open({ pointerUrl: 'https://d.test/v1/sets/w.json', fetchPointer: async () => pointer, fetchObject: c.make(bucket), cache: new MemoryObjectCache(), packs: [], retries: 0, onError: () => {} });
  }

  it('with a critical load in flight, the style prefetch goes out at once (at Prefetch it would wait for it)', async () => {
    const { storeAnimationPrefetch } = await import('../packages/renderer/src/animation/AnimationPrefetch.js');
    const c = controlled();
    const bucket = new FakeBucket();
    const s = await animStore(c, bucket);
    c.arm();
    void s.request('portal', 0x06000001, FetchPriority.Critical); // a miss elsewhere, still downloading
    await settle();
    expect(storeAnimationPrefetch(s).style(table(), STYLE)).toBe(3);
    await settle();
    expect(c.started.slice(1).sort()).toEqual([anim(0), anim(1), anim(2)].map((id) => hashOf(s, id)).sort());
    for (const h of c.waiting()) c.release(h);
  });

  it('a read that misses a queued prefetch (MotionManager holding the swing) promotes it to critical: it starts at once', async () => {
    const c = controlled();
    const bucket = new FakeBucket();
    const s = await animStore(c, bucket);
    c.arm();
    void s.request('portal', 0x06000001, FetchPriority.Critical);
    void s.request('portal', anim(1), FetchPriority.Prefetch);
    await settle();
    expect(c.started).toEqual([hashOf(s, 0x06000001)]); // the prefetch waits behind the critical load
    expect(s.db('portal').getFileData(anim(1))).toBeNull(); // loadAnimation's read: a miss
    await settle();
    expect(c.started).toEqual([hashOf(s, 0x06000001), hashOf(s, anim(1))]);
    for (const h of c.waiting()) c.release(h);
  });
});
