/**
 * GAP.56 — "Vitae stack (debt + Luminance recovery)". The vitae DEBT side is
 * fully faithful to ACE; the "Luminance recovery" half is a WRONG PREMISE.
 *
 * DEBT (verified faithful vs ACE):
 *   - +5% penalty per death (ACE vitae_penalty default 0.05; InflictVitaePenalty
 *     amount=5; EnchantmentManager.UpdateVitae subtracts vitae_penalty from the
 *     multiplier).
 *   - capped at the per-level max (ACE GetMinVitae: maxPenalty = clamp((level-1)*3,
 *     1, 40); the global cap is vitae_penalty_max default 0.40).
 *   - RECOVERS by earning XP into the vitae CP pool: each time the pool reaches
 *     VitaeCPPoolThreshold(multiplier, deathLevel) = (level^2.5*2.5+20)*mult^5+0.5,
 *     the penalty drops 1% (ACE ReduceVitae += 0.01) and the threshold is recomputed.
 *
 * WRONG PREMISE — there is no Luminance→vitae recovery in retail. ACE vitae
 * recovery is XP-only: Player_Xp.GrantXP calls UpdateXpVitae (gated on
 * xpType != Allegiance); Player_Luminance (EarnLuminance/GrantLuminance/
 * AddLuminance/UpdateLuminance) never touches vitae, so the client having no
 * vitae coupling to luminance is faithful, not a gap.
 *
 * Behavioral tests drive the shipped VitaeSystem mirror + vitaeCpPoolThreshold
 * (the vitae panel's XP-to-next-1% figure);
 * reference-anchored tests (skipIf ACE absent) lock the XP-only-recovery truth.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { VitaeSystem, vitaeCpPoolThreshold } from '@ac/shared';

describe('GAP.56 — the client mirrors the server-computed vitae (shipped VitaeSystem)', () => {
  it('the mirror is clamped to ACE vitae_penalty_max (0.40) and never negative', () => {
    // Accrual, the per-level cap and XP decay are ACE's (Player_Death.cs,
    // EnchantmentManager.UpdateVitae, Player_Xp.cs UpdateXpVitae); the client
    // only mirrors the penalty the Vitae enchantment ships.
    const v = new VitaeSystem();
    v.setVitaePenalty(0.05);
    expect(v.vitaePenalty).toBeCloseTo(0.05, 6);
    v.setVitaePenalty(0.9);
    expect(v.vitaePenalty).toBeCloseTo(0.40, 6);
    v.setVitaePenalty(-1);
    expect(v.vitaePenalty).toBe(0);
  });
});

describe('GAP.56 — vitae recovery is XP-driven via the CP-pool threshold', () => {
  it('vitaeCpPoolThreshold matches ACE (level^2.5*2.5+20)*mult^5+0.5', () => {
    // multiplier 0.95 (5% penalty), level 50
    const expected = (Math.pow(50, 2.5) * 2.5 + 20) * Math.pow(0.95, 5) + 0.5;
    expect(vitaeCpPoolThreshold(0.95, 50)).toBeCloseTo(expected, 6);
  });
});

const ACE = 'reference/ACE/Source/ACE.Server';
const hasAce = fs.existsSync(`${ACE}/WorldObjects/Player_Xp.cs`);

describe.skipIf(!hasAce)('GAP.56 — vitae recovery is XP-only, NOT Luminance (ACE ground truth)', () => {
  it('positive control: XP grants drive vitae recovery (GrantXP → UpdateXpVitae)', () => {
    const xp = fs.readFileSync(`${ACE}/WorldObjects/Player_Xp.cs`, 'utf8');
    expect(xp).toMatch(/UpdateXpVitae\(/);
    // recovery is gated off Allegiance-passthrough XP
    expect(xp).toMatch(/xpType != XpType\.Allegiance/);
  });

  it('Luminance grants do NOT touch vitae — no Luminance→vitae recovery exists', () => {
    const lum = fs.readFileSync(`${ACE}/WorldObjects/Player_Luminance.cs`, 'utf8');
    expect(lum).toMatch(/GrantLuminance/); // it IS the luminance-grant file
    expect(/vitae|UpdateXpVitae/i.test(lum)).toBe(false);
  });

  it('ACE property defaults (vitae_penalty 0.05, vitae_penalty_max 0.40 — the mirror clamp)', () => {
    const pm = fs.readFileSync(`${ACE}/Managers/PropertyManager.cs`, 'utf8');
    expect(pm).toMatch(/"vitae_penalty",\s*new Property<double>\(0\.05/);
    expect(pm).toMatch(/"vitae_penalty_max",\s*new Property<double>\(0\.40/);
  });
});
