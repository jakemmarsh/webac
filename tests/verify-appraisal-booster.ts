/**
 * Booster items (potions/food) in the item appraisal body (FAITHFUL.315).
 *
 * Two `[AssessmentProperty]` PropertyInt fields (ACE PropertyInt.cs):
 *   89 = BoosterEnum   (vital: 2 Health, 4 Stamina, 6 Mana — the CURRENT
 *                        vitals of PropertyAttribute2nd; 1/3/5 are the Max*
 *                        members and never appear on booster items)
 *   90 = BoostValue    (amount per use; negative = drain)
 *
 * The EoL text is ItemExamineUI::Appraisal_ShowBoostValue @ 004b2480
 * (decomp l.~175370), which dispatches only on 2/4/6:
 *   "Restores N Health when used." / "Depletes N Health when used."
 *   "Restores N Stamina when consumed." / "Depletes N Stamina when consumed."
 *   "Restores N Mana when used." / "Depletes N Mana when used."
 * — not the removed showExaminePanel's "Restores: N Health" label/value row.
 * Any other BoosterEnum appends retail's uninitialised buffer; we write
 * nothing. Healer items (PWD flag 0x10000) skip it for
 * Appraisal_ShowHealKitValues @ 004b25a0 instead. Drives the shipped builder
 * (ui/examine/ItemAppraisalText.ts buildItemAppraisalText).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type ItemAppraisalContext } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — BoosterEnum + BoostValue [AssessmentProperty]', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROPINT, 'utf8');
  });

  it('BoosterEnum = 89 [AssessmentProperty]', () => {
    expect(src).toMatch(/BoosterEnum\s+=\s*89/);
    const idx = src.indexOf('BoosterEnum                              = 89');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });

  it('BoostValue = 90 [AssessmentProperty]', () => {
    expect(src).toMatch(/BoostValue\s+=\s*90/);
    const idx = src.indexOf('BoostValue                               = 90');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
  });
});

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(booster: number, value: number, ctx: ItemAppraisalContext = {}): string[] {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0,
    propertiesInt: new Map([[PropertyInt.BoosterEnum, booster], [PropertyInt.BoostValue, value]]),
  };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true, ...ctx }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('Appraisal — Booster line (FAITHFUL.315, retail text)', () => {
  it('BoosterEnum 2 (Health), positive value: "Restores N Health when used."', () => {
    expect(body(2, 150)).toEqual(['Restores 150 Health when used.']);
  });

  it('BoosterEnum 6 (Mana), negative value: "Depletes N Mana when used." (magnitude, no sign)', () => {
    expect(body(6, -50)).toEqual(['Depletes 50 Mana when used.']);
  });

  it('BoosterEnum 4 (Stamina): "… when consumed." (food wording)', () => {
    expect(body(4, 25)).toEqual(['Restores 25 Stamina when consumed.']);
    expect(body(4, -25)).toEqual(['Depletes 25 Stamina when consumed.']);
  });

  // ShowBoostValue @ 004b2480 has no text for any value but 2/4/6 (retail appends
  // an uninitialised buffer); 1/3/5 are the Max* vitals and must NOT read as Health.
  it('BoosterEnum outside 2/4/6 (e.g. 1 MaxHealth, 99) writes nothing', () => {
    expect(body(1, 150)).toEqual([]);
    expect(body(99, 10)).toEqual([]);
  });

  // ShowBoostValue only checks both properties exist, so a 0 boost still prints.
  it('BoostValue 0 still writes the line ("Restores 0 Health when used.")', () => {
    expect(body(2, 0)).toEqual(['Restores 0 Health when used.']);
  });

  it('a healer (PWD ObjectDescriptionFlags 0x10000) shows ShowHealKitValues instead', () => {
    expect(body(2, 150, { weenie: { objectDescriptionFlags: 0x10000 } })).toEqual(['Bonus to Healing Skill: 150']);
  });
});
