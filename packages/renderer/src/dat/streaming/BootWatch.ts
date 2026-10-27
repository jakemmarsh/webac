/**
 * PERF.warm-boot-slow-breakdown — what the page itself was doing while a
 * streamed set opened (StreamingDats.openStreamingDats), for the boot
 * telemetry's phase breakdown:
 *
 *  - lagMs / lagMaxMs: how late a BOOT_WATCH_TICK_MS interval fired while the
 *    page was visible, summed over ticks later than BOOT_WATCH_LAG_FLOOR_MS,
 *    and the worst one. Every await of the open (an OPFS read, a gunzip, a
 *    hash) resumes on the main thread, so a long synchronous task anywhere in
 *    the page (a splash decode, a pack parse, another boot step) delays it by
 *    that much.
 *  - hiddenMs: how long the document was hidden (a background tab: Chrome
 *    throttles its timers to once a second, so its ticks do not count as lag).
 *
 * Prod signal (2026-10-23 / 10-27): two warm-cache boots spent ~21 s in the
 * 'all' set's open with zero network DAT bytes; nothing said whether the page
 * was busy, hidden or waiting.
 */

export const BOOT_WATCH_TICK_MS = 250;
/** Lateness under this is timer jitter, not a blocked main thread. */
export const BOOT_WATCH_LAG_FLOOR_MS = 50;

export interface BootWatchDoc {
  visibilityState?: string;
  addEventListener(type: 'visibilitychange', l: () => void): void;
  removeEventListener(type: 'visibilitychange', l: () => void): void;
}

export interface BootWatchEnv {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  doc: BootWatchDoc | null;
}

export interface BootWatchResult {
  lagMs: number;
  lagMaxMs: number;
  hiddenMs: number;
}

export interface BootWatch {
  /** Stop watching (idempotent); the totals so far. */
  stop(): BootWatchResult;
}

export function browserBootWatchEnv(): BootWatchEnv {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    doc: typeof document !== 'undefined' ? document as unknown as BootWatchDoc : null,
  };
}

export function startBootWatch(env: BootWatchEnv = browserBootWatchEnv()): BootWatch {
  const isHidden = () => env.doc?.visibilityState === 'hidden';
  let hiddenMs = 0;
  let hiddenSince: number | null = isHidden() ? env.now() : null;
  let lagMs = 0;
  let lagMaxMs = 0;
  let last = env.now();
  let stopped: BootWatchResult | null = null;

  const onVisibility = () => {
    const t = env.now();
    if (isHidden()) {
      if (hiddenSince === null) hiddenSince = t;
    } else if (hiddenSince !== null) {
      hiddenMs += t - hiddenSince;
      hiddenSince = null;
      last = t; // a throttled tick across the switch is not main-thread lag
    }
  };
  env.doc?.addEventListener('visibilitychange', onVisibility);

  const id = env.setInterval(() => {
    const t = env.now();
    const late = t - last - BOOT_WATCH_TICK_MS;
    last = t;
    if (isHidden() || late < BOOT_WATCH_LAG_FLOOR_MS) return;
    lagMs += late;
    if (late > lagMaxMs) lagMaxMs = late;
  }, BOOT_WATCH_TICK_MS);

  return {
    stop(): BootWatchResult {
      if (stopped) return stopped;
      env.clearInterval(id);
      env.doc?.removeEventListener('visibilitychange', onVisibility);
      // The interval's last, unfired period: lateness that has not ticked yet still counts.
      const t = env.now();
      const pending = t - last - BOOT_WATCH_TICK_MS;
      if (!isHidden() && pending >= BOOT_WATCH_LAG_FLOOR_MS) { lagMs += pending; if (pending > lagMaxMs) lagMaxMs = pending; }
      if (hiddenSince !== null) hiddenMs += t - hiddenSince;
      stopped = { lagMs: Math.round(lagMs), lagMaxMs: Math.round(lagMaxMs), hiddenMs: Math.round(hiddenMs) };
      return stopped;
    },
  };
}
