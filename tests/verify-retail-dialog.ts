/**
 * HARNESS.retail-ab-multiplayer-frames — tools/lib/retail-dialog.ts, which
 * finds the Yes button of a retail confirmation dialog in a frame of the real
 * client so tools/probe-two-client-retail-ab.ts can answer it.
 */
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { retailYesButton } from '../tools/lib/retail-dialog.ts';

type Rect = { x: number; y: number; w: number; h: number; rgb: [number, number, number] };

/** A 1600x900 frame of grass-green with the given rectangles painted over it. */
function frame(rects: Rect[]): PNG {
  const png = new PNG({ width: 1600, height: 900 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([60, 90, 40, 255], i);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) png.data.set([...r.rgb, 255], (y * 1600 + x) * 4);
    }
  }
  return png;
}

const RED: [number, number, number] = [120, 0, 0];
// The fellowship invite as retail drew it at 1600x900: Yes at 681-757 x 463-488, No at 841-917.
const YES = { x: 683, y: 464, w: 72, h: 23, rgb: RED };
const NO = { x: 843, y: 464, w: 72, h: 23, rgb: RED };

describe('retailYesButton', () => {
  it('returns the centre of the leftmost button of a Yes/No dialog', () => {
    expect(retailYesButton(frame([{ x: 600, y: 395, w: 400, h: 110, rgb: [15, 20, 35] }, YES, NO]))).toEqual({ x: 719, y: 475 });
  });

  it('returns null when no dialog is up', () => {
    expect(retailYesButton(frame([]))).toBeNull();
  });

  it('ignores red HUD pieces outside the dialog area and thin red bars', () => {
    // The health bar sits at the top centre; a thin red line is not a button face.
    const hud = [{ x: 725, y: 8, w: 150, h: 10, rgb: RED }, { x: 500, y: 600, w: 300, h: 4, rgb: RED }];
    expect(retailYesButton(frame(hud))).toBeNull();
    expect(retailYesButton(frame([...hud, NO, YES]))).toEqual({ x: 719, y: 475 });
  });

  it('skips a scattered red texture that is not mostly filled', () => {
    const png = frame([]);
    for (let y = 400; y < 430; y += 2) {
      for (let x = 700; x < 800; x += 2) png.data.set([...RED, 255], (y * 1600 + x) * 4);
    }
    expect(retailYesButton(png)).toBeNull();
  });
});
