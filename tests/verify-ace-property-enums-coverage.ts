/**
 * Runtime audit: every entry in the ACE Properties enum family must exist in
 * our TS port at the same numeric value.
 *
 * Mirrors FAITHFUL.62 (WeenieError) and FAITHFUL.64 (WeenieErrorWithString).
 * Walking ACE source at test time means if ACE adds or renames a property,
 * the suite fails until the client regenerates via the generator tool.
 *
 * Covers: PropertyInt (404), PropertyBool (141), PropertyFloat (182),
 * PropertyString (63), PropertyDataId (80), PropertyInstanceId (48),
 * PropertyInt64 (13), WeenieType (72). Total ~1003 entries pinned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PropertyInt,
  PropertyBool,
  PropertyFloat,
  PropertyString,
  PropertyDataId,
  PropertyInstanceId,
  PropertyInt64,
  WeenieType,
} from '@ac/shared';

const REPO_ROOT = resolve(__dirname, '..');

interface AceEntry {
  name: string;
  value: number;
}

function parseAceEnum(csPath: string, enumName: string): AceEntry[] {
  const src = readFileSync(resolve(REPO_ROOT, csPath), 'utf8');
  const lines = src.split('\n');
  const entries: AceEntry[] = [];

  const explicitRe = /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  const autoRe = /^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*(\/\/.*)?$/;

  let insideEnum = false;
  let nextAuto = 0;
  const enumOpenRe = new RegExp(`enum\\s+${enumName}\\b`);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!insideEnum) {
      if (enumOpenRe.test(line)) insideEnum = true;
      continue;
    }
    if (/^\s*}/.test(line)) break;

    const m = explicitRe.exec(line);
    if (m) {
      const name = m[1];
      const valStr = m[2];
      const value = valStr.startsWith('0x') ? parseInt(valStr, 16) : parseInt(valStr, 10);
      entries.push({ name, value });
      nextAuto = value + 1;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('[')
      || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    const a = autoRe.exec(line);
    if (a) {
      entries.push({ name: a[1], value: nextAuto });
      nextAuto++;
    }
  }
  return entries;
}

const enumPairs: Array<{
  enumName: string;
  tsEnum: object;
  csPath: string;
}> = [
  { enumName: 'PropertyInt', tsEnum: PropertyInt, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs' },
  { enumName: 'PropertyBool', tsEnum: PropertyBool, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyBool.cs' },
  { enumName: 'PropertyFloat', tsEnum: PropertyFloat, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs' },
  { enumName: 'PropertyString', tsEnum: PropertyString, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyString.cs' },
  { enumName: 'PropertyDataId', tsEnum: PropertyDataId, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs' },
  { enumName: 'PropertyInstanceId', tsEnum: PropertyInstanceId, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInstanceId.cs' },
  { enumName: 'PropertyInt64', tsEnum: PropertyInt64, csPath: 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt64.cs' },
  { enumName: 'WeenieType', tsEnum: WeenieType, csPath: 'reference/ACE/Source/ACE.Entity/Enum/WeenieType.cs' },
];

for (const { enumName, tsEnum, csPath } of enumPairs) {
  describe(`ACE ${enumName} coverage (runtime audit)`, () => {
    const aceEntries = parseAceEnum(csPath, enumName);
    const tsAsAny = tsEnum as unknown as Record<string, number>;

    it(`parses ACE source successfully (${csPath})`, () => {
      expect(existsSync(resolve(REPO_ROOT, csPath))).toBe(true);
      expect(aceEntries.length).toBeGreaterThanOrEqual(10);
    });

    it.each(aceEntries.map((e) => [e.name, e.value] as const))(
      `${enumName}.%s = %s exists in TS port at same value`,
      (name, value) => {
        const tsVal = tsAsAny[name];
        expect(tsVal).toBeDefined();
        expect(tsVal).toBe(value);
      },
    );

    it(`${enumName}: TS port has no extras that ACE does not`, () => {
      const aceNames = new Set(aceEntries.map((e) => e.name));
      const tsNames = Object.keys(tsAsAny).filter((k) => isNaN(Number(k)));
      const extras = tsNames.filter((n) => !aceNames.has(n));
      expect(extras).toEqual([]);
    });
  });
}
