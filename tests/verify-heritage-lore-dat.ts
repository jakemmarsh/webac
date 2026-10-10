/**
 * Heritage lore from DAT StringTable (FAITHFUL.280; ids re-derived
 * VISUAL.chargen-heritage-lore-spacing).
 *
 * Pre-fix the char-gen wizard had a hardcoded `heritageLore` map with
 * only 4 of the 13 ACE heritages. The lore is StringTable 0x23000002's
 * ID_CharGen_<X>Text, <X> chosen by gmCGHeritagePage::Update @ 00483210's
 * switch on heritage - 1: Umbraen (5) and Penumbraen (10) both read
 * "Shad", Olthoi Soldier (12) "Olthoi", Olthoi Spitter (13) "OlthoiAcid".
 * The earlier hand-found numbers left Umbraen empty and swapped the two
 * Olthoi ids (their texts happen to be identical in the EoL DAT).
 *
 * This test pins:
 *   1. Every heritage 1..13 shows its decomp-token lore string.
 *   2. The lore keeps its "\n\n" paragraph breaks (retail draws them).
 *   3. The DAT holds the expected opening phrase at each id (skipped in CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Heritage } from '@ac/shared';
import { registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { StringTableData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');

// The StringTable 0x23000002 lore ids per heritage = acStringHash("ID_CharGen_<X>Text").
const LORE_IDS: Array<[number, number]> = [
  [Heritage.Aluvian, 79636388], [Heritage.Gharundim, 65212900], [Heritage.Sho, 90388308],
  [Heritage.Viamontian, 4274004], [5, 83891876], [Heritage.Gearknight, 16650724], [Heritage.Tumerok, 20976052],
  [Heritage.Lugian, 252393236], [Heritage.Empyrean, 150091556], [Heritage.Penumbraen, 83891876],
  [Heritage.Undead, 150878036], [Heritage.Olthoi, 148898852], [Heritage.OlthoiAcid, 18960164],
];
// Sentinel lore text with the DAT's literal backslash-n paragraph breaks.
const sentinel = (id: number): string => `LORE-${id}\\n\\nsecond   paragraph`;

describe('Heritage lore resolves from the DAT StringTable on the Heritage step (FAITHFUL.280, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    H.ui.getTexURL = () => null;
    const ids = [...new Set(LORE_IDS.map(([, id]) => id))];
    const table: StringTableData = {
      id: 0x23000002, language: 1, unknown: 0,
      entries: ids.map((id) => ({ id, varNames: [], vars: [], strings: [sentinel(id)], comments: [], unknown: 0 })) as unknown as StringTableData['entries'],
    };
    registerStringTable(table);
  });
  afterAll(() => H.teardown());

  /** The last run (the lore) of the one lore text the real renderRaceStep emits for `heritage`. */
  function loreFor(heritage: number): string {
    H.ui.wizard.heritage = heritage;
    const host = H.win.document.createElement('div');
    host.innerHTML = H.ui.renderRaceStep();
    const spans = host.querySelectorAll('.heritage-lore [data-ac-runs]');
    expect(spans.length).toBe(1);
    const runs = JSON.parse((spans[0] as HTMLElement).getAttribute('data-ac-runs') ?? '[]') as Array<{ text: string }>;
    return runs[runs.length - 1]?.text ?? '';
  }

  it.each(LORE_IDS)('heritage %i shows StringTable %i, paragraph breaks kept', (h, id) => {
    expect(loreFor(h)).toBe(`LORE-${id}\n\nsecond   paragraph`);
  });

  it('the pre-fix hardcoded English lore is gone (Aluvian shows only the DAT text)', () => {
    const html = (() => { H.ui.wizard.heritage = Heritage.Aluvian; return H.ui.renderRaceStep() as string; })();
    expect(html).not.toMatch(/Aluvians hail from a land of rolling hills/);
    expect(html).not.toMatch(/Gharu'ndim come from the deserts/);
  });
});

// ── DAT verification (skipped in CI, where dat/ isn't checked in) ────
const DAT_PATH = resolve(REPO, 'dat/client_local_English.dat');

describe.skipIf(!existsSync(DAT_PATH))('DAT contents match our StringTable IDs (FAITHFUL.280)', () => {
  // vitest executes a skipped describe's callback at collection time, so the
  // DAT load lives in beforeAll (CLAUDE.md "Never Break Tests" landmine).
  let table: ReturnType<typeof import('@ac/dat-parser')['parseStringTable']> | null = null;
  beforeAll(async () => {
    // Lazy-load DAT parser only when DAT is present — keeps CI fast.
    const { DatDatabase, DatReader, parseStringTable } = await import('@ac/dat-parser');
    const buf = readFileSync(DAT_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const db = new DatDatabase(ab);  // synchronous: ctor reads header + directory
    const data = db.getFileData(0x23000002);
    table = data ? parseStringTable(new DatReader(data)) : null;
  });
  const lookup = (id: number): string | undefined => {
    if (!table) return undefined;
    for (const e of table.entries) {
      if (e.id === id) return e.strings[0];
    }
    return undefined;
  };

  it('StringTable 0x23000002 is loadable', () => {
    expect(table).not.toBeNull();
    expect(table!.entries.length).toBeGreaterThan(100);
  });

  // Each canonical opening phrase pinned to its StringTable ID.
  // These would break if the DAT itself were swapped — guards against ID drift.
  it.each([
    [79636388,  Heritage.Aluvian,    'ALUVIANS are a fiercely individualistic'],
    [65212900,  Heritage.Gharundim,  "GHARU'NDIM are an eminently honorable"],
    [90388308,  Heritage.Sho,        'The SHO are a people for whom duty'],
    [4274004,   Heritage.Viamontian, 'The war-like VIAMONTIANS'],
    [16650724,  Heritage.Gearknight, 'The GEAR KNIGHTS are a mechanized race'],
    [20976052,  Heritage.Tumerok,    'The TUMEROK are a race of lizard folk'],
    [252393236, Heritage.Lugian,     'The LUGIANS are a race of giants'],
    [150091556, Heritage.Empyrean,   'the EMPYREANS are a people only recently returned'],
    [83891876,  Heritage.Penumbraen, 'The UMBRAEN and PENUMBRAEN are a people'], // also Umbraen (5)
    [150878036, Heritage.Undead,     'The House Mhoire UNDEAD'],
    [148898852, Heritage.Olthoi,     'WARNING: The Olthoi are an advanced racial option'],
    [18960164,  Heritage.OlthoiAcid, 'WARNING: The Olthoi are an advanced racial option'],
  ])('id=%d (Heritage=%i) contains "%s"', (id, _heritage, phrase) => {
    const text = lookup(id);
    expect(text).toBeDefined();
    expect(text!).toContain(phrase);
  });
});
