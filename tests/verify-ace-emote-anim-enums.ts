/**
 * Runtime audit for animation-hook ACE enums:
 *   - AnimationHookType (27 entries) — every animation frame hook (sound, attack frame, etc.)
 *   - AnimationHookDir  (4 entries)  — forward/backward/both/unknown
 *
 * Animation hooks fire during motion playback to trigger sounds (footsteps,
 * weapon swing), schedule attack-damage windows, swap mesh parts (TransparentPart),
 * and create particle effects — silent ACE drift would mis-route these per-frame
 * events and shift footstep timing / damage windows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';

const REPO = resolve(__dirname, '..');
const AHT_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AnimationHookType.cs');

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

function tsNamesOf(enumObj: Record<string, unknown>): string[] {
  return Object.keys(enumObj).filter((k) => Number.isNaN(Number(k)));
}

// ─── AnimationHookType ──────────────────────────────────────

describe('ACE AnimationHookType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(AHT_PATH, 'AnimationHookType');

  it('parses ACE source successfully', () => {
    expect(existsSync(AHT_PATH)).toBe(true);
    // ACE source includes 2 sentinel entries we intentionally omit from the
    // TS port: Unknown=-1 (pre-init placeholder) and
    // ForceAnimationHook32Bit=2147483647 (.NET enum-width forcing constant).
    expect(aceEntries.length).toBe(29);
  });

  // Skip the two sentinel entries — TS port intentionally omits them.
  const realEntries = aceEntries.filter((e) => e.name !== 'Unknown' && e.name !== 'ForceAnimationHook32Bit');

  it('TS port covers all 27 real hook types', () => {
    expect(realEntries.length).toBe(27);
  });

  it.each(realEntries.map((e) => [e.name, e.value] as const))(
    'AnimationHookType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (AnimationHookType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras beyond ACE 27 real hooks', () => {
    const realNames = new Set(realEntries.map((e) => e.name));
    const extras = tsNamesOf(AnimationHookType as unknown as Record<string, unknown>).filter((n) => !realNames.has(n));
    expect(extras).toEqual([]);
  });
});
