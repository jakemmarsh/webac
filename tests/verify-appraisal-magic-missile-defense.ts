/**
 * Melee / Missile / Magic defense bonuses in the item appraisal body
 * (FAITHFUL.299).
 *
 * PropertyFloat 29 WeaponDefense, 149 WeaponMissileDefense, 150
 * WeaponMagicDefense (ACE PropertyFloat.cs; AppraiseInfo.cs post-processes
 * 149/150 for ImbueStackingBits and otherwise sends plain floats).
 *
 * The EoL text is ItemExamineUI::Appraisal_ShowDefenseModData @ 004b1df0
 * (decomp l.~175090): for each value present and ≠ 1.0, in melee, missile,
 * magic order,
 *   "Bonus to <Melee|Missile|Magic> Defense: " + SmallModifierToString(v) + "."
 * (SmallModifierToString @ 004ab240 = "%c%.1lf%%", sign from v < 1.0 — so a
 * debuff reads "-10.0%", never "+-10.0%"). Only the melee line takes an
 * enchantment colour (WeaponEnchantment bit 0x2). Drives the shipped builder
 * (ui/examine/ItemAppraisalText.ts) — the removed showExaminePanel's
 * label/value rows lacked the trailing ".".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyFloat } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type AppraisalLine } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

const ACE_PROPFLOAT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs',
);
const ACE_APPRAISE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Structure/AppraiseInfo.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPFLOAT))('ACE-source pin — PropertyFloat IDs 29/149/150', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROPFLOAT, 'utf8');
  });

  it('WeaponDefense = 29', () => {
    expect(src).toMatch(/WeaponDefense\s+=\s*29/);
  });
  it('WeaponMissileDefense = 149', () => {
    expect(src).toMatch(/WeaponMissileDefense\s+=\s*149/);
  });
  it('WeaponMagicDefense = 150', () => {
    expect(src).toMatch(/WeaponMagicDefense\s+=\s*150/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_APPRAISE))('ACE-source pin — AppraiseInfo post-processes both defenses', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_APPRAISE, 'utf8');
  });

  it('post-processes WeaponMagicDefense for ImbueStackingBits edge case', () => {
    expect(src).toMatch(/WeaponMagicDefense[\s\S]*ImbueStackingBits/);
  });
  it('post-processes WeaponMissileDefense for ImbueStackingBits edge case', () => {
    expect(src).toMatch(/WeaponMissileDefense[\s\S]*ImbueStackingBits/);
  });
});

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function lines(floats: Array<[number, number]>, weaponEnchantment?: IdentifyResponseData['weaponEnchantment']): AppraisalLine[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesFloat: new Map(floats), weaponEnchantment };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines.filter((l) => l.text !== '');
}
const body = (floats: Array<[number, number]>) => lines(floats).map((l) => l.text);

describe('Appraisal — weapon defense bonus lines (FAITHFUL.299, retail text)', () => {
  it('WeaponDefense 1.1 writes "Bonus to Melee Defense: +10.0%."', () => {
    expect(body([[PropertyFloat.WeaponDefense, 1.1]])).toEqual(['Bonus to Melee Defense: +10.0%.']);
  });

  it('all three present: melee, missile, then magic', () => {
    expect(body([
      [PropertyFloat.WeaponMagicDefense, 1.15],
      [PropertyFloat.WeaponMissileDefense, 1.1],
      [PropertyFloat.WeaponDefense, 1.05],
    ])).toEqual([
      'Bonus to Melee Defense: +5.0%.',
      'Bonus to Missile Defense: +10.0%.',
      'Bonus to Magic Defense: +15.0%.',
    ]);
  });

  it('values at the 1.0 default (or absent) write nothing', () => {
    expect(body([
      [PropertyFloat.WeaponDefense, 1.0], [PropertyFloat.WeaponMissileDefense, 1.0], [PropertyFloat.WeaponMagicDefense, 1.0],
    ])).toEqual([]);
    expect(body([])).toEqual([]);
  });

  it('WeaponMissileDefense 0.9 (debuff) writes "Bonus to Missile Defense: -10.0%.", not "+-10.0%"', () => {
    expect(body([[PropertyFloat.WeaponMissileDefense, 0.9]])).toEqual(['Bonus to Missile Defense: -10.0%.']);
  });

  it('WeaponEnchantment bit 0x2 colours only the melee line (green when raised, red when lowered)', () => {
    const floats: Array<[number, number]> = [[PropertyFloat.WeaponDefense, 1.1], [PropertyFloat.WeaponMagicDefense, 1.1]];
    expect(lines(floats, { highlight: 0x2, color: 0x2 }).map((l) => l.color)).toEqual([1, 0]);
    expect(lines(floats, { highlight: 0x2, color: 0 }).map((l) => l.color)).toEqual([2, 0]);
    expect(lines(floats).map((l) => l.color)).toEqual([0, 0]);
  });
});
