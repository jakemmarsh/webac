/**
 * Runtime audit: every entry in ACE PlayScript.cs must exist in our TS port
 * (packages/shared/src/enums/PlayScript.ts) at the same numeric value.
 *
 * Mirrors FAITHFUL.62/64/65/66 pattern. Walks ACE source at test time — drift-proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlayScript } from '../packages/shared/src/enums/PlayScript.js';

const REPO = resolve(__dirname, '..');
const PS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PlayScript.cs');

interface AceEntry { name: string; value: number; }

function parseAce(path: string, enumName: string): AceEntry[] {
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

describe('ACE PlayScript coverage (runtime audit)', () => {
  const aceEntries = parseAce(PS_PATH, 'PlayScript');

  it('parses ACE source successfully', () => {
    expect(existsSync(PS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(170);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'PlayScript.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (PlayScript as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    // TS enums have both name→value and value→name reverse mappings; filter to string keys.
    const tsNames = Object.keys(PlayScript).filter((k) => Number.isNaN(Number(k)));
    const extras = tsNames.filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});
