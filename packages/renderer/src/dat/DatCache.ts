/**
 * DatCache — persist the large DAT files (portal ~927MB, cell ~348MB,
 * client_local_English) in the browser's Origin Private File System so they
 * load once instead of re-downloading ~1.28GB on every page load.
 *
 * ASSESS (2026-06-10 fresh-eyes audit, "delivery hole"): the client fetched
 * every DAT in full on each load with no caching. OPFS gives generous quota
 * for large binaries and survives reloads; on a hit the DAT is read from
 * local disk (fast) and never re-downloaded.
 *
 * Validation: the cached copy is keyed and revalidated against a cheap HEAD
 * request (ETag, else Content-Length + Last-Modified). DAT iteration swaps
 * change file size, so a size mismatch always re-fetches — we never serve a
 * stale DAT. If OPFS is unavailable or any cache op fails, we transparently
 * fall back to a plain network fetch: caching is an optimization, never a
 * correctness dependency.
 */

export interface DatCacheMeta {
  /** Byte length of the resource. */
  size: number;
  /** HTTP Last-Modified header value, if any. */
  lastModified: string | null;
  /** HTTP ETag header value, if any. */
  etag: string | null;
}

/**
 * Decide whether a cached copy is still good given freshly-fetched remote
 * metadata. Pure + exhaustively unit-tested — this is the correctness core.
 *
 * - No cached copy → invalid (must fetch).
 * - Remote meta unavailable (HEAD failed / offline) → trust the cache: a
 *   working offline reload beats failing because we couldn't revalidate.
 * - Both have ETags → strong validator: equal ETag wins, differing loses.
 * - Otherwise compare size first (DAT iteration changes always change size),
 *   then Last-Modified when both are present.
 */
export function isCacheValid(
  cached: DatCacheMeta | null,
  remote: DatCacheMeta | null,
): boolean {
  if (!cached) return false;
  if (!remote) return true; // can't revalidate — keep working offline
  if (remote.etag && cached.etag) {
    // Strong validator — but still honor the "a size mismatch always
    // re-fetches" invariant when the server reports a size (guards a
    // misconfigured host that reuses an ETag across a content change).
    return remote.etag === cached.etag && (remote.size < 0 || remote.size === cached.size);
  }
  if (remote.size !== cached.size) return false;
  if (remote.lastModified && cached.lastModified) {
    return remote.lastModified === cached.lastModified;
  }
  return remote.size === cached.size;
}

/** Storage backend for cached DAT blobs + their metadata. */
export interface DatBlobStore {
  /** True when this backend can actually persist (feature-detected). */
  readonly available: boolean;
  getMeta(key: string): Promise<DatCacheMeta | null>;
  getData(key: string): Promise<ArrayBuffer | null>;
  put(key: string, data: ArrayBuffer, meta: DatCacheMeta): Promise<void>;
  /** Remove a single entry (data + meta). */
  remove(key: string): Promise<void>;
  /** Drop every cached DAT (data + manifest). */
  clear(): Promise<void>;
}

/** Stable, filesystem-safe cache key for a DAT URL. */
export function cacheKeyForUrl(url: string, namespace?: string): string {
  // Strip query/hash and any leading slash; keep only the path's basename-ish
  // tail so '/client_portal.dat' and 'http://host/client_portal.dat' collide
  // intentionally (same asset). Sanitize to a flat OPFS filename.
  const noQuery = url.split('?')[0].split('#')[0];
  const tail = noQuery.replace(/^.*\//, '') || noQuery;
  const base = tail.replace(/[^A-Za-z0-9._-]/g, '_');
  // A classic-era DAT set (docs/dark-majesty-support.md) shares file names —
  // and for the Classic Dereth portal even the byte size — with the
  // end-of-retail files, so each set's files live under their own key.
  return namespace ? `${namespace.replace(/[^A-Za-z0-9._-]/g, '_')}__${base}` : base;
}

export interface LoadDatOptions {
  store: DatBlobStore;
  /** Fetch resource metadata cheaply (HEAD). May reject/return null. */
  headMeta: (url: string) => Promise<DatCacheMeta | null>;
  /** Network fetch of the full resource (with progress). */
  fetchData: (
    url: string,
    onProgress?: (pct: number, loaded: number, total: number) => void,
  ) => Promise<ArrayBuffer>;
  onProgress?: (pct: number, loaded: number, total: number) => void;
  /** Notified with where the bytes came from, for UI/telemetry. */
  onSource?: (source: 'cache' | 'network') => void;
  /** Skip the cache entirely (e.g. ?nocache escape hatch). */
  bypass?: boolean;
  /** Cache-key namespace (cacheKeyForUrl): an era's DAT set; omitted for the end-of-retail files. */
  cacheNamespace?: string;
}

/**
 * Load a DAT: serve from cache when valid, otherwise fetch and (best-effort,
 * non-blocking) populate the cache for next time. Always resolves to the
 * bytes; caching failures only log.
 */
export async function loadDatWithCache(
  url: string,
  opts: LoadDatOptions,
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const key = cacheKeyForUrl(url, opts.cacheNamespace);
  const useStore = opts.store.available && !opts.bypass;

  if (useStore) {
    try {
      const cachedMeta = await opts.store.getMeta(key);
      if (cachedMeta) {
        const remoteMeta = await opts.headMeta(url).catch(() => null);
        if (isCacheValid(cachedMeta, remoteMeta)) {
          const data = await opts.store.getData(key);
          if (data && data.byteLength === cachedMeta.size) {
            opts.onSource?.('cache');
            return { buffer: data, fromCache: true };
          }
        } else {
          // Stale — drop it so the manifest doesn't keep a dead entry.
          await opts.store.remove(key).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[AC:DatCache] cache read failed, falling back to network:', err);
    }
  }

  opts.onSource?.('network');
  // Capture the validators BEFORE the download: a server that swaps the DAT
  // mid-download would otherwise pair the new version's ETag/Last-Modified with
  // the old version's bytes and serve that as "valid" forever. With pre-fetch
  // validators, a swap makes the next HEAD mismatch and self-corrects (one
  // harmless re-fetch) instead of caching a stale-but-valid blob.
  const preMeta = useStore ? await opts.headMeta(url).catch(() => null) : null;
  const buffer = await opts.fetchData(url, opts.onProgress);

  if (useStore) {
    // Populate in the background so the first (cold) load isn't slowed by the
    // OPFS write. size comes from the bytes we actually got; the validators
    // from the pre-fetch HEAD.
    void (async () => {
      try {
        const meta: DatCacheMeta = {
          size: buffer.byteLength,
          lastModified: preMeta?.lastModified ?? null,
          etag: preMeta?.etag ?? null,
        };
        await opts.store.put(key, buffer, meta);
      } catch (err) {
        console.warn('[AC:DatCache] cache write skipped:', err);
      }
    })();
  }

  return { buffer, fromCache: false };
}

export interface InterrogateDatOptions {
  store: DatBlobStore;
  headMeta: (url: string) => Promise<DatCacheMeta | null>;
  /** Skip the cache entirely (e.g. ?nocache escape hatch). */
  bypass?: boolean;
  /** Cache-key namespace, as LoadDatOptions.cacheNamespace. */
  cacheNamespace?: string;
}

export interface DatInterrogation {
  /** Where `loadDatWithCache` will take the bytes from, by the same rule. */
  source: 'cache' | 'network';
  /** Bytes a network load will transfer (the HEAD's Content-Length), -1 when unknown; 0 for a cache hit. */
  size: number;
}

/**
 * CORE.17.k.b.b.a.a.a — the "Looking for data to patch..." pass: decide,
 * without transferring anything, whether a DAT will come from the cache or
 * the network and how many bytes the network would move. The SAME cache
 * verdict `loadDatWithCache` reaches (cached meta + HEAD → isCacheValid),
 * so the patch meter's byte total (gmDataPatchUI's m_expected) can be the
 * sum over every DAT before the first download starts.
 */
export async function interrogateDat(url: string, opts: InterrogateDatOptions): Promise<DatInterrogation> {
  const useStore = opts.store.available && !opts.bypass;
  let remoteMeta: DatCacheMeta | null | undefined;
  if (useStore) {
    try {
      const cachedMeta = await opts.store.getMeta(cacheKeyForUrl(url, opts.cacheNamespace));
      if (cachedMeta) {
        remoteMeta = await opts.headMeta(url).catch(() => null);
        if (isCacheValid(cachedMeta, remoteMeta)) return { source: 'cache', size: 0 };
      }
    } catch {
      // Unreadable cache → the load falls back to the network below.
    }
  }
  if (remoteMeta === undefined) remoteMeta = await opts.headMeta(url).catch(() => null);
  return { source: 'network', size: remoteMeta && remoteMeta.size >= 0 ? remoteMeta.size : -1 };
}

/** Read DAT metadata via a cheap HEAD request. Returns null on any failure. */
export async function fetchHeadMeta(url: string): Promise<DatCacheMeta | null> {
  try {
    const resp = await fetch(url, { method: 'HEAD' });
    if (!resp.ok) return null;
    const len = resp.headers.get('content-length');
    return {
      size: len ? parseInt(len, 10) : -1,
      lastModified: resp.headers.get('last-modified'),
      etag: resp.headers.get('etag'),
    };
  } catch {
    return null;
  }
}

/**
 * OPFS-backed DatBlobStore. Data lives in flat files keyed by url-basename;
 * metadata in a single JSON manifest so we can validate without reading the
 * (huge) blob. Construct via OpfsDatBlobStore.create() to feature-detect.
 */
export class OpfsDatBlobStore implements DatBlobStore {
  readonly available: boolean;
  private static readonly MANIFEST = 'dat-cache-manifest.v1.json';
  private static readonly DATA_SUFFIX = '.datcache';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getDir: () => Promise<any>;
  private manifestCache: Record<string, DatCacheMeta> | null = null;

  private constructor(available: boolean) {
    this.available = available;
    this.getDir = () =>
      (navigator as unknown as {
        storage: { getDirectory(): Promise<unknown> };
      }).storage.getDirectory();
  }

  /** Feature-detect OPFS + createWritable (the writable-stream API we need). */
  static create(): OpfsDatBlobStore {
    const hasOpfs =
      typeof navigator !== 'undefined' &&
      !!(navigator as unknown as { storage?: { getDirectory?: unknown } }).storage
        ?.getDirectory &&
      typeof FileSystemFileHandle !== 'undefined' &&
      // createWritable is the part Safari historically lacked.
      'createWritable' in FileSystemFileHandle.prototype;
    return new OpfsDatBlobStore(hasOpfs);
  }

  private async readManifest(): Promise<Record<string, DatCacheMeta>> {
    if (this.manifestCache) return this.manifestCache;
    try {
      const dir = await this.getDir();
      const fh = await dir.getFileHandle(OpfsDatBlobStore.MANIFEST);
      const file = await fh.getFile();
      this.manifestCache = JSON.parse(await file.text());
    } catch {
      this.manifestCache = {};
    }
    return this.manifestCache!;
  }

  private async writeManifest(m: Record<string, DatCacheMeta>): Promise<void> {
    this.manifestCache = m;
    const dir = await this.getDir();
    const fh = await dir.getFileHandle(OpfsDatBlobStore.MANIFEST, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(m));
    await w.close();
  }

  async getMeta(key: string): Promise<DatCacheMeta | null> {
    if (!this.available) return null;
    const m = await this.readManifest();
    return m[key] ?? null;
  }

  async getData(key: string): Promise<ArrayBuffer | null> {
    if (!this.available) return null;
    try {
      const dir = await this.getDir();
      const fh = await dir.getFileHandle(key + OpfsDatBlobStore.DATA_SUFFIX);
      const file = await fh.getFile();
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  async put(key: string, data: ArrayBuffer, meta: DatCacheMeta): Promise<void> {
    return this.writeEntry(key, data, meta);
  }

  private async writeEntry(key: string, data: ArrayBuffer, meta: DatCacheMeta): Promise<void> {
    if (!this.available) return;
    const dir = await this.getDir();
    const fh = await dir.getFileHandle(key + OpfsDatBlobStore.DATA_SUFFIX, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (err) {
      // Quota exceeded or write failure — abort and leave no half-written file.
      try { await w.abort(); } catch { /* ignore */ }
      await this.remove(key).catch(() => {});
      throw err;
    }
    const m = await this.readManifest();
    m[key] = meta;
    await this.writeManifest(m);
  }

  async remove(key: string): Promise<void> {
    if (!this.available) return;
    try {
      const dir = await this.getDir();
      await dir.removeEntry(key + OpfsDatBlobStore.DATA_SUFFIX).catch(() => {});
      const m = await this.readManifest();
      if (key in m) {
        delete m[key];
        await this.writeManifest(m);
      }
    } catch (err) {
      console.warn('[AC:DatCache] remove failed:', err);
    }
  }

  async clear(): Promise<void> {
    if (!this.available) return;
    try {
      const m = await this.readManifest();
      const dir = await this.getDir();
      for (const key of Object.keys(m)) {
        await dir.removeEntry(key + OpfsDatBlobStore.DATA_SUFFIX).catch(() => {});
      }
      await dir.removeEntry(OpfsDatBlobStore.MANIFEST).catch(() => {});
      this.manifestCache = {};
    } catch (err) {
      console.warn('[AC:DatCache] clear failed:', err);
    }
  }
}
