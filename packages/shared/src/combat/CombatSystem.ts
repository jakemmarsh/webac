/**
 * CombatSystem — the combat vocabulary + client-side mode decisions.
 *
 * Combat resolution is server-authoritative (ACE Player_Melee.cs /
 * Player_Missile.cs / DamageEvent.cs roll every hit, crit and block), so
 * only the enums the wire carries and the retail client's own mode choice
 * (ClientCombatSystem) live here.
 */

// Anchored against reference/ACE/Source/ACE.Entity/Enum/CombatMode.cs.
// Server sends these flags in PropertyInt.CombatMode and ChangeCombatMode handler.
export enum CombatMode {
  Undef = 0x00,
  NonCombat = 0x01,
  Melee = 0x02,
  Missile = 0x04,
  Magic = 0x08,
}

// Anchored against reference/ACE/Source/ACE.Entity/Enum/AttackHeight.cs —
// the height byte of TargetedMelee/MissileAttack and the combat callouts.
export enum AttackHeight {
  High = 1,
  Medium = 2,
  Low = 3,
}

// Anchored against reference/ACE/Source/ACE.Entity/Enum/CombatUse.cs —
// shipped as the WeenieHeaderFlag.CombatUse sbyte in CreateObject/UpdateObject.
export enum CombatUse {
  None = 0x00,
  Melee = 0x01,
  Missile = 0x02,
  Ammo = 0x03,
  Shield = 0x04,
  TwoHanded = 0x05,
}

/**
 * CORE.12 — retail ClientCombatSystem::GetDefaultCombatMode @ 0056b310:
 * which combat mode the toggle enters from peace, decided by what's wielded.
 *   1. An item in any weapon slot (mask 0x2500000 = MeleeWeapon |
 *      MissileWeapon | TwoHanded): CombatUse == Missile → Missile,
 *      anything else → Melee.
 *   2. Otherwise an item in EquipMask.Held (0x1000000, the caster slot)
 *      → Magic. (Retail additionally runs a usability vcall on the held
 *      item and falls back to NonCombat + a chat line when the player
 *      can't cast with it; the server has already validated wield
 *      requirements for anything it let us equip, so an equipped caster
 *      maps straight to Magic here.)
 *   3. Nothing wielded → Melee.
 * ACE agrees on the slot→mode map (Player_Inventory.cs TryShuffleStance:
 * MissileWeapon → Missile, Held → Magic, default Melee).
 */
export function getDefaultCombatMode(
  equipped: ReadonlyArray<{ slot: number; combatUse?: number }>,
): CombatMode {
  const WEAPON_SLOTS = 0x02500000; // EquipMask MeleeWeapon | MissileWeapon | TwoHanded
  const HELD_SLOT = 0x01000000;    // EquipMask.Held — wand/orb/staff caster slot
  const weapon = equipped.find((i) => (i.slot & WEAPON_SLOTS) !== 0);
  if (weapon) {
    return weapon.combatUse === CombatUse.Missile ? CombatMode.Missile : CombatMode.Melee;
  }
  if (equipped.some((i) => (i.slot & HELD_SLOT) !== 0)) return CombatMode.Magic;
  return CombatMode.Melee;
}

/**
 * CORE.12.a — plan for a UI-initiated "attack this target" while in peace
 * mode (context-menu Attack / debug attack): which combat mode to enter,
 * and whether a targeted attack event should follow.
 *
 * The mode is getDefaultCombatMode — the same rule the combat toggle uses
 * (retail ClientCombatSystem::ToggleCombatMode @ 0056c8c0), never a
 * hardcoded Melee.
 *
 * sendAttack is true only for Melee/Missile: retail's ExecuteAttack
 * (@ 0056bb70) emits CM_Combat::Event_TargetedMeleeAttack only in
 * MELEE_COMBAT_MODE and Event_TargetedMissileAttack only in
 * MISSILE_COMBAT_MODE — no attack event exists in magic mode (the input
 * dispatch in ClientCombatSystem::OnAction @ 0056d890 routes attack
 * inputs only in modes 2/4). ACE agrees: Player_Melee.cs:55 treats a
 * TargetedMeleeAttack with CombatMode != Melee as a mismatch. With a
 * caster wielded the plan is therefore: enter Magic with the target
 * selected (the player then casts at it) and send no melee swing.
 */
export function getAutoEnterAttackPlan(
  equipped: ReadonlyArray<{ slot: number; combatUse?: number }>,
): { mode: CombatMode; sendAttack: boolean } {
  const mode = getDefaultCombatMode(equipped);
  return {
    mode,
    sendAttack: mode === CombatMode.Melee || mode === CombatMode.Missile,
  };
}
