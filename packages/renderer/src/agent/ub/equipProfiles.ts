/**
 * UtilityBelt's Equipment Manager (Tools/EquipmentManager.cs at 5fe9825a,
 * MIT; docs/vtank-parity-gaps.md §11.3): an equipment profile is a loot
 * profile whose Keep rules name what to wear.
 *   - `/ub equip load <profile>`: take off everything worn that the profile
 *     doesn't keep, then wear what it keeps, lowest Arcane Lore requirement
 *     first (each piece's mana and lore are already met before the next), up
 *     to 15 tries a piece.
 *   - `/ub equip test <profile>`: say what would be worn, in that order.
 *   - `/ub equip create [profile]`: a profile of what you wear now (one rule
 *     per piece: its name, kind and value; UB also writes its icon and
 *     material, which an item's name and value already pin here).
 *   - `/ub equip list`: the profiles there are.
 * Profiles are kept per character (`create`) and the routine profile's loot
 * sets count too (an imported `Set A.utl`); with no name, the character's
 * name, then `default`, as UB looks up `<Character>.utl` then `default.utl`.
 */
import type { LootRule } from '@ac/shared';
import type { AgentItem } from '../types.ts';
import { lootRuleFor, type ItemProps } from '../RoutineEngine.ts';

/** ACE PropertyInt.ItemDifficulty (Decal LoreRequirement). */
const P_LORE = 109;

/** What can be worn (UB: Armor, Clothing, Gem (aetheria), Jewelry, weapons, casters with EquipableSlots). */
export const isEquippable = (i: AgentItem): boolean => i.where === 'equipped' || !!i.fits;

/** The pieces the profile keeps, lowest Arcane Lore requirement first (UB CheckUtl). */
export function equipPlan(rules: LootRule[], inv: readonly AgentItem[], props: (guid: number) => ItemProps | null): AgentItem[] {
  const keep = inv.filter((i) => isEquippable(i)).filter((i) => {
    const p = props(i.guid);
    const r = lootRuleFor(rules, { name: i.name, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.burden !== undefined ? { burden: i.burden } : {}), ...(i.type ? { type: i.type } : {}), ...(p ? { props: p } : {}) });
    return r?.action === 'keep';
  });
  const lore = (i: AgentItem) => props(i.guid)?.int?.[P_LORE] ?? 0;
  return [...keep].sort((a, b) => lore(a) - lore(b));
}

/** The worn pieces to take off first (UB TryDequipItem: everything worn that isn't to be worn). */
export function toTakeOff(inv: readonly AgentItem[], wear: readonly AgentItem[]): AgentItem[] {
  const keep = new Set(wear.map((i) => i.guid));
  return inv.filter((i) => i.where === 'equipped' && !keep.has(i.guid));
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/ub equip create`: one Keep rule per worn piece (its exact name, kind and value). */
export function profileFromWorn(inv: readonly AgentItem[]): LootRule[] {
  return inv.filter((i) => i.where === 'equipped').map((i) => ({
    label: i.name,
    action: 'keep' as const,
    match: { name: `^${esc(i.name)}$`, ...(i.type ? { types: [i.type] } : {}), ...(i.value !== undefined ? { valueAtLeast: i.value, valueAtMost: i.value } : {}) },
  }));
}
