/**
 * Material type in the item appraisal (FAITHFUL.300).
 *
 * `PropertyInt.MaterialType` (131) is `[AssessmentProperty]` in
 * `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs`, so the
 * server sends it on appraisal. The end-of-retail client has NO standalone
 * "Material:" line: it names the material only by decorating the long
 * description — Appraisal_ShowDescription @ 004b6990 (buildItemAppraisalText),
 * when PropertyInt 172 AppraisalLongDescDecoration is present, prefixes the
 * MaterialTypeEnumMapper name (and the workmanship adjective for bit 0x1),
 * removing a copy of the name already in the description.
 *
 * Now verifies the shipped pure builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts` with the real
 * `getMaterialName` (@ac/shared, mirrors ACE `MaterialType`) as its
 * material resolver.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalContext } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMaterialName, PropertyInt } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);
const ACE_MATERIAL = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs',
);

const LONG_DESC = 16;
const ctx: ItemAppraisalContext = { hasValueBurdenElements: true, resolvers: { materialName: (m) => getMaterialName(m) } };
const item = (ints: Array<[number, number]>, longDesc?: string): IdentifyResponseData => ({
  guid: 0x80001111, flags: 0, propertiesInt: new Map(ints),
  ...(longDesc !== undefined ? { propertiesString: new Map([[LONG_DESC, longDesc]]) } : {}),
});
const body = (d: IdentifyResponseData) => buildItemAppraisalText(d, ctx).text;

describe('Appraisal — material in the decorated long description (FAITHFUL.300, Appraisal_ShowDescription @ 004b6990)', () => {
  it('AppraisalLongDescDecoration names the material before the description', () => {
    const lines = body(item([[PropertyInt.MaterialType, 1], [PropertyInt.AppraisalLongDescDecoration, 0x2]], 'Bowl')).split('\n');
    expect(lines.at(-1)).toBe(`${getMaterialName(1)} Bowl`);
    expect(lines.at(-1)).toBe('Ceramic Bowl');
  });

  it('a material name already in the description is not doubled', () => {
    const gold = 60;
    expect(getMaterialName(gold)).toBe('Gold');
    const text = body(item([[PropertyInt.MaterialType, gold], [PropertyInt.AppraisalLongDescDecoration, 0x2]], 'Gold Ring'));
    expect(text.split('\n').at(-1)).toBe('Gold Ring');
  });

  it('decoration bit 0x1 puts the workmanship adjective before the material', () => {
    const text = body(item([
      [PropertyInt.ItemWorkmanship, 6], [PropertyInt.MaterialType, 1], [PropertyInt.AppraisalLongDescDecoration, 0x1 | 0x2],
    ], 'Bowl'));
    expect(text.split('\n').at(-1)).toBe('Nearly flawless Ceramic Bowl');
  });

  it('material 0 / absent / no decoration flag adds no material text', () => {
    expect(body(item([[PropertyInt.MaterialType, 0], [PropertyInt.AppraisalLongDescDecoration, 0x2]], 'Bowl')).split('\n').at(-1)).toBe('Bowl');
    expect(body(item([[PropertyInt.AppraisalLongDescDecoration, 0x2]], 'Bowl')).split('\n').at(-1)).toBe('Bowl');
    expect(body(item([[PropertyInt.MaterialType, 1]], 'Bowl')).split('\n').at(-1)).toBe('Bowl');
  });

  it('retail has no standalone "Material:" line (the old invented row)', () => {
    // ItemExamineUI::SetAppraiseInfo @ 004b72b0 never emits a material label.
    const text = body(item([[PropertyInt.ItemWorkmanship, 7], [PropertyInt.MaterialType, 1], [PropertyInt.Value, 100]]));
    expect(text).not.toMatch(/Material/);
    expect(text).toContain('Workmanship: Flawless (7)');
  });
});

describe('getMaterialName canonical sample values (FAITHFUL.300 anchor)', () => {
  // Spot-pin the canonical material names so a regression in the table
  // (e.g. someone renames Steel to Iron) surfaces here as well as in
  // the underlying MaterialTypes test.
  it('Steel (1) → "Ceramic"', () => {
    // Per reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs the
    // first enum entry is "Ceramic = 1". Verifying our table starts there.
    expect(getMaterialName(1)).toBe('Ceramic');
  });
  it('returns a string for at least 10 known IDs (not all "Unknown")', () => {
    const knowns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(getMaterialName);
    const namedCount = knowns.filter((n) => n && n !== 'Unknown').length;
    expect(namedCount).toBeGreaterThanOrEqual(10);
  });
});

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — PropertyInt.MaterialType = 131 + [AssessmentProperty]', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  it('MaterialType = 131 in PropertyInt enum', () => {
    expect(src).toMatch(/MaterialType\s+=\s*131/);
  });

  it('has [AssessmentProperty] decorator above MaterialType', () => {
    const idx = src.indexOf('MaterialType                             = 131');
    expect(idx).toBeGreaterThan(0);
    const window = src.slice(Math.max(0, idx - 200), idx);
    expect(window).toMatch(/\[AssessmentProperty\]/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_MATERIAL))('ACE source pin — MaterialType enum has known canonical values', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_MATERIAL, 'utf8'); });

  it('Ceramic = 0x00000001 is the first non-Unknown material value', () => {
    // ACE source uses 0x00000001 (8-digit hex) for the enum members.
    expect(src).toMatch(/Ceramic\s*=\s*0x0+1\b/);
  });
});
