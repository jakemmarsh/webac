/**
 * isInteriorCellIndex contract test.
 *
 * FAITHFUL.148 hoisted the duplicated `cellId >= 0x0100 && cellId < 0xFFFE`
 * predicate (5 sites across main.ts + ServerObjectManager.ts) into a single
 * @ac/shared helper. The bounds differ deliberately from ACE's
 * LandblockId.Indoors (`>= 0x100` with no upper bound) — the client receives
 * full landblock IDs on the wire (e.g. 0xXXYYFFFF for terrain) and must
 * exclude terrain (0xFFFF) + LandBlockInfo (0xFFFE) per the cell.dat format
 * (CLAUDE.md "File Type ID Ranges").
 */
import { describe, it, expect } from 'vitest';
import { isInteriorCellIndex } from '@ac/shared';
import { arrivalMode } from '../packages/renderer/src/world/arrivalMode.js';

describe('isInteriorCellIndex bounds', () => {
  it('returns false for outdoor sub-cells (< 0x100)', () => {
    expect(isInteriorCellIndex(0x0000)).toBe(false);
    expect(isInteriorCellIndex(0x0029)).toBe(false); // typical outdoor sub-cell
    expect(isInteriorCellIndex(0x0073)).toBe(false);
    expect(isInteriorCellIndex(0x00FF)).toBe(false); // just below the boundary
  });

  it('returns true for interior EnvCells (0x0100..0xFFFD)', () => {
    expect(isInteriorCellIndex(0x0100)).toBe(true); // boundary low
    expect(isInteriorCellIndex(0x0102)).toBe(true);
    expect(isInteriorCellIndex(0x1234)).toBe(true);
    expect(isInteriorCellIndex(0xFFFD)).toBe(true); // boundary high
  });

  it('returns false for LandBlockInfo (0xFFFE)', () => {
    expect(isInteriorCellIndex(0xFFFE)).toBe(false);
  });

  it('returns false for terrain LandBlock (0xFFFF)', () => {
    expect(isInteriorCellIndex(0xFFFF)).toBe(false);
  });
});

// main.ts's arrival rule (login + teleport) reads the helper through
// world/arrivalMode.ts — driven here instead of the old source-text pin
// (the helper-call count in main.ts).
describe('arrivalMode uses the same interior bounds (FAITHFUL.148)', () => {
  const sealed = () => false;
  it('terrain (0xFFFF), LandBlockInfo (0xFFFE) and land cells arrive outdoors', () => {
    for (const id of [0xa9b4ffff, 0xa9b4fffe, 0xa9b40029, 0xa9b400ff]) {
      expect(arrivalMode(id, sealed)).toEqual({ kind: 'outdoor', surfaceCellId: 0 });
    }
  });
  it('a sealed EnvCell (0x0100..0xFFFD) arrives in interior mode', () => {
    for (const id of [0x86020100, 0x86021234, 0x8602fffd]) {
      expect(arrivalMode(id, sealed)).toEqual({ kind: 'interior' });
    }
  });
});

// ServerObjectManager's interior-cell rule is tested behaviorally in
// tests/verify-interior-culling.ts (env-cell indices culled with their cell,
// land cells and 0xFFFE/0xFFFF never), replacing the helper-call-count pin.
