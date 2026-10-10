/**
 * RELEASE.streaming-area-packs — a cold portal-space gate costs a request or
 * two per destination instead of a dependency chain of hundreds of single
 * leaves: the area index ("ACAI") names one pack of leaves per tile of
 * landblocks plus a common pack, DatClosure.ensureLandblock fetches the
 * tile's pack alongside the bundle, and a set without area packs (or a
 * failed one) streams leaf by leaf as before. Real DatStore over a fake bucket.
 */
import { describe, expect, it } from 'vitest';
import {
  type ObjectRef, areaTileOf, buildAreaIndex, parseAreaIndex, parseSetPointer,
} from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatClosure } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { DatStore, FetchPriority, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';

const enc = (s: string) => new TextEncoder().encode(s);
const ref = (o: { hash: string; size: number; gzSize: number }): ObjectRef => ({ hash: o.hash, size: o.size, gzSize: o.gzSize });

describe('area index format', () => {
  it('round-trips the tile size, the common pack and every tile', () => {
    const common = { hash: '0102030405060708', size: 100, gzSize: 50, files: 7 };
    const tiles = [{ tile: 0x2a2d, ref: { hash: 'a1a2a3a4a5a6a7a8', size: 1234, gzSize: 600 } }, { tile: 0x0001, ref: { hash: 'ffeeddccbbaa9988', size: 9, gzSize: 8 } }];
    const idx = parseAreaIndex(buildAreaIndex(4, common, tiles));
    expect(idx.tileSize).toBe(4);
    expect(idx.common).toEqual(common);
    expect(idx.areas.get(0x2a2d)).toEqual(tiles[0].ref);
    expect(idx.areas.get(0x0001)).toEqual(tiles[1].ref);
    expect(parseAreaIndex(buildAreaIndex(4, null, [])).common).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(() => parseAreaIndex(enc('nope'))).toThrow(/magic/);
    const bad = buildAreaIndex(4, null, [{ tile: 1, ref: { hash: '0000000000000001', size: 1, gzSize: 1 } }]);
    expect(() => parseAreaIndex(bad.subarray(0, bad.length - 4))).toThrow(/truncated/);
    const zeroTile = buildAreaIndex(4, null, []);
    new DataView(zeroTile.buffer).setUint32(8, 0, true);
    expect(() => parseAreaIndex(zeroTile)).toThrow(/tile size/);
  });

  it('a landblock maps to its tile: (x / size) << 8 | (y / size)', () => {
    expect(areaTileOf(0xA9B4, 4)).toBe((0x2A << 8) | 0x2D);
    expect(areaTileOf(0xA9B40019, 4)).toBe(areaTileOf(0xABB7, 4)); // a cell id, and the tile's far corner
    expect(areaTileOf(0xACB4, 4)).not.toBe(areaTileOf(0xABB4, 4));
    expect(areaTileOf(0xA9B4, 1)).toBe(0xA9B4);
  });

  it('the pointer\'s areas key is optional, and parsed when present', () => {
    const base = { format: 1, set: 's', iterations: {}, manifest: { key: 'v1/o/0011223344556677', size: 1, gzSize: 1 }, packs: {} };
    expect(parseSetPointer(base).areas).toBeUndefined();
    expect(parseSetPointer({ ...base, areas: { key: 'v1/o/8899aabbccddeeff', size: 10, gzSize: 5 } }).areas).toEqual({ hash: '8899aabbccddeeff', size: 10, gzSize: 5 });
  });
});

/**
 * A set where landblock 0xA9B4's tile has an area pack with leaves 0x01000001
 * and 0x06000001, and the common pack carries 0x06000002. Every leaf is also
 * an object of its own (the published layout keeps them).
 */
async function areaSet(opts: { withAreas?: boolean; failArea?: boolean } = {}) {
  const bucket = new FakeBucket();
  const terrain = bucket.put(buildPack([{ id: 0xA9B4FFFF, data: enc('land') }, { id: 0xA9B5FFFF, data: enc('land') }]));
  const bundle = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: enc('info') }, { id: 0xA9B40100, data: enc('cell') }])) };
  const leafData = new Map([[0x01000001, enc('gfx-a')], [0x06000001, enc('tex-a')], [0x06000002, enc('tex-common')]]);
  const leaves = [...leafData].map(([id, data]) => ({ id, ...bucket.put(data) }));
  const area = bucket.put(buildPack([{ id: 0x01000001, data: leafData.get(0x01000001)! }, { id: 0x06000001, data: leafData.get(0x06000001)! }]));
  const common = bucket.put(buildPack([{ id: 0x06000002, data: leafData.get(0x06000002)! }]));
  const index = bucket.put(buildAreaIndex(4, { ...ref(common), files: 1 }, [{ tile: areaTileOf(0xA9B4, 4), ref: ref(area) }]));
  if (opts.failArea) bucket.failing.set(area.hash, 99);
  const manifest = bucket.put(buildManifest({ leaves: { portal: leaves }, packs: [{ role: 4, files: 2, ...terrain }], bundles: [bundle] }));
  const pointer = {
    format: 1, set: 's', iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
    manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize },
    packs: { terrain: { key: `v1/o/${terrain.hash}`, size: terrain.size, gzSize: terrain.gzSize, files: 2 } },
    ...(opts.withAreas === false ? {} : { areas: { key: `v1/o/${index.hash}`, size: index.size, gzSize: index.gzSize } }),
  };
  const errors: string[] = [];
  const store = await DatStore.open({
    pointerUrl: 'https://d.test/v1/sets/s.json', fetchPointer: async () => pointer, fetchObject: bucket.fetch,
    cache: new MemoryObjectCache(), packs: ['terrain'], retries: 0, onError: (d) => errors.push(d),
  });
  bucket.requests = [];
  const leafHash = (id: number) => leaves.find((l) => l.id === id)!.hash;
  return { bucket, store, closure: new DatClosure(store), area, common, index, bundle, leafHash, errors };
}

describe('DatStore area packs', () => {
  it('a landblock\'s closure fetches the bundle and its tile\'s area pack: the leaves are resident without one request each', async () => {
    const { bucket, store, closure, area, index, bundle, leafHash } = await areaSet();
    await closure.ensureLandblock(0xA9B4, FetchPriority.Critical);
    expect(new Set(bucket.requests)).toEqual(new Set([index.hash, area.hash, bundle.hash]));
    expect(store.isAreaResident(0xA9B4)).toBe(true);
    expect(store.isResident('portal', 0x01000001)).toBe(true);
    expect(store.isResident('portal', 0x06000001)).toBe(true);
    expect(new TextDecoder().decode(store.db('portal').getFileData(0x06000001)!)).toBe('tex-a');
    // A later request for one of them is served from memory.
    await store.ensure([fileKey('portal', 0x06000001)], FetchPriority.Critical);
    expect(bucket.requests).not.toContain(leafHash(0x06000001));
    // The common pack's leaf is not in the area pack.
    expect(store.isResident('portal', 0x06000002)).toBe(false);
  });

  it('a second landblock in the same tile reuses the tile\'s pack; one in another tile without a pack fetches nothing more', async () => {
    const { bucket, store, area } = await areaSet();
    await Promise.all([store.ensureArea(0xA9B4), store.ensureArea(0xA9B5)]);
    expect(bucket.requests.filter((h) => h === area.hash).length).toBe(1);
    const before = bucket.requests.length;
    await store.ensureArea(0xA9B5);
    await store.ensureArea(0x1010); // no area pack for that tile
    expect(bucket.requests.length).toBe(before);
    expect(store.isAreaResident(0x1010)).toBe(true);
  });

  it('the common pack loads in the background and stays resident (not in the LRU)', async () => {
    const { bucket, store, common } = await areaSet();
    await store.ensureCommonPack();
    expect(bucket.requests).toContain(common.hash);
    expect(store.isResident('portal', 0x06000002)).toBe(true);
    expect(store.stats.packBytes).toBeGreaterThan(0);
    expect(store.stats.evictableBytes).toBe(0);
  });

  it('a set without area packs walks and fetches as before: no index request', async () => {
    const { bucket, store, closure, bundle } = await areaSet({ withAreas: false });
    await closure.ensureLandblock(0xA9B4, FetchPriority.Critical);
    await store.ensureCommonPack();
    expect(bucket.requests).toEqual([bundle.hash]);
    expect(store.isAreaResident(0xA9B4)).toBe(false);
  });

  it('a failed area pack never fails the gate: it is reported and the leaves stream one by one', async () => {
    const { store, closure, errors, leafHash, bucket } = await areaSet({ failArea: true });
    await expect(closure.ensureLandblock(0xA9B4, FetchPriority.Critical)).resolves.toBeUndefined();
    expect(errors.some((e) => /area pack/.test(e))).toBe(true);
    expect(store.isResident('portal', 0x01000001)).toBe(false);
    await store.ensure([fileKey('portal', 0x01000001)], FetchPriority.Critical);
    expect(bucket.requests).toContain(leafHash(0x01000001));
  });

  it('activeLoads counts the downloads a hold waits on (critical + prefetch), not background warm-fill', async () => {
    const { bucket, store } = await areaSet();
    bucket.hold();
    const bg = store.ensureCommonPack(FetchPriority.Background);
    const gate = store.ensureArea(0xA9B4, FetchPriority.Critical);
    await new Promise((r) => setTimeout(r, 0));
    // The index is shared: the gate's critical request promoted it.
    expect(store.activeLoads).toBe(1);
    bucket.release();
    await gate;
    await bg;
    expect(store.activeLoads).toBe(0);
  });
});
