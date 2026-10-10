/**
 * GAP.48 — "Roll" (a /roll dice command / panel) is a WRONG PREMISE.
 * End-of-retail Asheron's Call had no dice-roll, /random, or gambling
 * command. The gap-reconciliation itself noted "AC /roll command not
 * implemented" and "Missing confirmed" — i.e. it agreed AC lacks /roll —
 * yet filed it as a UI-panel gap to fill. It is not a gap; it is a
 * non-feature pulled from a generic-MMO checklist (many MMOs have /roll
 * for loot distribution; AC used corpse-permission looting instead).
 *
 * Two authoritative sources agree:
 *   1. ACE C# (the faithful retail server, authoritative for the command
 *      set — /roll would be a server-broadcast command so ACE would carry
 *      it if retail did): of ACE's 300+ [CommandHandler("…")] commands,
 *      NONE is roll / dice / random / gamble (only "setcoin", an admin
 *      pyreal command, matches the coin/roll family).
 *   2. The EoL DAT string tables: 0 occurrences of roll / dice / gamble.
 *
 * And our client already does the faithful thing: an unhandled `/roll`
 * is rewritten to `@roll` and forwarded to the server, which replies
 * "Unknown command: roll" (FAITHFUL.568, verify-unknown-slash-command.ts)
 * — so no local /roll is fabricated.
 *
 * Per CLAUDE.md (a wrong implementation is worse than none) no /roll is
 * built. This test locks the finding: if a real roll command ever appears
 * in ACE or a roll String in the DAT chain, it fails and re-triages.
 *
 * Both checks skipIf their reference is absent (CI has neither ACE nor DAT).
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import fs from 'fs';
import path from 'path';
import { DatDatabase, parseStringTable } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const ACE_CMD_DIR = 'reference/ACE/Source/ACE.Server/Command/Handlers';
const LANG_PATH = 'dat/client_local_English.dat';
const hasAce = aceReferenceExists(ACE_CMD_DIR);
const hasLang = fs.existsSync(LANG_PATH);

/** All [CommandHandler("name", …)] command names declared under ACE's handlers. */
function aceCommandNames(dir: string): string[] {
  const names: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.cs')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/CommandHandler\("([a-zA-Z0-9_-]+)"/g)) names.push(m[1]);
      }
    }
  };
  walk(dir);
  return names;
}

function allDatStrings(path: string): string[] {
  const dat = openDat(path);
  const out: string[] = [];
  for (const id of dat.listFileIds(0x23)) {
    try {
      const st = parseStringTable(dat.getReader(id));
      for (const e of st.entries) for (const s of e.strings) out.push(s);
    } catch { /* skip */ }
  }
  return out;
}

describe.skipIf(!hasAce)('GAP.48 — no /roll command in retail (ACE command-set ground truth)', () => {
  let names: string[];

  it('enumerates ACE command handlers', () => {
    names = aceCommandNames(ACE_CMD_DIR);
    // ACE ships hundreds of retail commands.
    expect(names.length).toBeGreaterThan(100);
  });

  it('positive control: a known command IS present (enumeration works)', () => {
    // "setcoin" is a real ACE admin command; its presence proves the scan
    // finds command names, so the roll absence below is meaningful.
    expect(names.map((n) => n.toLowerCase())).toContain('setcoin');
  });

  it('has NO dice-roll / random / gamble command', () => {
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const forbidden of ['roll', 'dice', 'random', 'gamble', 'flip', 'diceroll']) {
      expect(lower.has(forbidden), `unexpected ACE command "${forbidden}"`).toBe(false);
    }
  });
});

describe.skipIf(!hasLang)('GAP.48 — no roll/dice strings in the DAT', () => {
  it('no DAT string references roll / dice / gamble', () => {
    const strings = allDatStrings(LANG_PATH);
    expect(strings.length).toBeGreaterThan(1000);
    expect(strings.filter((s) => /\broll\b|dice|gamble/i.test(s))).toEqual([]);
  });
});
