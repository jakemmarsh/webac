/**
 * landblockX / landblockY / cellIndexOf audit (FAITHFUL.156).
 *
 * AC's `landblockId` packs `(blockX << 24) | (blockY << 16) | cellIndex`.
 * The decoding `(id >>> 24) & 0xFF` for X and `(id >>> 16) & 0xFF` for Y
 * appeared inline at 14+ call sites across the renderer (terrain mesh
 * generation, env cell positioning, dungeon collision, ServerObject
 * world-space transforms, teleport handling). After FAITHFUL.156 there's
 * one canonical decoder per axis in @ac/shared/types.ts, and the duplicated
 * inline expressions are gone from every consumer file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { landblockX, landblockY, cellIndexOf } from '@ac/shared';

const REPO = resolve(__dirname, '..');

describe('landblockX/Y/cellIndexOf semantics', () => {
  it('extracts X from the high byte', () => {
    expect(landblockX(0xA17301FF)).toBe(0xA1);
    expect(landblockX(0x00FF0000)).toBe(0x00);
    expect(landblockX(0xFF000000)).toBe(0xFF);
  });
  it('extracts Y from the second byte', () => {
    expect(landblockY(0xA17301FF)).toBe(0x73);
    expect(landblockY(0x00FF0000)).toBe(0xFF);
  });
  it('extracts cell index from the low 16 bits', () => {
    expect(cellIndexOf(0xA17301FF)).toBe(0x01FF);
    expect(cellIndexOf(0xA173FFFF)).toBe(0xFFFF);
    expect(cellIndexOf(0xA1730000)).toBe(0x0000);
  });
  it('round-trips the documented ACE Holtburg landblock 0xA9B40000', () => {
    // Holtburg lifestone landblock in retail = 0xA9B40000 → X=0xA9, Y=0xB4
    expect(landblockX(0xA9B40000)).toBe(0xA9);
    expect(landblockY(0xA9B40000)).toBe(0xB4);
    expect(cellIndexOf(0xA9B40000)).toBe(0);
  });
  it('handles unsigned uint32 high-bit safely (no negative numbers)', () => {
    // 0xFF000000 has bit 31 set; without >>> the result would be negative.
    expect(landblockX(0xFF000000)).toBe(0xFF);
    expect(landblockX(0xFF000000)).toBeGreaterThan(0);
  });
});

describe('No duplicate inline decoders remain (FAITHFUL.156)', () => {
  // Files that previously contained `(id >>> 24) & 0xFF` patterns:
  const consumers = [
    'packages/renderer/src/main.ts',
    'packages/renderer/src/world/DungeonRenderer.ts',
    'packages/renderer/src/world/ServerObjectManager.ts',
    'packages/renderer/src/world/EnvCellRenderer.ts',
    'packages/renderer/src/world/DungeonCollision.ts',
    'packages/renderer/src/terrain/LandblockMesh.ts',
  ];

  for (const path of consumers) {
    it(`${path} no longer contains the inline >>> 24/16 & 0xFF pattern`, () => {
      const src = readFileSync(resolve(REPO, path), 'utf8');
      // Allow the pattern only in comments/docs.
      const codeLines = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.includes('fileType'));
      const codeOnly = codeLines.join('\n');
      expect(codeOnly).not.toMatch(/>>>?\s*24\s*\)?\s*&\s*0xFF/);
      expect(codeOnly).not.toMatch(/>>>?\s*16\s*\)?\s*&\s*0xFF/);
      // And the helpers ARE imported.
      expect(src).toMatch(/landblockX/);
    });
  }
});
