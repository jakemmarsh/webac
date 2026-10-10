/**
 * Regression test for buildTexBgStyle — guards the fix from iteration 3
 * that made semi-transparent DAT textures render over an opaque base color.
 *
 * Bug: the old helper only set backgroundImage when a texture loaded, so
 * semi-transparent textures (e.g. 0x06004cc2 alpha 175) let HUD elements
 * behind the panel (radar, coord text) bleed through.
 *
 * Fix: always set backgroundColor to the fallback when the fallback is a
 * plain color, so the texture layers opaquely over it.
 */
import { describe, it, expect } from 'vitest';
import { buildTexBgStyle } from '../packages/renderer/src/ui/GameUI.js';

describe('buildTexBgStyle', () => {
  const SAMPLE_URL = 'data:image/png;base64,AAA';

  it('falls back to background shorthand when the texture URL is null', () => {
    const style = buildTexBgStyle(null, 'rgba(10,8,4,0.92)');
    expect(style).toEqual({ background: 'rgba(10,8,4,0.92)' });
  });

  it('sets backgroundColor as opaque base when the texture URL loads', () => {
    // Classic bleed-through case: 0x06004cc2 is semi-transparent, caller
    // passes a solid dark fallback to serve as the opaque base under it.
    const style = buildTexBgStyle(SAMPLE_URL, 'rgba(10,8,4,0.92)');
    expect(style.backgroundImage).toBe(`url(${SAMPLE_URL})`);
    expect(style.backgroundSize).toBe('100% 100%');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.backgroundColor).toBe('rgba(10,8,4,0.92)');
  });

  it('respects transparent fallback (still sets backgroundColor=transparent)', () => {
    // Some callers intentionally want transparency behind the texture
    // (e.g. aura icons, inactive indicators); they pass 'transparent'.
    const style = buildTexBgStyle(SAMPLE_URL, 'transparent');
    expect(style.backgroundColor).toBe('transparent');
  });

  it('does not set backgroundColor for full CSS declaration fallbacks', () => {
    // A handful of callers pass a full declaration (e.g. for a border or
    // `background:` shorthand). Those should NOT be set as backgroundColor
    // because that would be an invalid value.
    const style = buildTexBgStyle(SAMPLE_URL, 'border-top: 1px solid #8a7034');
    expect(style.backgroundColor).toBeUndefined();
    expect(style.backgroundImage).toBe(`url(${SAMPLE_URL})`);
  });

  it('does not set backgroundColor for empty fallbacks', () => {
    const style = buildTexBgStyle(SAMPLE_URL, '');
    expect(style.backgroundColor).toBeUndefined();
    expect(style.backgroundImage).toBe(`url(${SAMPLE_URL})`);
  });
});
