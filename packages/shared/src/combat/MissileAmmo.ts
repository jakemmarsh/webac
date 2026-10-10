/**
 * MissileAmmo — GAP.88: client-side mirror of ACE's silent no-weapon/no-ammo
 * rejection for missile attacks.
 *
 * Port of Player_Missile.cs:84-88:
 *   if (weapon == null || weapon.IsAmmoLauncher && ammo == null)
 *   {
 *       OnAttackDone();
 *       return;
 *   }
 * with IsAmmoLauncher per WorldObject.cs:78-80 = IsBow || IsAtlatl, and
 * IsBow = DefaultCombatStyle is Bow or Crossbow. ThrownWeapon is
 * deliberately excluded — a thrown weapon's own wielded stack IS its ammo,
 * so it needs no separate MissileAmmo slot.
 *
 * ACE never sends a WeenieError for this rejection (OnAttackDone alone), so
 * the send just fizzles with nothing visible to the player. The client
 * mirrors the check locally instead of round-tripping a doomed packet.
 */

import { CombatStyle } from '../ace-enums.js';

const AMMO_LAUNCHER_STYLES = CombatStyle.Bow | CombatStyle.Crossbow | CombatStyle.Atlatl;

/** True if a weapon with this DefaultCombatStyle requires separate ammo to fire. */
export function isAmmoLauncherCombatStyle(combatStyle: number): boolean {
  return (combatStyle & AMMO_LAUNCHER_STYLES) !== 0;
}

/** Mirrors Player_Missile.cs:84-88's weapon/ammo precondition. */
export function canFireMissile(hasWeapon: boolean, combatStyle: number, hasAmmo: boolean): boolean {
  if (!hasWeapon) return false;
  if (isAmmoLauncherCombatStyle(combatStyle) && !hasAmmo) return false;
  return true;
}
