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
export interface ObjectCache {
  /** True when this cache persists across sessions. */
  readonly persistent: boolean;
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, gz: Uint8Array): Promise<void>;
  /** Whether an object is stored, without reading it (absent: treat as unknown → false). */
  has?(hash: string): Promise<boolean>;
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

/**
 * Origin Private File System cache: one file per object under
 * acjs-dat-objects-v1/. Any failure degrades to a miss (caching is an
 * optimization, never a correctness dependency — the DatCache.ts rule).
 * A torn or corrupt file is harmless: DatStore checks every object's
 * inflated size and hash, and refetches on a mismatch.
 */
export class OpfsObjectCache implements ObjectCache {
  readonly persistent = true;
  private dir: Promise<FileSystemDirectoryHandle | null>;

  private constructor() {
    this.dir = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(OPFS_DIR, { create: true });
      } catch {
        return null;
      }
    })();
  }

  /** The OPFS cache when the browser has OPFS, else a NullObjectCache. */
  static create(): ObjectCache {
    const ok = typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
    return ok ? new OpfsObjectCache() : new NullObjectCache();
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
      const fh = await dir.getFileHandle(hash, { create: true });
      const w = await fh.createWritable();
      await w.write(gz as unknown as ArrayBuffer);
      await w.close();
    } catch {
      /* quota / unsupported: stay a miss */
    }
  }
}
