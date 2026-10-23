/**
 * BUG.ac1999-map-eor-art follow-up: the agent's town names (agent/towns.ts: nearestTownOf, townInName) per era.
 * End of retail and the classic eras: their client's map notes (end of retail's 53 unchanged; CustomDM's exe calls
 * Sanamar's note "Other"). 1999 has no notes: its world's towns (towns1999.ts), generated from the 1999 map marker
 * table and the 1999 cell.dat by tools/build-agent-towns.ts (tools/lib/agent-towns.ts).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AC1999_TOWNS, MAP_TOWNS, agentTowns, eraTowns, nearestTownOf, setAgentTownsEra, townInName, townsOfNotes,
} from '../packages/renderer/src/agent/towns.js';
import { AC1999_TOWN_ROWS } from '../packages/renderer/src/agent/towns1999.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { MAP_NOTE_LOCATIONS } from '../packages/renderer/src/ui/HudTooltips.js';
import { buildingCounter, deriveAgentTowns, landblockOfCoords, townRowsOfMarkerTable } from '../tools/lib/agent-towns.js';
import markers1999 from '../packages/renderer/src/ui/maps/markers/ac1999.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999CellOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';

const HOLTBURG = { ns: 42.3, ew: 33.6 };
const AYAN_BAQUR = { ns: -59.9, ew: -87.9 };

afterEach(() => setAgentTownsEra(null));

describe('end of retail is unchanged', () => {
  it('the 53 notes, inverted from the end-of-retail marker box, are the default towns', () => {
    expect(MAP_TOWNS).toHaveLength(53);
    expect(townsOfNotes(MAP_NOTE_LOCATIONS)).toEqual(MAP_TOWNS);
    expect(agentTowns()).toBe(MAP_TOWNS);
    for (const id of ['eor', 'classic-dereth', 'classic-dereth-1-0', 'classicace-infiltration']) expect(eraTowns(eraProfile(id)), id).toBe(MAP_TOWNS);
    expect(eraTowns(null)).toBe(MAP_TOWNS);
  });
  it('names places as before', () => {
    expect(nearestTownOf(HOLTBURG)?.text).toBe('Holtburg');
    expect(nearestTownOf(AYAN_BAQUR)?.name).toBe('Ayan Baqur');
    expect(townInName('Holtburg lifestone')).toEqual({ town: 'Holtburg', rest: 'lifestone' });
    expect(townInName('the Life Stone in Ayan Baqur')).toEqual({ town: 'Ayan Baqur', rest: 'Life Stone' });
    setAgentTownsEra(eraProfile('eor'));
    expect(agentTowns()).toBe(MAP_TOWNS);
  });
});

describe('ClassicACE CustomDM: its exe\'s notes', () => {
  it('Sanamar\'s note is "Other", at the same place; the rest are end of retail\'s', () => {
    const t = eraTowns(eraProfile('classicace-customdm'));
    expect(eraTowns(eraProfile('classicace-customdm'))).toBe(t);
    expect(t.map((x) => x.name)).toEqual(MAP_TOWNS.map((x) => (x.name === 'Sanamar' ? 'Other' : x.name)));
    expect(t.map((x) => x.coords)).toEqual(MAP_TOWNS.map((x) => x.coords));
  });
});

describe('1999: the world\'s towns', () => {
  it('the generated table: start towns and release towns in, post-1999 towns and the end-of-retail-only notes out', () => {
    expect(eraTowns(eraProfile('ac1999-retail'))).toBe(AC1999_TOWNS);
    expect(AC1999_TOWNS).toHaveLength(AC1999_TOWN_ROWS.length);
    const names = new Set(AC1999_TOWNS.map((t) => t.name));
    for (const n of ['Holtburg', 'Shoushi', 'Yaraq', 'Arwic', 'Rithwic', 'Qalaba\'r', 'Yanshi', 'Bandit Castle']) expect(names.has(n), n).toBe(true);
    for (const n of ['Ayan Baqur', 'Candeth Keep', "Danby's Outpost", 'Aerlinthe Island', 'Singularity Caul Island', 'Sanamar', 'Timaru', 'Yanshi (Old)', 'Yanshi (Rebuilt)']) {
      expect(names.has(n), n).toBe(false);
    }
  });
  it('the agent names 1999 places by them', () => {
    setAgentTownsEra(eraProfile('ac1999-retail'));
    expect(agentTowns()).toBe(AC1999_TOWNS);
    expect(nearestTownOf(HOLTBURG)?.text).toBe('Holtburg');
    expect(nearestTownOf(AYAN_BAQUR)).toBeUndefined();
    expect(townInName('Holtburg lifestone')).toEqual({ town: 'Holtburg', rest: 'lifestone' });
    expect(townInName('the Life Stone in Ayan Baqur')).toBeNull();
    expect(townInName('Yanshi healer')).toEqual({ town: 'Yanshi', rest: 'healer' });
  });
});

describe('the derivation (tools/lib/agent-towns.ts)', () => {
  it('keeps a row only where its 3x3 landblocks hold a building, and drops a lone disambiguating suffix', () => {
    const rows = [
      { name: 'A (Old)', ns: 0.5, ew: 0.5 }, { name: 'A (Rebuilt)', ns: 50, ew: 50 },
      { name: 'B (Old)', ns: 10, ew: 10 }, { name: 'B (New)', ns: 20, ew: 20 }, { name: 'C', ns: -40, ew: -40 },
    ];
    const lbA = landblockOfCoords(0.5, 0.5);
    expect(lbA).toEqual({ x: 128, y: 128 });
    const withBuildings = new Set([`${lbA.x + 1},${lbA.y}`, ...['B (Old)', 'B (New)'].map((n) => {
      const r = rows.find((x) => x.name === n)!; const l = landblockOfCoords(r.ns, r.ew); return `${l.x},${l.y - 1}`;
    })]);
    const out = deriveAgentTowns(rows, (x, y) => (withBuildings.has(`${x},${y}`) ? 2 : 0));
    expect(out.map((r) => r.name)).toEqual(['A', 'B (New)', 'B (Old)']);
  });
  it('the marker table\'s T / O rows', () => {
    const rows = townRowsOfMarkerTable(JSON.stringify({ m: [['T', 'X', 1, 2], ['L', 'Life Stone', 1, 2], ['O', 'Y Outpost', 3, 4]] }));
    expect(rows).toEqual([{ name: 'X', ns: 1, ew: 2 }, { name: 'Y Outpost', ns: 3, ew: 4 }]);
  });
});

const CELL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'cell.dat');
describe.skipIf(!existsSync(CELL_1999))('towns1999.ts is what the 1999 data gives', () => {
  it('re-derived from the 1999 marker table and the 1999 cell.dat', () => {
    const cell = new DatDatabase(new FileDatBytes(CELL_1999));
    cell.setOverlay(ac1999CellOverlay());
    const towns = deriveAgentTowns(townRowsOfMarkerTable(markers1999), buildingCounter(cell));
    expect(towns.map((t) => [t.name, t.ns, t.ew])).toEqual(AC1999_TOWN_ROWS.map((r) => [...r]));
    // The 1999 world DB places NPCs at Ayan Baqur, but the 1999 landscape has no building there.
    expect(townRowsOfMarkerTable(markers1999).some((r) => r.name === 'Ayan Baqur')).toBe(true);
  });
});
