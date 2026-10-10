/**
 * STATS.weenieerror-summary-leak — WeenieError chat text must be the retail
 * client's own string, not ACE's editorial <summary> annotation.
 *
 * ACE WeenieError.cs:137-140 documents Dead (0x3A) as "You can't do that...
 * you're dead! or You can't do that... its dead!" and :590-598 appends
 * "(From allegiance)" to 0x491/0x492; InvalidPkStatus (0x4D) re-cases
 * "status". The retail client prints ClientCommunicationSystem::
 * HandleFailureEvent @ 00571990's literal for each arm. This audit re-extracts
 * every arm's literal from the decomp (tools/generate-weenie-error-sinks.ts's
 * walker) and requires our text to equal it wherever both exist, so any
 * future summary leak fails here.
 *
 * 0x53B (ListOfBannedCharacters) is a WeenieErrorWithString code (ACE
 * WeenieErrorWithString.cs:424), already templated "Banned Characters: _"
 * — the retail arm (:361079) prints exactly that prefix + the string.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { weenieErrorText, WeenieError, formatWeenieErrorWithString } from '@ac/shared';
import { extractSinks, type SinkEntry } from '../tools/generate-weenie-error-sinks.js';

const DECOMP = resolve(__dirname, '..', 'reference/client-eol/decomp/acclient-decompiled.c');

describe('WeenieError texts for the leaked codes are the retail literals', () => {
  it('0x3A / 0x4D / 0x491 / 0x492 carry the HandleFailureEvent strings', () => {
    expect(weenieErrorText(WeenieError.Dead)).toBe("You can't do that... you're dead!");
    expect(weenieErrorText(WeenieError.InvalidPkStatus)).toBe('Invalid PK status!');
    expect(weenieErrorText(WeenieError.YouMustSpecifyCharacterToBoot)).toBe('You must specify a character to boot.');
    expect(weenieErrorText(WeenieError.YouCantBootYourself)).toBe("You can't boot yourself!");
  });

  it('no WeenieError text carries an ACE editorial annotation', () => {
    for (const code of Object.values(WeenieError)) {
      const t = weenieErrorText(code as number);
      if (!t) continue;
      expect(t).not.toMatch(/\(From allegiance\)/);
      expect(t).not.toMatch(/! or You can't/);
    }
  });

  it('0x53B is the WithString "Banned Characters: " + list', () => {
    expect(formatWeenieErrorWithString(0x053B, 'Bob, Alice')).toBe('Banned Characters: Bob, Alice');
  });
});

describe.skipIf(!existsSync(DECOMP))('WeenieError texts vs the decompiled retail HandleFailureEvent', () => {
  let sinks: SinkEntry[] = [];
  beforeAll(() => {
    sinks = extractSinks(readFileSync(DECOMP, 'utf8'));
  });

  it('every plain retail literal arm equals our text (trailing chat newline aside)', () => {
    const unescape = (s: string): string =>
      s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const known = new Set<number>(Object.values(WeenieError) as number[]);
    let compared = 0;
    for (const s of sinks) {
      if (s.type === null || !s.literal || !known.has(s.code)) continue;
      const ours = weenieErrorText(s.code);
      if (ours === null) continue;
      const lit = unescape(s.literal).replace(/\n+$/, '');
      // Name-prefixed sprintf arms (" doesn't know what to do with that.")
      // are templates, not whole strings.
      if (lit.startsWith(' ')) continue;
      expect(ours, `code 0x${s.code.toString(16)}`).toBe(lit);
      compared++;
    }
    expect(compared).toBeGreaterThan(150);
  });
});
