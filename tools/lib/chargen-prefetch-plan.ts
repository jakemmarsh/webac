/**
 * UX.chargen-preview-no-placeholder — what the chargen prefetch fetches, from
 * local DATs: ChargenPrefetch's roots for one heritage + sex, walked through
 * the client's own DatClosure edges (over a LocalClosureStore, where every
 * file is resident), down to the per-file leaves a streamed set downloads.
 * Used by tools/measure-chargen-prefetch.ts (the byte table) and
 * tests/verify-chargen-preview-no-placeholder.ts (coverage of real builds).
 */
import { gzipSync } from 'node:zlib';
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatClosure, type ClosureStore } from '../../packages/renderer/src/dat/streaming/DatClosure.js';
import { fileKey, splitFileKey } from '../../packages/renderer/src/dat/streaming/DatStore.js';
import { LocalClosureStore, isPortalLeaf } from './area-packs.js';

/** The portal leaves (per-file downloads) the closure of `roots` reaches. */
export async function closureLeaves(portal: DatDatabase, roots: readonly number[]): Promise<Set<number>> {
  const store = new LocalClosureStore({ portal });
  const closure = new DatClosure(store as unknown as ClosureStore);
  const { keys } = await closure.ensure(roots.map((id) => fileKey('portal', id >>> 0)));
  const out = new Set<number>();
  for (const k of keys) {
    const { dat, id } = splitFileKey(k);
    if (dat === 'portal' && isPortalLeaf(id) && portal.hasFile(id)) out.add(id >>> 0);
  }
  return out;
}

/** Payload and gzip -6 bytes (a per-file object's transfer size) of `ids`. */
export function leafBytes(portal: DatDatabase, ids: Iterable<number>): { files: number; payload: number; gz: number } {
  let files = 0, payload = 0, gz = 0;
  for (const id of ids) {
    const d = portal.getFileData(id);
    if (!d) continue;
    files++;
    payload += d.byteLength;
    gz += gzipSync(new Uint8Array(d), { level: 6 }).byteLength;
  }
  return { files, payload, gz };
}
