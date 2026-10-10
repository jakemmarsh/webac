/**
 * BUG.sealed-interior-renders-outdoor-terrain — interior/exterior visibility
 * is gated by the DAT's EnvCell SeenOutside flag, exactly as ACE does:
 *   ObjectMaint.cs:379-382 adds outdoor landblock objects only when
 *   cell.SeenOutside; Physics/Common/EnvCell.cs:455 keys IsVisibleIndoors
 *   off the same flag; ACE.DatLoader/FileTypes/EnvCell.cs:34 reads it as
 *   EnvCellFlags 0x01.
 *
 * Unit part drives the real EnvCell parser with hand-built bytes and asserts
 * the flag round-trips. DAT-gated part pins the ground truth the dungeon-entry
 * classification in main.ts relies on: every cell of the Holtburg starter
 * dungeon 0x8602 (including 0x860201AD, the cottage the old ±20m terrain-
 * height heuristic was written around) is sealed, while every Holtburg town
 * interior (0xA9B4 — genuine surface buildings) is SeenOutside.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { EnvCell, EnvCellFlags } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import type { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';

const REPO = resolve(__dirname, '..');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(CELL_DAT);

/** Build a minimal valid EnvCell byte stream (no surfaces/portals/stabs). */
function buildEnvCellBytes(id: number, flags: number): ArrayBuffer {
  // id(4) + flags(4) + dupId(4) + numSurfaces(1) + numPortals(1) + numStabs(2)
  // + envId(2) + cellStructure(2) + frame(28) + staticObjCount(4, gated by 0x02)
  const buf = new ArrayBuffer((flags & 0x02) !== 0 ? 52 : 48);
  const v = new DataView(buf);
  v.setUint32(0, id, true);
  v.setUint32(4, flags, true);
  v.setUint32(8, id, true); // duplicate cell ID
  v.setUint8(12, 0);        // numSurfaces
  v.setUint8(13, 0);        // numPortals
  v.setUint16(14, 0, true); // numStabs
  v.setUint16(16, 0x0100, true); // environmentId (padded to 0x0D000000 by parser)
  v.setUint16(18, 0, true); // cellStructure
  // frame: origin (0,0,0) + orientation (1,0,0,0) — 28 bytes of floats
  v.setFloat32(20, 0, true);
  v.setFloat32(24, 0, true);
  v.setFloat32(28, 0, true);
  v.setFloat32(32, 1, true);
  v.setFloat32(36, 0, true);
  v.setFloat32(40, 0, true);
  v.setFloat32(44, 0, true);
  return buf;
}

describe('EnvCell SeenOutside flag parsing (unit)', () => {
  it('matches ACE EnvCellFlags.SeenOutside = 0x01', () => {
    expect(EnvCellFlags.SeenOutside).toBe(0x01);
  });

  it('parses a sealed cell (flags without bit 0x01)', () => {
    const cell = new EnvCell(new DatReader(buildEnvCellBytes(0x11220101, 0x02)));
    expect(cell.flags & EnvCellFlags.SeenOutside).toBe(0);
    expect(cell.id).toBe(0x11220101);
  });

  it('parses a SeenOutside cell (flags with bit 0x01)', () => {
    const cell = new EnvCell(new DatReader(buildEnvCellBytes(0x11220102, 0x03)));
    expect(cell.flags & EnvCellFlags.SeenOutside).toBe(EnvCellFlags.SeenOutside);
  });
});

describe('TerrainRenderer.setLandscapeVisible (unit)', () => {
  /** Minimal fake TerrainManager: one landblock, flat 2-vertex-strip geometry. */
  const fakeLandblockMesh = {
    geometry: {
      positions: new Float32Array(9 * 3),
      normals: new Float32Array(9 * 3),
      uvs: new Float32Array(9 * 2),
      indices: new Uint16Array([0, 1, 2]),
    },
  };
  function makeRenderer(loadIds: number[]) {
    const scene = new THREE.Scene();
    const fakeManager = {
      update: () => ({ loaded: loadIds, unloaded: [] as number[] }),
      getMesh: () => fakeLandblockMesh,
    } as unknown as TerrainManager;
    return { scene, renderer: new TerrainRenderer(scene, fakeManager) };
  }

  it('hides existing terrain meshes and scenery attachments, then restores them', () => {
    const { renderer } = makeRenderer([0x00010001]);
    const scenery = new THREE.Group();
    renderer.setLandblockAttacher(() => [scenery]);
    renderer.update(0, 0);
    const mesh = renderer.getMesh(0x00010001)!;
    expect(mesh.visible).toBe(true);
    expect(scenery.visible).toBe(true);

    renderer.setLandscapeVisible(false);
    expect(mesh.visible).toBe(false);
    expect(scenery.visible).toBe(false);

    renderer.setLandscapeVisible(true);
    expect(mesh.visible).toBe(true);
    expect(scenery.visible).toBe(true);
  });

  it('landblocks streamed in while hidden arrive hidden', () => {
    const { renderer } = makeRenderer([0x00020001]);
    const scenery = new THREE.Group();
    renderer.setLandblockAttacher(() => [scenery]);
    renderer.setLandscapeVisible(false);
    // The viewer stands on the block (DECOMP.terrain-lod: full resolution).
    renderer.update(0, 2 * 192);
    expect(renderer.getMesh(0x00020001)!.visible).toBe(false);
    expect(scenery.visible).toBe(false);

    renderer.setLandscapeVisible(true);
    expect(renderer.getMesh(0x00020001)!.visible).toBe(true);
    expect(scenery.visible).toBe(true);
  });
});

describe.skipIf(!datPresent)('SeenOutside ground truth in cell.dat (DAT-gated)', () => {
  let db: DatDatabase;

  beforeAll(() => {
    // DAT read must live in beforeAll — vitest executes skipIf'd describe
    // bodies at collection time (see verify-attribute-pictograms.ts).
    const buf = readFileSync(CELL_DAT);
    db = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  });

  const interiorsOf = (lb: number): EnvCell[] => {
    const cells: EnvCell[] = [];
    for (const id of db.listFileIds()) {
      const idx = id & 0xFFFF;
      if ((id >>> 16) === lb && idx >= 1 && idx <= 0xFFFD) {
        cells.push(new EnvCell(db.getReader(id)));
      }
    }
    return cells;
  };

  it('Holtburg starter cottage 0x860201AD is sealed and portals only to interiors', () => {
    const cell = new EnvCell(db.getReader(0x860201AD));
    expect(cell.flags & EnvCellFlags.SeenOutside).toBe(0);
    expect(cell.cellPortals.length).toBeGreaterThan(0);
    for (const p of cell.cellPortals) {
      // otherCellId is the low word of an interior cell id — never 0 (outside)
      expect(p.otherCellId).toBeGreaterThanOrEqual(0x0001);
      expect(p.otherCellId).toBeLessThanOrEqual(0xFFFD);
    }
  });

  it('every cell of starter dungeon 0x8602 is sealed (SeenOutside unset)', () => {
    const cells = interiorsOf(0x8602);
    expect(cells.length).toBeGreaterThan(0);
    const seenOutside = cells.filter(c => (c.flags & EnvCellFlags.SeenOutside) !== 0);
    expect(seenOutside.map(c => c.id.toString(16))).toEqual([]);
  });

  it('every Holtburg town interior (0xA9B4 surface buildings) is SeenOutside', () => {
    const cells = interiorsOf(0xA9B4);
    expect(cells.length).toBeGreaterThan(0);
    const sealed = cells.filter(c => (c.flags & EnvCellFlags.SeenOutside) === 0);
    expect(sealed.map(c => c.id.toString(16))).toEqual([]);
  });
});
