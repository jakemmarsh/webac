/**
 * GAP.46 — "Bookmarks panel" is a WRONG-PREMISE gap: retail Asheron's Call
 * (end-of-retail, Jan 2017 — our DAT iteration-pin) had NO Bookmarks panel,
 * button, or feature.
 *
 * The gap-reconciliation flagged Bookmarks as "missing" on the sole evidence
 * "No bookmark code anywhere in renderer per grep" — an absence-of-OUR-code
 * observation with no positive retail citation (unlike Help, whose Options
 * button carries the real getString(196096592) "In-Game Help Files" label).
 * The name was pulled from a generic MMO-UI checklist.
 *
 * Per CLAUDE.md the DAT is ground truth. Every user-facing AC panel/button
 * carries a localized String-table label; a Bookmarks panel would too. This
 * test drives the REAL DAT parser over EVERY String table in
 * client_local_English.dat and asserts:
 *   1. (positive control) a KNOWN UI label IS found — proving the search
 *      method would surface a real panel label if one existed;
 *   2. NO string anywhere contains "bookmark" (case-insensitive) — proving
 *      retail shipped no such UI element.
 *
 * This guards against a future misguided "implementation" of a fabricated
 * Bookmarks panel (which CLAUDE.md warns is worse than none). If a real
 * bookmark String ever surfaces in the DAT chain, this test fails loudly and
 * the premise gets re-triaged.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DatDatabase, parseStringTable } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const LANG_PATH = 'dat/client_local_English.dat';
const hasLang = fs.existsSync(LANG_PATH);

function loadDat(path: string): DatDatabase {
  return openDat(path);
}

/** Collect every string from every StringTable (0x23xxxxxx) in a DAT. */
function allStrings(dat: DatDatabase): string[] {
  const out: string[] = [];
  for (const id of dat.listFileIds(0x23)) {
    let st;
    try { st = parseStringTable(dat.getReader(id)); } catch { continue; }
    for (const e of st.entries) for (const s of e.strings) out.push(s);
  }
  return out;
}

describe.skipIf(!hasLang)('GAP.46 — no Bookmarks panel in retail (DAT ground truth)', () => {
  let strings: string[];

  it('parses the language DAT string tables', () => {
    strings = allStrings(loadDat(LANG_PATH));
    // The EoL English client ships thousands of UI/label strings.
    expect(strings.length).toBeGreaterThan(1000);
  });

  it('positive control: a known UI-panel label IS present in the DAT strings', () => {
    // "In-Game Help Files" is getString(196096592) — the real Options button
    // GAP.45 rewired. Its presence proves this search WOULD catch a panel
    // label if one existed, so the "bookmark" absence below is meaningful.
    const hasKnownLabel = strings.some((s) => /In-Game Help Files/i.test(s));
    expect(hasKnownLabel).toBe(true);
  });

  it('NO DAT string references a Bookmark(s) panel/button — retail never had one', () => {
    const hits = strings.filter((s) => /bookmark/i.test(s));
    expect(hits).toEqual([]);
  });
});
