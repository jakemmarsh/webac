/**
 * WeaponProfile.weaponSkill surfaced in the item appraisal (FAITHFUL.298).
 *
 * `wp.weaponSkill` is the third uint32 of WeaponProfile.Write (ACE
 * `Network/Structure/WeaponProfile.cs`); PropertyInt.WeaponSkill (48) is
 * `[AssessmentProperty]`, so retail shows it.
 *
 * Now verifies the shipped end-of-retail builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts`,
 * Appraisal_ShowWeaponAndArmorData @ 004b10e0:
 *  - "Skill: <name>" is the FIRST weapon line, named by
 *    AppraisalSystem::SkillToString's table; an unknown/0 skill writes no
 *    Skill line (the rest of the weapon block still renders);
 *  - then "Damage: <min> - <max>, <type>" — one line (the old invented
 *    "Damage Type:" / "Max Damage:" rows are not retail);
 *  - damageMod appears only on a launcher, as "Damage Modifier: +N%."
 *    (ModifierToString), and weaponOffense only on a non-launcher, as
 *    "Bonus to Attack Skill: ±N%." — a single sign either way
 *    (BUG.appraisal-modifier-doubled-sign); 1.0 writes neither line.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

const ACE_PROFILE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Structure/WeaponProfile.cs',
);
const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROFILE))('ACE-source pin — WeaponProfile.weaponSkill is the 3rd uint32 on the wire', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROFILE, 'utf8');
  });

  it('Write emits WeaponSkill as the third field (after DamageType + WeaponTime)', () => {
    const m = src.match(/public static void Write\(this BinaryWriter writer, WeaponProfile profile\)\s*\{([\s\S]+?)\}/);
    expect(m).not.toBeNull();
    const writes = [...m![1].matchAll(/writer\.Write\(\s*\(?\s*(?:uint\))?\s*profile\.(\w+)\s*\)/g)].map(x => x[1]);
    expect(writes[0]).toBe('DamageType');
    expect(writes[1]).toBe('WeaponTime');
    expect(writes[2]).toBe('WeaponSkill');
  });
});

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE-source pin — PropertyInt.WeaponSkill is value 48 + [AssessmentProperty]', () => {
  let src: string;
  beforeAll(() => {
    src = readFileSync(ACE_PROPINT, 'utf8');
  });

  it('WeaponSkill = 48 in PropertyInt enum', () => {
    expect(src).toMatch(/WeaponSkill\s*=\s*48/);
  });

  it('has [AssessmentProperty] decorator above WeaponSkill (so retail shows it on appraisal)', () => {
    // Search a windowed slice around the WeaponSkill = 48 line for the
    // [AssessmentProperty] decorator. ACE puts these on a line BEFORE the
    // enum member with at most ~4 other decorator lines in between.
    const idx = src.indexOf('WeaponSkill                              = 48');
    expect(idx).toBeGreaterThan(0);
    const window = src.slice(Math.max(0, idx - 400), idx);
    expect(window).toMatch(/\[AssessmentProperty\]/);
  });
});

const MELEE_WEAPON = 0x100000; // EquipMask.MeleeWeapon
const MISSILE_WEAPON = 0x400000; // EquipMask.MissileWeapon

function baseWeaponProfile(overrides: Partial<NonNullable<IdentifyResponseData['weaponProfile']>> = {}): NonNullable<IdentifyResponseData['weaponProfile']> {
  return {
    damageType: 1, // Slashing
    weaponTime: 30,
    weaponSkill: 44, // HeavyWeapons
    damage: 12,
    damageVariance: 0.2,
    damageMod: 1.0,
    weaponLength: 0,
    maxVelocity: 0,
    weaponOffense: 1.0,
    maxVelocityEstimated: 0,
    ...overrides,
  };
}

/** The appraisal body lines for a weapon (docked page: no Value/Burden lines). */
function weaponLines(wp: Partial<NonNullable<IdentifyResponseData['weaponProfile']>>, validLocations = MELEE_WEAPON, ammoType = 0): string[] {
  return buildItemAppraisalText({ guid: 0x80001111, flags: 0, weaponProfile: baseWeaponProfile(wp) }, {
    hasValueBurdenElements: true, weenie: { validLocations, ammoType },
  }).text.split('\n');
}

describe('Appraisal — weapon Skill line (FAITHFUL.298, Appraisal_ShowWeaponAndArmorData @ 004b10e0)', () => {
  it('weaponSkill=44 → "Skill: Heavy Weapons", the first weapon line', () => {
    expect(weaponLines({ weaponSkill: 44 })).toEqual(['Skill: Heavy Weapons', 'Damage: 9.6 - 12, Slashing', 'Speed: Fast (30)', '']);
  });

  it('Skill comes before the combined Damage line (no separate Damage Type / Max Damage rows)', () => {
    const lines = weaponLines({ weaponSkill: 45 });
    expect(lines.indexOf('Skill: Light Weapons')).toBe(0);
    expect(lines.indexOf('Damage: 9.6 - 12, Slashing')).toBe(1);
    expect(lines.some((l) => /^(Damage Type|Max Damage):/.test(l))).toBe(false);
  });

  it('weaponSkill === 0 writes no Skill line; the rest of the weapon block still renders', () => {
    const lines = weaponLines({ weaponSkill: 0 });
    expect(lines.some((l) => l.startsWith('Skill:'))).toBe(false);
    expect(lines[0]).toBe('Damage: 9.6 - 12, Slashing');
  });

  it('weaponSkill=47 → "Skill: Missile Weapons"; a melee Piercing weapon names its type in the Damage line', () => {
    expect(weaponLines({ weaponSkill: 47 }, MISSILE_WEAPON, 1)[0]).toBe('Skill: Missile Weapons');
    expect(weaponLines({ damageType: 2 })[1]).toBe('Damage: 9.6 - 12, Piercing');
  });
});

describe('Appraisal — damage modifier / attack bonus signs (BUG.appraisal-modifier-doubled-sign)', () => {
  it('a launcher with damageMod=1.15 reads "Damage Modifier: +15%."', () => {
    expect(weaponLines({ weaponSkill: 47, damageMod: 1.15, maxVelocity: 20 }, MISSILE_WEAPON, 1)).toContain('Damage Modifier: +15%.');
  });

  it('a launcher with damageMod=0.85 (debuff) reads "Damage Modifier: -15%.", not "+-15%"', () => {
    const lines = weaponLines({ weaponSkill: 47, damageMod: 0.85, maxVelocity: 20 }, MISSILE_WEAPON, 1);
    expect(lines).toContain('Damage Modifier: -15%.');
    expect(lines.join('\n')).not.toContain('+-');
  });

  it('weaponOffense=0.9 (debuff) reads "Bonus to Attack Skill: -10%.", not "+-10%"; 1.15 reads "+15%."', () => {
    const lines = weaponLines({ weaponOffense: 0.9 });
    expect(lines).toContain('Bonus to Attack Skill: -10%.');
    expect(lines.join('\n')).not.toContain('+-');
    expect(weaponLines({ weaponOffense: 1.15 })).toContain('Bonus to Attack Skill: +15%.');
  });

  it('damageMod/weaponOffense at the 1.0 default write neither line; a melee weapon never shows Damage Modifier', () => {
    const text = weaponLines({ damageMod: 1.0, weaponOffense: 1.0 }).join('\n');
    expect(text).not.toContain('Bonus to Attack Skill');
    expect(weaponLines({ damageMod: 1.15 }).join('\n')).not.toContain('Damage Modifier');
  });
});
