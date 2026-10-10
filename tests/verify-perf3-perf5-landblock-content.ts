/**
 * PERF.3 / PERF.5 — the landblock object streamer over the REAL EoL
 * cell.dat / portal.dat (tools/landblock-content-census.ts drives the
 * shipped LandblockObjectStreamer + LandblockScenery; mesh builders are
 * counted stubs).
 *
 * PERF.5 — at the retail default Landscape Draw Distance (8) objects exist
 * only on the 3×3 full-detail blocks (LScape::get_block_orient @ 00504f90 +
 * CLandBlock::notify_change_size @ 005302c0), plus a hidden prefetch ring;
 * the scenery the streamer builds is exactly SceneryGenerator's placements.
 *
 * PERF.3 — the sparring-golem dungeon area (PERF.3's parking spot, 0x0366:
 * 108,887 scene meshes, 18,407 envcell groups) builds no interior cell at
 * all on the surface; the under-Holtburg-hill complex 0xACB5 keeps collision
 * for every cell walkable from its building but renders only the doorway
 * stab cells until the player stands inside, when the current cell + PVS
 * build, and they retire when the player's cell leaves the block.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import { Scene } from '@ac/dat-parser/file-types/Scene.js';
import { openDats, makeCensusStreamer, landblockContentCensus } from '../tools/landblock-content-census.js';
import { collectBuildingStabCells } from '../packages/renderer/src/world/buildingCells.js';
import { createLandblockSceneryBuilder } from '../packages/renderer/src/world/LandblockScenery.js';
import { generateScenery, makeTerrainSampler, buildingCellMask } from '../packages/renderer/src/terrain/SceneryGenerator.js';
import { SceneryInstancer } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';

const HAS_DATS = existsSync('dat/client_cell_1.dat') && existsSync('dat/client_portal.dat');

describe.skipIf(!HAS_DATS)('PERF.3 / PERF.5 — landblock content over the real DATs', () => {
  let dats: ReturnType<typeof openDats>;
  beforeAll(() => { dats = openDats(); });

  it('Holtburg at draw distance 8: 9 blocks draw (25 built), every stab cell of the built blocks has a mesh', () => {
    const c = landblockContentCensus(dats, 0xa9, 0xb4, 8);
    expect(c.objectBlocksShown).toBe(9);
    expect(c.objectBlocksBuilt).toBe(25);
    let stabCells = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const data = dats.cellDb.getFileData((((0xa9 + dx) << 24) | ((0xb4 + dy) << 16) | 0xfffe) >>> 0);
        if (!data) continue;
        const info = new LandblockInfo(new DatReader(data));
        stabCells += collectBuildingStabCells(info.buildings, info.numCells).size;
      }
    }
    expect(stabCells).toBeGreaterThan(100);
    expect(c.cellMeshesBuilt).toBe(stabCells);
    expect(c.cellCollisionRegistered).toBeGreaterThanOrEqual(stabCells);
    expect(c.buildingInstancesDrawn).toBeGreaterThan(0);
    expect(c.sceneryInstancesDrawn).toBeGreaterThan(0);
  });

  it('the sparring-golem dungeon area builds no interior cell mesh and no cell collision on the surface', () => {
    const c = landblockContentCensus(dats, 0x03, 0x66, 8);
    expect(c.interiorCellsInBlocks).toBeGreaterThan(1000);
    expect(c.cellMeshesBuilt).toBe(0);
    expect(c.cellCollisionRegistered).toBe(0);
  });

  it('0xACB5: collision for the whole walkable complex; the PVS builds on entry and retires on exit', () => {
    const { streamer, collision, env } = makeCensusStreamer(dats, 8);
    streamer.loadAround(0xac, 0xb5);
    const bk = (0xac << 8) | 0xb5;
    const block = streamer.surfaceCellRegistry.get(bk)!;
    const stabOnly = block.meshes.size;
    expect(stabOnly).toBe(block.stabSet.size);
    // The deep room 0xACB50104 is walkable (collision present) but not a stab cell.
    const deep = 0xacb50104;
    expect(block.meshes.has(deep & 0xffff)).toBe(false);
    const probe = collision as unknown as { envCells: Map<number, unknown> };
    expect(probe.envCells.has(deep)).toBe(true);
    // Every one of its portal neighbours has collision too — reachable before the player gets there.
    for (const p of env.loadEnvCell(deep)!.cellPortals) {
      if (p.otherCellId !== 0xffff) expect(probe.envCells.has((0xacb50000 | p.otherCellId) >>> 0)).toBe(true);
    }
    // Standing in it: current cell + PVS build.
    const pvs = new Set([deep & 0xffff, ...env.loadEnvCell(deep)!.visibleCells]);
    const built = streamer.ensureSurfaceCells(bk, pvs);
    expect(built).toBeGreaterThan(40);
    for (const idx of pvs) expect(block.meshes.has(idx), idx.toString(16)).toBe(true);
    // Walking out: the demand cells retire, the stab cells stay.
    expect(streamer.retireSurfaceCells(-1)).toBe(built);
    expect(block.meshes.size).toBe(stabOnly);
  });

  it('LandblockScenery builds exactly SceneryGenerator\'s placements at their placement matrices (Holtburg)', () => {
    const { cellDb, portalDb, regionDesc } = dats;
    const collision = new DungeonCollision();
    const build = createLandblockSceneryBuilder({
      cellDb, portalDb, regionDesc, hasModel: () => true, objectPhysics: () => null, collision, warn: { warn: () => {} },
    });
    const id = 0xa9b3ffff;
    const lb = CellLandblock.read(new DatReader(cellDb.getFileData(id)!));
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(0xa9b3fffe)!));
    const sceneCache = new Map<number, Scene | null>();
    const loadScene = (sid: number) => {
      if (!sceneCache.has(sid)) { const d = portalDb.getFileData(sid); sceneCache.set(sid, d ? Scene.read(new DatReader(d)) : null); }
      return sceneCache.get(sid)!;
    };
    const expected = generateScenery(id, lb, regionDesc, loadScene, makeTerrainSampler(id, lb, regionDesc), {
      excludeCells: lb.hasObjects ? buildingCellMask(info.buildings) : new Set(),
    });
    const got = build(0xa9, 0xb3)!;
    expect(expected.length).toBeGreaterThan(0);
    expect(got.entries).toHaveLength(expected.length);
    expect(got.entries[0].objId).toBe(expected[0].objId);
    expect(got.entries[0].matrix.equals(SceneryInstancer.placementMatrix(expected[0], 0xa9 * 192, 0xb3 * 192))).toBe(true);
    expect(got.collisionKeys).toHaveLength(0); // no physics models resolved here
  });
});
