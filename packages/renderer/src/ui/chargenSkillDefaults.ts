/**
 * The CharacterCreate skill array's defaults, from the DAT SkillTable and the
 * CharGen heritage overrides alone (no UI state), so the client, probes and
 * tests build the same array. GameUI.defaultChargenSkillClasses delegates here.
 *
 * Retail CharGenState::ResetSkillLevels @ 005c43b0 walks ids
 * 1..totalNumSkills-1 with the heritage's cost override (CharGen
 * HeritageGroup.mSkillList) else the SkillTable's costs:
 *   trainedCost<1 && specCost<1 → Specialized
 *   trainedCost<1               → Trained (EoL: Arcane Lore via the heritage
 *     override, Magic Defense/Jump/Run/Loyalty/Salvaging)
 *   both >= 0                   → Untrained
 *   either < 0, or id absent    → Inactive
 *
 * The array's length is CharGenState::totalNumSkills (ctor @ 005c6a50): one
 * past the highest id in the SkillTable. It is the data set's, so a server on
 * another set refuses it: GDL's CClient::CreateCharacter answers Corrupt for a
 * trained skill its own SkillTable lacks (Classic Dereth 1.0 has no Salvaging,
 * 40; Snowreap 2026-10-11, Seedsow 2026-10-12).
 */
import { SkillAdvancementClass } from '@ac/shared';

export interface ChargenSkillCosts { trainedCost: number; specializedCost: number }
export interface ChargenHeritageSkill { skillNum: number; normalCost: number; primaryCost: number }

/** Retail's fallback length before the SkillTable is read (end of retail: highest id 54). */
export const EOR_TOTAL_NUM_SKILLS = 55;

/** CharGenState::totalNumSkills: one past the SkillTable's highest id. */
export function chargenTotalNumSkills(skills: ReadonlyMap<number, unknown> | null | undefined): number {
  if (!skills || skills.size === 0) return EOR_TOTAL_NUM_SKILLS;
  let max = 0;
  for (const id of skills.keys()) if (id > max) max = id;
  return max + 1;
}

/** CharGenState::ResetSkillLevels: the default advancement class per skill id. */
export function defaultChargenSkillClasses(
  skills: ReadonlyMap<number, ChargenSkillCosts> | null | undefined,
  heritageSkills: readonly ChargenHeritageSkill[] | null | undefined,
): number[] {
  const total = chargenTotalNumSkills(skills);
  const out: number[] = new Array(total).fill(SkillAdvancementClass.Inactive);
  if (!skills) return out;
  for (const [id, s] of skills) {
    if (id < 1 || id >= total) continue; // retail loop covers ids 1..totalNumSkills-1
    const cg = heritageSkills?.find(k => k.skillNum === id);
    const trainedCost = cg ? cg.normalCost : s.trainedCost;
    const specializedCost = cg ? cg.primaryCost : s.specializedCost;
    if (trainedCost < 0 || specializedCost < 0) continue; // stays Inactive
    out[id] = trainedCost < 1
      ? (specializedCost < 1 ? SkillAdvancementClass.Specialized : SkillAdvancementClass.Trained)
      : SkillAdvancementClass.Untrained;
  }
  return out;
}
