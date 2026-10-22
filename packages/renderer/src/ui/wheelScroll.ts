/**
 * Wheel input, normalised across browsers: one physical wheel click is one
 * notch everywhere, and a touchpad stays smooth.
 *
 * Retail steps a list one line per wheel notch (the ListBox / Scrollbar
 * wheel handling), moves the camera one CameraSet step per notch, and fires
 * a wheel-bound command once per notch (CInputManager_WIN32::
 * GenerateMouseWheelEvent @ 00689510: one press + release per WM_MOUSEWHEEL
 * WHEEL_DELTA = 120). What browsers deliver for one click (COMPAT.wheel-deltamode):
 *  - Firefox (Windows, Linux and a macOS mouse): deltaMode 1 (lines), the
 *    system's lines-per-notch (3 by default) — but ONLY when the page reads
 *    `deltaMode` before `deltaX/Y`; a delta read first is converted to pixels
 *    at the target's line height (bug 1392460, Firefox 88+). readWheel reads
 *    deltaMode first. A busy main thread can coalesce clicks into one event
 *    (6 lines = 2 clicks), so the per-click line count is learned as the
 *    smallest line delta seen.
 *  - Chrome / Edge / Safari: deltaMode 0 (pixels). The pixel size of a click
 *    varies: ~100 px on Windows at three lines, scaled by the lines setting,
 *    ~53 px on Linux, accelerated small values on macOS, and reported as
 *    150 at 150 % display scaling by some Chrome builds. The legacy
 *    `wheelDeltaY` they also send is WHEEL_DELTA-based: a whole multiple of
 *    120 per click, whatever the pixels. That is the click count when
 *    present. Without it, a whole multiple of 100 px is a click (Chrome on
 *    Windows).
 *  - A touchpad (or smooth-scrolling mouse): deltaMode 0, small pixel
 *    deltas plus momentum, wheelDelta not a multiple of 120. Lists scroll by
 *    those pixels and the camera by the fraction of a 100 px notch.
 */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  /** Legacy WHEEL_DELTA-based deltas (Chrome, Safari, Edge; positive = up / left). */
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

const NOTCH_PX = 100;
/** WHEEL_DELTA: one click in the legacy wheelDelta units. */
export const WHEEL_DELTA = 120;
/** Lines one click reports in line mode by default (Windows' SPI_GETWHEELSCROLLLINES default, Firefox on Linux). */
export const LINES_PER_NOTCH = 3;

/** The smallest line-mode delta seen this page: the system's lines per click. */
let learnedLinesPerNotch = Infinity;
/** Tests: forget the learned lines per click. */
export function resetWheelLearning(): void { learnedLinesPerNotch = Infinity; }

export interface WheelReading {
  mode: number;
  dx: number;
  dy: number;
  /**
   * Whole mouse-wheel clicks on the chosen axis (signed like deltaY), or
   * null when the event is a touchpad's continuous scroll.
   */
  clicks: number | null;
}

/** deltaMode first, then the deltas (Firefox converts a delta read first to pixels). */
export function readWheel(e: WheelLike, axis: 'x' | 'y' = 'y'): WheelReading {
  // A WheelEvent's deltaMode defaults to 0 (DOM_DELTA_PIXEL); an event built without one is pixels.
  const mode = typeof e.deltaMode === 'number' ? e.deltaMode : 0;
  const dx = e.deltaX;
  const dy = e.deltaY;
  const horizontal = axis === 'x' && Math.abs(dx) > Math.abs(dy);
  const d = horizontal ? dx : dy;
  let clicks: number | null = null;
  if (d !== 0) {
    if (mode === 1) {
      const lines = Math.abs(d);
      if (lines < learnedLinesPerNotch) learnedLinesPerNotch = lines;
      // Never under one line: a fractional line delta (an accelerated macOS
      // stream) is one click per event, not a burst.
      const unit = Math.max(1, learnedLinesPerNotch);
      clicks = Math.sign(d) * Math.max(1, Math.round(lines / unit));
    } else if (mode === 0) {
      const wd = horizontal ? e.wheelDeltaX : e.wheelDeltaY;
      if (typeof wd === 'number' && wd !== 0 && Number.isFinite(wd) && wd % WHEEL_DELTA === 0) {
        // wheelDelta is positive for wheel up; deltaY positive for wheel down.
        clicks = Math.sign(d) * Math.abs(wd / WHEEL_DELTA);
      } else if (typeof wd !== 'number' && Math.abs(d) >= NOTCH_PX && d % NOTCH_PX === 0) {
        clicks = d / NOTCH_PX;
      }
    }
  }
  return { mode, dx, dy, clicks };
}

/**
 * The event in notches (signed like deltaY: positive = wheel down / toward
 * the user): whole clicks for a mouse wheel, a fraction of a 100 px notch for
 * a touchpad, pages as whole notches.
 */
export function wheelNotches(e: WheelLike): number {
  const r = readWheel(e);
  if (r.dy === 0) return 0;
  if (r.clicks !== null) return r.clicks;
  if (r.mode === 2) return r.dy;
  return r.dy / NOTCH_PX;
}

/** How far a wheel event scrolls a UI list, in pixels: a retail step per click, a touchpad's own pixels. */
export function wheelScrollPixels(e: WheelLike, stepPx: number, pagePx: number, axis: 'x' | 'y' = 'y'): number {
  const r = readWheel(e, axis);
  const d = axis === 'x' && Math.abs(r.dx) > Math.abs(r.dy) ? r.dx : r.dy;
  if (d === 0) return 0;
  if (r.clicks !== null) return r.clicks * stepPx;
  if (r.mode === 2) return d * pagePx;
  return d;
}

/**
 * Whole notches for a discrete command bound to a wheel direction: a mouse
 * click fires at once; a touchpad's stream fires once per 100 px gathered
 * (the remainder carries; a direction change starts over), so a swipe is not
 * dozens of presses.
 */
export class WheelNotchCounter {
  private carry = 0;
  /** Signed whole notches this event completes (0: none yet). */
  add(e: WheelLike): number {
    return this.addNotches(wheelNotches(e));
  }

  /** As add(), for an event already read with wheelNotches. */
  addNotches(n: number): number {
    if (n === 0) return 0;
    if (Math.sign(n) !== Math.sign(this.carry)) this.carry = 0;
    this.carry += n;
    const whole = Math.trunc(this.carry + Math.sign(this.carry) * 1e-9);
    this.carry -= whole;
    return whole || 0; // never -0
  }
}
