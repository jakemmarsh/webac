/**
 * PERF.warm-boot-slow-breakdown — a streamed set's boot report says where its
 * time went, and the set pointer (the one network request a warm boot awaits)
 * is retried and time-limited like every object.
 *
 * Evidence (production bridge, 2026-10-23 b17daa8d and 2026-10-27 4a42da0c):
 * `client_preworld outcome=boot_done stage=patch_download stream=[{"scope":"all",
 * "ms":22139,"worldCacheMs":982,"worldCached":true,"netBytes":0,
 * "cacheBytes":42028771,"cacheObjects":267}]` — 21 s inside openStreamingDats
 * with no DAT bytes from the network, and nothing to say which step.
 *
 * Drives the real DatStore / openStreamingDats over a fake content-addressed
 * bucket (real gzip, real hashes), the real BootWatch with a fake clock, the
 * real PreworldReporter and the bridge's real sanitizer and POST route.
 */
import { describe, expect, it } from 'vitest';
import { DatStore, POINTER_ATTEMPT_TIMEOUT_MS, fetchPointerRetried } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache, OpfsObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { openStreamingDats } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import { BOOT_WATCH_TICK_MS, type BootWatchEnv, startBootWatch } from '../packages/renderer/src/dat/streaming/BootWatch.js';
import { PreworldReporter, BOOT_STREAM_PHASE_KEYS, BOOT_SLOW_MS, type PreworldEvent, type PreworldScreen } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import {
  sanitizeClientPreworld, BOOT_STREAM_PHASE_KEYS as BRIDGE_PHASE_KEYS, CLIENT_PREWORLD_MAX_BODY,
} from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil.js';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server.js';
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
    world: pack([[0x06000200, 'world-texture']]),
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

/** A BootWatch env driven by hand: a clock, one interval, a document. */
function fakeWatchEnv() {
  const clock = { t: 0 };
  let tick: (() => void) | null = null;
  let cleared = false;
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_t: 'visibilitychange', l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: 'visibilitychange', l: () => void) => { listeners.delete(l); },
  };
  const env: BootWatchEnv = {
    now: () => clock.t,
    setInterval: (fn) => { tick = fn; return 7; },
    clearInterval: (id) => { if (id === 7) cleared = true; },
    doc,
  };
  return {
    env, clock, doc, listeners,
    get cleared() { return cleared; },
    /** The interval fires `late` ms after it was due. */
    fire(late = 0) { clock.t += BOOT_WATCH_TICK_MS + late; tick!(); },
    setVisibility(v: 'visible' | 'hidden') { doc.visibilityState = v; for (const l of listeners) l(); },
  };
}

describe('BootWatch: main-thread lag and hidden time while a set opens', () => {
  it('sums ticks that fired late while visible, ignores jitter, and counts hidden time without calling it lag', () => {
    const f = fakeWatchEnv();
    const w = startBootWatch(f.env);
    f.fire(2); // jitter
    f.fire(400); // a 400 ms synchronous task
    f.fire(1200); // a 1.2 s one
    f.setVisibility('hidden');
    f.fire(750); // a hidden tab's ticks come once a second: not lag
    f.fire(750);
    f.clock.t += 100;
    f.setVisibility('visible');
    f.fire(0);
    const r = w.stop();
    expect(r).toEqual({ lagMs: 1600, lagMaxMs: 1200, hiddenMs: (BOOT_WATCH_TICK_MS + 750) * 2 + 100 });
    expect(f.cleared).toBe(true);
    expect(f.listeners.size).toBe(0);
    f.clock.t += 5000;
    expect(w.stop()).toBe(r); // idempotent
  });

  it('a page hidden from the start and still hidden at stop counts the whole time hidden', () => {
    const f = fakeWatchEnv();
    f.doc.visibilityState = 'hidden';
    const w = startBootWatch(f.env);
    f.fire(750);
    f.clock.t += 3000;
    expect(w.stop()).toEqual({ lagMs: 0, lagMaxMs: 0, hiddenMs: BOOT_WATCH_TICK_MS + 750 + 3000 });
  });

  it('a task still blocking when the open ends counts too (its tick never fired)', () => {
    const f = fakeWatchEnv();
    const w = startBootWatch(f.env);
    f.clock.t += BOOT_WATCH_TICK_MS + 900;
    expect(w.stop()).toMatchObject({ lagMs: 900, lagMaxMs: 900 });
  });
});

describe('the set pointer is retried and time-limited (it had neither)', () => {
  it('a stalled attempt is aborted after the limit and the next one answers', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const got = await fetchPointerRetried(POINTER_URL, (_url, o) => {
      calls++;
      if (o?.signal) signals.push(o.signal);
      return calls === 1 ? new Promise(() => { /* never answers */ }) : Promise.resolve({ format: 1 });
    }, 3, 20);
    expect(got).toEqual({ raw: { format: 1 }, tries: 2, bytes: JSON.stringify({ format: 1 }).length });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(POINTER_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(5000); // a healthy cold-edge pointer is ≤ ~2 s
  });

  it('gives up after retries + 1 attempts with the last error', async () => {
    let calls = 0;
    await expect(fetchPointerRetried(POINTER_URL, async () => { calls++; throw new Error(`HTTP 503 #${calls}`); }, 2, 1000)).rejects.toThrow('HTTP 503 #3');
    expect(calls).toBe(3);
  });

  it('DatStore.open survives one dropped pointer request (it used to fail the boot) and reports the attempts', async () => {
    const set = makeSet();
    let calls = 0;
    const store = await DatStore.open({
      pointerUrl: POINTER_URL,
      fetchPointer: async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return JSON.parse(JSON.stringify(set.pointer)); },
      fetchObject: set.bucket.fetch,
      cache: new MemoryObjectCache(),
      packs: ['boot', 'local', 'skeleton'],
    });
    expect(store.isPackResident('skeleton')).toBe(true);
    expect(store.openTimings.pointerTries).toBe(2);
    expect(store.openTimings.pointerMs).toBeGreaterThanOrEqual(200); // the 250 ms backoff
    expect(store.openTimings.pointerBytes).toBe(JSON.stringify(set.pointer).length);
    expect(store.openTimings.packsMs).toBeGreaterThanOrEqual(store.openTimings.manifestMs);
  });
});

describe('openStreamingDats bootReport.phases', () => {
  const warmUp = async (set: ReturnType<typeof makeSet>, cache: MemoryObjectCache) => {
    const cold = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache, watchEnv: fakeWatchEnv().env });
    await cold.worldPacks;
    await new Promise((r) => setTimeout(r, 0)); // cache writes are fire-and-forget
    return cold;
  };

  it('a cold open: every object missed the cache and came from the network; every phase key is there', async () => {
    const set = makeSet();
    const cold = await openStreamingDats({ pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), fetchObject: set.bucket.fetch, cache: new MemoryObjectCache(), watchEnv: fakeWatchEnv().env });
    const p = cold.bootReport.phases;
    expect(Object.keys(p).sort()).toEqual([...BOOT_STREAM_PHASE_KEYS].sort());
    expect(p.pointerTries).toBe(1);
    expect(p.cacheMisses).toBeGreaterThanOrEqual(4); // manifest + boot + local + skeleton (+ the world packs, landing meanwhile)
    expect(p.retries).toBe(0);
    expect(p.failures).toBe(0);
    expect(p.rcvBytes).toBeGreaterThanOrEqual(cold.bootReport.netBytes);
    expect(cold.bootReport.worldCached).toBe(false);
    for (const v of Object.values(p)) expect(Number.isInteger(v) && v >= 0).toBe(true);
  });

  it('a warm open names the slow step: a slow cache read, a slow splash hook, a blocked main thread', async () => {
    const set = makeSet();
    const cache = new MemoryObjectCache();
    await warmUp(set, cache);
    // Warm: the boot pack's read takes 60 ms; the splash hook blocks the thread for 40 ms.
    const get = cache.get.bind(cache);
    cache.get = async (hash: string) => { if (hash === set.packs.boot.hash) await new Promise((r) => setTimeout(r, 60)); return get(hash); };
    const f = fakeWatchEnv();
    const warm = await openStreamingDats({
      pointerUrl: POINTER_URL, fetchPointer: pointerOf(set),
      fetchObject: async () => { throw new Error('network used on a warm profile'); },
      cache, watchEnv: f.env,
      onBootPacks: () => { const end = performance.now() + 40; while (performance.now() < end) { /* a synchronous splash build */ } f.fire(900); },
    });
    const p = warm.bootReport.phases;
    expect(warm.bootReport.worldCached).toBe(true);
    expect(warm.bootReport.netBytes).toBe(0);
    expect(p.cacheMisses).toBe(0);
    expect(p.retries).toBe(0);
    expect(p.rcvBytes).toBe(0);
    expect(p.cacheReadMaxMs).toBeGreaterThanOrEqual(50);
    expect(p.cacheReadMs).toBeGreaterThanOrEqual(p.cacheReadMaxMs);
    expect(p.packsMs).toBeGreaterThanOrEqual(50);
    expect(p.splashMs).toBeGreaterThanOrEqual(35);
    expect(p.lagMs).toBe(900);
    expect(p.lagMaxMs).toBe(900);
    expect(p.hiddenMs).toBe(0);
    expect(f.cleared).toBe(true);
    // The steps fit inside the whole.
    expect(p.pointerMs + p.packsMs + p.layoutMs + p.artMs + p.hasMs + warm.bootReport.worldCacheMs).toBeLessThanOrEqual(warm.bootReport.ms + 6);
  });

  it('a corrupt cache entry is a cache miss and a network fetch; a dropped request is a retry', async () => {
    const set = makeSet();
    const cache = new MemoryObjectCache();
    await warmUp(set, cache);
    cache.map.set(set.packs.local.hash, enc('not gzip'));
    let dropped = false;
    const warm = await openStreamingDats({
      pointerUrl: POINTER_URL, fetchPointer: pointerOf(set), cache, watchEnv: fakeWatchEnv().env,
      fetchObject: async (url) => { if (!dropped) { dropped = true; throw new TypeError('Failed to fetch'); } return set.bucket.fetch(url); },
    });
    expect(warm.bootReport.phases).toMatchObject({ cacheMisses: 1, retries: 1, failures: 0 });
    expect(warm.bootReport.netBytes).toBe(set.packs.local.gzSize);
  });

  it('the watch stops when open() fails (no interval left running)', async () => {
    const f = fakeWatchEnv();
    await expect(openStreamingDats({
      pointerUrl: POINTER_URL, fetchPointer: async () => ({ format: 99 }), cache: new MemoryObjectCache(), watchEnv: f.env,
    })).rejects.toThrow();
    expect(f.cleared).toBe(true);
  });

  it('OpfsObjectCache reports how long opening OPFS took (dirMs)', async () => {
    const clock = { t: 100 };
    const dir = { getFileHandle: async () => { throw new Error('NotFound'); } };
    const cache = OpfsObjectCache.create({
      getDirectory: async () => { clock.t += 3400; return { getDirectoryHandle: async () => dir } as unknown as FileSystemDirectoryHandle; },
      hasCreateWritable: true, startWriter: null, now: () => clock.t,
    });
    expect(cache.openMs).toBeNull();
    expect(await cache.get('00')).toBeNull();
    expect(cache.openMs).toBe(3400);
  });
});

describe('the phases reach the bridge log', () => {
  function harness() {
    const sent: PreworldEvent[] = [];
    const clock = { t: 1000 };
    const state: { screen: PreworldScreen } = { screen: 'boot' };
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null,
      screen: () => state.screen, now: () => clock.t, trace: 'feedc0de12345678',
      send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
    });
    const ticks: Array<() => void> = [];
    r.install({ addEventListener: () => undefined, setInterval: (f: () => void) => { ticks.push(f); return 1; } } as never,
      { visibilityState: 'visible', addEventListener: () => undefined } as never);
    const advance = (ms: number) => { for (let i = 0; i < ms; i += 1000) { clock.t += Math.min(1000, ms - i); ticks.forEach((f) => f()); } };
    return { r, sent, state, advance };
  }
  const phases = Object.fromEntries(BOOT_STREAM_PHASE_KEYS.map((k, i) => [k, i * 1000 + 0.4]));
  const report = { netBytes: 0, netObjects: 0, cacheBytes: 42_028_771, cacheObjects: 267, preWorldArtFiles: 80, ms: 22_139, worldCached: true, worldCacheMs: 982, phases };

  it('both lists name the same keys', () => {
    expect([...BRIDGE_PHASE_KEYS]).toEqual([...BOOT_STREAM_PHASE_KEYS]);
  });

  it('boot_done carries the phases, rounded; unknown keys and non-numbers never leave the page; the bridge keeps them whole', async () => {
    const h = harness();
    h.r.bootStage('patch_download');
    h.r.bootStream('all', { ...report, phases: { ...phases, url: 'https://x', lagMs: 'lots', hiddenMs: Number.NaN } });
    h.advance(BOOT_SLOW_MS);
    h.state.screen = 'server-select';
    h.advance(1000);
    const done = h.sent.find((e) => e.outcome === 'boot_done')!;
    const p = done.stream![0].phases!;
    expect(p).not.toHaveProperty('url');
    expect(p).not.toHaveProperty('lagMs');
    expect(p).not.toHaveProperty('hiddenMs');
    expect(p.pointerMs).toBe(0);
    expect(p.dirMs).toBe(3000);
    expect(sanitizeClientPreworld(done)).toEqual(done);
    // The bridge drops what a client should never send, keeping the entry.
    const ev = sanitizeClientPreworld({ ...done, stream: [{ ...done.stream![0], phases: { ...p, artMs: 1.5, secret: 5, packsMs: -1 } }] })!;
    expect(ev.stream![0].phases).not.toHaveProperty('artMs');
    expect(ev.stream![0].phases).not.toHaveProperty('secret');
    expect(ev.stream![0].phases).not.toHaveProperty('packsMs');
    expect(ev.stream![0].ms).toBe(22_139);
    expect(sanitizeClientPreworld({ ...done, stream: [{ ...done.stream![0], phases: 'slow' }] })!.stream![0]).not.toHaveProperty('phases');

    const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { lines.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', body: JSON.stringify(done), headers: { 'content-type': 'text/plain' } });
      expect(res.status).toBe(204);
      const line = lines.find((l) => l[1] === 'client_preworld')!;
      expect(line[2]).toMatchObject({ outcome: 'boot_done', stream: [{ scope: 'all', ms: 22_139, phases: { dirMs: 3000, rcvBytes: 17_000 } }] });
    } finally {
      await bridge.shutdown();
    }
  });

  it('two sets with every phase at its bound still fit the route body', () => {
    const h = harness();
    const big = Object.fromEntries(BOOT_STREAM_PHASE_KEYS.map((k) => [k, 1e12]));
    h.r.bootStream('interface', { ...report, netBytes: 1e12, cacheBytes: 1e12, cacheObjects: 1e12, ms: 1e12, worldCacheMs: 1e12, phases: big });
    h.r.bootStream('world', { ...report, netBytes: 1e12, cacheBytes: 1e12, cacheObjects: 1e12, ms: 1e12, worldCacheMs: 1e12, phases: big });
    h.r.bootCache('partial');
    h.r.capabilityIssues(['webgl2', 'websocket', 'memory', 'pointer', 'software_gpu']);
    h.advance(BOOT_SLOW_MS);
    h.state.screen = 'server-select';
    h.advance(1000);
    const done = h.sent.find((e) => e.outcome === 'boot_done')!;
    expect(done.stream).toHaveLength(2);
    expect(new TextEncoder().encode(JSON.stringify(done)).byteLength).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
  });
});
