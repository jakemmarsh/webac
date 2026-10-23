/**
 * DeathSystem — the client's vitae mirror.
 *
 * Death, corpses, item drops, vitae accrual and XP decay are all
 * server-authoritative (ACE Player_Death.cs, EnchantmentManager.UpdateVitae,
 * Player_Xp.cs UpdateXpVitae). The client only mirrors the penalty ACE
 * ships (the Vitae-flagged enchantment's statModValue) and computes the
 * XP-to-next-1% figure the vitae panel prints.
 */

/** Max vitae penalty (ACE PropertyManager vitae_penalty_max = 0.40). */
const MAX_VITAE = 0.40;

/**
 * ACE VitaeCPPoolThreshold (Player_Xp.cs:433): XP required to decay vitae by one
 * 1% step at a given death level and current vitae MULTIPLIER (1.0 = no penalty).
 *   (level^2.5 * 2.5 + 20) * vitaeMultiplier^5 + 0.5
 * The result is `(int)` cast (truncated) by the caller.
 */
export function vitaeCpPoolThreshold(vitaeMultiplier: number, deathLevel: number): number {
  return (Math.pow(deathLevel, 2.5) * 2.5 + 20.0) * Math.pow(vitaeMultiplier, 5.0) + 0.5;
}

/** The 1999 client's cap on one 1% step (0x30d4 at 0x005f0610; the AC1999 server's MAX_VITAE_COST). */
export const VITAE_COST_CAP_1999 = 12500;

/**
 * SWEEP1999.character (CHAR-2) — the 1999 client's VitaeCPPoolThreshold @ 0x005f0610:
 * `min(trunc((level^2 x 5 + 20) x vitae^5 + 0.5), 12500)`. The AC1999 server's
 * VitaeSystem::VitaeCPPoolThreshold (PhatSDK/VitaeSystem.cpp) is the same, so the panel's number
 * is the one the server regains at. Already truncated.
 */
export function vitaeCpPoolThreshold1999(vitaeMultiplier: number, deathLevel: number): number {
  return Math.min(Math.trunc((deathLevel * deathLevel * 5 + 20) * Math.pow(vitaeMultiplier, 5) + 0.5), VITAE_COST_CAP_1999);
}

export class VitaeSystem {
  private _vitaePenalty = 0;

  get vitaePenalty(): number { return this._vitaePenalty; }

  /**
   * FAITHFUL.273 — directly set the vitae penalty from an authoritative
   * server value. The ACE server is the source of truth for vitae state
   * (computed in Player_Death.InflictVitaePenalty + EnchantmentManager.UpdateVitae);
   * after a real death the server ships the value via a Vitae-flagged
   * MagicUpdateEnchantment whose statModValue carries the multiplier
   * (0.95 = 5% penalty, 0.60 = 40% max). Clamp into [0, MAX_VITAE] so
   * a malformed payload can't drive the UI to negative or super-cap.
   */
  setVitaePenalty(penalty: number): void {
    this._vitaePenalty = Math.max(0, Math.min(MAX_VITAE, penalty));
  }

  /** Clear the mirror (character switch). */
  reset(): void {
    this._vitaePenalty = 0;
  }
}
