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
