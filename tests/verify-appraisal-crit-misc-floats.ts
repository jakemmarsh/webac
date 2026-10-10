/**
 * 7 PropertyFloat combat/utility multipliers in the item appraisal body
 * (FAITHFUL.322).
 *
 * All `[AssessmentProperty]` (ACE PropertyFloat.cs):
 *   136 CriticalMultiplier, 137 ManaStoneDestroyChance, 147 CriticalFrequency,
 *   155 IgnoreArmor, 159 AbsorbMagicDamage, 100 HealkitMod, 87 ItemEfficiency.
 *
 * What the EoL client writes (ui/examine/ItemAppraisalText.ts cites each):
 *  - 136/147/155/159 are PRESENCE flags in the "Properties: …" line of
 *    Appraisal_ShowSpecialProperties @ 004b0140 — "Crushing Blow",
 *    "Biting Strike", "Armor Cleaving", "Magic Absorbing"; the value itself
 *    is never printed (so a 1.0 CriticalMultiplier still reads Crushing Blow).
 *  - 100 → Appraisal_ShowHealKitValues @ 004b25a0, healers only:
 *    "Restoration Bonus: N%" (ftol(mod·100)).
 *  - 87 / 137 → Appraisal_ShowManaStoneInfo @ 004b3900 (items without a
 *    spell list): "Efficiency: N%" / "Chance of Destruction: N%".
 * These replace the removed showExaminePanel's invented rows ("Critical Hit
 * Chance: 15.0%", "Healing Kit Bonus: +30%", …). Drives the shipped builder.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyFloat, PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalContext } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

const ACE_PROPFLOAT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPFLOAT))('ACE source pin — all 7 PropertyFloat [AssessmentProperty]', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROPFLOAT, 'utf8');
  });

  it('all 7 fields are [AssessmentProperty]', () => {
    const lines = src.split('\n');
    const assessmentSet = new Set<string>();
    let lastWasDecorator = false;
    for (const line of lines) {
      if (/\[AssessmentProperty\]/.test(line)) { lastWasDecorator = true; continue; }
      if (lastWasDecorator) {
        const m = line.match(/\s*(\w+)\s*=/);
        if (m) assessmentSet.add(m[1]);
        lastWasDecorator = false;
      }
    }
    for (const name of ['CriticalFrequency', 'CriticalMultiplier', 'IgnoreArmor',
                        'AbsorbMagicDamage', 'HealkitMod', 'ItemEfficiency',
                        'ManaStoneDestroyChance']) {
      expect(assessmentSet.has(name)).toBe(true);
    }
  });
});

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(floats: Array<[number, number]>, ctx: ItemAppraisalContext = {}, extra: Partial<IdentifyResponseData> = {}): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesFloat: new Map(floats), ...extra };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true, ...ctx }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}
const HEALER: ItemAppraisalContext = { weenie: { objectDescriptionFlags: 0x10000 } };

describe('Appraisal — crit + utility floats (FAITHFUL.322, retail text)', () => {
  it('CriticalFrequency (147) → "Properties: Biting Strike" (value not printed)', () => {
    expect(body([[PropertyFloat.CriticalFrequency, 0.15]])).toEqual(['Properties: Biting Strike']);
  });

  it('CriticalMultiplier (136) → "Properties: Crushing Blow", even at 1.0 (presence test only)', () => {
    expect(body([[PropertyFloat.CriticalMultiplier, 1.5]])).toEqual(['Properties: Crushing Blow']);
    expect(body([[PropertyFloat.CriticalMultiplier, 1.0]])).toEqual(['Properties: Crushing Blow']);
  });

  it('IgnoreArmor (155) → "Armor Cleaving"; AbsorbMagicDamage (159) → "Magic Absorbing"', () => {
    expect(body([[PropertyFloat.IgnoreArmor, 0.25]])).toEqual(['Properties: Armor Cleaving']);
    expect(body([[PropertyFloat.AbsorbMagicDamage, 0.1]])).toEqual(['Properties: Magic Absorbing']);
  });

  it('all four join in retail order on one line', () => {
    expect(body([
      [PropertyFloat.IgnoreArmor, 0.25], [PropertyFloat.CriticalFrequency, 0.15],
      [PropertyFloat.AbsorbMagicDamage, 0.1], [PropertyFloat.CriticalMultiplier, 1.5],
    ])).toEqual(['Properties: Magic Absorbing, Crushing Blow, Biting Strike, Armor Cleaving']);
  });

  it('HealkitMod (100) on a healer → "Restoration Bonus: N%" (after the skill bonus line)', () => {
    expect(body([[PropertyFloat.HealkitMod, 1.3]], HEALER)).toEqual(['Restoration Bonus: 130%']);
    expect(body([[PropertyFloat.HealkitMod, 0.7]], HEALER)).toEqual(['Restoration Bonus: 70%']);
    expect(body([[PropertyFloat.HealkitMod, 1.3]], HEALER, { propertiesInt: new Map([[PropertyInt.BoostValue, 25]]) }))
      .toEqual(['Bonus to Healing Skill: 25', 'Restoration Bonus: 130%']);
  });

  it('HealkitMod on a non-healer writes nothing (ShowHealKitValues only runs for healers)', () => {
    expect(body([[PropertyFloat.HealkitMod, 1.3]])).toEqual([]);
  });

  it('ItemEfficiency (87) → "Efficiency: N%"; ManaStoneDestroyChance (137) → "Chance of Destruction: N%"', () => {
    expect(body([[PropertyFloat.ItemEfficiency, 1.2]])).toEqual(['Efficiency: 120%']);
    expect(body([[PropertyFloat.ManaStoneDestroyChance, 0.05]])).toEqual(['Chance of Destruction: 5%']);
  });

  it('a mana stone lists Stored Mana, Efficiency, Chance of Destruction in that order', () => {
    expect(body([[PropertyFloat.ManaStoneDestroyChance, 0.05], [PropertyFloat.ItemEfficiency, 0.5]], {},
      { propertiesInt: new Map([[PropertyInt.ItemCurMana, 5000]]) }))
      .toEqual(['Stored Mana: 5000', 'Efficiency: 50%', 'Chance of Destruction: 5%']);
  });

  it('ShowManaStoneInfo is skipped when the item has a spell list', () => {
    expect(body([[PropertyFloat.ItemEfficiency, 1.2]], {}, { spellBook: [] })).toEqual([]);
  });
});
