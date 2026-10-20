/**
 * BUG.slow-link-gate-and-fetch-flood (2026-10-20, live at 25 KB/s, @tele to a cold Yaraq): the
 * portal-space gate counted progress only when an object LANDED, and one object took longer than
 * its 90 s no-progress window, so it gave up as if the host were dead. Meanwhile 96 fetches in
 * flight split the link 96 ways and the session's WebSocket starved (two drops + resumes).
 *
 * Drives the real DatStore (received bytes as they stream, the link meter, the fetch limiter's
 * critical-first / slow-link rules), the real CellGate, and the bridge's WsLiveness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellGate, DEFAULT_GATE_TIMEOUT_MS } from '../packages/renderer/src/dat/streaming/PortalSpaceGate.js';
import { DatClosure } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import {
  DatStore, FetchPriority, LinkMeter, SLOW_LINK_BYTES_PER_S, SLOW_LINK_MIN_INFLIGHT_BYTES, type ObjectFetcher,
} from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';
import { WsLiveness } from '../services/ws-tcp-bridge/src/bridgeUtil.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A set with one landblock bundle (0xA9B4), its terrain pack, and `leaves` portal leaves 0x01000001…. */
/** `n` incompressible bytes (a texture-sized leaf whose gzip is as big). */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

async function streamedSet(fetchObject: (bucket: FakeBucket) => ObjectFetcher, leaves = 0, now?: () => number, leafBytes = 0) {
  const bucket = new FakeBucket();
  const terrain = { ...bucket.put(buildPack([{ id: 0xA9B4FFFF, data: enc('land') }])), files: 1 };
  const bundle = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: enc('info') }, { id: 0xA9B40100, data: enc('cell') }])) };
  const leafList = Array.from({ length: leaves }, (_, i) => ({ id: 0x01000001 + i, ...bucket.put(leafBytes ? noise(leafBytes, i + 1) : enc(`gfx ${i}`)) }));
  const manifest = bucket.put(buildManifest({ leaves: { portal: leafList }, packs: [{ role: 4, ...terrain }], bundles: [bundle] }));
  const pointer = {
    format: 1, set: 's', iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
    manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize },
    packs: { terrain: { key: `v1/o/${terrain.hash}`, size: terrain.size, gzSize: terrain.gzSize, files: 1 } },
  };
  const store = await DatStore.open({
    pointerUrl: 'https://d.test/v1/sets/s.json', fetchPointer: async () => pointer, fetchObject: fetchObject(bucket),
    cache: new MemoryObjectCache(), packs: ['terrain'], retries: 0, onError: () => {}, ...(now ? { now } : {}),
  });
  return { bucket, store, bundle };
}

describe('the portal-space gate counts bytes as they stream, not objects as they land', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** The bundle streams for `seconds` (1 KB a second, as at a starved 25 KB/s link), then lands. */
  const trickle = (hash: () => string, seconds: number) => (bucket: FakeBucket): ObjectFetcher => async (url, opts) => {
    if (hash() && url.endsWith(hash())) { // set once the store is open
      for (let i = 0; i < seconds; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        opts.onBytes?.(1000);
      }
    }
    return bucket.fetch(url);
  };

  it('one object streaming for 150 s keeps the gate holding, and it completes', async () => {
    let bundleHash = '';
    const { store, bundle } = await streamedSet(trickle(() => bundleHash, 150));
    bundleHash = bundle.hash;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gate = new CellGate(new DatClosure(store), {
      objectRadius: () => 0, now: () => Date.now(),
      progress: () => store.stats.netReceivedBytes + store.stats.cacheBytes,
    });
    let out: Awaited<ReturnType<CellGate['prefetch']>> | null = null;
    void gate.prefetch(0xA9B40100).then((o) => { out = o; });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATE_TIMEOUT_MS + 10_000);
    expect(out).toBeNull(); // past 90 s, still holding: bytes kept arriving
    expect(store.stats.netReceivedBytes).toBeGreaterThanOrEqual(100_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out).toMatchObject({ ok: true });
    expect(store.isBundleResident(0xA9B4)).toBe(true);
  });

  it('counting only landed bytes (the build the live test ran) gives up at 90 s with 0 done', async () => {
    let bundleHash = '';
    const { store, bundle } = await streamedSet(trickle(() => bundleHash, 150));
    bundleHash = bundle.hash;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gate = new CellGate(new DatClosure(store), {
      objectRadius: () => 0, now: () => Date.now(),
      progress: () => store.stats.netBytes + store.stats.cacheBytes,
    });
    let out: Awaited<ReturnType<CellGate['prefetch']>> | null = null;
    void gate.prefetch(0xA9B40100).then((o) => { out = o; });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATE_TIMEOUT_MS + 2000);
    const o = out as Awaited<ReturnType<CellGate['prefetch']>> | null;
    expect(o?.ok).toBe(false);
    if (o && !o.ok) expect(o.error.message).toMatch(/without progress \(0\/\d+ done\)/);
    await vi.advanceTimersByTimeAsync(60_000); // let the download finish
  });

  it('a fetcher that cannot report chunks is topped up when it lands', async () => {
    const { store } = await streamedSet((b) => b.fetch, 1);
    await store.request('portal', 0x01000001);
    expect(store.stats.netReceivedBytes).toBe(store.stats.netBytes);
    expect(store.stats.netReceivedBytes).toBeGreaterThan(0);
  });
});

describe('the fetch limiter: critical work first, a slow link starts few fetches', () => {
  /** A fetcher whose responses wait until the test releases them; `started` lists hashes in start order. */
  function controlled() {
    const started: string[] = [];
    const waiters = new Map<string, () => void>();
    const s = { armed: false };
    const make = (bucket: FakeBucket): ObjectFetcher => async (url) => {
      if (!s.armed) return bucket.fetch(url); // the store's own open (manifest, packs)
      const hash = url.slice(url.lastIndexOf('/') + 1);
      started.push(hash);
      await new Promise<void>((r) => waiters.set(hash, r));
      return bucket.fetch(url);
    };
    const release = (hash: string) => { waiters.get(hash)?.(); waiters.delete(hash); };
    return { started, make, release, arm: () => { s.armed = true; } };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  const leafHash = (store: DatStore, id: number) => store.manifest.leaves.portal.get(id)!.hash;

  it('prefetch and background work wait while a critical load runs, then start', async () => {
    const c = controlled();
    const { store } = await streamedSet(c.make, 4);
    c.arm();
    void store.request('portal', 0x01000001, FetchPriority.Critical);
    await settle();
    void store.request('portal', 0x01000002, FetchPriority.Prefetch);
    void store.request('portal', 0x01000003, FetchPriority.Background);
    await settle();
    expect(c.started).toEqual([leafHash(store, 0x01000001)]);
    // Another critical load still goes straight out.
    void store.request('portal', 0x01000004, FetchPriority.Critical);
    await settle();
    expect(c.started).toEqual([leafHash(store, 0x01000001), leafHash(store, 0x01000004)]);
    c.release(leafHash(store, 0x01000001));
    await settle();
    expect(c.started).toHaveLength(2); // one critical still running
    c.release(leafHash(store, 0x01000004));
    await settle();
    expect(c.started.slice(2).sort()).toEqual([leafHash(store, 0x01000002), leafHash(store, 0x01000003)].sort());
    for (const h of c.started) c.release(h);
  });

  it('with no critical work, prefetch runs as many at once as before (healthy link unchanged)', async () => {
    const c = controlled();
    const { store } = await streamedSet(c.make, 20);
    c.arm();
    for (let i = 0; i < 20; i++) void store.request('portal', 0x01000001 + i, FetchPriority.Prefetch);
    await settle();
    expect(c.started).toHaveLength(20);
    for (const h of [...c.started]) c.release(h);
  });

  it(`a slow link (a saturated second under ${SLOW_LINK_BYTES_PER_S / 1024} KB/s): big objects start only while ~2 s of the link is in flight, critical first; a fast second lifts it`, async () => {
    const c = controlled();
    let t = 0;
    const { store } = await streamedSet(c.make, 30, () => t, 20_000);
    c.arm();
    expect(store.link.slow).toBe(false);
    // The live case: ~1 MB in flight, 25 KB arriving in a second.
    store.link.begin(1_000_000); t += 1000; store.link.received(25_000);
    expect(store.link.slow).toBe(true);
    store.link.end(975_000);
    expect(store.link.slowBudgetBytes).toBe(Math.max(SLOW_LINK_MIN_INFLIGHT_BYTES, 50_000));
    for (let i = 0; i < 20; i++) void store.request('portal', 0x01000001 + i, FetchPriority.Prefetch);
    await settle();
    // 20 KB each, 50 KB of room: two in flight, not 20 (each would get 1/20 of 25 KB/s, and the game's socket a sliver).
    expect(c.started).toHaveLength(2);
    // A critical miss queued now goes before the waiting prefetch.
    void store.request('portal', 0x01000015, FetchPriority.Critical);
    await settle();
    c.release(c.started[0]);
    await settle();
    expect(c.started[2]).toBe(leafHash(store, 0x01000015));
    expect(c.started).toHaveLength(3);
    // A second at 1 MB/s: healthy again, the rest start as before.
    store.link.begin(2_000_000); t += 1000; store.link.received(1_000_000);
    expect(store.link.slow).toBe(false);
    c.release(c.started[1]);
    await settle();
    c.release(leafHash(store, 0x01000015));
    await settle();
    expect(c.started.length).toBe(21);
    for (const h of [...c.started]) c.release(h);
  });

  it('on a slow link small objects still go many at once (a 32 KB floor), and one big object always may run', async () => {
    const c = controlled();
    let t = 0;
    const { store } = await streamedSet(c.make, 12, () => t);
    c.arm();
    store.link.begin(1_000_000); t += 1000; store.link.received(10_000);
    store.link.end(990_000);
    expect(store.link.slow).toBe(true);
    for (let i = 0; i < 12; i++) void store.request('portal', 0x01000001 + i, FetchPriority.Prefetch);
    await settle();
    expect(c.started).toHaveLength(12); // tiny leaves: all fit the floor
    for (const h of [...c.started]) c.release(h);
    expect(store.link.room(0, 0, 10_000_000)).toBe(true);
    expect(store.link.room(1, 0, 10_000_000)).toBe(false);
  });
});

describe('LinkMeter', () => {
  it('a latency-bound trickle of small objects is not a slow link; a saturated slow one is; a fast window clears it', () => {
    let t = 0;
    const m = new LinkMeter(() => t);
    // 8 small objects (2 KB each) on a cold edge: 16 KB/s, but nothing is queued behind them.
    m.begin(16_000); t += 1000; m.received(16_000);
    expect(m.slow).toBe(false);
    // 120 KB/s with 2 MB in flight: saturated and slow.
    m.begin(2_000_000); t += 1000; m.received(120_000);
    expect(m.slow).toBe(true);
    expect(m.rate).toBe(120_000);
    // A stalled link (nothing at all for a second, bytes in flight) stays slow.
    t += 1000;
    expect(m.slow).toBe(true);
    t += 1000; m.received(2 * SLOW_LINK_BYTES_PER_S + 1);
    expect(m.slow).toBe(false);
  });
});

describe('bridge WsLiveness: a starved downlink with a live browser is not a dead socket', () => {
  it('a late pong no longer ends a session whose browser keeps sending; a silent one still ends', () => {
    const live = new WsLiveness();
    expect(live.tick()).toBe('ping');
    live.heard(); // the browser's 3 s flow keepalive arrived (the pong is stuck behind downlink data)
    expect(live.tick()).toBe('ping');
    live.heard();
    expect(live.tick()).toBe('ping');
    // Nothing at all for a whole interval: ended.
    expect(live.tick()).toBe('dead');
  });
});
