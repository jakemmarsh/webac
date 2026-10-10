/**
 * Gear* / PK / Overpower rating PropertyInts in the item appraisal body
 * (FAITHFUL.321).
 *
 * All `[AssessmentProperty]` (ACE PropertyInt.cs): 370-379 Gear* per-item
 * ratings, 381-384 PK + GearPK damage ratings, 386-389 Overpower +
 * GearOverpower.
 *
 * The EoL client's ItemExamineUI::Appraisal_ShowRatings @ 004af080 (decomp
 * l.~173290) reads only 370-378 and 379:
 *   "Ratings: Dam N, Dam Resist N, Crit N, Crit Dam N, Crit Resist N,
 *    Crit Dam Resist N, Heal Boost N, Nether Resist N, Life Resist N."
 *   (only values > 0, in that fixed order — note Crit Dam before Crit Resist)
 *   "This item adds N Vitality."  (GearMaxHealth 379)
 * The PK / GearPK / Overpower ratings (381-389) are never read by any
 * Appraisal_Show* function, so retail shows nothing for them — the removed
 * showExaminePanel's "Gear PK Damage Rating: +3" etc. rows were invented.
 * Drives the shipped builder (ui/examine/ItemAppraisalText.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(ints: Array<[number, number]>): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints) };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

const GEAR_ENTRIES: Array<[keyof typeof PropertyInt, string]> = [
  ['GearDamage', 'Dam'],
  ['GearDamageResist', 'Dam Resist'],
  ['GearCrit', 'Crit'],
  ['GearCritDamage', 'Crit Dam'],
  ['GearCritResist', 'Crit Resist'],
  ['GearCritDamageResist', 'Crit Dam Resist'],
  ['GearHealingBoost', 'Heal Boost'],
  ['GearNetherResist', 'Nether Resist'],
  ['GearLifeResist', 'Life Resist'],
];
const UNSHOWN: Array<keyof typeof PropertyInt> = [
  'PKDamageRating', 'PKDamageResistRating', 'GearPKDamageRating', 'GearPKDamageResistRating',
  'Overpower', 'OverpowerResist', 'GearOverpower', 'GearOverpowerResist',
];

describe('Appraisal — gear ratings (FAITHFUL.321, retail text)', () => {
  it.each(GEAR_ENTRIES)('PropertyInt.%s writes "Ratings: %s N."', (prop, label) => {
    expect(body([[PropertyInt[prop] as number, 3]])).toEqual([`Ratings: ${label} 3.`]);
  });

  it('GearMaxHealth writes "This item adds N Vitality."', () => {
    expect(body([[PropertyInt.GearMaxHealth, 3]])).toEqual(['This item adds 3 Vitality.']);
  });

  it('every gear rating joins one line in ShowRatings order, then the Vitality line', () => {
    expect(body(([...GEAR_ENTRIES.map(([p]) => p), 'GearMaxHealth'] as Array<keyof typeof PropertyInt>)
      .map((p, i) => [PropertyInt[p] as number, i + 1]))).toEqual([
      'Ratings: Dam 1, Dam Resist 2, Crit 3, Crit Dam 4, Crit Resist 5, Crit Dam Resist 6, Heal Boost 7, Nether Resist 8, Life Resist 9.',
      'This item adds 10 Vitality.',
    ]);
  });

  it('zero or negative gear ratings write nothing (ShowRatings takes only values > 0)', () => {
    expect(body([[PropertyInt.GearCrit, 0]])).toEqual([]);
    expect(body([[PropertyInt.GearCrit, -2], [PropertyInt.GearMaxHealth, -1]])).toEqual([]);
  });

  it.each(UNSHOWN)('PropertyInt.%s is not read by any Appraisal_Show* — nothing is written', (prop) => {
    expect(body([[PropertyInt[prop] as number, 3]])).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — Gear*/PK/Overpower all [AssessmentProperty]', () => {
  const assessmentSet = new Set<string>();
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    const lines = readFileSync(ACE_PROPINT, 'utf8').split('\n');
    let lastWasDecorator = false;
    for (const line of lines) {
      if (/\[AssessmentProperty\]/.test(line)) { lastWasDecorator = true; continue; }
      if (lastWasDecorator) {
        const m = line.match(/\s*(\w+)\s*=/);
        if (m) assessmentSet.add(m[1]);
        lastWasDecorator = false;
      }
    }
  });

  const allRequired = [
    'GearDamage', 'GearDamageResist', 'GearCrit', 'GearCritResist',
    'GearCritDamage', 'GearCritDamageResist', 'GearHealingBoost',
    'GearNetherResist', 'GearLifeResist', 'GearMaxHealth',
    'PKDamageRating', 'PKDamageResistRating',
    'GearPKDamageRating', 'GearPKDamageResistRating',
    'Overpower', 'OverpowerResist',
    'GearOverpower', 'GearOverpowerResist',
  ];

  for (const name of allRequired) {
    it(`${name} is [AssessmentProperty]`, () => {
      expect(assessmentSet.has(name), `${name} missing from [AssessmentProperty] set`).toBe(true);
    });
  }
});
