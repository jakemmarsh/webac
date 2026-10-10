/**
 * CORE.17.k.b.b.a.f.b — CharGenState's template machine as the decompiled
 * EoL client runs it: ApplyTemplate (a profession row's values + skills)
 * and FitTemplateToCharacter (the lit profession row follows the character).
 *
 * Ground truth (docs/retail-client-symbols.md, CORE.17.k.b.b.a.f.b):
 *  - CharGenState::FitTemplateToCharacter @ 005c6130 scores every template
 *    of the heritage from index 1 (template 0, "Adventurer", is never
 *    scored — it is the Custom fallback), three terms each × 1/3
 *    (.rdata 0x7acf88):
 *      attributes: pow(Σ min(value, template) / Σ template, 2.5)
 *                  (0x7e7788); 0.25 when Σ template < 1 (0x3fd0000000000000)
 *      normal skills: pow(trained-or-specialized count / list size, 3.0)
 *                  (0x7e7790); + 0.3 flat when the list is empty (0x7e7818)
 *      primary skills: pow((trained 1 + specialized 2) / (2 × list size),
 *                  3.5) (0x7e7798); + 0.45 flat when empty (0x7e7810)
 *    __CIpow takes the base in ST(1) and the exponent in ST(0) — the
 *    ratio is the base, the .rdata double the exponent. A template wins
 *    only with a STRICTLY greater score (fcom; test ah, 0x41), so the
 *    lowest index keeps a tie. When the best score is below
 *    TEMPLATE_SCORE_CUTOFF = 0.75 (0x7e7780; fcomp, test ah, 0x5) the
 *    result is 0 — the Custom row. Fewer than two templates → 0.
 *    A skill counts through skillLevels[id] with id < totalNumSkills:
 *    normal when the level is > 1 (Trained 2 / Specialized 3), primary
 *    1 for Trained and 2 for Specialized.
 *  - gmCGProfessionPage::UpdateProfession @ 004821b0: template_ 0 → row
 *    0x100003d9 (Custom) + watermark 0x100003d8 state 0x1000002b +
 *    ID_CharGen_CustomText; 1 → 0x100003da / 0x1000002c / BowText; 2 →
 *    0x100003df / 0x10000031 / SwashText; 3 → 0x100003db / 0x1000002d /
 *    LifeText; 4 → 0x100003dc / 0x1000002e / WarText; 5 → 0x100003dd /
 *    0x1000002f / WayText; 6 → 0x100003de / 0x10000030 / SoldierText. The
 *    previously lit row goes back to state 0x10000016, the new one to
 *    0x10000017; the text box 0x100003e0 takes the string (table
 *    0x10000002). pcProfessions @ 0x8191a8 names the same order.
 *  - Callers: UpdateAttributeValues @ 00482450 (every slider move, value
 *    commit, lock-driven balance) ends with FitTemplateToCharacter +
 *    UpdateProfession; Update @ 00482830 (the page shown) and
 *    UpdateToDefaultAttributes @ 00482860 (a row click, after ClearLocks)
 *    run Fit + UpdateProfession + UpdateAttributeValues; gmCGSummaryPage::
 *    Update runs Fit before SetSummaryText.
 *  - CharGenState::ApplyTemplate @ 005c5080: bAttribLocked zeroed; the
 *    Olthoi heritages (0xc / 0xd) force template_ 0; with a heritage, a
 *    gender and template_ != −1: Set<Attr>(template value, 0) in the order
 *    Str, End, Coord, Quick, Focus, Self; ResetSkillLevels; every normal
 *    skill → SetSkillLevel(Trained); every primary skill: the credits
 *    with its current level's cost refunded, less GetSkillSpecializedCost
 *    — when that is ≥ 0 it is stored and the skill becomes Specialized.
 *  - CharGenState::SetSkillLevel @ 005c3c20: id < totalNumSkills and the
 *    level in [1, 3]; credits + the current level's cost (Trained →
 *    GetSkillTrainedCost, Specialized → GetSkillSpecializedCost) − the
 *    new level's cost; refused below 0, else stored with the level.
 *  - CharGenState::ResetSkillLevels @ 005c43b0: remainingSkillCredits =
 *    totalSkillCredits; every SkillTable skill 1..totalNumSkills−1 with
 *    both costs ≥ 0: trained cost < 1 → Trained (Specialized when the
 *    specialized cost is < 1 too), else Untrained.
 *  - ACCharGenData::GetSkillTrainedCost @ 005c26d0 / GetSkillSpecializedCost
 *    @ 005c27d0: the heritage's skill list entry (normalCost / primaryCost)
 *    when the skill is listed, else the SkillTable's SkillBase costs
 *    (trainedCost / specializedCost), −1 when neither knows it.
 *  - SetTemplate @ 005c5a60 stores template_ and ApplyTemplate's; SetHeritageGroup
 *    @ 005c67a0 re-applies the current template_ for the new heritage.
 */

import { SkillAdvancementClass } from '@ac/shared';
import type { AttributeSet } from './CharacterCreate.js';

/** template_ 0 — the Custom row (the "Adventurer" template: all 10s, no skills). */
export const CUSTOM_TEMPLATE = 0;

/** .rdata 0x7e7780 — below this best score the Custom row is lit. */
export const TEMPLATE_SCORE_CUTOFF = 0.75;
/** .rdata 0x7e7788 — the attribute term's exponent. */
export const TEMPLATE_FIT_ATTRIBUTE_EXPONENT = 2.5;
/** .rdata 0x7e7790 — the normal-skills term's exponent. */
export const TEMPLATE_FIT_NORMAL_SKILLS_EXPONENT = 3.0;
/** .rdata 0x7e7798 — the primary-skills term's exponent. */
export const TEMPLATE_FIT_PRIMARY_SKILLS_EXPONENT = 3.5;
/** .rdata 0x7acf88 — each term's weight. */
export const TEMPLATE_FIT_TERM_WEIGHT = 1 / 3;
/** The attribute term when the template's attributes sum to nothing. */
export const TEMPLATE_FIT_NO_ATTRIBUTES_TERM = 0.25;
/** .rdata 0x7e7818 — the normal-skills term for an empty list. */
export const TEMPLATE_FIT_NO_NORMAL_SKILLS_TERM = 0.3;
/** .rdata 0x7e7810 — the primary-skills term for an empty list. */
export const TEMPLATE_FIT_NO_PRIMARY_SKILLS_TERM = 0.45;

/** The template shape the fit and ApplyTemplate read (Template_CG / TemplateCG). */
export interface ChargenTemplate {
  readonly name?: string;
  readonly strength: number;
  readonly endurance: number;
  readonly coordination: number;
  readonly quickness: number;
  readonly focus: number;
  readonly self: number;
  readonly normalSkillsList: readonly number[];
  readonly primarySkillsList: readonly number[];
}

/** The "Adventurer" template 0 as the EoL DAT carries it, for a heritage without a list. */
export const ADVENTURER_TEMPLATE: ChargenTemplate = {
  name: 'Adventurer', strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10,
  normalSkillsList: [], primarySkillsList: [],
};

/** skillLevels[id] — Untrained when the character has not trained it. */
export type SkillLevelLookup = (skillId: number) => SkillAdvancementClass;

/**
 * ACCharGenData's per-heritage skill costs: GetSkillTrainedCost /
 * GetSkillSpecializedCost (−1 for a skill neither the heritage list nor
 * the SkillTable knows) over the SkillTable's ids (1..totalNumSkills−1).
 */
export interface ChargenSkillCosts {
  readonly skillIds: readonly number[];
  trainedCost(skillId: number): number;
  specializedCost(skillId: number): number;
}

/**
 * The cost table as GetSkillTrainedCost / GetSkillSpecializedCost resolve
 * it: the heritage's skill list first, else the SkillBase's own costs.
 */
export function chargenSkillCosts(
  skillTable: ReadonlyMap<number, { trainedCost: number; specializedCost: number }> | null | undefined,
  heritageSkills: readonly { skillNum: number; normalCost: number; primaryCost: number }[] | null | undefined,
): ChargenSkillCosts {
  const ids = skillTable ? Array.from(skillTable.keys()).filter((id) => id >= 1).sort((a, b) => a - b) : [];
  const overrides = new Map<number, { normalCost: number; primaryCost: number }>();
  for (const s of heritageSkills ?? []) overrides.set(s.skillNum, s);
  return {
    skillIds: ids,
    trainedCost: (id) => overrides.get(id)?.normalCost ?? skillTable?.get(id)?.trainedCost ?? -1,
    specializedCost: (id) => overrides.get(id)?.primaryCost ?? skillTable?.get(id)?.specializedCost ?? -1,
  };
}

/** The three terms of a template's fit and their sum. */
export interface TemplateFitScore {
  attributes: number;
  normalSkills: number;
  primarySkills: number;
  total: number;
}

/** FitTemplateToCharacter's score for one template. */
export function templateFitScore(template: ChargenTemplate, attrs: AttributeSet, skillLevel: SkillLevelLookup): TemplateFitScore {
  const templateSum = template.strength + template.endurance + template.coordination
    + template.quickness + template.focus + template.self;
  let attributes: number;
  if (templateSum < 1) {
    attributes = TEMPLATE_FIT_NO_ATTRIBUTES_TERM;
  } else {
    const minSum = Math.min(attrs.strength, template.strength) + Math.min(attrs.endurance, template.endurance)
      + Math.min(attrs.coordination, template.coordination) + Math.min(attrs.quickness, template.quickness)
      + Math.min(attrs.focus, template.focus) + Math.min(attrs.self, template.self);
    attributes = Math.pow(minSum / templateSum, TEMPLATE_FIT_ATTRIBUTE_EXPONENT) * TEMPLATE_FIT_TERM_WEIGHT;
  }

  let normalSkills: number;
  const normalCount = template.normalSkillsList.length;
  if (normalCount < 1) {
    normalSkills = TEMPLATE_FIT_NO_NORMAL_SKILLS_TERM;
  } else {
    let trained = 0;
    for (const id of template.normalSkillsList) if (skillLevel(id) > SkillAdvancementClass.Untrained) trained++;
    normalSkills = Math.pow(trained / normalCount, TEMPLATE_FIT_NORMAL_SKILLS_EXPONENT) * TEMPLATE_FIT_TERM_WEIGHT;
  }

  let primarySkills: number;
  const primaryCount = template.primarySkillsList.length;
  if (primaryCount < 1) {
    primarySkills = TEMPLATE_FIT_NO_PRIMARY_SKILLS_TERM;
  } else {
    let points = 0;
    for (const id of template.primarySkillsList) {
      const level = skillLevel(id);
      if (level === SkillAdvancementClass.Trained) points += 1;
      else if (level === SkillAdvancementClass.Specialized) points += 2;
    }
    primarySkills = Math.pow(points / (primaryCount * 2), TEMPLATE_FIT_PRIMARY_SKILLS_EXPONENT) * TEMPLATE_FIT_TERM_WEIGHT;
  }

  return { attributes, normalSkills, primarySkills, total: attributes + normalSkills + primarySkills };
}

/**
 * CharGenState::FitTemplateToCharacter @ 005c6130 — the template index the
 * character fits best (1..n−1; a strictly greater score takes the lead, so
 * the lowest index keeps a tie), or CUSTOM_TEMPLATE when the best score is
 * below the cutoff or the heritage has fewer than two templates.
 */
export function fitTemplateToCharacter(templates: readonly ChargenTemplate[], attrs: AttributeSet, skillLevel: SkillLevelLookup): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 1; i < templates.length; i++) {
    const score = templateFitScore(templates[i], attrs, skillLevel).total;
    if (bestScore < score) { bestScore = score; best = i; }
  }
  if (bestScore < TEMPLATE_SCORE_CUTOFF) return CUSTOM_TEMPLATE;
  return best;
}

// ─── UpdateProfession's rows, watermark states and texts ───────────────

/** The profession row 0x21000047 element UpdateProfession lights per template_. */
export const TEMPLATE_PROFESSION_ROW: Readonly<Record<number, number>> = {
  0: 0x100003d9, 1: 0x100003da, 2: 0x100003df, 3: 0x100003db, 4: 0x100003dc, 5: 0x100003dd, 6: 0x100003de,
};

/** The template_ each profession row selects (ListenToElementMessage's SetTemplate). */
export const PROFESSION_ROW_TEMPLATE: Readonly<Record<number, number>> = {
  0x100003d9: 0, 0x100003da: 1, 0x100003df: 2, 0x100003db: 3, 0x100003dc: 4, 0x100003dd: 5, 0x100003de: 6,
};

/** The state UpdateProfession puts the watermark 0x100003d8 in per template_. */
export const TEMPLATE_WATERMARK_STATE: Readonly<Record<number, number>> = {
  0: 0x1000002b, 1: 0x1000002c, 2: 0x10000031, 3: 0x1000002d, 4: 0x1000002e, 5: 0x1000002f, 6: 0x10000030,
};

/** The ID_CharGen_*Text token UpdateProfession sets on 0x100003e0 per template_. */
export const TEMPLATE_TEXT_TOKEN: Readonly<Record<number, string>> = {
  0: 'ID_CharGen_CustomText', 1: 'ID_CharGen_BowText', 2: 'ID_CharGen_SwashText', 3: 'ID_CharGen_LifeText',
  4: 'ID_CharGen_WarText', 5: 'ID_CharGen_WayText', 6: 'ID_CharGen_SoldierText',
};

/** The row's state media / label colour states (0x2100004c:0x100002e8). */
export const PROFESSION_ROW_STATE_NORMAL = 0x10000016;
export const PROFESSION_ROW_STATE_LIT = 0x10000017;

/** The Olthoi heritages ApplyTemplate forces to template_ 0. */
export const OLTHOI_HERITAGES: readonly number[] = [0xc, 0xd];

// ─── ApplyTemplate's skill side (the mutable skill state CharGenState keeps) ──

/** remainingSkillCredits + skillLevels, as the wizard keeps them (Untrained = absent). */
export interface ChargenSkillState {
  totalSkillCredits: number;
  remainingSkillCredits: number;
  /** skillLevels: Trained / Specialized entries; an absent id is Untrained. */
  levels: Map<number, SkillAdvancementClass>;
}

export function skillLevelOf(state: ChargenSkillState, skillId: number): SkillAdvancementClass {
  return state.levels.get(skillId) ?? SkillAdvancementClass.Untrained;
}

/** The credits a skill's current level cost (SetSkillLevel's refund). */
function currentLevelCost(state: ChargenSkillState, skillId: number, costs: ChargenSkillCosts): number {
  const level = skillLevelOf(state, skillId);
  if (level === SkillAdvancementClass.Trained) return costs.trainedCost(skillId);
  if (level === SkillAdvancementClass.Specialized) return costs.specializedCost(skillId);
  return 0;
}

function storeLevel(state: ChargenSkillState, skillId: number, level: SkillAdvancementClass): void {
  if (level > SkillAdvancementClass.Untrained) state.levels.set(skillId, level);
  else state.levels.delete(skillId);
}

/**
 * CharGenState::SetSkillLevel @ 005c3c20 — refund the current level's cost,
 * charge the new one; refused when the credits would go negative.
 */
export function setSkillLevel(state: ChargenSkillState, skillId: number, level: SkillAdvancementClass, costs: ChargenSkillCosts): boolean {
  // `id < totalNumSkills`: a skill the table does not carry is refused.
  if (!costs.skillIds.includes(skillId)) return false;
  if (level > SkillAdvancementClass.Specialized || level < SkillAdvancementClass.Untrained) return false;
  let credits = state.remainingSkillCredits + currentLevelCost(state, skillId, costs);
  if (level === SkillAdvancementClass.Trained) credits -= costs.trainedCost(skillId);
  else if (level === SkillAdvancementClass.Specialized) credits -= costs.specializedCost(skillId);
  if (credits < 0) return false;
  state.remainingSkillCredits = credits;
  storeLevel(state, skillId, level);
  return true;
}

/**
 * CharGenState::ResetSkillLevels @ 005c43b0 — every credit back; a skill
 * whose trained cost is < 1 starts Trained (Specialized when its
 * specialized cost is < 1 too), the rest Untrained; a skill with a
 * negative cost is left alone.
 */
export function resetSkillLevels(state: ChargenSkillState, costs: ChargenSkillCosts): void {
  state.remainingSkillCredits = state.totalSkillCredits;
  state.levels.clear();
  for (const id of costs.skillIds) {
    const trained = costs.trainedCost(id);
    const specialized = costs.specializedCost(id);
    if (trained < 0 || specialized < 0) continue;
    if (trained < 1) {
      state.levels.set(id, specialized < 1 ? SkillAdvancementClass.Specialized : SkillAdvancementClass.Trained);
    }
  }
}

/**
 * ApplyTemplate's skill half: ResetSkillLevels, the normal skills Trained
 * through SetSkillLevel, the primary skills Specialized when the credits
 * (with their current level refunded) cover GetSkillSpecializedCost.
 */
export function applyTemplateSkills(state: ChargenSkillState, template: ChargenTemplate, costs: ChargenSkillCosts): void {
  resetSkillLevels(state, costs);
  for (const id of template.normalSkillsList) setSkillLevel(state, id, SkillAdvancementClass.Trained, costs);
  for (const id of template.primarySkillsList) {
    if (!costs.skillIds.includes(id)) continue;
    const credits = state.remainingSkillCredits + currentLevelCost(state, id, costs);
    const specialized = costs.specializedCost(id);
    if (credits - specialized >= 0) {
      state.remainingSkillCredits = credits - specialized;
      state.levels.set(id, SkillAdvancementClass.Specialized);
    }
  }
}
