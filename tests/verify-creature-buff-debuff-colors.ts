/**
 * CreatureProfile buff/debuff highlighting on the examine page (FAITHFUL.296).
 *
 * `cp.attributeHighlights` + `cp.attributeColors` are two u16 bitfields
 * (ACE reference/ACE/Source/ACE.Server/Network/Structure/CreatureProfile.cs
 * HasBuffsDebuffs branch). Per ACE `Network/Enum/AttributeMask.cs`:
 *   highlightMask bit set    = attribute/vital IS modified (buff OR debuff)
 *   colorMask bit set        = modifier is a BUFF; clear = DEBUFF
 * Bits: Strength=0x1, Endurance=0x2, Quickness=0x4, Coordination=0x8,
 *       Focus=0x10, Self=0x20, Health=0x40, Stamina=0x80, Mana=0x100.
 *
 * Now verifies the shipped builder
 * `packages/renderer/src/ui/examine/CreatureAppraisalText.ts`: the stat
 * list 0x10000149's value colour is a font-colour INDEX into the DAT p27
 * array STAT_VALUE_COLORS (0 white, 1 green 0xFF00FF00, 2 red 0xFFFF0000,
 * 3 yellow) — CreatureAppraisalProfile::InqAttributeEnchantmentMod
 * @ 005b5ec0 / InqAttribute2ndEnchantmentMod @ 005b5fb0 read the retail
 * uint32 (highlights low 16, colours high 16); vitals are keyed by their
 * MAX bit. A failed appraisal paints every row yellow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildCreaturePage, creatureStatRows, STAT_VALUE_COLORS } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';

const REPO = resolve(__dirname, '..');

describe('Examine creature page — buff/debuff stat colours (FAITHFUL.296)', () => {
  const ATTRS = { strength: 11, endurance: 12, quickness: 13, coordination: 14, focus: 15, self: 16,
    stamina: 17, staminaMax: 170, mana: 18, manaMax: 180 };
  // Each AttributeMask bit → the stat-row value it must tint (retail row order is
  // Str, End, Coord, Quick, Focus, Self, Health, Stamina, Mana).
  const ROW_BY_BIT: Array<[number, string]> = [
    [0x1, '11'], [0x2, '12'], [0x4, '13'], [0x8, '14'], [0x10, '15'], [0x20, '16'],
    [0x40, '5/50 (10 %)'], [0x80, '17/170'], [0x100, '18/180'],
  ];
  const profile = (highlights: number, colors: number): IdentifyResponseData => ({
    guid: 0x80001111, flags: 0,
    creatureProfile: { profileFlags: 0x9, health: 5, healthMax: 50, attributes: ATTRS,
      attributeHighlights: highlights, attributeColors: colors },
  });
  const stats = (d: IdentifyResponseData, success = true) => buildCreaturePage(d, { success }).stats;

  it('the DAT colour array: 1 = green (buff), 2 = red (debuff), 0 = white', () => {
    expect(STAT_VALUE_COLORS[0]).toBe(0xffffffff);
    expect(STAT_VALUE_COLORS[1]).toBe(0xff00ff00);
    expect(STAT_VALUE_COLORS[2]).toBe(0xffff0000);
  });

  it('each AttributeMask bit tints exactly its own row: highlighted + colour bit → green (buff)', () => {
    for (const [bit, value] of ROW_BY_BIT) {
      const rows = stats(profile(bit, bit));
      const row = rows.find((r) => r.value === value);
      expect(row, `row for bit 0x${bit.toString(16)}`).toBeDefined();
      expect(row!.color, `bit 0x${bit.toString(16)}`).toBe(1);
      for (const other of rows.filter((r) => r !== row)) {
        expect(other.color, `bit 0x${bit.toString(16)} leaked to ${other.label}`).toBe(0);
      }
    }
  });

  it('highlighted with the colour bit clear → red (debuff)', () => {
    for (const [bit, value] of ROW_BY_BIT) {
      expect(stats(profile(bit, 0)).find((r) => r.value === value)!.color).toBe(2);
    }
  });

  it('a colour bit without its highlight bit is ignored (white)', () => {
    const rows = stats(profile(0, 0x1ff));
    expect(rows.map((r) => r.color)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('the rows carry the retail attribute / vital labels in retail order', () => {
    expect(stats(profile(0, 0)).map((r) => r.label)).toEqual([
      'Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self', 'Health', 'Stamina', 'Mana',
    ]);
  });

  it('a failed appraisal paints every row yellow (index 3) regardless of the masks', () => {
    const rows = creatureStatRows(profile(0x1ff, 0x1ff), false);
    expect(rows.every((r) => r.color === 3)).toBe(true);
    expect(STAT_VALUE_COLORS[3]).toBe(0xffffff00);
  });
});

const ACE_PROFILE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Structure/CreatureProfile.cs',
);
const ACE_MASK = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Enum/AttributeMask.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROFILE) || !aceReferenceExists(ACE_MASK))(
  'ACE source pin — CreatureProfile.HasBuffsDebuffs + AttributeMask bits',
  () => {
    let profileSrc: string;
    let maskSrc: string;
    // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
    beforeAll(() => {
      profileSrc = readFileSync(ACE_PROFILE, 'utf8');
      maskSrc = readFileSync(ACE_MASK, 'utf8');
    });

    it('CreatureProfile.Write emits AttributeHighlights+AttributeColors when HasBuffsDebuffs is set', () => {
      expect(profileSrc).toMatch(
        /HasBuffsDebuffs[\s\S]+writer\.Write\(\(ushort\)profile\.AttributeHighlights\)[\s\S]+writer\.Write\(\(ushort\)profile\.AttributeColors\)/,
      );
    });

    it('AttributeMask bit values match: Strength=0x1, Endurance=0x2, Quickness=0x4, Coordination=0x8, Focus=0x10, Self=0x20, Health=0x40, Stamina=0x80, Mana=0x100', () => {
      const expected: Record<string, string> = {
        Strength: '0x1',
        Endurance: '0x2',
        Quickness: '0x4',
        Coordination: '0x8',
        Focus: '0x10',
        Self: '0x20',
        Health: '0x40',
        Stamina: '0x80',
        Mana: '0x100',
      };
      for (const [name, hex] of Object.entries(expected)) {
        expect(maskSrc, `AttributeMask.${name} mismatch`)
          .toMatch(new RegExp(`${name}\\s*=\\s*${hex}\\b`, 'i'));
      }
    });

    it('AttributeMaskHelper.GetAttributeColors only sets bits for ModifierType.Buffed (debuff defaults to clear)', () => {
      // Pin the convention: bit SET in colors = buff, bit CLEAR (but set in
      // highlights) = debuff. Our attrColor helper depends on this exact
      // convention to choose green vs red.
      expect(maskSrc).toMatch(/colorMask\s*=\s*0/);
      expect(maskSrc).toMatch(/ModifierType\.Buffed/);
    });
  },
);
