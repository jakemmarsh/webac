/**
 * Examine-window creature stat-row labels + order (FAITHFUL.291).
 *
 * The removed showExaminePanel resolved its creature rows through the
 * StringTable 0x23000001 ids the character panel uses. The EoL examine page
 * does NOT: BasicCreatureExamineUI fills stat list 0x10000149 with nine rows
 * whose labels come from SkillSystem::InqAttributeName @ 005c8800 and
 * InqAttribute2ndName @ 005c88a0 — literals compiled into acclient.exe — in
 * ctor order (BasicCreatureExamineUI ctor @ 004acd30, l.171385):
 *   Strength, Endurance, Coordination, Quickness, Focus, Self, Health, Stamina, Mana
 * with values from AttributeInfoRegion::Update @ 004f1d90 ("%d") and
 * Attribute2ndInfoRegion::Update @ 004f1e80 ("%d/%d (%d %%)" for Health,
 * "%d/%d" for the others). This file drives the shipped builder
 * (ui/examine/CreatureAppraisalText.ts) and proves the rows ignore the
 * StringTable (sentinel strings registered under those ids never appear).
 * The character panel's renderVitalsOnly still reads the StringTable ids,
 * and that stays pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { StringTableData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildCreatureExaminePage } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';

// DAT StringTable 0x23000001 ids of the character panel's vital + attribute labels.
const LABEL_IDS: Record<string, number> = {
  Health: 163745349, Stamina: 252780597, Mana: 204321781,
  Strength: 147524293, Endurance: 30203877, Coordination: 26644053,
  Quickness: 92306277, Focus: 4495749, Self: 116081589,
};
const sentinel = (name: string): string => `DAT-${name}`;
const TABLE: StringTableData = {
  id: 0x23000001, language: 1, unknown: 0,
  entries: Object.entries(LABEL_IDS).map(([name, id]) => (
    { id, varNames: [], vars: [], strings: [sentinel(name)], comments: [], unknown: 0 }
  )) as unknown as StringTableData['entries'],
};

const profile: NonNullable<IdentifyResponseData['creatureProfile']> = {
  profileFlags: 0x8, health: 40, healthMax: 50,
  attributes: {
    strength: 11, endurance: 12, quickness: 13, coordination: 14, focus: 15, self: 16,
    stamina: 60, mana: 70, staminaMax: 80, manaMax: 90,
  },
};

function statRows(): Array<[string, string]> {
  const page = buildCreatureExaminePage({ guid: 0x80001111, flags: 0, creatureProfile: profile }, { success: true });
  return page!.stats.map((r) => [r.label, r.value]);
}

describe('Examine creature stat rows use the retail client\'s own names (FAITHFUL.291, retail behaviour)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    registerStringTable(TABLE);
  });
  afterAll(() => H.teardown());

  it('nine rows, in BasicCreatureExamineUI ctor order, with retail value formats', () => {
    expect(statRows()).toEqual([
      ['Strength', '11'], ['Endurance', '12'], ['Coordination', '14'], ['Quickness', '13'],
      ['Focus', '15'], ['Self', '16'],
      ['Health', '40/50 (80 %)'], ['Stamina', '60/80'], ['Mana', '70/90'],
    ]);
  });

  it('labels come from InqAttributeName / InqAttribute2ndName, not the StringTable (no sentinel text)', () => {
    for (const [label] of statRows()) expect(label.startsWith('DAT-'), label).toBe(false);
  });

  it('renderVitalsOnly (the char panel vitals) resolves the three StringTable ids', () => {
    H.ui.charInfo.vitals = {
      health: { current: 1, max: 2, raises: 0 },
      stamina: { current: 3, max: 4, raises: 0 },
      mana: { current: 5, max: 6, raises: 0 },
    };
    const host = H.win.document.createElement('div');
    H.ui.renderVitalsOnly(host);
    const text = host.textContent ?? '';
    for (const v of ['Health', 'Stamina', 'Mana']) expect(text).toContain(sentinel(v));
  });
});
