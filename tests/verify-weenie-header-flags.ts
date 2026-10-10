/**
 * FAITHFUL.56 — CI audit pinning WeenieHeaderFlag + WeenieHeaderFlag2
 * byte-for-byte against ACE source. The CreateObject parser branches on
 * every bit of these flags to decide whether each optional field is on
 * the wire — drift = wrong fields decoded = item icons / cooldowns /
 * cooldowns / pets all break.
 *
 * Reads reference/ACE/Source/ACE.Entity/Enum/WeenieHeaderFlags.cs at test
 * time and asserts our parser's enum declarations match the entries +
 * the literal hex values + the bitfield ordering.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');
const ACE_FILE = join(REPO_ROOT, 'reference/ACE/Source/ACE.Entity/Enum/WeenieHeaderFlags.cs');
const SERIALIZER = join(REPO_ROOT, 'packages/network/src/MessageSerializer.ts');

function parseEnum(src: string, enumName: string): Map<string, number> {
  const re = new RegExp(`enum\\s+${enumName}\\b[^{]*{([\\s\\S]*?)^\\s*}`, 'm');
  const m = src.match(re);
  if (!m) return new Map();
  const out = new Map<string, number>();
  for (const line of m[1].split('\n')) {
    const entry = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s+=\s+(0x[0-9A-Fa-f]+|\d+)/);
    if (entry) out.set(entry[1], parseInt(entry[2], 16) || parseInt(entry[2], 10));
  }
  return out;
}

describe.skipIf(!aceReferenceExists(ACE_FILE) || !existsSync(SERIALIZER))('FAITHFUL.56 — WeenieHeaderFlag bit-parity with ACE source', () => {
  let aceFlag: Map<string, number>;
  let aceFlag2: Map<string, number>;
  let acjsFlag: Map<string, number>;
  let acjsFlag2: Map<string, number>;
  let acjs: string;

  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    const ace = readFileSync(ACE_FILE, 'utf8');
    acjs = readFileSync(SERIALIZER, 'utf8');
    aceFlag = parseEnum(ace, 'WeenieHeaderFlag');
    aceFlag2 = parseEnum(ace, 'WeenieHeaderFlag2');
    acjsFlag = parseEnum(acjs, 'WeenieHeaderFlag');
    acjsFlag2 = parseEnum(acjs, 'WeenieHeaderFlag2');

    // ACE includes a `None = 0x00000000` sentinel in WeenieHeaderFlag and
    // WeenieHeaderFlag2; we omit it (no branch reads None). Strip from
    // comparison set so the audit reflects actual decoder-branch parity.
    aceFlag.delete('None');
    aceFlag2.delete('None');
  });

  it('WeenieHeaderFlag has all 32 ACE entries', () => {
    expect(aceFlag.size).toBe(32);
    expect(acjsFlag.size).toBe(32);
  });

  it('WeenieHeaderFlag bit values match ACE exactly', () => {
    for (const [name, value] of aceFlag) {
      expect(acjsFlag.has(name), `WeenieHeaderFlag.${name} missing in acjs`).toBe(true);
      expect(acjsFlag.get(name), `WeenieHeaderFlag.${name} value drift`).toBe(value);
    }
  });

  it('WeenieHeaderFlag has no extras vs ACE', () => {
    for (const [name] of acjsFlag) {
      expect(aceFlag.has(name), `acjs WeenieHeaderFlag.${name} is not in ACE source`).toBe(true);
    }
  });

  it('WeenieHeaderFlag2 has all 4 ACE entries', () => {
    expect(aceFlag2.size).toBe(4);
    expect(acjsFlag2.size).toBe(4);
  });

  it('WeenieHeaderFlag2 bit values match ACE exactly', () => {
    for (const [name, value] of aceFlag2) {
      expect(acjsFlag2.has(name), `WeenieHeaderFlag2.${name} missing in acjs`).toBe(true);
      expect(acjsFlag2.get(name), `WeenieHeaderFlag2.${name} value drift`).toBe(value);
    }
  });

  it('WeenieHeaderFlag2 has no extras vs ACE', () => {
    for (const [name] of acjsFlag2) {
      expect(aceFlag2.has(name), `acjs WeenieHeaderFlag2.${name} is not in ACE source`).toBe(true);
    }
  });

  // Specific load-bearing values per the actual ACE WeenieHeaderFlags.cs file.
  it('boundary bits: PluralName=0x01, MaterialType=0x80000000 (high bit)', () => {
    expect(acjsFlag.get('PluralName')).toBe(0x00000001);
    expect(acjsFlag.get('MaterialType')).toBe(0x80000000);
  });
  it('boundary bits: IconUnderlay=0x01, PetOwner=0x08', () => {
    expect(acjsFlag2.get('IconUnderlay')).toBe(0x01);
    expect(acjsFlag2.get('PetOwner')).toBe(0x08);
  });

  // Verify the CreateObject parser branches reference the typed enum, not
  // raw magic numbers — drift caught here would be reverting one of the
  // typed branches back to a hex literal.
  it('parser uses WeenieHeaderFlag2.IconUnderlay / Cooldown / CooldownDuration / PetOwner identifiers', () => {
    expect(acjs).toContain('WeenieHeaderFlag2.IconUnderlay');
    expect(acjs).toContain('WeenieHeaderFlag2.Cooldown');
    expect(acjs).toContain('WeenieHeaderFlag2.CooldownDuration');
    expect(acjs).toContain('WeenieHeaderFlag2.PetOwner');
    // No raw magic numbers remain on the flags2 branches
    expect(acjs).not.toMatch(/weenieFlags2\s*&\s*0x0[1248](?:[^0-9a-fA-F]|$)/);
  });
});
