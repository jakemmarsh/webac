/**
 * The spellbook's school + level filter, ported from gmSpellbookUI.
 *
 * Retail keeps ONE bitmask, the character's SpellbookFilters option (ACE
 * SpellBookFilterOptions: Creature 0x1, Item 0x2, Life 0x4, War 0x8,
 * Level1..Level9 0x10..0x1000, Void 0x2000; ACE seeds a new character with
 * 16383 = 0x3FFF, every bit on). Every school and level button is an
 * independent toggle of its own bit:
 *  - UpdateFilter @ 0048b5e0 ORs the clicked button's bit in (button state 6)
 *    or clears it, and sends Event_SpellbookFilterEvent only when the mask
 *    changed;
 *  - ResetFilterButtons @ 0048af90 lights each button whose bit is set;
 *  - IsFilteredOut @ 0048aeb0 hides a spell whose school bit OR level bit is
 *    clear (an unknown school or a level outside 1..9 is hidden too).
 */
import { MagicSchool } from '@ac/shared';

/** ACE's default Character.SpellbookFilters (ShardDbContext: 16383). */
export const SPELLBOOK_FILTERS_DEFAULT = 0x3fff;

/** IsFilteredOut's school switch (CSpellBase::_school → bit). */
export function spellbookSchoolBit(school: number): number {
  switch (school) {
    case MagicSchool.WarMagic: return 0x8;
    case MagicSchool.LifeMagic: return 0x4;
    case MagicSchool.ItemEnchantment: return 0x2;
    case MagicSchool.CreatureEnchantment: return 0x1;
    case MagicSchool.VoidMagic: return 0x2000;
    default: return 0;
  }
}

/** IsFilteredOut's level switch (InqSpellLevelByRoughHeuristic 1..9 → 0x10 << (level - 1)). */
export function spellbookLevelBit(level: number): number {
  return Number.isInteger(level) && level >= 1 && level <= 9 ? 0x10 << (level - 1) : 0;
}

/** gmSpellbookUI::IsFilteredOut: hidden unless both the school and the level bit are set. */
export function isSpellbookFilteredOut(school: number, level: number, filters: number): boolean {
  const s = spellbookSchoolBit(school);
  const l = spellbookLevelBit(level);
  return s === 0 || l === 0 || (filters & s) === 0 || (filters & l) === 0;
}

/** gmSpellbookUI::UpdateFilter: the clicked button flips its own bit. */
export function toggleSpellbookFilter(filters: number, bit: number): number {
  return (filters ^ bit) >>> 0;
}

/**
 * VISUAL.spellbook-scrollbar-and-order — the spellbook list order.
 * gmSpellbookUI::AddSpell inserts each spell at GetSortedInsertionPlace @
 * 0048b440: before the first row whose CSpellBase._display_order (the
 * SpellTable DAT's DisplayOrder) is GREATER than its own, else at the end.
 * Equal orders therefore keep their insertion order (Array.sort is stable).
 */
export function spellbookOrder<T extends { id: number }>(spells: readonly T[], displayOrderOf: (id: number) => number): T[] {
  return [...spells].sort((a, b) => displayOrderOf(a.id) - displayOrderOf(b.id));
}

/**
 * SWEEP1006B.magic-casting.spellbook-delete-confirmation-text-invented —
 * gmSpellbookUI::DeleteSpell @ 0048bd50 sprintf's the plain spell name
 * (ClientMagicSystem::GetSpellName) into the .rdata 0x7a3ea8 format
 * "Are you sure you want to remove %s from your spellbook? You will no
 * longer be able to cast this spell unless you learn it again!" (pushed at
 * 0048bdb6; its only reference) for the callback dialog.
 */
export function spellbookDeleteConfirmText(spellName: string): string {
  return `Are you sure you want to remove ${spellName} from your spellbook? You will no longer be able to cast this spell unless you learn it again!`;
}
