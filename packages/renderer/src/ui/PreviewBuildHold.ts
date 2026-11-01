/**
 * UX.chargen-preview-no-placeholder — hold the last complete picture of a 3D
 * preview while a new build's streamed files are on their way.
 *
 * Retail's gmCG3DView::Update @ 004ee9d0 rebuilt the chargen / barber figure
 * from a local DAT: DBObj::Get blocked until each file was read, so the
 * figure it swapped in was always whole. Streamed DATs answer a read of a
 * file that is not resident with null (and fetch it), so a synchronous
 * CharacterModelBuilder build that missed draws a white face (a missing
 * SurfaceTexture, a palette-less decode) until the file lands and a rebuild
 * runs (playwebac.com, 2026-11-01: "anything I change, the preview face
 * flashes white for a second").
 *
 * A request runs the build at once. A build that read every file (no
 * DatMiss epoch move) is handed to `onReady` in the same call, exactly as
 * before. A build that missed is dropped, the current picture stays, and the
 * build is tried again on each batch of arrivals (DatMiss.onDatMissResolved)
 * until one comes out complete. Only the latest request is ever retried or
 * shown: a newer request replaces a pending one. A cap releases a real stall
 * (a fetch that keeps failing, a file absent from the set): once the oldest
 * unresolved request is `capMs` old, the latest build is shown as it is, and
 * arrivals keep rebuilding it (up to `maxLateRebuilds` times) until it is
 * complete, so a stale or partial picture is never stranded.
 *
 * Whole DATs never miss: every request swaps synchronously.
 */
import { datMissEpoch, onDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';

/** How long a preview keeps its last complete picture before showing an incomplete build. */
export const PREVIEW_HOLD_CAP_MS = 1750;
/** Rebuilds on arrival after the cap released an incomplete build (a file truly absent can't loop). */
export const PREVIEW_HOLD_MAX_LATE_REBUILDS = 4;

export interface PreviewHoldEnv {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The batched "missed files are resident" signal; returns the unsubscribe. */
  onFilesArrived(listener: () => void): () => void;
  /** The streamed-miss counter. */
  missEpoch(): number;
}

const defaultEnv: PreviewHoldEnv = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onFilesArrived: onDatMissResolved,
  missEpoch: datMissEpoch,
};

export interface PreviewHoldRequestOptions {
  /** Called once when the request's first build missed: start the fetch of everything it needs (one wave, not one per retry). */
  onMiss?: () => void;
}

interface Pending<T> {
  build: () => T | null;
  onReady: (result: T, sync: boolean) => void;
}

export class PreviewBuildHold<T> {
  private pending: Pending<T> | null = null;
  private capTimer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  /** Set once the cap showed an incomplete build: arrivals then rebuild a bounded number of times. */
  private released = false;
  private lateRebuilds = 0;
  /** Misses counted inside the builds of the last request() / retry (callers subtract them from their own miss accounting). */
  lastBuildMisses = 0;
  /** Requests made / builds shown, for probes. */
  readonly stats = { requests: 0, builds: 0, shown: 0, shownIncomplete: 0, superseded: 0 };

  constructor(
    private readonly capMs = PREVIEW_HOLD_CAP_MS,
    private readonly env: PreviewHoldEnv = defaultEnv,
    private readonly maxLateRebuilds = PREVIEW_HOLD_MAX_LATE_REBUILDS,
  ) {}

  /** Whether a request is waiting for its files (the current picture is being held). */
  get holding(): boolean {
    return this.pending !== null && !this.released;
  }

  /**
   * Build now; a complete build reaches `onReady(result, true)` before this
   * returns (true). A build that missed is held for (false). `onReady(…,
   * false)` later means the swap happened outside the caller's frame: redraw.
   */
  request(build: () => T | null, onReady: (result: T, sync: boolean) => void, opts: PreviewHoldRequestOptions = {}): boolean {
    this.stats.requests++;
    if (this.pending) this.stats.superseded++;
    this.pending = { build, onReady };
    this.lateRebuilds = 0;
    const done = this.attempt(true, false);
    if (!done) {
      // A new choice after the cap already let one through: hold it again for its own cap.
      if (this.released) { this.released = false; this.armCap(); }
      opts.onMiss?.();
    }
    return done;
  }

  /** Drop whatever is pending (the view closed). */
  cancel(): void {
    this.pending = null;
    this.released = false;
    this.stopWaiting();
  }

  /** Run the pending build; true when it came out complete (and was handed over). */
  private attempt(sync: boolean, force: boolean): boolean {
    const p = this.pending;
    if (!p) return true;
    const before = this.env.missEpoch();
    let result: T | null = null;
    try {
      result = p.build();
    } finally {
      this.lastBuildMisses = this.env.missEpoch() - before;
    }
    this.stats.builds++;
    const complete = this.lastBuildMisses === 0;
    if (result === null) {
      // Nothing to draw (no SexCG / setup): keep the current picture, and
      // wait for files only when the build missed.
      if (complete) { this.pending = null; this.stopWaiting(); return true; }
      this.wait();
      return false;
    }
    if (complete) {
      this.pending = null;
      this.released = false;
      this.stopWaiting();
      this.stats.shown++;
      p.onReady(result, sync);
      return true;
    }
    if (force) {
      this.stats.shown++;
      this.stats.shownIncomplete++;
      p.onReady(result, sync);
    }
    this.wait();
    return false;
  }

  /** Listen for arrivals and keep the cap running. */
  private wait(): void {
    if (!this.unsubscribe) this.unsubscribe = this.env.onFilesArrived(() => this.onArrival());
    if (!this.released) this.armCap();
  }

  private armCap(): void {
    if (this.capTimer !== null) return;
    this.capTimer = this.env.setTimer(() => {
      this.capTimer = null;
      if (!this.pending) return;
      this.released = true;
      this.attempt(false, true);
    }, this.capMs);
  }

  private onArrival(): void {
    if (!this.pending) { this.stopWaiting(); return; }
    if (this.released) {
      if (this.lateRebuilds >= this.maxLateRebuilds) { this.cancel(); return; }
      this.lateRebuilds++;
      // A late rebuild replaces the incomplete picture with a less incomplete one.
      this.attempt(false, true);
      return;
    }
    this.attempt(false, false);
  }

  private stopWaiting(): void {
    if (this.capTimer !== null) { this.env.clearTimer(this.capTimer); this.capTimer = null; }
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }
}
