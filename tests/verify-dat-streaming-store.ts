/**
 * RELEASE.dat-streaming — DatStore over the published set format: pointer,
 * binary manifest, packs, landblock bundles and per-file leaves, through a
 * fake content-addressed bucket (real gzip, real hashes). The DatDatabases it
 * hands out are what every renderer consumer reads synchronously.
 */
import { describe, expect, it } from 'vitest';
import { parsePack, parseSetManifest, parseSetPointer, iterationRecordBytes, datHeaderFor, EOL_DAT_HEADERS } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { datMissEpoch } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { DatStore, FetchPriority, fileKey, gunzip } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack, type Obj } from './_harness/datSet.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);
const BASE = 'https://dats.test';
const EOL = { portal: 2072, cell: 982, highres: 497, local: 994 };

function makeSet(opts: { dats?: unknown; iterations?: Record<string, number> } = {}) {
  const bucket = new FakeBucket();
  const pack = (files: Array<[number, string]>) => {
    const bytes = buildPack(files.map(([id, s]) => ({ id, data: enc(s) })));
    return { ...bucket.put(bytes), files: files.length };
  };
  const packs = {
    boot: pack([[0x06000100, 'boot-texture'], [0x13000000, 'region']]),
    local: pack([[0x23000001, 'strings']]),
    skeleton: pack([[0x02000001, 'setup'], [0x08000001, 'surface'], [0x13000000, 'region']]),
    world: pack([[0x06000200, 'world-texture']]),
    terrain: pack([[0xA9B4FFFF, 'land-a9b4'], [0xA9B5FFFF, 'land-a9b5']]),
  };
  const leafGfx = { id: 0x01000001, ...bucket.put(enc('gfxobj-1')) };
  const leafTex = { id: 0x06000002, ...bucket.put(enc('texture-2')) };
  const leafHi = { id: 0x06000003, ...bucket.put(enc('hires-3')) };
  const bundle = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: enc('info') }, { id: 0xA9B40100, data: enc('cell-100') }])) };
  const role = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5 } as const;
  const manifestBytes = buildManifest({
    leaves: { portal: [leafGfx, leafTex], highres: [leafHi] },
    packs: (Object.entries(packs) as Array<[keyof typeof role, Obj & { files: number }]>).map(([r, p]) => ({ role: role[r], ...p })),
    bundles: [bundle],
  });
  const manifest = bucket.put(manifestBytes);
  const pointer = {
    format: 1, set: 'test-set', iterations: opts.iterations ?? EOL,
    manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
    packs: Object.fromEntries(Object.entries(packs).map(([r, p]) => [r, { key: `v1/o/${p.hash}`, size: p.size, gzSize: p.gzSize, files: p.files }])),
    ...(opts.dats ? { dats: opts.dats } : {}),
  };
  return { bucket, pointer, manifestBytes, leafGfx, leafTex, packs, bundle };
}

async function openSet(set: ReturnType<typeof makeSet>, cache = new MemoryObjectCache()) {
  return DatStore.open({
    pointerUrl: `${BASE}/v1/sets/test-set.json`,
    fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
    fetchObject: set.bucket.fetch,
    cache,
  });
}

describe('DatSetFormat', () => {
  it('parses the manifest sections the publish tool writes', () => {
    const set = makeSet();
    const m = parseSetManifest(set.manifestBytes);
    expect(m.leaves.portal.get(0x01000001)?.hash).toBe(set.leafGfx.hash);
    expect(m.leaves.highres.size).toBe(1);
    expect(m.packs.get('terrain')?.files).toBe(2);
    expect(m.bundles.has(0xA9B4)).toBe(true);
  });

  it('parses a pack index into views of each file', () => {
    const p = parsePack(buildPack([{ id: 0x02000002, data: enc('bb') }, { id: 0x02000001, data: enc('a') }]));
    expect(p.ids).toEqual([0x02000001, 0x02000002]);
    expect(new TextDecoder().decode(p.files.get(0x02000002))).toBe('bb');
  });

  it('rejects malformed input instead of misreading it', () => {
    expect(() => parseSetManifest(enc('NOPE00000000'))).toThrow(/magic/);
    expect(() => parsePack(enc('ACPK\x05\x00\x00\x00'))).toThrow(/truncated/);
    expect(() => parseSetPointer({ format: 2, set: 'x' })).toThrow(/format/);
  });

  it('synthesizes the Iteration record byte-for-byte (EoL portal: 18080000 e8f7ffff 01000000)', () => {
    expect(Buffer.from(iterationRecordBytes(2072)).toString('hex')).toBe('18080000e8f7ffff01000000');
  });

  it('takes DAT header fields from the pointer, falling back to the measured EoL headers only for the EoL set', () => {
    const eol = parseSetPointer(makeSet().pointer);
    expect(datHeaderFor(eol, 'portal')).toEqual(EOL_DAT_HEADERS.portal);
    const own = parseSetPointer(makeSet({ dats: { portal: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0x25000001 } } }).pointer);
    expect(datHeaderFor(own, 'portal').masterMapId).toBe(0x25000001);
    const other = parseSetPointer(makeSet({ iterations: { portal: 1, cell: 1, local: 1, highres: 0 } }).pointer);
    expect(datHeaderFor(other, 'portal').masterMapId).toBe(0);
  });
});

describe('DatStore', () => {
  it('opens pointer → manifest + packs, and serves pack files synchronously', async () => {
    const set = makeSet();
    const store = await openSet(set);
    const portal = store.db('portal');
    expect(dec(portal.getFileData(0x06000100))).toBe('boot-texture');
    expect(dec(store.db('local').getFileData(0x23000001))).toBe('strings');
    expect(dec(store.db('cell').getFileData(0xA9B5FFFF))).toBe('land-a9b5');
    // The Iteration record + header fields the DDD interrogation and DidMappers read.
    expect(portal.totalIterations).toBe(2072);
    expect(store.db('cell').totalIterations).toBe(982);
    expect(portal.masterMapId).toBe(0x25000000);
    // The listing is the full set: pack ids + leaves (resident or not).
    expect(portal.listFileIds(0x06).sort()).toEqual([0x06000002, 0x06000100, 0x06000200]);
    expect(portal.hasFile(0x01000001)).toBe(true);
    expect(portal.getFileEntry(0x01000001)?.fileSize).toBe(enc('gfxobj-1').length);
  });

  it('a read of an existing, non-resident file misses: null, epoch + scope recorded, fetched once', async () => {
    const set = makeSet();
    const store = await openSet(set);
    const before = set.bucket.requests.length;
    const epoch = datMissEpoch();
    const { result, scope } = store.scoped(() => store.db('portal').getFileData(0x01000001));
    expect(result).toBeNull();
    expect(datMissEpoch()).toBe(epoch + 1);
    expect([...scope.keys]).toEqual([fileKey('portal', 0x01000001)]);
    expect(store.stats.misses).toBe(1);
    // A second ensure while the miss's own fetch is in flight coalesces.
    await Promise.all([store.ensure(scope.keys), store.ensure(scope.keys)]);
    expect(set.bucket.requests.length - before).toBe(1);
    expect(dec(store.db('portal').getFileData(0x01000001))).toBe('gfxobj-1');
  });

  it('a file the set does not have is plain null — no miss, no fetch', async () => {
    const set = makeSet();
    const store = await openSet(set);
    const n = set.bucket.requests.length;
    expect(store.db('portal').getFileData(0x01FFFFFF)).toBeNull();
    expect(store.db('cell').getFileData(0x0101FFFF)).toBeNull(); // terrain pack lists every CellLandblock
    expect(store.stats.misses).toBe(0);
    expect(set.bucket.requests.length).toBe(n);
  });

  it('cell files exist "maybe" until their landblock bundle is resident, then exactly', async () => {
    const set = makeSet();
    const store = await openSet(set);
    const cell = store.db('cell');
    expect(cell.hasFile(0xA9B40105)).toBe(true); // unknown until the bundle says
    expect(store.isBundleResident(0xA9B4)).toBe(false);
    await store.ensureBundle(0xA9B4);
    expect(dec(cell.getFileData(0xA9B40100))).toBe('cell-100');
    expect(cell.hasFile(0xA9B40105)).toBe(false);
    expect(store.bundleIds(0xA9B4)).toEqual([0xA9B40100, 0xA9B4FFFE]);
    // A landblock with no bundle has no cells at all.
    expect(cell.hasFile(0x12340100)).toBe(false);
    expect(store.isBundleResident(0x1234)).toBe(true);
  });

  it('a warm object cache serves everything with no network objects (second session)', async () => {
    const set = makeSet();
    const cache = new MemoryObjectCache();
    const cold = await openSet(set, cache);
    await cold.request('portal', 0x01000001);
    await new Promise((r) => setTimeout(r, 0)); // cache writes are fire-and-forget
    expect(cold.stats.netObjects).toBe(7); // manifest + 5 packs + the leaf
    const warm = await openSet(set, cache);
    await warm.request('portal', 0x01000001, FetchPriority.Critical);
    expect(warm.stats.netObjects).toBe(0);
    expect(warm.stats.cacheObjects).toBe(7);
    expect(dec(warm.db('portal').getFileData(0x01000001))).toBe('gfxobj-1');
  });

  it('verifies every object: a corrupt cache entry is refetched, a corrupt download fails after retries', async () => {
    const set = makeSet();
    const cache = new MemoryObjectCache();
    cache.map.set(set.leafGfx.hash, new Uint8Array(set.bucket.objects.get(set.leafTex.hash)!)); // wrong content
    const store = await openSet(set, cache);
    await store.request('portal', 0x01000001);
    expect(dec(store.db('portal').getFileData(0x01000001))).toBe('gfxobj-1');

    const errors: string[] = [];
    const bad = DatStore.fromParts(BASE, store.pointer, store.manifest, {
      fetchObject: async () => set.bucket.objects.get(set.leafGfx.hash)!, // always the gfx bytes
      retries: 1, onError: (d) => errors.push(d),
    });
    await expect(bad.request('portal', 0x06000002)).rejects.toThrow();
    expect(bad.stats.failures).toBe(1);
    expect(errors.length).toBe(1);
  });

  it('retries a failed fetch and succeeds', async () => {
    const set = makeSet();
    const store = await openSet(set);
    set.bucket.failing.set(set.leafTex.hash, 1);
    await expect(store.request('portal', 0x06000002)).resolves.toBe(true);
    expect(store.stats.failures).toBe(0);
  });

  it('inflates gzip with the platform DecompressionStream', async () => {
    const set = makeSet();
    const out = await gunzip(set.bucket.objects.get(set.leafGfx.hash)!);
    expect(new TextDecoder().decode(out)).toBe('gfxobj-1');
  });
});

describe('DatStore — packs still downloading (RELEASE.streaming-charselect-weight)', () => {
  async function openFirst(set: ReturnType<typeof makeSet>, packs: Array<'boot' | 'local' | 'skeleton'>) {
    return DatStore.open({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject: set.bucket.fetch,
      cache: new MemoryObjectCache(),
      packs,
    });
  }

  it('a skeleton-type file read before the skeleton pack lands is a miss (never "absent"), resolved by the pack', async () => {
    const set = makeSet();
    const store = await openFirst(set, ['boot', 'local']);
    const portal = store.db('portal');
    const { result, scope } = store.scoped(() => portal.getFileData(0x02000001));
    expect(result).toBeNull();
    expect(scope.missed).toBe(true);
    expect(portal.hasFile(0x02000001)).toBe(true);
    expect(portal.hasFile(0x02FFFFFF)).toBe(true); // maybe, until the pack says
    expect(store.stats.unresolvedMisses).toBe(1);
    // The miss's own request waits for the pack instead of reporting "absent".
    await expect(store.request('portal', 0x02000001, FetchPriority.Critical)).resolves.toBe(true);
    expect(store.isPackResident('skeleton')).toBe(true);
    expect(store.stats.unresolvedMisses).toBe(0);
    expect(dec(portal.getFileData(0x02000001))).toBe('setup');
    expect(portal.hasFile(0x02FFFFFF)).toBe(false);
    // Leaf types were exact all along: a GfxObj the set lacks is plain null.
    expect(store.db('portal').getFileData(0x01FFFFFF)).toBeNull();
  });

  it('a CellLandblock read before the terrain pack lands misses and resolves when the pack does', async () => {
    const set = makeSet();
    const store = await openFirst(set, ['boot', 'local', 'skeleton']);
    const cell = store.db('cell');
    const resolved: number[] = [];
    store.onResident((k) => resolved.push(k));
    const { result, scope } = store.scoped(() => cell.getFileData(0xA9B4FFFF));
    expect(result).toBeNull();
    expect([...scope.keys]).toEqual([fileKey('cell', 0xA9B4FFFF)]);
    await store.ensure(scope.keys, FetchPriority.Critical);
    expect(dec(cell.getFileData(0xA9B4FFFF))).toBe('land-a9b4');
    expect(resolved).toContain(fileKey('cell', 0xA9B4FFFF));
    expect(store.stats.unresolvedMisses).toBe(0);
    expect(cell.hasFile(0x0101FFFF)).toBe(false); // exact once the pack is resident
  });
});

describe('DatStore — resident LRU (RELEASE.streaming-memory-and-progress)', () => {
  /** A set of 100-byte leaves + one bundle, a 250-byte cap, a 1 s minimum age and a hand clock. */
  function lruSet() {
    const bucket = new FakeBucket();
    const leaf = (i: number) => ({ id: 0x06001000 + i, ...bucket.put(new Uint8Array(100).fill(i)) });
    const leaves = [1, 2, 3, 4, 5].map(leaf);
    const bundle = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: new Uint8Array(150) }, { id: 0xA9B40100, data: new Uint8Array(50) }])) };
    const skeleton = bucket.put(buildPack([{ id: 0x02000001, data: enc('setup') }]));
    const manifest = parseSetManifest(buildManifest({ leaves: { portal: leaves }, bundles: [bundle] }));
    const pointer = parseSetPointer({
      format: 1, set: 'lru', iterations: EOL,
      manifest: { key: 'v1/o/0000000000000000', size: 0, gzSize: 0 },
      packs: { skeleton: { key: `v1/o/${skeleton.hash}`, size: skeleton.size, gzSize: skeleton.gzSize, files: 1 } },
    });
    let t = 0;
    const store = DatStore.fromParts(BASE, pointer, manifest, {
      fetchObject: bucket.fetch, residentCapBytes: 250, minResidentAgeMs: 1000, now: () => t,
    });
    return { store, bucket, leaves, setTime: (v: number) => { t = v; } };
  }

  it('evicts least-recently-used leaves past the cap, never ones used within the minimum age, and reports bytes', async () => {
    const { store, leaves, setTime, bucket } = lruSet();
    let evictSignals = 0;
    store.onEvict(() => { evictSignals++; });
    for (const l of leaves.slice(0, 3)) await store.request('portal', l.id);
    // 300 B > 250 B, but all three landed "now": the cap is soft until they age.
    expect(store.stats.evictableBytes).toBe(300);
    expect(store.stats.evictions).toBe(0);

    setTime(2000);
    expect(store.db('portal').getFileData(leaves[2].id)).not.toBeNull(); // a read is a use
    await store.request('portal', leaves[3].id);
    // Over the cap: trimmed to ≤ 85 % of it, oldest first (leaves 1 and 2); 3 (just read) and 4 (just landed) stay.
    expect(store.isResident('portal', leaves[0].id)).toBe(false);
    expect(store.isResident('portal', leaves[1].id)).toBe(false);
    expect(store.isResident('portal', leaves[2].id)).toBe(true);
    expect(store.isResident('portal', leaves[3].id)).toBe(true);
    expect(store.stats).toMatchObject({ evictions: 2, evictedBytes: 200, evictableBytes: 200, residentBytes: 200, packBytes: 0 });
    expect(evictSignals).toBe(1);

    // An evicted file is still in the set: the next read is an ordinary miss, and it comes back.
    expect(store.db('portal').hasFile(leaves[0].id)).toBe(true);
    const n = bucket.requests.length;
    const { result, scope } = store.scoped(() => store.db('portal').getFileData(leaves[0].id));
    expect(result).toBeNull();
    await store.ensure(scope.keys);
    expect(new Uint8Array(store.db('portal').getFileData(leaves[0].id)!)[0]).toBe(1);
    expect(bucket.requests.length).toBe(n + 1);
  });

  it('a bundle is one unit: evicting it drops all its cell files and the closure readiness built on it', async () => {
    const { store, leaves, setTime } = lruSet();
    const { DatClosure } = await import('../packages/renderer/src/dat/streaming/DatClosure.js');
    const closure = new DatClosure(store);
    await store.ensurePack('skeleton');
    await store.ensureBundle(0xA9B4);
    await closure.ensure([fileKey('portal', leaves[4].id)]);
    expect(closure.isClosed(fileKey('portal', leaves[4].id))).toBe(true);
    expect(store.stats.evictableBytes).toBe(store.stats.residentBytes - store.stats.packBytes);
    setTime(5000);
    await store.request('portal', leaves[0].id);
    await store.request('portal', leaves[1].id);
    // The bundle and leaf 5 were older than the minimum age and least recently used.
    expect(store.isBundleResident(0xA9B4)).toBe(false);
    expect(store.isResident('cell', 0xA9B40100)).toBe(false);
    expect(store.bundleIds(0xA9B4)).toEqual([]);
    expect(store.db('cell').hasFile(0xA9B40100)).toBe(true); // maybe again, until the bundle is back
    expect(closure.isClosed(fileKey('portal', leaves[4].id))).toBe(false);
    // Pack files are never evicted.
    expect(store.isResident('portal', 0x02000001)).toBe(true);
    await store.ensureBundle(0xA9B4);
    expect(store.db('cell').getFileData(0xA9B40100)?.byteLength).toBe(50);
  });

  it('a leaf fetched before its pack landed hands over to the pack copy (resident for good, out of the LRU)', async () => {
    const set = makeSet();
    const store = await DatStore.open({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject: set.bucket.fetch,
      packs: ['boot', 'local', 'skeleton', 'terrain'],
    });
    await store.request('portal', 0x06000002);
    expect(store.stats.evictableBytes).toBe(enc('texture-2').length);
    store.addPackBytes('world', buildPack([{ id: 0x06000002, data: enc('texture-2') }]));
    expect(store.stats.evictableBytes).toBe(0);
    expect(dec(store.db('portal').getFileData(0x06000002))).toBe('texture-2');
  });
});

describe('openStreamingDats — char select first, world in the background (RELEASE.streaming-charselect-weight)', () => {
  it('resolves on manifest + boot + local + skeleton while the world and terrain packs are still downloading', async () => {
    const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    const set = makeSet();
    const held = new Set([set.packs.world.hash, set.packs.terrain.hash]);
    const waiting: Array<() => void> = [];
    const priorities: FetchPriority[] = [];
    const fetchObject = async (url: string, o: { priority: FetchPriority }) => {
      priorities.push(o.priority);
      if (held.has(url.slice(url.lastIndexOf('/') + 1))) await new Promise<void>((r) => waiting.push(r));
      return set.bucket.fetch(url);
    };
    const progress: Array<[number, number]> = [];
    const sd = await openStreamingDats({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject,
      cache: new MemoryObjectCache(),
      onProgress: (d, t) => progress.push([d, t]),
    });
    // The char-select set is resident; the world packs are requested and held.
    expect(dec(sd.portal.getFileData(0x06000100))).toBe('boot-texture');
    expect(dec(sd.portal.getFileData(0x02000001))).toBe('setup');
    expect(sd.store.isPackResident('world')).toBe(false);
    expect(sd.worldPacksResident()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(waiting.length).toBe(2);
    // The patch meter ran over the char-select set only, and ended full.
    const first = set.pointer.manifest.gzSize + set.packs.boot.gzSize + set.packs.local.gzSize + set.packs.skeleton.gzSize;
    expect(progress[progress.length - 1]).toEqual([first, first]);
    expect(sd.bootReport.netObjects).toBe(4);
    // A world read now is a miss that lands with the pack.
    const { scope } = sd.store.scoped(() => sd.cell.getFileData(0xA9B4FFFF));
    expect(scope.missed).toBe(true);
    for (const r of waiting) r();
    await sd.worldPacks;
    expect(sd.worldPacksResident()).toBe(true);
    expect(dec(sd.portal.getFileData(0x06000200))).toBe('world-texture');
    expect(dec(sd.cell.getFileData(0xA9B4FFFF))).toBe('land-a9b4');
    expect(sd.store.stats.unresolvedMisses).toBe(0);
    // The UI art follows the world packs and is what main() awaits with them; nothing streams at Background.
    await expect(sd.prefetchUiArt()).resolves.toBeUndefined();
    await sd.uiArtReady;
    expect(priorities).not.toContain(FetchPriority.Background);
  });
});

describe('openStreamingDats — the splash does not wait for the skeleton pack', () => {
  it('fires onBootPacks once boot + local are resident, while the skeleton is still downloading', async () => {
    const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    const set = makeSet();
    const skeletonHash = set.packs.skeleton.hash;
    let releaseSkeleton!: () => void;
    const skeletonHeld = new Promise<void>((r) => { releaseSkeleton = r; });
    const fetchObject = async (url: string) => {
      if (url.endsWith(skeletonHash)) await skeletonHeld;
      return set.bucket.fetch(url);
    };
    let splashDrewWith: string | null = null;
    let opened = false;
    const opening = openStreamingDats({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject,
      cache: new MemoryObjectCache(),
      onBootPacks: (store) => { splashDrewWith = dec(store.db('portal').getFileData(0x06000100)); },
    }).then((sd) => { opened = true; return sd; });
    for (let i = 0; i < 20 && splashDrewWith === null; i++) await new Promise((r) => setTimeout(r, 0));
    expect(splashDrewWith).toBe('boot-texture');
    expect(opened).toBe(false); // the character screen still waits for the skeleton
    releaseSkeleton();
    const sd = await opening;
    expect(dec(sd.portal.getFileData(0x02000001))).toBe('setup');
    await sd.worldPacks;
  });
});

describe('DatStore — priority promotion (the login-gate regression, 2026-10-05)', () => {
  it('a critical request joining a queued background load of the same object jumps the queue', async () => {
    const set = makeSet();
    const store = await openSet(set);
    // One network slot, held by a blocker, so everything else queues.
    const order: string[] = [];
    const gate = { release: () => {} };
    const slow = DatStore.fromParts(BASE, store.pointer, store.manifest, {
      maxConcurrent: 1,
      fetchObject: async (url) => {
        const h = url.slice(url.lastIndexOf('/') + 1);
        order.push(h);
        if (order.length === 1) await new Promise<void>((r) => { gate.release = r; });
        return set.bucket.fetch(url);
      },
    });
    const blocker = slow.request('portal', 0x06000002, FetchPriority.Critical); // takes the slot
    await new Promise((r) => setTimeout(r, 0));
    const bg = slow.request('portal', 0x01000001, FetchPriority.Background); // queued at Background
    const pf = slow.ensureBundle(0xA9B4, FetchPriority.Prefetch); // queued at Prefetch
    await new Promise((r) => setTimeout(r, 0));
    // The gate wants the background object now.
    const crit = slow.request('portal', 0x01000001, FetchPriority.Critical);
    gate.release();
    await Promise.all([blocker, bg, pf, crit]);
    expect(order).toEqual([set.leafTex.hash, set.leafGfx.hash, set.bundle.hash]);
  });
});

describe('openStreamingDats — a warm profile loads the world before char select (warm login-gate regression, 2026-10-05)', () => {
  it('world packs already in the object cache: open() awaits them and the UI art, so main() builds the world up front', async () => {
    const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    const set = makeSet();
    const cache = new MemoryObjectCache();
    const open = (fetchObject: (url: string) => Promise<Uint8Array>) => openStreamingDats({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject,
      cache,
    });
    // Cold: resolves without the world packs (they are held), which then land in the cache.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const worldHashes = new Set([set.packs.world.hash, set.packs.terrain.hash]);
    const cold = await open(async (url) => {
      if (worldHashes.has(url.slice(url.lastIndexOf('/') + 1))) await held;
      return set.bucket.fetch(url);
    });
    expect(cold.bootReport.worldCached).toBe(false);
    expect(cold.worldPacksResident()).toBe(false);
    release();
    await cold.worldPacks;
    await new Promise((r) => setTimeout(r, 0)); // cache writes are fire-and-forget

    // Warm: everything from the cache, the world included, before open() resolves; no network.
    const warm = await open(async () => { throw new Error('network used on a warm profile'); });
    expect(warm.bootReport.worldCached).toBe(true);
    expect(warm.worldPacksResident()).toBe(true);
    expect(warm.store.stats.netObjects).toBe(0);
    expect(dec(warm.portal.getFileData(0x06000200))).toBe('world-texture');
    expect(dec(warm.cell.getFileData(0xA9B4FFFF))).toBe('land-a9b4');
  });
});

describe('openStreamingDats — an interface-only set (AC1999 under the streamed end-of-retail interface, 2026-10-06)', () => {
  it('never fetches the set\'s terrain pack (the 1999 world reads its own DATs); the world pack and UI art still load', async () => {
    const { openStreamingDats, backgroundPacks } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    expect(backgroundPacks('all')).toEqual(['world', 'terrain']);
    expect(backgroundPacks('interface')).toEqual(['world']);
    const set = makeSet();
    const sd = await openStreamingDats({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject: set.bucket.fetch,
      cache: new MemoryObjectCache(),
      scope: 'interface',
    });
    await sd.worldPacks;
    await sd.uiArtReady;
    expect(sd.worldPacksResident()).toBe(true);
    expect(dec(sd.portal.getFileData(0x06000200))).toBe('world-texture');
    expect(dec(sd.local.getFileData(0x23000001))).toBe('strings');
    expect(sd.store.isPackResident('terrain')).toBe(false);
    expect(set.bucket.requests).not.toContain(set.packs.terrain.hash);
    expect(set.bucket.requests).not.toContain(set.bundle.hash);
  });

  it('a world-only set (scope world) serves no interface: no pre-world or layout art roots', async () => {
    const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    const set = makeSet();
    const sd = await openStreamingDats({
      pointerUrl: `${BASE}/v1/sets/test-set.json`,
      fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
      fetchObject: set.bucket.fetch,
      cache: new MemoryObjectCache(),
      scope: 'world',
    });
    expect(sd.uiArtRoots()).toEqual([]);
    expect(sd.bootReport.preWorldArtFiles).toBe(0);
    await sd.worldPacks;
    expect(sd.store.isPackResident('terrain')).toBe(true);
    expect(dec(sd.cell.getFileData(0xA9B4FFFF))).toBe('land-a9b4');
  });
});
