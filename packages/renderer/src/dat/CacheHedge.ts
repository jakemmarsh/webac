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
};
