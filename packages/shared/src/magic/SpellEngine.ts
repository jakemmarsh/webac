/**
 * SpellEngine — the spell vocabulary the client displays: magic schools,
 * meta spell types and the client-side SpellDefinition the spellbook holds.
 *
 * Casting is server-authoritative (ACE Player_Magic.cs rolls fizzle, resist,
 * damage and mana), so no local cast simulation lives here.
 */

/**
 * Magic schools — exactly 5 per ACE MagicSchool.cs.
 * (NOT 7 — healing is part of LifeMagic, Summoning is not a school)
 */
export enum MagicSchool {
  None = 0,
  WarMagic = 1,
  LifeMagic = 2,
  ItemEnchantment = 3,
  CreatureEnchantment = 4,
  VoidMagic = 5,
}

/**
 * MetaSpellType — how the spell delivers its effect. Per ACE SpellType.cs.
 *
 * FAITHFUL.78: corrected from prior values that had PortalSending/Dispel/
 * FellowBoost/FellowEnchantment/FellowPortalSending shifted and were
 * missing PortalSummon, LifeProjectile, FellowDispel, EnchantmentProjectile.
 * Now mirrors ACE source byte-for-byte.
 */
export enum MetaSpellType {
  Undef = 0,
  Enchantment = 1,           // duration-based buff/debuff
  Projectile = 2,            // war/void projectile
  Boost = 3,                 // life magic heal/harm
  Transfer = 4,              // life magic drain (transfer vitals)
  PortalLink = 5,            // portal link
  PortalRecall = 6,          // recall
  PortalSummon = 7,          // portal summon
  PortalSending = 8,         // portal sending
  Dispel = 9,                // remove enchantments
  LifeProjectile = 10,       // life-school projectile (drain/harm)
  FellowBoost = 11,          // fellowship-wide boost
  FellowEnchantment = 12,    // fellowship-wide enchantment
  FellowPortalSending = 13,
  FellowDispel = 14,
  EnchantmentProjectile = 15,
}

export interface SpellDefinition {
  id: number;
  name: string;
  /**
   * Spell description from DAT SpellTable (read via readObfuscatedString
   * per `packages/dat-parser/src/file-types/SpellTable.ts:77`). Optional so
   * non-DAT-sourced spells (e.g. legacy test fixtures) can omit it.
   * FAITHFUL.309 — surfaced in the spell-bar slot tooltip.
   */
  desc?: string;
  school: MagicSchool;
  level: number;            // spell level I-VIII (1-8)
  power: number;            // spell power level (affects resist difficulty)
  manaCost: number;
  difficulty: number;       // skill threshold for casting
  duration: number;         // buff/debuff duration in seconds (0 = instant)
  components: number[];     // required component weenie IDs
  targetType: SpellTargetType;
  iconId?: number;            // DAT texture ID for spell icon (0x06xxxxxx)
  metaSpellType?: MetaSpellType;
  // War/Void magic
  minDamage?: number;
  maxDamage?: number;
  damageType?: number;      // DamageType flags
  numProjectiles?: number;
  projectileSpeed?: number;
  // Life magic (Boost)
  boost?: number;           // min heal/harm amount
  maxBoost?: number;        // max heal/harm amount
  // Enchantment
  buffAmount?: number;
  buffAttribute?: number;
  // Legacy compat
  damage?: number;
  healAmount?: number;
}

export enum SpellTargetType {
  Self = 1,
  SingleTarget = 2,
  Fellowship = 3,
  AllInRange = 4,
}
