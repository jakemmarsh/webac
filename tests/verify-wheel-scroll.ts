/**
 * UI lists scroll with the wheel the way the input device intends
 * (ui/wheelScroll.ts): a mouse-wheel notch (±100 px in Chrome/Edge/Safari,
 * a line in Firefox) is one retail step; a touchpad's small pixel deltas
 * and momentum scroll by exactly those pixels (Jake 2026-09-27: "make
 * scrolling panels respond to normal scrolls, e.g. mac touchpad" — every
 * handler used to turn ANY event into a full step by its sign).
 */
import { describe, it, expect } from 'vitest';
import { wheelScrollPixels } from '../packages/renderer/src/ui/wheelScroll.js';

const w = (deltaY: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode });

describe('wheelScrollPixels', () => {
  it('touchpad pixel deltas scroll by their own pixels (smooth, momentum included)', () => {
    expect(wheelScrollPixels(w(3), 14, 280)).toBe(3);
    expect(wheelScrollPixels(w(-7.5), 14, 280)).toBe(-7.5);
    expect(wheelScrollPixels(w(42), 14, 280)).toBe(42);
  });
  it('a mouse notch (±100 px, pixel mode) is one retail step per notch', () => {
    expect(wheelScrollPixels(w(100), 14, 280)).toBe(14);
    expect(wheelScrollPixels(w(-200), 14, 280)).toBe(-28);
  });
  it('line mode (Firefox) is one step per 3-line notch (COMPAT.wheel-deltamode); page mode is the viewport height', () => {
    expect(wheelScrollPixels(w(3, 1), 14, 280)).toBe(14);
    expect(wheelScrollPixels(w(-1, 2), 14, 280)).toBe(-280);
  });
  it('horizontal lists take a sideways swipe, else the vertical wheel', () => {
    expect(wheelScrollPixels(w(1, 0, 12), 32, 128, 'x')).toBe(12);
    expect(wheelScrollPixels(w(100, 0, 2), 32, 128, 'x')).toBe(32);
    expect(wheelScrollPixels(w(0), 32, 128)).toBe(0);
  });
});
