/**
 * Caster ManaConversionMod + ElementalDamageMod in the item appraisal body
 * (FAITHFUL.305).
 *
 * Two `[AssessmentProperty]` PropertyFloat fields (ACE PropertyFloat.cs):
 *   144 = ManaConversionMod   — wire-sent on a 0 baseline (AppraiseInfo.cs;
 *                               loot rolls 0.01, 0.02 … — caster.txt)
 *   152 = ElementalDamageMod  — 1.0 baseline
 *
 * The EoL text is ItemExamineUI::Appraisal_ShowCasterData @ 004b1b10
 * (decomp l.~175010):
 *   "Bonus to Mana Conversion: " + ModifierToString(mod + 1.0) + "."  (0 decimals;
 *     printed whenever the property is present, even at 0)
 *   "Damage bonus for <DamageTypeToString(PropertyInt 45)> spells:"
 *   " vs. Monsters: " + SmallModifierToString(mod) + "."
 *   " vs. Players: "  + SmallModifierToString((mod − 1)·0.25 + 1) + "."
 *     (CombatSystem::GetElementalModPKModifier @ 005c9020; needs DamageType)
 * — not the removed showExaminePanel's "Mana Conversion Bonus: +20.0%" /
 * "Elemental Damage Bonus:" rows. Colours come from the ResistEnchantment
 * bitfield (0x1000 mana conversion, 0x2000 elemental): highlight+colour =
 * green (index 1), highlight only = red (index 2). Drives the shipped
 * builder (ui/examine/ItemAppraisalText.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyFloat, PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  buildItemAppraisalText, APPRAISAL_COLOR_ARGB, type AppraisalLine,
} from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

const ACE_PROPFLOAT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPFLOAT))('ACE source pin — caster mod PropertyFloat IDs + decorators', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROPFLOAT, 'utf8');
  });

  it('ManaConversionMod = 144, [AssessmentProperty]', () => {
    expect(src).toMatch(/ManaConversionMod\s+=\s*144/);
    const idx = src.indexOf('ManaConversionMod              = 144');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });

  it('ElementalDamageMod = 152, [AssessmentProperty]', () => {
    expect(src).toMatch(/ElementalDamageMod\s+=\s*152/);
    const idx = src.indexOf('ElementalDamageMod             = 152');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });
});

const FIRE = 0x10;
const ELECTRIC = 0x40;

/** Non-blank body lines with colours (docked page: value/burden live in header elements). */
function lines(
  floats: Array<[number, number]>, damageType?: number,
  resistEnchantment?: IdentifyResponseData['resistEnchantment'],
): AppraisalLine[] {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0,
    propertiesFloat: new Map(floats),
    propertiesInt: new Map(damageType === undefined ? [] : [[PropertyInt.DamageType, damageType]]),
    resistEnchantment,
  };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines.filter((l) => l.text !== '');
}
const text = (ls: AppraisalLine[]) => ls.map((l) => l.text);

describe('Appraisal — caster lines (FAITHFUL.305, retail text)', () => {
  it('ManaConversionMod 0.2 (0-baseline wire value) writes "Bonus to Mana Conversion: +20%."', () => {
    expect(text(lines([[PropertyFloat.ManaConversionMod, 0.2]]))).toEqual(['Bonus to Mana Conversion: +20%.']);
  });

  it('ElementalDamageMod 1.05 with DamageType Fire writes the three-line vs. Monsters / vs. Players block', () => {
    expect(text(lines([[PropertyFloat.ElementalDamageMod, 1.05]], FIRE))).toEqual([
      'Damage bonus for Fire spells:',
      ' vs. Monsters: +5.0%.',
      ' vs. Players: +1.2%.',
    ]);
  });

  it('both present: mana conversion first, then the elemental block', () => {
    expect(text(lines([[PropertyFloat.ManaConversionMod, 0.1], [PropertyFloat.ElementalDamageMod, 1.25]], ELECTRIC))).toEqual([
      'Bonus to Mana Conversion: +10%.',
      'Damage bonus for Electrical spells:',
      ' vs. Monsters: +25.0%.',
      ' vs. Players: +6.2%.',
    ]);
  });

  // BUG.appraisal-modifier-doubled-sign — ModifierToString/SmallModifierToString pick the sign themselves.
  it('debuffs carry a single "-" sign, never "+-"', () => {
    expect(text(lines([[PropertyFloat.ManaConversionMod, -0.1]]))).toEqual(['Bonus to Mana Conversion: -10%.']);
    expect(text(lines([[PropertyFloat.ElementalDamageMod, 0.9]], FIRE))).toEqual([
      'Damage bonus for Fire spells:', ' vs. Monsters: -10.0%.', ' vs. Players: -2.5%.',
    ]);
  });

  // ShowCasterData tests only that PropertyFloat 144 exists — a plain caster carrying 0 shows "+0%".
  it('ManaConversionMod 0 (the plain-caster baseline) still writes "+0%."', () => {
    expect(text(lines([[PropertyFloat.ManaConversionMod, 0]]))).toEqual(['Bonus to Mana Conversion: +0%.']);
  });

  // The elemental block needs both PropertyFloat 152 and PropertyInt 45 (DamageType).
  it('ElementalDamageMod without a DamageType writes nothing; both mods absent writes nothing', () => {
    expect(text(lines([[PropertyFloat.ElementalDamageMod, 1.05]]))).toEqual([]);
    expect(text(lines([]))).toEqual([]);
  });

  it('resistEnchantment highlight+colour 0x1000 (buff) colours the mana-conversion line green', () => {
    const ls = lines([[PropertyFloat.ManaConversionMod, 0.2]], undefined, { highlight: 0x1000, color: 0x1000 });
    expect(ls).toEqual([{ text: 'Bonus to Mana Conversion: +20%.', color: 1 }]);
    expect(APPRAISAL_COLOR_ARGB[1]).toBe(0xff00ff00);
  });

  it('resistEnchantment highlight 0x2000 without colour (debuff) colours the whole elemental block red', () => {
    const ls = lines([[PropertyFloat.ElementalDamageMod, 0.9]], FIRE, { highlight: 0x2000, color: 0 });
    expect(ls.map((l) => l.color)).toEqual([2, 2, 2]);
    expect(APPRAISAL_COLOR_ARGB[2]).toBe(0xffff0000);
  });

  it('highlight clear, or no resistEnchantment at all, leaves every line the normal colour', () => {
    for (const re of [{ highlight: 0, color: 0 }, undefined]) {
      const ls = lines([[PropertyFloat.ManaConversionMod, 0.1], [PropertyFloat.ElementalDamageMod, 1.25]], ELECTRIC, re);
      expect(ls.map((l) => l.color)).toEqual([0, 0, 0, 0]);
    }
  });

  it('each bit is isolated: a 0x1000-only highlight does not tint the elemental block', () => {
    const ls = lines([[PropertyFloat.ManaConversionMod, 0.2], [PropertyFloat.ElementalDamageMod, 1.1]], FIRE,
      { highlight: 0x1000, color: 0x1000 });
    expect(ls.map((l) => l.color)).toEqual([1, 0, 0, 0]);
  });
});
