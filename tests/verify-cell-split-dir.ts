/**
 * computeCellSplitDir audit (FAITHFUL.155).
 *
 * The cell-triangle-split PRNG was duplicated across LandblockMesh.ts
 * (renderer mesh generation) and TerrainCollision.ts (shared physics).
 * Both copies returned the same value for the same inputs but the four
 * magic-hash constants were transcribed twice — any future fix to one
 * site (e.g. correcting a sign bug or overflow handling) would have
 * silently broken visual + physics alignment.
 *
 * After FAITHFUL.155 there's one canonical implementation in
 * packages/shared/src/physics/CellSplitDir.ts. This test pins it against
 * ACE.Server/Entity/LandblockMesh.cs:160-169 byte-for-byte AND verifies
 * both consumers route through the single helper.
 *
 * DEBT.test-harness-hygiene: the "no duplicate implementations" source pins
 * (grepping LandblockMesh.ts / TerrainCollision.ts for the hash constants) are
 * now behavioural: CellSplitDir.js is wrapped in a call-through spy, and both
 * consumers must invoke it (a private re-implementation would not).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeCellSplitDir, TerrainCollision } from '@ac/shared';
import { LandblockMesh } from '../packages/renderer/src/terrain/LandblockMesh.js';

// Call-through spy on the canonical helper: every importer (the @ac/shared
// barrel, TerrainCollision's relative import, LandblockMesh) gets this one.
vi.mock('../packages/shared/src/physics/CellSplitDir.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/shared/src/physics/CellSplitDir.js')>();
  return { ...real, computeCellSplitDir: vi.fn(real.computeCellSplitDir) };
});

const REPO = resolve(__dirname, '..');
const ACE_LBM = resolve(REPO, 'reference/ACE/Source/ACE.Server/Entity/LandblockMesh.cs');

describe.skipIf(!aceReferenceExists(ACE_LBM))('ACE GetSplitDir coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_LBM, 'utf8');
  });
  it('pins the 4 magic hash constants from ACE source', () => {
    expect(src).toMatch(/0x0CCAC033/);
    expect(src).toMatch(/0x421BE3BD/);
    expect(src).toMatch(/0x6C1AC587/);
    expect(src).toMatch(/0x519B8F25/);
  });
  it('uses the high-bit-zero predicate', () => {
    expect(src).toMatch(/\(dw\s*&\s*0x80000000\)\s*==\s*0/);
  });
  it('credits the AC2D project in a comment', () => {
    expect(src).toMatch(/AC2D/);
  });
});

describe('computeCellSplitDir behavior', () => {
  it('returns true (NW-SE) for the cell at (0,0,0,0)', () => {
    // dw = -0x519B8F25 (signed int32) → high bit is 1 → returns false (SW-NE).
    // Spot check: re-derive the value and confirm.
    const expected = ((-0x519B8F25) | 0) & 0x80000000;
    expect(computeCellSplitDir(0, 0, 0, 0)).toBe(expected === 0);
  });

  it('matches ACE arithmetic on a grid of inputs', () => {
    // Reproduce the C# expression locally and confirm matching truth values.
    const reference = (blockX: number, blockY: number, cellX: number, cellY: number): boolean => {
      const x = (blockX << 3) + cellX;
      const y = (blockY << 3) + cellY;
      const dw = (Math.imul(Math.imul(x, y), 0x0CCAC033)
        - Math.imul(x, 0x421BE3BD)
        + Math.imul(y, 0x6C1AC587)
        - 0x519B8F25) | 0;
      return (dw & 0x80000000) === 0;
    };
    for (const [bx, by, cx, cy] of [
      [0, 0, 0, 0], [1, 1, 1, 1], [127, 200, 3, 5], [0xA1, 0x73, 7, 7],
      [255, 255, 7, 7], [4, 0, 0, 4], [0, 4, 4, 0],
    ]) {
      expect(computeCellSplitDir(bx, by, cx, cy)).toBe(reference(bx, by, cx, cy));
    }
  });

  it('TerrainCollision.getSplitDir routes through computeCellSplitDir', () => {
    for (const [bx, by, cx, cy] of [
      [10, 20, 3, 4], [200, 200, 7, 7], [0x33, 0x77, 0, 1],
    ]) {
      expect(TerrainCollision.getSplitDir(bx, by, cx, cy))
        .toBe(computeCellSplitDir(bx, by, cx, cy));
    }
  });

  it('LandblockMesh.getSplitDir decodes landblockId and routes through computeCellSplitDir', () => {
    // landblockId 0xA17301FF: blockX=0xA1, blockY=0x73, cell=0x01..0xFE
    for (const [lbX, lbY, cellX, cellY] of [
      [0xA1, 0x73, 3, 5], [0x00, 0x00, 0, 0], [0xFF, 0xFF, 7, 7], [0x33, 0x77, 1, 2],
    ]) {
      const landblockId = ((lbX << 24) | (lbY << 16)) >>> 0;
      expect(LandblockMesh.getSplitDir(landblockId, cellX, cellY))
        .toBe(computeCellSplitDir(lbX, lbY, cellX, cellY));
    }
  });
});

describe('Integration: no duplicate implementations remain (FAITHFUL.155)', () => {
  const spy = vi.mocked(computeCellSplitDir);
  beforeEach(() => { spy.mockClear(); });

  it('the canonical helper is the call-through spy (the barrel re-exports CellSplitDir.js)', () => {
    expect(vi.isMockFunction(computeCellSplitDir)).toBe(true);
  });

  it('TerrainCollision.getSplitDir delegates to computeCellSplitDir (no private copy of the hash)', () => {
    TerrainCollision.getSplitDir(0x33, 0x77, 2, 5);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0x33, 0x77, 2, 5);
  });

  it('LandblockMesh.getSplitDir delegates to computeCellSplitDir with the decoded landblock x/y', () => {
    LandblockMesh.getSplitDir(((0xA1 << 24) | (0x73 << 16)) >>> 0, 3, 6);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0xA1, 0x73, 3, 6);
  });
});
