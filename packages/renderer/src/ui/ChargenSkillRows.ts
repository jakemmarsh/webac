/**
 * VISUAL.chargen-skills-list-rows — one row of the chargen Skills page list
 * (gmCGSkillsPage, layout 0x21000048 listbox 0x100003f7) as the decompiled
 * EoL client builds and refreshes it.
 *
 * Ground truth:
 *  - gmCGSkillsPage::DoSkillRecords @ 004817e0 fills each tagSkillRecord
 *    from the SkillTable's SkillBase: iTrainCost = trainedCost, iSpecCost =
 *    specializedCost, bUntrainable = trainedCost != 0, bUnspecializable =
 *    specializedCost != 0. Then, only for a skill the heritage's CharGen
 *    skill list carries: a normalCost of 0 makes iSpecCost −= iTrainCost,
 *    iTrainCost 0 and bUntrainable false; a primaryCost of 0 makes iSpecCost
 *    0 and bUnspecializable false. A non-zero heritage cost changes nothing
 *    here (CharGenState::SetSkillLevel charges with it).
 *  - gmCGSkillsPage::SetSkillText @ 00480600 (read from the disassembly; the
 *    decompiler drops the formatted values): the level text is
 *    CharGenState::GetSkillScore, then by advancement class
 *      Untrained:   up "%d" iTrainCost ("" when >= 999), down "0";
 *                   down button 0x1000001a; up 0x1000001b when the
 *                   remaining credits >= iTrainCost, else 0x1000001a.
 *      Trained:     up iSpecCost − iTrainCost ("" when >= 999), down
 *                   iTrainCost; up 0x1000001b when credits >= that
 *                   difference; down 0x1000001b when bUntrainable.
 *      Specialized: up "0", down iSpecCost − iTrainCost; up 0x1000001a;
 *                   down 0x1000001b when bUnspecializable.
 *    0x1000001b is the lit state (up media 0x06004cb6, down 0x06004d3f),
 *    0x1000001a the dim one (0x06004cb7 / 0x06004d3e).
 *  - IncreaseSkillLevel @ 00480ca0 / DecreaseSkillLevel @ 00480d60 step one
 *    class with the same record checks before CharGenState::SetSkillLevel.
 *
 * The row template is 0x2100004c:0x100002ff (421x26): the icon 0x10000300
 * (0,0) 26x26 with the DAT image 0x06004d3d (DoSkillRecords never replaces
 * it, so every row shows that one), the name 0x10000301 (37,0) 200x26, the
 * level 0x10000302 (255,0), the up cost 0x10000303 (325,0), the up button
 * 0x10000304 (346,0) 30x26, the down button 0x10000305 (373,0) 30x26 and
 * the down cost 0x10000306 (403,0); every text is 34 wide except the name
 * and inherits 0x100002fe (font 0x40000008, state 1 grey 0xffa3a3a3).
 */
import { SkillAdvancementClass } from '@ac/shared';

/** UIElement_Button states SetSkillText puts the arrows in. */
export const SKILL_ARROW_DIM_STATE = 0x1000001a;
export const SKILL_ARROW_LIT_STATE = 0x1000001b;

/** SetSkillText's cutoff: a cost of 999 or more draws as an empty string. */
export const SKILL_COST_BLANK_AT = 999;

export interface ChargenSkillRecord {
  trainCost: number;
  specCost: number;
  untrainable: boolean;
  unspecializable: boolean;
}

/** DoSkillRecords' costs and flags for one skill. */
export function chargenSkillRecord(
  skill: { trainedCost: number; specializedCost: number },
  heritageSkill?: { normalCost: number; primaryCost: number } | null,
): ChargenSkillRecord {
  const rec: ChargenSkillRecord = {
    trainCost: skill.trainedCost,
    specCost: skill.specializedCost,
    untrainable: skill.trainedCost !== 0,
    unspecializable: skill.specializedCost !== 0,
  };
  if (heritageSkill) {
    if (heritageSkill.normalCost === 0) {
      rec.specCost -= rec.trainCost;
      rec.trainCost = 0;
      rec.untrainable = false;
    }
    if (heritageSkill.primaryCost === 0) {
      rec.specCost = 0;
      rec.unspecializable = false;
    }
  }
  return rec;
}

export interface ChargenSkillRowView {
  upCostText: string;
  downCostText: string;
  upState: number;
  downState: number;
}

function costText(cost: number): string {
  return cost < SKILL_COST_BLANK_AT ? String(cost) : '';
}

/** SetSkillText's cost texts and arrow states for a skill in `advClass` with `credits` remaining. */
export function chargenSkillRowView(rec: ChargenSkillRecord, advClass: SkillAdvancementClass, credits: number): ChargenSkillRowView {
  const lit = (on: boolean): number => (on ? SKILL_ARROW_LIT_STATE : SKILL_ARROW_DIM_STATE);
  const upgrade = rec.specCost - rec.trainCost;
  if (advClass === SkillAdvancementClass.Specialized) {
    return { upCostText: '0', downCostText: String(upgrade), upState: SKILL_ARROW_DIM_STATE, downState: lit(rec.unspecializable) };
  }
  if (advClass === SkillAdvancementClass.Trained) {
    return { upCostText: costText(upgrade), downCostText: String(rec.trainCost), upState: lit(credits >= upgrade), downState: lit(rec.untrainable) };
  }
  return { upCostText: costText(rec.trainCost), downCostText: '0', upState: lit(rec.trainCost <= credits), downState: SKILL_ARROW_DIM_STATE };
}

/** IncreaseSkillLevel's target class, or null when the click does nothing. */
export function chargenSkillIncreaseTarget(rec: ChargenSkillRecord, advClass: SkillAdvancementClass, credits: number): SkillAdvancementClass | null {
  if (advClass === SkillAdvancementClass.Untrained) {
    return credits < rec.trainCost ? null : SkillAdvancementClass.Trained;
  }
  if (advClass === SkillAdvancementClass.Trained) {
    return credits < rec.specCost - rec.trainCost ? null : SkillAdvancementClass.Specialized;
  }
  return null;
}

/** DecreaseSkillLevel's target class, or null when the click does nothing. */
export function chargenSkillDecreaseTarget(rec: ChargenSkillRecord, advClass: SkillAdvancementClass): SkillAdvancementClass | null {
  if (advClass === SkillAdvancementClass.Specialized && rec.unspecializable) return SkillAdvancementClass.Trained;
  if (advClass === SkillAdvancementClass.Trained && rec.untrainable) return SkillAdvancementClass.Untrained;
  return null;
}

/**
 * VISUAL.chargen-skills-list-rows.a — CharGenState::GetAttributeName @
 * 005c3a20: the attribute names the formula line uses (the exe's own
 * strings, not the DAT's), indexed by the SkillTable formula's attribute
 * ids. Any other id is the empty string.
 */
const FORMULA_ATTRIBUTE_NAMES: Record<number, string> = {
  1: 'Strength', 2: 'Endurance', 3: 'Quickness', 4: 'Coordination', 5: 'Focus', 6: 'Self',
};

/**
 * gmCGSkillsPage::MakeSkillFormula @ 00480e10 (format strings read from the
 * disassembly; the decompiler drops them): "Formula : ", then each attribute
 * term whose multiplier and id are both non-zero, as its name or, with a
 * multiplier of 2 or more, "(%u x %s)"; two terms are joined by " + " and
 * wrapped in "(" ")". A divisor other than 1 appends " / %u" and a non-zero
 * additive term " +%u".
 */
export function chargenSkillFormulaText(formula: { w: number; x: number; y: number; z: number; attr1: number; attr2: number }): string {
  const term = (mult: number, attr: number): string => {
    const name = FORMULA_ATTRIBUTE_NAMES[attr] ?? '';
    return mult < 2 ? name : `(${mult} x ${name})`;
  };
  const has1 = formula.x !== 0 && formula.attr1 !== 0;
  const has2 = formula.y !== 0 && formula.attr2 !== 0;
  let out = 'Formula : ';
  if (has1) {
    if (has2) out += '(';
    out += term(formula.x, formula.attr1);
    if (has2) out += ' + ';
  }
  if (has2) out += term(formula.y, formula.attr2);
  if (has1 && has2) out += ')';
  if (formula.z !== 1) out += ` / ${formula.z}`;
  if (formula.w !== 0) out += ` +${formula.w}`;
  return out;
}

/**
 * gmCGSkillsPage::ShowSkillsText @ 00481250: what the description box
 * 0x100003fa shows for the selected row. The title 0x100003fb is the name
 * then " (%d)\n" with CharGenState::GetSkillScore; the text 0x100003fc is
 * the SkillBase description, "\n", "Training Bonus  +5\n" (trained) or
 * "Specialization Bonus  +10\n" (specialized), the formula line and "\n".
 */
export function chargenSkillInfoText(
  skill: { name: string; description: string; formula: { w: number; x: number; y: number; z: number; attr1: number; attr2: number } },
  score: number,
  advClass: SkillAdvancementClass,
): { title: string; text: string } {
  const bonus = advClass === SkillAdvancementClass.Trained ? 'Training Bonus  +5\n'
    : advClass === SkillAdvancementClass.Specialized ? 'Specialization Bonus  +10\n' : '';
  return {
    title: `${skill.name} (${score})\n`,
    text: `${skill.description}\n${bonus}${chargenSkillFormulaText(skill.formula)}\n`,
  };
}

/** The listbox item state a selected row's texts draw in (0x100002fe state 6, white). */
export const CHARGEN_SKILL_ROW_SELECTED_STATE = 6;
