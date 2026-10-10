/**
 * Runtime audit: every WeenieError in ACE C# source must exist in our TS port
 * at the same numeric value, and every <summary>-tagged entry must have a text
 * mapping (except the two explicit suppressions).
 *
 * Mirrors the FAITHFUL.53 (inbound GameEvent) and FAITHFUL.60 (outbound
 * GameAction) coverage tests. Walking ACE source at test time means if ACE
 * adds, renames, or shifts a WeenieError, the suite fails until the client
 * is regenerated via `npx tsx tools/generate-weenie-errors.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeenieError, weenieErrorText } from '@ac/shared';

const CS_PATH = resolve(__dirname, '../reference/ACE/Source/ACE.Entity/Enum/WeenieError.cs');

interface AceEntry {
  name: string;
  value: number;
  text: string | null;
}

function parseAceEnum(): AceEntry[] {
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
      const text = pendingSummary
        ? pendingSummary
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .join(' ')
            .trim() || null
        : null;
      out.push({ name, value, text });
      pendingSummary = null;
    }
  }
  return out;
}

// Codes intentionally not mapped to user-visible text (see WeenieErrorText.ts
// generator). Keep in sync with the SUPPRESS set in tools/generate-weenie-errors.ts.
const SUPPRESSED_TEXT = new Set<number>([
  0x0000, // None — success, no text by definition
]);

// Codes whose ACE <summary> is not the client string; the retail literal
// (decomp line) is shipped instead.
const RETAIL_TEXT: Record<number, string> = {
  0x003A: "You can't do that... you're dead!", // :360051
  0x004D: 'Invalid PK status!', // :360081
  0x0491: 'You must specify a character to boot.', // :360120
  0x0492: "You can't boot yourself!", // :360126
};

describe('ACE WeenieError coverage (runtime audit)', () => {
  const aceEntries = parseAceEnum();
  const tsEntries: Record<string, number> = WeenieError as any;

  it('parses ACE source successfully', () => {
    expect(existsSync(CS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(369);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'WeenieError.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      expect(tsEntries[name]).toBeDefined();
      expect(tsEntries[name]).toBe(value);
    },
  );

  it.each(
    aceEntries
      .filter((e) => e.text && !SUPPRESSED_TEXT.has(e.value) && !(e.value in RETAIL_TEXT))
      .map((e) => [e.name, e.value, e.text!] as const),
  )('WeenieError.%s (0x%s) text = %s', (_name, value, text) => {
    expect(weenieErrorText(value)).toBe(text);
  });

  // STATS.weenieerror-summary-leak — where ACE's <summary> is editorial (an
  // "or …" alternative, a "(From allegiance)" note, a re-cased word) the
  // retail client's literal from HandleFailureEvent @ 00571990 wins. Keep in
  // sync with RETAIL_TEXT in tools/generate-weenie-errors.ts.
  it.each(Object.entries(RETAIL_TEXT).map(([v, t]) => [Number(v), t] as const))(
    'code 0x%s carries the retail HandleFailureEvent literal, not the ACE summary',
    (value, text) => {
      const ace = aceEntries.find((e) => e.value === value);
      expect(ace?.text).toBeTruthy();
      expect(ace!.text).not.toBe(text); // the leak this pins against
      expect(weenieErrorText(value)).toBe(text);
    },
  );

  it('TS port has no extra entries that ACE does not (drift-from-other-direction)', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = Object.keys(tsEntries).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('suppressed codes return null even though ACE has summary text', () => {
    // CORE.17.k.c: ActionCancelled (0x0036) is no longer suppressed — the
    // retail client prints "Action cancelled!" (HandleFailureEvent :360046).
    expect(weenieErrorText(0x0036)).toBe('Action cancelled!');
    expect(weenieErrorText(0x0000)).toBeNull();
  });
});
