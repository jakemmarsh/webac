/**
 * BUG.cooldown-id-duration-discarded — retail item-icon cooldown meter.
 *
 * The EoL client drives a ten-step overlay on the icon of a use-triggered
 * item (rare gems) that is recharging:
 *
 *   UIElement_UIItem::UpdateCooldownDisplay @ 004e1e20 (+ DoHeartbeat
 *   @ 004e2070, same logic re-run each UI heartbeat) reads the item's
 *   PublicWeenieDesc _cooldown_id / _cooldown_duration and asks the
 *   player's enchantment registry CEnchantmentRegistry::OnCooldown
 *   @ 005943c0 for the cooldown enchantment whose
 *   (spell id & 0xFFFF) == cooldownId + 0x8000 (ACE
 *   EnchantmentManager.StartCooldown mints exactly that id, spell
 *   category SpellCategory_Cooldown = 0x8000). OnCooldown outputs
 *   remaining = (startTime + duration) - now and drops expired entries.
 *
 *   The meter itself is ten mutually-exclusive full-size overlay elements
 *   Icon_Cooldown_10..100 (0x1000054f..0x10000558 in LayoutDesc
 *   0x21000037 under the UIItem template 0x10000346), each a 32x32 image
 *   — a small clock glyph plus a red fill bar — from textures
 *   0x060067cf (10%) .. 0x060067d8 (100%). Element N0 shows when the
 *   computed decile == N (the 100 element when decile > 9).
 *
 * The exact decile arithmetic is elided by the decompiler (an _ftol2 on
 * an expression Ghidra dropped), but the ten-bucket element switch pins
 * the shape: decile in 1..10 while on cooldown, scaled by
 * remaining/cooldownDuration, and an overlay must be visible the whole
 * time the item is unusable — so any nonzero remainder rounds UP
 * (ceil), keeping the 10% element on screen until expiry. duration <= 0
 * leaves the index 0 (retail shows no element then: iVar5 stays 0 when
 * _cooldown_duration is not positive).
 */

/** ACE EnchantmentManager.cs SpellCategory_Cooldown — cooldown enchantment
 *  spell id = 0x8000 + CooldownId. */
export const COOLDOWN_SPELL_CATEGORY = 0x8000;

/** Texture DID of the 10%-remaining overlay; deciles 2..10 follow
 *  consecutively (0x060067cf..0x060067d8, LayoutDesc 0x21000037). */
export const COOLDOWN_OVERLAY_TEXTURE_BASE = 0x060067cf;

/** The subset of GameUI's tracked enchantment state the meter needs. */
export interface CooldownEnchantmentLike {
  spellId: number;
  isCooldown: boolean;
  /** Lifespan in seconds. */
  duration: number;
  /** Client receipt time in seconds (Date.now()/1000 at add). */
  appliedAt: number;
}

/**
 * CEnchantmentRegistry::OnCooldown mirror: remaining seconds of the active
 * cooldown enchantment paired to `cooldownId`, or 0 when none/expired.
 */
export function cooldownRemainingSeconds(
  cooldownId: number,
  enchantments: Iterable<CooldownEnchantmentLike>,
  nowSeconds: number,
): number {
  if (cooldownId <= 0) return 0;
  const wantId = (cooldownId + COOLDOWN_SPELL_CATEGORY) & 0xFFFF;
  for (const ench of enchantments) {
    if (!ench.isCooldown) continue;
    if ((ench.spellId & 0xFFFF) !== wantId) continue;
    const remaining = (ench.appliedAt + ench.duration) - nowSeconds;
    if (remaining > 0) return remaining;
  }
  return 0;
}

/**
 * UpdateCooldownDisplay mirror: which Icon_Cooldown_N0 overlay to show.
 * Returns 0 (no overlay) when the item is not on cooldown or carries no
 * positive cooldownDuration; else 1..10 = the remaining-time decile.
 */
export function cooldownDecile(
  cooldownId: number,
  cooldownDuration: number,
  enchantments: Iterable<CooldownEnchantmentLike>,
  nowSeconds: number,
): number {
  const remaining = cooldownRemainingSeconds(cooldownId, enchantments, nowSeconds);
  if (remaining <= 0) return 0;
  if (cooldownDuration <= 0) return 0;
  return Math.min(10, Math.max(1, Math.ceil((remaining / cooldownDuration) * 10)));
}

/** Texture DID for a decile from cooldownDecile (1..10). */
export function cooldownOverlayTextureId(decile: number): number {
  return COOLDOWN_OVERLAY_TEXTURE_BASE + (Math.min(10, Math.max(1, decile)) - 1);
}
