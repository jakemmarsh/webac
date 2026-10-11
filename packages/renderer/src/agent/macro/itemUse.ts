/**
 * Whether you may use an item's magic, read from the item's own examination,
 * as the server checks it (ACE WorldObject.CheckUseRequirements): Arcane Lore
 * against ItemDifficulty, the ItemSkillLimit skill against
 * ItemSkillLevelLimit, UseRequiresSkill (trained) / UseRequiresSkillSpec
 * (specialized) with UseRequiresSkillLevel, and UseRequiresLevel. An item that
 * has to be wielded to be used (ItemUseable's source Wielded bit) must also
 * pass its wield requirements (WieldRequirements / WieldSkillType /
 * WieldDifficulty) to be wielded at all.
 *
 * VirindiTank checks the same before it uses a buff gem, a Healer's Heart or
 * a wand (MOSS `BuffSelfRule.Consumables`, `TryHealersHeart`, read for facts
 * only). Every value comes from the item, so each era's own items decide.
 */
import { PropertyDataId, PropertyInt, type PlanItem, type PlanSkill } from '@ac/shared';

/** AC skill id of Arcane Lore (ACE Skill.ArcaneLore). */
const ARCANE_LORE = 14;
/** ACE Usable: the source must be wielded (0x4) or contained (0x8); the target flags sit in the high 16 bits. */
const USABLE_WIELDED = 0x4;

/** ACE WieldRequirement values the client can judge: Skill (buffed), RawSkill (base), Level, Training. */
const WIELD_SKILL = 1;
const WIELD_RAW_SKILL = 2;
const WIELD_LEVEL = 7;
const WIELD_TRAINING = 8;

const rank = (s: PlanSkill | undefined): number => (!s ? 0 : s.training === 'specialized' ? 3 : s.training === 'trained' ? 2 : 1);

/** True when the item has to be wielded to be used (ItemUseable's source Wielded bit). */
export function mustWield(item: Pick<PlanItem, 'ints'>): boolean {
  return ((item.ints?.[PropertyInt.ItemUseable] ?? 0) & 0xffff & USABLE_WIELDED) !== 0;
}

/**
 * Why you can't use the item's magic now, or null when you can. Unknown
 * properties (an item not examined) pass: the caller only offers examined items.
 */
export function useRequirementProblem(item: Pick<PlanItem, 'name' | 'ints' | 'dids'>, skills: PlanSkill[], level?: number): string | null {
  const ints = item.ints ?? {};
  const skill = (id: number): PlanSkill | undefined => skills.find((s) => s.id === id);
  const buffed = (id: number): number => skill(id)?.buffed ?? 0;
  const name = (id: number): string => skill(id)?.name ?? `skill ${id}`;
  const lore = ints[PropertyInt.ItemDifficulty];
  if (lore !== undefined && buffed(ARCANE_LORE) < lore) return `${item.name} needs ${lore} Arcane Lore`;
  const limitSkill = item.dids?.[PropertyDataId.ItemSkillLimit];
  const limitLevel = ints[PropertyInt.ItemSkillLevelLimit];
  if (limitSkill !== undefined && limitLevel !== undefined && buffed(limitSkill) < limitLevel) return `${item.name} needs ${limitLevel} ${name(limitSkill)}`;
  const reqLevel = ints[PropertyInt.UseRequiresSkillLevel];
  const trainedSkill = ints[PropertyInt.UseRequiresSkill];
  if (trainedSkill !== undefined) {
    if (rank(skill(trainedSkill)) < 2) return `${item.name} needs ${name(trainedSkill)} trained`;
    if (reqLevel !== undefined && buffed(trainedSkill) < reqLevel) return `${item.name} needs ${reqLevel} ${name(trainedSkill)}`;
  }
  const specSkill = ints[PropertyInt.UseRequiresSkillSpec];
  if (specSkill !== undefined) {
    if (rank(skill(specSkill)) < 3) return `${item.name} needs ${name(specSkill)} specialized`;
    if (reqLevel !== undefined && buffed(specSkill) < reqLevel) return `${item.name} needs ${reqLevel} ${name(specSkill)}`;
  }
  const minLevel = ints[PropertyInt.UseRequiresLevel];
  if (minLevel !== undefined && level !== undefined && level < minLevel) return `${item.name} needs level ${minLevel}`;
  if (mustWield(item)) {
    const req = ints[PropertyInt.WieldRequirements];
    const what = ints[PropertyInt.WieldSkillType];
    const diff = ints[PropertyInt.WieldDifficulty];
    if (req !== undefined && diff !== undefined) {
      if ((req === WIELD_SKILL && what !== undefined && buffed(what) < diff)
        || (req === WIELD_RAW_SKILL && what !== undefined && (skill(what)?.base ?? 0) < diff)
        || (req === WIELD_TRAINING && what !== undefined && rank(skill(what)) < diff)
        || (req === WIELD_LEVEL && level !== undefined && level < diff)) return `${item.name}'s wield requirement isn't met`;
    }
  }
  return null;
}

/** The spell an examined item casts when used (its Spell data id), or undefined. */
export const itemSpellId = (item: Pick<PlanItem, 'dids'>): number | undefined => item.dids?.[PropertyDataId.Spell] || undefined;

/** An examined caster with no mana left can't cast its spell (ItemCurMana 0). */
export const outOfMana = (item: Pick<PlanItem, 'ints'>): boolean => item.ints?.[PropertyInt.ItemCurMana] === 0;
