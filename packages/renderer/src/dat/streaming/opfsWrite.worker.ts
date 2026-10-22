/**
 * COMPAT.opfs-safari-sync-write — OpfsObjectCache's writer where the page
 * has no FileSystemFileHandle.createWritable (Safari before 26): one
 * FileSystemSyncAccessHandle write per request (opfsSyncWrite.ts), the
 * reply posted back by id.
 */
import { writeWithSyncHandle, type OpfsWriteRequest, type SyncDirLike } from './opfsSyncWrite.js';

let root: Promise<SyncDirLike> | null = null;
self.onmessage = (e: MessageEvent<OpfsWriteRequest>) => {
  const req = e.data;
  root ??= navigator.storage.getDirectory() as unknown as Promise<SyncDirLike>;
  void root
    .then((r) => writeWithSyncHandle(r, req))
    .catch(() => ({ id: req.id, ok: false }))
    .then((reply) => (self as unknown as Worker).postMessage(reply));
};
