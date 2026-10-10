/**
 * ASSESS: OPFS DAT cache — avoid re-downloading ~1.28GB of DAT files on every
 * page load. Drives the real cache-decision logic and orchestration
 * (DatCache.ts) against a fake in-memory store; OPFS itself isn't available in
 * node, so the OpfsDatBlobStore I/O is exercised live in-browser instead.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isCacheValid,
  cacheKeyForUrl,
  loadDatWithCache,
  type DatBlobStore,
  type DatCacheMeta,
} from '../packages/renderer/src/dat/DatCache.js';

const META = (size: number, lastModified: string | null = null, etag: string | null = null): DatCacheMeta =>
  ({ size, lastModified, etag });

describe('isCacheValid', () => {
  it('no cached copy → invalid', () => {
    expect(isCacheValid(null, META(10))).toBe(false);
  });

  it('remote unavailable (HEAD failed) → trust cache (offline reload)', () => {
    expect(isCacheValid(META(10), null)).toBe(true);
  });

  it('matching ETags → valid; differing ETags → invalid', () => {
    expect(isCacheValid(META(10, null, 'W/"abc"'), META(10, null, 'W/"abc"'))).toBe(true);
    expect(isCacheValid(META(10, null, 'W/"abc"'), META(10, null, 'W/"xyz"'))).toBe(false);
  });

  it('matching ETag with the same size is valid', () => {
    expect(isCacheValid(META(10, null, 'e1'), META(10, null, 'e1'))).toBe(true);
  });

  it('matching ETag but a DIFFERENT size re-fetches (honors the size invariant)', () => {
    // Review fix: a misconfigured host reusing an ETag across a content change
    // must not serve stale — "a size mismatch always re-fetches".
    expect(isCacheValid(META(10, null, 'e1'), META(999, null, 'e1'))).toBe(false);
  });

  it('matching ETag still valid when the server omits a size (size unknown)', () => {
    expect(isCacheValid(META(10, null, 'e1'), META(-1, null, 'e1'))).toBe(true);
  });

  it('different size → invalid (DAT iteration swap always changes size)', () => {
    expect(isCacheValid(META(927_000_000), META(926_000_000))).toBe(false);
  });

  it('same size, matching Last-Modified → valid', () => {
    const lm = 'Wed, 17 Jul 2019 00:00:00 GMT';
    expect(isCacheValid(META(10, lm), META(10, lm))).toBe(true);
  });

  it('same size, differing Last-Modified → invalid', () => {
    expect(isCacheValid(META(10, 'Mon, 01 Jan 2018 00:00:00 GMT'), META(10, 'Tue, 02 Jan 2018 00:00:00 GMT'))).toBe(false);
  });

  it('same size, no Last-Modified on either → valid (size is best signal)', () => {
    expect(isCacheValid(META(10), META(10))).toBe(true);
  });
});

describe('cacheKeyForUrl', () => {
  it('collapses absolute and root-relative URLs to the same key', () => {
    expect(cacheKeyForUrl('/client_portal.dat')).toBe('client_portal.dat');
    expect(cacheKeyForUrl('http://host:3000/client_portal.dat')).toBe('client_portal.dat');
  });
  it('strips query and hash', () => {
    expect(cacheKeyForUrl('/client_cell_1.dat?v=2#x')).toBe('client_cell_1.dat');
  });
  it('sanitizes unsafe characters', () => {
    expect(cacheKeyForUrl('/weird name!.dat')).toBe('weird_name_.dat');
  });
});

/** In-memory DatBlobStore for orchestration tests. */
function makeFakeStore(available = true): DatBlobStore & {
  data: Map<string, ArrayBuffer>;
  meta: Map<string, DatCacheMeta>;
  putCalls: number;
} {
  const data = new Map<string, ArrayBuffer>();
  const meta = new Map<string, DatCacheMeta>();
  return {
    available,
    data,
    meta,
    putCalls: 0,
    async getMeta(k) { return meta.get(k) ?? null; },
    async getData(k) { return data.get(k) ?? null; },
    async put(k, d, m) { this.putCalls++; data.set(k, d); meta.set(k, m); },
    async remove(k) { data.delete(k); meta.delete(k); },
    async clear() { data.clear(); meta.clear(); },
  };
}

const buf = (n: number) => new Uint8Array(n).fill(7).buffer;

/** Wait for the fire-and-forget background cache write to settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadDatWithCache', () => {
  it('cold load: fetches from network and populates the cache in the background', async () => {
    const store = makeFakeStore();
    const fetchData = vi.fn(async () => buf(100));
    const headMeta = vi.fn(async () => META(100, null, 'e1'));

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(false);
    expect(res.buffer.byteLength).toBe(100);
    expect(fetchData).toHaveBeenCalledOnce();

    await flush();
    expect(store.putCalls).toBe(1);
    expect(store.meta.get('client_portal.dat')).toEqual(META(100, null, 'e1'));
  });

  it('warm load: serves from cache and never hits the network', async () => {
    const store = makeFakeStore();
    store.data.set('client_portal.dat', buf(100));
    store.meta.set('client_portal.dat', META(100, null, 'e1'));
    const fetchData = vi.fn(async () => buf(100));
    const headMeta = vi.fn(async () => META(100, null, 'e1')); // unchanged

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(true);
    expect(res.buffer.byteLength).toBe(100);
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('stale cache (size changed): re-fetches, drops the dead entry, re-caches', async () => {
    const store = makeFakeStore();
    store.data.set('client_portal.dat', buf(100));
    store.meta.set('client_portal.dat', META(100, null, 'old'));
    const fetchData = vi.fn(async () => buf(200));
    const headMeta = vi.fn(async () => META(200, null, 'new')); // DAT swapped

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(false);
    expect(res.buffer.byteLength).toBe(200);
    expect(fetchData).toHaveBeenCalledOnce();
    await flush();
    expect(store.meta.get('client_portal.dat')).toEqual(META(200, null, 'new'));
  });

  it('offline reload (HEAD fails) still serves the cached copy', async () => {
    const store = makeFakeStore();
    store.data.set('client_cell_1.dat', buf(50));
    store.meta.set('client_cell_1.dat', META(50));
    const fetchData = vi.fn(async () => buf(50));
    const headMeta = vi.fn(async () => { throw new Error('offline'); });

    const res = await loadDatWithCache('/client_cell_1.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(true);
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('bypass (?nocache): always fetches, no cache read', async () => {
    const store = makeFakeStore();
    store.data.set('client_portal.dat', buf(100));
    store.meta.set('client_portal.dat', META(100));
    const getMeta = vi.spyOn(store, 'getMeta');
    const fetchData = vi.fn(async () => buf(100));
    const headMeta = vi.fn(async () => META(100));

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData, bypass: true });
    expect(res.fromCache).toBe(false);
    expect(fetchData).toHaveBeenCalledOnce();
    expect(getMeta).not.toHaveBeenCalled();
  });

  it('store unavailable: behaves as a plain fetch (no put attempted)', async () => {
    const store = makeFakeStore(false);
    const fetchData = vi.fn(async () => buf(100));
    const headMeta = vi.fn(async () => META(100));

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(false);
    await flush();
    expect(store.putCalls).toBe(0);
  });

  it('a cache-read failure falls back to the network instead of throwing', async () => {
    const store = makeFakeStore();
    store.meta.set('client_portal.dat', META(100));
    vi.spyOn(store, 'getData').mockRejectedValueOnce(new Error('OPFS read error'));
    const fetchData = vi.fn(async () => buf(100));
    const headMeta = vi.fn(async () => META(100));

    const res = await loadDatWithCache('/client_portal.dat', { store, headMeta, fetchData });
    expect(res.fromCache).toBe(false);
    expect(fetchData).toHaveBeenCalledOnce();
  });

  it('reports the source via onSource', async () => {
    const store = makeFakeStore();
    const sources: string[] = [];
    await loadDatWithCache('/x.dat', {
      store,
      headMeta: async () => META(10),
      fetchData: async () => buf(10),
      onSource: (s) => sources.push(s),
    });
    expect(sources).toContain('network');
  });
});

describe('era DAT sets get their own cache keys (docs/dark-majesty-support.md)', () => {
  it('end-of-retail keys are unchanged; a namespace prefixes the basename', () => {
    expect(cacheKeyForUrl('/client_portal.dat')).toBe('client_portal.dat');
    expect(cacheKeyForUrl('/sets/classic-dereth/client_portal.dat', 'classic-dereth')).toBe('classic-dereth__client_portal.dat');
    expect(cacheKeyForUrl('https://x/a b/client_cell_1.dat', 'we!rd')).toBe('we_rd__client_cell_1.dat');
  });

  it('a same-size classic portal never serves the cached end-of-retail one', async () => {
    // The Classic Dereth portal is 926,941,184 bytes, exactly the end-of-retail
    // size; with no ETag/Last-Modified a basename key would hit the EoL entry.
    const store = makeFakeStore();
    store.data.set('client_portal.dat', buf(100));
    store.meta.set('client_portal.dat', META(100));
    const fetchData = vi.fn(async () => new Uint8Array(100).fill(9).buffer);
    const headMeta = vi.fn(async () => META(100));

    const res = await loadDatWithCache('/sets/classic-dereth/client_portal.dat', {
      store, headMeta, fetchData, cacheNamespace: 'classic-dereth',
    });
    expect(res.fromCache).toBe(false);
    expect(new Uint8Array(res.buffer)[0]).toBe(9);
    await flush();
    expect(store.meta.has('classic-dereth__client_portal.dat')).toBe(true);
    // The end-of-retail entry is left alone: switching back costs no download.
    expect(new Uint8Array(store.data.get('client_portal.dat')!)[0]).toBe(7);
  });
});
