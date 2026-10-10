/**
 * Activation difficulty in the item appraisal body (FAITHFUL.303).
 *
 * `PropertyInt.ItemDifficulty` (109) is decorated `[AssessmentProperty]`
 * in `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs`.
 * The EoL client shows it as the Arcane Lore term of the single
 * "Activation requires …" line written by
 * ItemExamineUI::Appraisal_ShowActivationRequirements @ 004b3270 (decomp
 * l.~175950) — NOT as an "Activation Difficulty: N" row (that label was
 * invented by the removed showExaminePanel). This file drives the shipped
 * builder (ui/examine/ItemAppraisalText.ts buildItemAppraisalText) and pins
 * that exact retail text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalContext } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

/**
 * The non-blank body lines retail writes for `ints`. Docked-page mode puts
 * value/burden in their own header elements, so the body holds only the
 * section under test.
 */
function body(ints: Array<[number, number]>, ctx: ItemAppraisalContext = {}): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints) };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true, ...ctx }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('Appraisal — ItemDifficulty in "Activation requires" (FAITHFUL.303, retail text)', () => {
  it('ItemDifficulty (109) > 0 writes "Activation requires Arcane Lore: N"', () => {
    expect(body([[PropertyInt.ItemDifficulty, 250]])).toEqual(['Activation requires Arcane Lore: 250']);
  });

  it('it is the first term of the one comma-joined requirements line', () => {
    expect(body([[PropertyInt.ItemDifficulty, 250], [PropertyInt.ItemAllegianceRankLimit, 5]]))
      .toEqual(['Activation requires Arcane Lore: 250, Allegiance Rank: 5']);
  });

  it('ItemDifficulty 0 or absent writes nothing', () => {
    expect(body([[PropertyInt.ItemDifficulty, 0]])).toEqual([]);
    expect(body([])).toEqual([]);
  });

  it('a failed appraisal skips the whole section (ShowActivationRequirements runs only on success)', () => {
    expect(body([[PropertyInt.ItemDifficulty, 250]], { appraisalSuccess: false })).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — PropertyInt.ItemDifficulty', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  it('ItemDifficulty = 109, [AssessmentProperty]', () => {
    expect(src).toMatch(/ItemDifficulty\s+=\s*109/);
    const idx = src.indexOf('ItemDifficulty                           = 109');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });
});
