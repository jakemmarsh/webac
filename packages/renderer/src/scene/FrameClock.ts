/**
 * MOVE.chunked-motion-judder — the time a game frame simulates up to.
 *
 * requestAnimationFrame hands its callback the frame's timestamp: the start
 * of the frame the browser is about to produce, spaced by the display's
 * refresh (16.7 ms at 60 Hz, 6.9 ms at 144 Hz), whenever in that frame the
 * callback happens to run. `performance.now()` read inside the callback also
 * counts how late it ran (input handlers, network messages, a GC before it),
 * so frames that the screen presents evenly were advanced by 12, 21, 15 ms…
 * and the character and camera visibly moved unevenly. The world is
 * simulated to the rAF timestamp; the background beat (no rAF) uses the
 * clock. Time never runs backwards: a timestamp older than the last frame's
 * (a background beat ran after that frame began) gives a zero-length frame.
 */
export class FrameClock {
  private last = -Infinity;

  /** The time (ms) this frame simulates to. */
  next(frameTime: number | undefined, clockNow: number): number {
    // A timestamp from the future is not a frame time (a polyfill or a bad clock).
    const t = frameTime !== undefined && Number.isFinite(frameTime) && frameTime <= clockNow + 1 ? frameTime : clockNow;
    this.last = Math.max(this.last, t);
    return this.last;
  }
}
