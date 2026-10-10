/**
 * Levelable-item + heritage-armor properties in the item appraisal body
 * (FAITHFUL.320).
 *
 * `[AssessmentProperty]` fields (ACE PropertyInt.cs / PropertyInt64.cs):
 *   319 ItemMaxLevel, 320 ItemXpStyle, 324 HeritageSpecificArmor,
 *   PropertyInt64 4 ItemTotalXp (bigint), 5 ItemBaseXp.
 *
 * What the EoL client writes (not the removed showExaminePanel's invented
 * "Max Item Level: N (XP: X)" / "Heritage Locked:" rows):
 *  - ItemExamineUI::Appraisal_ShowItemLevelInfo @ 004b3c60 (decomp
 *    l.~176328), only when ItemBaseXp ≠ 0, ItemMaxLevel > 0 and
 *    ItemXpStyle > 0:
 *      "Item Level: <ItemTotalXPToLevel> / <max>"
 *      "Item XP: <total> / <xp for next level>"  (thousands commas)
 *  - Appraisal_ShowWieldRequirements @ 004af9a0: HeritageSpecificArmor →
 *    "Wield requires <AppraisalSystem::InqHeritageGroupDisplayName @ 005b4710>"
 *    — 2/5/13 hard-coded (Gharu'ndim / Umbraen / Olthoi), everything else the
 *    raw EnumMapper 0x2200000B name (so heritage 6 reads "Gearknight");
 *    no name → no line.
 * Drives the shipped builder (ui/examine/ItemAppraisalText.ts); the old
 * buildItemLevelHeritageRows helper went with the old panel.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Heritage, PropertyInt, PropertyInt64 } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalResolvers } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(ints: Array<[number, number]>, int64s: Array<[number, bigint]> = [], resolvers?: ItemAppraisalResolvers): string[] {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0, propertiesInt: new Map(ints), propertiesInt64: new Map(int64s),
  };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true, resolvers }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('Appraisal — item level (ShowItemLevelInfo, retail text)', () => {
  it('fixed-step style (1): level = total / base, next-level XP = (level + 1) · base', () => {
    expect(body(
      [[PropertyInt.ItemMaxLevel, 5], [PropertyInt.ItemXpStyle, 1]],
      [[PropertyInt64.ItemTotalXp, 1234567n], [PropertyInt64.ItemBaseXp, 1000000n]],
    )).toEqual(['Item Level: 1 / 5', 'Item XP: 1,234,567 / 2,000,000']);
  });

  it('at max level the "next" XP is the max level\'s total', () => {
    expect(body(
      [[PropertyInt.ItemMaxLevel, 2], [PropertyInt.ItemXpStyle, 1]],
      [[PropertyInt64.ItemTotalXp, 9000000n], [PropertyInt64.ItemBaseXp, 1000000n]],
    )).toEqual(['Item Level: 2 / 2', 'Item XP: 9,000,000 / 2,000,000']);
  });

  // ShowItemLevelInfo gates on ItemBaseXp != 0 && ItemMaxLevel > 0 && ItemXpStyle > 0.
  it('ItemMaxLevel + ItemTotalXp without ItemBaseXp/ItemXpStyle write nothing', () => {
    expect(body([[PropertyInt.ItemMaxLevel, 5]], [[PropertyInt64.ItemTotalXp, 1234567n]])).toEqual([]);
    expect(body([[PropertyInt.ItemMaxLevel, 0], [PropertyInt.ItemXpStyle, 1]], [[PropertyInt64.ItemBaseXp, 1000n]])).toEqual([]);
  });
});

describe('Appraisal — HeritageSpecificArmor (ShowWieldRequirements, retail text)', () => {
  const mapper: ItemAppraisalResolvers = { heritageName: (h) => ({ 1: 'Aluvian', 2: 'Gharundim', 6: 'Gearknight' } as Record<number, string>)[h] };

  it('writes "Wield requires <heritage>" with the EnumMapper name', () => {
    expect(body([[PropertyInt.HeritageSpecificArmor, Heritage.Gearknight]], [], mapper)).toEqual(['Wield requires Gearknight']);
    expect(body([[PropertyInt.HeritageSpecificArmor, 1]], [], mapper)).toEqual(['Wield requires Aluvian']);
  });

  it("2 / 5 / 13 use InqHeritageGroupDisplayName's hard-coded names over the mapper", () => {
    expect(body([[PropertyInt.HeritageSpecificArmor, 2]], [], mapper)).toEqual(["Wield requires Gharu'ndim"]);
    expect(body([[PropertyInt.HeritageSpecificArmor, 5]])).toEqual(['Wield requires Umbraen']);
    expect(body([[PropertyInt.HeritageSpecificArmor, 13]])).toEqual(['Wield requires Olthoi']);
  });

  it('an id with no display name writes nothing', () => {
    expect(body([[PropertyInt.HeritageSpecificArmor, 99]], [], mapper)).toEqual([]);
  });
});

describe.skipIf(!existsSync(PORTAL_DAT))('HeritageSpecificArmor names from the real EnumMapper 0x2200000B', () => {
  let resolvers: ItemAppraisalResolvers;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/index.js');
    const { createExamineResolvers } = await import('../packages/renderer/src/ui/examine/examineResolvers.js');
    const portalDb = openDat(PORTAL_DAT);
    resolvers = createExamineResolvers({ portalDb, spell: () => null, skillName: () => null }).item;
  });

  it('Gear Knight armor reads "Wield requires Gearknight" (raw DAT name — retail only special-cases 2/5/13)', () => {
    expect(body([[PropertyInt.HeritageSpecificArmor, Heritage.Gearknight]], [], resolvers)).toEqual(['Wield requires Gearknight']);
    expect(body([[PropertyInt.HeritageSpecificArmor, 2]], [], resolvers)).toEqual(["Wield requires Gharu'ndim"]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);
const ACE_PROPINT64 = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt64.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — ItemMaxLevel + HeritageSpecificArmor [AssessmentProperty]', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  function pin(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('ItemMaxLevel = 319 [AssessmentProperty]', () => pin('ItemMaxLevel', 319));
  it('HeritageSpecificArmor = 324 [AssessmentProperty]', () => pin('HeritageSpecificArmor', 324));
});

describe.skipIf(!aceReferenceExists(ACE_PROPINT64))('ACE source pin — ItemTotalXp [AssessmentProperty]', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => { src = readFileSync(ACE_PROPINT64, 'utf8'); });

  it('ItemTotalXp = 4 [AssessmentProperty]', () => {
    expect(src).toMatch(/ItemTotalXp\s+=\s*4/);
    const idx = src.search(/\sItemTotalXp\s+=\s*4/);
    if (idx >= 0) {
      expect(src.slice(Math.max(0, idx - 300), idx)).toMatch(/\[AssessmentProperty\]/);
    }
  });
});
