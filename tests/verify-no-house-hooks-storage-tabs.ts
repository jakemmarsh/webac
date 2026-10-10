/**
 * GAP.52 — "Housing panel: hooks + storage tabs" is a WRONG PREMISE. The
 * reconciliation called our 3-tab house panel (profile/access/rent)
 * "partial", claiming a missing hooks-management tab and dedicated storage
 * tab. Retail's House panel never had those tabs.
 *
 * Ground truth:
 *   • DAT: the House panel is INFORMATIONAL — "Open/Close the House panel.
 *     You can view information on your house on this panel." There are 0
 *     "hook" strings, 0 "storage" strings, 0 "dwelling" strings anywhere in
 *     the language DAT — no hooks/storage tab labels exist.
 *   • ACE house-panel data (HouseProfile — what the server sends the client
 *     for the panel) carries ONLY dwelling info + buy/rent payments + owner;
 *     it has NO hooks or storage list. Our profile/access/rent tabs map to
 *     exactly this.
 *   • Hooks and storage are WORLD-OBJECT CONTAINERS, not panel tabs:
 *     ACE `Hook : Container` (ActOnUse in-world to place decorations) and
 *     `Storage : Chest` (opened like any chest). Both flow through the
 *     existing container/loot panel. Storage ACCESS is a per-guest
 *     permission (retail "grant storage") — which our Access tab already
 *     models (guest.storageAccess → "(storage)" marker).
 *
 * So there is no hooks/storage tab to build (CLAUDE.md: a wrong
 * implementation is worse than none). This locks the finding: DAT has no
 * hook/storage tab labels; ACE keeps hooks/storage as world-object
 * containers outside the house-panel data. skipIf the reference is absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DatDatabase, parseStringTable } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const LANG_PATH = 'dat/client_local_English.dat';
const ACE = 'reference/ACE/Source/ACE.Server';
const hasLang = fs.existsSync(LANG_PATH);
const hasAce = fs.existsSync(`${ACE}/WorldObjects/Hook.cs`);

function allStrings(path: string): string[] {
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

describe.skipIf(!hasLang)('GAP.52 — no hooks/storage tabs in the house panel (DAT ground truth)', () => {
  let strings: string[];

  it('parses the language DAT string tables', () => {
    strings = allStrings(LANG_PATH);
    expect(strings.length).toBeGreaterThan(1000);
  });

  it('positive control: the House info-panel labels ARE present', () => {
    expect(strings.some((s) => /view information on your house/i.test(s))).toBe(true);
    expect(strings.some((s) => /\bHouse\b/.test(s))).toBe(true);
  });

  it('has NO hooks / storage / dwelling tab labels', () => {
    expect(strings.filter((s) => /\bhook/i.test(s))).toEqual([]);
    expect(strings.filter((s) => /storage/i.test(s))).toEqual([]);
    expect(strings.filter((s) => /dwelling/i.test(s))).toEqual([]);
  });
});

describe.skipIf(!hasAce)('GAP.52 — hooks/storage are world-object containers, not house-panel data (ACE)', () => {
  it('Hook is a Container (used in-world), Storage is a Chest', () => {
    const hook = fs.readFileSync(`${ACE}/WorldObjects/Hook.cs`, 'utf8');
    const storage = fs.readFileSync(`${ACE}/WorldObjects/Storage.cs`, 'utf8');
    expect(hook).toMatch(/class\s+Hook\s*:\s*Container/);
    expect(hook).toMatch(/ActOnUse/); // used in the world, not a panel tab
    expect(storage).toMatch(/class\s+Storage\s*:\s*Chest/);
  });

  it('HouseProfile (the house-panel data model) carries NO hooks/storage list', () => {
    const profile = fs.readFileSync(`${ACE}/Network/Structure/HouseProfile.cs`, 'utf8');
    // positive control: it IS the house-panel profile (dwelling + rent).
    expect(profile).toMatch(/DwellingID/);
    expect(profile).toMatch(/Rent/);
    // …and it has no hooks/storage fields — those aren't panel data.
    expect(/\bhook/i.test(profile)).toBe(false);
    expect(/\bstorage/i.test(profile)).toBe(false);
  });
});
