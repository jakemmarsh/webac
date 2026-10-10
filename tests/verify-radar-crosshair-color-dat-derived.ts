/**
 * GAP.81 — radarCrosshair AC_COLORS entry (formerly magicSchoolEvil) must be
 * evidence-derived, not a hand-picked hex guess, and the radar's cardinal
 * direction labels must reuse an already-cited AC_COLORS token rather than a
 * second invented literal.
 *
 * AC_COLORS.magicSchoolEvil/magicSchoolEvilFill were named after a
 * "magic school" UI element that grep confirms was never actually built —
 * the only real call sites were the radar's center player-position cross
 * and its N/S/E/W cardinal labels (GameUI.drawRadar). Renamed to
 * radarCrosshair to reflect real usage.
 *
 * reference/images/hud/radar-regular.jpg is a real retail radar screenshot
 * showing this exact green center cross. Pixel-sampling the most
 * green-saturated pixels in an 8px box around the frame's exact center
 * gives avg #4bcc45 (top-5 most-saturated pixels), confirming green is
 * correct and refining the old uncited '#44cc44' guess. The cardinal
 * labels in the same screenshot sample to a warm cream matching the
 * already-cited AC_COLORS.textLight ('#d4c8a0'), so magicSchoolEvilFill is
 * dropped rather than re-derived as a second, separate literal.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';

const ROOT = resolve(__dirname, '..');
const REFERENCE_SCREENSHOT = resolve(ROOT, 'reference/images/hud/radar-regular.jpg');

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

describe('GAP.81: radarCrosshair color has retail screenshot evidence', () => {
  it.skipIf(!existsSync(REFERENCE_SCREENSHOT))('the cited reference screenshot exists in the repo (local-only; reference/images is gitignored, absent in CI)', () => {
    expect(existsSync(REFERENCE_SCREENSHOT)).toBe(true);
  });

  it('AC_COLORS exports radarCrosshair (not the old magicSchoolEvil name) as 6-digit hex', () => {
    expect(AC_COLORS.radarCrosshair).toMatch(/^#[0-9a-f]{6}$/);
    expect((AC_COLORS as Record<string, unknown>).magicSchoolEvil).toBeUndefined();
    expect((AC_COLORS as Record<string, unknown>).magicSchoolEvilFill).toBeUndefined();
  });

  it('radarCrosshair is green-dominant, matching the pixel-sampled retail center cross (avg #4bcc45)', () => {
    const [r, g, b] = hexToRgb(AC_COLORS.radarCrosshair);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g - Math.max(r, b)).toBeGreaterThanOrEqual(100);
  });

  it('cardinal-label fallback no longer needs its own literal — textLight is reused', () => {
    // Sampled cardinal-label cream (~#e3e2c6) is within JPEG-noise tolerance
    // of the already-cited textLight token; assert textLight itself remains
    // a warm cream/tan tone so the reuse stays visually correct.
    const [r, g, b] = hexToRgb(AC_COLORS.textLight);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeGreaterThan(150);
    expect(r).toBeGreaterThanOrEqual(b);
  });
});

describe('GAP.81: combat-mode vector-icon canvas overlay removed as unreachable dead code', () => {
  it('the old magicSchoolWar/ItemTri/Creature* names are gone', () => {
    const colors = AC_COLORS as Record<string, unknown>;
    expect(colors.magicSchoolWar).toBeUndefined();
    expect(colors.magicSchoolItemTri).toBeUndefined();
    expect(colors.magicSchoolCreature).toBeUndefined();
    expect(colors.magicSchoolCreatureFill).toBeUndefined();
  });

  it('combatIconMelee/Missile/MagicFill/MagicStroke are no longer exported', () => {
    // 2026-07-21: dat-parser confirms the 4 combat-mode ornament-frame
    // textures (0x06004cec/ee/f0/f2, LayoutDesc 0x21000016) all decode
    // successfully as 55x58 DXT3 — getTexURL(texId) is therefore always
    // truthy once portal.dat is loaded (required for the client to boot at
    // all), so drawCombatMode's vector sword/bow/star canvas fallback could
    // never actually run. Removed as unreachable invented dead code rather
    // than kept as an "undocumentable fallback" needing a citable color.
    const colors = AC_COLORS as Record<string, unknown>;
    expect(colors.combatIconMelee).toBeUndefined();
    expect(colors.combatIconMissile).toBeUndefined();
    expect(colors.combatIconMagicFill).toBeUndefined();
    expect(colors.combatIconMagicStroke).toBeUndefined();
  });
});
