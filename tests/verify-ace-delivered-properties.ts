/**
 * What ACE actually delivers about an object, and the readers that depended on what it doesn't.
 *
 * 2026-11-17 sweep (bug class: summoning essences identified by PetClass 266, which ACE never
 * appraises; fixtures carried 266 so tests passed while the feature was dead live):
 *  - packages/shared/src/appraisal/aceDeliveredProperties.ts is pinned here to ACE's own
 *    [AssessmentProperty] / [SendOnLogin] tags and AppraiseInfo's computed additions.
 *  - Weapon / armor numbers arrive only in the appraisal's profiles; Mag-Tools' item line and
 *    loot rules read them as properties (foldAppraisalProfiles).
 *  - The Mag-Tools mana tracker read ValidLocations / CurrentWieldedLocation / Spell from the
 *    appraisal; ACE sends them only in CreateObject (mtWornItemOf).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACE_APPRAISAL_PROPERTIES, ACE_LOGIN_PROPERTIES, aceAppraisalCarries, aceShapedAppraisal, propertiesAceNeverAppraises,
  foldAppraisalProfiles, mtWornItemOf, MtManaTracker, mtItemInfo, MtObjectClass,
  type AppraisalPropertyKind, type MtWornAppraisal,
} from '@ac/shared';
import { aceReferenceExists } from './_harness/reference.js';
import { aceAppraisal } from './_harness/aceAppraisal.js';

const ACE_SRC = resolve(__dirname, '../reference/ACE/Source');
const PROPS_DIR = resolve(ACE_SRC, 'ACE.Entity/Enum/Properties');
const APPRAISE_INFO = resolve(ACE_SRC, 'ACE.Server/Network/Structure/AppraiseInfo.cs');

/** Parse one ACE Property*.cs enum: name → id, plus the ids carrying each attribute. */
function parseEnum(file: string): { names: Map<string, number>; tagged: (attr: string) => Set<number> } {
  const src = readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('{', src.indexOf('enum ')) + 1);
  const names = new Map<string, number>();
  const attrsOf = new Map<number, string[]>();
  let attrs: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('}')) break;
    let rest = line;
    const am = line.match(/^((?:\[[^\]]+\])+)\s*(.*)$/);
    if (am) { attrs.push(...am[1].match(/\[([^\]]+)\]/g)!.map((s) => s.slice(1, -1))); rest = am[2]; if (!rest) continue; }
    const m = rest.match(/^(\w+)\s*=\s*(-?\w+)/);
    if (!m) { attrs = []; continue; }
    names.set(m[1], Number(m[2]));
    attrsOf.set(Number(m[2]), attrs);
    attrs = [];
  }
  return { names, tagged: (attr) => new Set([...attrsOf].filter(([, a]) => a.some((x) => x.startsWith(attr))).map(([id]) => id)) };
}

const FILES: Record<AppraisalPropertyKind | 'iid', string> = {
  int: 'PropertyInt.cs', int64: 'PropertyInt64.cs', bool: 'PropertyBool.cs', float: 'PropertyFloat.cs',
  string: 'PropertyString.cs', did: 'PropertyDataId.cs', iid: 'PropertyInstanceId.cs',
};
const sorted = (s: Iterable<number>) => [...s].sort((a, b) => a - b);

describe.skipIf(!aceReferenceExists(APPRAISE_INFO))('the tables match ACE (reference/ACE)', () => {
  let enums: Record<string, ReturnType<typeof parseEnum>>;
  let computed: Record<string, Set<number>>;
  beforeAll(() => {
    enums = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, parseEnum(resolve(PROPS_DIR, f))]));
    // AppraiseInfo.BuildProfile's own additions: `PropertiesX[PropertyX.Name] = …` and `PropertiesX.Add(PropertyX.Name …`.
    const src = readFileSync(APPRAISE_INFO, 'utf8');
    const kindOf: Record<string, AppraisalPropertyKind> = {
      PropertiesInt: 'int', PropertiesInt64: 'int64', PropertiesBool: 'bool', PropertiesFloat: 'float', PropertiesString: 'string', PropertiesDID: 'did',
    };
    computed = {};
    for (const m of src.matchAll(/(Properties(?:Int64|Int|Bool|Float|String|DID))(?:\[Property\w+\.(\w+)\]\s*(?:=|\+=)|\.Add\(Property\w+\.(\w+))/g)) {
      const kind = kindOf[m[1]];
      const id = enums[kind].names.get(m[2] ?? m[3]!);
      expect(id, `${m[0]} names a known property`).toBeTypeOf('number');
      (computed[kind] ??= new Set()).add(id!);
    }
  });

  it('appraisal = [AssessmentProperty] tags ∪ what AppraiseInfo computes, per kind', () => {
    for (const kind of ['int', 'int64', 'bool', 'float', 'string', 'did'] as const) {
      const expected = new Set([...enums[kind].tagged('AssessmentProperty'), ...(computed[kind] ?? [])]);
      expect(sorted(ACE_APPRAISAL_PROPERTIES[kind]), kind).toEqual(sorted(expected));
    }
  });

  it('login = [SendOnLogin] tags, per kind', () => {
    for (const kind of Object.keys(FILES) as Array<keyof typeof FILES>) {
      expect(sorted(ACE_LOGIN_PROPERTIES[kind]), kind).toEqual(sorted(enums[kind].tagged('SendOnLogin')));
    }
  });

  it('AppraiseInfo writes no InstanceId table (none is tagged, and the writer has no IID section)', () => {
    expect(enums.iid.tagged('AssessmentProperty').size).toBe(0);
    expect(readFileSync(APPRAISE_INFO, 'utf8')).not.toMatch(/writer\.Write\(info\.PropertiesIID\)/);
  });
});

describe('fixture realism guard', () => {
  it('names every property ACE never appraises (PetClass 266, ValidLocations 9, Setup DID 1, Name 1)', () => {
    expect(aceAppraisalCarries('int', 266)).toBe(false);
    expect(aceAppraisalCarries('int', 362)).toBe(false); // SummoningMastery: [SendOnLogin], your own character only
    expect(propertiesAceNeverAppraises({
      int: new Map([[266, 3], [19, 50], [9, 0x2000000]]), did: { 1: 0x02000001, 55: 1 }, string: new Map([[1, 'Essence']]),
    })).toEqual(['int 266', 'int 9', 'string 1', 'did 1']);
    expect(() => aceShapedAppraisal({ int: { 266: 3 } })).toThrow(/int 266/);
  });

  it('passes a server-shaped appraisal through, and the test harness refuses an InstanceId table', () => {
    const ok = { guid: 1, flags: 0, propertiesInt: new Map([[19, 50], [5, 10], [366, 54], [367, 100]]) };
    expect(aceAppraisal(ok)).toBe(ok);
    expect(() => aceAppraisal({ guid: 1, flags: 0, propertiesInstanceID: new Map([[3, 5]]) })).toThrow(/InstanceId/);
  });
});

// ─── Weapon / armor profiles as properties ─────────────────────────────

/** A Yumi as ACE appraises it: Value / Burden / WeaponDefense as properties, the rest in the WeaponProfile. */
const yumiInts = { 19: 1200, 5: 600, 353: 8 };
const yumiFloats = { 29: 1.1 };
const yumiProfile = { damageType: 0x2, weaponTime: 40, weaponSkill: 47, damage: 18, damageVariance: 0.25, damageMod: 1.4, weaponOffense: 1.05 };

describe('foldAppraisalProfiles', () => {
  it('writes the weapon profile in under Damage 44 / DamageType 45 / WeaponSkill 48 / WeaponTime 49 / Variance 22 / Offense 62 / DamageMod 63', () => {
    aceShapedAppraisal({ int: yumiInts, float: yumiFloats });
    const f = foldAppraisalProfiles(yumiInts, yumiFloats, yumiProfile, null);
    expect(f.int).toMatchObject({ 19: 1200, 5: 600, 44: 18, 45: 2, 48: 47, 49: 40 });
    expect(f.float).toMatchObject({ 29: 1.1, 22: 0.25, 62: 1.05, 63: 1.4 });
    expect(f.float[26]).toBeUndefined(); // MaxVelocity's 1.0 is ACE's "none stored" placeholder, not a stat
  });

  it('writes the armor profile in under ArmorModVs* 13–19 and Nether 165', () => {
    const armor = { slashing: 1, piercing: 0.8, bludgeoning: 0.6, cold: 0.4, fire: 0.5, acid: 0.3, nether: 0.2, lightning: 0.7 };
    expect(foldAppraisalProfiles({ 28: 120 }, {}, null, armor).float).toEqual({ 13: 1, 14: 0.8, 15: 0.6, 16: 0.4, 17: 0.5, 18: 0.3, 19: 0.7, 165: 0.2 });
  });

  it('a property the server sent wins (GDLE appraises Damage too); a failed appraisal\'s Unknown profile adds nothing', () => {
    expect(foldAppraisalProfiles({ 44: 20 }, {}, yumiProfile).int[44]).toBe(20);
    expect(foldAppraisalProfiles({}, {}, { ...yumiProfile, weaponTime: -1, damage: -1 })).toEqual({ int: {}, float: {} });
  });

  it('Mag-Tools\' item line shows the damage range and bonuses of an ACE-appraised weapon', () => {
    const item = (int: Record<number, number>, float: Record<number, number>) => mtItemInfo(
      { id: 1, name: 'Yumi', objectClass: MtObjectClass.MissileWeapon, int, float, spells: [] },
      { showBuffedValues: false, showValueAndBurden: false },
    );
    const raw = item(yumiInts, yumiFloats);
    expect(raw).toBe('Yumi (Bow), 10%md'); // what it printed before: the profile never reached it
    const f = foldAppraisalProfiles(yumiInts, yumiFloats, yumiProfile);
    const line = item(f.int, f.float);
    expect(line).toBe('Yumi (Bow), 13.50-18, +40%, +5%a, 10%md');
    expect(line).toContain('+40%');
    expect(line).toContain('+5%a');
  });
});

// ─── Mag-Tools mana tracker: CreateObject fields, not appraisal ────────

describe('mtWornItemOf: the worn item\'s slots and spell come from CreateObject', () => {
  const appraised = (int: Record<number, number>, extra: Partial<MtWornAppraisal> = {}): MtWornAppraisal => {
    // Server-shaped: what ACE puts in a worn item's appraisal (no ValidLocations 9, no CurrentWieldedLocation 10, no Spell DID 28).
    aceShapedAppraisal({ int, float: { 5: -0.05 }, bool: extra.bool ?? {} });
    return { int, float: { 5: -0.05 }, bool: {}, did: {}, spellIds: [], activeSpellIds: [], at: 0, ...extra };
  };
  const spells: Record<number, { name: string; family: number; difficulty: number }> = {
    2000: { name: 'Major Strength', family: 1, difficulty: 50 }, 3000: { name: 'Item use spell', family: 9, difficulty: 10 },
  };
  const spell = (id: number) => (spells[id] ? { id, ...spells[id] } : null);
  const ench = (id: number) => (spells[id] ? { family: spells[id].family, difficulty: spells[id].difficulty } : null);
  const CLOAK = 0x08000000, AMMO = 0x00800000, CHEST = 0x00000200;

  it('a cloak is hidden and ammunition is hidden and not counted unretained, from the worn entry alone', () => {
    const worn = [
      mtWornItemOf({ id: 1, name: 'Cloak', slot: CLOAK, validLocations: CLOAK }, appraised({ 107: 100, 108: 100 }), spell, ench, 0),
      mtWornItemOf({ id: 2, name: 'Arrows', slot: AMMO, validLocations: AMMO }, appraised({}), spell, ench, 0),
      mtWornItemOf({ id: 3, name: 'Breastplate', slot: CHEST, validLocations: CHEST }, appraised({}), spell, ench, 0),
    ];
    const t = new MtManaTracker({ worn: () => worn, playerEnchantments: () => [], now: () => 0 });
    const rows = t.rows();
    expect(rows.find((r) => r.id === 1)!.hidden).toBe(true);
    expect(rows.find((r) => r.id === 2)!.hidden).toBe(true);
    expect(rows.find((r) => r.id === 3)!.hidden).toBe(false);
    expect(t.unretainedText()).toBe('Unretained Items: 2');
  });

  it('the item\'s own use spell (CreateObject Spell) is never required to be active', () => {
    const a = appraised({ 107: 50, 108: 100 }, { spellIds: [3000, 2000], activeSpellIds: [2000] });
    const w = mtWornItemOf({ id: 4, name: 'Orb', slot: 0x01000000, spellDid: 3000 }, a, spell, ench, 0);
    expect(w.associatedSpellId).toBe(3000);
    const t = new MtManaTracker({ worn: () => [w], playerEnchantments: () => [], now: () => 0 });
    expect(t.rows()[0].state).toBe('Active');
    // Without the CreateObject spell the use spell counted, and the orb read Not Active.
    const bare = mtWornItemOf({ id: 4, name: 'Orb', slot: 0x01000000 }, a, spell, ench, 0);
    expect(new MtManaTracker({ worn: () => [bare], playerEnchantments: () => [], now: () => 0 }).rows()[0].state).toBe('NotActive');
  });

  it('a GDLE appraisal that does carry ValidLocations / CurrentWieldedLocation / Spell still fills in', () => {
    const gdle: MtWornAppraisal = { int: { 9: CLOAK, 10: CLOAK }, float: {}, bool: {}, did: { 28: 3000 }, spellIds: [], activeSpellIds: [] };
    const w = mtWornItemOf({ id: 5, name: 'Cloak', slot: 0 }, gdle, spell, ench, 7);
    expect(w).toMatchObject({ validLocations: CLOAK, wieldedLocation: CLOAK, associatedSpellId: 3000, manaUpdatedAt: 7 });
  });
});
