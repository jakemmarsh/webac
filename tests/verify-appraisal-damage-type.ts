/**
 * Weapon damage type surfaced in appraisal (FAITHFUL.295 +
 * VISUAL.examine-damage-type-composite-raw-enum).
 *
 * Originally a source-pin test for FAITHFUL.295's "Damage Type" row wiring
 * (regex against GameUI.ts source); converted to behavioral tests of the
 * real @ac/shared exports when composite-mask formatting was fixed for
 * VISUAL.examine-damage-type-composite-raw-enum.
 *
 * Ground truth — retail `AppraisalSystem::DamageTypeToString` @ 005b4200
 * (reference/client-eol/decomp/acclient-decompiled.c:422307):
 *  - Walks DAMAGE_TYPE bits in order Slash, Pierce, Bludgeon, Cold, Fire,
 *    Acid, Electric, Nether, Base and concatenates one name per set bit,
 *    so composite masks (multi-strike weapons like Sword of Lost Light,
 *    Slash|Pierce = 3) render "Slashing/Piercing" — never a raw enum
 *    number ("DamageType #3", the pre-fix behavior).
 *  - The join separator is "/" — the acclient string table carries the
 *    "/"-prefixed append variants ("/Piercing", "/Bludgeoning", "/Cold",
 *    "/Fire", "/Acid", "/Electrical", "/Nether", "/Prismatic") right next
 *    to the bare forms (strings 24828-24846 in the binary).
 *  - Electric renders "Electrical" and Base renders "Prismatic" — these
 *    differ from ACE's server-side DamageType.GetName ("Electric"/"Base"),
 *    which damageTypeName mirrors for combat chat.
 *  - Drain bits (Health/Stamina/Mana) are NOT in the walk; a mask with no
 *    walked bit leaves the output buffer empty. Callers skip the row then.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appraisalDamageTypeToString, damageTypeName } from '@ac/shared';

const REPO = resolve(__dirname, '..');

describe('appraisalDamageTypeToString — retail composite formatting @ 005b4200', () => {
  it('Slash|Pierce (3, Sword of Lost Light) → "Slashing/Piercing" — not "DamageType #3"', () => {
    expect(appraisalDamageTypeToString(0x3)).toBe('Slashing/Piercing');
  });

  it('single bits render the retail bare names', () => {
    expect(appraisalDamageTypeToString(0x1)).toBe('Slashing');
    expect(appraisalDamageTypeToString(0x2)).toBe('Piercing');
    expect(appraisalDamageTypeToString(0x4)).toBe('Bludgeoning');
    expect(appraisalDamageTypeToString(0x8)).toBe('Cold');
    expect(appraisalDamageTypeToString(0x10)).toBe('Fire');
    expect(appraisalDamageTypeToString(0x20)).toBe('Acid');
    expect(appraisalDamageTypeToString(0x400)).toBe('Nether');
  });

  it('Electric (0x40) → retail "Electrical", not ACE GetName "Electric"', () => {
    expect(appraisalDamageTypeToString(0x40)).toBe('Electrical');
  });

  it('Base (0x10000000) → retail "Prismatic", not ACE GetName "Base"', () => {
    expect(appraisalDamageTypeToString(0x10000000)).toBe('Prismatic');
  });

  it('walk order is fixed regardless of numeric magnitude — Nether|Cold → "Cold/Nether"', () => {
    expect(appraisalDamageTypeToString(0x408)).toBe('Cold/Nether');
  });

  it('three-way physical composite → "Slashing/Piercing/Bludgeoning"', () => {
    expect(appraisalDamageTypeToString(0x7)).toBe('Slashing/Piercing/Bludgeoning');
  });

  it('Base combines like any other bit — Slash|Base → "Slashing/Prismatic"', () => {
    expect(appraisalDamageTypeToString(0x10000001)).toBe('Slashing/Prismatic');
  });

  it('Undef (0) → "" (caller skips the row)', () => {
    expect(appraisalDamageTypeToString(0)).toBe('');
  });

  it('drain-only masks (Health/Stamina/Mana) → "" exactly like the retail walk', () => {
    expect(appraisalDamageTypeToString(0x80)).toBe('');
    expect(appraisalDamageTypeToString(0x100)).toBe('');
    expect(appraisalDamageTypeToString(0x200)).toBe('');
    expect(appraisalDamageTypeToString(0x80 | 0x100 | 0x200)).toBe('');
  });

  it('drain bits mixed into a weapon mask contribute nothing — Slash|Health → "Slashing"', () => {
    expect(appraisalDamageTypeToString(0x81)).toBe('Slashing');
  });
});

describe('damageTypeName — ACE GetName forms unchanged (combat-chat contract)', () => {
  // CombatDialog / CombatController lowercase these inside chat sentences
  // ("...for X points of slashing damage") — the appraisal fix must NOT
  // leak retail's "Electrical"/"Prismatic" into the server-text mirror.
  it('Slash (0x1) → "Slashing"', () => expect(damageTypeName(0x1)).toBe('Slashing'));
  it('Pierce (0x2) → "Piercing"', () => expect(damageTypeName(0x2)).toBe('Piercing'));
  it('Bludgeon (0x4) → "Bludgeoning"', () => expect(damageTypeName(0x4)).toBe('Bludgeoning'));
  it('Cold (0x8) → "Cold"', () => expect(damageTypeName(0x8)).toBe('Cold'));
  it('Fire (0x10) → "Fire"', () => expect(damageTypeName(0x10)).toBe('Fire'));
  it('Acid (0x20) → "Acid"', () => expect(damageTypeName(0x20)).toBe('Acid'));
  it('Electric (0x40) → "Electric" (ACE form, NOT "Electrical")', () => expect(damageTypeName(0x40)).toBe('Electric'));
  it('Nether (0x400) → "Nether"', () => expect(damageTypeName(0x400)).toBe('Nether'));
  it('Base (0x10000000) → "Base" (ACE form, NOT "Prismatic")', () => expect(damageTypeName(0x10000000)).toBe('Base'));
});

describe('ACE-source pin — WeaponProfile.damageType is the FIRST field on the wire', () => {
  const ACE_SRC = resolve(
    REPO,
    'reference/ACE/Source/ACE.Server/Network/Structure/WeaponProfile.cs',
  );

  it('WeaponProfileExtensions.Write writes DamageType as the first field', () => {
    try {
      const src = readFileSync(ACE_SRC, 'utf8');
      const m = src.match(/public static void Write\(this BinaryWriter writer, WeaponProfile profile\)\s*\{([\s\S]+?)\}/);
      expect(m).not.toBeNull();
      const writes = [...m![1].matchAll(/writer\.Write\(\s*\(?\s*(?:uint\))?\s*profile\.(\w+)\s*\)/g)].map(x => x[1]);
      expect(writes[0]).toBe('DamageType');
    } catch (e) {
      // ACE source not present (CI / packagers without `reference/` git submodule)
      // — skip rather than fail the suite. Local dev / regression runs DO have
      // it and surface drift.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  });
});
