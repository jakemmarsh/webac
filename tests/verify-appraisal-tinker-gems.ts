/**
 * Tinkering + gem properties in the item appraisal (FAITHFUL.301).
 *
 * Four `[AssessmentProperty]` PropertyInt fields (per
 * `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs`):
 *
 *   170 = NumItemsInMaterial   — # of salvage bags used to forge the item
 *   171 = NumTimesTinkered     — total tinkering operations applied
 *   177 = GemCount             — # of gems set in this jewelry/clothing
 *   178 = GemType              — MaterialType enum value of the gem
 *
 * Now verifies the end-of-retail sentences the shipped builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts` writes (the old
 * invented "Times Tinkered" / "Items In Material" / "Gems Set: N × gem"
 * label rows are not retail):
 *  - Appraisal_ShowTinkeringInfo @ 004b0e70: "This item has been tinkered
 *    N time(s)."; NumItemsInMaterial divides the workmanship into an average
 *    ("Workmanship: <adj> (avg)") and adds "Salvaged from N items.".
 *  - Appraisal_ShowDescription @ 004b6990: with AppraisalLongDescDecoration
 *    bit 0x4, the long description ends ", set with N <gem>" — the single
 *    gem name, or InqPluralizedGemName @ 005b5800's plural.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt, getMaterialName } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');
const LONG_DESC = 16;

function body(ints: Array<[number, number]>, longDesc?: string): string {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0, propertiesInt: new Map(ints),
    ...(longDesc !== undefined ? { propertiesString: new Map([[LONG_DESC, longDesc]]) } : {}),
  };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true, resolvers: { materialName: (m) => getMaterialName(m) } }).text;
}

describe('Tinkering (FAITHFUL.301, Appraisal_ShowTinkeringInfo @ 004b0e70)', () => {
  it('NumTimesTinkered → "This item has been tinkered N time(s)."', () => {
    expect(body([[PropertyInt.NumTimesTinkered, 1]]).split('\n')[0]).toBe('This item has been tinkered 1 time.');
    expect(body([[PropertyInt.NumTimesTinkered, 2]]).split('\n')[0]).toBe('This item has been tinkered 2 times.');
  });

  it('NumItemsInMaterial averages the workmanship and adds "Salvaged from N items."', () => {
    const lines = body([[PropertyInt.ItemWorkmanship, 30], [PropertyInt.NumItemsInMaterial, 6]]).split('\n');
    expect(lines.slice(0, 3)).toEqual(['Workmanship: Magnificent (5.00)', '', 'Salvaged from 6 items.']);
  });

  it('without NumItemsInMaterial the workmanship is shown as-is and no salvage line is written', () => {
    const text = body([[PropertyInt.ItemWorkmanship, 5]]);
    expect(text.split('\n')[0]).toBe('Workmanship: Magnificent (5)');
    expect(text).not.toContain('Salvaged from');
  });

  it('no tinker properties → no tinkering sentences, and none of the old invented labels', () => {
    const text = body([]);
    expect(text).not.toContain('tinkered');
    expect(text).not.toContain('Salvaged');
    for (const l of ['Times Tinkered', 'Items In Material', 'Gems Set']) expect(text).not.toContain(l);
  });
});

describe('Gems in the decorated description (FAITHFUL.301, Appraisal_ShowDescription @ 004b6990)', () => {
  const RUBY = 38;
  const AGATE = 15;

  it('GemCount + GemType end the description with ", set with N <plural gem>"', () => {
    expect(getMaterialName(RUBY)).toBe('Ruby');
    const text = body([[PropertyInt.GemCount, 3], [PropertyInt.GemType, RUBY], [PropertyInt.AppraisalLongDescDecoration, 0x4]], 'Necklace');
    expect(text.split('\n').at(-1)).toBe('Necklace, set with 3 Rubies');
  });

  it('one gem uses the singular material name', () => {
    const text = body([[PropertyInt.GemCount, 1], [PropertyInt.GemType, AGATE], [PropertyInt.AppraisalLongDescDecoration, 0x4]], 'Ring');
    expect(text.split('\n').at(-1)).toBe(`Ring, set with 1 ${getMaterialName(AGATE)}`);
  });

  it('without decoration bit 0x4 the gems are not named', () => {
    const text = body([[PropertyInt.GemCount, 3], [PropertyInt.GemType, RUBY], [PropertyInt.AppraisalLongDescDecoration, 0x1]], 'Necklace');
    expect(text).not.toContain('set with');
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — 4 PropertyInt IDs all [AssessmentProperty]', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  function checkValueAndDecorator(name: string, value: number) {
    expect(src, `${name} = ${value} value`).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.indexOf(`${name.padEnd(40, ' ')}= ${value}`);
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 200), idx);
      expect(window, `${name} missing [AssessmentProperty]`).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('NumItemsInMaterial = 170, [AssessmentProperty]', () => {
    checkValueAndDecorator('NumItemsInMaterial', 170);
  });
  it('NumTimesTinkered = 171, [AssessmentProperty]', () => {
    checkValueAndDecorator('NumTimesTinkered', 171);
  });
  it('GemCount = 177, [AssessmentProperty]', () => {
    checkValueAndDecorator('GemCount', 177);
  });
  it('GemType = 178, [AssessmentProperty]', () => {
    checkValueAndDecorator('GemType', 178);
  });
});
