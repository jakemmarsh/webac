/**
 * FAITHFUL.103 — Pin tests for formatWieldRequirement.
 *
 * Anchored to ACE Player_Inventory.cs:2125-2229 (`CheckWieldRequirement`)
 * for the kind→what→threshold semantics. The appraisal panel's wield-req
 * row consumes this formatter; pre-fix it printed just the raw threshold
 * number with no context (e.g. "Wield Req: 250" instead of "Wield
 * Requirements: Skill: War Magic — 250").
 *
 * Triplet layout (each triplet is 3 consecutive PropertyInt rows):
 *   158 = WieldRequirements   (kind: WieldRequirementType enum)
 *   159 = WieldSkillType      (what: depends on kind)
 *   160 = WieldDifficulty     (threshold)
 *
 * Plus 3 more triplets at 270/271/272, 273/274/275, 276/277/278.
 *
 * Audit anchor: also walks ACE source to pin enum values byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WieldRequirementType, formatWieldRequirement } from '../packages/shared/src/index.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/WieldRequirement.cs');

describe('WieldRequirementType (ACE-source audit)', () => {
  it('parses ACE source + has exactly 13 entries (Invalid + 12 kinds)', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    // ACE source uses implicit numbering — Invalid=0, Skill=1, ... HeritageType=12.
    const lines = src.split('\n');
    let inside = false;
    const ids: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!inside) { if (/enum\s+WieldRequirement\b/.test(line)) inside = true; continue; }
      if (line.startsWith('}')) break;
      const m = /^([A-Z][A-Za-z]*)\s*,?\s*(\/\/.*)?$/.exec(line);
      if (m) ids.push(m[1]);
    }
    expect(ids).toEqual([
      'Invalid',
      'Skill',
      'RawSkill',
      'Attrib',
      'RawAttrib',
      'SecondaryAttrib',
      'RawSecondaryAttrib',
      'Level',
      'Training',
      'IntStat',
      'BoolStat',
      'CreatureType',
      'HeritageType',
    ]);
  });

  it('TS port pins all 13 values implicit-sequentially', () => {
    expect(WieldRequirementType.Invalid).toBe(0);
    expect(WieldRequirementType.Skill).toBe(1);
    expect(WieldRequirementType.RawSkill).toBe(2);
    expect(WieldRequirementType.Attrib).toBe(3);
    expect(WieldRequirementType.RawAttrib).toBe(4);
    expect(WieldRequirementType.SecondaryAttrib).toBe(5);
    expect(WieldRequirementType.RawSecondaryAttrib).toBe(6);
    expect(WieldRequirementType.Level).toBe(7);
    expect(WieldRequirementType.Training).toBe(8);
    expect(WieldRequirementType.IntStat).toBe(9);
    expect(WieldRequirementType.BoolStat).toBe(10);
    expect(WieldRequirementType.CreatureType).toBe(11);
    expect(WieldRequirementType.HeritageType).toBe(12);
  });
});

describe('formatWieldRequirement', () => {
  // Resolvers replicate the in-game flow: DAT SkillTable for skill names,
  // CharGen for heritage names. Tests pass deterministic resolvers.
  const skillName = (id: number) => ({
    34: 'War Magic',
    44: 'Mana Conversion',
    7: 'Missile Defense',
  })[id] ?? null;
  const heritageName = (id: number) => ({
    1: 'Aluvian',
    2: 'Gharu\'ndim',
    3: 'Sho',
  })[id] ?? null;
  const creatureTypeName = (id: number) => ({
    25: 'Olthoi',
    7: 'Drudge',
  })[id] ?? null;
  const resolvers = { skillName, heritageName, creatureTypeName };

  it('Skill → "Skill: <name> — <threshold>"', () => {
    expect(formatWieldRequirement(WieldRequirementType.Skill, 34, 350, resolvers))
      .toBe('Skill: War Magic — 350');
  });

  it('RawSkill → same format as Skill (verifies base-vs-current is server-side only)', () => {
    expect(formatWieldRequirement(WieldRequirementType.RawSkill, 44, 250, resolvers))
      .toBe('Skill: Mana Conversion — 250');
  });

  it('Unresolved skill ID falls back to "Skill #<id>"', () => {
    expect(formatWieldRequirement(WieldRequirementType.Skill, 999, 100, resolvers))
      .toBe('Skill: Skill #999 — 100');
  });

  it('Level → "Level — <threshold>" (ignores what)', () => {
    expect(formatWieldRequirement(WieldRequirementType.Level, 0, 80, resolvers))
      .toBe('Level — 80');
  });

  it('Attrib uses PropertyAttribute 1..6 names', () => {
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 1, 250, resolvers)).toBe('Strength — 250');
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 2, 200, resolvers)).toBe('Endurance — 200');
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 3, 180, resolvers)).toBe('Quickness — 180');
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 4, 220, resolvers)).toBe('Coordination — 220');
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 5, 150, resolvers)).toBe('Focus — 150');
    expect(formatWieldRequirement(WieldRequirementType.Attrib, 6, 160, resolvers)).toBe('Self — 160');
  });

  it('RawAttrib → same name table as Attrib', () => {
    expect(formatWieldRequirement(WieldRequirementType.RawAttrib, 1, 250, resolvers)).toBe('Strength — 250');
  });

  it('SecondaryAttrib uses PropertyAttribute2nd 1/3/5 names (skips 2/4 — those are current, not max)', () => {
    // FAITHFUL.294 — labels match ACE PropertyAttribute2ndExtensions.ToSentence
    // ("Maximum Health", NOT "Max Health"). The C# fallback path even has an
    // explicit `.Replace("Max", "Maximum")` step. Pre-fix this test pinned
    // the wrong (short) labels; updated to match the canonical retail wording.
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 1, 200, resolvers)).toBe('Maximum Health — 200');
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 3, 150, resolvers)).toBe('Maximum Stamina — 150');
    expect(formatWieldRequirement(WieldRequirementType.SecondaryAttrib, 5, 180, resolvers)).toBe('Maximum Mana — 180');
  });

  it('Training: 2=Trained, 3=Specialized — threshold maps to SkillAdvancementClass', () => {
    expect(formatWieldRequirement(WieldRequirementType.Training, 34, 2, resolvers)).toBe('Trained in War Magic');
    expect(formatWieldRequirement(WieldRequirementType.Training, 34, 3, resolvers)).toBe('Specialized in War Magic');
  });

  it('Training with unexpected threshold falls back to Tier #', () => {
    expect(formatWieldRequirement(WieldRequirementType.Training, 34, 5, resolvers)).toBe('Tier 5 in War Magic');
  });

  it('CreatureType uses threshold (not what) for the CreatureType id — per ACE Player_Inventory.cs:2216', () => {
    expect(formatWieldRequirement(WieldRequirementType.CreatureType, 0, 25, resolvers))
      .toBe('CreatureType: Olthoi');
    expect(formatWieldRequirement(WieldRequirementType.CreatureType, 0, 999, resolvers))
      .toBe('CreatureType: CreatureType #999');
  });

  it('HeritageType uses threshold for the HeritageGroup id — per ACE Player_Inventory.cs:2223', () => {
    expect(formatWieldRequirement(WieldRequirementType.HeritageType, 0, 1, resolvers))
      .toBe('Heritage: Aluvian');
    expect(formatWieldRequirement(WieldRequirementType.HeritageType, 0, 3, resolvers))
      .toBe('Heritage: Sho');
  });

  it('Invalid → empty string (skip rendering the row)', () => {
    expect(formatWieldRequirement(WieldRequirementType.Invalid, 0, 0, resolvers)).toBe('');
  });

  it('IntStat / BoolStat fall through to generic format (PY16-unused per ACE)', () => {
    expect(formatWieldRequirement(WieldRequirementType.IntStat, 158, 50, resolvers)).toBe('IntStat #158 — 50');
    expect(formatWieldRequirement(WieldRequirementType.BoolStat, 99, 1, resolvers)).toBe('BoolStat #99 true');
    expect(formatWieldRequirement(WieldRequirementType.BoolStat, 99, 0, resolvers)).toBe('BoolStat #99 false');
  });

  it('Works with no resolvers — degrades to "Skill #<id>" / "Heritage #<id>" fallbacks', () => {
    expect(formatWieldRequirement(WieldRequirementType.Skill, 34, 350)).toBe('Skill: Skill #34 — 350');
    expect(formatWieldRequirement(WieldRequirementType.HeritageType, 0, 1)).toBe('Heritage: Heritage #1');
    expect(formatWieldRequirement(WieldRequirementType.CreatureType, 0, 25)).toBe('CreatureType: CreatureType #25');
  });
});
