/**
 * FAITHFUL.178 — validateNameWithRules() correctness tests.
 *
 * Pins the retail char-create rules ACE-derived from NameFilterTable +
 * TabooTable. Mirrors the rules loaded live in the renderer:
 *   - maximumSameCharactersInARow = 2
 *   - maximumVowelsInARow = 3 (compound letters th/ch/ph count as one)
 *   - firstNCharactersMustHaveAVowel = 4
 *   - extraAllowedCharacters = "'-"
 *
 * Reference: packages/shared/src/character/CharacterCreation.ts
 */
import { describe, it, expect } from 'vitest';
import { validateNameWithRules, CreateResult } from '@ac/shared';
import type { NameFilterRules } from '@ac/shared';

const ENGLISH_RETAIL_RULES: NameFilterRules = {
  maximumSameCharactersInARow: 2,
  maximumVowelsInARow: 3,
  firstNCharactersMustHaveAVowel: 4,
  vowelContainingSubstringLength: 5,
  extraAllowedCharacters: "'-",
  compoundLetterGroups: ['th', 'ch', 'ph'],
};

describe('validateNameWithRules — basic length / whitespace', () => {
  it('rejects empty name', () => {
    expect(validateNameWithRules('', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('rejects all-whitespace name', () => {
    expect(validateNameWithRules('   ', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('rejects leading/trailing space', () => {
    expect(validateNameWithRules(' Aaron', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
    expect(validateNameWithRules('Aaron ', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('rejects names longer than 32 chars', () => {
    expect(validateNameWithRules('A'.repeat(33), ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
});

describe('validateNameWithRules — maximumSameCharactersInARow', () => {
  it('accepts 2 in a row', () => {
    expect(validateNameWithRules('Aaron', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('rejects 3 in a row', () => {
    expect(validateNameWithRules('Aaaron', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('rejects 5 in a row', () => {
    expect(validateNameWithRules('Aaaaaa', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
});

describe('validateNameWithRules — maximumVowelsInARow', () => {
  it('accepts 3 vowels in a row', () => {
    expect(validateNameWithRules('Caoine', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('rejects 4 vowels in a row', () => {
    expect(validateNameWithRules('Caooine', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('treats compound letter "th" as one non-vowel — "Throne" stays valid', () => {
    // T H R O N E: counting consonants individually, "thr" is 3 consonants; the
    // vowel run is just O. With "th" as a compound, the sequence is th/r/o/n/e
    // — still has vowel "o" but no excessive run. Test that compound prefix
    // doesn't trip the rule by being misclassified as vowels.
    expect(validateNameWithRules('Throne', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
});

describe('validateNameWithRules — firstNCharactersMustHaveAVowel', () => {
  it('accepts names with a vowel in the first 4 chars', () => {
    expect(validateNameWithRules('Aaron', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
    expect(validateNameWithRules('Thane', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('rejects names with no vowel in the first 4 chars', () => {
    // First 4 chars "Mrbg" — no vowel. Expected to fail.
    expect(validateNameWithRules('Mrbgxyz', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
});

describe('validateNameWithRules — extraAllowedCharacters', () => {
  it('accepts apostrophe', () => {
    expect(validateNameWithRules("Aaron'Glenn", ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('accepts hyphen', () => {
    expect(validateNameWithRules('Aaron-Glenn', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('accepts space (always allowed)', () => {
    expect(validateNameWithRules('Aaron Glenn', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.Success);
  });
  it('rejects digits', () => {
    expect(validateNameWithRules('Aaron2', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
  it('rejects punctuation not in extraAllowedCharacters', () => {
    expect(validateNameWithRules('Aaron!', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
    expect(validateNameWithRules('Aaron@', ENGLISH_RETAIL_RULES, null)).toBe(CreateResult.InvalidName);
  });
});

describe('validateNameWithRules — TabooTable integration', () => {
  it('rejects names matching the taboo predicate', () => {
    const tabooed = (input: string) => input.toLowerCase() === 'fubar';
    expect(validateNameWithRules('Fubar', ENGLISH_RETAIL_RULES, tabooed)).toBe(CreateResult.InvalidName);
  });
  it('accepts names not matching the taboo predicate', () => {
    const tabooed = (input: string) => input.toLowerCase() === 'fubar';
    expect(validateNameWithRules('Alice', ENGLISH_RETAIL_RULES, tabooed)).toBe(CreateResult.Success);
  });
});

describe('validateNameWithRules — no rules + no taboo', () => {
  it('falls back to length/whitespace-only basic validation', () => {
    expect(validateNameWithRules('Aaron', null, null)).toBe(CreateResult.Success);
    expect(validateNameWithRules('', null, null)).toBe(CreateResult.InvalidName);
    expect(validateNameWithRules('Aaaaaa', null, null)).toBe(CreateResult.Success); // basic validator allows it
  });
});
