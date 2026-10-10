/**
 * The AC1999 era's world DATs (docs/ac1999-support-scope.md Phase 2.3/2.4):
 * the 1999 portal and cell, each wearing dat-parser era1999's overlay (1999
 * files served in the end-of-retail formats our parsers read) plus the
 * server's DAT patches.
 *
 * An AC1999 server pushes its changed files as 0xF7B7 at login
 * (network era1999 Connection1999 → the `datPatch1999` event). Retail wrote
 * them into its DATs; we keep them beside the base files, per server, so a
 * second 1999 server never inherits the first one's content: in memory in the
 * overlays' patch maps, and persisted in the DAT cache's OPFS store as
 * `ac1999-patch__<server>__<file id>` plus a manifest, reloaded before the
 * world loads on the next visit (and reported as the server's iteration, so
 * the server does not send them again).
 */
import { ac1999CellOverlay, ac1999PortalOverlay, type Ac1999DatOverlay, type DatDatabase } from '@ac/dat-parser';
import type { DatBlobStore } from '../dat/DatCache.js';

/** One pushed file, as Connection1999 emits it (zlib from the AC1999 server; see inflateAc1999Patch). */
export interface Ac1999PatchFile { dat: 'portal' | 'cell'; fileId: number; compressed: Uint8Array; rawLength: number }
/** The `datPatch1999` connection event's payload. */
export interface Ac1999PatchEvent { patches: Ac1999PatchFile[]; portalIteration: number; cellIteration: number }
/** A patch ready to serve: its 1999-format bytes. */
export interface Ac1999Patch { dat: 'portal' | 'cell'; fileId: number; bytes: ArrayBuffer }

interface PatchManifest { portalIteration: number; cellIteration: number; files: Array<{ dat: 'portal' | 'cell'; id: number }> }

const KEY_PREFIX = 'ac1999-patch__';

/** A filesystem-safe per-server key (the bridge URL names the server: ?server=<id>, or a direct host). */
export function ac1999ServerKey(connectUrl: string): string {
  return connectUrl.replace(/^wss?:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/** The store key of one patched file. */
export function ac1999PatchKey(serverKey: string, fileId: number): string {
  return `${KEY_PREFIX}${serverKey}__${(fileId >>> 0).toString(16).padStart(8, '0')}`;
}

function manifestKey(serverKey: string): string {
  return `${KEY_PREFIX}${serverKey}__manifest`;
}

async function streamThrough(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<ArrayBuffer> {
  const ds = new DecompressionStream(format);
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Response(out).arrayBuffer();
}

/**
 * Inflate one pushed file. The AC1999 server always compresses (Client.cpp
 * SendDatFile: compress2 at Z_BEST_COMPRESSION, zlib RFC 1950, the 0x78
 * header), which DecompressionStream calls 'deflate'; a bare deflate stream
 * ('deflate-raw') is the fallback. A compressed length equal to the raw
 * length is therefore no proof the bytes are stored (zlib output can land on
 * the raw length), so inflate is tried first, and only when it fails or comes
 * out the wrong length, with equal lengths, are the bytes used as they are
 * (another server might send a file stored).
 */
export async function inflateAc1999Patch(p: Pick<Ac1999PatchFile, 'compressed' | 'rawLength'>): Promise<ArrayBuffer> {
  const stored = p.compressed.length === p.rawLength;
  let out: ArrayBuffer | null = null;
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      out = await streamThrough(p.compressed, format);
      if (out.byteLength === p.rawLength) return out;
    } catch {
      // not this framing
    }
  }
  if (stored) return p.compressed.slice().buffer as ArrayBuffer;
  if (!out) throw new Error(`[AC:1999] patch (${p.compressed.length} bytes) is neither zlib nor deflate`);
  console.warn(`[AC:1999] patch inflated to ${out.byteLength} bytes; the server said ${p.rawLength}`);
  return out;
}

export class Ac1999World {
  readonly portalOverlay: Ac1999DatOverlay;
  readonly cellOverlay: Ac1999DatOverlay;
  private restoredFor: string | null = null;

  /**
   * `translatedBase`: the DATs are a streamed 1999 world set, already in the
   * end-of-retail formats (built through the overlay): only the server's
   * patches are translated. Otherwise they are the 1999 files themselves.
   */
  constructor(readonly portal: DatDatabase, readonly cell: DatDatabase, opts: { translatedBase?: boolean } = {}) {
    const onError = (id: number, err: unknown) => console.warn(`[AC:1999] file 0x${(id >>> 0).toString(16)} did not translate:`, err);
    const translatedBase = opts.translatedBase === true;
    this.portalOverlay = ac1999PortalOverlay({ patches: new Map(), onError, translatedBase });
    this.cellOverlay = ac1999CellOverlay({ patches: new Map(), onError, translatedBase });
    portal.setOverlay(this.portalOverlay);
    cell.setOverlay(this.cellOverlay);
  }

  /** What the login reports (DDD): the base iterations, or the server's once its patches are applied. */
  get iterations(): { portal: number; cell: number } {
    return { portal: this.portal.totalIterations, cell: this.cell.totalIterations };
  }

  /**
   * Serve `files` from now on and report the server's iterations (0 = keep).
   * Files already translated are dropped from the overlays' caches so a
   * patched id is never served from its pre-patch translation.
   */
  apply(files: readonly Ac1999Patch[], iterations: { portal: number; cell: number }): void {
    for (const [dat, overlay] of [['portal', this.portalOverlay], ['cell', this.cellOverlay]] as const) {
      const mine = files.filter((f) => f.dat === dat);
      for (const f of mine) overlay.patches.set(f.fileId >>> 0, f.bytes);
      if (mine.length && overlay.cachedCount > 0) overlay.clearCache();
      const it = dat === 'portal' ? iterations.portal : iterations.cell;
      if (it > 0) overlay.iteration = it;
    }
  }

  /** Inflate and apply a `datPatch1999` event; resolves to the files applied. */
  async applyEvent(e: Ac1999PatchEvent): Promise<Ac1999Patch[]> {
    const files: Ac1999Patch[] = [];
    for (const p of e.patches) {
      try {
        files.push({ dat: p.dat, fileId: p.fileId >>> 0, bytes: await inflateAc1999Patch(p) });
      } catch (err) {
        console.warn(`[AC:1999] patch 0x${(p.fileId >>> 0).toString(16)} could not be inflated:`, err);
      }
    }
    this.apply(files, { portal: e.portalIteration, cell: e.cellIteration });
    return files;
  }

  /** Persist `files` (merged into what the server already stored) and the current iterations. Never throws. */
  async persist(store: DatBlobStore, serverKey: string, files: readonly Ac1999Patch[]): Promise<void> {
    if (!store.available) return;
    try {
      const prev = await readManifest(store, serverKey);
      const known = new Map((prev?.files ?? []).map((f) => [f.id >>> 0, f.dat] as const));
      for (const f of files) {
        await store.put(ac1999PatchKey(serverKey, f.fileId), f.bytes, { size: f.bytes.byteLength, lastModified: null, etag: null });
        known.set(f.fileId >>> 0, f.dat);
      }
      const manifest: PatchManifest = {
        portalIteration: this.portalOverlay.iteration ?? 0,
        cellIteration: this.cellOverlay.iteration ?? 0,
        files: [...known].map(([id, dat]) => ({ dat, id })),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer;
      await store.put(manifestKey(serverKey), bytes, { size: bytes.byteLength, lastModified: null, etag: null });
    } catch (err) {
      console.warn('[AC:1999] could not store the server\'s DAT patches:', err);
    }
  }

  /**
   * Load the patches stored for `serverKey` (once per key; a different key
   * replaces the previous server's). Resolves to the number of files applied.
   * Never throws: a missing or partial store means the server sends them again.
   */
  async restore(store: DatBlobStore, serverKey: string): Promise<number> {
    if (this.restoredFor === serverKey) return 0;
    if (this.restoredFor !== null) {
      for (const o of [this.portalOverlay, this.cellOverlay]) { o.patches.clear(); o.iteration = undefined; o.clearCache(); }
    }
    this.restoredFor = serverKey;
    if (!store.available) return 0;
    try {
      const manifest = await readManifest(store, serverKey);
      if (!manifest) return 0;
      const files: Ac1999Patch[] = [];
      for (const f of manifest.files) {
        const bytes = await store.getData(ac1999PatchKey(serverKey, f.id));
        if (!bytes) return 0; // incomplete: report the base iterations so the server resends everything
        files.push({ dat: f.dat, fileId: f.id >>> 0, bytes });
      }
      this.apply(files, { portal: manifest.portalIteration, cell: manifest.cellIteration });
      return files.length;
    } catch (err) {
      console.warn('[AC:1999] could not read the stored DAT patches:', err);
      return 0;
    }
  }
}

async function readManifest(store: DatBlobStore, serverKey: string): Promise<PatchManifest | null> {
  const raw = await store.getData(manifestKey(serverKey));
  if (!raw) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(raw)) as Partial<PatchManifest>;
    if (!Array.isArray(v.files)) return null;
    return {
      portalIteration: Number(v.portalIteration) || 0,
      cellIteration: Number(v.cellIteration) || 0,
      files: v.files.filter((f) => (f?.dat === 'portal' || f?.dat === 'cell') && Number.isFinite(f.id)),
    };
  } catch {
    return null;
  }
}
