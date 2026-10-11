/**
 * VirindiTank's AutoAttackPower and UseRecklessness: where the macro charges
 * the power / accuracy bar for one melee or missile attack
 * (docs/vtank-macro-behavior.md, "Auto weapon / damage").
 *
 * What the bar does on the server (ACE): a melee swing's PowerLevel picks the
 * attack type of a weapon that has two (WorldObject_Weapon.GetAttackType:
 * below ThrustThreshold 0.33 a thrust, else a slash; dual wield keeps the
 * multi-strike types), and a slash + pierce weapon's damage type follows the
 * attack type (Player_Combat.GetDamageType: thrusts and low-power punches
 * pierce, the rest slash). Unarmed, above KickThreshold 0.75 is a kick, else
 * a punch (Player_Melee). Missile reads the same bar as AccuracyLevel. With
 * Recklessness trained, a bar between 0.1 and 0.9 adds its damage rating
 * (Player_Combat.GetRecklessnessMod).
 *
 * VTank's rule (MOSS AutoAttackPower, read for facts only): a full bar
 * (1.0), except on a weapon that deals both slash and pierce, where the bar
 * chooses the element the row wants: Pierce takes 0.2 (a thrust); Pierce
 * with a triple-strike weapon takes 0.49 when dual wielding, and 1.0 with a
 * shield (ACE forces the thrust animation with a shield); an unarmed weapon
 * with no melee offhand takes 0 (a punch) unless the row wants Slash from a
 * slash + pierce one (0.5). Missile and casters stay at 1.0. UseRecklessness
 * clamps the result to 0.11–0.9 when the Recklessness skill is trained or
 * specialised. AutoAttackPower off leaves the bar where the player put it.
 *
 * Eras: nothing here names an era. Recklessness is skill 50 in the era's own
 * skill list (the 1999 and Dark Majesty tables have no such skill, so it is
 * never trained there), and a melee offhand only exists where the server
 * lets a weapon into the shield slot (dual wield, end of retail).
 */
import { VT_DAMAGE, type PlanSkill } from '@ac/shared';
import type { CombatElement } from './combatPlan.ts';

/** ACE ItemType bits. */
const IT_MELEE = 0x1, IT_MISSILE = 0x100;
/** ACE PropertyInt: DamageType 45, AttackType 47, WeaponType 353. */
const PROP_DAMAGE_TYPE = 45, PROP_ATTACK_TYPE = 47, PROP_WEAPON_TYPE = 353;
/** ACE DamageType Slash | Pierce. */
const SLASH = 0x1, PIERCE = 0x2;
/** ACE AttackType.TripleSlash. */
const TRIPLE_SLASH = 0x40;
/** ACE WeaponType.Unarmed. */
const WEAPON_UNARMED = 1;
/** ACE Skill.Recklessness. */
export const SKILL_RECKLESSNESS = 50;

/** What the bar reads of a carried item (a PlanItem or an agent inventory row with its examination). */
export interface PowerItem {
  guid: number;
  name: string;
  itemType?: number;
  equipped?: boolean;
  /** Equipped: its slot names (EquipMask names joined by +, e.g. MeleeWeapon, Shield). */
  slot?: string;
  /** Examined int properties (ACE PropertyInt). */
  ints?: Record<number, number>;
}

export interface AttackPowerInput {
  /** The element the Monsters-tab row wants (combatPlan's resolution), or null. */
  element: CombatElement | null;
  /** What you carry; only the wielded ones count. */
  items: PowerItem[];
  settings: Record<string, string | number | boolean>;
  skills: PlanSkill[];
}

const on = (v: string | number | boolean | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : v === true || v === 1 || (typeof v === 'string' && /^(true|1)$/i.test(v));

const inShieldSlot = (i: PowerItem): boolean => /(^|\+)Shield(\+|$)/.test(i.slot ?? '');

/** The wielded weapon (melee or missile, not the offhand), and the offhand (a shield or a second melee weapon). */
export function wieldedPair(items: PowerItem[]): { weapon?: PowerItem; offhand?: PowerItem } {
  const worn = items.filter((i) => i.equipped);
  const weapon = worn.find((i) => ((i.itemType ?? 0) & (IT_MELEE | IT_MISSILE)) !== 0 && !inShieldSlot(i));
  const offhand = worn.find((i) => i !== weapon && (inShieldSlot(i) || ((i.itemType ?? 0) & IT_MELEE) !== 0));
  return { ...(weapon ? { weapon } : {}), ...(offhand ? { offhand } : {}) };
}

/**
 * The bar for one attack: a number in 0..1, or 'bar' when AutoAttackPower is
 * off (the player's own bar is used).
 */
export function autoAttackPower(input: AttackPowerInput): number | 'bar' {
  if (!on(input.settings.AutoAttackPower, true)) return 'bar';
  const { weapon, offhand } = wieldedPair(input.items);
  let power = 1;
  if (weapon && ((weapon.itemType ?? 0) & IT_MELEE) !== 0) {
    const offhandMelee = !!offhand && ((offhand.itemType ?? 0) & IT_MELEE) !== 0;
    const offhandShield = !!offhand && !offhandMelee && inShieldSlot(offhand);
    const dmg = weapon.ints?.[PROP_DAMAGE_TYPE] ?? 0;
    const dualEdged = (dmg & (SLASH | PIERCE)) === (SLASH | PIERCE);
    const triple = ((weapon.ints?.[PROP_ATTACK_TYPE] ?? 0) & TRIPLE_SLASH) !== 0;
    const pierce = input.element === 'pierce';
    if (weapon.ints?.[PROP_WEAPON_TYPE] === WEAPON_UNARMED && !offhandMelee) power = input.element === 'slash' && dualEdged ? 0.5 : 0;
    else if (pierce && dualEdged && !triple) power = 0.2;
    else if (pierce && dualEdged && triple && offhandMelee) power = 0.49;
    else if (pierce && dualEdged && triple && !offhandShield) power = 0.2;
    else power = 1;
  }
  const reck = input.skills.find((s) => s.id === SKILL_RECKLESSNESS);
  if (on(input.settings.UseRecklessness, true) && reck && reck.training !== 'untrained') power = Math.min(0.9, Math.max(0.11, power));
  return power;
}

/**
 * The element a Monsters-tab Dmg value means for a weapon swing, when no
 * combat plan resolved it (the attack-nearest step): Slash and Pierce as
 * named, Auto the weapon's own first physical damage type (ACE bit order:
 * slash, then pierce), anything else none.
 */
export function swingElement(damage: number, weapon: PowerItem | undefined): CombatElement | null {
  if (damage === VT_DAMAGE.Pierce) return 'pierce';
  if (damage === VT_DAMAGE.Slash) return 'slash';
  if (damage === VT_DAMAGE.Auto) {
    const bits = weapon?.ints?.[PROP_DAMAGE_TYPE] ?? 0;
    return bits & SLASH ? 'slash' : bits & PIERCE ? 'pierce' : null;
  }
  return null;
}

/** Wielded weapons still to examine (their DamageType / AttackType / WeaponType decide the bar). */
export function powerItemsToExamine(items: PowerItem[]): PowerItem[] {
  const { weapon, offhand } = wieldedPair(items);
  return [weapon, offhand].filter((i): i is PowerItem => !!i && !i.ints && ((i.itemType ?? 0) & IT_MELEE) !== 0);
}
