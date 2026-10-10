/**
 * AnimSpeed — BUG.melee-swing-speed-ignores-quickness-weapon: ACE-exact
 * melee swing animation speed.
 *
 * Port of Creature_Combat.cs:503-522 GetAnimSpeed:
 *   divisor = 1 - quickness/300 + weaponSpeed/150
 *   animSpeed = clamp(1/divisor, 0.5, 2.0)   (or 2.0 if divisor <= 0)
 *
 * Player_Melee.cs:402-404 DoSwingMotion then applies the dual-wield 1.2x
 * multiplier on top: animSpeed = GetAnimSpeed() * (dualWield ? 1.2 : 1.0).
 */

export const MIN_ATTACK_SPEED = 0.5; // Creature_Combat.cs:503
export const MAX_ATTACK_SPEED = 2.0; // Creature_Combat.cs:504

/**
 * @param quickness - Quickness.Current attribute value
 * @param weaponSpeed - equipped weapon's PropertyInt.WeaponTime (WorldObject_Weapon.cs:270
 *   GetWeaponSpeed; unarmed/no weapon defaults to 40, WorldObject_Weapon.cs:265)
 */
export function getAnimSpeed(quickness: number, weaponSpeed: number): number {
  const divisor = 1.0 - quickness / 300.0 + weaponSpeed / 150.0;
  if (divisor <= 0) return MAX_ATTACK_SPEED;

  return Math.min(MAX_ATTACK_SPEED, Math.max(MIN_ATTACK_SPEED, 1.0 / divisor));
}

/** WorldObject_Weapon.cs:265 defaultSpeed — used when unarmed / weapon has no WeaponTime. */
export const DEFAULT_WEAPON_SPEED = 40;
