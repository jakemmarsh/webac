/**
 * How far a wheel event scrolls a UI list, in pixels.
 *
 * Retail steps a list one line per wheel notch (the ListBox / Scrollbar
 * wheel handling). Browsers deliver three shapes of wheel input:
 *  - deltaMode 1 (lines — Firefox mouse wheels) and 2 (pages): discrete;
 *    one line = one retail step, one page = the viewport height;
 *  - deltaMode 0 with whole multiples of 100 px (Chrome / Edge / Safari
 *    report a mouse-wheel notch as ±100): a discrete notch — one step each;
 *  - deltaMode 0 with anything else: a touchpad (or a smooth-scrolling
 *    mouse) streaming small pixel deltas plus momentum — scroll by exactly
 *    those pixels, so a two-finger swipe moves the text with the fingers
 *    instead of jumping a whole step per tiny event.
 * `axis` 'y' reads deltaY; 'x' (horizontal lists) reads a horizontal
 * swipe's deltaX when it dominates, else the vertical wheel.
 */
export interface WheelLike { deltaX: number; deltaY: number; deltaMode: number }

const NOTCH_PX = 100;

export function wheelScrollPixels(e: WheelLike, stepPx: number, pagePx: number, axis: 'x' | 'y' = 'y'): number {
  const d = axis === 'x' && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (d === 0) return 0;
  if (e.deltaMode === 1) return d * stepPx;
  if (e.deltaMode === 2) return d * pagePx;
  if (Math.abs(d) >= NOTCH_PX && d % NOTCH_PX === 0) return (d / NOTCH_PX) * stepPx;
  return d;
}
