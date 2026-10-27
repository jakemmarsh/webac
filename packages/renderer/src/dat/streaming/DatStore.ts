/**
 * DatStore — the streamed DAT set (docs/dat-streaming.md §3.1 option (c),
 * "prefetch-then-sync"; RELEASE.dat-streaming).
 *
 * An async store fills an in-memory map of resident files; each DAT is a
 * normal DatDatabase over that map (DatResidentSource), so every consumer
 * keeps its synchronous getFileData → parse → build. The objects come from
 * the published set (tools/publish-dats-r2.ts):
 *
 *   pointer  v1/sets/<set>.json                    (fetched every launch, no-store)
 *   packs    boot / local / skeleton / world / terrain (whole, at boot)
 *   bundles  one per landblock: LandblockInfo + EnvCells (on demand)
 *   areas    one per tile of landblocks: every leaf their closures read (on
 *            demand, with the bundle; RELEASE.streaming-area-packs), plus one
 *            common pack of the leaves very many landblocks share (background)
 *   leaves   one per portal GfxObj / Animation / Palette / Texture / Wave / Environment, and every highres file
 *
 * Every object is gzip, inflated with DecompressionStream, checked against
 * its manifest size and content hash, and persisted in the ObjectCache by
 * hash (OPFS), so a second session reads it locally with no revalidation.
 *
 * A synchronous read of a file that exists but is not resident yet returns
 * null, notes a miss (DatMiss epoch + any open MissScope) and fetches it at
 * critical priority. The choke points (boot, portal-space gate, landblock
 * streamer, server objects) prefetch before their sync code runs so misses
 * stay rare; MissScope tells a builder what to wait for before it rebuilds.
 *
 * Fetches use cache: 'no-store': Chrome answered a full GET with only
 * previously cached Range bytes (2026-10-04), and OPFS is the cache. Every
 * body is length-checked (readResponseBytes) and hash-checked.
 *
 * Packs that are still downloading (skeleton, terrain: the background half
 * of boot) do not make their files look absent: a read of a file type such a
 * pack carries is a miss that resolves when the pack lands, so no cache
 * stores a negative entry for it.
 *
 * Memory (RELEASE.streaming-memory-and-progress): pack files stay resident
 * for the session; downloaded leaves and landblock bundles are an LRU bounded
 * by `residentCapBytes` (default DEFAULT_RESIDENT_CAP_BYTES). Only units not
 * read or landed for `minResidentAgeMs` are evicted, so nothing a gate or a
 * prefetch just made resident disappears before its build runs; an evicted
 * file is still in the set, and the next read is an ordinary miss (OPFS hit).
 * Every read returns a copy, so no consumer holds the evicted bytes.
 */
import { DatDatabase, type DatResidentSource } from '@ac/dat-parser/DatDatabase.js';
import { noteDatMiss, noteDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';
import {
  type AreaIndex, type DatName, type DatSetManifest, type DatSetPointer, type ObjectRef, type PackRole,
  DAT_CODE, PACK_DAT, SKELETON_TYPES, areaTileOf, datHeaderFor, iterationRecordBytes, objectKey, parseAreaIndex, parsePack, parseSetManifest, parseSetPointer,
} from '@ac/dat-parser/streaming/DatSetFormat.js';
import { readResponseBytes } from '../readResponseBytes.js';
import { NullObjectCache, type ObjectCache } from './ObjectCache.js';
import { streamHandlerCost } from '../../telemetry/MainThreadCost.js';

const ITERATION_FILE_ID = 0xffff0001;

/**
 * Downloaded leaves + landblock bundles kept resident (payload bytes). A cold
 * Holtburg login downloads ~14 MB gzip (≈ 32 MB payload) of them on top of
 * the packs, a teleport into a new town or dungeon 1.5–3.7 MB gzip
 * (docs/dat-streaming.md §6.2/§6.6): 256 MB is roughly 15–25 distinct
 * destinations before the first eviction. With the packs (~91 MB payload,
 * never evicted) a session stays under ~350 MB, against 1.28 GB of whole DATs.
 */
export const DEFAULT_RESIDENT_CAP_BYTES = 256 * 1024 * 1024;

/**
 * Network fetches in flight. Cloudflare (dats.playwebac.com) advertises
 * SETTINGS_MAX_CONCURRENT_STREAMS = 100 and Chrome multiplexes one HTTP/2
 * connection per origin, so 96 fills the connection with a little headroom.
 * An edge-cache miss costs ~0.5 s regardless of size, so a cold gate is
 * files / concurrency × that; 48 left half the connection idle
 * (RELEASE.streaming-gate-real-gpu-check, 2026-10-06).
 */
export const DEFAULT_MAX_CONCURRENT = 96;
/** A unit read or landed this recently is never evicted (longer than the portal-space gate's 90 s timeout). */
export const DEFAULT_MIN_RESIDENT_AGE_MS = 120_000;
/** Eviction trims to this fraction of the cap (hysteresis: one batch, not one file per fetch). */
const EVICT_TO_FRACTION = 0.85;

/**
 * PERF.warm-boot-slow-breakdown — one attempt at the set pointer (a ~1 KB
 * JSON, fetched no-store every launch: the one network request a warm boot
 * waits on) may take this long before it is aborted and tried again. Every
 * object fetch was retried; the pointer was not, so one dropped request
 * failed the whole boot, and a stalled one held it with no limit.
 */
export const POINTER_ATTEMPT_TIMEOUT_MS = 8000;

/** DatStore.open's own steps (DatStore.openTimings), ms from when each began. */
export interface DatStoreOpenTimings {
  /** The pointer fetch, every attempt and backoff included. */
  pointerMs: number;
  /** Pointer attempts made (1 = no retry). */
  pointerTries: number;
  /** The pointer's JSON length. */
  pointerBytes: number;
  /** After the pointer: the manifest loaded (cache or network) and parsed. */
  manifestMs: number;
  /** After the pointer: every boot-time pack resident. */
  packsMs: number;
}

/** Fetch priority: critical (a miss / a gate), prefetch (streamer ring), background (warm-fill). */
export enum FetchPriority { Critical = 0, Prefetch = 1, Background = 2 }

/** One DAT file, as a single number: dat code × 2^32 + id. */
export type FileKey = number;
export function fileKey(dat: DatName, id: number): FileKey {
  return DAT_CODE[dat] * 0x100000000 + (id >>> 0);
}
const DAT_OF_CODE: Record<number, DatName> = { 1: 'portal', 2: 'cell', 3: 'local', 4: 'highres' };
export function splitFileKey(key: FileKey): { dat: DatName; id: number } {
  return { dat: DAT_OF_CODE[Math.floor(key / 0x100000000)], id: key % 0x100000000 };
}

/**
 * Fetches one object's stored (gzip) bytes. `onBytes` hears each chunk of the
 * body as it arrives (a fetcher that cannot report is topped up when it
 * resolves), so a slow download shows progress before it lands.
 */
export type ObjectFetcher = (url: string, opts: { priority: FetchPriority; signal?: AbortSignal; onBytes?: (n: number) => void }) => Promise<Uint8Array>;

/** The browser fetcher: no-store, priority hint, length-checked body, bytes reported per chunk. */
export const browserObjectFetcher: ObjectFetcher = async (url, { priority, signal, onBytes }) => {
  const init: RequestInit & { priority?: string } = { cache: 'no-store', ...(signal ? { signal } : {}) };
  init.priority = priority === FetchPriority.Critical ? 'high' : priority === FetchPriority.Background ? 'low' : 'auto';
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`GET ${url}: HTTP ${resp.status}`);
  let seen = 0;
  return new Uint8Array(await readResponseBytes(resp, onBytes ? (_pct, loaded) => { onBytes(loaded - seen); seen = loaded; } : undefined));
};

/**
 * A link is slow when a saturated second (more bytes in flight than ~2 s of
 * it) moved less than this: 2 Mbit/s. A healthy link (the 50 Mbit/s the
 * streaming budget assumes) is ~25× this; a cold edge's latency-bound
 * trickle of small objects is not saturated, so it never counts.
 */
export const SLOW_LINK_BYTES_PER_S = 256 * 1024;
/**
 * On a slow link a fetch starts only while the bytes in flight stay under
 * about this many seconds of the measured rate (at least
 * SLOW_LINK_MIN_INFLIGHT_BYTES, and one fetch always may run): big objects go
 * one or two at a time, small ones still many, and nothing queues minutes of
 * download in front of the game's own traffic.
 */
export const SLOW_LINK_INFLIGHT_SECONDS = 2;
export const SLOW_LINK_MIN_INFLIGHT_BYTES = 32 * 1024;

/**
 * BUG.slow-link-fetch-flood (2026-10-20, live at 25 KB/s): 96 fetches in
 * flight split a slow link 96 ways, so no object landed for minutes (the
 * gate saw no progress) and the game's WebSocket got a sliver of the link
 * (the session dropped and resumed twice). LinkMeter watches the bytes in
 * flight and the rate they arrive at, one-second windows while anything is
 * in flight: a saturated window under SLOW_LINK_BYTES_PER_S marks the link
 * slow, any window at twice that marks it healthy again.
 */
export class LinkMeter {
  private inflight = 0;
  private winStart: number | null = null;
  private winBytes = 0;
  private _slow = false;
  /** The last window's rate, bytes/s (null before one closed). */
  rate: number | null = null;

  constructor(private readonly now: () => number) {}

  get slow(): boolean { this.roll(); return this._slow; }
  get inflightBytes(): number { return this.inflight; }
  /** While slow: the bytes that may be in flight. */
  get slowBudgetBytes(): number {
    return Math.max(SLOW_LINK_MIN_INFLIGHT_BYTES, SLOW_LINK_INFLIGHT_SECONDS * (this.rate ?? 0));
  }
  /** Whether a fetch of `bytes` may start with `running` running and `starting` bytes about to begin. */
  room(running: number, starting: number, bytes: number): boolean {
    if (!this.slow || running === 0) return true;
    return this.inflight + starting + bytes <= this.slowBudgetBytes;
  }

  /** A network fetch of `bytes` (its expected size) started. */
  begin(bytes: number): void {
    this.roll();
    if (this.inflight <= 0) { this.inflight = 0; this.winStart = this.now(); this.winBytes = 0; }
    this.inflight += Math.max(0, bytes);
  }

  /** `n` body bytes arrived. */
  received(n: number): void {
    if (!(n > 0)) return;
    this.winBytes += n;
    this.inflight = Math.max(0, this.inflight - n);
    this.roll();
  }

  /** A fetch ended (landed or failed) with `unreceived` of its expected bytes never arriving. */
  end(unreceived: number): void {
    this.inflight = Math.max(0, this.inflight - Math.max(0, unreceived));
    this.roll();
  }

  private roll(): void {
    if (this.winStart === null) return;
    const t = this.now();
    const ms = t - this.winStart;
    if (ms < 1000) return;
    const rate = this.winBytes / (ms / 1000);
    this.rate = rate;
    // Saturated: the bytes still in flight are more than ~2 s of this rate.
    if (rate >= 2 * SLOW_LINK_BYTES_PER_S) this._slow = false;
    else if (rate < SLOW_LINK_BYTES_PER_S && this.inflight > 2 * rate) this._slow = true;
    this.winStart = this.inflight > 0 ? t : null;
    this.winBytes = 0;
  }
}

/** gunzip with the platform DecompressionStream (browsers, Node ≥ 18). */
export async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Prefix(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
  let s = '';
  for (let i = 0; i < 8; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

/** Bytes moved, for the patch meter and the measurements in docs/dat-streaming.md. */
export interface DatStoreStats {
  /** Objects / gzip bytes fetched over the network. */
  netObjects: number;
  netBytes: number;
  /**
   * Body bytes received from the network so far, counted as they arrive (a
   * download in progress included; failed attempts too). The portal-space
   * gate reads it as progress: one object may take minutes on a slow link.
   */
  netReceivedBytes: number;
  /** Objects / gzip bytes served from the ObjectCache (OPFS). */
  cacheObjects: number;
  cacheBytes: number;
  /** Synchronous reads that found an existing file not resident. */
  misses: number;
  /** Misses per "<dat>:<type byte>" (e.g. "portal:06"): where gate / prefetch coverage is thin. */
  missesByType: Record<string, number>;
  /** Fetches that failed after retries. */
  failures: number;
  /** Network attempts after an object's first (each failed attempt that was tried again). */
  retries: number;
  /**
   * PERF.warm-boot-slow-breakdown — the object cache's side: objects it did
   * not serve (absent, unreadable or failing their size / hash check), the
   * time spent reading it (summed over objects, and the slowest one; queueing
   * for a disk slot excluded), and the time spent inflating + hash-checking
   * every object (cache and network, summed).
   */
  cacheMisses: number;
  cacheReadMs: number;
  cacheReadMaxMs: number;
  inflateMs: number;
  /** Missed files not resident yet (in flight): 0 once every miss has landed (the A/B gate's check). */
  unresolvedMisses: number;
  /** Payload bytes resident now: packs + leaves + bundles (what the session holds instead of whole DATs). */
  residentBytes: number;
  /** Of which pack payloads (resident for the session). */
  packBytes: number;
  /** Of which leaves + bundles (the LRU, bounded by residentCapBytes). */
  evictableBytes: number;
  /** Leaves / bundles evicted, and their payload bytes. */
  evictions: number;
  evictedBytes: number;
}

/** Collects the files a synchronous build missed (DatStore.beginScope / endScope). */
export class MissScope {
  readonly keys = new Set<FileKey>();
  get missed(): boolean { return this.keys.size > 0; }
}

export interface DatStoreOptions {
  /** The set pointer URL, e.g. https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json. */
  pointerUrl: string;
  fetchObject?: ObjectFetcher;
  /** Fetches the pointer JSON (default: fetch no-store). `signal` aborts an attempt that timed out. */
  fetchPointer?: (url: string, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  /** One pointer attempt's limit before it is tried again (default POINTER_ATTEMPT_TIMEOUT_MS). */
  pointerTimeoutMs?: number;
  cache?: ObjectCache;
  /** Concurrent network fetches (HTTP/2 streams; default DEFAULT_MAX_CONCURRENT). */
  maxConcurrent?: number;
  /** Check each payload's sha256 prefix against its key (default true). */
  verifyHash?: boolean;
  /** Packs to load before open() resolves (default: all five). */
  packs?: PackRole[];
  /** Progress over the packs + manifest: gzip bytes done / total. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  /** open(): each pack as it becomes resident (after the manifest), before open() resolves. */
  onPackResident?: (role: PackRole, store: DatStore) => void;
  /** Network failures after retries (console; the gate surfaces its own error). */
  onError?: (detail: string, err: unknown) => void;
  retries?: number;
  /** LRU bound on downloaded leaves + bundles (payload bytes; default DEFAULT_RESIDENT_CAP_BYTES). */
  residentCapBytes?: number;
  /** Units used more recently than this are never evicted (default DEFAULT_MIN_RESIDENT_AGE_MS). */
  minResidentAgeMs?: number;
  /** Clock for the LRU (tests). */
  now?: () => number;
}

/** One evictable resident unit: a leaf file, or a landblock bundle (all its cell files). */
interface ResidentUnit {
  bytes: number;
  touched: number;
  /** Leaf: its DAT + id. Bundle: the landblock. */
  dat: DatName;
  id: number;
  bundle: boolean;
}
/** LRU key of a bundle unit (leaf units use their FileKey, which is ≥ 2^32). */
const bundleUnitKey = (lb: number): number => lb & 0xffff;

/**
 * One object load's place in the limiters. A load requested again at a
 * higher priority (a gate's critical request joining a background prefetch
 * of the same object) is promoted, so it never waits behind the work it
 * should pre-empt (RELEASE.streaming-charselect-weight: priority inversion).
 */
class Ticket {
  queuedIn: Limiter | null = null;
  wake: (() => void) | null = null;
  /** The network download's expected size (gzip bytes), for the slow-link rule. */
  bytes = 0;
  constructor(public priority: FetchPriority) {}
  promote(priority: FetchPriority): void {
    if (priority >= this.priority) return;
    if (this.queuedIn) this.queuedIn.requeue(this, priority);
    else this.priority = priority;
  }
}

/** How a limiter may start work beyond its fixed max (the network limiter's link rules). */
interface LimiterPolicy {
  /** Whether a ticket of `bytes` may start now: `running` running, `starting` bytes woken but not begun. */
  room(running: number, starting: number, bytes: number): boolean;
  /** Non-critical work waits while critical work is running or queued. */
  holdNonCritical: boolean;
}

/**
 * A tiny priority-ordered concurrency limiter. With a policy (the network
 * limiter): prefetch and background work do not start while a critical load
 * (a portal-space gate, a miss) runs or waits, so a gate gets the link to
 * itself, and on a slow link a fetch starts only while the bytes in flight
 * fit SLOW_LINK_INFLIGHT_SECONDS of it (LinkMeter.room).
 * Work already running is never cut off.
 */
class Limiter {
  private readonly active = new Set<Ticket>();
  /** Woken by pump but not yet running fn (their bytes are not in the link meter yet). */
  private readonly waking = new Set<Ticket>();
  private readonly queues: Ticket[][] = [[], [], []];
  constructor(private readonly max: number, private readonly policy: LimiterPolicy | null = null) {}

  private criticalWaiting(): boolean {
    if (this.queues[0].length > 0) return true;
    for (const t of this.active) if (t.priority === FetchPriority.Critical) return true;
    return false;
  }

  private canStart(ticket: Ticket, priority: FetchPriority = ticket.priority): boolean {
    if (this.active.size >= this.max) return false;
    if (!this.policy) return true;
    if (this.policy.holdNonCritical && priority !== FetchPriority.Critical && this.criticalWaiting()) return false;
    let starting = 0;
    for (const t of this.waking) starting += t.bytes;
    return this.policy.room(this.active.size, starting, ticket.bytes);
  }

  async run<T>(ticket: Ticket, fn: () => Promise<T>): Promise<T> {
    const ahead = this.queues.slice(0, ticket.priority + 1).some((q) => q.length > 0);
    if (ahead || !this.canStart(ticket)) {
      await new Promise<void>((r) => { ticket.wake = r; ticket.queuedIn = this; this.queues[ticket.priority].push(ticket); });
    }
    this.waking.delete(ticket);
    this.active.add(ticket);
    try {
      return await fn();
    } finally {
      this.active.delete(ticket);
      this.pump();
    }
  }

  /** Start every queued ticket the rules allow now (after a finish, or when the link's state changed). */
  pump(): void {
    for (;;) {
      let next: Ticket | undefined;
      for (let p = 0; p < this.queues.length && !next; p++) {
        const q = this.queues[p];
        if (q.length > 0 && this.canStart(q[0], p as FetchPriority)) next = q.shift();
        // A queue that cannot start blocks the lower ones (priority order).
        else if (q.length > 0) break;
      }
      if (!next) return;
      const wake = next.wake!;
      next.wake = null;
      next.queuedIn = null;
      // Counted at once (active, and its bytes as starting), so this loop's canStart sees it.
      this.active.add(next);
      this.waking.add(next);
      wake();
    }
  }

  /** Move a queued ticket to a higher-priority queue. */
  requeue(ticket: Ticket, priority: FetchPriority): void {
    const q = this.queues[ticket.priority];
    const i = q.indexOf(ticket);
    if (i >= 0) q.splice(i, 1);
    ticket.priority = priority;
    this.queues[priority].push(ticket);
    this.pump();
  }
  get pending(): number { return this.queues[0].length + this.queues[1].length + this.queues[2].length; }
  get running(): number { return this.active.size; }
}

export class DatStore {
  readonly stats: DatStoreStats = {
    netObjects: 0, netBytes: 0, netReceivedBytes: 0, cacheObjects: 0, cacheBytes: 0, misses: 0, missesByType: {}, failures: 0, retries: 0, unresolvedMisses: 0,
    cacheMisses: 0, cacheReadMs: 0, cacheReadMaxMs: 0, inflateMs: 0,
    residentBytes: 0, packBytes: 0, evictableBytes: 0, evictions: 0, evictedBytes: 0,
  };
  /** Resident file bytes per DAT (views into packs / bundles / leaf payloads). */
  private readonly resident: Record<DatName, Map<number, Uint8Array>> = { portal: new Map(), cell: new Map(), local: new Map(), highres: new Map() };
  /** Ids known to exist per DAT, beyond the leaf tables (pack indexes). */
  private readonly packIds: Record<DatName, Set<number>> = { portal: new Set(), cell: new Set(), local: new Set(), highres: new Set() };
  private readonly loadedPacks = new Set<PackRole>();
  private readonly packLoads = new Map<PackRole, Promise<void>>();
  /** Landblocks (0xXXYY) whose bundle is resident. */
  private readonly residentBundles = new Set<number>();
  /** Landblock (0xXXYY) → the cell ids its resident bundle holds. */
  private readonly bundleFileIds = new Map<number, number[]>();
  private readonly bundleLoads = new Map<number, Promise<void>>();
  /** The area index (RELEASE.streaming-area-packs), once loaded; its load. */
  private areaIndex: AreaIndex | null = null;
  private areaIndexLoad: Promise<AreaIndex | null> | null = null;
  /** Tiles whose area pack has landed (cleared by an eviction: its leaves may be gone). */
  private readonly loadedAreas = new Set<number>();
  private readonly areaLoads = new Map<number, Promise<void>>();
  private commonLoad: Promise<void> | null = null;
  private readonly objectLoads = new Map<string, { promise: Promise<Uint8Array>; ticket: Ticket }>();
  private readonly fileLoads = new Map<FileKey, Promise<boolean>>();
  private readonly scopes: MissScope[] = [];
  private readonly dbs = new Map<DatName, DatDatabase>();
  private readonly limiter: Limiter;
  private readonly disk = new Limiter(32);
  /** The network link's state (LinkMeter): a slow link starts fewer fetches. */
  readonly link: LinkMeter;
  private readonly fetchObject: ObjectFetcher;
  private readonly cache: ObjectCache;
  private readonly verifyHash: boolean;
  private readonly retries: number;
  private readonly onError: (detail: string, err: unknown) => void;
  private readonly residentListeners = new Set<(key: FileKey) => void>();
  /** Files a synchronous read missed that have not landed yet (stats.unresolvedMisses). */
  private readonly missedKeys = new Set<FileKey>();
  /** Evictable units in least-recently-used order (Map insertion order; a touch re-inserts). */
  private readonly lru = new Map<number, ResidentUnit>();
  private readonly evictListeners = new Set<() => void>();
  private readonly residentCap: number;
  private readonly minResidentAge: number;
  private readonly now: () => number;

  private constructor(
    readonly baseUrl: string,
    readonly pointer: DatSetPointer,
    private _manifest: DatSetManifest,
    opts: DatStoreOptions,
  ) {
    this.fetchObject = opts.fetchObject ?? browserObjectFetcher;
    this.cache = opts.cache ?? new NullObjectCache();
    this.verifyHash = opts.verifyHash ?? true;
    this.retries = opts.retries ?? 3;
    this.onError = opts.onError ?? ((d, e) => console.warn(`[DatStore] ${d}`, e));
    this.residentCap = opts.residentCapBytes ?? DEFAULT_RESIDENT_CAP_BYTES;
    this.minResidentAge = opts.minResidentAgeMs ?? DEFAULT_MIN_RESIDENT_AGE_MS;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.link = new LinkMeter(this.now);
    const link = this.link;
    this.limiter = new Limiter(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, {
      room: (running, starting, bytes) => link.room(running, starting, bytes),
      holdNonCritical: true,
    });
  }

  /** The parsed binary manifest (leaf / pack / bundle tables). */
  get manifest(): DatSetManifest { return this._manifest; }

  /** How open() spent its time (zeros for a store made with fromParts). */
  openTimings: DatStoreOpenTimings = { pointerMs: 0, pointerTries: 0, pointerBytes: 0, manifestMs: 0, packsMs: 0 };

  /** The object root for a pointer URL: everything before "/v1/sets/". */
  static baseUrlOf(pointerUrl: string): string {
    const i = pointerUrl.indexOf('/v1/sets/');
    if (i < 0) throw new Error(`not a set pointer URL (no /v1/sets/): ${pointerUrl}`);
    return pointerUrl.slice(0, i);
  }

  /**
   * Fetch the pointer, the manifest and the boot-time packs; resolve once
   * they are resident. Byte progress covers manifest + packs.
   */
  static async open(opts: DatStoreOptions): Promise<DatStore> {
    const base = DatStore.baseUrlOf(opts.pointerUrl);
    const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const fetchPointer = opts.fetchPointer ?? (async (url: string, o?: { signal?: AbortSignal }) => {
      const r = await fetch(url, { cache: 'no-store', ...(o?.signal ? { signal: o.signal } : {}) });
      if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
      return r.json();
    });
    const tp = now();
    const got = await fetchPointerRetried(opts.pointerUrl, fetchPointer, opts.retries ?? 3, opts.pointerTimeoutMs ?? POINTER_ATTEMPT_TIMEOUT_MS);
    const pointer = parseSetPointer(got.raw);
    const timings: DatStoreOpenTimings = { pointerMs: Math.round(now() - tp), pointerTries: got.tries, pointerBytes: got.bytes, manifestMs: 0, packsMs: 0 };
    const tm = now();
    const roles = opts.packs ?? (['boot', 'local', 'skeleton', 'world', 'terrain'] as PackRole[]);
    const total = pointer.manifest.gzSize + roles.reduce((s, r) => s + (pointer.packs[r]?.gzSize ?? 0), 0);
    let done = 0;
    const tick = (n: number) => { done += n; opts.onProgress?.(done, total); };
    // The manifest and the packs in parallel (the pointer names the packs).
    const store = new DatStore(base, pointer, { leaves: { portal: new Map(), highres: new Map() }, packs: new Map(), bundles: new Map() }, opts);
    store.openTimings = timings;
    const manifestBytes = store.loadObject(pointer.manifest, FetchPriority.Critical).then((b) => { tick(pointer.manifest.gzSize); return b; });
    const packBytes = roles.map((role) => {
      const ref = pointer.packs[role];
      if (!ref) return Promise.resolve(null);
      return store.loadObject(ref, FetchPriority.Critical).then((b) => { tick(ref.gzSize); return b; });
    });
    store._manifest = parseSetManifest(await manifestBytes);
    timings.manifestMs = Math.round(now() - tm);
    // Each pack is resident as soon as it lands (the splash draws from boot + local while a bigger pack is in flight).
    await Promise.all(packBytes.map((p, i) => p.then((b) => {
      if (!b) return;
      store.addPack(roles[i], b);
      opts.onPackResident?.(roles[i], store);
    })));
    timings.packsMs = Math.round(now() - tm);
    return store;
  }

  /**
   * A store over an already-parsed pointer + manifest (tests, tools, and a
   * future local-install source). Packs are added with addPackBytes.
   */
  static fromParts(baseUrl: string, pointer: DatSetPointer, manifest: DatSetManifest, opts: Omit<DatStoreOptions, 'pointerUrl'> = {}): DatStore {
    return new DatStore(baseUrl, pointer, manifest, { pointerUrl: `${baseUrl}/v1/sets/${pointer.set}.json`, ...opts });
  }

  /** Make a pack's files resident from its payload bytes ("ACPK"). */
  addPackBytes(role: PackRole, bytes: Uint8Array): void {
    this.addPack(role, bytes);
  }

  /** The DatDatabase over one DAT's resident files (created once). */
  db(dat: DatName): DatDatabase {
    let db = this.dbs.get(dat);
    if (!db) {
      db = new DatDatabase(this.residentSource(dat));
      this.dbs.set(dat, db);
    }
    return db;
  }

  /** Is the file resident (readable synchronously right now)? */
  isResident(dat: DatName, id: number): boolean {
    return this.resident[dat].has(id >>> 0) || ((id >>> 0) === ITERATION_FILE_ID && this.pointer.iterations[dat] > 0);
  }

  /** A resident file's bytes (a view: do not modify), without counting a miss. Null when not resident. */
  peek(dat: DatName, id: number): Uint8Array | null {
    return this.resident[dat].get(id >>> 0) ?? null;
  }

  /** The cell ids in a landblock's resident bundle ([] when not resident or none). */
  bundleIds(landblock: number): readonly number[] {
    return this.bundleFileIds.get(landblock & 0xffff) ?? [];
  }

  /** Whether a landblock's bundle (LandblockInfo + EnvCells) is resident, or it has none. */
  isBundleResident(landblock: number): boolean {
    const lb = landblock & 0xffff;
    return this.residentBundles.has(lb) || !this.manifest.bundles.has(lb);
  }

  /**
   * Whether the file exists in the set. A cell file inside a landblock whose
   * bundle is not resident yet counts as existing (it may; the bundle says).
   */
  exists(dat: DatName, id: number): boolean {
    id >>>= 0;
    if (this.resident[dat].has(id) || this.packIds[dat].has(id)) return true;
    if (id === ITERATION_FILE_ID) return this.pointer.iterations[dat] > 0;
    switch (dat) {
      case 'portal':
        // A skeleton-type file while the skeleton pack is still downloading: maybe (the pack says).
        if (SKELETON_TYPES.has(id >>> 24) && this.packPending('skeleton')) return true;
        return this.manifest.leaves.portal.has(id);
      case 'highres':
        return this.manifest.leaves[dat].has(id);
      case 'cell': {
        // The terrain pack lists every CellLandblock: maybe, while it is still downloading.
        if ((id & 0xffff) === 0xffff) return this.packPending('terrain');
        const lb = id >>> 16;
        return this.manifest.bundles.has(lb) && !this.residentBundles.has(lb);
      }
      default:
        return false;
    }
  }

  /** Make one file resident. Resolves true when resident, false when the set has no such file. */
  request(dat: DatName, id: number, priority: FetchPriority = FetchPriority.Prefetch): Promise<boolean> {
    id >>>= 0;
    if (this.isResident(dat, id)) return Promise.resolve(true);
    const key = fileKey(dat, id);
    const inflight = this.fileLoads.get(key);
    if (inflight) { this.promoteFile(dat, id, priority); return inflight; }
    const p = this.loadFile(dat, id, priority).finally(() => this.fileLoads.delete(key));
    this.fileLoads.set(key, p);
    return p;
  }

  /** Make every key resident (absent files are skipped). Rejects if a fetch fails after retries. */
  async ensure(keys: Iterable<FileKey>, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    const ps: Promise<boolean>[] = [];
    for (const k of keys) {
      const { dat, id } = splitFileKey(k);
      if (!this.isResident(dat, id)) ps.push(this.request(dat, id, priority));
    }
    await Promise.all(ps);
  }

  /** Make a landblock's bundle resident (no-op for a block without one). */
  ensureBundle(landblock: number, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    const lb = landblock & 0xffff;
    if (this.residentBundles.has(lb)) return Promise.resolve();
    const ref = this.manifest.bundles.get(lb);
    if (!ref) return Promise.resolve();
    let p = this.bundleLoads.get(lb);
    if (p) this.promote(ref.hash, priority);
    if (!p) {
      // PERF.slow-first-minute-diagnostics — a landing's main-thread cost (telemetry/MainThreadCost.ts).
      p = this.loadObject(ref, priority).then((bytes) => streamHandlerCost.time('bundle', () => {
        const pack = parsePack(bytes);
        const cell = this.resident.cell;
        for (const [id, view] of pack.files) cell.set(id >>> 0, view);
        this.residentBundles.add(lb);
        this.bundleFileIds.set(lb, pack.ids.map((id) => id >>> 0));
        this.addUnit(bundleUnitKey(lb), { bytes: bytes.byteLength, touched: this.now(), dat: 'cell', id: lb, bundle: true });
        for (const id of pack.ids) this.emitResident(fileKey('cell', id));
        this.evictIfOverCap();
      })).finally(() => this.bundleLoads.delete(lb));
      this.bundleLoads.set(lb, p);
    }
    return p;
  }

  /**
   * The set's area index (RELEASE.streaming-area-packs), loaded once. Null
   * when the set has none or it failed: every leaf then streams on its own
   * through the closure walk, exactly as before area packs existed.
   */
  loadAreaIndex(priority: FetchPriority = FetchPriority.Prefetch): Promise<AreaIndex | null> {
    const ref = this.pointer.areas;
    if (!ref) return Promise.resolve(null);
    if (this.areaIndexLoad) { this.promote(ref.hash, priority); return this.areaIndexLoad; }
    this.areaIndexLoad = this.loadObject(ref, priority).then((b) => (this.areaIndex = parseAreaIndex(b))).catch((err) => {
      this.onError('area index failed: leaves stream one by one', err);
      return null;
    });
    return this.areaIndexLoad;
  }

  /**
   * Make the area pack of a landblock's tile resident: every leaf the tile's
   * landblocks read, in one object, fetched alongside the bundle
   * (DatClosure.ensureLandblock). A cold destination then costs a request or
   * two instead of a dependency chain of hundreds of single files, each of
   * which waits up to seconds on a cold Cloudflare edge
   * (RELEASE.streaming-area-packs). Never rejects: a failed area pack leaves
   * the walk to fetch the files one by one.
   */
  ensureArea(landblock: number, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    if (!this.pointer.areas) return Promise.resolve();
    const index = this.areaIndex;
    if (index && this.loadedAreas.has(areaTileOf(landblock, index.tileSize))) return Promise.resolve();
    // Until the index lands, coalesce by landblock; after, by tile.
    const loadKey = index ? 0x10000 + areaTileOf(landblock, index.tileSize) : landblock & 0xffff;
    const inflight = this.areaLoads.get(loadKey);
    if (inflight) {
      const ref = index?.areas.get(areaTileOf(landblock, index.tileSize));
      this.promote(ref ? ref.hash : this.pointer.areas.hash, priority);
      return inflight;
    }
    const p = (async () => {
      const idx = this.areaIndex ?? await this.loadAreaIndex(priority);
      if (!idx) return;
      const tile = areaTileOf(landblock, idx.tileSize);
      if (this.loadedAreas.has(tile)) return;
      const ref = idx.areas.get(tile);
      // Loads of one tile started before the index landed share the object (loadObject coalesces by hash).
      if (ref) { const bytes = await this.loadObject(ref, priority); if (!this.loadedAreas.has(tile)) this.addLeafPack(bytes, true); }
      this.loadedAreas.add(tile);
    })().catch((err) => {
      this.onError(`area pack for landblock ${(landblock & 0xffff).toString(16).padStart(4, '0')} failed: its leaves stream one by one`, err);
    }).finally(() => this.areaLoads.delete(loadKey));
    this.areaLoads.set(loadKey, p);
    return p;
  }

  /**
   * The common pack: the leaves many landblocks share (scenery, town art),
   * left out of every area pack. Resident for the session once loaded, like
   * the other packs. Never rejects.
   */
  ensureCommonPack(priority: FetchPriority = FetchPriority.Background): Promise<void> {
    if (!this.commonLoad) {
      this.commonLoad = this.loadAreaIndex(priority).then(async (index) => {
        if (index?.common) this.addLeafPack(await this.loadObject(index.common, priority), false);
      }).catch((err) => { this.onError('common pack failed: its leaves stream one by one', err); });
    }
    return this.commonLoad;
  }

  /** Whether a landblock's area pack has landed (tests / probes). */
  isAreaResident(landblock: number): boolean {
    return !!this.areaIndex && this.loadedAreas.has(areaTileOf(landblock, this.areaIndex.tileSize));
  }

  /**
   * Object loads in flight that someone is waiting on (critical and prefetch
   * priority; background warm-fill is left out), from the network or the
   * object cache. The power bar's "Download: done / total" during a
   * portal-space hold counts these (PortalSpaceGate PrefetchStatus).
   */
  get activeLoads(): number {
    let n = 0;
    for (const { ticket } of this.objectLoads.values()) if (ticket.priority !== FetchPriority.Background) n++;
    return n;
  }

  /** Whether a pack's files are resident. */
  isPackResident(role: PackRole): boolean {
    return this.loadedPacks.has(role);
  }

  /** The set has this pack and it is not resident (yet): its files may exist. */
  private packPending(role: PackRole): boolean {
    return !this.loadedPacks.has(role) && !!(this.manifest.packs.get(role) ?? this.pointer.packs[role]);
  }

  /** Load one of the set's packs (no-op when resident). */
  ensurePack(role: PackRole, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    if (this.loadedPacks.has(role)) return Promise.resolve();
    let p = this.packLoads.get(role);
    if (p) { const ref = this.manifest.packs.get(role) ?? this.pointer.packs[role]; if (ref) this.promote(ref.hash, priority); }
    if (!p) {
      const ref = this.manifest.packs.get(role) ?? this.pointer.packs[role];
      if (!ref) return Promise.resolve();
      p = this.loadObject(ref, priority).then((b) => this.addPack(role, b)).finally(() => this.packLoads.delete(role));
      this.packLoads.set(role, p);
    }
    return p;
  }

  /**
   * Called after the LRU evicted leaves / bundles (closure caches that
   * assume residency only grows reset here).
   */
  onEvict(listener: () => void): () => void {
    this.evictListeners.add(listener);
    return () => this.evictListeners.delete(listener);
  }

  /** Called with each file key that becomes resident through a fetch. */
  onResident(listener: (key: FileKey) => void): () => void {
    this.residentListeners.add(listener);
    return () => this.residentListeners.delete(listener);
  }

  /** Start collecting misses; every open scope records each miss. */
  beginScope(): MissScope {
    const s = new MissScope();
    this.scopes.push(s);
    return s;
  }

  endScope(scope: MissScope): MissScope {
    const i = this.scopes.lastIndexOf(scope);
    if (i >= 0) this.scopes.splice(i, 1);
    return scope;
  }

  /** Run a synchronous build inside a miss scope. */
  scoped<T>(fn: () => T): { result: T; scope: MissScope } {
    const scope = this.beginScope();
    try {
      return { result: fn(), scope };
    } finally {
      this.endScope(scope);
    }
  }

  /** Network requests waiting for a slot (all priorities). */
  get queuedFetches(): number { return this.limiter.pending; }

  // ── internals ────────────────────────────────────────────────────────────

  private emitResident(key: FileKey): void {
    // A file some build missed is resident now: tell the repaint listeners (DatMiss).
    if (this.missedKeys.delete(key)) {
      this.stats.unresolvedMisses = this.missedKeys.size;
      noteDatMissResolved();
    }
    for (const l of this.residentListeners) {
      try { l(key); } catch { /* a listener never breaks the store */ }
    }
  }

  /**
   * Make a pack of portal leaves resident (an area pack or the common pack).
   * Area leaves are copied out into LRU units of their own, so evicting one
   * frees it; the common pack's are views that stay for the session.
   */
  private addLeafPack(bytes: Uint8Array, evictable: boolean): void {
    streamHandlerCost.time(evictable ? 'area' : 'common', () => this.addLeafPackNow(bytes, evictable));
  }

  private addLeafPackNow(bytes: Uint8Array, evictable: boolean): void {
    const map = this.resident.portal;
    const pack = parsePack(bytes);
    for (const [rawId, view] of pack.files) {
      const id = rawId >>> 0;
      const key = fileKey('portal', id);
      if (map.has(id)) {
        if (evictable) continue;
        // Fetched earlier as a leaf: the pack's copy is resident for good.
        const unit = this.lru.get(key);
        if (unit) { this.dropUnit(key, unit); map.set(id, view); }
        continue;
      }
      if (evictable) {
        const copy = view.slice();
        map.set(id, copy);
        this.addUnit(key, { bytes: copy.byteLength, touched: this.now(), dat: 'portal', id, bundle: false });
      } else {
        map.set(id, view);
      }
      this.emitResident(key);
    }
    if (!evictable) {
      this.stats.packBytes += bytes.byteLength;
      this.stats.residentBytes += bytes.byteLength;
    }
    this.evictIfOverCap();
  }

  private addPack(role: PackRole, bytes: Uint8Array): void {
    streamHandlerCost.time(`pack_${role}`, () => this.addPackNow(role, bytes));
  }

  private addPackNow(role: PackRole, bytes: Uint8Array): void {
    const dat = PACK_DAT[role];
    const pack = parsePack(bytes);
    const map = this.resident[dat];
    const ids = this.packIds[dat];
    for (const [rawId, view] of pack.files) {
      const id = rawId >>> 0;
      ids.add(id);
      if (!map.has(id)) { map.set(id, view); continue; }
      // Fetched earlier as a leaf (before this pack landed): the pack's copy is resident for good.
      const unit = this.lru.get(fileKey(dat, id));
      if (unit) { this.dropUnit(fileKey(dat, id), unit); map.set(id, view); }
    }
    if (!this.loadedPacks.has(role)) {
      this.stats.packBytes += bytes.byteLength;
      this.stats.residentBytes += bytes.byteLength;
    }
    this.loadedPacks.add(role);
    // Reads that missed while this pack was downloading have landed.
    for (const key of [...this.missedKeys]) {
      const { dat: d, id } = splitFileKey(key);
      if (d === dat && map.has(id)) this.emitResident(key);
    }
  }

  // ── LRU over leaves + bundles ────────────────────────────────────────────

  private addUnit(key: number, unit: ResidentUnit): void {
    const old = this.lru.get(key);
    if (old) this.dropUnit(key, old);
    this.lru.set(key, unit);
    this.stats.evictableBytes += unit.bytes;
    this.stats.residentBytes += unit.bytes;
  }

  /** Forget a unit's accounting (its files stay or go with the caller). */
  private dropUnit(key: number, unit: ResidentUnit): void {
    this.lru.delete(key);
    this.stats.evictableBytes -= unit.bytes;
    this.stats.residentBytes -= unit.bytes;
  }

  /** A read of a resident file: its unit becomes the most recently used. */
  private touch(dat: DatName, id: number): void {
    let key: number;
    if (dat === 'cell') {
      if ((id & 0xffff) === 0xffff) return; // terrain pack
      key = bundleUnitKey(id >>> 16);
    } else {
      key = fileKey(dat, id);
    }
    const unit = this.lru.get(key);
    if (!unit) return; // a pack file
    unit.touched = this.now();
    this.lru.delete(key);
    this.lru.set(key, unit);
  }

  /**
   * Over the cap: evict least-recently-used units down to EVICT_TO_FRACTION of
   * it, oldest first, never one used within minResidentAge (the cap is soft:
   * a burst of recent files may exceed it until they age).
   */
  private evictIfOverCap(): void {
    if (this.stats.evictableBytes <= this.residentCap) return;
    const target = this.residentCap * EVICT_TO_FRACTION;
    const cutoff = this.now() - this.minResidentAge;
    let evicted = 0;
    for (const [key, unit] of this.lru) {
      if (this.stats.evictableBytes <= target || unit.touched > cutoff) break;
      this.dropUnit(key, unit);
      if (unit.bundle) {
        const lb = unit.id;
        for (const cid of this.bundleFileIds.get(lb) ?? []) this.resident.cell.delete(cid);
        this.bundleFileIds.delete(lb);
        this.residentBundles.delete(lb);
      } else {
        this.resident[unit.dat].delete(unit.id);
      }
      this.stats.evictions++;
      this.stats.evictedBytes += unit.bytes;
      evicted++;
    }
    if (evicted > 0) {
      this.loadedAreas.clear();
      for (const l of this.evictListeners) {
        try { l(); } catch { /* a listener never breaks the store */ }
      }
    }
  }

  private async loadFile(dat: DatName, id: number, priority: FetchPriority): Promise<boolean> {
    if (dat === 'portal' || dat === 'highres') {
      const leaf = this.manifest.leaves[dat].get(id);
      if (!leaf) {
        // Every non-leaf portal file is in a pack: wait for the skeleton when it is still downloading.
        if (dat === 'portal' && SKELETON_TYPES.has(id >>> 24) && this.packPending('skeleton')) {
          await this.ensurePack('skeleton', priority);
          return this.resident.portal.has(id);
        }
        return false;
      }
      const payload = await this.loadObject(leaf, priority);
      streamHandlerCost.time('leaf', () => {
        if (!this.resident[dat].has(id)) {
          this.resident[dat].set(id, payload);
          this.addUnit(fileKey(dat, id), { bytes: payload.byteLength, touched: this.now(), dat, id, bundle: false });
        }
        this.emitResident(fileKey(dat, id));
        this.evictIfOverCap();
      });
      return true;
    }
    if (dat === 'cell') {
      if ((id & 0xffff) === 0xffff) {
        if (!this.resident.cell.has(id) && this.packPending('terrain')) await this.ensurePack('terrain', priority);
        return this.resident.cell.has(id);
      }
      await this.ensureBundle(id >>> 16, priority);
      return this.resident.cell.has(id);
    }
    return this.resident[dat].has(id);
  }

  /** One object's payload: ObjectCache, else network (retried), inflated and verified. Coalesced by hash. */
  private loadObject(ref: ObjectRef, priority: FetchPriority): Promise<Uint8Array> {
    const inflight = this.objectLoads.get(ref.hash);
    if (inflight) {
      inflight.ticket.promote(priority);
      return inflight.promise;
    }
    const ticket = new Ticket(priority);
    const promise = this.fetchAndVerify(ref, ticket).finally(() => this.objectLoads.delete(ref.hash));
    this.objectLoads.set(ref.hash, { promise, ticket });
    return promise;
  }

  /** An in-flight object load is now wanted at `priority`. */
  private promote(hash: string, priority: FetchPriority): void {
    this.objectLoads.get(hash)?.ticket.promote(priority);
  }

  /** An in-flight file request is now wanted at `priority`: promote the object it waits on. */
  private promoteFile(dat: DatName, id: number, priority: FetchPriority): void {
    if (dat === 'portal' || dat === 'highres') {
      const leaf = this.manifest.leaves[dat].get(id);
      if (leaf) this.promote(leaf.hash, priority);
      else if (dat === 'portal') this.promotePack('skeleton', priority);
    } else if (dat === 'cell') {
      if ((id & 0xffff) === 0xffff) this.promotePack('terrain', priority);
      else { const b = this.manifest.bundles.get(id >>> 16); if (b) this.promote(b.hash, priority); }
    }
  }

  private promotePack(role: PackRole, priority: FetchPriority): void {
    const ref = this.manifest.packs.get(role) ?? this.pointer.packs[role];
    if (ref) this.promote(ref.hash, priority);
  }

  private async fetchAndVerify(ref: ObjectRef, ticket: Ticket): Promise<Uint8Array> {
    const cached = await this.disk.run(ticket, async () => {
      const t = this.now();
      try {
        return await this.cache.get(ref.hash);
      } finally {
        const ms = this.now() - t;
        this.stats.cacheReadMs += ms;
        if (ms > this.stats.cacheReadMaxMs) this.stats.cacheReadMaxMs = ms;
      }
    });
    if (cached) {
      const payload = await this.inflateChecked(cached, ref).catch(() => null);
      if (payload) {
        this.stats.cacheObjects++;
        this.stats.cacheBytes += cached.byteLength;
        return payload;
      }
    }
    this.stats.cacheMisses++;
    const url = `${this.baseUrl}/${objectKey(ref.hash)}`;
    let lastErr: unknown = null;
    ticket.bytes = ref.gzSize;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
      try {
        const gz = await this.limiter.run(ticket, async () => {
          let got = 0;
          this.link.begin(ref.gzSize);
          const onBytes = (n: number): void => {
            if (!(n > 0)) return;
            got += n;
            this.stats.netReceivedBytes += n;
            this.link.received(n);
          };
          try {
            const bytes = await this.fetchObject(url, { priority: ticket.priority, onBytes });
            if (bytes.byteLength > got) onBytes(bytes.byteLength - got); // a fetcher that reports nothing (or not all)
            return bytes;
          } finally {
            this.link.end(ref.gzSize - got);
          }
        });
        if (gz.byteLength !== ref.gzSize) throw new Error(`${ref.hash}: got ${gz.byteLength} bytes, manifest says ${ref.gzSize}`);
        const payload = await this.inflateChecked(gz, ref);
        this.stats.netObjects++;
        this.stats.netBytes += gz.byteLength;
        void this.cache.put(ref.hash, gz);
        return payload;
      } catch (err) {
        lastErr = err;
      }
    }
    this.stats.failures++;
    this.onError(`object ${ref.hash} failed after ${this.retries + 1} attempts`, lastErr);
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async inflateChecked(gz: Uint8Array, ref: ObjectRef): Promise<Uint8Array> {
    const t = this.now();
    try {
      return await this.inflateCheckedNow(gz, ref);
    } finally {
      this.stats.inflateMs += this.now() - t;
    }
  }

  private async inflateCheckedNow(gz: Uint8Array, ref: ObjectRef): Promise<Uint8Array> {
    const payload = await gunzip(gz);
    if (payload.byteLength !== ref.size) throw new Error(`${ref.hash}: inflated to ${payload.byteLength} bytes, manifest says ${ref.size}`);
    if (this.verifyHash) {
      const h = await sha256Prefix(payload);
      if (h !== ref.hash) throw new Error(`${ref.hash}: content hash ${h}`);
    }
    return payload;
  }

  private residentSource(dat: DatName): DatResidentSource {
    const store = this;
    const map = this.resident[dat];
    const iteration = this.pointer.iterations[dat] > 0 ? new Uint8Array(iterationRecordBytes(this.pointer.iterations[dat])) : null;
    return {
      kind: 'resident',
      header: datHeaderFor(this.pointer, dat),
      get(id: number): ArrayBuffer | null {
        const u8 = map.get(id) ?? (id === ITERATION_FILE_ID ? iteration : null);
        if (u8) {
          store.touch(dat, id);
          return u8.slice().buffer;
        }
        if (!store.exists(dat, id)) return null;
        store.noteMiss(dat, id);
        return null;
      },
      has: (id: number) => store.exists(dat, id),
      listIds(typePrefix?: number): number[] {
        const all = new Set<number>(store.packIds[dat]);
        if (dat === 'portal' || dat === 'highres') for (const id of store.manifest.leaves[dat].keys()) all.add(id);
        for (const id of map.keys()) all.add(id);
        const ids = [...all];
        return typePrefix === undefined ? ids : ids.filter((id) => ((id >>> 24) & 0xff) === typePrefix);
      },
      get count(): number {
        return store.packIds[dat].size + (dat === 'portal' || dat === 'highres' ? store.manifest.leaves[dat].size : 0);
      },
      sizeOf(id: number): number {
        const u8 = map.get(id);
        if (u8) return u8.byteLength;
        if (dat === 'portal' || dat === 'highres') return store.manifest.leaves[dat].get(id)?.size ?? -1;
        return -1;
      },
    };
  }

  private noteMiss(dat: DatName, id: number): void {
    noteDatMiss();
    // Probe hook (tools/probe-stream-miss-sweep.ts): a page that sets
    // window.__missTrace = [] gets each miss with the stack that made it, to
    // find render paths that read before their files land. Off otherwise.
    const trace = (globalThis as { __missTrace?: unknown[] }).__missTrace;
    if (Array.isArray(trace) && trace.length < 50_000) trace.push({ key: `${dat}:${id.toString(16).padStart(8, '0')}`, at: Date.now(), stack: new Error().stack ?? '' });
    this.stats.misses++;
    const t = dat === 'cell' ? `cell:${(id & 0xffff) === 0xfffe ? 'info' : 'envcell'}` : `${dat}:${(id >>> 24).toString(16).padStart(2, '0')}`;
    this.stats.missesByType[t] = (this.stats.missesByType[t] ?? 0) + 1;
    const key = fileKey(dat, id);
    for (const s of this.scopes) s.keys.add(key);
    this.missedKeys.add(key);
    this.stats.unresolvedMisses = this.missedKeys.size;
    const settle = () => {
      // Absent after all (a cell file outside its bundle) or failed: nothing will land.
      if (this.missedKeys.delete(key)) this.stats.unresolvedMisses = this.missedKeys.size;
    };
    this.request(dat, id, FetchPriority.Critical).then((ok) => { if (!ok) settle(); }, settle);
  }
}

/**
 * The pointer fetch, tried like an object (retries + 1 attempts, 250 ms
 * doubling backoff), each attempt limited to `timeoutMs`: a stalled request
 * is aborted and tried again instead of holding the boot. The bytes are the
 * parsed JSON's length (the fetcher may hand back an object).
 */
export async function fetchPointerRetried(
  url: string, fetchPointer: (url: string, opts?: { signal?: AbortSignal }) => Promise<unknown>, retries: number, timeoutMs: number,
): Promise<{ raw: unknown; tries: number; bytes: number }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = await Promise.race([
        fetchPointer(url, ac ? { signal: ac.signal } : {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { ac?.abort(); reject(new Error(`GET ${url}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
        }),
      ]);
      let bytes = 0;
      try { bytes = JSON.stringify(raw)?.length ?? 0; } catch { bytes = 0; }
      return { raw, tries: attempt + 1, bytes };
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
