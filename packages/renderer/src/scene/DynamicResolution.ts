/**
 * PERF.render-adapt — dynamic resolution: the world's WebGL buffer follows
 * the measured frame time (scene/RenderScale.ts has the why).
 *
 * The controller sees one sample per drawn frame (main.ts, beside the
 * first-minute reporter) and only counts frames that drew the world in a
 * visible tab: portal space, loading screens and a hidden tab never move it,
 * and any interval over STALL_MS (a GC pause, a streamed-in landblock, a tab
 * switch) is dropped. Every EVAL_MS it takes the MEDIAN of the window, so a
 * few hitches cannot move it either:
 *
 *  - median > DOWN_MS (under ~26 FPS): step the pixel ratio down, by the
 *    square root of target / median (cost follows the pixel count), at most
 *    MAX_DOWN_FACTOR and at least MIN_DOWN_FACTOR per step, to the floor.
 *  - a step down that did not make frames faster means the frame is not
 *    bound by pixels: the ratio steps back up and stays put for NO_GAIN_MS.
 *  - at the floor (or pixels not being the cost) and still slow: one step
 *    of draw distance (when the host gives any; the player's own Landscape
 *    Draw Distance is the ceiling and is never rewritten).
 *  - median < UP_MS and the step's predicted cost (median × area ratio)
 *    stays under UP_PREDICT_MS: restore draw distance first, then step the
 *    ratio up by UP_FACTOR toward full.
 *
 * Hysteresis: the up and down bands are far apart, every change opens a
 * SETTLE_MS window that is not measured (the buffer reallocation's own
 * hitch), every down step blocks up steps for a back-off that doubles each
 * time a raise is undone within FLAP_MS (to BACKOFF_MAX_MS). A machine at
 * 60 FPS never measures a 38 ms median, so a healthy GPU stays at 1.0.
 *
 * Ratios are kept to RATIO_QUANTUM so the buffer is never resized for a
 * difference no one can see.
 */

export const TARGET_FRAME_MS = 1000 / 30;
export const DOWN_MS = 38;
export const UP_MS = 22;
export const UP_PREDICT_MS = 30;
export const STALL_MS = 250;
export const EVAL_MS = 2000;
export const MIN_SAMPLES = 15;
export const SETTLE_MS = 1000;
export const MIN_DOWN_FACTOR = 0.7;
export const MAX_DOWN_FACTOR = 0.9;
export const UP_FACTOR = 1.12;
export const NO_GAIN_MS = 60_000;
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 120_000;
export const FLAP_MS = 15_000;
export const RATIO_QUANTUM = 0.05;
/** A down step that did not cut the median by at least this much bought nothing. */
const GAIN_REQUIRED = 0.92;
const MAX_SAMPLES = 512;

export interface DynamicResolutionOptions {
  /** Highest ratio (the device pixel ratio). */
  max: number;
  /** Lowest ratio. */
  min: number;
  /** Where to start (defaults to `max`). */
  start?: number;
  /** Draw-distance steps the host can take below the player's setting (0 = none). */
  maxDistanceSteps?: number;
  /** A change to apply: the new ratio and draw-distance steps. */
  onChange?: (ratio: number, distanceSteps: number) => void;
}

function quantize(r: number): number {
  return Math.round(r / RATIO_QUANTUM) * RATIO_QUANTUM;
}

export class DynamicResolution {
  private _ratio: number;
  private _min: number;
  private _max: number;
  private _distanceSteps = 0;
  private maxDistanceSteps: number;
  private readonly onChange: ((ratio: number, distanceSteps: number) => void) | undefined;

  private readonly samples = new Float32Array(MAX_SAMPLES);
  private count = 0;
  private windowStart: number | null = null;
  private lastFrameAt: number | null = null;
  private settleUntil = -Infinity;

  /** The median before the last ratio step down, and that step's ratio before it. */
  private pendingDown: { median: number; from: number } | null = null;
  private noGainUntil = -Infinity;
  private upAllowedAt = -Infinity;
  private backoffMs = BACKOFF_START_MS;
  private lastUpAt = -Infinity;
  /** Changes made (telemetry / tests). */
  changes = 0;

  constructor(opts: DynamicResolutionOptions) {
    this._max = opts.max;
    this._min = Math.min(opts.min, opts.max);
    this._ratio = this.clamp(opts.start ?? opts.max);
    this.maxDistanceSteps = Math.max(0, Math.floor(opts.maxDistanceSteps ?? 0));
    this.onChange = opts.onChange;
  }

  get ratio(): number { return this._ratio; }
  get distanceSteps(): number { return this._distanceSteps; }
  /** ratio / max: 1 = full resolution. */
  get scale(): number { return this._max > 0 ? this._ratio / this._max : 1; }

  /** New bounds (the window moved to another display: devicePixelRatio changed). Never fires onChange. */
  setBounds(min: number, max: number): void {
    const wasFull = this._ratio >= this._max;
    this._max = max;
    this._min = Math.min(min, max);
    this._ratio = wasFull ? max : this.clamp(this._ratio);
  }

  /** The host's draw-distance room changed (the player picked another Landscape Draw Distance). */
  setMaxDistanceSteps(n: number): void {
    this.maxDistanceSteps = Math.max(0, Math.floor(n));
    if (this._distanceSteps > this.maxDistanceSteps) this.apply(this._ratio, this.maxDistanceSteps, -Infinity);
  }

  /**
   * One drawn frame at `now` (ms). `eligible`: the frame drew the world in a
   * visible tab (no portal space, no loading cover).
   */
  frame(now: number, eligible: boolean): void {
    // An ineligible frame breaks the chain: the next interval would span it.
    const last = this.lastFrameAt;
    this.lastFrameAt = eligible ? now : null;
    if (!eligible || last === null || now < this.settleUntil) return;
    const dt = now - last;
    if (!(dt > 0) || dt > STALL_MS) return;
    if (this.windowStart === null) this.windowStart = last;
    if (this.count < MAX_SAMPLES) this.samples[this.count++] = dt;
    if (now - this.windowStart >= EVAL_MS && this.count >= MIN_SAMPLES) this.evaluate(now);
  }

  private median(): number {
    const s = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  private evaluate(now: number): void {
    const med = this.median();
    this.count = 0;
    this.windowStart = null;

    // Did the last step down help? If not, pixels are not the cost: undo it.
    if (this.pendingDown) {
      const { median: before, from } = this.pendingDown;
      this.pendingDown = null;
      if (med > before * GAIN_REQUIRED) {
        this.noGainUntil = now + NO_GAIN_MS;
        this.apply(from, this._distanceSteps, now);
        return;
      }
    }

    if (med > DOWN_MS) {
      const canRatio = this._ratio > this._min && now >= this.noGainUntil;
      if (canRatio) {
        const f = Math.min(MAX_DOWN_FACTOR, Math.max(MIN_DOWN_FACTOR, Math.sqrt(TARGET_FRAME_MS / med)));
        let next = this.clamp(quantize(this._ratio * f));
        if (next >= this._ratio) next = this.clamp(this._ratio - RATIO_QUANTUM);
        if (next < this._ratio) {
          this.pendingDown = { median: med, from: this._ratio };
          this.down(now);
          this.apply(next, this._distanceSteps, now);
          return;
        }
      }
      if (this._distanceSteps < this.maxDistanceSteps) {
        this.down(now);
        this.apply(this._ratio, this._distanceSteps + 1, now);
      }
      return;
    }

    if (med < UP_MS && now >= this.upAllowedAt) {
      if (this._distanceSteps > 0) {
        this.lastUpAt = now;
        this.apply(this._ratio, this._distanceSteps - 1, now);
        return;
      }
      if (this._ratio < this._max) {
        let next = quantize(this._ratio * UP_FACTOR);
        if (next <= this._ratio) next = this._ratio + RATIO_QUANTUM;
        next = Math.min(this._max, next);
        const predicted = med * (next / this._ratio) ** 2;
        if (predicted < UP_PREDICT_MS) {
          this.lastUpAt = now;
          this.apply(next, this._distanceSteps, now);
        }
      }
    }
  }

  /** A step down: block raises, longer each time a raise was undone soon after. */
  private down(now: number): void {
    if (now - this.lastUpAt < FLAP_MS) this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.upAllowedAt = now + this.backoffMs;
  }

  private clamp(r: number): number {
    return Math.min(this._max, Math.max(this._min, r));
  }

  private apply(ratio: number, distanceSteps: number, now: number): void {
    const r = this.clamp(ratio);
    if (r === this._ratio && distanceSteps === this._distanceSteps) return;
    this._ratio = r;
    this._distanceSteps = distanceSteps;
    this.changes++;
    this.settleUntil = now + SETTLE_MS;
    this.count = 0;
    this.windowStart = null;
    this.lastFrameAt = null;
    try { this.onChange?.(r, distanceSteps); } catch { /* the host's apply must not stop the loop */ }
  }
}
