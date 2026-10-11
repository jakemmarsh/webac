/**
 * Where a Monsters-tab debuff can come from besides your own spellbook
 * (docs/vtank-parity-gaps.md §1.6; facts from MOSS `CombatItemDebuffPlanner`,
 * no code copied):
 * - a caster on the Items tab whose own spell (Spell, PropertyDataId 28) is
 *   that debuff: it is used on the monster (ours: wielded first);
 * - a melee or missile weapon on the Items tab whose first offensive spell
 *   (not War or Void, not self-targeted) is that debuff: a cast-on-strike
 *   weapon, swung at the monster until the debuff lands;
 * - a grenade: a thrown weapon on the Consumables tab whose spell is that
 *   debuff, thrown at the monster. VTank reads grenades from its game
 *   database (GrenadeOptions: name, wield requirement, spell, spellcraft).
 *   No era's world data has a thrown weapon carrying a spell (end of retail,
 *   Dark Majesty and 1999 all have none), so ours reads the same facts from
 *   the item's own examination: its spells and wield requirement.
 * Item spells are judged by the item's Spellcraft (PropertyInt 106), your
 * spells by your buffed school skill. DebuffSelectionMethod 2 (Skill, the
 * default) ranks by that skill, then by the spell's level (its power); 1
 * (Spell Level) the other way round. Then your own spell before an item, and
 * then the item seen first.
 *
 * Flight (UseProjectileAwareness): a grenade and a launcher's spell fly the
 * way a missile does; your debuffs, a caster's debuffs and a melee weapon's
 * have no flight to test.
 */
import { PropertyDataId, PropertyInt, type PlanItem, type PlanSpell } from '@ac/shared';
import { outOfMana, useRequirementProblem } from './itemUse.ts';
import type { PlanSkill } from '@ac/shared';

export type DebuffSourceKind = 'spell' | 'caster' | 'proc' | 'grenade';

export interface DebuffSpellInfo { name: string; category: number; school: number; bitfield: number; power: number; duration?: number }

export interface DebuffSource {
  kind: DebuffSourceKind;
  /** The spell that goes on the monster. */
  spell: PlanSpell;
  /** The item it comes from (not for 'spell'). */
  item?: PlanItem;
  /** The skill it is cast at: yours for a spell, the item's Spellcraft for an item. */
  skill: number;
  /** A grenade's or a launcher's spell flies like a missile. */
  flies: boolean;
}

/** ACE SpellFlags. */
const SF_BENEFICIAL = 0x4, SF_SELF_TARGETED = 0x8;
const IT_MELEE = 0x1, IT_MISSILE = 0x100, IT_CASTER = 0x8000;
const SCHOOL_NAME: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };

const asPlanSpell = (id: number, s: DebuffSpellInfo): PlanSpell => ({ id, name: s.name, school: SCHOOL_NAME[s.school] ?? '', category: s.category, power: s.power, self: false, buff: false, duration: s.duration ?? 0 });

export interface DebuffSourceInput {
  /** The family's spell ids (other-targeted, not beneficial). */
  ids: Set<number>;
  /** Your best spell of the family that you can cast and that reaches (null: none). */
  learned: PlanSpell | null;
  /** Your buffed skill in that spell's school. */
  learnedSkill: number;
  /** Items-tab items you carry, in the tab's order. */
  items: PlanItem[];
  /** Consumables-tab items you carry. */
  consumables: PlanItem[];
  skills: PlanSkill[];
  level?: number;
  spellInfo: (id: number) => DebuffSpellInfo | undefined;
  /** Whether you meet a weapon's wield requirement. */
  canWield: (item: PlanItem) => boolean;
  /** DebuffSelectionMethod: 1 Spell Level, 2 Skill. */
  method: number;
}

/** Every way to put this debuff on the monster, best first. */
export function debuffSources(input: DebuffSourceInput): DebuffSource[] {
  const out: DebuffSource[] = [];
  if (input.learned) out.push({ kind: 'spell', spell: input.learned, skill: input.learnedSkill, flies: false });
  const spellcraft = (i: PlanItem): number => i.ints?.[PropertyInt.ItemSpellcraft] ?? 0;
  for (const item of input.items) {
    const t = item.itemType ?? 0;
    if (t & IT_CASTER) {
      const id = item.dids?.[PropertyDataId.Spell];
      const s = id ? input.spellInfo(id) : undefined;
      if (!id || !s || !input.ids.has(id) || outOfMana(item) || useRequirementProblem(item, input.skills, input.level) || !input.canWield(item)) continue;
      out.push({ kind: 'caster', spell: asPlanSpell(id, s), item, skill: spellcraft(item), flies: false });
      continue;
    }
    if (!(t & (IT_MELEE | IT_MISSILE)) || !input.canWield(item)) continue;
    // The first offensive, targeted spell that isn't War or Void is the weapon's; it counts only if it is this debuff.
    for (const id of item.spells ?? []) {
      const s = input.spellInfo(id);
      if (!s || (s.bitfield & (SF_BENEFICIAL | SF_SELF_TARGETED)) || s.school === 1 || s.school === 5) continue;
      if (input.ids.has(id)) out.push({ kind: 'proc', spell: asPlanSpell(id, s), item, skill: spellcraft(item), flies: (t & IT_MISSILE) !== 0 });
      break;
    }
  }
  for (const item of input.consumables) {
    if (!((item.itemType ?? 0) & IT_MISSILE) || !input.canWield(item)) continue;
    const id = [item.dids?.[PropertyDataId.Spell], item.dids?.[PropertyDataId.ProcSpell], ...(item.spells ?? [])].find((x): x is number => !!x && input.ids.has(x));
    const s = id ? input.spellInfo(id) : undefined;
    if (!id || !s) continue;
    out.push({ kind: 'grenade', spell: asPlanSpell(id, s), item, skill: spellcraft(item), flies: true });
  }
  const bySkill = input.method !== 1;
  out.sort((a, b) => {
    const first = bySkill ? b.skill - a.skill : b.spell.power - a.spell.power;
    if (first) return first;
    const second = bySkill ? b.spell.power - a.spell.power : b.skill - a.skill;
    if (second) return second;
    if ((a.kind === 'spell') !== (b.kind === 'spell')) return a.kind === 'spell' ? -1 : 1;
    return (a.item?.guid ?? 0) - (b.item?.guid ?? 0);
  });
  return out;
}

/**
 * Whether a chat line says an item's spell went on a monster: "<item> cast <spell> on <monster>" (with an
 * optional ", refreshing …" / ", surpassing …" / ", but it is surpassed by …"). ACE
 * WorldObject_Magic.CreateEnchantment (a caster or a weapon's proc is not "You") and the AC1999 / GDLE
 * SpellcastingManager_Effects.cpp ("%s cast %s on %s" to the owner) word it so. ClassicACE says "<item>
 * casts <spell> on <monster>." and may name a metaspell's adjectives first ("extended Imperil Other V";
 * "quickcasts"); those are read past.
 */
export function itemCastLine(line: string): { caster: string; spell: string; target: string } | null {
  const m = /^(.+?) (?:quick)?casts? (?:(?:delayed|extended|enchained|maximized|empowered) )*(.+?) on (.+?)(?:, (?:refreshing|surpassing|but it is surpassed by) .*)?\.?$/.exec(line.trim());
  return m ? { caster: m[1], spell: m[2], target: m[3] } : null;
}
