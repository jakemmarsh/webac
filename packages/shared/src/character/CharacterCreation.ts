/**
 * CharacterCreation — the chargen wizard's CharacterCreate payload shape and
 * the client-side name/attribute checks the wizard runs before submitting.
 *
 * The character itself is built server-side (ACE.Server/Factories/
 * PlayerFactory.cs); the client only validates what retail's chargen UI
 * validates locally.
 */

import { Heritage, Gender, SkillAdvancementClass } from './Heritage.js';
import { ATTRIBUTE_MIN, ATTRIBUTE_MAX } from './StartingAttributes.js';

/** Character creation input from the UI/client */
export interface CharacterCreateInfo {
  name: string;
  heritage: Heritage;
  gender: Gender;
  attributes: {
    strength: number;
    endurance: number;
    coordination: number;
    quickness: number;
    focus: number;
    self: number;
  };
  /** Map of skill ID → advancement class (Trained/Specialized/Untrained) */
  skills: Map<number, SkillAdvancementClass>;
  appearance: AppearanceInfo;
  templateIndex: number;
  startArea: number;
}

export interface AppearanceInfo {
  hairStyle: number;
  hairColor: number;
  /** BUG.chargen-eyes-strip-sent-as-eye-colour — the eyes STRIP index into
   *  Sex_CG.eyeStripList (retail CharGenState::eyesStrip; the wire's
   *  Appearance.Eyes, ACE PlayerFactory.cs:77 GetEyeTexture). */
  eyesStrip: number;
  /** The eye-colour PALETTE index into Sex_CG.eyeColorList (retail
   *  CharGenState::eyeColor; the wire's Appearance.EyeColor, ACE
   *  PlayerFactory.cs:100 sex.EyeColorList[EyeColor]). */
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
  /** VISUAL.156 — shade doubles (0..1), the ACE CharacterCreate wire's six
   *  float64 hue fields. Each selects a palette within the part's
   *  PaletteSet (gmCGAppearancePage SetShade / gradient disk). Optional so
   *  pre-wheel appearance blobs (default 0) keep working. */
  skinHue?: number;
  hairHue?: number;
  headgearHue?: number;
  shirtHue?: number;
  pantsHue?: number;
  footwearHue?: number;
}

export enum CreateResult {
  Success = 0,
  TooManySkillCreditsUsed = 1,
  InvalidSkillRequested = 2,
  FailedToTrainSkill = 3,
  FailedToSpecializeSkill = 4,
  ClientServerSkillsMismatch = 5,
  InvalidHeritageGroup = 6,
  InvalidGender = 7,
  InvalidName = 8,
  InvalidAppearance = 9,
  InvalidStartArea = 10,
}

/**
 * Validate character name — basic length / whitespace rules.
 *
 * For full DAT-driven validation matching retail (vowel/consonant rules,
 * compound-letter handling, taboo-word filter) use `validateNameWithRules`
 * which accepts loaded NameFilterTable + TabooTable inputs.
 */
export function validateName(name: string): CreateResult {
  if (!name || name.trim().length === 0) {
    return CreateResult.InvalidName;
  }
  if (name.length < 1 || name.length > 32) {
    return CreateResult.InvalidName;
  }
  // No leading/trailing spaces
  if (name !== name.trim()) {
    return CreateResult.InvalidName;
  }
  return CreateResult.Success;
}

/**
 * Structural rule set extracted from a NameFilterTable entry. Pulled out as
 * a type so the shared module doesn't depend on the dat-parser package.
 */
export interface NameFilterRules {
  maximumSameCharactersInARow: number;
  maximumVowelsInARow: number;
  firstNCharactersMustHaveAVowel: number;
  vowelContainingSubstringLength: number;
  extraAllowedCharacters: string;
  compoundLetterGroups: string[];
}

/**
 * Predicate for the taboo-word filter — caller passes a function that wraps
 * a loaded TabooTable's `containsBadWord` method. Keeping it as a function
 * lets the shared package stay free of dat-parser imports.
 */
export type TabooPredicate = (input: string) => boolean;

/**
 * Full DAT-driven character name validation. Combines:
 *   1) Basic length / whitespace checks from `validateName`.
 *   2) `rules.maximumSameCharactersInARow` — no character may repeat more
 *      than N consecutive times (default retail = 2; "Aaaaa" fails).
 *   3) `rules.maximumVowelsInARow` — no more than N consecutive vowels
 *      (default retail = 3; compound letters like "th" count as one).
 *   4) `rules.firstNCharactersMustHaveAVowel` + `vowelContainingSubstringLength`
 *      — within the first N characters, at least one vowel must appear in a
 *      substring of length M. Default retail enforces "first 4 chars must
 *      contain a vowel".
 *   5) `rules.extraAllowedCharacters` — set of non-alphanumeric characters
 *      allowed in addition to letters (retail: apostrophe, hyphen).
 *   6) `tabooCheck` — whole-name match against the TabooTable's forbidden
 *      glob list.
 *
 * Mirrors the retail AC char-create validation chain. Reference:
 *   reference/ACE/Source/ACE.DatLoader/Entity/NameFilterLanguageData.cs
 *   reference/ACE/Source/ACE.DatLoader/Entity/TabooTableEntry.cs
 */
export function validateNameWithRules(
  name: string,
  rules: NameFilterRules | null,
  tabooCheck: TabooPredicate | null,
): CreateResult {
  const basic = validateName(name);
  if (basic !== CreateResult.Success) return basic;
  if (rules) {
    if (!checkSameCharactersInARow(name, rules.maximumSameCharactersInARow)) {
      return CreateResult.InvalidName;
    }
    if (!checkVowelsInARow(name, rules.maximumVowelsInARow, rules.compoundLetterGroups)) {
      return CreateResult.InvalidName;
    }
    if (rules.firstNCharactersMustHaveAVowel > 0
        && !checkFirstNHasVowel(name, rules.firstNCharactersMustHaveAVowel, rules.vowelContainingSubstringLength)) {
      return CreateResult.InvalidName;
    }
    if (!checkAllowedCharacters(name, rules.extraAllowedCharacters)) {
      return CreateResult.InvalidName;
    }
  }
  if (tabooCheck && tabooCheck(name)) {
    return CreateResult.InvalidName;
  }
  return CreateResult.Success;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

function checkSameCharactersInARow(name: string, max: number): boolean {
  let run = 1;
  for (let i = 1; i < name.length; i++) {
    if (name[i].toLowerCase() === name[i - 1].toLowerCase()) {
      run++;
      if (run > max) return false;
    } else {
      run = 1;
    }
  }
  return true;
}

function checkVowelsInARow(name: string, max: number, compoundLetters: string[]): boolean {
  const lower = name.toLowerCase();
  // Compound letters (e.g. "th", "ch") count as ONE non-vowel letter for the
  // run accumulator. Match longest compound first so "tch" beats "th".
  const compoundSorted = [...compoundLetters].sort((a, b) => b.length - a.length);
  let run = 0;
  let i = 0;
  while (i < lower.length) {
    let consumed = 1;
    let isVowel = false;
    // Try compound match first
    let matchedCompound = false;
    for (const c of compoundSorted) {
      if (lower.startsWith(c, i)) {
        consumed = c.length;
        isVowel = false; // compounds are treated as one consonant unit
        matchedCompound = true;
        break;
      }
    }
    if (!matchedCompound) isVowel = VOWELS.has(lower[i]);
    if (isVowel) {
      run++;
      if (run > max) return false;
    } else {
      run = 0;
    }
    i += consumed;
  }
  return true;
}

function checkFirstNHasVowel(name: string, firstN: number, _subLen: number): boolean {
  const window = name.slice(0, firstN).toLowerCase();
  for (const ch of window) {
    if (VOWELS.has(ch)) return true;
  }
  return false;
}

function checkAllowedCharacters(name: string, extra: string): boolean {
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const isAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isSpace = code === 0x20;
    if (isAlpha || isSpace) continue;
    if (extra.includes(ch)) continue;
    return false;
  }
  return true;
}

/**
 * Validate attribute allocation: each 10-100, total ≤ heritage's attributeCredits.
 */
export function validateAttributes(
  attributes: CharacterCreateInfo['attributes'],
  maxCredits: number,
): CreateResult {
  const values = [
    attributes.strength,
    attributes.endurance,
    attributes.coordination,
    attributes.quickness,
    attributes.focus,
    attributes.self,
  ];

  for (const val of values) {
    if (!Number.isInteger(val) || val < ATTRIBUTE_MIN || val > ATTRIBUTE_MAX) {
      return CreateResult.InvalidSkillRequested;
    }
  }

  const total = values.reduce((a, b) => a + b, 0);
  if (total > maxCredits) {
    return CreateResult.TooManySkillCreditsUsed;
  }

  return CreateResult.Success;
}
