/**
 * Streamed-DAT miss epoch (docs/dat-streaming.md §3.1).
 *
 * A streamed DAT answers a read of a file that exists but is not resident yet
 * with null (and fetches it). Code that caches what it built from DAT reads
 * must not cache a result built across such a miss, or the late-arriving file
 * is never used: a material built without its texture, a scenery model with
 * no parts. Those caches compare the epoch before and after the build and
 * skip the cache write when it moved.
 *
 * The other half is the arrival signal (RELEASE.streaming-regression-gate):
 * when a file that missed becomes resident, the store calls
 * noteDatMissResolved and every onDatMissResolved listener runs once per
 * batch (coalesced over a short window), so surfaces that drew without the
 * file (item icons, panel art) repaint instead of keeping a placeholder.
 *
 * Whole-file DATs (local dev, tests, tools) never miss, so the epoch stays 0,
 * the arrival signal never fires, and every cache behaves exactly as before.
 */
let epoch = 0;

/** Current miss count. */
export function datMissEpoch(): number {
  return epoch;
}

/** Record one miss (the streamed DAT's resident source calls this). */
export function noteDatMiss(): void {
  epoch++;
}

/** True when no streamed-DAT miss happened since `since` (a datMissEpoch() value). */
export function noDatMissSince(since: number): boolean {
  return epoch === since;
}

/** How long arrivals are batched before the listeners run (one repaint per burst). */
export const DAT_ARRIVAL_COALESCE_MS = 50;

const arrivalListeners = new Set<() => void>();
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;

/** Run `listener` after files that missed become resident (batched). Returns the unsubscribe. */
export function onDatMissResolved(listener: () => void): () => void {
  arrivalListeners.add(listener);
  return () => { arrivalListeners.delete(listener); };
}

/** A file that missed is resident now (the streamed DAT's store calls this). */
export function noteDatMissResolved(): void {
  if (arrivalTimer !== null) return;
  arrivalTimer = setTimeout(() => {
    arrivalTimer = null;
    for (const l of [...arrivalListeners]) {
      try { l(); } catch (e) { console.warn('[DatMiss] arrival listener failed', e); }
    }
  }, DAT_ARRIVAL_COALESCE_MS);
}
