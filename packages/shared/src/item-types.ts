/**
 * ACE-anchored item/weapon enums for client-side rendering of IdentifyResponse,
 * tooltip text, and item icons. Ported byte-for-byte from:
 *   reference/ACE/Source/ACE.Entity/Enum/AmmoType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/ArmorType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/AttackType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/AttunedStatus.cs
 *   reference/ACE/Source/ACE.Entity/Enum/BondedStatus.cs
 *
 * Numeric values are LOAD-BEARING — they map directly to the values the ACE
 * server writes onto the wire in IdentifyResponse (HookProfile.ammoType,
 * WeaponProfile.attackType) and weenie property tables. Do not renumber.
 */

/** AmmoType — Flags enum on ushort. Per AmmoType.cs. */
export enum AmmoType {
  None             = 0x000,
  Arrow            = 0x001,
  Bolt             = 0x002,
  Atlatl           = 0x004,
  ArrowCrystal     = 0x008,
  BoltCrystal      = 0x010,
  AtlatlCrystal    = 0x020,
  ArrowChorizite   = 0x040,
  BoltChorizite    = 0x080,
  AtlatlChorizite  = 0x100,
}

/** Tooltip label for AmmoType. ACE source has no display name, so we use
 *  the AC client's familiar tooltip wording (e.g. "Arrow", "Chorizite Bolt"). */
export function ammoTypeLabel(t: AmmoType): string {
  switch (t) {
    case AmmoType.None: return '';
    case AmmoType.Arrow: return 'Arrow';
    case AmmoType.Bolt: return 'Bolt';
    case AmmoType.Atlatl: return 'Atlatl';
    case AmmoType.ArrowCrystal: return 'Crystal Arrow';
    case AmmoType.BoltCrystal: return 'Crystal Bolt';
    case AmmoType.AtlatlCrystal: return 'Crystal Atlatl';
    case AmmoType.ArrowChorizite: return 'Chorizite Arrow';
    case AmmoType.BoltChorizite: return 'Chorizite Bolt';
    case AmmoType.AtlatlChorizite: return 'Chorizite Atlatl';
    default: return '';
  }
}

/** ArmorType — per ArmorType.cs. */
export enum ArmorType {
  None           = 0,
  Cloth          = 1,
  Leather        = 2,
  StuddedLeather = 4,
  Scalemail      = 8,
  Chainmail      = 16,
  Metal          = 32,
}

export function armorTypeLabel(t: ArmorType): string {
  switch (t) {
    case ArmorType.None: return '';
    case ArmorType.Cloth: return 'Cloth';
    case ArmorType.Leather: return 'Leather';
    case ArmorType.StuddedLeather: return 'Studded Leather';
    case ArmorType.Scalemail: return 'Scalemail';
    case ArmorType.Chainmail: return 'Chainmail';
    case ArmorType.Metal: return 'Metal';
    default: return '';
  }
}

/**
 * AttackType — Flags enum used by WeaponProfile.attackType. Per AttackType.cs.
 * Includes named aliases (Unarmed, DoubleStrike, TripleStrike, MultiStrike,
 * Offhand, Thrusts, Slashes, Punches) which are bitwise unions of the base
 * flags. They're separate enum members on the wire — TypeScript needs them
 * as numeric constants alongside the enum.
 */
export enum AttackType {
  Undef               = 0x0000,
  Punch               = 0x0001,
  Thrust              = 0x0002,
  Slash               = 0x0004,
  Kick                = 0x0008,
  OffhandPunch        = 0x0010,
  DoubleSlash         = 0x0020,
  TripleSlash         = 0x0040,
  DoubleThrust        = 0x0080,
  TripleThrust        = 0x0100,
  OffhandThrust       = 0x0200,
  OffhandSlash        = 0x0400,
  OffhandDoubleSlash  = 0x0800,
  OffhandTripleSlash  = 0x1000,
  OffhandDoubleThrust = 0x2000,
  OffhandTripleThrust = 0x4000,
}

/** Aliased flag unions per AttackType.cs. */
export const ATTACK_TYPE_UNARMED      = AttackType.Punch | AttackType.Kick | AttackType.OffhandPunch;
export const ATTACK_TYPE_DOUBLE_STRIKE = AttackType.DoubleSlash | AttackType.DoubleThrust | AttackType.OffhandDoubleSlash | AttackType.OffhandDoubleThrust;
export const ATTACK_TYPE_TRIPLE_STRIKE = AttackType.TripleSlash | AttackType.TripleThrust | AttackType.OffhandTripleSlash | AttackType.OffhandTripleThrust;
export const ATTACK_TYPE_OFFHAND       = AttackType.OffhandThrust | AttackType.OffhandSlash | AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash | AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust;
export const ATTACK_TYPE_THRUSTS       = AttackType.Thrust | AttackType.DoubleThrust | AttackType.TripleThrust | AttackType.OffhandThrust | AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust;
export const ATTACK_TYPE_SLASHES       = AttackType.Slash | AttackType.DoubleSlash | AttackType.TripleSlash | AttackType.OffhandSlash | AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash;
export const ATTACK_TYPE_PUNCHES       = AttackType.Punch | AttackType.OffhandPunch;
export const ATTACK_TYPE_MULTI_STRIKE  = ATTACK_TYPE_DOUBLE_STRIKE | ATTACK_TYPE_TRIPLE_STRIKE;

/** Per AttackTypeExtensions.IsMultiStrike in AttackType.cs. */
export function isMultiStrike(t: AttackType): boolean {
  return (t & ATTACK_TYPE_MULTI_STRIKE) !== 0;
}

/** Per AttackTypeExtensions.ReduceMultiStrike — collapses Double/Triple to single. */
export function reduceMultiStrike(t: AttackType): AttackType {
  if (!isMultiStrike(t)) return AttackType.Undef;
  switch (t) {
    case AttackType.DoubleThrust:
    case AttackType.TripleThrust: return AttackType.Thrust;
    case AttackType.DoubleSlash:
    case AttackType.TripleSlash: return AttackType.Slash;
    case AttackType.OffhandDoubleThrust:
    case AttackType.OffhandTripleThrust: return AttackType.OffhandThrust;
    case AttackType.OffhandDoubleSlash:
    case AttackType.OffhandTripleSlash: return AttackType.OffhandSlash;
    default: return AttackType.Undef;
  }
}

/** AttunedStatus — per AttunedStatus.cs (implicit 0,1,2). */
export enum AttunedStatus {
  Normal  = 0,
  Attuned = 1,
  Sticky  = 2,
}

export function attunedStatusLabel(t: AttunedStatus): string {
  switch (t) {
    case AttunedStatus.Normal: return '';
    case AttunedStatus.Attuned: return 'Attuned';
    case AttunedStatus.Sticky: return 'Attuned (Sticky)';
    default: return '';
  }
}

/** BondedStatus — per BondedStatus.cs (signed; Destroy=-2, Slippery=-1). */
export enum BondedStatus {
  Destroy  = -2,
  Slippery = -1,
  Normal   = 0,
  Bonded   = 1,
  Sticky   = 2,
}

export function bondedStatusLabel(t: BondedStatus): string {
  switch (t) {
    case BondedStatus.Destroy: return 'Destroyed on Death';
    case BondedStatus.Slippery: return 'Drops on Death';
    case BondedStatus.Normal: return '';
    case BondedStatus.Bonded: return 'Bonded';
    case BondedStatus.Sticky: return 'Bonded (Sticky)';
    default: return '';
  }
}
