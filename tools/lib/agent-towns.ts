/**
 * The agent's town table for an era whose client has no map notes (BUG.ac1999-map-eor-art follow-up): derived from
 * that era's own data. Pure, so the generator (tools/build-agent-towns.ts) and the test that pins the committed table
 * share it.
 *
 * Sources:
 *  - the era's UB map town / outpost rows (packages/renderer/src/ui/maps/markers/<era>.ts, tools/build-map-markers.ts:
 *    UB's town list kept only where the era's WORLD places a lifestone, vendor or NPC within 2.0 of it);
 *  - the era's cell.dat: a row is kept only where the 3x3 landblocks around it hold buildings (LandBlockInfo
 *    0xXXYYFFFE). The 1999 world DB places NPCs at a few post-1999 towns (Ayan Baqur, Candeth Keep, Danby's
 *    Outpost) whose landscape the November 1999 cell.dat has no building on.
 *  - A name UB disambiguates with a parenthesized suffix ("Yanshi (Old)" beside the post-1999 "Yanshi (Rebuilt)")
 *    drops the suffix when no other kept row has the same base name: the era had one Yanshi.
 */
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.ts';
import { DatReader } from '../../packages/dat-parser/src/DatReader.ts';
import { LandblockInfo } from '../../packages/dat-parser/src/file-types/LandblockInfo.ts';

export interface AgentTownRow { name: string; ns: number; ew: number }

/** Map coordinates → landblock (CPlayerSystem::InqPlayerCoords inverted: cell = (coord − 0.5)·10 + 1024, 8 per block). */
export function landblockOfCoords(ns: number, ew: number): { x: number; y: number } {
  return { x: Math.floor(((ew - 0.5) * 10 + 1024) / 8), y: Math.floor(((ns - 0.5) * 10 + 1024) / 8) };
}

/** The marker table's town ('T') and outpost ('O') rows. */
export function townRowsOfMarkerTable(json: string): AgentTownRow[] {
  const t = JSON.parse(json) as { m: [string, string, number, number][] };
  return t.m.filter((r) => r[0] === 'T' || r[0] === 'O').map((r) => ({ name: r[1], ns: r[2], ew: r[3] }));
}

/** `buildingsAt(lbx, lby)`: the building count of one landblock in the era's cell.dat. */
export function deriveAgentTowns(rows: readonly AgentTownRow[], buildingsAt: (lbx: number, lby: number) => number): AgentTownRow[] {
  const kept = rows.filter((r) => {
    const l = landblockOfCoords(r.ns, r.ew);
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) n += buildingsAt(l.x + dx, l.y + dy);
    return n > 0;
  });
  const base = (n: string): string => n.replace(/\s*\([^)]*\)$/, '');
  return kept
    .map((r) => (kept.filter((o) => base(o.name) === base(r.name)).length === 1 ? { ...r, name: base(r.name) } : r))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A landblock's building count in a cell `db` (its LandBlockInfo 0xXXYYFFFE; 0 when it has none). */
export function buildingCounter(db: DatDatabase): (lbx: number, lby: number) => number {
  return (lbx, lby) => {
    if (lbx < 0 || lby < 0 || lbx > 0xff || lby > 0xff) return 0;
    const d = db.getFileData(((lbx << 24) | (lby << 16) | 0xfffe) >>> 0);
    return d ? new LandblockInfo(new DatReader(d)).buildings.length : 0;
  };
}
