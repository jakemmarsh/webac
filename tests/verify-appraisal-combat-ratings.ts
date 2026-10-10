/**
 * The 7 creature combat-rating PropertyInts on the examine window
 * (FAITHFUL.319).
 *
 *   307 DamageRating, 308 DamageResistRating, 313 CritRating,
 *   314 CritDamageRating, 315 CritResistRating, 316 CritDamageResistRating,
 *   323 HealingBoostRating — all `[AssessmentProperty]` (ACE PropertyInt.cs).
 *
 * These are a creature's / character's TOTAL ratings, so the EoL client
 * shows them on the creature/character page, in the misc-info list 0x10000335
 * (CreatureExamineUI::SetAppraiseInfo @ 004b3ff0, l.176496 / CharExamineUI
 * @ 004b45f0), as rows:
 *   blank, "Dmg/CritDmg" "Rating: <307>/<314>", "Dmg/CritDmg" "Resist: <308>/<316>",
 *   "DoT/Life:" "Resist: <350>/<351>", blank
 * (the "%Rating" printf format renders "Rating"; 313/315 only gate the rows;
 * HealingBoostRating is read but never shown; only values > 0 open a row).
 * The ITEM page never reads them — gear shows its Gear* ratings instead
 * (verify-appraisal-gear-pk-ratings.ts). Replaces the removed
 * showExaminePanel's invented "Damage Rating: +3" rows. Drives the shipped
 * builders (ui/examine/CreatureAppraisalText.ts, ItemAppraisalText.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildCreatureExaminePage } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

const PROFILE: NonNullable<IdentifyResponseData['creatureProfile']> = { profileFlags: 0, health: 10, healthMax: 10 };

/** The creature page's misc-info rows as "label|value" strings. */
function misc(ints: Array<[number, number]>): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, creatureProfile: PROFILE, propertiesInt: new Map(ints) };
  const page = buildCreatureExaminePage(data, { success: true });
  expect(page?.page).toBe('creature');
  return page!.miscInfo.map((r) => `${r.label}|${r.value}`);
}

describe('Examine — creature combat-rating rows (FAITHFUL.319, retail text)', () => {
  it('damage + crit-damage ratings share one "Dmg/CritDmg  Rating: D/C" row framed by blanks', () => {
    expect(misc([[PropertyInt.DamageRating, 3], [PropertyInt.CritDamageRating, 5]]))
      .toEqual(['|', 'Dmg/CritDmg|Rating: 3/5', '|']);
  });

  it('CritRating alone opens the rating row (it gates it but is not printed)', () => {
    expect(misc([[PropertyInt.CritRating, 4]])).toEqual(['|', 'Dmg/CritDmg|Rating: 0/0', '|']);
  });

  it('resist ratings give the "Resist: DR/CDR" row; CritResistRating gates it', () => {
    expect(misc([[PropertyInt.DamageResistRating, 2], [PropertyInt.CritDamageResistRating, 7]]))
      .toEqual(['|', 'Dmg/CritDmg|Resist: 2/7', '|']);
    expect(misc([[PropertyInt.CritResistRating, 6]])).toEqual(['|', 'Dmg/CritDmg|Resist: 0/0', '|']);
  });

  it('all six together: one opening blank, rating row, resist row, closing blank', () => {
    expect(misc([
      [PropertyInt.DamageRating, 3], [PropertyInt.DamageResistRating, 2], [PropertyInt.CritRating, 4],
      [PropertyInt.CritDamageRating, 5], [PropertyInt.CritResistRating, 6], [PropertyInt.CritDamageResistRating, 7],
    ])).toEqual(['|', 'Dmg/CritDmg|Rating: 3/5', 'Dmg/CritDmg|Resist: 2/7', '|']);
  });

  it('HealingBoostRating (323) is read but never shown', () => {
    expect(misc([[PropertyInt.HealingBoostRating, 3]])).toEqual([]);
  });

  it('zero or negative ratings open no row', () => {
    expect(misc([[PropertyInt.CritRating, 0], [PropertyInt.DamageRating, -2]])).toEqual([]);
  });

  it('the item page never prints the creature ratings', () => {
    const data: IdentifyResponseData = {
      guid: 0x80001111, flags: 0,
      propertiesInt: new Map([[PropertyInt.DamageRating, 3], [PropertyInt.CritRating, 3], [PropertyInt.HealingBoostRating, 3]]),
    };
    expect(buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines.filter((l) => l.text !== '')).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — 7 combat-rating PropertyInts [AssessmentProperty]', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PROPINT, 'utf8');
  });

  function pin(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('DamageRating = 307 [AssessmentProperty]', () => pin('DamageRating', 307));
  it('DamageResistRating = 308 [AssessmentProperty]', () => pin('DamageResistRating', 308));
  it('CritRating = 313 [AssessmentProperty]', () => pin('CritRating', 313));
  it('CritDamageRating = 314 [AssessmentProperty]', () => pin('CritDamageRating', 314));
  it('CritResistRating = 315 [AssessmentProperty]', () => pin('CritResistRating', 315));
  it('CritDamageResistRating = 316 [AssessmentProperty]', () => pin('CritDamageResistRating', 316));
  it('HealingBoostRating = 323 [AssessmentProperty]', () => pin('HealingBoostRating', 323));
});
