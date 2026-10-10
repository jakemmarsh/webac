/**
 * Runtime audit: every WeenieErrorWithString in ACE C# source must exist in
 * our TS port at the same numeric value, and every <summary>-tagged entry must
 * have a text template in our WEENIE_ERROR_WITH_STRING_TEXT map (with the
 * placeholder underscores restored from spacing).
 *
 * Mirrors FAITHFUL.62's WeenieError audit. Walking ACE source at test time
 * means if ACE adds, renames, or shifts a WeenieErrorWithString, the suite
 * fails until the client regenerates via the generator tool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeenieErrorWithString, WEENIE_ERROR_WITH_STRING_TEXT } from '@ac/shared';

const CS_PATH = resolve(__dirname, '../reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs');

interface AceEntry {
  name: string;
  value: number;
  hasSummary: boolean;
}

function parseAce(): AceEntry[] {
  const src = readFileSync(CS_PATH, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];

  let pendingSummary: string[] | null = null;
  let inSummary = false;
  const enumLineRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*0x([0-9A-Fa-f]+)\s*,?\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '/// <summary>') {
      pendingSummary = [];
      inSummary = true;
      continue;
    }
    if (trimmed === '/// </summary>') {
      inSummary = false;
      continue;
    }
    if (inSummary) {
      const m = /^\s*\/\/\/\s?(.*)$/.exec(line);
      if (m) pendingSummary!.push(m[1]);
      continue;
    }
    if (/^\s*\/\//.test(line)) continue;
    const em = enumLineRe.exec(line);
    if (em) {
      const name = em[1];
      const value = parseInt(em[2], 16);
      const hasSummary = !!(pendingSummary && pendingSummary.join(' ').trim().length > 0);
      out.push({ name, value, hasSummary });
      pendingSummary = null;
    }
  }
  return out;
}

describe('ACE WeenieErrorWithString coverage (runtime audit)', () => {
  const aceEntries = parseAce();
  const tsEntries = WeenieErrorWithString as unknown as Record<string, number>;

  it('parses ACE source successfully', () => {
    expect(existsSync(CS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(113);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'WeenieErrorWithString.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = tsEntries[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it.each(
    aceEntries
      .filter((e) => e.hasSummary)
      .map((e) => [e.name, e.value] as const),
  )('WeenieErrorWithString.%s (0x%s) has a text template', (_name, value) => {
    const text = WEENIE_ERROR_WITH_STRING_TEXT[value];
    expect(text).toBeDefined();
    expect(text.length).toBeGreaterThan(0);
  });

  it('TS port has no extras that ACE does not (drift-from-other-direction)', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const tsNames = Object.keys(tsEntries).filter((k) => isNaN(Number(k)));
    const extras = tsNames.filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('placeholder reconstruction: known templates have correct underscore positions', () => {
    // Leading-space summary → leading `_ ` template (actor name comes first).
    expect(WEENIE_ERROR_WITH_STRING_TEXT[0x001E]).toBe('_ is too busy to accept gifts right now.');
    // Two distinct placeholders in body (double-space in summary).
    expect(WEENIE_ERROR_WITH_STRING_TEXT[0x0052])
      .toBe('You fail to affect _ because _ is not a player killer!');
    // Final entry — trailing exclamation, leading underscore.
    expect(WEENIE_ERROR_WITH_STRING_TEXT[0x058A]).toBe('_ cowers from you!');
  });
});
