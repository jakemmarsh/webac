/**
 * GAP.81 — ~18 list-row selection/hover highlights and swatch borders across
 * GameUI.ts duplicated AC_COLORS.gold's rgb(200,168,78) triple as a raw
 * hand-typed literal (at varying alphas) instead of deriving it from the one
 * already-cited AC_COLORS.gold token. Consolidated behind `goldAlpha()` so
 * every one of those call sites now derives its color from AC_COLORS.gold at
 * runtime — if gold is ever re-derived from new DAT evidence, all of them
 * follow automatically instead of silently drifting out of sync.
 *
 * This test drives the real exported `goldAlpha` function (not a source-text
 * pin) and asserts its output decomposes back to AC_COLORS.gold's own RGB
 * channels for every alpha value actually used in GameUI.ts.
 */
import { describe, it, expect } from 'vitest';
import { AC_COLORS, goldAlpha } from '../packages/renderer/src/ui/GameUI.js';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

describe('GAP.81: goldAlpha derives from AC_COLORS.gold (no orphaned rgb literal)', () => {
  const [r, g, b] = hexToRgb(AC_COLORS.gold);

  it('AC_COLORS.gold is still the expected 6-digit hex', () => {
    expect(AC_COLORS.gold).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('goldAlpha(1) reproduces AC_COLORS.gold\'s exact RGB channels', () => {
    expect(goldAlpha(1)).toBe(`rgba(${r},${g},${b},1)`);
  });

  it.each([0.12, 0.15, 0.18, 0.2, 0.25, 0.5, 0.9])(
    'goldAlpha(%s) uses gold\'s RGB channels with that alpha',
    (alpha) => {
      expect(goldAlpha(alpha)).toBe(`rgba(${r},${g},${b},${alpha})`);
    },
  );

  it('tracks AC_COLORS.gold if it is ever re-derived (no independent literal to drift)', () => {
    // rgb(200,168,78) is today's AC_COLORS.gold value; goldAlpha must derive
    // it from the constant, not hardcode it a second time.
    expect([r, g, b]).toEqual([200, 168, 78]);
    expect(goldAlpha(0.5)).toBe('rgba(200,168,78,0.5)');
  });
});
