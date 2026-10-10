/**
 * Runtime audit: every entry in ACE Sound.cs must exist in our TS port
 * (packages/shared/src/enums/Sound.ts) at the same numeric value.
 *
 * Same pattern as the other FAITHFUL audits. Sound is used in
 * SoundTable lookup for every server-driven game-event sound (combat
 * swing, damage, footstep, hit-leather, ambient, UI clicks, etc.).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sound } from '../packages/shared/src/enums/Sound.js';

const REPO = resolve(__dirname, '..');
const SND_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Sound.cs');

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

describe('ACE Sound coverage (runtime audit)', () => {
  const aceEntries = parseAce(SND_PATH, 'Sound');

  it('parses ACE source successfully', () => {
    expect(existsSync(SND_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(200);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'Sound.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (Sound as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const tsNames = Object.keys(Sound).filter((k) => Number.isNaN(Number(k)));
    const extras = tsNames.filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});
