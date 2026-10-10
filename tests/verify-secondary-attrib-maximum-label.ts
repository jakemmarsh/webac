/**
 * SecondaryAttrib wield-req labels use 'Maximum' not 'Max' (FAITHFUL.294).
 *
 * Pre-fix `formatWieldRequirement` in `packages/shared/src/ace-enums.ts:721`
 * mapped PropertyAttribute2nd 1/3/5 to the SHORT labels 'Max Health' /
 * 'Max Stamina' / 'Max Mana'. ACE's canonical
 * `PropertyAttribute2ndExtensions.ToSentence`
 * (reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyAttribute2nd.cs:30-52)
 * uses the LONG forms 'Maximum Health' / 'Maximum Stamina' / 'Maximum Mana'.
 * The C# algorithmic fallback at line 51 even includes an explicit
 * `.Replace("Max", "Maximum")` step to enforce the long form on any
 * future Max* additions to the enum.
 *
 * Items with `WieldRequirements = SecondaryAttrib` therefore displayed
 * 'Max Health — N' on appraise instead of the canonical 'Maximum
 * Health — N'. Drift was string-only — no behavior bug, just non-faithful
 * wording in the wield-req tooltip row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatWieldRequirement, WieldRequirementType } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_PROP2 = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyAttribute2nd.cs',
);

describe('formatWieldRequirement.SecondaryAttrib — canonical "Maximum X" labels', () => {
  it('PropertyAttribute2nd 1 → "Maximum Health" (NOT "Max Health")', () => {
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 1, 200))
      .toBe('Maximum Health — 200');
  });
  it('PropertyAttribute2nd 3 → "Maximum Stamina"', () => {
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 3, 150))
      .toBe('Maximum Stamina — 150');
  });
  it('PropertyAttribute2nd 5 → "Maximum Mana"', () => {
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 5, 180))
      .toBe('Maximum Mana — 180');
  });
  it('RawSecondaryAttrib uses the same canonical names', () => {
    expect(formatWieldRequirement(WieldRequirementType.RawSecondaryAttrib, 1, 250))
      .toBe('Maximum Health — 250');
  });
  it('Unknown index falls back to "Vital #N" (matches pre-fix fallback shape)', () => {
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 99, 0))
      .toBe('Vital #99 — 0');
  });
});

describe.skipIf(!aceReferenceExists(ACE_PROP2))('ACE source pin — PropertyAttribute2nd.ToSentence', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PROP2, 'utf8');
  });

  it('MaxHealth → "Maximum Health"', () => {
    expect(src).toMatch(/case PropertyAttribute2nd\.MaxHealth:\s*return "Maximum Health";/);
  });
  it('MaxStamina → "Maximum Stamina"', () => {
    expect(src).toMatch(/case PropertyAttribute2nd\.MaxStamina:\s*return "Maximum Stamina";/);
  });
  it('MaxMana → "Maximum Mana"', () => {
    expect(src).toMatch(/case PropertyAttribute2nd\.MaxMana:\s*return "Maximum Mana";/);
  });
  it('algorithmic fallback explicitly replaces "Max" with "Maximum"', () => {
    // This is the C# fallback's "if a new MaxFoo gets added to the enum,
    // still surface it as 'Maximum Foo'" rule. Pinning it here makes the
    // canonical retail convention visible from the TypeScript side.
    expect(src).toMatch(/\.Replace\("Max", "Maximum"\)/);
  });
});
