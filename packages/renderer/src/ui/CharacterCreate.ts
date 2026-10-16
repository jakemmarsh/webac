/**
 * CharacterCreateWizard — manages character creation wizard state.
 *
 * Pure logic layer: no DOM manipulation. Tracks the multi-step wizard
 * state matching the original Asheron's Call character creation tabs:
 *   Race | Appearance | Attributes | Skills | Map | Finish
 *
 * Race includes heritage + gender selection. Appearance includes
 * templates + appearance customization. Finish includes name entry
 * and summary. Provides validation at each step and produces a
 * CharacterCreateInfo for submission.
 */

import {
  Heritage, Gender, SkillAdvancementClass,
  validateName, validateNameWithRules, validateAttributes,
  ATTRIBUTE_MIN, ATTRIBUTE_MAX, DEFAULT_ATTRIBUTE_CREDITS,
  CreateResult,
} from '@ac/shared';
import type { CharacterCreateInfo, AppearanceInfo, NameFilterRules, TabooPredicate } from '@ac/shared';
import type { CharacterCreateParams } from '@ac/network';
import { paletteTemplateIdFor, NO_CLOTHING_COLORS, type ChargenClothingColors } from '../models/ChargenClothingColors.js';
import {
  ATTRIBUTE_SLOT, ATTRIBUTE_SLOT_KEYS, absRemainingCredits, setAttributeSlot, setAttributeFromPage,
} from './ChargenAttributeSliders.js';
import type { AttributeCreditsState, AttributeKey } from './ChargenAttributeSliders.js';
import {
  CUSTOM_TEMPLATE, OLTHOI_HERITAGES, applyTemplateSkills, fitTemplateToCharacter, skillLevelOf, setSkillLevel, resetSkillLevels,
} from './ChargenTemplates.js';
import type { ChargenSkillCosts, ChargenSkillState, ChargenTemplate } from './ChargenTemplates.js';
import {
  randomizeHeritageGroup, randomizeStartArea, randomizeTemplate, randomizeSkills, randomizeAppearance,
  randomizeHeadgear, randomizeShirt, randomizeTrousers, randomizeFootwear, randomizeClothing, resetAppearance, rollDice,
  constrainAppearance,
} from './ChargenRandomize.js';
import type { AppearanceRollLists, ChargenRandomSource, ClothingColorCounts } from './ChargenRandomize.js';

/** The HeritageGroup_CG fields CharGenState::SetHeritageGroup reads. */
export interface ChargenHeritageData {
  readonly attributeCredits: number;
  readonly skillCredits: number;
  readonly primaryStartAreas: readonly number[];
}

/**
 * CORE.17.k.b.b.a.f.d — what SetHeritageGroup and the Random rolls read
 * from ACCharGenData: the heritage record, its templates and skill costs,
 * the Sex_CG list sizes, the starter-area count and the account's Throne
 * of Destiny flag.
 */
export interface ChargenRollDeps {
  readonly hasThroneOfDestiny: boolean;
  heritageGroup(heritage: number): ChargenHeritageData | undefined;
  templatesFor(heritage: number): readonly ChargenTemplate[];
  costsFor(heritage: number): ChargenSkillCosts;
  listsFor(heritage: number, gender: number): AppearanceRollLists;
  readonly starterAreaCount: number;
  /** The heritage page lists this heritage (HeritageRows.ts); absent = all listed. */
  heritageListed?(heritage: number): boolean;
  /** num<Slot>Colors for the appearance's chosen clothing (Set<Slot>Style's StoreColorInformation); absent = colours left alone. */
  clothingColorCounts?(heritage: number, gender: number, appearance: AppearanceState): ClothingColorCounts | null;
}

/**
 * EoL chargen wizard order per DAT layout 0x21000039 (chargen_progress):
 * Heritage → Profession → Skills → Appearance → Town → Summary.
 * (A pre-2026-06-09 version ran Race/Appearance/Attributes/Skills/Map/Finish —
 * both the labels and the order were wrong; Appearance comes AFTER Skills.)
 */
export enum CreateStep {
  Heritage = 0,
  Profession = 1,
  Skills = 2,
  Appearance = 3,
  Town = 4,
  Summary = 5,
}

/**
 * CORE.17.k.b.b.c.c.b — the pages `gmCharGenMainUI::SetProgressState @
 * 004e7a10` hides for the Olthoi heritages (CharGenState heritage 0xc /
 * 0xd): m_pProfessionButton / m_pSkillsButton / m_pTownButton SetVisible(0)
 * (SetVisible(1) for every other heritage), and the heritage page's radio
 * rows toggle the same three (ListenToElementMessage @ 004e9450: the
 * Olthoi Soldier / Spitter rows 0x100005c7 / c8 hide them, every other
 * row shows them).
 */
export const OLTHOI_HIDDEN_STEPS: readonly CreateStep[] = [CreateStep.Profession, CreateStep.Skills, CreateStep.Town];

/**
 * CORE.17.k.b.b.c.c.b.a — what the Back chevron (0x100003c6) does:
 * `gmCharGenMainUI::ListenToElementMessage @ 004e9450` case 0x100003c6
 * (message 1) is `1 < m_eProgressState ? SetProgressState(state − 1) :
 * DoExit` — on the Heritage page (ECG_HERTAGE = 1, our step 0) Back is
 * the Exit button (0x100003ca shares the same DoExit jump, LAB_004e9597).
 * Retail never draws Back disabled in chargen.
 */
export type ChargenBackAction = 'back' | 'exit';
export function chargenBackAction(step: CreateStep): ChargenBackAction {
  return step > CreateStep.Heritage ? 'back' : 'exit';
}

/**
 * `gmCharGenMainUI::DoExit @ 004e8650` — the Yes / No dialog (DialogFactory
 * type 1: property 0x8e = 1, 0xac = 1, 0xc5 = StringInfo(compute_str_hash
 * ("ID_CharGen_ExitWarning"), table enum 0x10000002 → 0x23000002)), one at
 * a time (m_uiExitContext). `RecvNotice_CloseDialog @ 004e9780` clears
 * the context and, on Yes (property 0x92), `UIFramework::QueueUIMode
 * (0x1000000a)` — gmCharacterManagementUI, the character-select screen,
 * with the character set already in hand (no server round-trip).
 */
export const EXIT_WARNING_STRING_ID = 106506567; // compute_str_hash("ID_CharGen_ExitWarning") = 0x6592947
export const EXIT_WARNING_FALLBACK = 'Warning!\n\nYou are about to return to the Main Menu.\nAll character information will be lost.\nDo you wish to continue?';
/** UIFlow mode id of gmCharacterManagementUI (the registration table @ decomp :125554–125561). */
export const UI_MODE_CHARACTER_MANAGEMENT = 0x1000000a;

/**
 * SetProgressState's remap of the requested page for an Olthoi heritage,
 * compared against the page being left (`mov 0xc(%esp),%eax` = the
 * requested page, `mov 0xf8(%esi),%edi` = the previous m_eProgressState):
 * moving BACK (requested < previous) onto Profession / Skills lands on
 * Heritage and onto Town lands on Appearance; moving FORWARD (or to the
 * same page) onto Profession / Skills lands on Appearance and onto Town
 * lands on Summary. Every other heritage takes the page as requested.
 */
export function resolveProgressState(requested: CreateStep, previous: CreateStep, heritage: number): CreateStep {
  if (!OLTHOI_HERITAGES.includes(heritage)) return requested;
  const backward = requested < previous;
  if (requested === CreateStep.Profession || requested === CreateStep.Skills) {
    return backward ? CreateStep.Heritage : CreateStep.Appearance;
  }
  if (requested === CreateStep.Town) return backward ? CreateStep.Appearance : CreateStep.Summary;
  return requested;
}

export interface AppearanceState {
  hairStyle: number;
  hairColor: number;
  /** BUG.chargen-eyes-strip-sent-as-eye-colour — CharGenState::eyesStrip,
   *  the Sex_CG.eyeStripList index (the Eyes page's strip picker). */
  eyesStrip: number;
  /** CharGenState::eyeColor, the Sex_CG.eyeColorList palette index (the
   *  Eyes page's colour spots: gmCGAppearancePage m_tChoices[1].iNumColors
   *  = mEyeColorList.m_num, SetColor → SetEyeColor @ 005c38d0). */
  eyeColor: number;
  skinColor: number;
  noseStyle: number;
  mouthStyle: number;
  headgearStyle: number;
  headgearColor: number;
  shirtStyle: number;
  shirtColor: number;
  pantsStyle: number;
  pantsColor: number;
  footwearStyle: number;
  footwearColor: number;
  /** VISUAL.156 — gradient-disk shade doubles (0..1), sent as the wire's
   *  six float64 hue fields. */
  skinHue: number;
  hairHue: number;
  headgearHue: number;
  shirtHue: number;
  pantsHue: number;
  footwearHue: number;
}

/**
 * The CharacterCreate (0xF656) Appearance block from the wizard's appearance
 * (ACE ACE.Entity/Appearance.cs Unpack order: Eyes, Nose, Mouth, HairColor,
 * EyeColor, HairStyle, ...). BUG.chargen-eyes-strip-sent-as-eye-colour — Eyes
 * is the eyes STRIP (PlayerFactory.cs:77 GetEyeTexture(Eyes)) and EyeColor
 * the palette index (PlayerFactory.cs:100 sex.EyeColorList[EyeColor]); the
 * wizard once sent its one field as both.
 */
export function characterCreateAppearance(
  a: AppearanceInfo | undefined,
  clothingColors?: ChargenClothingColors,
): CharacterCreateParams['appearance'] {
  // BUG.cap-palette-template-0-black — the four clothing colours go out as
  // palette TEMPLATE ids, not the spot index (CharGenState::GetCharGenResult
  // @ 005c4030: `0 <= idx < num ? xPaletteTemplateIDs[idx] : 0`); ACE stores
  // the value as the item's PaletteTemplate (PlayerFactory.cs
  // GetClothingObject). Without the choices (no DAT) retail's num is 0 → 0.
  const cc = clothingColors;
  return {
    eyes: a?.eyesStrip ?? 0,
    nose: a?.noseStyle ?? 0,
    mouth: a?.mouthStyle ?? 0,
    hairColor: a?.hairColor ?? 0,
    eyeColor: a?.eyeColor ?? 0,
    hairStyle: a?.hairStyle ?? 0,
    headgearStyle: a?.headgearStyle ?? 0,
    headgearColor: paletteTemplateIdFor(cc?.headgear ?? NO_CLOTHING_COLORS, a?.headgearColor ?? -1),
    shirtStyle: a?.shirtStyle ?? 0,
    shirtColor: paletteTemplateIdFor(cc?.shirt ?? NO_CLOTHING_COLORS, a?.shirtColor ?? -1),
    pantsStyle: a?.pantsStyle ?? 0,
    pantsColor: paletteTemplateIdFor(cc?.pants ?? NO_CLOTHING_COLORS, a?.pantsColor ?? -1),
    footwearStyle: a?.footwearStyle ?? 0,
    footwearColor: paletteTemplateIdFor(cc?.footwear ?? NO_CLOTHING_COLORS, a?.footwearColor ?? -1),
    // VISUAL.156 — the six float64 shades come from the appearance page's
    // gradient disk (0..1), matching ACE's Appearance doubles.
    skinHue: a?.skinHue ?? 0,
    hairHue: a?.hairHue ?? 0,
    headgearHue: a?.headgearHue ?? 0,
    shirtHue: a?.shirtHue ?? 0,
    pantsHue: a?.pantsHue ?? 0,
    footwearHue: a?.footwearHue ?? 0,
  };
}

export interface AttributeSet {
  strength: number;
  endurance: number;
  coordination: number;
  quickness: number;
  focus: number;
  self: number;
}

export class CharacterCreateWizard {
  /** Current wizard step. */
  currentStep: CreateStep = CreateStep.Heritage;

  /** Selected heritage group. */
  heritage: Heritage = Heritage.Aluvian;

  /** Selected gender. */
  gender: Gender = Gender.Male;

  /** Character name. */
  name: string = '';

  /** Attribute allocation (6 values, default 10 each). */
  attributes: AttributeSet;

  /** Total available attribute credits. */
  attributeCredits: number;

  /** Skill advancement selections: skillId -> advancement class. */
  skills: Map<number, SkillAdvancementClass> = new Map();

  /** Total skill credits available at creation. */
  skillCredits: number;

  /** Skill credits currently spent. */
  skillCreditsUsed: number = 0;

  /** Appearance customization state. */
  appearance: AppearanceState;

  /** Selected starting area index. */
  startArea: number = 0;

  constructor(
    attributeCredits: number = DEFAULT_ATTRIBUTE_CREDITS,
    skillCredits: number = 52,
  ) {
    this.attributeCredits = attributeCredits;
    this.skillCredits = skillCredits;

    // All attributes start at the minimum (10 each = 60 total, 270 remaining)
    this.attributes = {
      strength: ATTRIBUTE_MIN,
      endurance: ATTRIBUTE_MIN,
      coordination: ATTRIBUTE_MIN,
      quickness: ATTRIBUTE_MIN,
      focus: ATTRIBUTE_MIN,
      self: ATTRIBUTE_MIN,
    };

    // All appearance values start at 0
    this.appearance = {
      hairStyle: 0,
      hairColor: 0,
      eyesStrip: 0,
      eyeColor: 0,
      skinColor: 0,
      noseStyle: 0,
      mouthStyle: 0,
      headgearStyle: 0,
      headgearColor: 0,
      shirtStyle: 0,
      shirtColor: 0,
      pantsStyle: 0,
      pantsColor: 0,
      footwearStyle: 0,
      footwearColor: 0,
      skinHue: 0,
      hairHue: 0,
      headgearHue: 0,
      shirtHue: 0,
      pantsHue: 0,
      footwearHue: 0,
    };
  }

  // ── Navigation ────────────────────────────────────────────────────

  /** Total number of steps in the wizard. */
  get totalSteps(): number {
    return 6;
  }

  /** Whether the wizard can advance to the next step (current step is valid). */
  get canGoNext(): boolean {
    switch (this.currentStep) {
      case CreateStep.Heritage:
        return this.heritage !== Heritage.Invalid;
      case CreateStep.Profession:
        return this.attributesRemaining >= 0 && this._attributesInRange();
      case CreateStep.Skills:
        return this.skillCreditsRemaining >= 0;
      case CreateStep.Appearance:
        return true;
      case CreateStep.Town:
        return true;
      case CreateStep.Summary:
        return false; // Final step — user clicks "Create"
      default:
        return false;
    }
  }

  /** Whether the wizard can go back to the previous step. */
  get canGoBack(): boolean {
    return this.currentStep > 0;
  }

  /** CharGenState heritage 0xc / 0xd — the heritages SetProgressState treats as Olthoi. */
  get isOlthoi(): boolean {
    return OLTHOI_HERITAGES.includes(this.heritage);
  }

  /** The progress tabs SetProgressState hides for the current heritage (none unless Olthoi). */
  get hiddenSteps(): readonly CreateStep[] {
    return this.isOlthoi ? OLTHOI_HIDDEN_STEPS : [];
  }

  /** Whether the page's progress tab is visible for the current heritage. */
  isStepVisible(step: CreateStep): boolean {
    return !this.hiddenSteps.includes(step);
  }

  /**
   * `gmCharGenMainUI::SetProgressState @ 004e7a10` — the requested page,
   * remapped for an Olthoi heritage against the page being left
   * (resolveProgressState). Every entry — the Back / Next chevrons
   * (ListenToElementMessage 0x100003c6 / c7: m_eProgressState ∓ 1) and a
   * tab click (0x100003ef–f4) — comes through here. Returns the page opened.
   */
  setProgressState(requested: CreateStep): CreateStep {
    this.currentStep = resolveProgressState(requested, this.currentStep, this.heritage);
    return this.currentStep;
  }

  /** Advance to the next step if the current step is valid. Returns true on success. */
  nextStep(): boolean {
    if (!this.canGoNext) return false;
    if (this.currentStep < CreateStep.Summary) {
      this.setProgressState((this.currentStep + 1) as CreateStep);
      return true;
    }
    return false;
  }

  /** Go back to the previous step. Returns true on success. */
  prevStep(): boolean {
    if (!this.canGoBack) return false;
    this.setProgressState((this.currentStep - 1) as CreateStep);
    return true;
  }

  // ── Heritage ──────────────────────────────────────────────────────

  /** Set the heritage group. */
  setHeritage(h: Heritage): void {
    this.heritage = h;
  }

  // ── Gender ────────────────────────────────────────────────────────

  /**
   * CharGenState::SetGender @ 005c64a0 — the gender, then
   * ConstrainAllByGender and the four Set<Slot>Style calls
   * (constrainAllByGender). Without `deps` (no CharGen data) only the gender.
   */
  setGender(g: Gender, deps?: ChargenRollDeps): void {
    this.gender = g;
    if (deps) this.constrainAllByGender(deps);
  }

  /** CharGenState::ConstrainAllByGender @ 005c5b80 + the Set<Slot>Style calls after it (constrainAppearance). */
  constrainAllByGender(deps: ChargenRollDeps): void {
    const valid = this.heritage !== Heritage.Invalid && this.gender !== Gender.Invalid;
    const lists = valid ? deps.listsFor(this.heritage, this.gender) : null;
    // No Sex_CG record (no CharGen data loaded): nothing to hold the indices to.
    if (lists && Object.values(lists).every((n) => n === 0)) return;
    // The style clamp first: the colour counts are the clamped items' (SetHeadgearStyle(num − 1) re-reads them).
    constrainAppearance(this.appearance, lists);
    if (lists) constrainAppearance(this.appearance, lists, deps.clothingColorCounts?.(this.heritage, this.gender, this.appearance) ?? null);
  }

  /**
   * CharGenState::ConstrainAllByHeritage @ 005c6590 (SetHeritageGroup's
   * tail): ConstrainAllByGender, a template_ past the heritage's list → −1,
   * and the skill credits re-counted from the levels held
   * (UpdateRemainingSkillCredits @ 005c37c0), every level reset when they
   * no longer fit.
   */
  constrainAllByHeritage(deps: ChargenRollDeps): void {
    if (this.heritage === Heritage.Invalid) return; // Reset's branch: RandomizeCharacter already reset all of it.
    this.constrainAllByGender(deps);
    if (deps.templatesFor(this.heritage).length <= this.templateIndex) this.templateIndex = -1;
    const costs = deps.costsFor(this.heritage);
    let used = 0;
    for (const [id, level] of this.skills) {
      if (level === SkillAdvancementClass.Trained) used += costs.trainedCost(id);
      else if (level === SkillAdvancementClass.Specialized) used += costs.specializedCost(id);
    }
    this.skillCreditsUsed = used;
    if (this.skillCreditsRemaining < 0) {
      const state = this.skillState();
      resetSkillLevels(state, costs);
      this.storeSkillState(state);
    }
  }

  // ── Attributes ────────────────────────────────────────────────────

  /** Sum of all 6 attribute values. */
  get attributeTotal(): number {
    return (
      this.attributes.strength +
      this.attributes.endurance +
      this.attributes.coordination +
      this.attributes.quickness +
      this.attributes.focus +
      this.attributes.self
    );
  }

  /** Remaining attribute credits (credits - total). */
  get attributesRemaining(): number {
    return this.attributeCredits - this.attributeTotal;
  }

  /**
   * CORE.17.k.b.b.a.f — CharGenState::bAttribLocked: a locked attribute
   * keeps its value while the others balance (SetLock @ 00482000 /
   * LockAttribute @ 005c3be0).
   */
  readonly attributeLocks: Record<AttributeKey, boolean> = {
    strength: false, endurance: false, coordination: false, quickness: false, focus: false, self: false,
  };

  /** The CharGenState view of the attributes (slots 1..6) the pure balancing functions run over. */
  private attributeCreditsState(): AttributeCreditsState {
    const values = [0]; const locked = [false];
    for (let i = 1; i <= 6; i++) {
      const key = ATTRIBUTE_SLOT_KEYS[i] as AttributeKey;
      values.push(this.attributes[key]);
      locked.push(this.attributeLocks[key]);
    }
    return { totalCredits: this.attributeCredits, values, locked };
  }

  private storeAttributeCreditsState(state: AttributeCreditsState): void {
    for (let i = 1; i <= 6; i++) this.attributes[ATTRIBUTE_SLOT_KEYS[i] as AttributeKey] = state.values[i];
  }

  /** CharGenState::GetAbsRemainingCredits @ 005c3b20 for `attr`. */
  absRemainingAttributeCredits(attr: keyof AttributeSet): number {
    return absRemainingCredits(this.attributeCreditsState(), ATTRIBUTE_SLOT[attr]);
  }

  isAttributeLocked(attr: keyof AttributeSet): boolean {
    return this.attributeLocks[attr];
  }

  /** CharGenState::LockAttribute(i, locked). */
  lockAttribute(attr: keyof AttributeSet, locked: boolean): void {
    this.attributeLocks[attr] = locked;
  }

  /** gmCGProfessionPage::SetLock @ 00482000 — the toggle. Returns the new state. */
  toggleAttributeLock(attr: keyof AttributeSet): boolean {
    this.attributeLocks[attr] = !this.attributeLocks[attr];
    return this.attributeLocks[attr];
  }

  /** CharGenState::ResetAttributeLock @ 005c3bc0 (ClearLocks / ApplyTemplate): every lock off. */
  clearAttributeLocks(): void {
    for (const key of Object.keys(this.attributeLocks) as AttributeKey[]) this.attributeLocks[key] = false;
  }

  /**
   * CharGenState::Set<Attr>(value, balance) @ 005c4660… — the value is held
   * to [ATTRIBUTE_MIN, ATTRIBUTE_MAX] (the page's paths never send more);
   * a rise is refused when GetAbsRemainingCredits(attr) is 0 (nothing
   * unlocked could pay for it); otherwise it is stored and, with `balance`
   * (the default — what the page's slider does), BalanceAttributes drains
   * the other unlocked attributes round-robin until the credits are not
   * overspent. ApplyTemplate stores template values with balance off.
   * Returns true when the value was stored.
   */
  setAttribute(attr: keyof AttributeSet, value: number, balance = true): boolean {
    const before = this.attributes[attr];
    const clamped = Math.max(ATTRIBUTE_MIN, Math.min(ATTRIBUTE_MAX, Math.floor(value)));
    const stored = balance
      ? this.setAttributeFromSlider(attr, clamped)
      : this.storeAttributeSlot(attr, clamped);
    return stored !== before || clamped === before;
  }

  /** Set<Attr>(value, 0) — the stored value (the old one when the rise was refused). */
  private storeAttributeSlot(attr: keyof AttributeSet, value: number): number {
    const state = this.attributeCreditsState();
    const stored = setAttributeSlot(state, ATTRIBUTE_SLOT[attr], value, false);
    this.storeAttributeCreditsState(state);
    return stored;
  }

  /**
   * gmCGProfessionPage::SetAttribValue @ 00482890 — the slider / typed
   * path: a rise past GetAbsRemainingCredits is clamped to what the
   * unlocked others can give, then Set<Attr>(value, 1) balances them.
   * Returns the value stored.
   */
  setAttributeFromSlider(attr: keyof AttributeSet, value: number): number {
    const clamped = Math.max(ATTRIBUTE_MIN, Math.min(ATTRIBUTE_MAX, Math.floor(value)));
    const state = this.attributeCreditsState();
    const stored = setAttributeFromPage(state, ATTRIBUTE_SLOT[attr], clamped);
    this.storeAttributeCreditsState(state);
    return stored;
  }

  // ── Templates (CORE.17.k.b.b.a.f.b) ──────────────────────────────

  /**
   * CharGenState::template_ — the profession template in force: 0 is the
   * Custom row ("Adventurer"), 1..6 the DAT's Bow Hunter … Soldier (the
   * pcProfessions order). SetTemplate stores it; FitTemplateToCharacter
   * re-derives it from the attributes and skills.
   */
  templateIndex: number = CUSTOM_TEMPLATE;

  /** CharGenState::SetTemplate @ 005c5a60 (without the ApplyTemplate it then runs). */
  setTemplate(index: number): void {
    this.templateIndex = index;
  }

  /** skillLevels[id] — Untrained for a skill the wizard has not trained. */
  skillLevel(skillId: number): SkillAdvancementClass {
    return skillLevelOf(this.skillState(), skillId);
  }

  /**
   * CharGenState::SetSkillLevel @ 005c3c20 — the current level's cost back,
   * the new level's charged (heritage costs first); false when the credits
   * would go negative. The Skills page arrows step through this.
   */
  setSkillLevel(skillId: number, level: SkillAdvancementClass, costs: ChargenSkillCosts): boolean {
    const state = this.skillState();
    if (!setSkillLevel(state, skillId, level, costs)) return false;
    this.storeSkillState(state);
    return true;
  }

  private skillState(): ChargenSkillState {
    return {
      totalSkillCredits: this.skillCredits,
      remainingSkillCredits: this.skillCreditsRemaining,
      levels: this.skills,
    };
  }

  private storeSkillState(state: ChargenSkillState): void {
    this.skillCreditsUsed = state.totalSkillCredits - state.remainingSkillCredits;
  }

  /**
   * CharGenState::ApplyTemplate @ 005c5080 — every lock off; the Olthoi
   * heritages force template 0; then, with a template in force, its
   * attributes through Set<Attr>(value, 0) in the order Str, End, Coord,
   * Quick, Focus, Self, ResetSkillLevels, its normal skills Trained and
   * its primary skills Specialized as the credits allow. `templates` is the
   * heritage's list (index = template_); a missing entry leaves the
   * attributes and skills alone the way template_ == −1 does.
   */
  applyTemplate(templates: readonly ChargenTemplate[], costs: ChargenSkillCosts): void {
    this.clearAttributeLocks();
    if (OLTHOI_HERITAGES.includes(this.heritage)) this.templateIndex = CUSTOM_TEMPLATE;
    // `mHeritageGroup != 0 && mGender != 0 && template_ != -1` — nothing applies
    // before a heritage and a gender are set (Reset's transient state).
    if (this.heritage === Heritage.Invalid || this.gender === Gender.Invalid) return;
    const template = templates[this.templateIndex];
    if (!template) return;
    this.setAttribute('strength', template.strength, false);
    this.setAttribute('endurance', template.endurance, false);
    this.setAttribute('coordination', template.coordination, false);
    this.setAttribute('quickness', template.quickness, false);
    this.setAttribute('focus', template.focus, false);
    this.setAttribute('self', template.self, false);
    const state = this.skillState();
    applyTemplateSkills(state, template, costs);
    this.storeSkillState(state);
  }

  /**
   * CharGenState::FitTemplateToCharacter @ 005c6130 — template_ becomes
   * the template the attributes and skills fit best (Custom below the
   * 0.75 cutoff). Returns the new template_.
   */
  fitTemplateToCharacter(templates: readonly ChargenTemplate[]): number {
    this.templateIndex = fitTemplateToCharacter(templates, this.attributes, (id) => this.skillLevel(id));
    return this.templateIndex;
  }

  // ── SetHeritageGroup + the Random button (CORE.17.k.b.b.a.f.d) ────

  /**
   * CharGenState::SetHeritageGroup @ 005c67a0 — the heritage, then with a
   * record: the attribute credits, the skill credits (the remaining ones
   * reset to the total), ApplyTemplate for the template in force, and
   * RandomizeStartArea (the heritage's primary start areas — one each at
   * EoL, the home town). Both the heritage page's row click and
   * RandomizeHeritageGroup come through here.
   */
  setHeritageGroup(heritage: number, deps: ChargenRollDeps, src: ChargenRandomSource): void {
    this.heritage = heritage;
    const group = deps.heritageGroup(heritage);
    if (!group) return;
    this.attributeCredits = group.attributeCredits;
    this.skillCredits = group.skillCredits;
    this.skillCreditsUsed = 0;
    this.applyTemplate(deps.templatesFor(heritage), deps.costsFor(heritage));
    this.randomizeStartArea(group.primaryStartAreas, deps.starterAreaCount, src);
    this.constrainAllByHeritage(deps);
  }

  /** CharGenState::RandomizeStartArea @ 005c59e0 — an empty list leaves the start area alone. */
  randomizeStartArea(primaryStartAreas: readonly number[], starterAreaCount: number, src: ChargenRandomSource): void {
    const area = randomizeStartArea(src, primaryStartAreas, starterAreaCount);
    if (area !== undefined) this.startArea = area;
  }

  /**
   * CharGenState::RandomizeTemplate @ 005c6500 — a template other than the
   * current one (1..count−1), applied; Olthoi → 1 (ApplyTemplate forces 0).
   * Returns false when nothing rolled (no heritage / gender, one template).
   */
  randomizeTemplate(templates: readonly ChargenTemplate[], costs: ChargenSkillCosts, src: ChargenRandomSource): boolean {
    const roll = randomizeTemplate(src, this.heritage, this.gender, this.templateIndex, templates.length);
    if (!roll) return false;
    this.templateIndex = roll.templateIndex;
    if (roll.apply) this.applyTemplate(templates, costs);
    return true;
  }

  /** CharGenState::RandomizeSkills @ 005c57e0 over the wizard's skill state. */
  randomizeSkills(costs: ChargenSkillCosts, src: ChargenRandomSource): void {
    const state = this.skillState();
    randomizeSkills(src, state, costs);
    this.storeSkillState(state);
  }

  /** CharGenState::RandomizeAppearance(0) @ 005c4f10 — the face only. */
  randomizeAppearance(lists: AppearanceRollLists, src: ChargenRandomSource): void {
    randomizeAppearance(src, this.appearance, lists);
  }

  /** CharGenState::RandomizeClothing(excludeHeadgear) @ 005c6770 — the clothes only. */
  randomizeClothing(lists: AppearanceRollLists, src: ChargenRandomSource, excludeHeadgear: boolean): void {
    randomizeClothing(src, this.appearance, lists, excludeHeadgear);
  }

  /**
   * CharGenState::RandomizeCharacter(ToD) @ 005c6d80 — the summary page's
   * Random after the warning dialog: Reset @ 005c68a0 (the name "", every
   * lock off, heritage / gender 0, every appearance index −1 and shade
   * −1.0, template_ −1, the credits 0, ApplyDefaultTemplate's transient
   * 50s, ResetSkillLevels, startArea −1), then SetHeritageGroup(RollDice(1,
   * ToD ? 4 : 3)), SetGender(RollDice(1, 2)), RandomizeAppearance(0),
   * RandomizeHeadgear(0) (no exclusion), RandomizeShirt / Trousers /
   * Footwear, RandomizeTemplate (which applies the rolled template's
   * attributes and skills) and RandomizeStartArea. The *Frozen flags it
   * sets are read nowhere.
   */
  randomizeCharacter(deps: ChargenRollDeps, src: ChargenRandomSource): void {
    // Reset.
    this.clearAttributeLocks();
    this.heritage = Heritage.Invalid;
    this.gender = Gender.Invalid;
    resetAppearance(this.appearance);
    this.templateIndex = -1;
    this.attributeCredits = 0;
    this.skillCredits = 0;
    this.skillCreditsUsed = 0;
    this.skills.clear();
    // ApplyDefaultTemplate @ 005c4990: every attribute to 50 (GetAbsRemainingCredits is never 0 with no credits).
    for (const key of ATTRIBUTE_SLOT_KEYS.slice(1) as AttributeKey[]) this.attributes[key] = 50;
    this.name = '';
    this.startArea = -1;
    // RandomizeCharacter.
    const heritage = randomizeHeritageGroup(src, deps.hasThroneOfDestiny, deps.heritageListed?.bind(deps));
    this.setHeritageGroup(heritage, deps, src);
    this.gender = rollDice(src, 1, 2) as Gender;
    const lists = deps.listsFor(heritage, this.gender);
    randomizeAppearance(src, this.appearance, lists);
    randomizeHeadgear(src, this.appearance, lists, false);
    randomizeShirt(src, this.appearance, lists);
    randomizeTrousers(src, this.appearance, lists);
    randomizeFootwear(src, this.appearance, lists);
    this.randomizeTemplate(deps.templatesFor(heritage), deps.costsFor(heritage), src);
    this.randomizeStartArea(deps.heritageGroup(heritage)?.primaryStartAreas ?? [], deps.starterAreaCount, src);
  }

  /** Check that all attributes are within [ATTRIBUTE_MIN, ATTRIBUTE_MAX]. */
  private _attributesInRange(): boolean {
    const vals = [
      this.attributes.strength,
      this.attributes.endurance,
      this.attributes.coordination,
      this.attributes.quickness,
      this.attributes.focus,
      this.attributes.self,
    ];
    return vals.every(v => v >= ATTRIBUTE_MIN && v <= ATTRIBUTE_MAX);
  }

  // ── Skills ────────────────────────────────────────────────────────

  /**
   * Train a skill (set it to Trained advancement class).
   * @param skillId - The skill ID to train
   * @param cost - Skill credit cost to train this skill
   * @returns true if the skill was successfully trained
   */
  trainSkill(skillId: number, cost: number): boolean {
    const current = this.skills.get(skillId);
    // Cannot train if already trained or specialized
    if (current === SkillAdvancementClass.Trained || current === SkillAdvancementClass.Specialized) {
      return false;
    }
    // Check credits
    if (this.skillCreditsUsed + cost > this.skillCredits) {
      return false;
    }
    this.skills.set(skillId, SkillAdvancementClass.Trained);
    this.skillCreditsUsed += cost;
    return true;
  }

  /**
   * Specialize a skill (Trained -> Specialized advancement class).
   * Per ACE Player_Skills.cs SpecializeSkill(), the skill must already be
   * Trained — the up-arrow interaction in retail chargen (str 24143443) is a
   * one-step-at-a-time cycle (Untrained -> Trained -> Specialized), never a
   * direct Untrained -> Specialized jump.
   * @param skillId - The skill ID to specialize
   * @param cost - Incremental skill credit cost to upgrade Trained -> Specialized
   * @returns true if the skill was successfully specialized
   */
  specializeSkill(skillId: number, cost: number): boolean {
    const current = this.skills.get(skillId);
    if (current !== SkillAdvancementClass.Trained) {
      return false;
    }
    // Check credits
    if (this.skillCreditsUsed + cost > this.skillCredits) {
      return false;
    }
    this.skills.set(skillId, SkillAdvancementClass.Specialized);
    this.skillCreditsUsed += cost;
    return true;
  }

  /**
   * Unspecialize a skill (Specialized -> Trained advancement class),
   * refunding the incremental specialize cost. Mirrors ACE's
   * UnspecializeSkill (Player_Skills.cs) used by the down-arrow step of the
   * chargen Untrained <-> Trained <-> Specialized cycle.
   * @param skillId - The skill ID to unspecialize
   * @param cost - Incremental skill credit cost to refund (Trained -> Specialized upgrade cost)
   * @returns true if the skill was successfully unspecialized
   */
  unspecializeSkill(skillId: number, cost: number): boolean {
    const current = this.skills.get(skillId);
    if (current !== SkillAdvancementClass.Specialized) {
      return false;
    }
    this.skills.set(skillId, SkillAdvancementClass.Trained);
    this.skillCreditsUsed = Math.max(0, this.skillCreditsUsed - cost);
    return true;
  }

  /**
   * Untrain a skill (remove it from trained/specialized).
   * @param skillId - The skill ID to untrain
   * @param cost - Skill credit cost to refund
   * @returns true if the skill was successfully untrained
   */
  untrainSkill(skillId: number, cost: number): boolean {
    const current = this.skills.get(skillId);
    if (
      current !== SkillAdvancementClass.Trained &&
      current !== SkillAdvancementClass.Specialized
    ) {
      return false;
    }
    this.skills.delete(skillId);
    this.skillCreditsUsed = Math.max(0, this.skillCreditsUsed - cost);
    return true;
  }

  /** Remaining skill credits. */
  get skillCreditsRemaining(): number {
    return this.skillCredits - this.skillCreditsUsed;
  }

  // ── Name ──────────────────────────────────────────────────────────

  /** Set the character name. */
  setName(name: string): void {
    this.name = name;
  }

  /**
   * DAT-driven name validation rules (FAITHFUL.176). Wired from main.ts after
   * NameFilterTable + TabooTable parse. When unset, validation falls back to
   * the basic length/whitespace `validateName` checks.
   */
  private nameFilterRules: NameFilterRules | null = null;
  private tabooCheck: TabooPredicate | null = null;

  setNameValidationRules(rules: NameFilterRules | null, tabooCheck: TabooPredicate | null): void {
    this.nameFilterRules = rules;
    this.tabooCheck = tabooCheck;
  }

  /** Whether the current name passes validation. */
  get nameValid(): boolean {
    if (this.nameFilterRules || this.tabooCheck) {
      return validateNameWithRules(this.name, this.nameFilterRules, this.tabooCheck) === CreateResult.Success;
    }
    return validateName(this.name) === CreateResult.Success;
  }

  // ── Final output ──────────────────────────────────────────────────

  /** Produce a CharacterCreateInfo object for submission. */
  getCharacterInfo(): CharacterCreateInfo {
    return {
      name: this.name,
      heritage: this.heritage,
      gender: this.gender,
      attributes: { ...this.attributes },
      skills: new Map(this.skills),
      appearance: { ...this.appearance } as AppearanceInfo,
      // ACCharGenResult.templateNum = template_ (CharGenState::GetCharGenResult @ 005c4030).
      templateIndex: this.templateIndex,
      startArea: this.startArea,
    };
  }

  // ── Validation ────────────────────────────────────────────────────

  /**
   * Validate the entire wizard state.
   * Returns an object with a validity flag and a list of error messages.
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Heritage
    if (this.heritage === Heritage.Invalid) {
      errors.push('No heritage selected');
    }

    // Name
    if (validateName(this.name) !== CreateResult.Success) {
      errors.push('Invalid character name');
    }

    // Attributes
    if (validateAttributes(this.attributes, this.attributeCredits) !== CreateResult.Success) {
      errors.push('Invalid attribute allocation');
    }
    if (!this._attributesInRange()) {
      errors.push('One or more attributes out of range');
    }

    // Skill credits
    if (this.skillCreditsUsed > this.skillCredits) {
      errors.push('Too many skill credits used');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
