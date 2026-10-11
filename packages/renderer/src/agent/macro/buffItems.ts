/**
 * VirindiTank's buff items, rebuff pacing and fast casting (docs/vtank-parity-gaps.md §2.1, §2.2, §2.6;
 * facts from MOSS `BuffSelfRule`, `BuffSelfRule.Consumables` and the wiki's changelog, no code copied).
 *
 * Buff items: a carried gem, food or potion whose own spell (its Spell data id, read from its
 * examination) is a buff. VTank uses those named in its GemFoodItems table (by default Asheron's
 * Benediction and Blackmoor's Favor) and Consumables-tab entries of that kind. One is used when its
 * spell is not on you at that level or better with at least the rebuff time left, and:
 * - you meet its use requirements (itemUse.ts: the server's own check);
 * - its shared cooldown (SharedCooldown, PropertyInt 280) is not running;
 * - a fellowship-only spell (SpellFlags.FellowshipSpell) needs you in a fellowship.
 * After a use the item and its family wait 5 s (30 s when nothing came of it) for the effect to show.
 * Items that don't exist in an era are never carried there, so nothing here is era-specific.
 *
 * BuffCastRecast_Seconds / BuffCastRecastReset_Seconds: once a buff is cast, every other buff's rebuff
 * threshold is raised by BuffCastRecast_Seconds for BuffCastRecastReset_Seconds, so buffs that fall due
 * close together go out in one round. VTank never lets the threshold below 10 s.
 *
 * FastCastBuffs ("Moves you backwards during casting, use with caution", VTank 1.0 changelog): the
 * character walks backwards while a quick buff is cast. A quick buff is one of difficulty below 50, a
 * Creature or Life self buff (not a fellowship spell) of a minute or more, or a FastCast spell.
 */
import { PropertyFloat, PropertyInt, type PlanEnchantment, type PlanItem, type PlanSkill } from '@ac/shared';
import { itemSpellId, useRequirementProblem } from './itemUse.ts';

/** VirindiTank's default GemFoodItems table (its default settings profile; the ids are the end-of-retail spells 3810 / 3811). */
export const VT_GEM_FOOD_ITEMS = ["Asheron's Benediction", "Blackmoor's Favor"];

/** ACE SpellFlags. */
const BENEFICIAL = 0x4;
const SELF_TARGETED = 0x8;
const FELLOWSHIP = 0x2000;
const FAST_CAST = 0x4000;

interface SpellRow { name: string; category: number; school: number; bitfield: number; power: number; duration?: number }

export interface BuffItemInput {
  /** Carried items, examined ones with their ints and data ids. */
  items: PlanItem[];
  /** Names that may be used: VT_GEM_FOOD_ITEMS and the Consumables tab. */
  listed: string[];
  spellTable: { spells: Map<number, SpellRow> };
  active: PlanEnchantment[];
  /** Seconds: a buff with less than this left is due. */
  threshold: number;
  skills: PlanSkill[];
  level?: number;
  inFellowship: boolean;
  /** Seconds left on a shared cooldown (by its id), 0 when none. */
  cooldownLeft: (cooldownId: number) => number;
  /** Items and spell families held back after a recent use. */
  heldBack?: (guid: number, category: number) => boolean;
}

export interface BuffItemPick { item: PlanItem; spellId: number; spell: SpellRow; why: string }

/** Seconds left on your enchantment of `category` at `power` or better, or null when none is up. */
function familyLeft(active: PlanEnchantment[], category: number, power: number): number | null {
  let best: number | null = null;
  for (const e of active) {
    if (e.category !== category || (e.power !== undefined && e.power < power)) continue;
    if (best === null || e.remaining > best) best = e.remaining;
  }
  return best;
}

/** The buff item to use now, or null. */
export function planBuffItem(input: BuffItemInput): BuffItemPick | null {
  const listed = new Set(input.listed.map((n) => n.trim().toLowerCase()));
  for (const item of input.items) {
    if (item.equipped || !listed.has(item.name.trim().toLowerCase()) || !item.ints) continue;
    const spellId = itemSpellId(item);
    const spell = spellId !== undefined ? input.spellTable.spells.get(spellId) : undefined;
    if (!spellId || !spell || !(spell.bitfield & BENEFICIAL) || !((spell.duration ?? 0) > 0)) continue;
    if (input.heldBack?.(item.guid, spell.category)) continue;
    if ((spell.bitfield & FELLOWSHIP) && !input.inFellowship) continue;
    if (useRequirementProblem(item, input.skills, input.level)) continue;
    const cooldown = item.ints[PropertyInt.SharedCooldown] ?? 0;
    if (cooldown > 0 && input.cooldownLeft(cooldown) > 0) continue;
    const left = familyLeft(input.active, spell.category, spell.power);
    if (left !== null && left >= input.threshold) continue;
    return { item, spellId, spell, why: `${spell.name} ${left === null ? 'is not on you' : `has ${Math.round(left)} s left`}: using ${item.name}` };
  }
  return null;
}

/** A buff item's shared cooldown, as the server starts it on use: its id and seconds (CooldownDuration). */
export function itemCooldown(item: PlanItem): { id: number; seconds: number } | null {
  const id = item.ints?.[PropertyInt.SharedCooldown] ?? 0;
  const seconds = item.floats?.[PropertyFloat.CooldownDuration] ?? 0;
  return id > 0 && seconds > 0 ? { id, seconds } : null;
}

/**
 * The buff threshold with BuffCastRecast: raised by BuffCastRecast_Seconds while a buff was cast within
 * BuffCastRecastReset_Seconds, and never below 10 s (VTank's floor).
 */
export function rebuffThreshold(base: number, recastOn: boolean, recastSeconds: number): number {
  return Math.max(10, base + (recastOn ? Math.max(0, recastSeconds) : 0));
}

/** FastCastBuffs' quick buffs: difficulty below 50, a Creature (4) or Life (2) self buff of a minute or more that isn't a fellowship spell, or a FastCast spell. */
export function isQuickBuff(spell: SpellRow): boolean {
  if (spell.power < 50) return true;
  if ((spell.bitfield & SELF_TARGETED) && !(spell.bitfield & FELLOWSHIP) && (spell.duration ?? 0) >= 60 && (spell.school === 2 || spell.school === 4)) return true;
  return (spell.bitfield & FAST_CAST) !== 0;
}
