// retail-find-cell.ts — which cell the retail client puts a Position in.
//
// CPhysicsObj::AdjustPosition's env-cell branch (@ 00511d80, decomp
// annotated.c:264491): GetVisible(objcell_id) → CEnvCell::find_visible_child_cell
// (@ 0052dc50, annotated.c:293920) tests the NAMED cell's point_in_cell, then
// only the cells in that cell's stab list (VisibleCells). No hit and the cell
// is SeenOutside → Position::adjust_to_outside (the landscape); no hit
// otherwise → no cell at all, and retail draws nothing (an all-black 3D view:
// the 2026-10-02 retail A/B at the Crater Caves / Soul-Fearing Vestry portal
// destinations, HARNESS.retail-ab-dark-dungeons). There is no landblock-wide
// scan, so a Position whose cell id disagrees with its point lands only if
// the true cell is in the named cell's stab list (Dungeon Manor's does).
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.ts';
import { EnvCell, EnvCellFlags } from '../../packages/dat-parser/src/file-types/EnvCell.ts';
import { Environment } from '../../packages/dat-parser/src/file-types/Environment.ts';
import type { BSPNodeBase } from '../../packages/dat-parser/src/file-types/BSPTree.ts';
import { pointInCell, type ACQuat, type ACVec3 } from '../../packages/renderer/src/world/cellContainment.ts';

/** What find_visible_child_cell needs of one cell. */
export interface FindCellInfo {
  seenOutside: boolean;
  /** Stab list: low 16 bits of each visible cell id, in DAT order. */
  visibleCells: number[];
  origin: ACVec3;
  quat: ACQuat;
  cellBspRoot: BSPNodeBase | undefined;
}

export type FindCellResult =
  | { kind: 'named'; cellId: number }
  | { kind: 'stab'; cellId: number }
  | { kind: 'outside' }
  | { kind: 'none'; reason: string };

/**
 * Retail's cell for `point` (landblock-local AC coordinates) given the
 * Position's env-cell id. `lookup` returns null for a cell the DAT lacks
 * (GetVisible fails).
 */
export function retailFindEnvCell(cellId: number, point: ACVec3, lookup: (id: number) => FindCellInfo | null): FindCellResult {
  const named = lookup(cellId);
  if (!named) return { kind: 'none', reason: `cell 0x${hex(cellId)} not in cell.dat` };
  const inside = (c: FindCellInfo): boolean => pointInCell(c.cellBspRoot, c.origin, c.quat, point);
  if (inside(named)) return { kind: 'named', cellId };
  const lb = cellId & 0xffff0000;
  for (const low of named.visibleCells) {
    const id = (lb | low) >>> 0;
    const c = lookup(id);
    if (c && inside(c)) return { kind: 'stab', cellId: id };
  }
  if (named.seenOutside) return { kind: 'outside' };
  return { kind: 'none', reason: `point not in 0x${hex(cellId)} or its ${named.visibleCells.length} stab cells` };
}

const hex = (n: number): string => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** A `lookup` over the real DATs (EnvCell from cell.dat, its CellStruct's CELL BSP from portal.dat). */
export function datCellLookup(cellDat: DatDatabase, portalDat: DatDatabase): (id: number) => FindCellInfo | null {
  const envs = new Map<number, Environment>();
  return (id) => {
    if (!cellDat.hasFile(id >>> 0)) return null;
    const ec = new EnvCell(cellDat.getReader(id >>> 0));
    let env = envs.get(ec.environmentId);
    if (!env) { env = new Environment(portalDat.getReader(ec.environmentId)); envs.set(ec.environmentId, env); }
    const cs = env.cells.get(ec.cellStructure);
    return {
      seenOutside: (ec.flags & EnvCellFlags.SeenOutside) !== 0,
      visibleCells: ec.visibleCells,
      origin: ec.position.origin,
      quat: ec.position.orientation,
      cellBspRoot: cs?.cellBSP.rootNode,
    };
  };
}
