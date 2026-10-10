/**
 * SwingAnimation — GAP.9: ACE-exact melee swing-animation selection.
 *
 * Ports, line-for-line:
 *  - Player_Melee.cs:440 GetSwingAnimation (power subdivision 0.33, or 0.66
 *    for thrust-slash weapons; unarmed Kick above KickThreshold=0.75;
 *    motions[1] below the subdivision when the CombatManeuverTable has two
 *    entries — "higher-powered animation always in first slot")
 *  - WorldObject_Weapon.cs:1050 GetAttackType + :1097 GetOffhandAttackType
 *    (ThrustThreshold=0.33 + the stance-specific multi-strike and
 *    legacy-weapon special cases, comments preserved)
 *  - WorldObject_Weapon.cs:1039 IsThrustSlash
 *  - Creature_Combat.cs:265 GetCombatStance / :294 GetWeaponStance /
 *    :348 AddShieldStance (CombatStyle → MotionStance)
 *  - CombatManeuverTable.GetMotion (ACE.DatLoader FileTypes) — key on
 *    (style, attackHeight, attackType), IN FILE ORDER.
 *
 * The player's CombatManeuverTable is 0x30000000 (world DB: weenie 1,
 * weenie_properties_d_i_d type 4 = PropertyDataId.CombatTable).
 */

import { AttackType, ATTACK_TYPE_OFFHAND } from '../item-types.js';
import { CombatStyle } from '../ace-enums.js';

export const THRUST_THRESHOLD = 0.33; // WorldObject_Weapon.cs:1033
export const KICK_THRESHOLD = 0.75;   // Player_Melee.cs:432

/** C# Enum.HasFlag: ALL bits of flag present. */
function hasFlag(value: number, flag: number): boolean {
  return (value & flag) === flag;
}

/**
 * MotionStance IDs (full u32 command values, matching the renderer's
 * MotionCommands table and the DAT CombatManeuverTable style field).
 */
export const STANCE = {
  HandCombat:           0x8000003c,
  NonCombat:            0x8000003d,
  SwordCombat:          0x8000003e,
  BowCombat:            0x8000003f,
  SwordShieldCombat:    0x80000040,
  CrossbowCombat:       0x80000041,
  SlingCombat:          0x80000043,
  TwoHandedSwordCombat: 0x80000044,
  DualWieldCombat:      0x80000046,
  ThrownWeaponCombat:   0x80000047,
  Magic:                0x80000049,
  AtlatlCombat:         0x8000013b,
  ThrownShieldCombat:   0x8000013c,
} as const;

/**
 * ACE WorldObject_Weapon.cs:1039 IsThrustSlash — weapon alternates between
 * two attack types across the ThrustThreshold, which widens the power
 * subdivision for animation-slot selection to 0.66.
 */
export function isThrustSlash(wAttackType: number): boolean {
  return hasFlag(wAttackType, AttackType.Slash | AttackType.Thrust) ||
         hasFlag(wAttackType, AttackType.DoubleSlash | AttackType.DoubleThrust) ||
         hasFlag(wAttackType, AttackType.TripleSlash | AttackType.TripleThrust) ||
         hasFlag(wAttackType, AttackType.DoubleSlash); // stiletto
}

/**
 * ACE WorldObject_Weapon.cs:1050 GetAttackType — resolve the weapon's
 * W_AttackType flags + stance + power level to the single AttackType used
 * for the CombatManeuverTable lookup.
 */
export function getWeaponAttackType(
  wAttackType: number,
  stance: number,
  powerLevel: number,
  offhand: boolean,
): number {
  if (offhand) return getOffhandAttackType(wAttackType, powerLevel);

  let attackType = wAttackType & ~ATTACK_TYPE_OFFHAND;

  if (stance === STANCE.DualWieldCombat) {
    if (hasFlag(attackType, AttackType.TripleThrust | AttackType.TripleSlash)) {
      attackType = powerLevel >= THRUST_THRESHOLD ? AttackType.TripleSlash : AttackType.TripleThrust;
    } else if (hasFlag(attackType, AttackType.DoubleThrust | AttackType.DoubleSlash)) {
      attackType = powerLevel >= THRUST_THRESHOLD ? AttackType.DoubleSlash : AttackType.DoubleThrust;
    }
    // handle old bugged stilettos that only have DoubleThrust
    // handle old bugged rapiers w/ Thrust, DoubleThrust
    else if (hasFlag(attackType, AttackType.DoubleThrust)) {
      attackType = (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
        ? AttackType.DoubleThrust : AttackType.Thrust;
    }
    // handle old bugged poniards and newer tachis
    else if (hasFlag(attackType, AttackType.Thrust | AttackType.DoubleSlash)) {
      attackType = powerLevel >= THRUST_THRESHOLD ? AttackType.DoubleSlash : AttackType.Thrust;
    }
    // gaerlan sword / py16 (iasparailaun)
    else if (hasFlag(attackType, AttackType.Thrust | AttackType.TripleSlash)) {
      attackType = powerLevel >= THRUST_THRESHOLD ? AttackType.TripleSlash : AttackType.Thrust;
    }
  } else if (stance === STANCE.SwordShieldCombat) {
    // force thrust animation when using a shield with a multi-strike weapon
    if (hasFlag(attackType, AttackType.TripleThrust)) {
      attackType = (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
        ? AttackType.TripleThrust : AttackType.Thrust;
    } else if (hasFlag(attackType, AttackType.DoubleThrust)) {
      attackType = (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
        ? AttackType.DoubleThrust : AttackType.Thrust;
    }
    // handle old bugged poniards and newer tachis w/ Thrust, DoubleSlash
    // and gaerlan sword / py16 (iasparailaun) w/ Thrust, TripleSlash
    else if (hasFlag(attackType, AttackType.Thrust)
        && (attackType & (AttackType.DoubleSlash | AttackType.TripleSlash)) !== 0) {
      attackType = AttackType.Thrust;
    }
  } else if (stance === STANCE.SwordCombat) {
    // force slash animation when using no shield with a multi-strike weapon
    if (hasFlag(attackType, AttackType.TripleSlash)) {
      attackType = (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
        ? AttackType.TripleSlash : AttackType.Thrust;
    } else if (hasFlag(attackType, AttackType.DoubleSlash)) {
      attackType = (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
        ? AttackType.DoubleSlash : AttackType.Thrust;
    }
    // handle old bugged stilettos that only have DoubleThrust
    else if (hasFlag(attackType, AttackType.DoubleThrust)) {
      attackType = AttackType.Thrust;
    }
  }

  if (hasFlag(attackType, AttackType.Thrust | AttackType.Slash)) {
    attackType = powerLevel >= THRUST_THRESHOLD ? AttackType.Slash : AttackType.Thrust;
  }

  return attackType;
}

/** ACE WorldObject_Weapon.cs:1097 GetOffhandAttackType. */
export function getOffhandAttackType(wAttackType: number, powerLevel: number): number {
  const attackType = wAttackType & ~ATTACK_TYPE_OFFHAND;

  if (hasFlag(attackType, AttackType.TripleThrust | AttackType.TripleSlash)) {
    return powerLevel >= THRUST_THRESHOLD ? AttackType.OffhandTripleSlash : AttackType.OffhandTripleThrust;
  }
  if (hasFlag(attackType, AttackType.DoubleThrust | AttackType.DoubleSlash)) {
    return powerLevel >= THRUST_THRESHOLD ? AttackType.OffhandDoubleSlash : AttackType.OffhandDoubleThrust;
  }
  // handle old bugged stilettos that only have DoubleThrust
  // handle old bugged rapiers w/ Thrust, DoubleThrust
  if (hasFlag(attackType, AttackType.DoubleThrust)) {
    return (powerLevel >= THRUST_THRESHOLD || !hasFlag(attackType, AttackType.Thrust))
      ? AttackType.OffhandDoubleThrust : AttackType.OffhandThrust;
  }
  // handle old bugged poniards and newer tachis w/ Thrust, DoubleSlash
  if (hasFlag(attackType, AttackType.Thrust | AttackType.DoubleSlash)) {
    return powerLevel >= THRUST_THRESHOLD ? AttackType.OffhandDoubleSlash : AttackType.OffhandThrust;
  }
  // gaerlan sword / py16 (iasparailaun)
  if (hasFlag(attackType, AttackType.Thrust | AttackType.TripleSlash)) {
    return powerLevel >= THRUST_THRESHOLD ? AttackType.OffhandTripleSlash : AttackType.OffhandThrust;
  }
  if (hasFlag(attackType, AttackType.Thrust | AttackType.Slash)) {
    return powerLevel >= THRUST_THRESHOLD ? AttackType.OffhandSlash : AttackType.OffhandThrust;
  }
  if (hasFlag(attackType, AttackType.Slash)) return AttackType.OffhandSlash;
  return AttackType.OffhandThrust;
}

/** Player_Melee.cs:462 — unarmed: Kick above 0.75 power (never dual-wield). */
export function getUnarmedAttackType(powerLevel: number, isDualWieldAttack: boolean): number {
  return powerLevel > KICK_THRESHOLD && !isDualWieldAttack ? AttackType.Kick : AttackType.Punch;
}

/** One parsed CombatManeuverTable row (dat-parser CombatManeuver shape). */
export interface CombatManeuverRow {
  style: number;
  attackHeight: number;
  attackType: number;
  motion: number;
}

/**
 * CombatManeuverTable.GetMotion + the Player_Melee.cs:466-469 slot rule:
 * collect the motions for (stance, height, attackType) in FILE ORDER, then
 * pick motions[1] when powerLevel < subdivision and a second slot exists —
 * "higher-powered animation always in first slot".
 * Returns null when the table has no entry (ACE returns Invalid).
 */
export function selectSwingMotion(
  maneuvers: CombatManeuverRow[],
  stance: number,
  attackHeight: number,
  attackType: number,
  powerLevel: number,
  subdivision: number,
): number | null {
  const motions: number[] = [];
  for (const m of maneuvers) {
    if (m.style === stance && m.attackHeight === attackHeight && m.attackType === attackType) {
      motions.push(m.motion);
    }
  }
  if (motions.length === 0) return null;
  return motions.length > 1 && powerLevel < subdivision ? motions[1] : motions[0];
}

export interface SwingAnimationInput {
  maneuvers: CombatManeuverRow[];
  stance: number;
  attackHeight: number; // ACE AttackHeight: High=1, Medium=2, Low=3
  powerLevel: number;   // 0–1
  /** Equipped melee weapon's W_AttackType flags (PropertyInt 47), or null unarmed. */
  weaponAttackType: number | null;
  offhand?: boolean;
  isDualWieldAttack?: boolean;
}

/**
 * Player_Melee.cs:440 GetSwingAnimation — the full selection:
 * weapon/unarmed attack type, power subdivision (0.66 for thrust-slash
 * weapons), CombatManeuverTable lookup, power-slot pick.
 */
export function getSwingAnimation(input: SwingAnimationInput): number | null {
  const { maneuvers, stance, attackHeight, powerLevel } = input;
  let subdivision = 0.33;
  let attackType: number;

  if (input.weaponAttackType !== null) {
    attackType = getWeaponAttackType(input.weaponAttackType, stance, powerLevel, input.offhand ?? false);
    if (isThrustSlash(input.weaponAttackType)) subdivision = 0.66;
  } else {
    attackType = getUnarmedAttackType(powerLevel, input.isDualWieldAttack ?? false);
  }

  return selectSwingMotion(maneuvers, stance, attackHeight, attackType, powerLevel, subdivision);
}

/** Creature_Combat.cs:294 GetWeaponStance — CombatStyle → MotionStance. */
export function getWeaponStance(defaultCombatStyle: number): number {
  switch (defaultCombatStyle) {
    case CombatStyle.Atlatl:             return STANCE.AtlatlCombat;
    case CombatStyle.Bow:                return STANCE.BowCombat;
    case CombatStyle.Crossbow:           return STANCE.CrossbowCombat;
    case CombatStyle.DualWield:          return STANCE.DualWieldCombat;
    case CombatStyle.Magic:              return STANCE.Magic;
    case CombatStyle.OneHanded:          return STANCE.SwordCombat;
    case CombatStyle.OneHandedAndShield: return STANCE.SwordShieldCombat;
    case CombatStyle.Sling:              return STANCE.SlingCombat;
    case CombatStyle.ThrownShield:       return STANCE.ThrownShieldCombat;
    case CombatStyle.ThrownWeapon:       return STANCE.ThrownWeaponCombat;
    // MotionStance.TwoHandedStaffCombat doesn't appear to do anything (ACE comment)
    case CombatStyle.TwoHanded:          return STANCE.TwoHandedSwordCombat;
    case CombatStyle.Unarmed:            return STANCE.HandCombat;
    default:                             return STANCE.HandCombat;
  }
}

/** Creature_Combat.cs:348 AddShieldStance. */
export function addShieldStance(combatStance: number): number {
  if (combatStance === STANCE.SwordCombat) return STANCE.SwordShieldCombat;
  if (combatStance === STANCE.ThrownWeaponCombat) return STANCE.ThrownShieldCombat;
  return combatStance;
}
