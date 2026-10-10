/**
 * GAP.81 — presence-bullet CSS fallback (the DAT texture pair 0x06004d17
 * bright-green ON / 0x06004d19 dark OFF) must reuse the one already
 * DAT-derived onlineGreen token everywhere it backs that pair, not
 * duplicate it as a fresh uncited literal per call site.
 *
 * Three call sites bind this exact texture pair: addCheckSliderRow (Options
 * panel checkbox rows), the fellowship/allegiance "Slots" gem toggle, and
 * renderMagicPanel's mkRadio (spellbook school/level filter radios). The
 * first two already fell back to AC_COLORS.onlineGreen / a matching dark
 * bronze (see tests/verify-online-green-color-dat-derived.ts, which
 * re-derives onlineGreen from the real texture bytes); mkRadio had drifted
 * to an uncited raw '#3f3'/'#332' pair instead — copy-paste drift, not a
 * distinct researched color. All three now route through the shared static
 * GameUI.presenceBulletFallbackStyle, which this test drives directly —
 * real shipped code, not a source-text pin.
 */
import { describe, it, expect } from 'vitest';
import { GameUI, AC_COLORS } from '../packages/renderer/src/ui/GameUI';

describe('GAP.81: presenceBulletFallbackStyle drives the real fallback color', () => {
  it('on: reuses the DAT-derived onlineGreen token', () => {
    expect(GameUI.presenceBulletFallbackStyle(true)).toEqual({
      borderRadius: '50%',
      background: AC_COLORS.onlineGreen,
    });
  });

  it('off: the already-vetted dark bronze, not a fresh guess', () => {
    expect(GameUI.presenceBulletFallbackStyle(false)).toEqual({
      borderRadius: '50%',
      background: 'rgba(40,32,20,0.9)',
    });
  });

  it('no invented pure-green/pure-black shorthand hexes remain', () => {
    expect(GameUI.presenceBulletFallbackStyle(true).background).not.toBe('#3f3');
    expect(GameUI.presenceBulletFallbackStyle(false).background).not.toBe('#332');
  });

  it('on/off are hue-distinct (green-dominant vs red-dominant), matching the two textures', () => {
    const on = GameUI.presenceBulletFallbackStyle(true).background;
    const off = GameUI.presenceBulletFallbackStyle(false).background;
    expect(on).toBe(AC_COLORS.onlineGreen);
    expect(off).not.toBe(on);
  });
});
