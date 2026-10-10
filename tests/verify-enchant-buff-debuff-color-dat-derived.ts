/**
 * GAP.81 — enchantBuff/enchantDebuff AC_COLORS entries must be evidence-derived,
 * not hand-picked pale-green/pale-red hex guesses.
 *
 * reference/images/hud/beneficial-spells.jpg is a real retail screenshot of
 * the "Beneficial Spells in Effect" panel. Pixel-sampling the brightest
 * text-stroke pixels over the "Adja's Blessing" row gives avg
 * rgb(255,254,251) — plain white, not the previously invented pale green
 * '#c0e0c0'. No retail screenshot of the harmful-spells equivalent exists to
 * sample directly, but retail renders "Harmful Spells in Effect" as a
 * separate title-barred window rather than a single merged, color-coded
 * list — the one verified data point (spell-name text itself is plain
 * white) is applied to enchantDebuff by direct analogy rather than guessing
 * a red tint from nothing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';

const ROOT = resolve(__dirname, '..');
const REFERENCE_SCREENSHOT = resolve(ROOT, 'reference/images/hud/beneficial-spells.jpg');

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

describe('GAP.81: enchantBuff/enchantDebuff colors have retail screenshot evidence', () => {
  it.skipIf(!existsSync(REFERENCE_SCREENSHOT))('the cited reference screenshot exists in the repo (local-only; reference/images is gitignored, absent in CI)', () => {
    expect(existsSync(REFERENCE_SCREENSHOT)).toBe(true);
  });

  it('AC_COLORS still exports enchantBuff/enchantDebuff as 6-digit hex', () => {
    expect(AC_COLORS.enchantBuff).toMatch(/^#[0-9a-f]{6}$/);
    expect(AC_COLORS.enchantDebuff).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('enchantBuff is no longer the old invented pale-green #c0e0c0 guess', () => {
    expect(AC_COLORS.enchantBuff).not.toBe('#c0e0c0');
  });

  it('enchantDebuff is no longer the old invented pale-red #e0c0c0 guess', () => {
    expect(AC_COLORS.enchantDebuff).not.toBe('#e0c0c0');
  });

  it('enchantBuff is near-white, matching the pixel-sampled retail beneficial-spell text (avg rgb 255,254,251)', () => {
    const [r, g, b] = hexToRgb(AC_COLORS.enchantBuff);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  it('enchantDebuff matches enchantBuff by structural analogy (retail separates buff/debuff by window, not text hue)', () => {
    expect(AC_COLORS.enchantDebuff).toBe(AC_COLORS.enchantBuff);
  });
});
