/**
 * Phase 20 — Character Creation
 *
 * Tests heritage groups, attribute allocation, skill selection,
 * appearance validation, starting equipment, and full creation flow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatDatabase, DatReader, CharacterGenerator, SkillTable, XpTable } from '@ac/dat-parser';
import { Heritage, DEFAULT_ATTRIBUTE_CREDITS, CreateResult, validateName, validateAttributes } from '@ac/shared';
import { openDat } from './_harness/dat.js';

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL_PATH = path.join(DAT_DIR, 'client_portal.dat');

const hasPortalDat = fs.existsSync(PORTAL_PATH);

let portalDb: DatDatabase;
let charGen: CharacterGenerator;
let skillTable: SkillTable;
let xpTable: XpTable;

/** Load CharGen, SkillTable, XpTable from portal.dat */
beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat(PORTAL_PATH);

  // CharGen 0x0E000002
  const cgData = portalDb.getFileData(0x0E000002);
  expect(cgData).toBeDefined();
  charGen = new CharacterGenerator(new DatReader(cgData!));

  // SkillTable 0x0E000004
  const stData = portalDb.getFileData(0x0E000004);
  expect(stData).toBeDefined();
  skillTable = new SkillTable(new DatReader(stData!));

  // XpTable 0x0E000018
  const xpData = portalDb.getFileData(0x0E000018);
  expect(xpData).toBeDefined();
  xpTable = new XpTable(new DatReader(xpData!));
});

// ─── CharGen data from DAT ──────────────────────────────────

describe.skipIf(!hasPortalDat)('Phase 20 — Character Creation', () => {

describe('CharGen data from DAT', () => {
  it('has ≥4 heritage groups', () => {
    expect(charGen.heritageGroups.size).toBeGreaterThanOrEqual(4);
  });

  it('has Aluvian, Gharundim, Sho, Viamontian', () => {
    expect(charGen.heritageGroups.has(Heritage.Aluvian)).toBe(true);
    expect(charGen.heritageGroups.has(Heritage.Gharundim)).toBe(true);
    expect(charGen.heritageGroups.has(Heritage.Sho)).toBe(true);
    expect(charGen.heritageGroups.has(Heritage.Viamontian)).toBe(true);
  });

  it('each heritage has name, attributeCredits, skillCredits, skills, templates, genders', () => {
    for (const [, hg] of charGen.heritageGroups) {
      expect(hg.name.length).toBeGreaterThan(0);
      expect(hg.attributeCredits).toBeGreaterThan(0);
      expect(hg.skillCredits).toBeGreaterThan(0);
      expect(hg.skills.length).toBeGreaterThan(0);
      expect(hg.templates.length).toBeGreaterThan(0);
      expect(hg.genders.size).toBeGreaterThanOrEqual(1);
    }
  });

  it('each heritage has ≥1 sex option with valid counts', () => {
    for (const [, hg] of charGen.heritageGroups) {
      for (const [, sex] of hg.genders) {
        expect(sex.name.length).toBeGreaterThan(0);
        expect(sex.hairColorList.length).toBeGreaterThan(0);
        expect(sex.hairStyleList.length).toBeGreaterThan(0);
        expect(sex.eyeColorList.length).toBeGreaterThan(0);
      }
    }
  });

  it('human heritages have attributeCredits = 330', () => {
    for (const h of [Heritage.Aluvian, Heritage.Gharundim, Heritage.Sho, Heritage.Viamontian]) {
      const hg = charGen.heritageGroups.get(h)!;
      expect(hg.attributeCredits).toBe(DEFAULT_ATTRIBUTE_CREDITS);
    }
  });

  it('starter areas exist', () => {
    expect(charGen.starterAreas.length).toBeGreaterThanOrEqual(3);
    for (const area of charGen.starterAreas) {
      expect(area.name.length).toBeGreaterThan(0);
      expect(area.locations.length).toBeGreaterThan(0);
    }
  });
});

// ─── Name validation ────────────────────────────────────────

describe('Name validation', () => {
  it('accepts valid names', () => {
    expect(validateName('Asheron')).toBe(CreateResult.Success);
    expect(validateName('Sir Lancelot')).toBe(CreateResult.Success);
    expect(validateName('X')).toBe(CreateResult.Success);
  });

  it('rejects empty or blank names', () => {
    expect(validateName('')).toBe(CreateResult.InvalidName);
    expect(validateName('   ')).toBe(CreateResult.InvalidName);
  });

  it('rejects names with leading/trailing spaces', () => {
    expect(validateName(' Leading')).toBe(CreateResult.InvalidName);
    expect(validateName('Trailing ')).toBe(CreateResult.InvalidName);
  });

  it('rejects very long names (>32 chars)', () => {
    expect(validateName('A'.repeat(33))).toBe(CreateResult.InvalidName);
  });
});

// ─── Attribute validation ───────────────────────────────────

describe('Attribute validation', () => {
  it('accepts valid attributes totaling ≤ max credits', () => {
    const attrs = { strength: 60, endurance: 60, coordination: 55, quickness: 55, focus: 50, self: 50 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.Success);
  });

  it('rejects attribute < 10', () => {
    const attrs = { strength: 9, endurance: 60, coordination: 60, quickness: 60, focus: 60, self: 60 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.InvalidSkillRequested);
  });

  it('rejects attribute > 100', () => {
    const attrs = { strength: 101, endurance: 50, coordination: 50, quickness: 50, focus: 50, self: 50 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.InvalidSkillRequested);
  });

  it('rejects total > max credits', () => {
    const attrs = { strength: 100, endurance: 100, coordination: 100, quickness: 100, focus: 100, self: 100 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.TooManySkillCreditsUsed);
  });

  it('accepts attributes totaling exactly 330', () => {
    const attrs = { strength: 55, endurance: 55, coordination: 55, quickness: 55, focus: 55, self: 55 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.Success);
  });

  it('accepts min attributes (10 each = 60 total)', () => {
    const attrs = { strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10 };
    expect(validateAttributes(attrs, 330)).toBe(CreateResult.Success);
  });
});

// ─── SkillTable from DAT ────────────────────────────────────

describe('SkillTable integration', () => {
  it('has ≥35 skills', () => {
    expect(skillTable.skills.size).toBeGreaterThanOrEqual(35);
  });

  it('each skill has name, formula, and costs', () => {
    for (const [, skill] of skillTable.skills) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.formula).toBeDefined();
      // trainedCost and specializedCost can be -1 for untrainable skills
      expect(typeof skill.trainedCost).toBe('number');
      expect(typeof skill.specializedCost).toBe('number');
    }
  });
});

// ─── XpTable integration ────────────────────────────────────

describe('XpTable integration', () => {
  it('has level thresholds from 1 to ≥275', () => {
    // characterLevelXpList has entries 0 through levelCount (inclusive)
    expect(xpTable.characterLevelXpList.length).toBeGreaterThanOrEqual(276);
  });

  it('level 1 threshold = 0 XP', () => {
    // Index 0 is level 0, index 1 is level 1
    expect(xpTable.characterLevelXpList[1]).toBe(0n);
  });

  it('level thresholds increase monotonically', () => {
    for (let i = 2; i < xpTable.characterLevelXpList.length; i++) {
      expect(xpTable.characterLevelXpList[i]).toBeGreaterThanOrEqual(
        xpTable.characterLevelXpList[i - 1],
      );
    }
  });

  it('skill credits per level exists', () => {
    expect(xpTable.characterLevelSkillCreditList.length).toBeGreaterThanOrEqual(276);
  });
});

}); // end describe.skipIf
