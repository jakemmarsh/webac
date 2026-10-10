/**
 * CreatureAppraisalText — the EoL examine window's creature / character
 * pages (page 0x10000140), ported from the decompiled retail client:
 * gmExaminationUI::SetAppraiseInfo @ 004adae0, BasicCreatureExamineUI
 * (ctor @ 004acd30, SetAppraiseInfo @ 004b3f70, SetLevelValueText
 * @ 004b3e70), CreatureExamineUI::SetAppraiseInfo @ 004b3ff0,
 * CharExamineUI::SetAppraiseInfo @ 004b45f0, Attribute(2nd)InfoRegion::
 * Update(AppraisalProfile) @ 004f1d90 / 004f1e80.
 *
 * Includes the retail screenshot reference/images/hud/examine-npc.jpg
 * ("Sir Daeglan") reproduced from matching inputs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler';
import {
  buildCreatureExaminePage, buildCharacterPage, buildCreaturePage, creatureExamineSubPage,
  creatureStatRows, ratingLines, deltaTimeToString, armorLevelCell, genderHeritageDisplay,
  creatureDisplayName, heritageDisplayName, societyRankSuffix, mulDiv, paperDollCameraOffsetY,
  CREATURE_EXAMINE_ELEMENTS, CREATURE_EXAMINE_STRING_IDS, CREATURE_EXAMINE_LABELS,
  STAT_VALUE_COLORS, MISC_INFO_COLORS,
  type CreatureExamineContext, type CharacterPageModel, type CreaturePageModel,
} from '../packages/renderer/src/ui/examine/CreatureAppraisalText';

const GENDER: Record<number, string> = { 1: 'Male', 2: 'Female' };
const HERITAGE: Record<number, string> = {
  1: 'Aluvian', 2: 'Gharundim', 3: 'Sho', 4: 'Viamontian', 5: 'Shadowbound', 6: 'Gearknight',
  7: 'Tumerok', 8: 'Lugian', 9: 'Empyrean', 10: 'Penumbraen', 11: 'Undead', 12: 'Olthoi', 13: 'OlthoiAcid',
};
const CREATURE: Record<number, string> = { 3: 'Drudge', 35: 'Olthoi_Larvae', 31: 'Human' };

const ctx = (over: Partial<CreatureExamineContext> = {}): CreatureExamineContext => ({
  success: true,
  genderEnumName: g => GENDER[g],
  heritageEnumName: h => HERITAGE[h],
  creatureTypeEnumName: c => CREATURE[c],
  characterTitle: id => (id === 1 ? 'Adventurer' : null),
  publicWeenieBitfield: 0,
  viewerFaction1Bits: 0,
  objectName: 'Sir Daeglan',
  ...over,
});

function daeglan(): IdentifyResponseData {
  return {
    guid: 0x80000001, flags: 0x4109,
    propertiesInt: new Map([[25, 220], [113, 1], [188, 1], [2, 31]]),
    propertiesString: new Map([[1, 'Sir Daeglan'], [5, 'Royal Investigator']]),
    creatureProfile: {
      profileFlags: 0x8, health: 341, healthMax: 341,
      attributes: {
        strength: 200, endurance: 290, quickness: 200, coordination: 260, focus: 290, self: 290,
        stamina: 486, mana: 486, staminaMax: 486, manaMax: 486,
      },
    },
    armorLevels: { head: 20, chest: 90, abdomen: 0, upperArm: 0, lowerArm: 0, hand: 420, upperLeg: 0, lowerLeg: 0, foot: 0 },
  };
}

describe('page choice (gmExaminationUI::SetAppraiseInfo @ 004adae0)', () => {
  it('no creature profile → not this page; Template or CharacterTitleId → character; else creature', () => {
    expect(creatureExamineSubPage({})).toBeNull();
    const cp = { profileFlags: 0, health: 1, healthMax: 1 };
    expect(creatureExamineSubPage({ creatureProfile: cp })).toBe('creature');
    expect(creatureExamineSubPage({ creatureProfile: cp, propertiesString: new Map([[5, 'x']]) })).toBe('character');
    expect(creatureExamineSubPage({ creatureProfile: cp, propertiesInt: new Map([[261, 0]]) })).toBe('character');
    expect(buildCreatureExaminePage({ guid: 1, flags: 0 }, ctx())).toBeNull();
  });
});

describe('Sir Daeglan — reference/images/hud/examine-npc.jpg', () => {
  let page: CharacterPageModel;
  beforeAll(() => { page = buildCreatureExaminePage(daeglan(), ctx()) as CharacterPageModel; });

  it('uses the character header sub-panel of page 0x10000140', () => {
    expect(page.page).toBe('character');
    expect(page.headerPanel).toBe(0x1000014f);
    expect(CREATURE_EXAMINE_ELEMENTS.page).toBe(0x10000140);
  });

  it('header lines 0x10000150/51/52 and level 0x1000014c', () => {
    expect(page.heritage).toBe('Male Aluvian');
    expect(page.title).toBe('Royal Investigator');
    expect(page.playerKiller).toBe('Non-Player Killer');
    expect(page.level).toBe('220');
    expect(page.windowTitle).toBe('Sir Daeglan');
  });

  it('stat rows in retail order with retail formats', () => {
    expect(page.stats.map(r => [r.label, r.value])).toEqual([
      ['Strength', '200'], ['Endurance', '290'], ['Coordination', '260'], ['Quickness', '200'],
      ['Focus', '290'], ['Self', '290'],
      ['Health', '341/341 (100 %)'], ['Stamina', '486/486'], ['Mana', '486/486'],
    ]);
    expect(page.stats.every(r => r.color === 0)).toBe(true);
  });

  it('misc list: blank, three AL rows, "* = Unenchantable"', () => {
    expect(page.miscInfo).toEqual([
      { label: '', value: '', color: 0 },
      { label: 'Head/Chest/Groin', value: 'AL: 20/90/0', color: 0 },
      { label: 'Bicep/Wrist/Hand', value: 'AL: 0/0/420', color: 0 },
      { label: 'Thigh/Shin/Foot', value: 'AL: 0/0/0', color: 0 },
      { label: '* = Unenchantable', value: '', color: 0 },
    ]);
    expect(page.allegianceName).toBe('');
  });
});

describe('stat rows (Attribute(2nd)InfoRegion::Update @ 004f1d90 / 004f1e80)', () => {
  it('failed appraisal: attrs "???" (only health known), health "%d %%", yellow', () => {
    const rows = creatureStatRows({ creatureProfile: { profileFlags: 0, health: 50, healthMax: 200 } }, false);
    expect(rows.map(r => r.value)).toEqual(['???', '???', '???', '???', '???', '???', '25 %', '???', '???']);
    expect(rows.every(r => r.color === 3)).toBe(true);
    expect(STAT_VALUE_COLORS[3]).toBe(0xffffff00);
  });

  it('percent is MulDiv-rounded', () => {
    expect(mulDiv(100, 2, 3)).toBe(67);
    expect(mulDiv(100, 1, 3)).toBe(33);
    expect(mulDiv(100, 1, 0)).toBe(-1);
    const rows = creatureStatRows({ creatureProfile: { profileFlags: 8, health: 2, healthMax: 3 } }, true);
    expect(rows[6].value).toBe('2/3 (67 %)'); // health rows need only health + max
    const r2 = creatureStatRows({ creatureProfile: { profileFlags: 8, health: 2, healthMax: 3,
      attributes: { strength: 1, endurance: 1, quickness: 1, coordination: 1, focus: 1, self: 1, stamina: 0, mana: 5, staminaMax: 9, manaMax: 10 } } }, true);
    expect(r2[6].value).toBe('2/3 (67 %)');
    expect(r2[7].value).toBe('???'); // current stamina 0 → InqAttribute2nd fails
    expect(r2[8].value).toBe('5/10');
  });

  it('highlight/colour bitmasks: green = buffed, red = debuffed; vitals keyed by the max bit', () => {
    const rows = creatureStatRows({ creatureProfile: {
      profileFlags: 9, health: 10, healthMax: 10,
      attributes: { strength: 1, endurance: 1, quickness: 1, coordination: 1, focus: 1, self: 1, stamina: 1, mana: 1, staminaMax: 1, manaMax: 1 },
      attributeHighlights: 0x1 | 0x4 | 0x40 | 0x100, attributeColors: 0x1 | 0x100,
    } }, true);
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r.color]));
    expect(byLabel).toEqual({ Strength: 1, Endurance: 0, Coordination: 0, Quickness: 2, Focus: 0, Self: 0, Health: 2, Stamina: 0, Mana: 1 });
    expect(MISC_INFO_COLORS).toEqual([0xffffffff, 0xff00ff00, 0xffff0000]);
  });
});

describe('creature page (CreatureExamineUI::SetAppraiseInfo @ 004b3ff0)', () => {
  const drudge = (): IdentifyResponseData => ({
    guid: 2, flags: 0,
    propertiesInt: new Map([[2, 35], [25, 0], [307, 10], [314, 4], [350, 3]]),
    creatureProfile: { profileFlags: 0, health: 10, healthMax: 40 },
  });

  it('display name from CreatureType with "_" → " ", level "???", allegiance line cleared', () => {
    const p = buildCreatureExaminePage(drudge(), ctx({ success: false })) as CreaturePageModel;
    expect(p.page).toBe('creature');
    expect(p.headerPanel).toBe(0x1000014d);
    expect(p.creatureDisplayName).toBe('Olthoi Larvae');
    expect(p.level).toBe('???');
    expect(p.allegianceName).toBe('');
  });

  it('rating block with opening + closing blank rows and no Unenchantable legend', () => {
    const p = buildCreaturePage(drudge(), ctx());
    expect(p.miscInfo).toEqual([
      { label: '', value: '', color: 0 },
      { label: 'Dmg/CritDmg', value: 'Rating: 10/4', color: 0 },
      { label: 'DoT/Life:', value: 'Resist: 3/0', color: 0 },
      { label: '', value: '', color: 0 },
    ]);
  });

  it('unknown creature type leaves the header untouched (null)', () => {
    const d = drudge(); d.propertiesInt!.set(2, 999);
    expect(buildCreaturePage(d, ctx()).creatureDisplayName).toBeNull();
  });

  it('no ratings → no rows; resist line alone still opens with a blank', () => {
    expect(ratingLines({ propertiesInt: new Map() })).toEqual([]);
    expect(ratingLines({ propertiesInt: new Map([[308, 5], [316, 2]]) }).map(l => l.value)).toEqual(['', 'Resist: 5/2', '']);
  });
});

describe('character page misc list (CharExamineUI::SetAppraiseInfo @ 004b45f0)', () => {
  const player = (): IdentifyResponseData => ({
    guid: 0x50000001, flags: 0,
    propertiesInt: new Map([
      [25, 126], [113, 2], [188, 2], [261, 1], [281, 2], [288, 450], [30, 3],
      [125, 90061], [181, 1400], [192, 55], [43, 0], [262, 12], [313, 5],
    ]),
    propertiesString: new Map([
      [47, 'Order of Frore'], [21, 'High King Bael'], [35, 'Sultana Ayla'],
      [10, 'Lugian Hunters'], [43, 'Arrived 01/02/2003'],
    ]),
    creatureProfile: { profileFlags: 8, health: 100, healthMax: 100 },
  });

  it('header: gender+heritage override, title table, PK Lite; window title gains the allegiance rank title', () => {
    const p = buildCharacterPage(player(), ctx({ publicWeenieBitfield: 0x02000000, objectName: 'Ayla', viewerFaction1Bits: 2 }));
    expect(p.heritage).toBe("Female Gharu'ndim");
    expect(p.title).toBe('Adventurer');
    expect(p.playerKiller).toBe('Player Killer Lite');
    expect(p.windowTitle).toBe('Maulana Ayla');
    expect(p.allegianceName).toBe('Order of Frore');
  });

  it('misc rows in retail order', () => {
    const p = buildCharacterPage(player(), ctx({ viewerFaction1Bits: 2 }));
    expect(p.miscInfo).toEqual([
      { label: 'Society:', value: 'Eldrytch Web ~ Knight', color: 1 },
      { label: 'Monarch:', value: 'High King Bael', color: 0 },
      { label: 'Patron:', value: 'Sultana Ayla', color: 0 },
      { label: '', value: '', color: 0 },
      { label: 'Dmg/CritDmg', value: 'Rating: 0/0', color: 0 },
      { label: '', value: '', color: 0 },
      { label: 'Fellowship:', value: 'Lugian Hunters', color: 0 },
      { label: 'Arrived in Dereth:', value: 'Arrived 01/02/2003', color: 0 },
      { label: 'Time in Dereth:', value: '1d 1h 1m 1s', color: 0 },
      { label: 'Chess Rank:', value: '1400', color: 0 },
      { label: 'Fishing Skill:', value: '55', color: 0 },
      { label: 'Deaths:', value: 'Has never died', color: 0 },
      { label: 'Titles Earned:', value: '12', color: 0 },
      { label: '* = Unenchantable', value: '', color: 0 },
    ]);
  });

  it('society colour: rival society red, none white; "???" for unknown bits', () => {
    expect(buildCharacterPage(player(), ctx({ viewerFaction1Bits: 4 })).miscInfo[0].color).toBe(2);
    expect(buildCharacterPage(player(), ctx({ viewerFaction1Bits: 0 })).miscInfo[0].color).toBe(0);
    const d = player(); d.propertiesInt!.set(281, 0);
    expect(buildCharacterPage(d, ctx()).miscInfo[0]).toEqual({ label: 'Society:', value: '???', color: 0 });
  });

  it('monarch variants: same patron, monarch self (followers)', () => {
    const d = player(); d.propertiesString!.set(35, 'High King Bael');
    expect(buildCharacterPage(d, ctx()).miscInfo[1]).toEqual({ label: 'Monarch/Patron:', value: 'High King Bael', color: 0 });
    const m = player(); m.propertiesString!.delete(21); m.propertiesInt!.set(35, 1);
    expect(buildCharacterPage(m, ctx()).miscInfo[1]).toEqual({ label: 'Alleg. Monarch:', value: '1 Follower', color: 0 });
    m.propertiesInt!.delete(35);
    expect(buildCharacterPage(m, ctx()).miscInfo[1].value).toBe('0 Followers');
    const none = player(); none.propertiesInt!.delete(30);
    const p = buildCharacterPage(none, ctx());
    expect(p.allegianceName).toBe('');
    expect(p.miscInfo.some(l => l.label.includes('Monarch'))).toBe(false);
  });

  it('PK / NPK / no weenie; template fallback when the title id is unknown', () => {
    expect(buildCharacterPage(player(), ctx({ publicWeenieBitfield: 0x20 })).playerKiller).toBe('Player Killer');
    expect(buildCharacterPage(player(), ctx({ publicWeenieBitfield: undefined })).playerKiller).toBeNull();
    const d = player(); d.propertiesInt!.set(261, 77); d.propertiesString!.set(5, 'Tinker');
    expect(buildCharacterPage(d, ctx()).title).toBe('Tinker');
    d.propertiesString!.delete(5);
    expect(buildCharacterPage(d, ctx()).title).toBeNull();
  });

  it('deaths count', () => {
    const d = player(); d.propertiesInt!.set(43, 7);
    expect(buildCharacterPage(d, ctx()).miscInfo.find(l => l.label === 'Deaths:')!.value).toBe('7');
  });
});

describe('small retail helpers', () => {
  it('armor cells mark ≥ 9999 as unenchantable', () => {
    expect(armorLevelCell(9999 + 250)).toBe('*250');
    expect(armorLevelCell(9999)).toBe('*0');
    expect(armorLevelCell(9998)).toBe('9998');
  });

  it('DeltaTimeToString (30-day months, zero units skipped, seconds always)', () => {
    expect(deltaTimeToString(0)).toBe('0s');
    expect(deltaTimeToString(60)).toBe('1m 0s');
    expect(deltaTimeToString(2592000 * 14 + 86400 * 3 + 5)).toBe('14mo 3d 5s');
  });

  it('society ranks', () => {
    expect([0, 1, 100, 101, 300, 301, 600, 601, 1000, 1001, 1500, 1501].map(societyRankSuffix)).toEqual([
      '', ' ~ Initiate', ' ~ Initiate', ' ~ Adept', ' ~ Adept', ' ~ Knight', ' ~ Knight',
      ' ~ Lord', ' ~ Lord', ' ~ Master', ' ~ Master', '',
    ]);
  });

  it('gender/heritage/creature display (InqGenderHeritageDisplay @ 005b5ae0)', () => {
    const c = ctx();
    expect(heritageDisplayName(5, c.heritageEnumName)).toBe('Umbraen');
    expect(heritageDisplayName(13, c.heritageEnumName)).toBe('Olthoi');
    expect(heritageDisplayName(10, c.heritageEnumName)).toBe('Penumbraen');
    expect(genderHeritageDisplay(0, 1, 0, c)).toBe('Aluvian');
    expect(genderHeritageDisplay(1, 0, 3, c)).toBe('Male Drudge');
    expect(genderHeritageDisplay(1, 0, 0, c)).toBe('Male');
    expect(genderHeritageDisplay(1, 99, 0, c)).toBe('Male');
    expect(genderHeritageDisplay(0, 0, 0, c)).toBe('');
    expect(creatureDisplayName(35, c.creatureTypeEnumName)).toBe('Olthoi Larvae');
  });

  it('paper-doll camera pull-back', () => {
    // dz/dx = 2 >= h/w = 265/300 → fit = dz
    expect(paperDollCameraOffsetY({ dx: 1, dy: 1, dz: 2 }, 300, 265)).toBeCloseTo(-(2 * 1.2071068 + 0.5), 5);
    // dz/dx = 0.5 < 265/300 → fit = dx·h/w
    expect(paperDollCameraOffsetY({ dx: 4, dy: 2, dz: 2 }, 300, 265)).toBeCloseTo(-(4 * (265 / 300) * 1.2071068 + 1), 5);
  });
});

const ROOT = resolve(__dirname, '..');
const PORTAL = resolve(ROOT, 'dat/client_portal.dat');
const LOCAL = resolve(ROOT, 'dat/client_local_English.dat');

describe.skipIf(!existsSync(PORTAL) || !existsSync(LOCAL))('DAT-anchored strings, enum names and colours', () => {
  let getStringFromTable: (t: number, id: number) => string | null;
  let enumNames: Map<number, Map<number, string>>;
  let layoutProps: (layout: number, path: number[]) => Map<number, any> | undefined;
  let acStringHash: (s: string) => number;

  beforeAll(async () => {
    const dp = await import('../packages/dat-parser/src/index');
    const { readEnumMapper } = await import('../packages/dat-parser/src/file-types/EnumMapper');
    const open = (p: string) => {
      const b = readFileSync(p);
      return new dp.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    };
    const portal = open(PORTAL);
    const local = open(LOCAL);
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001)!)));
    for (const t of [0x23000001, 0x2300000e]) dp.registerStringTable(dp.parseStringTable(new dp.DatReader(local.getFileData(t)!)));
    getStringFromTable = dp.getStringFromTable;
    acStringHash = dp.acStringHash;
    enumNames = new Map();
    for (const id of [0x2200000a, 0x2200000b, 0x2200000e, 0x22000041]) {
      enumNames.set(id, readEnumMapper(new dp.DatReader(portal.getFileData(id)!)).idToStringMap);
    }
    const layouts = new Map<number, any>();
    layoutProps = (layout, path) => {
      if (!layouts.has(layout)) layouts.set(layout, dp.parseLayoutDesc(new dp.DatReader(local.getFileData(layout)!)));
      let children: Map<number, any> = layouts.get(layout).elements;
      let el: any;
      for (const id of path) { el = children.get(id); if (!el) return undefined; children = el.children; }
      return el?.properties;
    };
  });

  it('page labels resolve to "Character" / "Level" in StringTable 0x23000001', () => {
    expect(getStringFromTable(CREATURE_EXAMINE_STRING_IDS.table, CREATURE_EXAMINE_STRING_IDS.character)).toBe(CREATURE_EXAMINE_LABELS.character);
    expect(getStringFromTable(CREATURE_EXAMINE_STRING_IDS.table, CREATURE_EXAMINE_STRING_IDS.level)).toBe(CREATURE_EXAMINE_LABELS.level);
    const lbl = layoutProps(0x2100006b, [0x100005f2, 0x10000140, 0x1000014a]);
    expect(lbl?.get(23)?.valueString?.stringId).toBe(CREATURE_EXAMINE_STRING_IDS.character);
    const lvl = layoutProps(0x2100006b, [0x100005f2, 0x10000140, 0x1000014b]);
    expect(lvl?.get(23)?.valueString?.stringId).toBe(CREATURE_EXAMINE_STRING_IDS.level);
  });

  it('font colour arrays match the row templates', () => {
    const colors = (props: Map<number, any> | undefined) => props?.get(27)?.valueArray?.map((v: any) => v.valueColor >>> 0);
    expect(colors(layoutProps(0x2100006b, [0x10000166, 0x1000012b]))).toEqual([...STAT_VALUE_COLORS]);
    expect(colors(layoutProps(0x2100001c, [0x10000337, 0x1000012b]))).toEqual([...MISC_INFO_COLORS]);
    const misc = layoutProps(0x2100006b, [0x100005f2, 0x10000140, 0x10000335]);
    const tmpl = misc?.get(100)?.valueArray?.[0]?.valueStruct;
    expect(tmpl?.get(98)?.valueEnum).toBe(CREATURE_EXAMINE_ELEMENTS.miscRowTemplate);
    expect(tmpl?.get(99)?.valueDataFile).toBe(CREATURE_EXAMINE_ELEMENTS.miscRowTemplateLayout);
  });

  it('Sir Daeglan header from the real EnumMappers; title from 0x22000041 → 0x2300000E', () => {
    const e = (id: number) => (v: number) => enumNames.get(id)!.get(v) ?? null;
    const c = ctx({
      genderEnumName: e(0x2200000a), heritageEnumName: e(0x2200000b), creatureTypeEnumName: e(0x2200000e),
      characterTitle: id => {
        const tok = enumNames.get(0x22000041)!.get(id);
        return tok ? getStringFromTable(0x2300000e, acStringHash(tok)) : null;
      },
    });
    const p = buildCharacterPage(daeglan(), c);
    expect(p.heritage).toBe('Male Aluvian');
    expect(genderHeritageDisplay(2, 5, 0, c)).toBe('Female Umbraen');
    expect(creatureDisplayName(35, c.creatureTypeEnumName)).toBe('Olthoi Larvae');
    const d = daeglan(); d.propertiesInt!.set(261, 1);
    expect(buildCharacterPage(d, c).title).toBe('Adventurer');
  });
});
