/**
 * STREAM.dungeon-entry-one-shots — entering an interior landblock built its
 * collision and its cell index once. With DAT streaming (after the
 * portal-space gate's timeout or a failed fetch) a missed cell, Environment
 * or static GfxObj left that floor / wall / furniture without collision,
 * that room undrawn or untextured, for the whole stay; a missed
 * LandblockInfo capped the dungeon at 200 cells.
 *  - world/DungeonCollisionBuild.populateDungeonCollision (login + teleport
 *    shared it inline) runs again once files land: keyed adds fill the gaps
 *    without duplicates.
 *  - DungeonRenderer re-scans cells whose EnvCell missed, rebuilds a cell
 *    mesh built across a miss once the files land, and scans the whole
 *    interior range when the LandblockInfo is missing.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { populateDungeonCollision, type DungeonCollisionSources } from '../packages/renderer/src/world/DungeonCollisionBuild.js';
import { DungeonRenderer } from '../packages/renderer/src/world/DungeonRenderer.js';
import { noteDatMiss, noteDatMissResolved } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const total = (c: DungeonCollision) => c.cellCount + c.cylinderCount + c.sphereCount;

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('populateDungeonCollision (DAT: training academy dungeon 0x8602)', () => {
  let sources: DungeonCollisionSources;
  beforeAll(async () => {
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const tm = new TextureManager(portalDb);
    const mf = new MaterialFactory(portalDb, tm);
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const env = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    const dungeon = new DungeonRenderer(cellDb, env);
    sources = {
      findInteriorCells: (lb) => dungeon.findInteriorCells(lb),
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
      loadLandblockInfo: (lb) => dungeon.loadLandblockInfo(lb),
    };
  });

  it('a second run after missed files fills in what the first missed, with no duplicates', () => {
    const geoLb = 0x8602ffff;
    const full = new DungeonCollision();
    populateDungeonCollision(full, geoLb, sources);
    expect(full.cellCount).toBeGreaterThan(10);

    // First run: every other cell's EnvCell and every GfxObj "not resident".
    let n = 0;
    const missing: DungeonCollisionSources = {
      ...sources,
      getCellCollisionData: (id) => (n++ % 2 ? null : sources.getCellCollisionData(id)),
      loadGfxObj: () => null,
    };
    const retried = new DungeonCollision();
    populateDungeonCollision(retried, geoLb, missing);
    expect(total(retried)).toBeLessThan(total(full));
    populateDungeonCollision(retried, geoLb, sources);
    expect(retried.cellCount).toBe(full.cellCount);
    expect(retried.cylinderCount).toBe(full.cylinderCount);
    expect(retried.sphereCount).toBe(full.sphereCount);
    // Idempotent.
    populateDungeonCollision(retried, geoLb, sources);
    expect(total(retried)).toBe(total(full));
  });
});

describe('populateDungeonCollision dispatch (FAITHFUL.116 / FAITHFUL.118: by PortalFileType, never a bare 0x0N)', () => {
  it('dispatches a Setup static part by part, a lone GfxObj static once, and a building model the same way', () => {
    const gfx = (id: number) => ({ id, physicsBSP: { rootNode: {} }, physicsPolygons: new Map([[0, {}]]) });
    const frame = { origin: { x: 1, y: 2, z: 3 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };
    const keys: string[] = [];
    const collision = {
      addCell: () => {},
      addGfxObjCollision: (key: unknown, g: { id: number }) => { keys.push(`${String(key)}#${g.id.toString(16)}`); },
    } as unknown as DungeonCollision;
    const sources: DungeonCollisionSources = {
      findInteriorCells: () => [0x01020100],
      getCellCollisionData: () => ({ cellStruct: {} as never, position: frame as never }),
      loadEnvCell: () => ({ staticObjects: [{ id: 0x02000abc, frame }, { id: 0x01000def, frame }, { id: 0x0d000001, frame }] } as never),
      loadSetupModel: () => ({ parts: [0x01000001, 0x01000002], placementFrames: new Map() } as never),
      loadGfxObj: (id) => gfx(id) as never,
      loadLandblockInfo: () => ({ buildings: [{ modelId: 0x01000f00, frame }] } as never),
    };
    populateDungeonCollision(collision, 0x0102ffff, sources);
    // Setup 0x02…: both parts; GfxObj 0x01…: itself; anything else (0x0D…): nothing; the building: itself.
    expect(keys.map((k) => k.split('#')[1])).toEqual(['1000001', '1000002', '1000def', '1000f00']);
  });
});

/* ── DungeonRenderer over a fake cell DAT ── */

const LB = 0x7f7fffff;
const cellId = (i: number) => ((LB & 0xffff0000) | (0x0100 + i)) >>> 0;

function fakeDungeon(opts: { cells: number; landblockInfo: boolean }) {
  const resident = new Set<number>();
  for (let i = 0; i < opts.cells; i++) resident.add(cellId(i));
  const builds: number[] = [];
  const missOnBuild = new Set<number>();
  const cellDb = {
    hasFile: (id: number) => (id >>> 0) === (((LB & 0xffff0000) | 0xfffe) >>> 0) ? opts.landblockInfo : (id >>> 16) === (LB >>> 16) && (id & 0xffff) >= 0x100 && (id & 0xffff) < 0x100 + opts.cells,
    getFileData: () => null, // LandblockInfo not resident (or absent)
  };
  const env = {
    loadEnvCell: (id: number) => (resident.has(id) ? { position: { origin: { x: (id & 0xff) * 4, y: 0, z: 0 } }, visibleCells: [] } : null),
    createCellMesh: (id: number) => {
      builds.push(id);
      if (missOnBuild.delete(id)) noteDatMiss();
      const g = new THREE.Group(); g.name = `envcell_${id.toString(16)}`; return g;
    },
  };
  const dungeon = new DungeonRenderer(cellDb as never, env as never);
  return { dungeon, resident, builds, missOnBuild };
}

afterEach(() => { vi.useRealTimers(); });

describe('DungeonRenderer under streaming', () => {
  it('scans the whole interior range when the LandblockInfo is not resident (no 200-cell cap)', () => {
    const { dungeon } = fakeDungeon({ cells: 260, landblockInfo: true });
    expect(dungeon.findInteriorCells(LB)).toHaveLength(260);
  });

  it('a cell whose EnvCell missed at the pre-scan is drawn once it arrives', () => {
    const f = fakeDungeon({ cells: 3, landblockInfo: true });
    f.resident.delete(cellId(2));
    f.dungeon.initStream(LB);
    f.dungeon.updateStream(0, 0);
    expect(f.dungeon.streamCellCount).toBe(2);
    f.resident.add(cellId(2));
    f.dungeon.updateStream(0, 0);
    expect(f.dungeon.streamCellCount).toBe(3);
    expect(f.builds).toContain(cellId(2));
  });

  it('a cell mesh built across a miss is rebuilt once the missed files land', () => {
    vi.useFakeTimers();
    const f = fakeDungeon({ cells: 2, landblockInfo: true });
    f.missOnBuild.add(cellId(1));
    f.dungeon.initStream(LB);
    f.dungeon.updateStream(0, 0);
    expect(f.builds.filter((id) => id === cellId(1))).toHaveLength(1);
    noteDatMissResolved();
    vi.runAllTimers();
    f.dungeon.updateStream(0, 0);
    expect(f.builds.filter((id) => id === cellId(1))).toHaveLength(2); // rebuilt whole
    expect(f.builds.filter((id) => id === cellId(0))).toHaveLength(1); // a complete cell is kept
    expect(f.dungeon.streamCellCount).toBe(2);
  });
});
