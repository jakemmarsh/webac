/**
 * Persistent cache of streamed DAT objects, keyed by content hash
 * (docs/dat-streaming.md §2.2 "second session").
 *
 * Objects are immutable and named by the hash of their payload, so a hit
 * needs no revalidation and two DAT sets (EoL, Dark Majesty, a server's
 * custom portal.dat) share every byte-identical file. Never key by DAT
 * iteration: Seedsow's portal.dat reports EoL's iteration with different
 * contents.
 *
 * Stored bytes are the gzip objects as fetched (about half the payload size);
 * the store inflates them on read.
 */
import type { OpfsWriteReply, OpfsWriteRequest } from './opfsSyncWrite.js';

export interface ObjectCache {
  /** True when this cache persists across sessions. */
  readonly persistent: boolean;
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, gz: Uint8Array): Promise<void>;
  /** Whether an object is stored, without reading it (absent: treat as unknown → false). */
  has?(hash: string): Promise<boolean>;
  /**
   * PERF.warm-boot-slow-breakdown — how long opening the store took (OPFS:
   * navigator.storage.getDirectory + the objects directory), once known; null
   * before then or for a cache with nothing to open.
   */
  readonly openMs?: number | null;
}

/** No persistence (OPFS unavailable, ?nocache, tests). */
export class NullObjectCache implements ObjectCache {
  readonly persistent = false;
  async get(): Promise<Uint8Array | null> { return null; }
  async put(): Promise<void> { /* nothing */ }
  async has(): Promise<boolean> { return false; }
}

/** In-memory cache (tests; simulates a warm OPFS). */
export class MemoryObjectCache implements ObjectCache {
  readonly persistent = true;
  readonly map = new Map<string, Uint8Array>();
  async get(hash: string): Promise<Uint8Array | null> { return this.map.get(hash) ?? null; }
  async put(hash: string, gz: Uint8Array): Promise<void> { this.map.set(hash, gz.slice()); }
  async has(hash: string): Promise<boolean> { return this.map.has(hash); }
}

const OPFS_DIR = 'acjs-dat-objects-v1';

/** A worker that writes OPFS files for the page (opfsWrite.worker.ts), as far as the cache drives it. */
export interface OpfsWriterWorker {
  postMessage(msg: OpfsWriteRequest): void;
  onmessage: ((e: { data: OpfsWriteReply }) => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

/** What OpfsObjectCache.create needs from the browser (injectable for tests). */
export interface OpfsEnv {
  /** navigator.storage.getDirectory, when the browser has OPFS. */
  getDirectory: (() => Promise<FileSystemDirectoryHandle>) | null;
  /** FileSystemFileHandle.prototype.createWritable exists (Safari only from 26). */
  hasCreateWritable: boolean;
  /** Start the sync-access-handle writer worker (null when workers are unavailable). */
  startWriter: (() => OpfsWriterWorker) | null;
  /** Clock for openMs (default performance.now). */
  now?: () => number;
}

function browserOpfsEnv(): OpfsEnv {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  return {
    getDirectory: storage && typeof storage.getDirectory === 'function' ? () => storage.getDirectory() : null,
    hasCreateWritable: typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
    startWriter: typeof Worker !== 'undefined'
      ? () => new Worker(new URL('./opfsWrite.worker.ts', import.meta.url), { type: 'module', name: 'acjs-opfs-write' }) as unknown as OpfsWriterWorker
      : null,
  };
}

/**
 * Origin Private File System cache: one file per object under
 * acjs-dat-objects-v1/. Any failure degrades to a miss (caching is an
 * optimization, never a correctness dependency — the DatCache.ts rule).
 * A torn or corrupt file is harmless: DatStore checks every object's
 * inflated size and hash, and refetches on a mismatch.
 *
 * COMPAT.opfs-safari-sync-write — where the page has no createWritable
 * (Safari before 26) the bytes go to a worker that writes them with a
 * FileSystemSyncAccessHandle; with neither, there is no cache at all
 * (a NullObjectCache), rather than an empty file left per object.
 */
export class OpfsObjectCache implements ObjectCache {
  readonly persistent = true;
  private dir: Promise<FileSystemDirectoryHandle | null>;
  private nextWriteId = 1;
  private readonly pendingWrites = new Map<number, () => void>();
  /** The writer worker failed to load or crashed: later puts are dropped. */
  private writerBroken = false;
  /** ObjectCache.openMs: getDirectory + the objects directory, once settled. */
  openMs: number | null = null;

  private constructor(getDirectory: () => Promise<FileSystemDirectoryHandle>, private readonly writer: OpfsWriterWorker | null, now: () => number) {
    const t0 = now();
    this.dir = (async () => {
      try {
        const root = await getDirectory();
        return await root.getDirectoryHandle(OPFS_DIR, { create: true });
      } catch {
        return null;
      } finally {
        this.openMs = Math.round(now() - t0);
      }
    })();
    if (writer) {
      writer.onmessage = (e) => {
        const done = this.pendingWrites.get(e.data?.id);
        if (done) { this.pendingWrites.delete(e.data.id); done(); }
      };
      writer.onerror = () => {
        this.writerBroken = true;
        for (const done of this.pendingWrites.values()) done();
        this.pendingWrites.clear();
      };
    }
  }

  /** The OPFS cache when the browser can write OPFS files (page-side or in a worker), else a NullObjectCache. */
  static create(env: OpfsEnv = browserOpfsEnv()): ObjectCache {
    if (!env.getDirectory) return new NullObjectCache();
    const now = env.now ?? (() => performance.now());
    if (env.hasCreateWritable) return new OpfsObjectCache(env.getDirectory, null, now);
    let writer: OpfsWriterWorker | null = null;
    try { writer = env.startWriter?.() ?? null; } catch { writer = null; }
    return writer ? new OpfsObjectCache(env.getDirectory, writer, now) : new NullObjectCache();
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try {
      const dir = await this.dir;
      if (!dir) return null;
      const fh = await dir.getFileHandle(hash);
      const file = await fh.getFile();
      if (file.size === 0) return null;
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      const dir = await this.dir;
      if (!dir) return false;
      return (await (await dir.getFileHandle(hash)).getFile()).size > 0;
    } catch {
      return false;
    }
  }

  async put(hash: string, gz: Uint8Array): Promise<void> {
    try {
      const dir = await this.dir;
      if (!dir) return;
      if (this.writer) {
        if (this.writerBroken) return;
        const id = this.nextWriteId++;
        const done = new Promise<void>((resolve) => this.pendingWrites.set(id, resolve));
        // A copy: the caller keeps its bytes (postMessage clones it anyway; no transfer).
        this.writer.postMessage({ id, dir: OPFS_DIR, name: hash, bytes: gz });
        await done;
        return;
      }
      const fh = await dir.getFileHandle(hash, { create: true });
      const w = await fh.createWritable();
      await w.write(gz as unknown as ArrayBuffer);
      await w.close();
    } catch {
      /* quota / unsupported: stay a miss */
    }
  }
}
