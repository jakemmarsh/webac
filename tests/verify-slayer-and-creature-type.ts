/**
 * Slayer property + CreatureType wield requirement in the item appraisal
 * (FAITHFUL.307).
 *
 *  - PropertyInt.SlayerCreatureType (166, [AssessmentProperty]) marks a
 *    slayer weapon (PropertyFloat.SlayerDamageBonus 138 is its multiplier).
 *  - WieldRequirementType.CreatureType (11) gates wielding on the wielder's
 *    creature type (WieldDifficulty = the CreatureType).
 *
 * Now verifies the end-of-retail text from the shipped builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts`, with the
 * CreatureType names resolved like main.ts does (EnumMapper 0x2200000E via
 * createExamineResolvers; AppraisalSystem::InqCreatureDisplayName @ 005b59e0
 * turns every "_" into " "):
 *  - Appraisal_ShowSpecialProperties @ 004b0140 lists "<Creature> slayer"
 *    in the "Properties:" line (type 0x1F = "Bael'Zharon's Hate"). Retail
 *    shows no damage-bonus percentage and nothing for an unmapped type — the
 *    old invented "Slayer: <Type> (+N% damage)" / "CreatureType #N" row is
 *    gone.
 *  - Appraisal_ShowWieldRequirements @ 004af9a0 (via
 *    GetAppraisalStringFromRequirements @ 004acac0) writes
 *    "Wield requires <Creature> type".
 * The @ac/shared creatureTypeName / formatWieldRequirement pins are kept.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { creatureTypeName, CreatureType, formatWieldRequirement, WieldRequirementType, PropertyInt, PropertyFloat } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalResolvers } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { createExamineResolvers } from '../packages/renderer/src/ui/examine/examineResolvers.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

/** EnumMapper 0x2200000E raw names (underscored, as in the DAT). */
const CREATURE_ENUM: Record<number, string> = { 1: 'Olthoi', 35: 'Olthoi_Larvae', 0x1f: 'Bael_Zharon' };
const resolvers: ItemAppraisalResolvers = { creatureTypeName: (id) => CREATURE_ENUM[id] ?? null };

function body(data: Partial<IdentifyResponseData>, r: ItemAppraisalResolvers = resolvers): string {
  return buildItemAppraisalText({ guid: 0x80001111, flags: 0, ...data }, { hasValueBurdenElements: true, resolvers: r }).text;
}

describe('creatureTypeName helper (FAITHFUL.307)', () => {
  it('Olthoi (1) → "Olthoi"', () => expect(creatureTypeName(1)).toBe('Olthoi'));
  it('Banderling (2) → "Banderling"', () => expect(creatureTypeName(2)).toBe('Banderling'));
  it('OlthoiLarvae (35) → "Olthoi Larvae" (space-inserted)', () => {
    expect(creatureTypeName(35)).toBe('Olthoi Larvae');
  });
  it('EnchantedArms (87) → "Enchanted Arms"', () => {
    expect(creatureTypeName(87)).toBe('Enchanted Arms');
  });
  it('GearKnight (99) → "Gear Knight"', () => {
    expect(creatureTypeName(99)).toBe('Gear Knight');
  });
  it('Invalid (0) → null', () => expect(creatureTypeName(0)).toBeNull());
  it('Unknown ID → null', () => expect(creatureTypeName(9999)).toBeNull());
  it('matches CreatureType enum membership', () => {
    // For every named CreatureType the helper should return a non-null label.
    for (const k of Object.keys(CreatureType)) {
      if (/^\d+$/.test(k)) continue; // skip numeric reverse-mapping keys
      if (k === 'Invalid') continue;
      const id = (CreatureType as any)[k];
      expect(creatureTypeName(id), `${k}=${id} returned null`).not.toBeNull();
    }
  });
});

describe('Appraisal — slayer property + CreatureType wield requirement (FAITHFUL.307)', () => {
  it('SlayerCreatureType names "<Creature> slayer" in the Properties line, underscores → spaces', () => {
    const text = body({
      propertiesInt: new Map([[PropertyInt.SlayerCreatureType, 35]]),
      propertiesFloat: new Map([[PropertyFloat.SlayerDamageBonus, 1.5]]),
    });
    expect(text.split('\n')).toContain('Properties: Olthoi Larvae slayer');
  });

  it("retail shows no slayer damage-bonus percentage", () => {
    const text = body({
      propertiesInt: new Map([[PropertyInt.SlayerCreatureType, 1]]),
      propertiesFloat: new Map([[PropertyFloat.SlayerDamageBonus, 1.5]]),
    });
    expect(text.split('\n')).toContain('Properties: Olthoi slayer');
    expect(text).not.toContain('%');
    expect(text).not.toContain('Slayer:');
  });

  it("creature type 0x1F is Bael'Zharon's Hate", () => {
    expect(body({ propertiesInt: new Map([[PropertyInt.SlayerCreatureType, 0x1f]]) }).split('\n')).toContain("Properties: Bael'Zharon's Hate");
  });

  it('an unmapped creature type writes no slayer text (no "CreatureType #N" fallback)', () => {
    const text = body({ propertiesInt: new Map([[PropertyInt.SlayerCreatureType, 9999]]) });
    expect(text).not.toContain('slayer');
    expect(text).not.toContain('CreatureType');
    expect(text).not.toContain('Properties:');
  });

  it('a CreatureType wield requirement reads "Wield requires <Creature> type"', () => {
    const text = body({
      propertiesInt: new Map([
        [PropertyInt.WieldRequirements, WieldRequirementType.CreatureType],
        [PropertyInt.WieldSkillType, 0],
        [PropertyInt.WieldDifficulty, 1],
      ]),
    });
    expect(text.split('\n')).toContain('Wield requires Olthoi type');
  });
});

describe.skipIf(!existsSync(PORTAL_DAT))('DAT EnumMapper 0x2200000E names match the ACE CreatureType names', () => {
  let text = '';
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/index.js');
    const portalDb = openDat(PORTAL_DAT);
    const r = createExamineResolvers({ portalDb, spell: () => null, skillName: () => null });
    text = body({ propertiesInt: new Map([[PropertyInt.SlayerCreatureType, 35]]) }, r.item);
  }, 120_000);

  it('the live resolver renders "Olthoi Larvae slayer" (= @ac/shared creatureTypeName(35))', () => {
    expect(text.split('\n')).toContain(`Properties: ${creatureTypeName(35)} slayer`);
  });
});

describe('formatWieldRequirement — CreatureType resolver (FAITHFUL.307)', () => {
  it('formatWieldRequirement with CreatureType + resolver returns full name', () => {
    const result = formatWieldRequirement(
      WieldRequirementType.CreatureType,
      0,
      1, // Olthoi
      { creatureTypeName: (id) => creatureTypeName(id) },
    );
    expect(result).toBe('CreatureType: Olthoi');
  });

  it('formatWieldRequirement WITHOUT resolver still falls back to CreatureType #N (pre-FAITHFUL.307 shape)', () => {
    const result = formatWieldRequirement(WieldRequirementType.CreatureType, 0, 1);
    expect(result).toBe('CreatureType: CreatureType #1');
  });
});

const ACE_CREATURE_TYPE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/CreatureType.cs',
);

describe.skipIf(!aceReferenceExists(ACE_CREATURE_TYPE))('ACE source pin — CreatureType enum order', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_CREATURE_TYPE, 'utf8'); });

  it('ACE uses implicit enumeration starting at Invalid=0 / Olthoi=1', () => {
    // Members appear in order: Invalid, Olthoi, Banderling, Drudge, ...
    // Parse the C# enum body and check the order.
    const m = src.match(/enum CreatureType\s*:\s*uint\s*\{([\s\S]+?)\}/);
    expect(m).not.toBeNull();
    const members = m![1]
      .split('\n')
      .map((l) => l.trim().split(/\s|,/)[0])
      .filter((s) => /^[A-Z]\w+$/.test(s));
    expect(members[0]).toBe('Invalid');
    expect(members[1]).toBe('Olthoi');
    expect(members[2]).toBe('Banderling');
    expect(members[3]).toBe('Drudge');
    // Spot-check some later members exist (exact index depends on file
    // edits, so just verify presence).
    expect(members).toContain('OlthoiLarvae');
    expect(members).toContain('EnchantedArms');
    expect(members).toContain('GearKnight');
  });
});
