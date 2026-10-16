/**
 * CORE.17.k.b.b.a.f.d — the chargen Random button as the decompiled EoL
 * client rolls it: gmCharGenMainUI::DoRandom @ 004e7d70 dispatches PER PAGE
 * (m_eProgressState), and every roll is a CharGenState::Randomize* over the
 * CRT rand() / the Random::RollDice generator.
 *
 * Ground truth (docs/retail-client-symbols.md, CORE.17.k.b.b.a.f.d):
 *  - DoRandom @ 004e7d70: ECG_HERTAGE → RandomizeHeritageGroup(AccountHas
 *    ThroneOfDestiny) + gmCGHeritagePage::Update; ECG_PROFESSION →
 *    RandomizeTemplate + gmCGProfessionPage::UpdateToDefaultAttributes;
 *    ECG_SKILLS → RandomizeSkills + gmCGSkillsPage::Update; ECG_APPEARANCE →
 *    m_eCurType != ECG_CHOICE_CLOTHES ? RandomizeAppearance(0) :
 *    RandomizeClothing(1), then gmCGAppearancePage::Update; ECG_TOWN →
 *    SetStartArea(RandInt(ToD ? 4 : 3)) + gmCGTownPage::Update;
 *    ECG_SUMMARY → RandomizeCharacter(ToD) + gmCGSummaryPage::Update.
 *  - ListenToElementMessage (0x100003cb, message 1): in ECG_SUMMARY
 *    MakeRandomizeWarningDialog @ 004e8a90 (DialogFactory type 0x8e = 1 —
 *    the Yes / No confirmation — with 0xc5 = ID_CharGen_RandomizeWarning
 *    from table 0x10000002); CloseRandomizeWarningDialog @ 004e8400 runs
 *    DoRandom on Yes. Every other page runs DoRandom at once.
 *  - RandInt(n) @ 00684400 = (rand() × n) >> 15 — uniform over [0, n) from
 *    the CRT's 15-bit rand(); RandInt(n, exclude) @ 00684420 redraws while
 *    the draw equals `exclude` (n > 1), else 0. CharGenState::GetRandomInt
 *    @ 00563910 / 00563920 are those; GetRandomReal @ 00563940 =
 *    rand() × (1 / 32767) (.rdata 0x3f00002000400080).
 *  - Random::RollDice(min, max) @ 0042c5c0 = min + ftol(real01 ×
 *    (max − min + 1)) over its own generator @ 0042c4c0 — inclusive.
 *  - RandomizeHeritageGroup @ 005c6a20: SetHeritageGroup(RollDice(1, ToD ?
 *    4 : 3)) — Aluvian, Gharu'ndim, Sho, Viamontian; never the later
 *    heritages. SetHeritageGroup @ 005c67a0 sets the credits, ApplyTemplate
 *    and RandomizeStartArea @ 005c59e0 (RandInt over the heritage's primary
 *    start areas — one each at EoL: the home town — validated against the
 *    starter-area count, else −1).
 *  - RandomizeTemplate @ 005c6500: needs a heritage and a gender; Olthoi
 *    (0xc / 0xd) → template_ = 1 + ApplyTemplate (which forces 0); else with
 *    more than one template: template_ = RandInt(count − 1, template_ − 1)
 *    + 1 (never the current one, 1..count−1 — Adventurer 0 is never
 *    rolled) + ApplyTemplate.
 *  - RandomizeSkills @ 005c57e0: ResetSkillLevels; up to 100 draws of
 *    RandInt(totalNumSkills) — an Untrained draw is trained only on an odd
 *    iteration, a Trained draw is specialized (SetSkillLevel) — while
 *    credits remain; then, with credits left, a fill pass over ids 0..
 *    totalNumSkills−1 in order: Untrained → Trained when affordable,
 *    Trained → Specialized when (credits + trained cost − specialized cost)
 *    ≥ 0, until the credits are 0. totalNumSkills = the SkillTable's
 *    highest id + 1 (55 at EoL) while the table carries 38 ids; retail's
 *    GetSkillTrainedCost is −1 for the 17 phantom ids, so its SetSkillLevel
 *    and fill pass GAIN a credit on each — an EoL client bug that overspends
 *    the 52 credits, and ACE refuses such a character (InvalidSkillRequested
 *    / FailedToTrainSkill). Ours keeps the draw domain and treats a phantom
 *    draw as a miss (nothing set, no credit) — the one deliberate deviation,
 *    recorded in the task notes.
 *  - RandomizeAppearance(0) @ 005c4f10: eyes strip, nose strip, mouth strip
 *    = GetRandomInt(count, current) (never the current one); skinShade,
 *    hairShade = GetRandomReal; hairColor, eyeColor, hairStyle =
 *    GetRandomInt(count, current); each only when its list is non-empty.
 *    The gender is NOT rolled here.
 *  - RandomizeClothing(1) @ 005c6770 = RandomizeHeadgear(1) + RandomizeShirt
 *    + RandomizeTrousers + RandomizeFootwear. RandomizeHeadgear @ 005c5e10:
 *    RandInt(count + 1[, current + 1]) − 1 — −1 is "no headgear" (ACE:
 *    uint.MaxValue); SetHeadgearStyle then holds the colour to [0, colours
 *    − 1]; headgearColor = RandInt(colours, current); the shade = rand() /
 *    32767. Shirt / trousers / footwear @ 005c5ef0 / 005c5fb0 / 005c6070:
 *    style = RandInt(count, current) (no "none"), the colour held to
 *    ≤ colours − 1, colour = RandInt(colours, current), the shade.
 *  - RandomizeCharacter(ToD) @ 005c6d80: Reset @ 005c68a0 (the name "",
 *    every lock off, heritage / gender 0, every appearance −1, template_
 *    −1, startArea −1), SetHeritageGroup(RollDice(1, ToD ? 4 : 3)),
 *    SetGender(RollDice(1, 2)), RandomizeAppearance(0), RandomizeHeadgear(0)
 *    (no exclusion), Shirt, Trousers, Footwear, RandomizeTemplate,
 *    RandomizeStartArea; the three *Frozen flags it sets are read nowhere.
 *    The town page's roll is RandInt(ToD ? 4 : 3) (any of the four towns),
 *    not the heritage's primary area.
 */

import { SkillAdvancementClass } from '@ac/shared';
import type { AppearanceState } from './CharacterCreate.js';
import { OLTHOI_HERITAGES, resetSkillLevels, setSkillLevel, skillLevelOf } from './ChargenTemplates.js';
import type { ChargenSkillCosts, ChargenSkillState } from './ChargenTemplates.js';

// ─── The generators ────────────────────────────────────────────────────

/** The CRT rand() range the client's RandInt / GetRandomReal divide by. */
export const RETAIL_RAND_MAX = 32767;

/**
 * The two generators the client draws from: `rand()` (the CRT, an integer
 * in [0, 32767]) and `roll()` (Random::RollDice's own generator, a real in
 * [0, 1)). Tests script them; the page uses Math.random for both.
 */
export interface ChargenRandomSource {
  rand(): number;
  roll(): number;
}

export function defaultRandomSource(random: () => number = Math.random): ChargenRandomSource {
  return {
    rand: () => Math.floor(random() * (RETAIL_RAND_MAX + 1)),
    roll: () => random(),
  };
}

/**
 * A reproducible source (mulberry32 over `seed`) for capture tooling:
 * GameUI.pinChargenRandom seeds the roll a fresh chargen opens with, so two
 * screen-regression runs of identical code land on the same character.
 */
export function seededRandomSource(seed: number): ChargenRandomSource {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return defaultRandomSource(next);
}

/** A scripted source for tests: `rand()` values first, `roll()` values second; each wraps around. */
export function scriptedRandomSource(rands: readonly number[], rolls: readonly number[] = [0]): ChargenRandomSource & { randCalls: number; rollCalls: number } {
  const src = {
    randCalls: 0, rollCalls: 0,
    rand: (): number => { const v = rands[src.randCalls % rands.length]; src.randCalls++; return v; },
    roll: (): number => { const v = rolls[src.rollCalls % rolls.length]; src.rollCalls++; return v; },
  };
  return src;
}

/** RandInt(n) @ 00684400: (rand() × n) >> 15 — uniform over [0, n). */
export function randInt(src: ChargenRandomSource, n: number): number {
  return Math.floor((src.rand() * n) / (RETAIL_RAND_MAX + 1));
}

/** The redraws after which a source that keeps returning `exclude` is reported instead of spun on (a scripted-source guard; the client has none). */
export const RAND_INT_EXCLUDING_REDRAW_CAP = 10_000;

/** RandInt(n, exclude) @ 00684420: a draw that is not `exclude`; 0 when n ≤ 1. */
export function randIntExcluding(src: ChargenRandomSource, n: number, exclude: number): number {
  if (n <= 1) return 0;
  let draw: number;
  let redraws = 0;
  do {
    draw = randInt(src, n);
    if (draw === exclude && ++redraws > RAND_INT_EXCLUDING_REDRAW_CAP) {
      throw new Error(`randIntExcluding(${n}, ${exclude}): the source returned the excluded draw ${redraws} times`);
    }
  } while (draw === exclude);
  return draw;
}

/** CharGenState::GetRandomReal @ 00563940: rand() / 32767 — [0, 1] inclusive. */
export function randomReal(src: ChargenRandomSource): number {
  return src.rand() / RETAIL_RAND_MAX;
}

/** Random::RollDice(min, max) @ 0042c5c0: min + ftol(real × (max − min + 1)) — inclusive. */
export function rollDice(src: ChargenRandomSource, min: number, max: number): number {
  if (max === min) return min;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.trunc(src.roll() * (hi - lo + 1));
}

// ─── The heritage / town rolls ─────────────────────────────────────────

/** The heritages the rolls reach: 1..4 with Throne of Destiny (Viamontian included), 1..3 without. */
export const TOD_ROLL_HERITAGES = 4;
export const PRE_TOD_ROLL_HERITAGES = 3;
/** The towns the town page's roll reaches: 0..3 with Throne of Destiny (Sanamar included), 0..2 without. */
export const TOD_ROLL_TOWNS = 4;
export const PRE_TOD_ROLL_TOWNS = 3;

/**
 * CharGenState::RandomizeHeritageGroup @ 005c6a20 — the heritage SetHeritageGroup receives.
 * `listed`: a roll that lands on a heritage the page doesn't list (a classic
 * era blanks it, HeritageRows.ts) is redrawn among the listed ones in the
 * same range; end of retail lists them all, so its sequence is unchanged.
 */
export function randomizeHeritageGroup(src: ChargenRandomSource, hasThroneOfDestiny: boolean, listed?: (heritage: number) => boolean): number {
  const max = hasThroneOfDestiny ? TOD_ROLL_HERITAGES : PRE_TOD_ROLL_HERITAGES;
  const rolled = rollDice(src, 1, max);
  if (!listed || listed(rolled)) return rolled;
  const choices = Array.from({ length: max }, (_, i) => i + 1).filter(listed);
  return choices.length ? choices[randInt(src, choices.length)] : rolled;
}

/** DoRandom's ECG_TOWN case — the start area SetStartArea receives. */
export function randomizeTownPage(src: ChargenRandomSource, hasThroneOfDestiny: boolean): number {
  return randInt(src, hasThroneOfDestiny ? TOD_ROLL_TOWNS : PRE_TOD_ROLL_TOWNS);
}

/** CharGenState::SetStartArea @ 005c4000 — held to the starter-area list, else −1. */
export function setStartArea(index: number, starterAreaCount: number): number {
  return index >= 0 && index < starterAreaCount ? index : -1;
}

/**
 * CharGenState::RandomizeStartArea @ 005c59e0 — RandInt(count, −1) over the
 * heritage's primary start areas, validated against the starter-area
 * count (else −1). Returns undefined when the heritage lists none (the
 * start area is left alone).
 */
export function randomizeStartArea(src: ChargenRandomSource, primaryStartAreas: readonly number[], starterAreaCount: number): number | undefined {
  if (primaryStartAreas.length === 0) return undefined;
  const area = primaryStartAreas[randIntExcluding(src, primaryStartAreas.length, -1)];
  return setStartArea(area, starterAreaCount);
}

// ─── The template roll ─────────────────────────────────────────────────

/**
 * CharGenState::RandomizeTemplate @ 005c6500 — the new template_ and
 * whether ApplyTemplate follows; null when nothing changes (no heritage
 * or gender, or a single-template heritage that is not Olthoi).
 */
export function randomizeTemplate(src: ChargenRandomSource, heritage: number, gender: number, templateIndex: number, templateCount: number): { templateIndex: number; apply: boolean } | null {
  if (heritage === 0 || gender === 0) return null;
  if (OLTHOI_HERITAGES.includes(heritage)) return { templateIndex: 1, apply: true };
  if (templateCount <= 1) return null;
  const draw = randIntExcluding(src, templateCount - 1, templateIndex - 1);
  return { templateIndex: draw + 1, apply: draw + 1 !== -1 };
}

// ─── The skills roll ───────────────────────────────────────────────────

/** RandomizeSkills' draw cap (`uVar4 < 100`). */
export const RANDOMIZE_SKILLS_MAX_DRAWS = 100;

/** CharGenState::totalNumSkills — the SkillTable's highest id + 1 (55 at EoL). */
export function totalNumSkills(costs: ChargenSkillCosts): number {
  let max = -1;
  for (const id of costs.skillIds) if (id > max) max = id;
  return max + 1;
}

/**
 * CharGenState::RandomizeSkills @ 005c57e0 over the wizard's skill state.
 * `numSkills` is the draw domain (totalNumSkills); a draw the table does
 * not carry is a miss (see the header — retail's −1 cost would gain a
 * credit there). Returns the number of draws made.
 */
export function randomizeSkills(src: ChargenRandomSource, state: ChargenSkillState, costs: ChargenSkillCosts, numSkills: number = totalNumSkills(costs)): number {
  resetSkillLevels(state, costs);
  const known = new Set(costs.skillIds);
  let draws = 0;
  let i = 0;
  // do { … } while (remaining != 0 && ++i < 100)
  for (;;) {
    const id = randInt(src, numSkills);
    draws++;
    if (id < numSkills && known.has(id)) {
      const level = skillLevelOf(state, id);
      if (level === SkillAdvancementClass.Untrained) {
        if ((i & 1) !== 0) setSkillLevel(state, id, SkillAdvancementClass.Trained, costs);
      } else if (level === SkillAdvancementClass.Trained) {
        setSkillLevel(state, id, SkillAdvancementClass.Specialized, costs);
      }
    }
    if (state.remainingSkillCredits === 0) break;
    i++;
    if (i >= RANDOMIZE_SKILLS_MAX_DRAWS) break;
  }
  // The fill pass: ids in order while credits remain.
  if (state.remainingSkillCredits > 0 && numSkills !== 0) {
    for (let id = 0; id < numSkills; id++) {
      if (known.has(id)) {
        const level = skillLevelOf(state, id);
        const credits = state.remainingSkillCredits;
        if (level === SkillAdvancementClass.Untrained) {
          const cost = costs.trainedCost(id);
          if (credits - cost >= 0) {
            state.remainingSkillCredits = credits - cost;
            state.levels.set(id, SkillAdvancementClass.Trained);
          }
        } else if (level === SkillAdvancementClass.Trained) {
          const left = credits + costs.trainedCost(id) - costs.specializedCost(id);
          if (left >= 0) {
            state.remainingSkillCredits = left;
            state.levels.set(id, SkillAdvancementClass.Specialized);
          }
        }
      }
      if (state.remainingSkillCredits === 0) break;
    }
  }
  return draws;
}

// ─── The appearance rolls ──────────────────────────────────────────────

/** The per-sex lists the appearance rolls read (Sex_CG). */
export interface AppearanceRollLists {
  readonly hairStyleCount: number;
  readonly hairColorCount: number;
  readonly eyeStripCount: number;
  readonly eyeColorCount: number;
  readonly noseStripCount: number;
  readonly mouthStripCount: number;
  readonly headgearCount: number;
  readonly shirtCount: number;
  readonly pantsCount: number;
  readonly footwearCount: number;
  /** The colour count the clothing pages offer (our page's clothingColorsList). */
  readonly clothingColorCount: number;
}

/**
 * CharGenState::RandomizeAppearance(0) @ 005c4f10 — the face: the eyes /
 * nose / mouth strips, the skin and hair shades, the hair colour and the
 * hair style; every draw skips the current value. The gender and the
 * clothes are untouched. The eyes strip (eyesStrip) and the eye-colour
 * palette index (eyeColor) are separate draws, in retail's order.
 */
export function randomizeAppearance(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists): void {
  if (lists.eyeStripCount !== 0) a.eyesStrip = randIntExcluding(src, lists.eyeStripCount, a.eyesStrip);
  if (lists.noseStripCount !== 0) a.noseStyle = randIntExcluding(src, lists.noseStripCount, a.noseStyle);
  if (lists.mouthStripCount !== 0) a.mouthStyle = randIntExcluding(src, lists.mouthStripCount, a.mouthStyle);
  a.skinHue = randomReal(src);
  a.hairHue = randomReal(src);
  if (lists.hairColorCount !== 0) a.hairColor = randIntExcluding(src, lists.hairColorCount, a.hairColor);
  if (lists.eyeColorCount !== 0) a.eyeColor = randIntExcluding(src, lists.eyeColorCount, a.eyeColor);
  if (lists.hairStyleCount !== 0) a.hairStyle = randIntExcluding(src, lists.hairStyleCount, a.hairStyle);
}

/** The colour count SetHeadgearStyle / SetShirtStyle … store: 0 for "no gear". */
function gearColorCount(style: number, lists: AppearanceRollLists): number {
  return style === -1 ? 0 : lists.clothingColorCount;
}

/**
 * CharGenState::RandomizeHeadgear(excludeCurrent) @ 005c5e10: the style is
 * RandInt(count + 1[, current + 1]) − 1 (−1 = no headgear), SetHeadgearStyle
 * holds the colour to [0, colours − 1], then the colour is rolled (never
 * the current one) and the shade drawn.
 */
export function randomizeHeadgear(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists, excludeCurrent: boolean): void {
  if (lists.headgearCount !== 0) {
    const draw = excludeCurrent
      ? randIntExcluding(src, lists.headgearCount + 1, a.headgearStyle + 1)
      : randInt(src, lists.headgearCount + 1);
    a.headgearStyle = draw - 1;
    const colours = gearColorCount(a.headgearStyle, lists);
    if (a.headgearStyle !== -1) {
      if (a.headgearColor < 0) a.headgearColor = 0;
      if (colours <= a.headgearColor) a.headgearColor = colours - 1;
    }
  }
  const colours = gearColorCount(a.headgearStyle, lists);
  if (colours !== 0) a.headgearColor = randIntExcluding(src, colours, a.headgearColor);
  a.headgearHue = randomReal(src);
}

/** CharGenState::RandomizeShirt @ 005c5ef0 (the style never the current one; no "none"). */
export function randomizeShirt(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists): void {
  if (lists.shirtCount !== 0) {
    a.shirtStyle = randIntExcluding(src, lists.shirtCount, a.shirtStyle);
    if (lists.clothingColorCount <= a.shirtColor) a.shirtColor = lists.clothingColorCount - 1;
  }
  const colours = gearColorCount(a.shirtStyle, lists);
  if (colours !== 0) a.shirtColor = randIntExcluding(src, colours, a.shirtColor);
  a.shirtHue = randomReal(src);
}

/** CharGenState::RandomizeTrousers @ 005c5fb0. */
export function randomizeTrousers(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists): void {
  if (lists.pantsCount !== 0) {
    a.pantsStyle = randIntExcluding(src, lists.pantsCount, a.pantsStyle);
    if (lists.clothingColorCount <= a.pantsColor) a.pantsColor = lists.clothingColorCount - 1;
  }
  const colours = gearColorCount(a.pantsStyle, lists);
  if (colours !== 0) a.pantsColor = randIntExcluding(src, colours, a.pantsColor);
  a.pantsHue = randomReal(src);
}

/** CharGenState::RandomizeFootwear @ 005c6070. */
export function randomizeFootwear(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists): void {
  if (lists.footwearCount !== 0) {
    a.footwearStyle = randIntExcluding(src, lists.footwearCount, a.footwearStyle);
    if (lists.clothingColorCount <= a.footwearColor) a.footwearColor = lists.clothingColorCount - 1;
  }
  const colours = gearColorCount(a.footwearStyle, lists);
  if (colours !== 0) a.footwearColor = randIntExcluding(src, colours, a.footwearColor);
  a.footwearHue = randomReal(src);
}

/** CharGenState::RandomizeClothing(excludeHeadgear) @ 005c6770. */
export function randomizeClothing(src: ChargenRandomSource, a: AppearanceState, lists: AppearanceRollLists, excludeHeadgear: boolean): void {
  randomizeHeadgear(src, a, lists, excludeHeadgear);
  randomizeShirt(src, a, lists);
  randomizeTrousers(src, a, lists);
  randomizeFootwear(src, a, lists);
}

/** The Sex_CG lists as AppearanceRollLists; every count 0 without a sex record (nothing rolls). */
export function appearanceRollLists(sex: {
  hairStyleList: readonly unknown[]; hairColorList: readonly unknown[]; eyeStripList: readonly unknown[]; eyeColorList: readonly unknown[];
  noseStripList: readonly unknown[]; mouthStripList: readonly unknown[]; headgearList: readonly unknown[];
  shirtList: readonly unknown[]; pantsList: readonly unknown[]; footwearList: readonly unknown[];
  clothingColorsList: readonly unknown[];
} | null | undefined): AppearanceRollLists {
  return {
    hairStyleCount: sex?.hairStyleList.length ?? 0,
    hairColorCount: sex?.hairColorList.length ?? 0,
    eyeStripCount: sex?.eyeStripList.length ?? 0,
    eyeColorCount: sex?.eyeColorList.length ?? 0,
    noseStripCount: sex?.noseStripList.length ?? 0,
    mouthStripCount: sex?.mouthStripList.length ?? 0,
    headgearCount: sex?.headgearList.length ?? 0,
    shirtCount: sex?.shirtList.length ?? 0,
    pantsCount: sex?.pantsList.length ?? 0,
    footwearCount: sex?.footwearList.length ?? 0,
    clothingColorCount: sex?.clothingColorsList.length ?? 0,
  };
}

/** CharGenState::Reset @ 005c68a0's appearance half: every index −1, every shade −1.0. */
export function resetAppearance(a: AppearanceState): void {
  a.eyesStrip = -1; a.eyeColor = -1; a.noseStyle = -1; a.mouthStyle = -1;
  a.skinHue = -1; a.hairHue = -1;
  a.hairColor = -1; a.hairStyle = -1;
  a.headgearStyle = -1; a.headgearColor = -1; a.headgearHue = -1;
  a.shirtStyle = -1; a.shirtColor = -1; a.shirtHue = -1;
  a.pantsStyle = -1; a.pantsColor = -1; a.pantsHue = -1;
  a.footwearStyle = -1; a.footwearColor = -1; a.footwearHue = -1;
  a.skinColor = 0;
}

/** The colour count each clothing slot's chosen item offers (CharGenState::num<Slot>Colors, set by Set<Slot>Style). */
export interface ClothingColorCounts {
  readonly headgear: number;
  readonly shirt: number;
  readonly pants: number;
  readonly footwear: number;
}

/**
 * BUG.chargen-finish-silent — CharGenState::ConstrainAllByGender @ 005c5b80
 * (run by SetGender @ 005c64a0 and, through ConstrainAllByHeritage, by
 * SetHeritageGroup @ 005c67a0): every appearance index at or past the new
 * heritage / gender's list is pulled back to the list's last entry; the
 * Set<Slot>Style calls that follow hold each clothing colour inside the
 * chosen item's colours (0 .. num−1, only while a style is chosen). Without
 * a heritage or a gender (`lists` null) everything goes back to −1, as
 * Reset leaves it.
 *
 * Without it a face or outfit picked for one heritage / gender went out
 * with the next one's out-of-range index: ACE's PlayerFactory.Create threw
 * (sex.HairStyleList[i], EyeColorList[i], …), its handler logged the
 * exception and answered nothing, and FINISH sat pending for good — "FINISH
 * does nothing" (Reddit, Coldeve, 2026-10-16; every Olthoi: two-entry lists).
 */
export function constrainAppearance(a: AppearanceState, lists: AppearanceRollLists | null, colorCounts?: ClothingColorCounts | null): void {
  if (!lists) { resetAppearance(a); return; }
  const top = (v: number, count: number): number => (count <= v ? count - 1 : v);
  a.eyesStrip = top(a.eyesStrip, lists.eyeStripCount);
  a.noseStyle = top(a.noseStyle, lists.noseStripCount);
  a.mouthStyle = top(a.mouthStyle, lists.mouthStripCount);
  a.hairStyle = top(a.hairStyle, lists.hairStyleCount);
  a.eyeColor = top(a.eyeColor, lists.eyeColorCount);
  a.hairColor = top(a.hairColor, lists.hairColorCount);
  a.headgearStyle = top(a.headgearStyle, lists.headgearCount);
  a.shirtStyle = top(a.shirtStyle, lists.shirtCount);
  a.pantsStyle = top(a.pantsStyle, lists.pantsCount);
  a.footwearStyle = top(a.footwearStyle, lists.footwearCount);
  if (!colorCounts) return;
  // Set<Slot>Style(style): with a style chosen, colour < 0 → 0, colour >= num → num − 1.
  const color = (style: number, c: number, n: number): number => {
    if (style === -1) return c;
    let v = c < 0 ? 0 : c;
    if (n <= v) v = n - 1;
    return v;
  };
  a.headgearColor = color(a.headgearStyle, a.headgearColor, colorCounts.headgear);
  a.shirtColor = color(a.shirtStyle, a.shirtColor, colorCounts.shirt);
  a.pantsColor = color(a.pantsStyle, a.pantsColor, colorCounts.pants);
  a.footwearColor = color(a.footwearStyle, a.footwearColor, colorCounts.footwear);
}

/** The ID_CharGen_RandomizeWarning string (table 0x23000002) MakeRandomizeWarningDialog shows. */
export const RANDOMIZE_WARNING_STRING_ID = 158536663;
export const RANDOMIZE_WARNING_FALLBACK = 'Warning!\n\nRandomizing your character will reset all customizations you have made to appearance and abilities. Do you wish to continue?';
