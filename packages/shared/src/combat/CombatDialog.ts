/**
 * Retail-faithful combat chat dialog formatting for AttackerNotification +
 * DefenderNotification events.
 *
 * The original AC client formatted these strings locally from the wire
 * payload (ACE only ships the data, never the rendered string). Two
 * anchors:
 *
 *   1. ACE C# wire format —
 *      `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/`
 *      `GameEventAttackerNotification.cs` + `GameEventDefenderNotification.cs`.
 *      Both ship a `percent = damage / target.Health.MaxValue` severity ratio
 *      (`Player_Combat.cs:163, 423, 493`). DefenderNotification additionally
 *      ships a `DamageLocation` (body part hit, 0–8).
 *
 *   2. Retail chat format — sourced from the AC Community Wiki at
 *      `asheron.fandom.com/wiki/Combat_Dialog` and the `Combat` article
 *      which include canonical retail examples:
 *
 *        "Critical hit! You impale Olthoi Ripper for 1320 points of piercing damage!"
 *        "Tumerok Gladiator grazes your lower arm for 2 points of bludgeoning damage!"
 *
 *      The verb is chosen from a damage-type × severity-tier table. The
 *      severity tiers, per the wiki, are: >50% / >25% / >10% / ≤10%.
 *
 * Pre-FAITHFUL.332 the client rendered both messages as the generic
 *   "[Attacker] hits you for N points of [type] damage."
 * with no body-part info and no severity-driven verb selection — closing a
 * canonical-retail gap that was load-bearing for the game's combat feel.
 */

import { DamageType } from '../game-types.js';
import { damageTypeName, appraisalDamageTypeToString } from '../ace-enums.js';
import { AttackConditions } from './AttackConditions.js';

/**
 * Body parts a defender can be hit on. Mirrors
 * `reference/ACE/Source/ACE.Server/Network/Enum/DamageLocation.cs` exactly —
 * the values are what ACE writes onto the wire in DefenderNotification's
 * `damageLocation` field.
 */
export enum DamageLocation {
  Head     = 0x0,
  Chest    = 0x1,
  Abdomen  = 0x2,
  UpperArm = 0x3,
  LowerArm = 0x4,
  Hand     = 0x5,
  UpperLeg = 0x6,
  LowerLeg = 0x7,
  Foot     = 0x8,
}

/**
 * Lowercase body-part label as it appears in the canonical retail defender
 * message ("...your lower arm..."). Multi-word zones use spaces, not
 * hyphens, per the Combat wiki article's example.
 *
 * Returns `null` for unknown / out-of-range values so the caller can
 * gracefully omit the "your X" clause rather than emitting a numeric
 * placeholder mid-sentence.
 */
export function damageLocationLabel(loc: number): string | null {
  switch (loc) {
    case DamageLocation.Head:     return 'head';
    case DamageLocation.Chest:    return 'chest';
    case DamageLocation.Abdomen:  return 'abdomen';
    case DamageLocation.UpperArm: return 'upper arm';
    case DamageLocation.LowerArm: return 'lower arm';
    case DamageLocation.Hand:     return 'hand';
    case DamageLocation.UpperLeg: return 'upper leg';
    case DamageLocation.LowerLeg: return 'lower leg';
    case DamageLocation.Foot:     return 'foot';
    default: return null;
  }
}

/**
 * Severity tier index (0-3) from the percent field.
 *
 * Per `asheron.fandom.com/wiki/Combat_Dialog`:
 *   percent > 0.50 → tier 0 (heaviest verb — "mangle", "incinerate", …)
 *   percent > 0.25 → tier 1
 *   percent > 0.10 → tier 2
 *   percent ≤ 0.10 → tier 3 (lightest verb — "scratch", "graze", "singe", …)
 *
 * The `percent` arriving over the wire is already the damage/target-maxHealth
 * ratio, NOT a 0–100 number — caller does not need to divide.
 */
export function combatSeverityTier(percent: number): number {
  if (percent > 0.50) return 0;
  if (percent > 0.25) return 1;
  if (percent > 0.10) return 2;
  return 3;
}

/** Verb pair: [2nd-person base form, 3rd-person -s/-es form]. */
type CombatVerbPair = readonly [base: string, third: string];

/**
 * Damage-type → severity-tier → verb pair. Sourced verbatim from
 * `asheron.fandom.com/wiki/Combat_Dialog`. The 3rd-person inflection is
 * stored explicitly (rather than computed) so future ACE-source enum drift
 * — or unusual orthography — can't silently corrupt the strings.
 *
 * `Stamina` and `Mana` damage types are intentionally absent — retail
 * combat dialog never emits a chat line for stamina/mana drain via the
 * Attacker/DefenderNotification channel (those drains use separate
 * GameMessageSystemChat templates from the server). `Undef` and the
 * `Base` overlay bit are likewise absent — caller falls back to the
 * generic "hit/hits" verb in those rare cases.
 */
const COMBAT_VERB_TABLE: Record<number, ReadonlyArray<CombatVerbPair>> = {
  [DamageType.Slash]:    [['mangle','mangles'],       ['slash','slashes'],     ['cut','cuts'],         ['scratch','scratches']],
  [DamageType.Pierce]:   [['gore','gores'],           ['impale','impales'],    ['stab','stabs'],       ['nick','nicks']],
  [DamageType.Bludgeon]: [['crush','crushes'],        ['smash','smashes'],     ['bash','bashes'],      ['graze','grazes']],
  [DamageType.Fire]:     [['incinerate','incinerates'],['burn','burns'],       ['scorch','scorches'],  ['singe','singes']],
  [DamageType.Cold]:     [['freeze','freezes'],       ['frost','frosts'],      ['chill','chills'],     ['numb','numbs']],
  [DamageType.Acid]:     [['dissolve','dissolves'],   ['corrode','corrodes'],  ['sear','sears'],       ['blister','blisters']],
  [DamageType.Electric]: [['blast','blasts'],         ['jolt','jolts'],        ['shock','shocks'],     ['spark','sparks']],
  [DamageType.Health]:   [['deplete','depletes'],     ['siphon','siphons'],    ['exhaust','exhausts'], ['drain','drains']],
  [DamageType.Nether]:   [['eradicate','eradicates'], ['wither','withers'],    ['twist','twists'],     ['scar','scars']],
};

/** Default fallback when a damage type has no verb table entry (Stamina, Mana, Undef, Base). */
const DEFAULT_VERB: CombatVerbPair = ['hit', 'hits'];

/**
 * Pick the verb pair for a (damageType, severity) combination.
 * Strips the wire-format `Base` overlay bit (0x10000000) before lookup
 * since it can OR-in with any of the other bits.
 */
export function combatVerb(damageType: number, severity: number): CombatVerbPair {
  const base = damageType & ~DamageType.Base;
  const tiers = COMBAT_VERB_TABLE[base];
  if (!tiers) return DEFAULT_VERB;
  return tiers[combatSeverityTier(severity)];
}

/**
 * The "<type> " damage-type word in a hit line: retail runs
 * `AppraisalSystem::DamageTypeToString` (the appraisal names, "Electrical" /
 * "Prismatic", "/"-joined for a multi-type mask), `_strlwr`s it and appends
 * " " only when it is non-empty — a mask with no named bit reads
 * "... points of damage!".
 */
function hitDamageTypeWord(damageType: number): string {
  const name = appraisalDamageTypeToString(damageType).toLowerCase();
  return name ? `${name} ` : '';
}

/** "point" + "s" unless the damage is exactly 1 (`cmp edi, 1` @ 0056b5f8). */
function pointWord(damage: number): string {
  return damage !== 1 ? 'points' : 'point';
}

/**
 * The attacker-side hit line (chat type 0x16, CombatSelf) —
 * `ClientCombatSystem::HandleAttackerNotificationEvent @ 0056b420`, one
 * AddTextToScroll per event. Prefixes in retail order: "Critical hit!  "
 * (two spaces, .rdata 0x7cf5d0) on a crit, then "Sneak Attack! " (condition
 * bit 0x4) and "Recklessness! " (bit 0x2), then
 * `sprintf("You %s %s for %d point%s of %sdamage!", verb, target, damage,
 * "s"|"", "<type> "|"")` (0x7cf588), then — condition bit 0x1 — " Your
 * target's Critical Protection augmentation allows them to avoid your
 * critical hit!" (0x7cf530). ACE's Overpower bit (0x8) prints nothing.
 */
export function formatAttackerChat(
  targetName: string,
  damageType: number,
  severity: number,
  damage: number,
  critical: boolean,
  attackConditions = 0,
): string {
  const [verb] = combatVerb(damageType, severity);
  let line = critical ? 'Critical hit!  ' : '';
  if (attackConditions & AttackConditions.SneakAttack) line += 'Sneak Attack! ';
  if (attackConditions & AttackConditions.Recklessness) line += 'Recklessness! ';
  line += `You ${verb} ${targetName} for ${damage} ${pointWord(damage)} of ${hitDamageTypeWord(damageType)}damage!`;
  if (attackConditions & AttackConditions.CriticalProtectionAugmentation) {
    line += " Your target's Critical Protection augmentation allows them to avoid your critical hit!";
  }
  return line;
}

/**
 * The defender-side hit line (chat type 0x15, CombatEnemy) —
 * `ClientCombatSystem::HandleDefenderNotificationEvent @ 0056c920`:
 * "Critical hit! " (one space) on a crit, "Sneak Attack! " (bit 0x4),
 * "Reckless! " (bit 0x2), then "<attacker> <verb>s your <part> for N
 * point[s] of <type >damage!" — " you" in place of " your <part>" when the
 * body part has no name (`BodyPartEnumMapper::BodyPartToString` fails) —
 * then, bit 0x1, " Your Critical Protection augmentation allows you to avoid
 * a critical hit!".
 */
export function formatDefenderChat(
  attackerName: string,
  damageType: number,
  severity: number,
  damage: number,
  damageLocation: number,
  critical: boolean,
  attackConditions = 0,
): string {
  const [, verbS] = combatVerb(damageType, severity);
  const bodyPart = damageLocationLabel(damageLocation);
  const target = bodyPart ? `your ${bodyPart}` : 'you';
  let line = critical ? 'Critical hit! ' : '';
  if (attackConditions & AttackConditions.SneakAttack) line += 'Sneak Attack! ';
  if (attackConditions & AttackConditions.Recklessness) line += 'Reckless! ';
  line += `${attackerName} ${verbS} ${target} for ${damage} ${pointWord(damage)} of ${hitDamageTypeWord(damageType)}damage!`;
  if (attackConditions & AttackConditions.CriticalProtectionAugmentation) {
    line += ' Your Critical Protection augmentation allows you to avoid a critical hit!';
  }
  return line;
}

/**
 * FAITHFUL.287 diagnostic line for DefenderNotification. Not retail chat —
 * a console.log aid so combat audits can distinguish "no incoming damage
 * event" from "event arrived but failed to render". ACE's
 * `Player_Combat.cs:524-529` short-circuits BEFORE the DefenderNotification
 * send at line 542 when the hit is lethal (Health.Current <= 0), so a
 * "player died with no preceding [DefenderNotification] log" is expected
 * behavior on one-shot kills, not a missing event.
 */
export function formatDefenderNotificationLog(
  attackerName: string,
  damageType: number,
  damage: number,
  critical: boolean,
): string {
  const typeName = damageTypeName(damageType).toLowerCase();
  return `[DefenderNotification] ${attackerName} hit for ${damage} ${typeName}${critical ? ' CRIT' : ''}`;
}
