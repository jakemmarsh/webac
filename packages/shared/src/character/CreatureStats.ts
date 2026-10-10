/**
 * CreatureStats — the player's CURRENT (buffed) attribute / skill values and
 * carry capacity, layered over the raw AttributeSystem / SkillSystem ranks
 * exactly the way ACE computes them server-side.
 *
 * STATS.enchantments-never-populated — pre-fix every displayed attribute,
 * skill and max vital was the UNBUFFED base: the enchantment registry never
 * reached the stat math, and vitae / augmentations were ignored.
 *
 *   Attribute  ACE CreatureAttribute.GetCurrent(true)   (CreatureAttribute.cs:141-155)
 *   Skill      ACE CreatureSkill.Current / .Base        (CreatureSkill.cs:136-195)
 *              + GetAugBonus_Base / GetAugBonus_Current (CreatureSkill.cs:197-243)
 *   Vital max  VitalSystem.getMaxValue                  (CreatureVital.cs:127-174)
 *   Capacity   ACE Player.GetEncumbranceCapacity        (Player_Inventory.cs:46-51)
 *
 * All arithmetic mirrors ACE's C# `float` (single precision — see Math.fround)
 * and its `.Round()` (MidpointRounding.AwayFromZero, FloatExtensions.cs:9).
 *
 * Where the retail client's own display math differs (CACQualities::InqSkill
 * @ 00592660 has no Enlightenment term and truncates via _ftol2 instead of
 * rounding), we follow ACE: the server enforces ITS numbers (a vital's current
 * is clamped to ACE's max, not the client's), so matching ACE keeps the HUD
 * consistent with what the server sends.
 */

import { AttributeId, type AttributeSystem } from './AttributeSystem.js';
import type { SkillSystem } from './SkillSystem.js';
import { SkillAdvancementClass } from './Heritage.js';
import type { EnchantmentManager } from '../magic/EnchantmentManager.js';
import type { SkillBase } from '@ac/dat-parser';
import { roundHalfAwayFromZero } from '../util/round.js';
import { SkillId } from '../ace-enums.js';
import { PropertyInt } from '../weenie-types.js';
import { getEncumbranceCapacity } from '../physics/MovementSystem.js';

const f32 = Math.fround;

/**
 * The player-only PropertyInt inputs to the stat formulas. Every one is
 * [SendOnLogin] (ACE PropertyInt.cs) so the login PlayerDescription carries
 * them, and PrivateUpdatePropertyInt keeps them current.
 */
export interface PlayerStatMods {
  /** PropertyInt.Enlightenment (390) — +2 max health each, +1 trained skills. */
  enlightenment: number;
  /** PropertyInt.GearMaxHealth (379) — equipped-item max-health rating sum (Player_Vitals.cs:210-220). */
  gearMaxHealth: number;
  /** PropertyInt.LumAugAllSkills (365). */
  lumAugAllSkills: number;
  /** PropertyInt.AugmentationSkilledMelee (300). */
  augmentationSkilledMelee: number;
  /** PropertyInt.AugmentationSkilledMissile (301). */
  augmentationSkilledMissile: number;
  /** PropertyInt.AugmentationSkilledMagic (302). */
  augmentationSkilledMagic: number;
  /** PropertyInt.AugmentationJackOfAllTrades (326). */
  augmentationJackOfAllTrades: number;
  /** PropertyInt.LumAugSkilledSpec (344). */
  lumAugSkilledSpec: number;
  /** PropertyInt.AugmentationIncreasedCarryingCapacity (230). */
  augmentationIncreasedCarryingCapacity: number;
}

/** Read the stat mods off a PropertyInt lookup (the ACE getters default to 0). */
export function playerStatModsFromIntProps(get: (key: number) => number | undefined): PlayerStatMods {
  return {
    enlightenment: get(PropertyInt.Enlightenment) ?? 0,
    gearMaxHealth: get(PropertyInt.GearMaxHealth) ?? 0,
    lumAugAllSkills: get(PropertyInt.LumAugAllSkills) ?? 0,
    augmentationSkilledMelee: get(PropertyInt.AugmentationSkilledMelee) ?? 0,
    augmentationSkilledMissile: get(PropertyInt.AugmentationSkilledMissile) ?? 0,
    augmentationSkilledMagic: get(PropertyInt.AugmentationSkilledMagic) ?? 0,
    augmentationJackOfAllTrades: get(PropertyInt.AugmentationJackOfAllTrades) ?? 0,
    lumAugSkilledSpec: get(PropertyInt.LumAugSkilledSpec) ?? 0,
    augmentationIncreasedCarryingCapacity: get(PropertyInt.AugmentationIncreasedCarryingCapacity) ?? 0,
  };
}

/** ACE Player.MeleeSkills (Player_Skills.cs:554-570). */
export const MELEE_SKILLS: ReadonlySet<number> = new Set([
  SkillId.LightWeapons, SkillId.HeavyWeapons, SkillId.FinesseWeapons, SkillId.DualWield, SkillId.TwoHandedCombat,
  SkillId.Axe, SkillId.Dagger, SkillId.Mace, SkillId.Spear, SkillId.Staff, SkillId.Sword, SkillId.UnarmedCombat,
]);
/** ACE Player.MissileSkills (Player_Skills.cs:572-581). */
export const MISSILE_SKILLS: ReadonlySet<number> = new Set([
  SkillId.MissileWeapons, SkillId.Bow, SkillId.Crossbow, SkillId.Sling, SkillId.ThrownWeapon,
]);
/** ACE Player.MagicSkills (Player_Skills.cs:583-590). */
export const MAGIC_SKILLS: ReadonlySet<number> = new Set([
  SkillId.CreatureEnchantment, SkillId.ItemEnchantment, SkillId.LifeMagic, SkillId.VoidMagic, SkillId.WarMagic,
]);

/**
 * ACE CreatureAttribute.GetCurrent(enchanted) (CreatureAttribute.cs:141-155):
 *   total = (int)Base * multipliers + additives   (float), .Round()
 *   floor at 10 — or 1 when Base < 10 — "attributes cannot be debuffed below 10".
 * Base = StartingValue + Ranks (:93-97) = AttributeSystem.getCurrent.
 */
export function getAttributeCurrent(
  attributes: AttributeSystem,
  id: AttributeId,
  enchantments?: EnchantmentManager | null,
): number {
  const base = attributes.getCurrent(id);
  const multipliers = enchantments ? enchantments.getAttributeModMultiplier(id) : 1.0;
  const additives = enchantments ? enchantments.getAttributeModAdditive(id) : 0;
  const total = roundHalfAwayFromZero(f32(f32(base * multipliers) + additives));
  const minimum = base >= 10 ? 10 : 1;
  return Math.max(minimum, total);
}

/**
 * ACE CreatureSkill.GetAugBonus_Base (CreatureSkill.cs:197-229): LumAugAllSkills,
 * +10 per Master-of-the-* aug for its skill family (one family only — ACE's
 * else-if chain), + Enlightenment for Trained/Specialized skills.
 */
export function getSkillAugBonusBase(skillId: number, advancementClass: number, mods: PlayerStatMods): number {
  let total = 0;
  if (mods.lumAugAllSkills !== 0) total += mods.lumAugAllSkills;
  if (mods.augmentationSkilledMelee > 0 && MELEE_SKILLS.has(skillId)) total += mods.augmentationSkilledMelee * 10;
  else if (mods.augmentationSkilledMissile > 0 && MISSILE_SKILLS.has(skillId)) total += mods.augmentationSkilledMissile * 10;
  else if (mods.augmentationSkilledMagic > 0 && MAGIC_SKILLS.has(skillId)) total += mods.augmentationSkilledMagic * 10;
  if (advancementClass >= SkillAdvancementClass.Trained && mods.enlightenment !== 0) total += mods.enlightenment;
  return total;
}

/**
 * ACE CreatureSkill.GetAugBonus_Current (CreatureSkill.cs:231-243): Jack of All
 * Trades +5, Aura of Specialization +2/level on Specialized skills. Added AFTER
 * vitae ("everything beyond this point does not get scaled by vitae").
 */
export function getSkillAugBonusCurrent(advancementClass: number, mods: PlayerStatMods): number {
  let total = 0;
  if (mods.augmentationJackOfAllTrades !== 0) total += mods.augmentationJackOfAllTrades * 5;
  if (advancementClass === SkillAdvancementClass.Specialized && mods.lumAugSkilledSpec !== 0) total += mods.lumAugSkilledSpec * 2;
  return total;
}

/**
 * ACE CreatureSkill.Base (CreatureSkill.cs:136-151): unbuffed attribute formula
 * (when usable) + InitLevel + Ranks + GetAugBonus_Base for players.
 */
export function getSkillBaseValue(
  skills: SkillSystem,
  skillId: number,
  skillTable: Map<number, SkillBase>,
  attributes: AttributeSystem,
  mods?: PlayerStatMods | null,
): number {
  const base = skills.getBase(skillId, skillTable, attributes);
  return mods ? base + getSkillAugBonusBase(skillId, skills.getAdvancementClass(skillId), mods) : base;
}

/**
 * ACE CreatureSkill.Current (CreatureSkill.cs:154-195):
 *   total  = formula(BUFFED attributes, when usable) + InitLevel + Ranks
 *            + GetAugBonus_Base                      ("base gets scaled by vitae")
 *   fTotal = total × GetSkillMod_Multiplier × Vitae    (float)
 *            + GetAugBonus_Current
 *   Current = max(0, Round(fTotal + GetSkillMod_Additives))
 */
export function getSkillCurrent(
  skills: SkillSystem,
  skillId: number,
  skillTable: Map<number, SkillBase>,
  attributes: AttributeSystem,
  enchantments?: EnchantmentManager | null,
  mods?: PlayerStatMods | null,
): number {
  const advancementClass = skills.getAdvancementClass(skillId);
  let total = skills.getBaseWith(skillId, skillTable, (id) => getAttributeCurrent(attributes, id, enchantments));
  if (mods) total += getSkillAugBonusBase(skillId, advancementClass, mods);

  const multiplier = enchantments ? enchantments.getSkillModMultiplier(skillId) : 1.0;
  let fTotal = f32(total * multiplier);
  if (mods) {
    const vitae = enchantments ? enchantments.getVitae() : 1.0;
    if (vitae !== 1.0) fTotal = f32(fTotal * vitae);
    fTotal = f32(fTotal + getSkillAugBonusCurrent(advancementClass, mods));
  }
  const additives = enchantments ? enchantments.getSkillModAdditive(skillId) : 0;
  const iTotal = roundHalfAwayFromZero(f32(fTotal + additives));
  return Math.max(iTotal, 0);
}

/**
 * ACE Player.GetEncumbranceCapacity (Player_Inventory.cs:46-51) — the BUFFED
 * Strength (`Attributes[Strength].Current`) through EncumbranceSystem.
 * EncumbranceCapacity with the Increased Carrying Capacity augmentation count.
 * The retail client computes the same thing itself: CACQualities::InqLoad
 * @ 0058f130 = EncumbranceCapacity(InqAttribute(Strength, enchanted), InqInt(230)).
 */
export function getPlayerEncumbranceCapacity(
  attributes: AttributeSystem,
  enchantments: EnchantmentManager | null | undefined,
  augmentationIncreasedCarryingCapacity: number,
): number {
  return getEncumbranceCapacity(
    getAttributeCurrent(attributes, AttributeId.Strength, enchantments),
    augmentationIncreasedCarryingCapacity,
  );
}
