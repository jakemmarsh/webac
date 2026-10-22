/**
 * COMPAT.opfs-safari-sync-write — Safari before 26 has OPFS but no
 * FileSystemFileHandle.createWritable (https://caniuse.com/mdn-api_filesystemfilehandle_createwritable).
 * OpfsObjectCache used to pick OPFS anyway: every put created an empty file,
 * threw on createWritable, and nothing was ever cached, so every Safari 18
 * session streamed every DAT object again. Now the writes go to a worker
 * that uses a FileSystemSyncAccessHandle (Safari 15.2+), and a browser with
 * neither gets no cache instead of empty files.
 */
import { describe, it, expect } from 'vitest';
import { OpfsObjectCache, NullObjectCache, type OpfsEnv, type OpfsWriterWorker } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { writeWithSyncHandle, type SyncDirLike, type OpfsWriteRequest } from '../packages/renderer/src/dat/streaming/opfsSyncWrite.js';

/** An in-memory OPFS: directories of files, page-side (getFile) and worker-side (sync handles). */
function fakeOpfs(opts: { createWritable: boolean; asyncHandleMethods?: boolean }) {
  const files = new Map<string, Uint8Array>();
  const open = new Set<string>();
  const dirHandle = (path: string): unknown => ({
    async getDirectoryHandle(name: string) { return dirHandle(`${path}/${name}`); },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const key = `${path}/${name}`;
      if (!files.has(key)) {
        if (!o?.create) throw new DOMException('missing', 'NotFoundError');
        files.set(key, new Uint8Array(0));
      }
      const fh: Record<string, unknown> = {
        async getFile() { const b = files.get(key)!; return { size: b.length, arrayBuffer: async () => b.slice().buffer }; },
        async createSyncAccessHandle() {
          if (open.has(key)) throw new DOMException('busy', 'NoModificationAllowedError');
          open.add(key);
          let buf = files.get(key)!;
          const wrap = <T>(v: T) => (opts.asyncHandleMethods ? Promise.resolve(v) : v);
          return {
            truncate: (n: number) => wrap(void (buf = buf.slice(0, n))),
            write: (b: Uint8Array, w?: { at?: number }) => {
              const at = w?.at ?? 0;
              const next = new Uint8Array(Math.max(buf.length, at + b.length));
              next.set(buf); next.set(b, at); buf = next;
              return wrap(b.length);
            },
            flush: () => wrap(void files.set(key, buf)),
            close: () => wrap(void open.delete(key)),
          };
        },
      };
      if (opts.createWritable) {
        fh.createWritable = async () => {
          const parts: Uint8Array[] = [];
          return { write: async (b: Uint8Array) => { parts.push(b); }, close: async () => { files.set(key, parts[0] ?? new Uint8Array(0)); } };
        };
      }
      return fh;
    },
  });
  const root = dirHandle('');
  return { files, root, getDirectory: async () => root as FileSystemDirectoryHandle };
}

/** A worker double that runs the real worker body (writeWithSyncHandle) on the fake OPFS root. */
function fakeWriter(root: unknown): OpfsWriterWorker & { posted: OpfsWriteRequest[] } {
  const w: OpfsWriterWorker & { posted: OpfsWriteRequest[] } = {
    posted: [],
    onmessage: null,
    postMessage(msg) {
      w.posted.push(msg);
      void writeWithSyncHandle(root as SyncDirLike, msg).then((reply) => w.onmessage?.({ data: reply }));
    },
  };
  return w;
}

const HASH = 'ab'.repeat(20);
const BYTES = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);

describe('OpfsObjectCache on Safari before 26 (no createWritable)', () => {
  it('stores through the sync-access-handle worker, and the page reads it back', async () => {
    const opfs = fakeOpfs({ createWritable: false });
    const writer = fakeWriter(opfs.root);
    const env: OpfsEnv = { getDirectory: opfs.getDirectory, hasCreateWritable: false, startWriter: () => writer };
    const cache = OpfsObjectCache.create(env);
    expect(cache).toBeInstanceOf(OpfsObjectCache);
    await cache.put(HASH, BYTES);
    expect(writer.posted).toHaveLength(1);
    expect(await cache.has!(HASH)).toBe(true);
    expect(Array.from((await cache.get(HASH))!)).toEqual(Array.from(BYTES));
  });

  it('Safari 15.2–16 (promise-returning handle methods) writes the same bytes', async () => {
    const opfs = fakeOpfs({ createWritable: false, asyncHandleMethods: true });
    const cache = OpfsObjectCache.create({ getDirectory: opfs.getDirectory, hasCreateWritable: false, startWriter: () => fakeWriter(opfs.root) });
    await cache.put(HASH, BYTES);
    expect(Array.from((await cache.get(HASH))!)).toEqual(Array.from(BYTES));
  });

  it('no createWritable and no worker: no cache at all (no empty file per object)', async () => {
    const opfs = fakeOpfs({ createWritable: false });
    const cache = OpfsObjectCache.create({ getDirectory: opfs.getDirectory, hasCreateWritable: false, startWriter: null });
    expect(cache).toBeInstanceOf(NullObjectCache);
    await cache.put(HASH, BYTES);
    expect(opfs.files.size).toBe(0);
  });

  it('a writer worker that fails to load drops later puts instead of hanging them', async () => {
    const opfs = fakeOpfs({ createWritable: false });
    const dead: OpfsWriterWorker = { onmessage: null, onerror: null, postMessage() { /* never answers */ } };
    const cache = OpfsObjectCache.create({ getDirectory: opfs.getDirectory, hasCreateWritable: false, startWriter: () => dead });
    const p = cache.put(HASH, BYTES);
    await Promise.resolve(); await Promise.resolve();
    dead.onerror?.(new Event('error'));
    await expect(p).resolves.toBeUndefined();
    await expect(cache.put(HASH, BYTES)).resolves.toBeUndefined();
  });

  it('a second writer holding the file (NoModificationAllowedError) leaves a miss, never a throw', async () => {
    const opfs = fakeOpfs({ createWritable: false });
    const dir = await (opfs.root as SyncDirLike).getDirectoryHandle('acjs-dat-objects-v1', { create: true });
    const held = await (await dir.getFileHandle(HASH, { create: true })).createSyncAccessHandle();
    const reply = await writeWithSyncHandle(opfs.root as SyncDirLike, { id: 7, dir: 'acjs-dat-objects-v1', name: HASH, bytes: BYTES });
    expect(reply).toEqual({ id: 7, ok: false });
    await held.close();
  });
});

describe('OpfsObjectCache with createWritable (Chrome, Firefox, Safari 26+): unchanged', () => {
  it('writes page-side; no worker is started', async () => {
    const opfs = fakeOpfs({ createWritable: true });
    let started = 0;
    const cache = OpfsObjectCache.create({ getDirectory: opfs.getDirectory, hasCreateWritable: true, startWriter: () => { started++; return fakeWriter(opfs.root); } });
    await cache.put(HASH, BYTES);
    expect(started).toBe(0);
    expect(Array.from((await cache.get(HASH))!)).toEqual(Array.from(BYTES));
  });

  it('no OPFS at all (Firefox private window before 2024, old browsers): NullObjectCache', () => {
    expect(OpfsObjectCache.create({ getDirectory: null, hasCreateWritable: false, startWriter: null })).toBeInstanceOf(NullObjectCache);
  });
});
