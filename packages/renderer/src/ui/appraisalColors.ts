/**
 * Appraisal enchantment-highlight coloring (SWEEP.5).
 *
 * ACE sends paired `highlight`/`color` u16 bitfields on item appraisal: a set
 * highlight bit means the stat is modified by an enchantment; the matching
 * color bit means that modifier is a BUFF (green), clear means a DEBUFF (red).
 * Kept pure + DOM-free so the bit logic is unit-testable; GameUI maps the
 * returned state to its AC_COLORS palette.
 *
 * Masks are the ACE Network/Enum bit values:
 *   ArmorMask.cs  — armor protection rows (flag 0x0200 armorEnchantment)
 *   WeaponMask.cs — weapon stat rows      (flag 0x0800 weaponEnchantment)
 * (Armor "Nether" has no ArmorMask bit, so it is never tinted.)
 */
export type EnchantState = 'buff' | 'debuff' | null;

export function enchantmentValueState(highlight: number, color: number, mask: number): EnchantState {
  if (!(highlight & mask)) return null;
  return (color & mask) ? 'buff' : 'debuff';
}

/** ArmorMask bits (ACE ArmorMask.cs) for the ArmorProfile resistance rows. */
export const ARMOR_MASK = {
  Slashing: 0x2,
  Piercing: 0x4,
  Bludgeoning: 0x8,
  Cold: 0x10,
  Fire: 0x20,
  Acid: 0x40,
  Lightning: 0x80,
} as const;

/** WeaponMask bits (ACE WeaponMask.cs) for the WeaponProfile stat rows. */
export const WEAPON_MASK = {
  AttackSkill: 0x1,
  MeleeDefense: 0x2,
  Speed: 0x4,
  Damage: 0x8,
  DamageVariance: 0x10,
  DamageMod: 0x20,
} as const;

/**
 * ResistMask bits (ACE Network/Enum/ResistMask.cs) relevant to the
 * caster-implement bonus rows (FAITHFUL.305). ManaConversionMod/
 * ElementalDamageMod are the only two ResistMask bits with an appraisal row
 * in this client — the rest of the enum covers wielder resistance-mod rows
 * that AC never rendered in the tooltip.
 */
export const RESIST_MASK = {
  ManaConversionMod: 0x1000,
  ElementalDamageMod: 0x2000,
} as const;
