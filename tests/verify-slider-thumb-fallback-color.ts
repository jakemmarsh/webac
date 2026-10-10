/**
 * GAP.85 — the options slider thumb (buildSliderTrack) must reuse
 * the already-DAT-derived AC_COLORS.goldLight/goldDim/black tokens for its
 * CSS fallback (shown only when its DAT texture — CORE.17.h.d: 0x06001286,
 * the UIOption_Slider widget — fails to load), not
 * duplicate their hex values as fresh uncited literals. It had drifted to a
 * raw `linear-gradient(180deg, #e8c87a, #8a7034)` + `1px solid #2a2010` —
 * #e8c87a/#8a7034 are exact duplicates of goldLight/goldDim, and #2a2010 had
 * no citation at all. GameUI.sliderThumbFallbackStyle is the extracted,
 * directly-testable static that replaced the inline literals — real shipped
 * code, not a source-text pin.
 */
import { describe, it, expect } from 'vitest';
import { GameUI, AC_COLORS } from '../packages/renderer/src/ui/GameUI';

describe('GAP.85: sliderThumbFallbackStyle drives the real fallback style', () => {
  it('reuses the DAT-derived goldLight/goldDim tokens in the gradient', () => {
    const style = GameUI.sliderThumbFallbackStyle();
    expect(style.background).toBe(`linear-gradient(180deg, ${AC_COLORS.goldLight}, ${AC_COLORS.goldDim})`);
  });

  it('reuses AC_COLORS.goldDim for the border', () => {
    expect(GameUI.sliderThumbFallbackStyle().border).toBe(`1px solid ${AC_COLORS.goldDim}`);
  });

  it('reuses AC_COLORS.black for the shadow', () => {
    expect(GameUI.sliderThumbFallbackStyle().boxShadow).toBe(`0 0 1px ${AC_COLORS.black}`);
  });

  it('no wholly-uncited literal (#2a2010) or shorthand-black (#000) remains', () => {
    const style = GameUI.sliderThumbFallbackStyle();
    const serialized = `${style.background} ${style.border} ${style.boxShadow}`;
    expect(serialized).not.toContain('#2a2010');
    expect(serialized).not.toMatch(/#000\b/); // shorthand, distinct from AC_COLORS.black ('#000000')
  });

  it('gradient/border values are sourced from AC_COLORS, not independent literals', () => {
    const style = GameUI.sliderThumbFallbackStyle();
    expect(style.background).toContain(AC_COLORS.goldLight);
    expect(style.background).toContain(AC_COLORS.goldDim);
    expect(style.border).toContain(AC_COLORS.goldDim);
    expect(style.boxShadow).toContain(AC_COLORS.black);
  });
});
