/**
 * WeaponType + UseRequires* in the item appraisal (FAITHFUL.316-317).
 *
 * Five `[AssessmentProperty]` PropertyInt fields (ACE
 * `ACE.Entity/Enum/Properties/PropertyInt.cs`):
 *   353 = WeaponType            (enum 1-12 per ACE WeaponType.cs)
 *   366 = UseRequiresSkill      (Skill enum value)
 *   367 = UseRequiresSkillLevel (minimum skill rank)
 *   368 = UseRequiresSkillSpec  (a Skill enum value that must be specialized)
 *   369 = UseRequiresLevel      (minimum character level)
 *
 * Now verifies the end-of-retail wording from the shipped builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts`:
 *  - Appraisal_ShowWeaponAndArmorData @ 004b10e0: WeaponType is a
 *    parenthesised suffix on the Skill line — "Skill: Light Weapons (Sword)";
 *    retail's switch covers 1-10 only (Two Handed / Magic get no suffix).
 *    There is no separate "Weapon Type:" row.
 *  - Appraisal_ShowUsageLimitInfo @ 004b2a70: "Use requires level N.",
 *    "Use requires <skill> of at least N." (skill AND level both needed),
 *    "Use requires specialized <skill>." (368 names a skill, not a number).
 * The @ac/shared weaponTypeLabel helper (ACE enum names) keeps its own pins.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeaponType, weaponTypeLabel, PropertyInt } from '@ac/shared';

const REPO = resolve(__dirname, '..');

describe('weaponTypeLabel helper (FAITHFUL.316)', () => {
  it('Undef (0) → null', () => expect(weaponTypeLabel(0)).toBeNull());
  it('Sword (2) → "Sword"', () => expect(weaponTypeLabel(WeaponType.Sword)).toBe('Sword'));
  it('TwoHanded (11) → "Two Handed" (space-inserted)', () => {
    expect(weaponTypeLabel(WeaponType.TwoHanded)).toBe('Two Handed');
  });
  it('Magic (12) → "Magic"', () => expect(weaponTypeLabel(WeaponType.Magic)).toBe('Magic'));
  it('returns non-null for all named enum members (Unarmed..Magic)', () => {
    for (const k of Object.keys(WeaponType)) {
      if (/^\d+$/.test(k)) continue;
      if (k === 'Undef') continue;
      const id = (WeaponType as any)[k];
      expect(weaponTypeLabel(id), `${k}=${id} returned null`).not.toBeNull();
    }
  });
});

const MELEE_WEAPON = 0x100000; // EquipMask.MeleeWeapon
const sword = (weaponSkill = 45) => ({
  damageType: 1, weaponTime: 30, weaponSkill, damage: 12, damageVariance: 0.2, damageMod: 1,
  weaponLength: 0, maxVelocity: 0, weaponOffense: 1, maxVelocityEstimated: 0,
});
const body = (ints: Array<[number, number]>, weaponSkill?: number): string =>
  buildItemAppraisalText(
    { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints), ...(weaponSkill !== undefined ? { weaponProfile: sword(weaponSkill) } : {}) },
    { hasValueBurdenElements: true, weenie: { validLocations: MELEE_WEAPON } },
  ).text;

describe('Appraisal — WeaponType suffix on the Skill line (FAITHFUL.316, Appraisal_ShowWeaponAndArmorData @ 004b10e0)', () => {
  it('Sword (2) → "Skill: Light Weapons (Sword)"; Dagger (6) → " (Dagger)"', () => {
    expect(body([[PropertyInt.WeaponType, WeaponType.Sword]], 45).split('\n')[0]).toBe('Skill: Light Weapons (Sword)');
    expect(body([[PropertyInt.WeaponType, WeaponType.Dagger]], 46).split('\n')[0]).toBe('Skill: Finesse Weapons (Dagger)');
  });

  it('no suffix for TwoHanded / Magic / Undef / unnamed values, and never a "Weapon Type" row', () => {
    for (const wt of [WeaponType.TwoHanded, WeaponType.Magic, 0, 999]) {
      const t = body([[PropertyInt.WeaponType, wt]], 41);
      expect(t.split('\n')[0]).toBe('Skill: Two Handed Combat');
      expect(t).not.toContain('Weapon Type');
    }
  });
});

describe('Appraisal — UseRequires* (FAITHFUL.317, Appraisal_ShowUsageLimitInfo @ 004b2a70)', () => {
  it('"Use requires <skill> of at least N." needs both the skill and the level', () => {
    expect(body([[PropertyInt.UseRequiresSkill, 6], [PropertyInt.UseRequiresSkillLevel, 250]])).toBe('Use requires Melee Defense of at least 250.');
    expect(body([[PropertyInt.UseRequiresSkill, 6]])).not.toContain('Use requires');
    expect(body([[PropertyInt.UseRequiresSkill, 0], [PropertyInt.UseRequiresSkillLevel, 250]])).not.toContain('Use requires');
  });

  it('UseRequiresSkillSpec names the skill: 34 → "Use requires specialized War Magic."; 0 → nothing', () => {
    expect(body([[PropertyInt.UseRequiresSkillSpec, 34]])).toBe('Use requires specialized War Magic.');
    expect(body([[PropertyInt.UseRequiresSkillSpec, 0]])).not.toContain('Use requires');
  });

  it('"Use requires level N." only when > 0', () => {
    expect(body([[PropertyInt.UseRequiresLevel, 180]])).toBe('Use requires level 180.');
    expect(body([[PropertyInt.UseRequiresLevel, 0]])).not.toContain('Use requires');
  });

  it('all three together, level first, one paragraph', () => {
    expect(body([
      [PropertyInt.UseRequiresLevel, 180], [PropertyInt.UseRequiresSkill, 6],
      [PropertyInt.UseRequiresSkillLevel, 250], [PropertyInt.UseRequiresSkillSpec, 34],
    ])).toBe('Use requires level 180.\nUse requires Melee Defense of at least 250.\nUse requires specialized War Magic.');
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);
const ACE_WEAPONTYPE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/WeaponType.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — 5 PropertyInt IDs + decorators', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  function pin(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('WeaponType = 353 [AssessmentProperty]', () => pin('WeaponType', 353));
  it('UseRequiresSkill = 366 [AssessmentProperty]', () => pin('UseRequiresSkill', 366));
  it('UseRequiresSkillLevel = 367 [AssessmentProperty]', () => pin('UseRequiresSkillLevel', 367));
  it('UseRequiresSkillSpec = 368 [AssessmentProperty]', () => pin('UseRequiresSkillSpec', 368));
  it('UseRequiresLevel = 369 [AssessmentProperty]', () => pin('UseRequiresLevel', 369));
});

describe.skipIf(!aceReferenceExists(ACE_WEAPONTYPE))('ACE source pin — WeaponType.cs enum order', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_WEAPONTYPE, 'utf8'); });

  it('Undef, Unarmed, Sword, Axe, Mace, Spear, Dagger, Staff, Bow, Crossbow, Thrown, TwoHanded, Magic — in that order', () => {
    const m = src.match(/enum WeaponType\s*\{([\s\S]+?)\}/);
    expect(m).not.toBeNull();
    const members = m![1]
      .split('\n')
      .map((l) => l.trim().split(/[\s,]/)[0])
      .filter((s) => /^[A-Z]\w+$/.test(s));
    expect(members).toEqual([
      'Undef', 'Unarmed', 'Sword', 'Axe', 'Mace', 'Spear', 'Dagger', 'Staff',
      'Bow', 'Crossbow', 'Thrown', 'TwoHanded', 'Magic',
    ]);
  });
});
