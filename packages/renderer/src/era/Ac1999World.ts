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
 *
 * A first visit has nothing stored and reports the world set's iterations, so
 * the server sends its whole difference first (10-14 s at its pacing;
 * BUG.ac1999-slow-login-ddd-push). Where the world set carries a seed for the
 * server (that same difference, prepared ahead: dat-parser era1999
 * ServerPatchSeed, tools/ac1999-dat-seed.ts), the seed is applied instead, as
 * if the server had sent it. The login reports the newest state the client
 * fully holds: stored patches win over a seed only when they are at least the
 * seed's level in both DATs (BUG.ac1999-stored-patches-beat-newer-seed: a
 * browser that stored 10006 before seeds existed kept reporting it under a
 * 10007 seed and was pushed the difference); a state built on a seed names it
 * (`seed` in the manifest) and is dropped when that seed is no longer the one
 * offered, so it is never mixed with another.
 */
import { ac1999CellOverlay, ac1999PortalOverlay, decodeServerPatchSeed, type Ac1999DatOverlay, type DatDatabase, type DatIterations } from '@ac/dat-parser';
import type { DatBlobStore } from '../dat/DatCache.js';
import type { DatStore } from '../dat/streaming/DatStore.js';

/** One pushed file, as Connection1999 emits it (zlib from the AC1999 server; see inflateAc1999Patch). */
export interface Ac1999PatchFile { dat: 'portal' | 'cell'; fileId: number; compressed: Uint8Array; rawLength: number }
/** The `datPatch1999` connection event's payload. */
export interface Ac1999PatchEvent { patches: Ac1999PatchFile[]; portalIteration: number; cellIteration: number }
/** A patch ready to serve: its 1999-format bytes. */
export interface Ac1999Patch { dat: 'portal' | 'cell'; fileId: number; bytes: ArrayBuffer }

/**
 * A server's login push prepared ahead of time. `id` names it (its content hash); `base` is the
 * iterations it was diffed from, `iterations` the server's.
 */
export interface Ac1999Seed { id: string; base: DatIterations; iterations: DatIterations; files: Ac1999Patch[] }
/** What a seed is, as the set pointer describes it (no fetch). */
export interface Ac1999SeedInfo { id: string; base: DatIterations; iterations: DatIterations }
/**
 * Fetches the seed for the server being restored, or null when there is none. `describe`, when
 * present, says what the pointer offers without fetching it, so a stored state already at or past
 * the seed's level never loads it.
 */
export interface Ac1999SeedSource { (): Promise<Ac1999Seed | null>; describe?: () => Ac1999SeedInfo | null }

/** A seed payload (ServerPatchSeed's "ACSS") as an Ac1999Seed; throws on a malformed one. */
export function ac1999SeedFromPayload(id: string, payload: Uint8Array): Ac1999Seed {
  const s = decodeServerPatchSeed(payload);
  return {
    id, base: s.base, iterations: s.iterations,
    files: s.records.map((r) => ({ dat: r.dat, fileId: r.id >>> 0, bytes: r.bytes.slice().buffer as ArrayBuffer })),
  };
}

/**
 * The seed a streamed 1999 world set offers for the server a connect URL names (its launcher
 * world id, `?server=`), or undefined when there is no set or no id. A seed whose header
 * disagrees with the pointer's description of it is refused.
 */
export function ac1999SeedSource(store: (Pick<DatStore, 'loadServerSeed'> & Partial<Pick<DatStore, 'pointer'>>) | null | undefined, serverId: string | null): Ac1999SeedSource | undefined {
  if (!store || !serverId) return undefined;
  const source: Ac1999SeedSource = async () => {
    const got = await store.loadServerSeed(serverId);
    if (!got) return null;
    const seed = ac1999SeedFromPayload(got.ref.hash, got.payload);
    const same = (a: DatIterations, b: DatIterations) => a.portal === b.portal && a.cell === b.cell;
    if (!same(seed.base, got.ref.base) || !same(seed.iterations, got.ref.iterations)) {
      throw new Error(`seed ${got.ref.hash} says ${seed.base.portal}/${seed.base.cell} → ${seed.iterations.portal}/${seed.iterations.cell}; the set pointer says otherwise`);
    }
    return seed;
  };
  if (store.pointer) {
    const pointer = store.pointer;
    source.describe = () => {
      const ref = pointer.serverSeeds?.[serverId];
      return ref ? { id: ref.hash, base: { ...ref.base }, iterations: { ...ref.iterations } } : null;
    };
  }
  return source;
}

/** `seed`: the seed the stored files were applied over (absent: they are the whole difference from the base). */
interface PatchManifest { portalIteration: number; cellIteration: number; files: Array<{ dat: 'portal' | 'cell'; id: number }>; seed?: string }

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
  /** The world's own iterations (the set's or the 1999 files'), before any patch. */
  readonly baseIterations: DatIterations;
  /** The seed the served patches were built on, or null. */
  private seedId: string | null = null;
  /** False after restore set the stored manifest aside: the next persist starts from nothing, not from it. */
  private storedTrusted = true;

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
    this.baseIterations = { portal: portal.totalIterations, cell: cell.totalIterations };
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

  /**
   * Inflate and apply a `datPatch1999` event; resolves to the files applied. When a file fails to
   * inflate the server's iterations are NOT adopted (the world keeps reporting the level it fully
   * holds, so the next login is sent the push again) and the caller must not persist the event:
   * `complete` says which.
   */
  async applyEvent(e: Ac1999PatchEvent): Promise<Ac1999Patch[] & { complete?: boolean }> {
    const files: Ac1999Patch[] & { complete?: boolean } = [];
    for (const p of e.patches) {
      try {
        files.push({ dat: p.dat, fileId: p.fileId >>> 0, bytes: await inflateAc1999Patch(p) });
      } catch (err) {
        console.warn(`[AC:1999] patch 0x${(p.fileId >>> 0).toString(16)} could not be inflated:`, err);
      }
    }
    files.complete = files.length === e.patches.length;
    if (!files.complete) console.warn(`[AC:1999] ${e.patches.length - files.length} of ${e.patches.length} pushed file(s) unusable: staying at ${this.iterations.portal} / ${this.iterations.cell}`);
    this.apply(files, files.complete ? { portal: e.portalIteration, cell: e.cellIteration } : { portal: 0, cell: 0 });
    return files;
  }

  /**
   * Persist `files` (merged into what the server already stored) and the current iterations. Never throws.
   * Calls run one after another: a second login's persist (a relog in the same page, reporting the
   * server's iteration, so no files) must read the manifest the first one writes, not run beside it and
   * store the server's iteration with none of its files while the first is still writing them.
   */
  persist(store: DatBlobStore, serverKey: string, files: readonly Ac1999Patch[]): Promise<void> {
    const run = this.persisting.then(() => this.persistNow(store, serverKey, files));
    this.persisting = run;
    return run;
  }

  private persisting: Promise<void> = Promise.resolve();

  private async persistNow(store: DatBlobStore, serverKey: string, files: readonly Ac1999Patch[]): Promise<void> {
    if (!store.available) return;
    let step = 'reading the stored manifest';
    try {
      const stored = await readManifest(store, serverKey);
      const prev = this.storedTrusted ? stored : null;
      const known = new Map((prev?.files ?? []).map((f) => [f.id >>> 0, f.dat] as const));
      for (const f of files) {
        step = `writing ${f.dat} 0x${(f.fileId >>> 0).toString(16)} (${f.bytes.byteLength} bytes)`;
        await store.put(ac1999PatchKey(serverKey, f.fileId), f.bytes, { size: f.bytes.byteLength, lastModified: null, etag: null });
        known.set(f.fileId >>> 0, f.dat);
      }
      const manifest: PatchManifest = {
        portalIteration: this.portalOverlay.iteration ?? 0,
        cellIteration: this.cellOverlay.iteration ?? 0,
        files: [...known].map(([id, dat]) => ({ dat, id })),
        ...(this.seedId ? { seed: this.seedId } : {}),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer;
      step = `writing the manifest (${files.length} new file(s))`;
      await store.put(manifestKey(serverKey), bytes, { size: bytes.byteLength, lastModified: null, etag: null });
      this.storedTrusted = true;
      // A manifest restore set aside leaves its files behind: remove the ones the new manifest doesn't list
      // (after it is written, so a closed tab leaves extra files, never a manifest naming removed ones).
      if (stored && !prev) {
        step = 'removing set-aside files';
        for (const f of stored.files) if (!known.has(f.id >>> 0)) await store.remove(ac1999PatchKey(serverKey, f.id));
      }
    } catch (err) {
      console.warn(`[AC:1999] could not store the server's DAT patches (${step}):`, err);
    }
  }

  /**
   * Load the patches stored for `serverKey` (once per key; a different key
   * replaces the previous server's). Resolves to the number of files applied.
   * Never throws: a missing or partial store means the server sends them again.
   *
   * The login then reports the newest state the client fully holds (the
   * server pushes the difference from whatever iteration is reported:
   * TurbineData.cpp GetSyncPlan), never one whose files it lacks:
   * - A stored state with no seed is a complete difference from the base.
   *   It is used when it is at or past the offered seed's level in both DATs
   *   (or nothing is offered); a seed above it in either DAT replaces it, and
   *   the stored files are set aside, not layered (they were diffed from the
   *   base, not from the seed). A server's iterations only rise, so two of
   *   its states are ordered in both DATs; a mixed pair (a server reset)
   *   takes the seed, which is always a whole, consistent state.
   * - A state built on a seed comes back only with that same seed (applied
   *   first, the stored files, the server's later pushes, over it) and only
   *   at or past its level; otherwise it is set aside.
   * - Nothing usable stored (none, incomplete, an empty baseline): the seed.
   * A seed applies only over the base it was diffed from. Whatever is set
   * aside is not merged by the next persist, which also removes its files.
   */
  async restore(store: DatBlobStore, serverKey: string, seed?: Ac1999SeedSource): Promise<number> {
    if (this.restoredFor === serverKey) return 0;
    if (this.restoredFor !== null) {
      for (const o of [this.portalOverlay, this.cellOverlay]) { o.patches.clear(); o.iteration = undefined; o.clearCache(); }
    }
    this.restoredFor = serverKey;
    this.seedId = null;
    this.storedTrusted = true;
    const base = this.baseIterations;
    const fromBase = (s: Ac1999SeedInfo | Ac1999Seed): boolean => s.base.portal === base.portal && s.base.cell === base.cell;
    let offered: Ac1999Seed | null | undefined;
    const getSeed = async (): Promise<Ac1999Seed | null> => {
      if (offered !== undefined) return offered;
      offered = null;
      if (!seed) return null;
      try {
        const s = await seed();
        if (s && !fromBase(s)) {
          console.warn(`[AC:1999] the server's seed was diffed from ${s.base.portal} / ${s.base.cell}, this world is ${base.portal} / ${base.cell}: not used`);
        } else offered = s;
      } catch (err) {
        console.warn('[AC:1999] could not load the server\'s DAT seed:', err);
      }
      return offered;
    };
    /** The offered seed's level: from the pointer's description when there is one (no fetch), else by loading it. */
    const seedLevel = async (): Promise<DatIterations | null> => {
      const info = seed?.describe ? seed.describe() : undefined;
      if (info !== undefined) return info && fromBase(info) ? info.iterations : null;
      const s = await getSeed();
      return s ? s.iterations : null;
    };
    // A manifest iteration of 0 means "not moved off the base" (apply() keeps the base for 0).
    const level = (m: PatchManifest): DatIterations => ({ portal: m.portalIteration || base.portal, cell: m.cellIteration || base.cell });
    const atLeast = (a: DatIterations, b: DatIterations) => a.portal >= b.portal && a.cell >= b.cell;
    try {
      const manifest = store.available ? await readManifest(store, serverKey) : null;
      if (manifest) {
        const files = await readStoredFiles(store, serverKey, manifest).catch(() => null);
        const have = level(manifest);
        if (files && !manifest.seed) {
          const target = await seedLevel();
          // A seed the pointer lists but that fails to load leaves the stored state the newest one held.
          if (!target || atLeast(have, target) || !(await getSeed())) {
            this.apply(files, { portal: manifest.portalIteration, cell: manifest.cellIteration });
            return files.length;
          }
          console.log(`[AC:1999] stored DAT patches at ${have.portal} / ${have.cell} are behind the server's seed (${target.portal} / ${target.cell}): set aside`);
        } else if (files && manifest.seed) {
          const s = await getSeed();
          if (s && s.id === manifest.seed && atLeast(have, s.iterations)) {
            this.apply(s.files, s.iterations);
            this.apply(files, { portal: manifest.portalIteration, cell: manifest.cellIteration });
            this.seedId = s.id;
            return s.files.length + files.length;
          }
          console.log(`[AC:1999] stored DAT patches were built on seed ${manifest.seed}, which is ${s ? (s.id === manifest.seed ? `above their stored ${have.portal} / ${have.cell}` : `now ${s.id}`) : 'not offered'}: set aside`);
        }
        // Incomplete, behind the seed, or built on another seed: the next persist must not merge it.
        this.storedTrusted = false;
      }
      const s = await getSeed();
      if (!s) return 0;
      this.apply(s.files, s.iterations);
      this.seedId = s.id;
      return s.files.length;
    } catch (err) {
      console.warn('[AC:1999] could not read the stored DAT patches:', err);
      return 0;
    }
  }
}

/** Every file a manifest lists, or null when one is missing (the server must resend them all). */
async function readStoredFiles(store: DatBlobStore, serverKey: string, manifest: PatchManifest): Promise<Ac1999Patch[] | null> {
  const files: Ac1999Patch[] = [];
  for (const f of manifest.files) {
    const bytes = await store.getData(ac1999PatchKey(serverKey, f.id));
    if (!bytes) return null;
    files.push({ dat: f.dat, fileId: f.id >>> 0, bytes });
  }
  return files;
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
      ...(typeof v.seed === 'string' && v.seed ? { seed: v.seed } : {}),
    };
  } catch {
    return null;
  }
}
