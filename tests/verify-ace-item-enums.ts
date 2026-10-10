/**
 * Runtime audit for item-/material-related ACE enums:
 *   - MaterialType         (78 entries) — rides every item's PropertyInt.MaterialType
 *   - CreatureType         (102 entries) — rides every creature's PropertyInt.CreatureType
 *   - AmmoType             (10 bits) — packed bitmask used by missile-routing
 *   - ArmorType            (7 entries) — armor classification for damage-mod tables
 *   - AttunedStatus        (3 entries) — auto-numbered, drives "Attuned" tooltip line
 *   - BondedStatus         (5 entries; signed, includes -2/-1) — "Bonded" tooltip line
 *   - AttackType           (16 canonical bits + 8 composite aggregates) — combat AI dispatch
 *   - MagicSchool          (6 entries) — every spell descriptor + spellbar tabs
 *
 * Each enum is anchored against ACE source; mismatches fail the test. AttackType
 * uses a custom equivalence helper because the TS port carries the composite
 * aliases as `ATTACK_TYPE_*` consts rather than enum entries (C# inline-OR
 * expressions can't be re-evaluated by the regex parser).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MaterialType,
} from '../packages/shared/src/loot/MaterialTypes.js';
import {
  CreatureType,
  AmmoType,
  ArmorType,
  AttunedStatus,
  BondedStatus,
  AttackType,
  ATTACK_TYPE_UNARMED,
  ATTACK_TYPE_DOUBLE_STRIKE,
  ATTACK_TYPE_TRIPLE_STRIKE,
  ATTACK_TYPE_OFFHAND,
  ATTACK_TYPE_THRUSTS,
  ATTACK_TYPE_SLASHES,
  ATTACK_TYPE_PUNCHES,
  ATTACK_TYPE_MULTI_STRIKE,
} from '../packages/shared/src/index.js';
import { MagicSchool } from '../packages/shared/src/magic/SpellEngine.js';

const REPO = resolve(__dirname, '..');
const MAT_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs');
const CT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CreatureType.cs');
const AMM_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AmmoType.cs');
const ART_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ArmorType.cs');
const AS_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AttunedStatus.cs');
const BS_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/BondedStatus.cs');
const AT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AttackType.cs');
const MS_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MagicSchool.cs');

interface AceEntry { name: string; value: number; }

function parseAceNumeric(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = re.exec(line);
    if (m) {
      const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      out.push({ name: m[1], value });
    }
  }
  return out;
}

function parseAceAutoNumbered(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  let index = 0;
  const ID_RE = /^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trimEnd();
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = ID_RE.exec(line);
    if (m) {
      out.push({ name: m[1], value: index });
      index++;
    }
  }
  return out;
}

function tsNamesOf(enumObj: Record<string, unknown>): string[] {
  return Object.keys(enumObj).filter((k) => Number.isNaN(Number(k)));
}

// ─── MaterialType ───────────────────────────────────────────

describe('ACE MaterialType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(MAT_PATH, 'MaterialType');

  it('parses ACE source successfully', () => {
    expect(existsSync(MAT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(78);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MaterialType.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (MaterialType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(MaterialType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── CreatureType ───────────────────────────────────────────

describe('ACE CreatureType coverage (runtime audit)', () => {
  // ACE source is auto-numbered (Invalid=0, Olthoi=1, ..., Anekshay=101).
  const aceEntries = parseAceAutoNumbered(CT_PATH, 'CreatureType');

  it('parses ACE source successfully', () => {
    expect(existsSync(CT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(102);
    expect(aceEntries[0]?.name).toBe('Invalid');
    expect(aceEntries[aceEntries.length - 1]?.name).toBe('Anekshay');
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CreatureType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (CreatureType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(CreatureType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── AmmoType ───────────────────────────────────────────────

describe('ACE AmmoType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(AMM_PATH, 'AmmoType');

  it('parses ACE source successfully', () => {
    expect(existsSync(AMM_PATH)).toBe(true);
    expect(aceEntries.length).toBe(10);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AmmoType.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (AmmoType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(AmmoType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── ArmorType ──────────────────────────────────────────────

describe('ACE ArmorType coverage (runtime audit)', () => {
  // ACE source is auto-numbered with explicit powers-of-2.
  const aceEntries = parseAceNumeric(ART_PATH, 'ArmorType');

  it('parses ACE source successfully', () => {
    expect(existsSync(ART_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(7);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ArmorType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (ArmorType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(ArmorType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── AttunedStatus ──────────────────────────────────────────

describe('ACE AttunedStatus coverage (runtime audit)', () => {
  // ACE source is auto-numbered (Normal=0, Attuned=1, Sticky=2).
  const aceEntries = parseAceAutoNumbered(AS_PATH, 'AttunedStatus');

  it('parses ACE source successfully', () => {
    expect(existsSync(AS_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AttunedStatus.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (AttunedStatus as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(AttunedStatus as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── BondedStatus ───────────────────────────────────────────

describe('ACE BondedStatus coverage (runtime audit)', () => {
  // ACE source uses explicit negative values (Destroy=-2, Slippery=-1) plus 0/1/2.
  const aceEntries = parseAceNumeric(BS_PATH, 'BondedStatus');

  it('parses ACE source successfully', () => {
    expect(existsSync(BS_PATH)).toBe(true);
    expect(aceEntries.length).toBe(5);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'BondedStatus.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (BondedStatus as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(BondedStatus as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── AttackType ─────────────────────────────────────────────

describe('ACE AttackType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(AT_PATH, 'AttackType');

  it('parses ACE source successfully', () => {
    expect(existsSync(AT_PATH)).toBe(true);
    // 16 canonical bits (Undef + 15 attack bits). The 8 composite aliases
    // (Unarmed, DoubleStrike, TripleStrike, Offhand, Thrusts, Slashes,
    // Punches, MultiStrike) use bitwise-OR RHS and are skipped by the
    // numeric-only parser.
    expect(aceEntries.length).toBe(16);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AttackType.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (AttackType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(AttackType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  // Composite-alias pins — these are stored as exported consts (not enum
  // entries), so we re-derive the expected aggregates inline and compare.
  it('composite aliases match ACE source bitwise-OR aggregates', () => {
    expect(ATTACK_TYPE_UNARMED).toBe(AttackType.Punch | AttackType.Kick | AttackType.OffhandPunch);
    expect(ATTACK_TYPE_DOUBLE_STRIKE).toBe(
      AttackType.DoubleSlash | AttackType.DoubleThrust |
      AttackType.OffhandDoubleSlash | AttackType.OffhandDoubleThrust,
    );
    expect(ATTACK_TYPE_TRIPLE_STRIKE).toBe(
      AttackType.TripleSlash | AttackType.TripleThrust |
      AttackType.OffhandTripleSlash | AttackType.OffhandTripleThrust,
    );
    expect(ATTACK_TYPE_OFFHAND).toBe(
      AttackType.OffhandThrust | AttackType.OffhandSlash |
      AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash |
      AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust,
    );
    expect(ATTACK_TYPE_THRUSTS).toBe(
      AttackType.Thrust | AttackType.DoubleThrust | AttackType.TripleThrust |
      AttackType.OffhandThrust | AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust,
    );
    expect(ATTACK_TYPE_SLASHES).toBe(
      AttackType.Slash | AttackType.DoubleSlash | AttackType.TripleSlash |
      AttackType.OffhandSlash | AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash,
    );
    expect(ATTACK_TYPE_PUNCHES).toBe(AttackType.Punch | AttackType.OffhandPunch);
    expect(ATTACK_TYPE_MULTI_STRIKE).toBe(ATTACK_TYPE_DOUBLE_STRIKE | ATTACK_TYPE_TRIPLE_STRIKE);
  });
});

// ─── MagicSchool ────────────────────────────────────────────

describe('ACE MagicSchool coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(MS_PATH, 'MagicSchool');

  it('parses ACE source successfully', () => {
    expect(existsSync(MS_PATH)).toBe(true);
    expect(aceEntries.length).toBe(6);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MagicSchool.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (MagicSchool as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(MagicSchool as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});
