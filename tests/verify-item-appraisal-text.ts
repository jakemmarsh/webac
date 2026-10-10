/**
 * EoL ITEM examine body text (ItemExamineUI → element 0x1000013c) —
 * behavioural tests of the shipped pure builder
 * packages/renderer/src/ui/examine/ItemAppraisalText.ts.
 *
 * Ground truth: the decompiled retail client (reference/client-eol, build
 * ac1_sep13) — ItemExamineUI::SetAppraiseInfo @ 004b72b0 and every
 * Appraisal_Show* it calls (format strings / constants read out of
 * acclient.exe). The two retail screenshots reference/images/hud/
 * examine-bow.jpg + examine-helm.jpg are an OLDER docked-era panel: the
 * inputs below are built to match them, and the assertions pin the EoL
 * wording/order the decomp produces for those same items (e.g. "Properties:"
 * not "Special Properties:", "Spells:" not "Casts the following spells:",
 * description LAST, value/burden inside the floaty body).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  buildItemAppraisalText, buildItemValueBurdenHeader, AUGMENTATION_COST_STRING_ID,
  APPRAISAL_COLOR_ARGB, type ItemAppraisalContext, type SpellInfo,
} from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import {
  modifierToString, smallModifierToString, damageResistanceToString, damageTypeToString,
  workmanshipAdjective, deltaTimeToString, cG, itemTotalXpToLevel, itemLevelToTotalXp,
  clothingPriorityToString, insertCommas,
} from '../packages/renderer/src/ui/examine/appraisalFormat.js';
import { acStringHash, registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';

const REPO = resolve(__dirname, '..');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

function item(p: Partial<IdentifyResponseData> & {
  ints?: Record<number, number>; floats?: Record<number, number>; bools?: Record<number, boolean>;
  strings?: Record<number, string>; int64s?: Record<number, bigint>; dids?: Record<number, number>;
}): IdentifyResponseData {
  const m = <T>(o?: Record<number, T>) => (o ? new Map(Object.entries(o).map(([k, v]) => [Number(k), v])) : undefined);
  const { ints, floats, bools, strings, int64s, dids, ...rest } = p;
  return {
    guid: 0x80000001, flags: 0,
    propertiesInt: m(ints), propertiesFloat: m(floats), propertiesBool: m(bools),
    propertiesString: m(strings), propertiesInt64: m(int64s), propertiesDataID: m(dids),
    ...rest,
  };
}

// ─── Lilitha's Bow (examine-bow.jpg) ───────────────────────────────────
const BOW_SPELLS: Record<number, SpellInfo> = {
  1001: { name: 'Defender IV', description: 'Increases the wielder\'s melee defense.' },
  1002: { name: 'Blood Drinker IV', description: 'Increases the weapon\'s damage.' },
};
const bow = item({
  ints: {
    19: 875, 5: 350, 353: 8 /* WeaponType Bow */, 33: 1 /* Bonded */,
    115: 230 /* ItemSkillLevelLimit */, 176: 47 /* AppraisalItemSkill = Missile Weapons */,
    106: 150, 107: 400, 108: 400,
  },
  floats: { 29: 1.08 /* WeaponDefense */, 147: 1.5 /* CriticalFrequency → Biting Strike */, 5: -1 / 30 /* ManaRate */ },
  bools: { 85: true /* AppraisalHasAllowedWielder */ },
  strings: { 25: 'Ontij', 16: "One of Lilitha's earlier Bows, recently repaired by Eldrista the Adventurer." },
  spellBook: [1001, 1002],
  activeEnchantments: [],
  weaponProfile: {
    damageType: 0, weaponTime: 40, weaponSkill: 47, damage: 4, damageVariance: 0, damageMod: 2.1,
    weaponLength: 0, maxVelocity: 27, weaponOffense: 1.0, maxVelocityEstimated: 0,
  },
});
const bowCtx: ItemAppraisalContext = {
  weenie: { validLocations: 0x400000 /* MissileWeapon */, ammoType: 1 /* arrows */ },
  resolvers: { spell: (id) => BOW_SPELLS[id] },
};

describe('ItemAppraisalText — bow (examine-bow.jpg inputs, EoL floaty page)', () => {
  it('reproduces the retail body line-for-line in SetAppraiseInfo order', () => {
    const out = buildItemAppraisalText(bow, bowCtx);
    expect(out.text.split('\n')).toEqual([
      'Value: 875',
      'Burden: 350',
      '',
      'Skill: Missile Weapons (Bow)',
      'Damage Bonus: 4',
      'Damage Modifier: +110%.',
      'Speed: Average (40)',
      'Range: 80 yds.',
      'Uses arrows as ammunition.',
      'Bonus to Melee Defense: +8.0%.',
      '',
      'Spells: Defender IV, Blood Drinker IV',
      '',
      'Properties: Bonded, Biting Strike',
      '',
      'Wield requires Ontij',
      'Activation requires Missile Weapons: 230',
      'Spellcraft: 150.',
      'Mana: 400 / 400.',
      'Mana Cost: 1 point per 30 seconds.',
      '',
      'Spell Descriptions:',
      "~ Defender IV: Increases the wielder's melee defense.",
      "~ Blood Drinker IV: Increases the weapon's damage.",
      '',
      "One of Lilitha's earlier Bows, recently repaired by Eldrista the Adventurer.",
    ]);
  });

  it('groups the body into blank-line-separated paragraphs', () => {
    const out = buildItemAppraisalText(bow, bowCtx);
    expect(out.paragraphs.map((p) => p[0].text)).toEqual([
      'Value: 875', 'Skill: Missile Weapons (Bow)', 'Spells: Defender IV, Blood Drinker IV',
      'Properties: Bonded, Biting Strike', 'Wield requires Ontij', 'Spell Descriptions:',
      "One of Lilitha's earlier Bows, recently repaired by Eldrista the Adventurer.",
    ]);
    expect(out.lines.every((l) => l.color === 0)).toBe(true);
  });

  it('first AddItemInfo has no separator; sameParagraph=0 sections open with a blank line', () => {
    const out = buildItemAppraisalText(bow, bowCtx);
    expect(out.runs[0]).toMatchObject({ separator: '', text: 'Value: 875', section: 'ShowValueInfo' });
    expect(out.runs.find((r) => r.text.startsWith('Spells: '))!.separator).toBe('\n\n');
    expect(out.runs.find((r) => r.text === 'Spell Descriptions:\n~ Defender IV: Increases the wielder\'s melee defense.\n~ Blood Drinker IV: Increases the weapon\'s damage.')!.separator).toBe('\n\n');
  });

  it('docked page (header elements present) keeps Value/Burden out of the body', () => {
    const out = buildItemAppraisalText(bow, { ...bowCtx, hasValueBurdenElements: true });
    expect(out.value).toBe('Value: 875');
    expect(out.burden).toBe('350 Burden Units');
    // Body starts empty, so the first line gets no separator (AddItemInfo's > 1 glyph test).
    expect(out.text.startsWith('Skill: Missile Weapons (Bow)\nDamage Bonus: 4')).toBe(true);
  });

  it('failed appraisal: "Damage Modifier: Unknown" and both magic sections say "Spells: unknown."', () => {
    const out = buildItemAppraisalText(bow, { ...bowCtx, appraisalSuccess: false });
    expect(out.text).toContain('Damage Modifier: Unknown');
    expect(out.text.match(/Spells: unknown\./g)!.length).toBe(2);
    expect(out.text).not.toContain('Activation requires');
  });
});

// ─── Helm of Darkness (examine-helm.jpg) ──────────────────────────────
const HELM_SPELLS = ["Archer's Bane", 'Major Armor', "Olthoi's Bane", "Swordsman's Bane", "Tusker's Bane",
  "Inferno's Bane", "Gelidite's Bane", "Brogard's Defiance", "Astyrrian's Bane"];
const helm = item({
  ints: {
    19: 0, 5: 600, 265: 19 /* EquipmentSetId Hearty */, 28: 440 /* ArmorLevel */, 114: 1, 33: 1,
    158: 7 /* WieldRequirements = Level */, 159: 1, 160: 125, 106: 100, 107: 1000, 108: 1000,
  },
  floats: { 5: -1 / 30 },
  bools: { 99: true, 100: true },
  strings: { 16: 'This piece of armor once belonged to the unknown warrior. Touching this armor fills your head with chaotic thoughts.' },
  spellBook: HELM_SPELLS.map((_, i) => 2000 + i),
  armorProfile: {
    slashing: Math.fround(1.2), piercing: 1.5, bludgeoning: Math.fround(1.2), cold: Math.fround(0.6),
    fire: Math.fround(0.6), acid: Math.fround(0.8), nether: 1.0, lightning: Math.fround(0.6),
  },
});
const helmCtx: ItemAppraisalContext = {
  weenie: { validLocations: 0x1 /* HeadWear */, priority: 0x4000 /* Head */ },
  resolvers: { spell: (id) => ({ name: HELM_SPELLS[id - 2000], description: 'desc' }) },
};

describe('ItemAppraisalText — helm (examine-helm.jpg inputs)', () => {
  it('set, coverage, armor table (retail Fire-before-Cold order), properties, wield level, magic', () => {
    const lines = buildItemAppraisalText(helm, helmCtx).text.split('\n');
    expect(lines.slice(0, 21)).toEqual([
      'Value: 0',
      'Burden: 600',
      '',
      'Set: Hearty',
      '',
      'Covers Head',
      '',
      'Armor Level: 440',
      'Slashing: Above Average  (528)',
      'Piercing: Above Average  (660)',
      'Bludgeoning: Above Average  (528)',
      'Fire: Below Average  (264)',
      'Cold: Below Average  (264)',
      'Acid: Average  (352)',
      'Electric: Below Average  (264)',
      'Nether: Average  (440)',
      '',
      `Spells: ${HELM_SPELLS.join(', ')}`,
      '',
      'Properties: Attuned, Bonded, Ivoryable, Dyeable',
      '',
    ]);
    expect(lines.slice(21, 26)).toEqual([
      'Wield requires level 125',
      'Spellcraft: 100.',
      'Mana: 1000 / 1000.',
      'Mana Cost: 1 point per 30 seconds.',
      '',
    ]);
    expect(lines[26]).toBe('Spell Descriptions:');
    expect(lines.at(-1)).toBe('This piece of armor once belonged to the unknown warrior. Touching this armor fills your head with chaotic thoughts.');
  });

  it('an era with no nether damage (1999: noNetherDamage) drops only the Nether row', () => {
    const eor = buildItemAppraisalText(helm, helmCtx).text.split('\n');
    const old = buildItemAppraisalText(helm, { ...helmCtx, noNetherDamage: true }).text.split('\n');
    expect(eor).toContain('Nether: Average  (440)');
    expect(old.some((l) => l.startsWith('Nether'))).toBe(false);
    expect(old).toEqual(eor.filter((l) => l !== 'Nether: Average  (440)'));
  });

  it('enchanted armor rows are coloured by the highlight/colour bitfields (1 = green buff, 2 = red debuff)', () => {
    const out = buildItemAppraisalText({ ...helm, armorEnchantment: { highlight: 0x1 | 0x2 | 0x20, color: 0x1 } }, helmCtx);
    const byText = (t: string) => out.lines.find((l) => l.text.startsWith(t))!;
    expect(byText('Armor Level:').color).toBe(1);
    expect(byText('Slashing:').color).toBe(2);
    expect(byText('Fire:').color).toBe(2);
    expect(byText('Piercing:').color).toBe(0);
    expect(APPRAISAL_COLOR_ARGB[1]).toBe(0xff00ff00);
    expect(APPRAISAL_COLOR_ARGB[2]).toBe(0xffff0000);
  });
});

// ─── Other sections ───────────────────────────────────────────────────
describe('ItemAppraisalText — other retail sections', () => {
  it('melee weapon: damage range, damage type, attack bonus, enchanted damage colour', () => {
    const sword = item({
      ints: { 19: 12000, 5: 250, 353: 2, 204: 5 },
      weaponProfile: {
        damageType: 0x1 | 0x2, weaponTime: 25, weaponSkill: 45, damage: 20, damageVariance: 0.37, damageMod: 1,
        weaponLength: 0, maxVelocity: 0, weaponOffense: 1.1, maxVelocityEstimated: 0,
      },
      weaponEnchantment: { highlight: 0x8, color: 0x8 },
    });
    const out = buildItemAppraisalText(sword, { weenie: { validLocations: 0x100000 } });
    expect(out.text.split('\n')).toEqual([
      'Value: 12,000', 'Burden: 250', '',
      'Skill: Light Weapons (Sword)',
      'Damage: 12.6 - 20, Slashing/Piercing',
      'Elemental Damage Bonus: 5, Slashing/Piercing.',
      'Speed: Fast (25)',
      'Bonus to Attack Skill: +10%.',
      '',
    ]);
    expect(out.lines.find((l) => l.text.startsWith('Damage:'))!.color).toBe(1);
  });

  it('tinkering, set + ratings (extra blank line), workmanship with salvage count', () => {
    const t = item({
      ints: { 171: 3, 105: 20, 170: 3, 265: 13, 370: 3, 374: 2, 379: 10 },
      strings: { 39: 'Tinkerer Bob', 40: 'Imbuer Sue' },
    });
    const lines = buildItemAppraisalText(t, { hasValueBurdenElements: true }).text.split('\n');
    expect(lines).toEqual([
      'This item has been tinkered 3 times.',
      'Last tinkered by Tinkerer Bob.',
      'Imbued by Imbuer Sue.',
      'Workmanship: Flawless (6.67)',
      '',
      'Salvaged from 3 items.',
      '',
      "Set: Soldier's",
      'Ratings: Dam 3, Crit Dam 2.',
      'This item adds 10 Vitality.',
      '', '', '',
    ]);
  });

  it('wield requirement types, activation list, level limits, usage, lock, uses, craftsman, rare, unsellable', () => {
    const t = item({
      ints: {
        158: 8, 159: 34, 160: 3, 270: 2, 271: 45, 272: 300, 273: 12, 274: 0, 275: 13,
        276: 8, 277: 33, 278: 2, 109: 250, 110: 3, 258: 100, 257: 1, 86: 50, 87: 50,
        92: 5, 17: 1234, 38: 25,
      },
      strings: { 14: 'Use this to do things.', 25: 'Aerfalle' },
      bools: { 69: false, 108: true, 3: true },
    });
    const text = buildItemAppraisalText(t, { hasValueBurdenElements: true }).text;
    expect(text).toContain('Wield requires specialized War Magic\nWield requires base Light Weapons 300\nWield requires Olthoi race\nWield requires Trained Life Magic');
    expect(text).toContain('Activation requires Arcane Lore: 250, Allegiance Rank: 3, Strength: 100');
    expect(text.startsWith('Use this to do things.\n\nRestricted to characters of Level 50.\nWield requires specialized')).toBe(true);
    expect(text).toContain('\n\nLocked\nNumber of uses remaining: 5\nCreated by Aerfalle.\nThis item cannot be sold.\n\nThis rare item has a timer restriction of 3 minutes. You will not be able to use another rare item with a timer within 3 minutes of using this one.\n\nRare #1234');
  });

  it('special properties: slayer, imbues, cleaving, cooldown, unique, tether', () => {
    const t = item({
      ints: { 166: 0x1f, 179: 0x1 | 0x80, 36: 9999, 263: 0x10, 279: 1, 292: 2, 280: 7 },
      floats: { 157: 1.2, 136: 2, 167: 300 },
      bools: { 130: true, 91: true },
      dids: { 55: 0x0600 },
    });
    const text = buildItemAppraisalText(t, {
      hasValueBurdenElements: true, sharedCooldownRemainingSeconds: 3725,
      resolvers: { creatureTypeName: (id) => (id === 0x1f ? 'Bael_Zharon' : null) },
    }).text;
    expect(text).toBe([
      'You can only carry 1 of these items.',
      'Cooldown When Used: 5m 0s',
      'Cooldown Remaining: 1h 2m 5s',
      '',
      'Cleave: 2 enemies in front arc.',
      '',
      "Properties: Bael'Zharon's Hate, Critical Strike, Cold Rending, Unenchantable, Retained, Crushing Blow, Resistance Cleaving: Fire, Cast on Strike",
      'This item cannot be further imbued.',
      'This item is tethered to the left side.',
      '',
    ].join('\n'));
  });

  it('caster, heal kit, mana stone, capacity, portal, expiry, decorated description', () => {
    const wand = item({ floats: { 144: 0.05, 152: 1.1 }, ints: { 45: 0x10 } });
    expect(buildItemAppraisalText(wand, { hasValueBurdenElements: true }).text).toContain(
      'Bonus to Mana Conversion: +5%.\n\nDamage bonus for Fire spells:\n vs. Monsters: +10.0%.\n vs. Players: +2.5%.');

    const kit = item({ ints: { 90: 25, 92: 10 }, floats: { 100: 1.15 } });
    expect(buildItemAppraisalText(kit, { hasValueBurdenElements: true, weenie: { objectDescriptionFlags: 0x10000 } }).text)
      .toContain('Bonus to Healing Skill: 25\nRestoration Bonus: 114%');

    const stone = item({ ints: { 107: 5000 }, floats: { 87: 0.5, 137: 0.25 } });
    expect(buildItemAppraisalText(stone, { hasValueBurdenElements: true }).text).toContain('Stored Mana: 5000\nEfficiency: 50%\nChance of Destruction: 25%');

    const pack = item({});
    expect(buildItemAppraisalText(pack, { hasValueBurdenElements: true, weenie: { itemsCapacity: 24, containersCapacity: 0 } }).text)
      .toContain('Can hold up to 24 items.');

    const portal = item({ ints: { 111: 0x2 | 0x10 }, strings: { 38: 'Holtburg' } });
    expect(buildItemAppraisalText(portal, { hasValueBurdenElements: true }).text)
      .toContain('Destination: Holtburg');
    expect(buildItemAppraisalText(portal, { hasValueBurdenElements: true }).text)
      .toContain('Player Killers may not use this portal.\nThis portal cannot be summoned.\n');

    const expiring = item({ ints: { 267: 3600 * 30, 98: 1, 268: 90061 } });
    expect(buildItemAppraisalText(expiring, { hasValueBurdenElements: true }).text)
      .toContain('This item expires in 1 days, 1 hours, 1 minutes, 1 seconds.');

    const deco = item({
      ints: { 172: 0x1 | 0x2 | 0x4, 105: 6, 131: 60, 177: 2, 178: 38 },
      strings: { 16: 'Silver Ring' },
    });
    expect(buildItemAppraisalText(deco, { hasValueBurdenElements: true, resolvers: { materialName: (m) => (m === 60 ? 'Silver' : 'Ruby') } }).text)
      .toContain('Nearly flawless Silver Ring, set with 2 Rubies');
  });

  it('augmentation gems append the ID_Examine_Item_AugmentationCost fragments with no separator', () => {
    expect(acStringHash('ID_Examine_Item_AugmentationCost')).toBe(AUGMENTATION_COST_STRING_ID);
    const gem = item({ int64s: { 3: 2000000000n }, strings: { 15: 'A gem.' } });
    const out = buildItemAppraisalText(gem, { hasValueBurdenElements: true });
    expect(out.text).toBe('A gem.\nUsing this gem will drain 2000000000 points of your available experience.\n');
    expect(out.runs.at(-1)!.separator).toBe('');
  });

  it('levelable item + cloak weave rows', () => {
    const t = item({ int64s: { 5: 1000n, 4: 3500n }, ints: { 319: 5, 320: 2, 352: 2 } });
    expect(buildItemAppraisalText(t, { hasValueBurdenElements: true }).text).toContain(
      'Item Level: 2 / 5\nItem XP: 3,500 / 7,000\n\nThis cloak has a chance to reduce an incoming attack by 200 damage.\n');
  });

  it('shield: base + effective level from the viewer shield skill', () => {
    const t = item({ ints: { 28: 300 } });
    const text = buildItemAppraisalText(t, { hasValueBurdenElements: true, weenie: { validLocations: 0x200000 }, viewerShieldSkill: { current: 400, advancementClass: 2 } }).text;
    expect(text).toContain('Base Shield Level: 300\nEffective Shield Level : 200 (with Shield skill)');
  });

  it('docked-page header strings', () => {
    expect(buildItemValueBurdenHeader({ propertiesInt: new Map([[19, 1234567], [5, 50]]) })).toEqual({ value: 'Value: 1,234,567', burden: '50 Burden Units' });
    expect(buildItemValueBurdenHeader({})).toEqual({ value: 'Value: ???', burden: 'Unknown Burden' });
  });
});

describe('appraisalFormat helpers (retail formatting routines)', () => {
  it('ModifierToString / SmallModifierToString', () => {
    expect(modifierToString(2.1)).toBe('+110%');
    expect(modifierToString(0.75)).toBe('-25%');
    expect(smallModifierToString(1.08)).toBe('+8.0%');
    expect(smallModifierToString(0.95)).toBe('-5.0%');
  });
  it('DamageResistanceToString thresholds + negative sentence', () => {
    expect(damageResistanceToString(0x1, 100, 0)).toBe('Slashing: No  (0)');
    expect(damageResistanceToString(0x1, 100, Math.fround(0.4))).toBe('Slashing: Below Average  (40)');
    expect(damageResistanceToString(0x1, 100, 0.3)).toBe('Slashing: Poor  (30)');
    expect(damageResistanceToString(0x10, 100, 1.7)).toBe('Fire: Excellent  (170)');
    expect(damageResistanceToString(0x10, 100, 2.5)).toBe('Fire: Unparalleled  (200)');
    expect(damageResistanceToString(0x1, 200, -0.44)).toBe('Your armor will rend and slash you if hit.  (-88)');
  });
  it('damage types, workmanship, delta time, %g, commas, coverage, item XP', () => {
    expect(damageTypeToString(0x10000000)).toBe('Prismatic');
    expect(damageTypeToString(0x8 | 0x40)).toBe('Cold/Electrical');
    expect(workmanshipAdjective(2)).toBe('Well-crafted');
    expect(workmanshipAdjective(0)).toBe('crafted');
    expect(workmanshipAdjective(12)).toBe('Priceless');
    expect(deltaTimeToString(59)).toBe('59s');
    expect(deltaTimeToString(2592000 + 60)).toBe('1mo 1m 0s');
    expect(cG(12.6, 4)).toBe('12.6');
    expect(cG(5.25, 3)).toBe('5.25');
    expect(insertCommas(-1234567)).toBe('-1,234,567');
    expect(clothingPriorityToString(0x8 | 0x8000 | 0x10000)).toBe('Covers Chest, Hands, Feet');
    expect(clothingPriorityToString(0)).toBeNull();
    expect(itemTotalXpToLevel(3500n, 1000n, 5, 2)).toBe(2);
    expect(itemLevelToTotalXp(3, 1000n, 5, 2)).toBe(7000n);
    expect(itemLevelToTotalXp(3, 1000n, 5, 3)).toBe(6000n);
    expect(itemTotalXpToLevel(6000n, 1000n, 5, 3)).toBe(3);
  });
});

// ─── DAT-backed: string table + SkillTable/SpellTable resolvers ──────────
describe.skipIf(!existsSync(LANG_DAT) || !existsSync(PORTAL_DAT))('DAT — resolvers + string table', () => {
  let text = '';
  let missileName = '';
  let spellNames: string[] = [];
  beforeAll(async () => {
    const { DatDatabase, DatReader, parseStringTable, SkillTable, SpellTable } = await import('@ac/dat-parser');
    const open = (p: string) => { const b = readFileSync(p); return new DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
    const lang = open(LANG_DAT);
    registerStringTable(parseStringTable(new DatReader(lang.getFileData(0x23000001)!)));
    const portal = open(PORTAL_DAT);
    const skills = new SkillTable(new DatReader(portal.getFileData(0x0e000004)!));
    const spells = new SpellTable(new DatReader(portal.getFileData(0x0e00000e)!));
    missileName = skills.skills.get(47)!.name;
    // EoL renamed the item auras: the screenshot's "Defender IV" / "Blood Drinker IV"
    // are SpellTable 1603 / 1614 "Aura of … Self IV" in the iteration-2072 portal.dat.
    const ids = [1603, 1614];
    spellNames = ids.map((id) => spells.spells.get(id)!.name);
    const gem = item({ int64s: { 3: 250000000n } });
    text = buildItemAppraisalText(gem, { hasValueBurdenElements: true }).text;
    const out = buildItemAppraisalText({ ...bow, spellBook: ids }, {
      ...bowCtx,
      resolvers: {
        spell: (id) => { const s = spells.spells.get(id); return s ? { name: s.name, description: s.desc } : null; },
        skillName: (id) => skills.skills.get(id)?.name,
      },
    });
    spellNames.push(out.text.split('\n').find((l) => l.startsWith('Spells: '))!);
    spellNames.push(out.text.split('\n').find((l) => l.startsWith('Activation requires'))!);
  });

  it('augmentation text comes from StringTable 0x23000001 verbatim', () => {
    expect(text).toBe('\nUsing this gem will drain 250000000 points of your available experience.\n');
  });

  it('SkillTable name for Missile Weapons matches the SkillToString fallback; spells resolve from SpellTable', () => {
    expect(missileName).toBe('Missile Weapons');
    expect(spellNames.slice(0, 2)).toEqual(['Aura of Defender Self IV', 'Aura of Blood Drinker Self IV']);
    expect(spellNames[2]).toBe('Spells: Aura of Defender Self IV, Aura of Blood Drinker Self IV');
    expect(spellNames[3]).toBe('Activation requires Missile Weapons: 230');
  });
});
