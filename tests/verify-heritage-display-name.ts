/**
 * Heritage display name on the character panel (FAITHFUL.285, follow-up
 * 2026-08-01 upstream-drift audit).
 *
 * `GameUI.syncFromPlayerState()` renders the character panel's "Heritage"
 * field via `resolveHeritageDisplayName()` (extracted to
 * `packages/renderer/src/utils/heritageDisplayName.ts` so the fallback table
 * is directly unit-testable instead of source-pinned).
 *
 * History:
 *   - Original FAITHFUL.285 fix corrected 4 of 13 fallback labels against
 *     DAT `client_local_English.dat` StringTable 0x23000002: "Gearknight"
 *     -> "Gear Knight", "Tumerok" -> "Aun Tumerok", "Olthoi" -> "Olthoi
 *     Soldier", "Olthoi Acid" -> "Olthoi Spitter".
 *   - 2026-08-01 upstream-drift audit against `reference/ACE` found a 5th:
 *     Shadowbound's fallback was the raw enum name "Shadowbound", but
 *     upstream ACE's `HeritageGroupExtensions.ToSentence()` (added after
 *     our pinned reference commit) maps `Shadowbound -> "Umbraen"`,
 *     corroborated independently by our own DAT lore text (StringTable
 *     0x23000002 id 83891876, the Penumbraen lore entry: "The UMBRAEN and
 *     PENUMBRAEN are a people born from the other Isparian heritages...")
 *     and by the char-gen wizard's heritage list, which already used
 *     "Umbraen" as its Shadowbound fallback (`GameUI.ts` `renderRaceStep`).
 *     The character panel's map disagreed with its own sibling despite a
 *     comment claiming the two matched verbatim.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Heritage } from '@ac/shared';
import {
  HERITAGE_DISPLAY_NAME_FALLBACK,
  resolveHeritageDisplayName,
} from '../packages/renderer/src/utils/heritageDisplayName.js';

const REPO = resolve(__dirname, '..');
const DAT_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT_PATH = resolve(REPO, 'dat/client_portal.dat');

describe('resolveHeritageDisplayName (FAITHFUL.285)', () => {
  it('all 13 Heritage enum values have a fallback label', () => {
    expect(Object.keys(HERITAGE_DISPLAY_NAME_FALLBACK).length).toBe(13);
  });

  it('the 5 corrected labels match retail wording (4 original FAITHFUL.285 + Shadowbound)', () => {
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Gearknight]).toBe('Gear Knight');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Tumerok]).toBe('Aun Tumerok');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Olthoi]).toBe('Olthoi Soldier');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.OlthoiAcid]).toBe('Olthoi Spitter');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Shadowbound]).toBe('Umbraen');
  });

  it('the remaining 8 labels are unchanged', () => {
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Aluvian]).toBe('Aluvian');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Gharundim]).toBe("Gharu'ndim");
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Sho]).toBe('Sho');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Viamontian]).toBe('Viamontian');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Lugian]).toBe('Lugian');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Empyrean]).toBe('Empyrean');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Penumbraen]).toBe('Penumbraen');
    expect(HERITAGE_DISPLAY_NAME_FALLBACK[Heritage.Undead]).toBe('Undead');
  });

  it('prefers the retail-wording table over the raw DAT-loaded name for a known heritage id', () => {
    // The raw DAT name is a truncated/internal string for 4 of 13
    // heritages (e.g. HeritageGroupCG.name = "Gear" for Gearknight,
    // "OlthoiAcid" for OlthoiAcid) — the table must win regardless of what
    // the DAT-loaded name says, not just when the DAT hasn't loaded yet.
    expect(resolveHeritageDisplayName(Heritage.Gearknight, 'Gear')).toBe('Gear Knight');
    expect(resolveHeritageDisplayName(Heritage.Tumerok, 'Tumerok')).toBe('Aun Tumerok');
    expect(resolveHeritageDisplayName(Heritage.Olthoi, 'Olthoi')).toBe('Olthoi Soldier');
    expect(resolveHeritageDisplayName(Heritage.OlthoiAcid, 'OlthoiAcid')).toBe('Olthoi Spitter');
    expect(resolveHeritageDisplayName(Heritage.Shadowbound, 'Shadowbound')).toBe('Umbraen');
    expect(resolveHeritageDisplayName(Heritage.Gharundim, undefined)).toBe("Gharu'ndim");
  });

  it('falls back to the raw DAT name only for an unrecognized heritage id', () => {
    expect(resolveHeritageDisplayName(999, 'SomeNewHeritage')).toBe('SomeNewHeritage');
  });

  it('falls back to "Unknown" for an unrecognized heritage id with no DAT name', () => {
    expect(resolveHeritageDisplayName(999, undefined)).toBe('Unknown');
  });
});

// ── DAT verification (skipped in CI) ────────────────────────────────
describe.skipIf(!existsSync(DAT_PATH))('DAT canonical labels (FAITHFUL.285)', () => {
  // A skipped describe's callback still runs at collection — the DAT load
  // lives in beforeAll so CI (no dat/) never touches the file.
  let table: ReturnType<typeof import('@ac/dat-parser')['parseStringTable']> | null = null;
  beforeAll(async () => {
    const { DatDatabase, DatReader, parseStringTable } = await import('@ac/dat-parser');
    const buf = readFileSync(DAT_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const db = new DatDatabase(ab);
    const data = db.getFileData(0x23000002);
    table = data ? parseStringTable(new DatReader(data)) : null;
  });

  const lookup = (id: number): string | undefined => {
    if (!table) return undefined;
    for (const e of table.entries) if (e.id === id) return e.strings[0];
    return undefined;
  };

  it('"Olthoi Soldier" + "Olthoi Spitter" exist verbatim in StringTable 0x23000002', () => {
    expect(lookup(245946601)).toBe('Olthoi Soldier');
    expect(lookup(149147940)).toBe('Olthoi Spitter');
  });

  it('DAT confirms "Gear Knight" (two words) — `Select…Gear Knight`', () => {
    expect(lookup(165449668)).toContain('Gear Knight');
  });

  it('DAT confirms "Aun Tumerok" — `Select…Aun Tumerok`', () => {
    expect(lookup(192670939)).toContain('Aun Tumerok');
  });

  it('DAT lore corroborates "UMBRAEN" as the Shadowbound retail name', () => {
    expect(lookup(83891876)).toMatch(/UMBRAEN/);
  });
});

// ── End-to-end: real DAT-loaded HeritageGroupCG.name through the resolver ──
// (skipped in CI, no dat/) — this is the exact call shape every GameUI.ts
// site now uses: raw CharacterGenerator data straight into
// resolveHeritageDisplayName(), proving the truncated 4-of-13 DAT names get
// corrected rather than passed through.
describe.skipIf(!existsSync(PORTAL_DAT_PATH))('GameUI call-site shape: real DAT name -> resolveHeritageDisplayName (BUG.heritage-name-truncated-uncorrected)', () => {
  let rawNames: Map<number, string> | null = null;

  beforeAll(async () => {
    const { DatDatabase, DatReader } = await import('@ac/dat-parser');
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    const buf = readFileSync(PORTAL_DAT_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const db = new DatDatabase(ab);
    const data = db.getFileData(0x0E000002);
    if (!data) throw new Error('CharacterGenerator 0x0E000002 missing from client_portal.dat');
    const charGen = new CharacterGenerator(new DatReader(data));
    rawNames = new Map();
    for (const [id, group] of charGen.heritageGroups) rawNames.set(id, group.name);
  });

  it('the raw DAT name is truncated/internal for the 4 known-bad heritages', () => {
    if (!rawNames) throw new Error('beforeAll did not load the heritage names');
    expect(rawNames.get(Heritage.Gearknight)).toBe('Gear');
    expect(rawNames.get(Heritage.Tumerok)).toBe('Tumerok');
    expect(rawNames.get(Heritage.Olthoi)).toBe('Olthoi');
    expect(rawNames.get(Heritage.OlthoiAcid)).toBe('OlthoiAcid');
  });

  it('resolveHeritageDisplayName(heritage, rawDatName) corrects all 13 heritages to retail wording', () => {
    if (!rawNames) throw new Error('beforeAll did not load the heritage names');
    for (const [id, expected] of Object.entries(HERITAGE_DISPLAY_NAME_FALLBACK)) {
      expect(resolveHeritageDisplayName(Number(id), rawNames.get(Number(id)))).toBe(expected);
    }
  });
});
