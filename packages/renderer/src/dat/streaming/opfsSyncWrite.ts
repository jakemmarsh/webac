/**
 * COMPAT.opfs-safari-sync-write — write one OPFS file through a
 * FileSystemSyncAccessHandle (dedicated workers only). Safari before 26 has
 * OPFS and createSyncAccessHandle (15.2+) but no FileSystemFileHandle.
 * createWritable (https://caniuse.com/mdn-api_filesystemfilehandle_createwritable),
 * so a page-side put could never store anything there. opfsWrite.worker.ts
 * runs this for OpfsObjectCache.
 *
 * Safari 15.2–16.x shipped the handle's methods as promise-returning; later
 * versions are synchronous. Every call is awaited, which suits both.
 */

/** The OPFS surface this needs (a worker's navigator.storage.getDirectory() root). */
export interface SyncDirLike {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<SyncDirLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{ createSyncAccessHandle(): Promise<SyncHandleLike> }>;
}
export interface SyncHandleLike {
  truncate(size: number): unknown;
  write(buf: Uint8Array, opts?: { at?: number }): unknown;
  flush(): unknown;
  close(): unknown;
}

export interface OpfsWriteRequest { id: number; dir: string; name: string; bytes: Uint8Array }
export interface OpfsWriteReply { id: number; ok: boolean }

export async function writeWithSyncHandle(root: SyncDirLike, req: OpfsWriteRequest): Promise<OpfsWriteReply> {
  let handle: SyncHandleLike | null = null;
  try {
    const dir = await root.getDirectoryHandle(req.dir, { create: true });
    const fh = await dir.getFileHandle(req.name, { create: true });
    handle = await fh.createSyncAccessHandle();
    await handle.truncate(0);
    await handle.write(req.bytes, { at: 0 });
    await handle.flush();
    return { id: req.id, ok: true };
  } catch {
    // Quota, a second writer holding the file's handle: the object stays a miss.
    return { id: req.id, ok: false };
  } finally {
    try { if (handle) await handle.close(); } catch { /* already closed */ }
  }
}
