/**
 * FAITHFUL.13 — Examine-panel row formatting from structured appraisal profiles.
 *
 * The actual row-building lives in GameUI.showExaminePanel (DOM-heavy), but
 * the formatting transforms are pure and worth pinning so they don't drift
 * away from what the original AC client showed.
 *
 * Behavior:
 *   - WeaponProfile.damageMod / weaponOffense displayed as +N% bonus (relative to 1.0 baseline).
 *   - WeaponProfile.damageVariance displayed as N% (absolute, not relative).
 *   - ArmorProfile resistance levels displayed as percentages (e.g. 1.5 → "150%").
 *   - ArmorLevels 9999-asterisk marker stripped for display with trailing "*".
 */
import { describe, it, expect } from 'vitest';

// Pure helpers mirror the formatting inside GameUI.showExaminePanel.
function formatBonus(mod: number): string {
  return `+${((mod - 1) * 100).toFixed(1)}%`;
}
function formatVariance(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}
function formatResist(r: number): string {
  return `${(r * 100).toFixed(0)}%`;
}
function formatAL(n: number): string {
  return n >= 9999 ? `${n - 9999}*` : `${n}`;
}

describe('Examine panel — WeaponProfile formatting', () => {
  it('damage mod 1.20 → "+20.0%"', () => {
    expect(formatBonus(1.20)).toBe('+20.0%');
  });
  it('weapon offense 1.05 → "+5.0%"', () => {
    expect(formatBonus(1.05)).toBe('+5.0%');
  });
  it('weapon offense 1.0 baseline → "+0.0%" (caller suppresses)', () => {
    expect(formatBonus(1.0)).toBe('+0.0%');
  });
  it('damage variance 0.55 → "55%"', () => {
    expect(formatVariance(0.55)).toBe('55%');
  });
});

describe('Examine panel — ArmorProfile formatting', () => {
  it('1.5x resist → "150%"', () => {
    expect(formatResist(1.5)).toBe('150%');
  });
  it('1.0x baseline → "100%"', () => {
    expect(formatResist(1.0)).toBe('100%');
  });
  it('Bane (0.8x weakness) → "80%"', () => {
    expect(formatResist(0.8)).toBe('80%');
  });
  it('-1.0 (server clamp absurdity → exposed for testing) → "-100%"', () => {
    expect(formatResist(-1.0)).toBe('-100%');
  });
});

describe('Splash-screen label colors (GAP.81 — see verify-splash-label-colors-dat-derived.ts for the DAT/decompiled-client evidence)', () => {
  // GAP.81 superseded the originally-invented '#8090b0'/'#706850' pair (no
  // citation) with AC_COLORS.white, backed by LayoutDesc 0x21000000 carrying
  // no Color property for these elements and UIElement_Text's decompiled
  // constructor defaulting every text element to ::RGBAColor_White.
  it('AC_COLORS.splashLabel resolves to white, not the discredited blue-grey', async () => {
    const { AC_COLORS } = await import('../packages/renderer/src/ui/GameUI.js');
    expect(AC_COLORS.splashLabel).toBe(AC_COLORS.white);
    expect(AC_COLORS.splashLabel).not.toBe('#8090b0');
  });
  it('AC_COLORS.splashCopyright resolves to white, not the discredited dark gold', async () => {
    const { AC_COLORS } = await import('../packages/renderer/src/ui/GameUI.js');
    expect(AC_COLORS.splashCopyright).toBe(AC_COLORS.white);
    expect(AC_COLORS.splashCopyright).not.toBe('#706850');
  });
});

describe('Examine panel — ArmorLevels asterisk marker', () => {
  it('normal AL 250 → "250"', () => {
    expect(formatAL(250)).toBe('250');
  });
  it('unenchantable AL (250 + 9999 ACE marker) → "250*"', () => {
    expect(formatAL(10249)).toBe('250*');
  });
  it('exactly 9999 (rare: 0 base + marker) → "0*"', () => {
    expect(formatAL(9999)).toBe('0*');
  });
  it('boundary just below marker → no asterisk', () => {
    expect(formatAL(9998)).toBe('9998');
  });
});
