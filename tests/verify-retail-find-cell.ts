/**
 * HARNESS.retail-ab-dark-dungeons — tools/lib/retail-find-cell.ts mirrors
 * retail's CEnvCell::find_visible_child_cell (decomp @ 0052dc50): the named
 * cell, then only its stab list, then adjust_to_outside for a SeenOutside
 * cell, else no cell. The retail A/B tour generator rejects drop points that
 * resolve to no cell (retail drew those all black).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { retailFindEnvCell, datCellLookup, type FindCellInfo } from '../tools/lib/retail-find-cell.ts';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import type { BSPNodeBase } from '../packages/dat-parser/src/file-types/BSPTree.ts';

/** A cell that is the slab lo <= x <= hi (two splitting planes, front = inside). */
function slab(lo: number, hi: number, visibleCells: number[] = [], seenOutside = false): FindCellInfo {
  const leaf = {} as BSPNodeBase;
  const upper = { splittingPlane: { normal: { x: -1, y: 0, z: 0 }, distance: hi }, posNode: leaf } as unknown as BSPNodeBase;
  const root = { splittingPlane: { normal: { x: 1, y: 0, z: 0 }, distance: -lo }, posNode: upper } as unknown as BSPNodeBase;
  return { seenOutside, visibleCells, origin: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, cellBspRoot: root };
}

describe('retailFindEnvCell (synthetic cells)', () => {
  const cells = new Map<number, FindCellInfo>([
    [0x01000100, slab(0, 10, [0x0101])],
    [0x01000101, slab(10, 20, [0x0100])],
    [0x01000102, slab(20, 30)],              // exists, but in nobody's stab list
    [0x01000103, slab(40, 50, [], true)],    // SeenOutside
  ]);
  const lookup = (id: number) => cells.get(id) ?? null;
  const at = (x: number) => ({ x, y: 0, z: 0 });

  it('returns the named cell when it holds the point', () => {
    expect(retailFindEnvCell(0x01000100, at(5), lookup)).toEqual({ kind: 'named', cellId: 0x01000100 });
  });
  it('falls back to a cell in the named cell\'s stab list', () => {
    expect(retailFindEnvCell(0x01000100, at(15), lookup)).toEqual({ kind: 'stab', cellId: 0x01000101 });
  });
  it('finds no cell when the true cell is outside the stab list (no landblock-wide scan)', () => {
    const r = retailFindEnvCell(0x01000100, at(25), lookup);
    expect(r.kind).toBe('none');
  });
  it('adjusts to outside for a SeenOutside cell that misses', () => {
    expect(retailFindEnvCell(0x01000103, at(5), lookup)).toEqual({ kind: 'outside' });
  });
  it('finds no cell when the named cell is not in the DAT', () => {
    const r = retailFindEnvCell(0x01000199, at(5), lookup);
    expect(r).toMatchObject({ kind: 'none' });
    expect((r as { reason: string }).reason).toContain('not in cell.dat');
  });
});

const HAS_DATS = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!HAS_DATS)('retailFindEnvCell over the EoL DATs (portal weenie destinations)', () => {
  let lookup: ReturnType<typeof datCellLookup>;
  beforeAll(() => { lookup = datCellLookup(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal)); });

  it('Holtburg Dungeon lands in its named cell (retail rendered it)', () => {
    expect(retailFindEnvCell(0x01F60289, { x: 96.7, y: -10, z: 0 }, lookup)).toEqual({ kind: 'named', cellId: 0x01F60289 });
  });
  it('Dungeon Manor lands through the stab list (named 0x01E801BA, point in 0x01E8016A; retail rendered it)', () => {
    expect(retailFindEnvCell(0x01E801BA, { x: -0.6, y: -38.5, z: 0 }, lookup)).toEqual({ kind: 'stab', cellId: 0x01E8016A });
  });
  it('Crater Caves and Soul-Fearing Vestry find no cell (retail drew both all black)', () => {
    expect(retailFindEnvCell(0x019A02CA, { x: 40, y: -150, z: 0 }, lookup).kind).toBe('none');
    expect(retailFindEnvCell(0x02EF0269, { x: 210, y: -150, z: -6 }, lookup).kind).toBe('none');
  });
});
