/**
 * Allegiance-rank requirement in the item appraisal body (FAITHFUL.311).
 *
 * `PropertyInt.ItemAllegianceRankLimit` (110) is decorated
 * `[AssessmentProperty]` in `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs`.
 * The EoL client shows it as the "Allegiance Rank: N" term of the one
 * "Activation requires …" line (ItemExamineUI::Appraisal_ShowActivationRequirements
 * @ 004b3270, decomp l.~175950), after the Arcane Lore term. This file drives
 * the shipped builder (ui/examine/ItemAppraisalText.ts) and pins that text.
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

describe('Appraisal — ItemAllegianceRankLimit (FAITHFUL.311, retail text)', () => {
  it('ItemAllegianceRankLimit (110) > 0 writes "Activation requires Allegiance Rank: N"', () => {
    expect(body([[PropertyInt.ItemAllegianceRankLimit, 5]])).toEqual(['Activation requires Allegiance Rank: 5']);
  });

  it('it follows the Arcane Lore term in the same line', () => {
    expect(body([[PropertyInt.ItemAllegianceRankLimit, 5], [PropertyInt.ItemDifficulty, 180]]))
      .toEqual(['Activation requires Arcane Lore: 180, Allegiance Rank: 5']);
  });

  it('nothing when the limit is 0 or absent', () => {
    expect(body([[PropertyInt.ItemAllegianceRankLimit, 0]])).toEqual([]);
    expect(body([])).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — ItemAllegianceRankLimit', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  it('ItemAllegianceRankLimit = 110 + [AssessmentProperty]', () => {
    expect(src).toMatch(/ItemAllegianceRankLimit\s+=\s*110/);
    const idx = src.indexOf('ItemAllegianceRankLimit                  = 110');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });
});
