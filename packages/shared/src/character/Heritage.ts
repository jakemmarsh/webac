/**
 * Heritage — heritage group enum and related constants.
 *
 * Reference: ACE.Entity.Enum.HeritageGroup
 */

export enum Heritage {
  Invalid = 0,
  Aluvian = 1,
  Gharundim = 2,
  Sho = 3,
  Viamontian = 4,
  Shadowbound = 5,
  Gearknight = 6,
  Tumerok = 7,
  Lugian = 8,
  Empyrean = 9,
  Penumbraen = 10,
  Undead = 11,
  Olthoi = 12,
  OlthoiAcid = 13,
}

// Anchored against reference/ACE/Source/ACE.Entity/Enum/Gender.cs.
// MUST be Invalid=0, Male=1, Female=2 — server sends these values directly on
// the wire in PlayerDescription / appraisal / chargen messages.
export enum Gender {
  Invalid = 0,
  Male = 1,
  Female = 2,
}

export enum SkillAdvancementClass {
  Inactive = 0,
  Untrained = 1,
  Trained = 2,
  Specialized = 3,
}

/** Starting towns with their cell IDs */
export enum StartingTown {
  Holtburg = 0,
  Shoushi = 1,
  Yaraq = 2,
  Sanamar = 3,
}

/**
 * Weapon types for heritage mastery check.
 * Anchored against reference/ACE/Source/ACE.Entity/Enum/WeaponType.cs.
 * Server sends these IDs in PropertyInt.WeaponType — must match exactly.
 */
export enum WeaponType {
  Undef = 0,
  Unarmed = 1,
  Sword = 2,
  Axe = 3,
  Mace = 4,
  Spear = 5,
  Dagger = 6,
  Staff = 7,
  Bow = 8,
  Crossbow = 9,
  Thrown = 10,
  TwoHanded = 11,
  Magic = 12,
}

/**
 * Display label for a WeaponType enum value, mirroring ACE's
 * `WeaponType.ToString` (the enum names are already retail-canonical —
 * "Sword", "Axe", "TwoHanded", etc.) with space-insertion before the
 * interior capital in "TwoHanded" → "Two Handed".
 *
 * Used by the appraisal panel's "Weapon Type" row (FAITHFUL.316) and
 * by any other code that needs a player-facing label without bringing
 * in the full enum names map.
 *
 * Returns `null` for Undef (0) so callers can skip the row, and for
 * any unknown ID (defensive — future ACE additions surface visibly).
 */
export function weaponTypeLabel(t: WeaponType): string | null {
  const name = WeaponType[t];
  if (!name || name === 'Undef') return null;
  return name.replace(/([A-Z][a-z])/g, ' $1').trim();
}
