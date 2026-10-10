/**
 * Runtime audit: every entry in ACE MotionCommand.cs and MotionStance.cs must
 * exist in our TS port (packages/renderer/src/animation/MotionCommands.ts) at
 * the same numeric value.
 *
 * Mirrors FAITHFUL.62/64/65 pattern. Walks ACE source at test time — drift-proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';

const REPO = resolve(__dirname, '..');
const MC_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionCommand.cs');
const MS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionStance.cs');

interface AceEntry { name: string; value: number; }

function parseAce(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
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

describe('ACE MotionCommand coverage (runtime audit)', () => {
  const aceEntries = parseAce(MC_PATH, 'MotionCommand');

  it('parses ACE source successfully', () => {
    expect(existsSync(MC_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(400);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MotionCommand.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (MotionCommand as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const tsNames = Object.keys(MotionCommand);
    const extras = tsNames.filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE MotionStance coverage (runtime audit)', () => {
  const aceEntries = parseAce(MS_PATH, 'MotionStance');

  it('parses ACE source successfully', () => {
    expect(existsSync(MS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(15);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MotionStance.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (MotionStance as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const tsNames = Object.keys(MotionStance);
    const extras = tsNames.filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});
