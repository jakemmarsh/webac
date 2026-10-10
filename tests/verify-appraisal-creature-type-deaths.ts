/**
 * CreatureType + NumDeaths on the examine window (FAITHFUL.313).
 *
 * Two `[AssessmentProperty]` PropertyInt fields (ACE PropertyInt.cs):
 *    2 = CreatureType, 43 = NumDeaths.
 *
 * Retail (decompiled EoL client) has no "Creature Type:" / "Deaths:" rows on
 * a generic panel (the removed showExaminePanel's invention):
 *  - CreatureType → the creature header text 0x1000014e,
 *    AppraisalSystem::InqCreatureDisplayName @ 005b59e0 (EnumMapper
 *    0x2200000E name with every "_" → " "); no mapper entry = element not
 *    touched (CreatureExamineUI::SetAppraiseInfo @ 004b3ff0).
 *  - NumDeaths → only the CHARACTER page's misc list: "Deaths:" + N, or
 *    "Has never died" when < 1 (CharExamineUI::SetAppraiseInfo @ 004b45f0).
 *    The creature page and the item page never show it.
 * Drives the shipped builders (ui/examine/CreatureAppraisalText.ts,
 * ItemAppraisalText.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt, PropertyString } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildCreatureExaminePage } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

const PROFILE: NonNullable<IdentifyResponseData['creatureProfile']> = { profileFlags: 0, health: 10, healthMax: 10 };
/** EnumMapper 0x2200000E stand-in: raw DAT names keep their underscores. */
const creatureTypeEnumName = (ct: number) => (ct === 1 ? 'Olthoi_Larvae' : null);

function page(ints: Array<[number, number]>, strings: Array<[number, string]> = []) {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0, creatureProfile: PROFILE,
    propertiesInt: new Map(ints), propertiesString: new Map(strings),
  };
  return buildCreatureExaminePage(data, { success: true, creatureTypeEnumName })!;
}

describe('Examine — CreatureType header + Deaths row (FAITHFUL.313, retail text)', () => {
  it('CreatureType (2) sets the creature header to the display name ("_" → " ")', () => {
    const p = page([[PropertyInt.CreatureType, 1]]);
    expect(p.page).toBe('creature');
    expect(p.page === 'creature' && p.creatureDisplayName).toBe('Olthoi Larvae');
  });

  it('an unmapped CreatureType, 0, or absent leaves the header untouched (null)', () => {
    for (const ints of [[[PropertyInt.CreatureType, 99999]], [[PropertyInt.CreatureType, 0]], []] as Array<Array<[number, number]>>) {
      const p = page(ints);
      expect(p.page === 'creature' && p.creatureDisplayName).toBeNull();
    }
  });

  it('NumDeaths (43) on the character page (templated profile): "Deaths:" N, or "Has never died" at 0', () => {
    const tmpl: Array<[number, string]> = [[PropertyString.Template, 'Adventurer']];
    const deaths = (n: number) => page([[PropertyInt.NumDeaths, n]], tmpl).miscInfo.find((r) => r.label === 'Deaths:')?.value;
    expect(page([], tmpl).page).toBe('character');
    expect(deaths(7)).toBe('7');
    expect(deaths(0)).toBe('Has never died');
  });

  it('the creature page and the item page never show NumDeaths', () => {
    expect(page([[PropertyInt.NumDeaths, 7]]).miscInfo).toEqual([]);
    const item: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map([[PropertyInt.NumDeaths, 7], [PropertyInt.CreatureType, 1]]) };
    expect(buildItemAppraisalText(item, { hasValueBurdenElements: true }).lines.filter((l) => l.text !== '')).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — PropertyInt CreatureType + NumDeaths', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  function pinAssessment(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('CreatureType = 2 [AssessmentProperty]', () => pinAssessment('CreatureType', 2));
  it('NumDeaths = 43 [AssessmentProperty]', () => pinAssessment('NumDeaths', 43));
});
