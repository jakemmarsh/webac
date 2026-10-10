/**
 * Runtime audit for the housing ACE enum the client ships:
 *   - HouseType (5 entries) — house tier classification (houseTypeName labels)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HouseType } from '../packages/shared/src/housing/HousingTypes.js';

const REPO = resolve(__dirname, '..');
const HT_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/HouseType.cs');

interface AceEntry { name: string; value: number; }

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

// ─── HouseType ──────────────────────────────────────────────

describe('ACE HouseType coverage (runtime audit)', () => {
  // Auto-numbered (Undef=0, Cottage=1, Villa=2, Mansion=3, Apartment=4).
  const aceEntries = parseAceAutoNumbered(HT_PATH, 'HouseType');

  it('parses ACE source', () => {
    expect(existsSync(HT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(5);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'HouseType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (HouseType as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );
});
