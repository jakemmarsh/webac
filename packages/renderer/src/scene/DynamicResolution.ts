/**
 * PERF.render-adapt — dynamic resolution: the world's WebGL buffer follows
 * the measured frame time (scene/RenderScale.ts has the why).
 *
 * The controller sees one sample per drawn frame (main.ts, beside the
 * first-minute reporter) and only counts frames that drew the world in a
 * visible tab: portal space, loading screens and a hidden tab never move it.
 * An interval over STALL_MS is dropped as a one-off hitch (a GC pause, a
 * streamed-in landblock, a tab switch) only when the interval before it was
 * not already slow (under DOWN_MS); after a slow interval it is a real frame
 * of a slow machine and counts, clamped to LONG_FRAME_CAP_MS. Every EVAL_MS it
 * takes the MEDIAN of the window, so a few hitches cannot move it either.
 * A window needs MIN_SAMPLES frames, or, when frames are long, MIN_SLOW_SAMPLES
 * whose summed length covers EVAL_MS (a 3 FPS machine draws ~6 frames in 2 s).
 *
 * BUG (prod 2026-10-20, Intel UHD 630 at dpr 2): every frame took 250–330 ms,
 * the old rule dropped every one of them as a hitch, the window never filled,
 * and the controller sat at full resolution at ~3 FPS for the whole first
 * minute: blind exactly where it is needed.
 *
 *
 *  - median > DOWN_MS (under ~26 FPS): step the pixel ratio down, by the
 *    square root of target / median (cost follows the pixel count), at most
 *    MAX_DOWN_FACTOR and at least MIN_DOWN_FACTOR per step, to the floor.
 *    A median over FAR_DOWN_MS (far over budget) allows a step as large as
 *    FAR_MIN_DOWN_FACTOR, so a 300 ms machine reaches the floor in two steps
 *    (a few seconds) instead of four or five.
 *  - a step down that did not make frames faster means the frame is not
 *    bound by pixels: the ratio steps back up and stays put for NO_GAIN_MS.
 *  - at the floor (or pixels not being the cost) and still slow: one step
 *    of draw distance (when the host gives any; the player's own Landscape
 *    Draw Distance is the ceiling and is never rewritten).
 *  - median < UP_MS and the step's predicted cost (median × area ratio)
 *    stays under UP_PREDICT_MS: restore draw distance first, then step the
 *    ratio up by UP_FACTOR toward full.
 *
 * PERF.render-adapt-cpu-bound (prod 2026-11-15, Reddit "graphics often appear
 * blurry ... I'm on a Mac"): a MacBook Air (Intel HD 5000, dpr 1) sat at the
 * 50 % floor with a 33 ms median and 28 ms of CPU work per frame; its render
 * phase cost MORE at half size (17.4 ms, 520 draw calls) than at full size
 * elsewhere (13 ms, 330 draw calls). Frame intervals are vsync-quantized
 * (16.7 / 33 / 50 ms), so a steady 30 FPS median of 33 sits between UP_MS and
 * DOWN_MS forever: once a heavy moment (a 50 ms window) put it at the floor it
 * never climbed back. Fast machines (RTX 4070 at 8 ms frames, RTX 5080 and an
 * Apple GPU at 16 ms) were also at the floor at the 60 s mark: loading windows
 * over DOWN_MS stepped them down (FAR steps reach the floor in two windows),
 * each step "gained" because the load ended, and the climb back was one
 * UP_FACTOR step per ~3 s behind a back-off the loading's ups and downs had
 * doubled. The rules that fix both:
 *
 *  - the host also passes each frame's CPU work (main.ts: frame start to
 *    after the draw). A median frame that the median work explains to within
 *    one refresh (work + VSYNC_MS >= median) is set by the CPU, not by the
 *    pixel count: a step down then takes a draw-distance step first (draw
 *    calls are the cost), and the ratio only when there is none left (still
 *    checked by the no-gain rule, so a GPU whose submission blocks still gets
 *    its reduction);
 *  - in the band (UP_MS..DOWN_MS) a CPU-explained window PROBES the ratio up
 *    by PROBE_FACTOR. A probe that makes the median worse (past DOWN_MS, or by
 *    more than GAIN_REQUIRED) is undone and in-band probes stay at or below
 *    the ratio it left for a hold that doubles per failure; a down step that
 *    helped sets the same ceiling, so it never re-probes straight into the
 *    step it just took;
 *  - with headroom (median < UP_MS) the ratio jumps to the highest one the
 *    conservative prediction (median x area ratio) keeps under UP_PREDICT_MS,
 *    with one draw-distance step restored in the same change, and the
 *    back-off holds such a raise at most HEADROOM_HOLD_MS after the last step
 *    down. An 8 ms machine at the floor is back at full within two steps.
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
/** A window of long frames evaluates with this many, once their summed length reaches EVAL_MS. */
export const MIN_SLOW_SAMPLES = 5;
/** A long interval that counts (part of a slow run) is clamped to this. */
export const LONG_FRAME_CAP_MS = 1000;
/** Medians over this are far over budget: the down step may be as large as FAR_MIN_DOWN_FACTOR. */
export const FAR_DOWN_MS = 2 * DOWN_MS;
export const FAR_MIN_DOWN_FACTOR = 0.5;
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
export const GAIN_REQUIRED = 0.92;
/** One display refresh at 60 Hz: the quantum frame intervals snap to. */
export const VSYNC_MS = 1000 / 60;
/** An in-band probe up multiplies the ratio by this (pixels are not what sets the frame there). */
export const PROBE_FACTOR = 1.25;
/** A raise with clear headroom (median < UP_MS) waits at most this long after the last step down. */
export const HEADROOM_HOLD_MS = BACKOFF_START_MS;
/** How long the probe ceiling first holds (a failed probe, or a down step that helped); doubles per failed probe. */
export const PROBE_HOLD_MS = NO_GAIN_MS;
export const PROBE_HOLD_MAX_MS = 8 * 60_000;
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
  /** The CPU work of the same frames (ms); valid only while workKnown. */
  private readonly works = new Float32Array(MAX_SAMPLES);
  private workKnown = true;
  private count = 0;
  /** Summed length of the window's samples, ms. */
  private sum = 0;
  /** The previous interval of the current eligible chain (null at a chain start). */
  private prevDt: number | null = null;
  private windowStart: number | null = null;
  private lastFrameAt: number | null = null;
  private settleUntil = -Infinity;

  /** The median before the last ratio step down, and that step's ratio before it. */
  private pendingDown: { median: number; from: number } | null = null;
  private noGainUntil = -Infinity;
  /** The median before the last in-band probe up, and the ratio it left. */
  private pendingUp: { median: number; from: number } | null = null;
  /** In-band probes stay at or below this ratio until probeCeilingUntil. */
  private probeCeiling = Infinity;
  private probeCeilingUntil = -Infinity;
  private probeHoldMs = PROBE_HOLD_MS;
  private lastDownAt = -Infinity;
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
   * visible tab (no portal space, no loading cover). `workMs`: the frame's own
   * CPU work (its script time up to and including the draw call), when the
   * host measures it.
   */
  frame(now: number, eligible: boolean, workMs?: number): void {
    // An ineligible frame breaks the chain: the next interval would span it.
    const last = this.lastFrameAt;
    this.lastFrameAt = eligible ? now : null;
    if (!eligible || last === null) { this.prevDt = null; return; }
    const dt = now - last;
    const prev = this.prevDt;
    this.prevDt = dt;
    if (now < this.settleUntil || !(dt > 0)) return;
    let sample = dt;
    if (dt > STALL_MS) {
      // A hitch among normal frames is dropped; a long frame after a slow one is the machine's pace.
      if (prev === null || !(prev > DOWN_MS)) return;
      sample = Math.min(dt, LONG_FRAME_CAP_MS);
    }
    if (this.windowStart === null) this.windowStart = last;
    if (this.count < MAX_SAMPLES) {
      if (workMs !== undefined && Number.isFinite(workMs) && workMs >= 0) this.works[this.count] = workMs;
      else this.workKnown = false;
      this.samples[this.count++] = sample;
      this.sum += sample;
    }
    if (now - this.windowStart >= EVAL_MS
      && (this.count >= MIN_SAMPLES || (this.count >= MIN_SLOW_SAMPLES && this.sum >= EVAL_MS))) this.evaluate(now);
  }

  private median(arr: Float32Array = this.samples): number {
    const s = Array.from(arr.subarray(0, this.count)).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  private evaluate(now: number): void {
    const med = this.median();
    const work = this.workKnown && this.count > 0 ? this.median(this.works) : null;
    this.resetWindow();
    // The CPU work explains the frame to within one refresh: the pixel count is not what sets it.
    const cpuExplained = work !== null && work + VSYNC_MS >= med;

    // Did the last step down help? If not, pixels are not the cost: undo it.
    if (this.pendingDown) {
      const { median: before, from } = this.pendingDown;
      this.pendingDown = null;
      if (med > before * GAIN_REQUIRED) {
        this.noGainUntil = now + NO_GAIN_MS;
        this.apply(from, this._distanceSteps, now);
        return;
      }
      // It helped: in-band probes stay at or below where it landed for a while.
      this.setProbeCeiling(this._ratio, now);
    }

    // Did the last probe up cost frames? Then pixels were the cost after all: undo it.
    if (this.pendingUp) {
      const { median: before, from } = this.pendingUp;
      this.pendingUp = null;
      if (med > DOWN_MS || med * GAIN_REQUIRED > before) {
        this.setProbeCeiling(from, now);
        this.probeHoldMs = Math.min(PROBE_HOLD_MAX_MS, this.probeHoldMs * 2);
        this.down(now);
        this.apply(from, this._distanceSteps, now);
        return;
      }
      this.probeHoldMs = PROBE_HOLD_MS;
    }

    if (med > DOWN_MS) {
      // CPU-set frames: fewer draw calls first; the ratio only once there is no distance left.
      if (cpuExplained && this._distanceSteps < this.maxDistanceSteps) {
        this.down(now);
        this.apply(this._ratio, this._distanceSteps + 1, now);
        return;
      }
      const canRatio = this._ratio > this._min && now >= this.noGainUntil;
      if (canRatio) {
        const minFactor = med > FAR_DOWN_MS ? FAR_MIN_DOWN_FACTOR : MIN_DOWN_FACTOR;
        const f = Math.min(MAX_DOWN_FACTOR, Math.max(minFactor, Math.sqrt(TARGET_FRAME_MS / med)));
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

    if (med < UP_MS) {
      // Clear headroom: a back-off left by a loading burst never holds this for long.
      if (now < Math.min(this.upAllowedAt, this.lastDownAt + HEADROOM_HOLD_MS)) return;
      // The highest ratio the conservative prediction (median x area ratio) keeps under UP_PREDICT_MS.
      const room = this._ratio * Math.sqrt(UP_PREDICT_MS / med);
      let next = this._ratio;
      if (room >= this._max) next = this._max;
      else {
        const q = Math.floor(room / RATIO_QUANTUM + 1e-9) * RATIO_QUANTUM;
        if (q > this._ratio + 1e-9) next = q;
      }
      const steps = Math.max(0, this._distanceSteps - 1);
      if (next > this._ratio || steps !== this._distanceSteps) {
        this.lastUpAt = now;
        this.apply(next, steps, now);
      }
      return;
    }

    // The band (UP_MS..DOWN_MS): a CPU-set frame probes the ratio up; pixels are not what sets it.
    if (cpuExplained && this._ratio < this._max && now >= this.upAllowedAt) {
      const ceiling = now < this.probeCeilingUntil ? this.probeCeiling : this._max;
      let next = quantize(this._ratio * PROBE_FACTOR);
      if (next <= this._ratio) next = this._ratio + RATIO_QUANTUM;
      next = Math.min(this._max, ceiling, next);
      if (next > this._ratio + 1e-9) {
        this.lastUpAt = now;
        this.pendingUp = { median: med, from: this._ratio };
        this.apply(next, this._distanceSteps, now);
      }
    }
  }

  private setProbeCeiling(ratio: number, now: number): void {
    this.probeCeiling = ratio;
    this.probeCeilingUntil = now + this.probeHoldMs;
  }

  private resetWindow(): void {
    this.count = 0;
    this.sum = 0;
    this.windowStart = null;
    this.workKnown = true;
  }

  /** A step down: block raises, longer each time a raise was undone soon after. */
  private down(now: number): void {
    if (now - this.lastUpAt < FLAP_MS) this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.upAllowedAt = now + this.backoffMs;
    this.lastDownAt = now;
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
    this.resetWindow();
    this.lastFrameAt = null;
    this.prevDt = null;
    try { this.onChange?.(r, distanceSteps); } catch { /* the host's apply must not stop the loop */ }
  }
}
