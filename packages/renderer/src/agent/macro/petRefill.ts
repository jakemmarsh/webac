/**
 * VirindiTank's pet refills: PetRefillCount-Normal (1) and PetRefillCount-Idle
 * (3) (docs/vtank-parity-gaps.md §1.8; facts from MOSS `PetAutomation.
 * TrySelectRefill` and `PetRefillRule`, no code copied). The first summoning
 * essence on the Items tab whose charges (Structure, PropertyInt 92) are down
 * to the count and short of full (MaxStructure, 91) is topped up with the
 * smallest stack of Encapsulated Spirits you carry, used on it in peace mode.
 * The normal count is checked high in the rule list (before the fellowship
 * manager and Attack), the idle one only with nothing to fight. An essence not
 * yet examined has no known charges and is left alone. Essences exist only in
 * end of retail: in the other eras nothing is ever listed, so nothing runs.
 */
import { PropertyInt, type PlanItem } from '@ac/shared';

/** The item that refills an essence's charges (ACE PetDevice: Encapsulated Spirit used on it). */
export const ENCAPSULATED_SPIRIT = 'Encapsulated Spirit';

/** AC skill id of Summoning (ACE Skill.Summoning); only end of retail's SkillTable has it. */
export const SUMMONING_SKILL = 54;

/**
 * Whether an examined item is a summoning essence. ACE's examination (AppraiseInfo) sends only the
 * [AssessmentProperty] ints, and PetClass (266) is not one, so on an ACE world no essence ever shows it.
 * What it does show is UseRequiresSkill (366) or UseRequiresSkillSpec (368) = Summoning: in the ACE world
 * DB exactly the 259 combat essences carry it and nothing else does (the 29 cosmetic pet devices don't).
 * PetClass still counts where a server sends it. Before 2026-11-17 PetClass alone decided, and on ACE
 * Summon Pets, the pet refills and the generated profile's pets never found an essence.
 */
export function isSummoningEssence(item: { ints?: Record<number, number> }): boolean {
  const ints = item.ints;
  if (!ints) return false;
  return ints[PropertyInt.PetClass] !== undefined || ints[PropertyInt.UseRequiresSkill] === SUMMONING_SKILL || ints[PropertyInt.UseRequiresSkillSpec] === SUMMONING_SKILL;
}

/**
 * The server's refusals of an essence's use, as ACE words them: PetDevice.CheckUseRequirements ("You must
 * be a {SummoningMastery} to use the {Name}", "{pet} is already active"), PetDevice.ActOnUse ("Your
 * summoning device does not have enough charges to function!"), Pet.Init ("Couldn't spawn {pet}") and
 * WorldObject.CheckUseRequirements (the cooldown's "You have used this item too recently", "You are not high
 * enough level to use that!", and the Summoning skill's WeenieErrorWithString lines: too low, must be
 * trained / specialized to use the item's magic). Each arrives as a line before the use's UseDone, which
 * carries no error, so the reply line is the only word of a refusal.
 */
const PET_REFUSED: RegExp[] = [
  / is already active\.?$/i, /used this item too recently/i, /does not have enough charges/i, /^Couldn't spawn /i,
  /not high enough level to use/i, /too low to use (?:that|this) item's magic/i, /must (?:have .+ trained|specialize .+) to use (?:that|this) item's magic/i,
  /^You're too busy!?$/i,
];

/** A refusal of `device`'s use among the server's `lines`: the line, and the Summoning Mastery it needs when that was why. */
export function petRefusal(lines: string[], device: string): { line: string; mastery?: string } | null {
  const dev = device.toLowerCase();
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^You must be an? (.+?) to use the (.+?)\.?$/i.exec(line);
    if (m && m[2].toLowerCase() === dev) return { line, mastery: m[1] };
    if (PET_REFUSED.some((r) => r.test(line))) return { line };
  }
  return null;
}

export interface RefillPlan { device: PlanItem; spirit: PlanItem; why: string }

/** The refill to make at `threshold` charges, or null. `devices`: Items-tab essences in the tab's order; `carried`: your pack. */
export function planPetRefill(devices: PlanItem[], carried: PlanItem[], threshold: number): RefillPlan | null {
  const device = devices.find((d) => {
    const left = d.ints?.[PropertyInt.Structure];
    const max = d.ints?.[PropertyInt.MaxStructure];
    return left !== undefined && left <= threshold && (max === undefined || left < max);
  });
  if (!device) return null;
  let spirit: PlanItem | null = null;
  for (const i of carried) {
    if (i.name.toLowerCase() !== ENCAPSULATED_SPIRIT.toLowerCase()) continue;
    if (!spirit || Math.max(1, i.stack ?? 1) < Math.max(1, spirit.stack ?? 1)) spirit = i;
  }
  if (!spirit) return null;
  return { device, spirit, why: `${device.name} has ${device.ints?.[PropertyInt.Structure]} charges (refill at ${threshold})` };
}
