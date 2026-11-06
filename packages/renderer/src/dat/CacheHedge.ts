/**
 * PERF.cache-read-slower-than-network — when a slow browser-cache read also asks
 * the network. Used by the streamed object cache (streaming/DatStore.ts) and the
 * whole-DAT cache (DatCache.ts loadDatWithCache).
 */

/**
 * PERF.cache-read-slower-than-network (production, 2026-11-04): a returning
 * player's warm boot sat 21 s in 'world_cache' because ONE object-cache read
 * (OPFS getFile().arrayBuffer(), most likely the 18.6 MB worldLand pack) took
 * 19 s, on a 4 GB Windows laptop whose same read had taken ≤ 2 s six minutes
 * earlier and takes ~70 ms on a healthy machine. Nothing in the page caused it
 * (main-thread lag 81 ms, no writes that boot, no network); the disk under it
 * stalled. The store awaited the read however long it took, so the boot was
 * as slow as the worst disk moment.
 *
 * Now a cache read that is still running after delayMs(gzSize) also asks the
 * network for the object (content-addressed: the same bytes), and the first to
 * deliver a verified payload wins; the other is dropped (the download aborted
 * when the cache wins). A healthy read never reaches the deadline: across 213
 * production boots of 2026-11-01..04 the slowest read outside these two
 * incidents was 1.97 s (the same laptop) and the median slowest 81 ms.
 */
export interface CacheHedgePolicy {
  /** How long a cache read of an object of `gzSize` bytes may run before the network is asked too. */
  delayMs(gzSize: number): number;
  /** Call `fire` once `ms` have passed; returns a cancel. */
  wait(ms: number, fire: () => void): () => void;
  /**
   * PERF.slow-cache-bypass — the page's record of slow cache operations, shared by every store that
   * uses this policy (DEFAULT_CACHE_HEDGE: one per page, so an AC1999 boot's two sets share it).
   * Absent: each DatStore keeps its own.
   */
  health?: CacheHealth;
  /** How long a has() check (is this object stored?) may run before it counts as "not stored" (default CACHE_HAS_BOUND_MS). */
  hasBoundMs?: number;
}

/**
 * PERF.slow-cache-bypass (production, 2026-11-06, one player on two builds): with the read hedge in
 * place, boots still took 12-46 s. The OPFS directory itself took 12-46 s to open (dirMs 12525,
 * 22100, 46097), and on another boot one has() check took 5.5 s with the directory open in 22 ms.
 * Every cache operation waits for that directory: each read paid its 3 s deadline before the network
 * was asked, and the has() checks (the warm-profile check, hasMs 9203; the split-pack check, then
 * untimed: 18 s and 40 s of the 22.6 s and 46.6 s boots) were not raced at all, while the network
 * delivered the same bytes in 3-4 s.
 *
 * A has() check now answers "not stored" once it passes CACHE_HAS_BOUND_MS (the cold-profile path:
 * the world packs load behind char select, their reads raced as before), and a cache that has been
 * slow CACHE_SLOW_OPS_TO_BYPASS times in this page (a read that reached its deadline, a has() that
 * reached its bound) is bypassed for the rest of the page: reads go straight to the network, and
 * fall back to the cache only when the network fails (offline still boots from the cache); has()
 * answers "not stored" at once; nothing is written to it. Reads waiting on their deadline when the
 * bypass begins ask the network then.
 */
export class CacheHealth {
  /** Slow operations seen: reads that reached their deadline, has() checks that reached their bound. */
  slowOps = 0;
  /** has() checks that reached their bound (answered "not stored"). */
  hasTimeouts = 0;
  /** Reads sent straight to the network because the cache was bypassed. */
  bypassReads = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly slowOpsToBypass = CACHE_SLOW_OPS_TO_BYPASS) {}
  /** The cache has been slow often enough in this page to stop asking it first. */
  get bypassed(): boolean { return this.slowOps >= this.slowOpsToBypass; }
  /** A cache operation reached its deadline. */
  noteSlow(): void {
    const was = this.bypassed;
    this.slowOps++;
    if (!was && this.bypassed) for (const l of [...this.listeners]) l();
  }
  /** Call `fn` once when the bypass begins (at once if it already has); returns an unsubscribe. */
  onBypass(fn: () => void): () => void {
    if (this.bypassed) { fn(); return () => undefined; }
    const once = (): void => { this.listeners.delete(once); fn(); };
    this.listeners.add(once);
    return () => { this.listeners.delete(once); };
  }
}

/**
 * Slow cache operations in a page before the cache is bypassed. A healthy disk never has one (the
 * slowest healthy read in 213 boots, 1.97 s, is under the 3 s read deadline); a stalled one has
 * several in its first seconds (2026-11-06: 2-48 hedges a boot).
 */
export const CACHE_SLOW_OPS_TO_BYPASS = 2;
/**
 * How long a has() check may take. It reads no bytes (a file handle and its size). Across 677
 * streamed-set boots of 2026-10-23..11-06 (hasMs, a set's checks in parallel, OPFS open included):
 * median 4 ms, p95 90 ms, p99 605 ms, the slowest outside the stalled-disk incidents 649 ms; the
 * incidents 3.9-12.1 s. Answering "not stored" only means the boot does not wait for the world
 * packs before char select (they load behind it, their reads raced as usual).
 */
export const CACHE_HAS_BOUND_MS = 1500;

/** The page's CacheHealth (DEFAULT_CACHE_HEDGE's). */
export const pageCacheHealth = new CacheHealth();

/**
 * PERF.slow-cache-bypass — `cache.has(hash)`, answering false when the cache is bypassed or the check
 * passes the policy's bound (noted as a slow operation). A null policy (dev ?noCacheHedge) waits it out.
 * A late answer is dropped.
 */
export function boundedHas(has: (hash: string) => Promise<boolean>, hash: string, policy: CacheHedgePolicy | null, health: CacheHealth | null, onTimeout?: () => void): Promise<boolean> {
  if (policy && health?.bypassed) return Promise.resolve(false);
  const check = has(hash).catch(() => false);
  if (!policy || !health) return check;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let cancel: () => void = () => undefined;
    let offBypass: () => void = () => undefined;
    const finish = (v: boolean): void => { if (done) return; done = true; cancel(); offBypass(); resolve(v); };
    cancel = policy.wait(policy.hasBoundMs ?? CACHE_HAS_BOUND_MS, () => {
      if (done) return;
      health.hasTimeouts++;
      onTimeout?.();
      finish(false);
      health.noteSlow();
    });
    if (!done) offBypass = health.onBypass(() => finish(false));
    void check.then(finish);
  });
}

/** A cache read may run this long (plus CACHE_HEDGE_BYTES_PER_MS of its size) before the network is asked too. */
export const CACHE_HEDGE_BASE_MS = 3000;
/** The slowest disk a read is allowed before it is hedged: 8 MB/s (a healthy one reads 50-150 MB/s). */
export const CACHE_HEDGE_BYTES_PER_MS = 8000;

/**
 * A timer that does not run while the page is prerendering. Chrome defers
 * navigator.storage.getDirectory() in a prerendered page until it is shown
 * (tested 2026-11-04: it resolved 32 ms after activation, never before), so
 * every cache read of a prerendered boot waits for the player. That is not a
 * slow disk, and downloading the whole set during a prerender the player may
 * never open would be waste: the clock starts again on activation.
 */
export function prerenderAwareWait(ms: number, fire: () => void, doc: { prerendering?: boolean; addEventListener?: Document['addEventListener']; removeEventListener?: Document['removeEventListener'] } | null =
  typeof document !== 'undefined' ? document : null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const onActivate = (): void => { if (!cancelled) arm(); };
  const arm = (): void => {
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      if (doc?.prerendering && doc.addEventListener) doc.addEventListener('prerenderingchange', onActivate, { once: true });
      else fire();
    }, ms);
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    doc?.removeEventListener?.('prerenderingchange', onActivate);
  };
}

export const DEFAULT_CACHE_HEDGE: CacheHedgePolicy = {
  delayMs: (gzSize) => CACHE_HEDGE_BASE_MS + Math.max(0, gzSize) / CACHE_HEDGE_BYTES_PER_MS,
  wait: (ms, fire) => prerenderAwareWait(ms, fire),
  health: pageCacheHealth,
  hasBoundMs: CACHE_HAS_BOUND_MS,
};
