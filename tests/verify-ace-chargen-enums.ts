/**
 * Runtime audit for character-creation / wire-format ACE enums:
 *   - HeritageGroup (Heritage)    — 14 entries; PlayerDescription + appraisal
 *   - Gender                      — 3 entries; chargen + appraisal
 *   - SkillAdvancementClass       — 4 entries; PlayerDescription per-skill state
 *   - WeaponType                  — 13 entries; PropertyInt.WeaponType on every weapon
 *   - ConfirmationType            — 8 entries; GameEventConfirmationRequest payload
 *
 * Each rides the wire format directly. ConfirmationType in particular is read
 * as Int32 by GameActionConfirmationResponse on the server side; any drift in
 * the numeric values silently mis-categorizes the dialog and breaks the
 * confirmation round-trip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Heritage, Gender, SkillAdvancementClass, WeaponType } from '../packages/shared/src/character/Heritage.js';
import { ConfirmationType } from '../packages/shared/src/game-types.js';

const REPO = resolve(__dirname, '..');
const HG_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/HeritageGroup.cs');
const G_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Gender.cs');
const SAC_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/SkillAdvancementClass.cs');
const WT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/WeaponType.cs');
const CF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ConfirmationType.cs');

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

// ─── HeritageGroup (Heritage) ───────────────────────────────

describe('ACE HeritageGroup (Heritage) coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(HG_PATH, 'HeritageGroup');

  it('parses ACE source successfully', () => {
    expect(existsSync(HG_PATH)).toBe(true);
    expect(aceEntries.length).toBe(14);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'Heritage.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (Heritage as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(Heritage as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── Gender ─────────────────────────────────────────────────

describe('ACE Gender coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(G_PATH, 'Gender');

  it('parses ACE source successfully', () => {
    expect(existsSync(G_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'Gender.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (Gender as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(Gender as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── SkillAdvancementClass ──────────────────────────────────

describe('ACE SkillAdvancementClass coverage (runtime audit)', () => {
  // Auto-numbered: Inactive=0, Untrained=1, Trained=2, Specialized=3.
  const aceEntries = parseAceAutoNumbered(SAC_PATH, 'SkillAdvancementClass');

  it('parses ACE source successfully', () => {
    expect(existsSync(SAC_PATH)).toBe(true);
    expect(aceEntries.length).toBe(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'SkillAdvancementClass.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (SkillAdvancementClass as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(SkillAdvancementClass as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── WeaponType ─────────────────────────────────────────────

describe('ACE WeaponType coverage (runtime audit)', () => {
  // Auto-numbered: Undef=0, Unarmed=1, Sword=2, ..., Magic=12.
  const aceEntries = parseAceAutoNumbered(WT_PATH, 'WeaponType');

  it('parses ACE source successfully', () => {
    expect(existsSync(WT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(13);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'WeaponType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (WeaponType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(WeaponType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── ConfirmationType ───────────────────────────────────────

describe('ACE ConfirmationType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(CF_PATH, 'ConfirmationType');

  it('parses ACE source successfully', () => {
    expect(existsSync(CF_PATH)).toBe(true);
    expect(aceEntries.length).toBe(8);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ConfirmationType.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (ConfirmationType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(ConfirmationType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  // Wire-format pin: GameActionConfirmationResponse reads ConfirmationType as
  // Int32. Any drift in the numeric value would mis-route the dialog response.
  it('canonical wire values: Undefined=0..Yes_No=7', () => {
    expect(ConfirmationType.Undefined).toBe(0);
    expect(ConfirmationType.SwearAllegiance).toBe(1);
    expect(ConfirmationType.AlterSkill).toBe(2);
    expect(ConfirmationType.AlterAttribute).toBe(3);
    expect(ConfirmationType.Fellowship).toBe(4);
    expect(ConfirmationType.CraftInteraction).toBe(5);
    expect(ConfirmationType.Augmentation).toBe(6);
    expect(ConfirmationType.Yes_No).toBe(7);
  });
});
