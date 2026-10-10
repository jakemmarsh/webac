/**
 * ASSESS: per-table StringTable resolution (getStringFromTable).
 *
 * StringTable entry ids are token hashes, so the SAME id can hold different
 * text in different tables: id 237541360 ("ID_PlayerOption_FellowshipShareXP")
 * is "Share Fellowship Experience and Luminance" in 0x23000003 but the short
 * "Share Fellowship Experience" in 0x23000005. The retail client binds each
 * consumer to a specific table (StringInfo::SetStringIDandTableEnum —
 * gmFellowshipUI::PostInit @ 0048fd40 binds all four fellowship toggles to
 * table enum 0x10000003 = English table 0x23000003), so the fellowship panel
 * shows the LONG variant. Our flat getString index is last-write-wins and
 * main.ts registers 0x23000005 after 0x23000003, which silently dropped
 * "and Luminance" — getStringFromTable is the fix.
 *
 * Unit suite drives registerStringTable/getString/getStringFromTable with
 * synthetic tables carrying the real ids + texts (no DAT needed); the DAT
 * suite re-verifies the collision against the live client_local_English.dat.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import {
  DatDatabase, DatReader, parseStringTable, registerStringTable,
  getString, getStringFromTable, acStringHash,
} from '@ac/dat-parser';
import type { StringTableData } from '@ac/dat-parser';
import { fellowshipString, FELLOWSHIP_STRING_TABLE } from '@ac/renderer/ui/FellowshipStrings.js';
import { openDat } from './_harness/dat.js';

const LONG = 'Share Fellowship Experience and Luminance';
const SHORT = 'Share Fellowship Experience';
const SHARE_XP_ID = 237541360;

function entry(id: number, text: string) {
  return { id, varNames: [], vars: [], strings: [text], comments: [], unknown: 0 };
}

describe('getStringFromTable — per-table id-collision resolution', () => {
  beforeAll(() => {
    // Same registration order as main.ts: 0x23000003 before 0x23000005.
    const t3: StringTableData = {
      id: 0x23000003, language: 1, unknown: 0,
      entries: [entry(SHARE_XP_ID, LONG), entry(143989828, 'Share Fellowship Loot')],
    };
    const t5: StringTableData = {
      id: 0x23000005, language: 1, unknown: 0,
      entries: [entry(SHARE_XP_ID, SHORT), entry(143989828, 'Share Fellowship Loot')],
    };
    registerStringTable(t3);
    registerStringTable(t5);
  });

  it('the share-XP id is the hash of ID_PlayerOption_FellowshipShareXP', () => {
    expect(acStringHash('ID_PlayerOption_FellowshipShareXP')).toBe(SHARE_XP_ID);
  });

  it('flat getString is last-write-wins (documents the collision)', () => {
    expect(getString(SHARE_XP_ID)).toBe(SHORT);
  });

  it('resolves each table\'s own variant of the colliding id', () => {
    expect(getStringFromTable(0x23000003, SHARE_XP_ID)).toBe(LONG);
    expect(getStringFromTable(0x23000005, SHARE_XP_ID)).toBe(SHORT);
  });

  it('returns null for an unregistered table or unknown entry', () => {
    expect(getStringFromTable(0x23000004, SHARE_XP_ID)).toBeNull();
    expect(getStringFromTable(0x23000003, 12345)).toBeNull();
  });

  it('re-registering a table replaces without clobbering other tables', () => {
    registerStringTable({
      id: 0x23000005, language: 1, unknown: 0,
      entries: [entry(SHARE_XP_ID, SHORT)],
    });
    expect(getStringFromTable(0x23000003, SHARE_XP_ID)).toBe(LONG);
    expect(getStringFromTable(0x23000005, SHARE_XP_ID)).toBe(SHORT);
  });

  it('fellowshipString is bound to retail table 0x23000003 and beats the flat index', () => {
    expect(FELLOWSHIP_STRING_TABLE).toBe(0x23000003);
    // Flat lookup resolves the 0x23000005 short variant; the panel binding
    // must recover the long retail text (reference/images/hud/fellowship-panel.jpg).
    expect(getString(SHARE_XP_ID)).toBe(SHORT);
    expect(fellowshipString(SHARE_XP_ID, 'fallback')).toBe(LONG);
    expect(fellowshipString(143989828, 'fallback')).toBe('Share Fellowship Loot');
  });

  it('fellowshipString falls back to the flat index, then the hardcoded default', () => {
    // Registered only in the flat index via a table other than 0x23000003.
    registerStringTable({
      id: 0x23000009, language: 1, unknown: 0,
      entries: [entry(424242, 'Elsewhere Only')],
    });
    expect(fellowshipString(424242, 'fallback')).toBe('Elsewhere Only');
    expect(fellowshipString(31337, 'Hardcoded Default')).toBe('Hardcoded Default');
  });

  it('unescapes literal \\n like getString does', () => {
    registerStringTable({
      id: 0x23000007, language: 1, unknown: 0,
      entries: [entry(999, 'line one\\nline two')],
    });
    expect(getStringFromTable(0x23000007, 999)).toBe('line one\nline two');
  });
});

// ─── Live DAT: the collision is real in client_local_English.dat ──────────
const LANG_PATH = 'dat/client_local_English.dat';

describe.skipIf(!fs.existsSync(LANG_PATH))('fellowship share-XP string in the live DAT', () => {
  beforeAll(() => {
    const dat = openDat(LANG_PATH);
    for (const tableId of [0x23000003, 0x23000005]) {
      const data = dat.getFileData(tableId);
      expect(data).not.toBeNull();
      registerStringTable(parseStringTable(new DatReader(data!)));
    }
  });

  it('0x23000003 carries the long retail text, 0x23000005 the short one', () => {
    expect(getStringFromTable(0x23000003, SHARE_XP_ID)).toBe(LONG);
    expect(getStringFromTable(0x23000005, SHARE_XP_ID)).toBe(SHORT);
  });

  it('fellowshipString yields the four retail toggle labels from the live DAT', () => {
    expect(fellowshipString(159149763, '')).toBe('Ignore Fellowship Requests');
    expect(fellowshipString(115802515, '')).toBe('Automatically Accept Fellowship Requests');
    expect(fellowshipString(237541360, '')).toBe(LONG);
    expect(fellowshipString(143989828, '')).toBe('Share Fellowship Loot');
  });
});
