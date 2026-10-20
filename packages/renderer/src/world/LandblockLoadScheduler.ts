/**
 * REND.landblock-streaming-one-frame — spreads landblock object loads over
 * frames instead of building a whole newly-entered row (2R+1 blocks, 17 at
 * the retail default draw distance of 8) in the frame that crosses into it.
 *
 * Each block's load is a resumable job (an iterator that yields after every
 * unit of work — see main.ts loadLandblockObjectsSteps). `pump()` runs once
 * per frame:
 *
 *  1. Blocks within `syncRadius` (Chebyshev) of the player's block are
 *     finished NOW, whatever the budget — the player's own block and its
 *     neighbours always have their collision before the player can reach it
 *     (a teleport into unloaded ground loads them synchronously).
 *  2. Then jobs advance nearest-first until this frame's budget is spent
 *     (`budgetMs`, more on a slow machine: see frameBudgetMs). The job in
 *     progress is always resumed before a new one starts, so at most one
 *     block is ever partially built.
 *
 * The budget is per frame, so on a slow machine it was per much less time:
 * at 3–4 FPS (prod 2026-10-20, Intel UHD 630 at ~300 ms frames) 6 ms a frame
 * is ~20 ms of loading a second against ~360 ms at 60 FPS, and the streamed
 * object ring fell minutes behind the player. A frame whose interval is long
 * gets SLOW_FRAME_SHARE of it instead (never under `budgetMs`, never over
 * MAX_SLOW_BUDGET_MS): unchanged up to ~75 ms frames (13 FPS), 24 ms at
 * 300 ms frames (8% more frame time for 4× the loading).
 *
 * Nothing is dropped: the same steps run in the same order as a synchronous
 * load, only spread over frames — the end state is identical.
 */
export type BlockJobFactory = (blockX: number, blockY: number) => Iterator<void>;

export interface LandblockLoadSchedulerOptions {
  /** Per-frame time budget for non-mandatory work, ms. */
  budgetMs?: number;
  /** Blocks within this Chebyshev distance of the player's block load synchronously. */
  syncRadius?: number;
  /** Clock (ms). */
  now?: () => number;
}

export interface PumpStats {
  /** Iterator steps run this pump. */
  steps: number;
  /** Blocks finished this pump. */
  completed: number;
  /** Time spent, ms. */
  elapsedMs: number;
}

/** Retail-default-agnostic budget: well under one 60 Hz frame (16.7 ms). */
export const DEFAULT_LANDBLOCK_BUDGET_MS = 6;
/** On long frames the budget is this share of the (smoothed) interval between pumps... */
export const SLOW_FRAME_SHARE = 0.08;
/** ...at most this many ms per frame. */
export const MAX_SLOW_BUDGET_MS = 24;
/** Each interval counts at most this long (a hidden tab's pause is not a frame). */
const MAX_INTERVAL_MS = 1000;
/** Weight of the newest interval in the smoothed one. */
const INTERVAL_EMA = 0.3;

function blockKey(bx: number, by: number): number {
  return ((bx & 0xff) << 8) | (by & 0xff);
}

interface Job { bx: number; by: number; it: Iterator<void> | null }

export class LandblockLoadScheduler {
  private readonly pending = new Map<number, Job>();
  private current: { key: number; job: Job } | null = null;
  private readonly budgetMs: number;
  private readonly syncRadius: number;
  private readonly now: () => number;
  /** When the last pump started, and the smoothed interval between pumps (null until two pumps). */
  private lastPumpAt: number | null = null;
  private intervalMs: number | null = null;

  constructor(private readonly start: BlockJobFactory, options: LandblockLoadSchedulerOptions = {}) {
    this.budgetMs = options.budgetMs ?? DEFAULT_LANDBLOCK_BUDGET_MS;
    this.syncRadius = options.syncRadius ?? 1;
    this.now = options.now ?? (() => performance.now());
  }

  /** Queue every block within `radius` of (cx, cy) (clamped to the 0..255 map). Already-queued blocks stay queued. */
  request(cx: number, cy: number, radius: number): void {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const bx = cx + dx;
        const by = cy + dy;
        if (bx < 0 || bx > 0xff || by < 0 || by > 0xff) continue;
        const key = blockKey(bx, by);
        if (this.current?.key === key || this.pending.has(key)) continue;
        this.pending.set(key, { bx, by, it: null });
      }
    }
  }

  /** Drop queued (not yet started) blocks farther than `radius` from (cx, cy) — the player moved on. */
  cancelOutside(cx: number, cy: number, radius: number): void {
    for (const [key, job] of this.pending) {
      if (Math.abs(job.bx - cx) > radius || Math.abs(job.by - cy) > radius) this.pending.delete(key);
    }
  }

  /**
   * Finish block (bx, by) right now if it is in progress, or take it off the
   * queue if it is waiting (the caller is about to load it itself).
   */
  complete(bx: number, by: number): void {
    const key = blockKey(bx, by);
    if (this.current?.key === key) {
      this.drain(this.current.job);
      this.current = null;
    }
    this.pending.delete(key);
  }

  /** Run every queued job to completion (nearest-first from (cx, cy)). */
  flush(cx: number, cy: number): void {
    if (this.current) { this.drain(this.current.job); this.current = null; }
    while (this.pending.size > 0) {
      const key = this.nearest(cx, cy)!;
      const job = this.pending.get(key)!;
      this.pending.delete(key);
      this.drain(job);
    }
  }

  /** This frame's budget for non-mandatory work: `budgetMs`, or a share of a long frame. */
  get frameBudgetMs(): number {
    const iv = this.intervalMs;
    if (iv === null) return this.budgetMs;
    return Math.max(this.budgetMs, Math.min(MAX_SLOW_BUDGET_MS, iv * SLOW_FRAME_SHARE));
  }

  /** One frame's worth of loading around the player's block (px, py). */
  pump(px: number, py: number): PumpStats {
    const t0 = this.now();
    if (this.lastPumpAt !== null) {
      const dt = Math.min(MAX_INTERVAL_MS, t0 - this.lastPumpAt);
      if (dt > 0) this.intervalMs = this.intervalMs === null ? dt : this.intervalMs + (dt - this.intervalMs) * INTERVAL_EMA;
    }
    this.lastPumpAt = t0;
    const budget = this.frameBudgetMs;
    let steps = 0;
    let completed = 0;

    // 1. Mandatory ring — the player's block + neighbours, whatever the cost.
    if (this.current && this.isMandatory(this.current.job, px, py)) {
      steps += this.drain(this.current.job);
      this.current = null;
      completed++;
    }
    for (const [key, job] of [...this.pending]) {
      if (!this.isMandatory(job, px, py)) continue;
      this.pending.delete(key);
      steps += this.drain(job);
      completed++;
    }

    // 2. Budgeted — nearest first, resuming the block in progress.
    while (this.now() - t0 < budget) {
      if (!this.current) {
        const key = this.nearest(px, py);
        if (key === null) break;
        const job = this.pending.get(key)!;
        this.pending.delete(key);
        this.current = { key, job };
      }
      const job = this.current.job;
      job.it ??= this.start(job.bx, job.by);
      steps++;
      if (job.it.next().done) {
        this.current = null;
        completed++;
      }
    }
    return { steps, completed, elapsedMs: this.now() - t0 };
  }

  /** Blocks queued or in progress. */
  get queuedCount(): number {
    return this.pending.size + (this.current ? 1 : 0);
  }

  /** True when a block is waiting or in progress at (bx, by). */
  isQueued(bx: number, by: number): boolean {
    const key = blockKey(bx, by);
    return this.current?.key === key || this.pending.has(key);
  }

  private isMandatory(job: Job, px: number, py: number): boolean {
    return Math.abs(job.bx - px) <= this.syncRadius && Math.abs(job.by - py) <= this.syncRadius;
  }

  private drain(job: Job): number {
    job.it ??= this.start(job.bx, job.by);
    let n = 0;
    while (!job.it.next().done) n++;
    return n + 1;
  }

  /** The waiting block nearest (Euclidean, in blocks) to (px, py); ties → lowest key, for determinism. */
  private nearest(px: number, py: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (const [key, job] of this.pending) {
      const d = (job.bx - px) ** 2 + (job.by - py) ** 2;
      if (d < bestD || (d === bestD && best !== null && key < best)) {
        best = key;
        bestD = d;
      }
    }
    return best;
  }
}
