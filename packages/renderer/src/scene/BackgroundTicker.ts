/**
 * Keep the game simulating when the browser stops drawing it.
 *
 * Chrome stops requestAnimationFrame for a hidden tab, a minimized window,
 * or one fully covered by another app (occlusion), and throttles its timers.
 * Our whole simulation (movement, physics, the agent's tasks) runs in the
 * rAF frame, so the character froze: with Claude Desktop in front, Claude's
 * walk to a vendor didn't move at all in 22 s (measured 2026-10-10; visible,
 * the same walk took 13 s). The CLI never saw it: its Playwright browser
 * launches with the background-throttling switches off. Retail is a desktop
 * program that keeps running when covered or minimized.
 *
 * A dedicated worker's beat (frameTicker.worker.ts, not throttled) runs the
 * frame step without drawing whenever rAF has been silent for STARVED_MS.
 *
 * "Silent" is measured against the page's own frame pace: a visible tab on a
 * slow GPU draws every 250–330 ms (prod 2026-10-20, Intel UHD 630 at ~3 FPS),
 * and a fixed 250 ms threshold ran an extra undrawn frame step between nearly
 * every pair of real frames, adding main-thread work to a machine that was
 * already too slow. The threshold is STARVED_FACTOR times the recent rAF
 * interval (a smoothed average, each interval capped at STARVED_MAX_MS), never
 * under STARVED_MS and never over STARVED_MAX_MS, so a hidden tab is still
 * picked up within a second.
 */
export const TICK_MS = 50;
export const STARVED_MS = 250;
export const STARVED_MAX_MS = 1000;
export const STARVED_FACTOR = 3;
/** Weight of the newest interval in the smoothed rAF interval. */
const INTERVAL_EMA = 0.2;

export class BackgroundTicker {
  private lastFrameAt: number;
  /** Smoothed rAF interval, ms (starts at a 60 Hz frame). */
  private intervalMs = 1000 / 60;
  private worker: { postMessage(ms: number): void; terminate(): void; onmessage: ((e: MessageEvent) => void) | null } | null = null;

  constructor(
    /** One frame step without drawing. */
    private readonly step: () => void,
    private readonly now: () => number = () => performance.now(),
    private readonly makeWorker: () => { postMessage(ms: number): void; terminate(): void; onmessage: ((e: MessageEvent) => void) | null } = () =>
      new Worker(new URL('./frameTicker.worker.ts', import.meta.url), { type: 'module', name: 'acjs-frame-ticker' }) as never,
  ) {
    this.lastFrameAt = now();
  }

  /** The browser drew a frame (call from the rAF loop). */
  frame(): void {
    const t = this.now();
    const dt = t - this.lastFrameAt;
    if (dt > 0) this.intervalMs += (Math.min(dt, STARVED_MAX_MS) - this.intervalMs) * INTERVAL_EMA;
    this.lastFrameAt = t;
  }

  /** How long rAF must be silent before the beat steps: scaled to the page's own frame pace. */
  get starvedAfterMs(): number {
    return Math.min(STARVED_MAX_MS, Math.max(STARVED_MS, STARVED_FACTOR * this.intervalMs));
  }

  /** rAF has been silent long enough that the simulation needs the worker's beat. */
  get starved(): boolean { return this.now() - this.lastFrameAt > this.starvedAfterMs; }

  start(): void {
    if (this.worker) return;
    try {
      this.worker = this.makeWorker();
      this.worker.onmessage = () => { if (this.starved) this.step(); };
      this.worker.postMessage(TICK_MS);
    } catch { this.worker = null; /* no workers here: the page simply pauses when hidden, as before */ }
  }

  stop(): void {
    this.worker?.postMessage(0);
    this.worker?.terminate();
    this.worker = null;
  }
}
