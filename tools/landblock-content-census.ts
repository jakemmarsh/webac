/**
 * PERF.3 / PERF.5 — node-side census of what the landblock OBJECT streamer
 * builds around a spot, from the real cell.dat / portal.dat (no browser).
 *
 * Drives the shipped LandblockObjectStreamer + LandblockScenery with the
 * real LandblockInfo / EnvCell / RegionDesc data; mesh builders are stubbed
 * and counted (their output is not what is being measured — how MANY cells
 * and instances the streaming rules ask for is). Physics models resolve to
 * null (scenery obj_within_block passes everything), identically for every
 * run, so counts compare run to run.
 *
 * Usage: npx tsx tools/landblock-content-census.ts [0xXXYY ...] [--radius N]
 *   default spots: Holtburg 0xA9B4 and the sparring-golem dungeon area 0x0366
 *   (the PERF.3 parking spot), radius 8 (retail "Medium").
 *
 * Before/after numbers for PERF.3/PERF.5 are in docs/performance-budgets.md.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import { EnvCellRenderer } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { LandblockObjectStreamer, type LandblockObjectStreamerDeps } from '../packages/renderer/src/world/LandblockObjectStreamer.js';
import { createLandblockSceneryBuilder } from '../packages/renderer/src/world/LandblockScenery.js';
import type { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';

export interface CensusResult {
  spot: string;
  radius: number;
  objectBlocksBuilt: number;
  objectBlocksShown: number;
  /** Interior cells that exist in the shown + built blocks' LandblockInfo. */
  interiorCellsInBlocks: number;
  cellMeshesBuilt: number;
  cellCollisionRegistered: number;
  staticInstancesDrawn: number;
  buildingInstancesDrawn: number;
  sceneryInstancesDrawn: number;
  ms: number;
}

function arrayBufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function openDats(root = '.'): { portalDb: DatDatabase; cellDb: DatDatabase; regionDesc: RegionDesc } {
  const portalDb = new DatDatabase(arrayBufferOf(`${root}/dat/client_portal.dat`));
  const cellDb = new DatDatabase(arrayBufferOf(`${root}/dat/client_cell_1.dat`));
  const regionDesc = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
  return { portalDb, cellDb, regionDesc };
}

type CountingPool = { m: Map<number, number>; addBlock(k: number, e: unknown[]): void; removeBlock(k: number): void; setVisible(v: boolean): void };

/** The shipped streamer over the real DATs, with counted stub mesh builders. */
export function makeCensusStreamer(dats: ReturnType<typeof openDats>, radius: number): {
  streamer: LandblockObjectStreamer; collision: DungeonCollision; env: EnvCellRenderer;
  pools: { statics: CountingPool; buildings: CountingPool; scenery: CountingPool };
} {
  const { portalDb, cellDb, regionDesc } = dats;
  const env = new EnvCellRenderer(portalDb, cellDb, null as unknown as MaterialFactory);
  const countingPool = (): CountingPool => {
    const m = new Map<number, number>();
    return { m, addBlock: (k: number, e: unknown[]) => { m.set(k, e.length); }, removeBlock: (k: number) => { m.delete(k); }, setVisible: () => {} };
  };
  const statics = countingPool(), buildings = countingPool(), scenery = countingPool();
  const collision = new DungeonCollision();
  const warn = { warn: () => {} };
  const deps: LandblockObjectStreamerDeps = {
    cellDb,
    addToScene: () => {}, removeFromScene: () => {}, setTerrainVisible: () => {},
    instancer: {
      hasModel: () => true,
      getWorldBBox: (_id, m) => new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 8, 5)).applyMatrix4(m),
    },
    sceneryPool: scenery, staticsPool: statics, buildingsPool: buildings,
    envCells: {
      createCellMesh: () => new THREE.Group(),
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
    },
    setupModels: { createSetupMesh: () => new THREE.Group(), loadSetupModel: () => null },
    models: { createMesh: () => new THREE.Group(), loadGfxObj: () => null },
    degradeLod: { attachPart: () => {} } as unknown as LandblockObjectStreamerDeps['degradeLod'],
    collision,
    objectPhysics: () => null,
    buildScenery: createLandblockSceneryBuilder({
      cellDb, portalDb, regionDesc, hasModel: () => true, objectPhysics: () => null, collision, warn,
    }),
    warn,
    onCollisionMeshesChanged: () => {},
    loadRadius: radius,
    budgetMs: 1e9,
  };
  return { streamer: new LandblockObjectStreamer(deps), collision, env, pools: { statics, buildings, scenery } };
}

export function landblockContentCensus(
  dats: ReturnType<typeof openDats>, cx: number, cy: number, radius: number,
): CensusResult {
  const { cellDb } = dats;
  const t0 = performance.now();
  const { streamer: s, collision, pools: { statics, buildings, scenery } } = makeCensusStreamer(dats, radius);
  s.loadAround(cx, cy);
  s.pump(cx, cy); // the prefetch ring (budget unlimited here)
  const ms = performance.now() - t0;
  const c = s.census();
  let interiorCellsInBlocks = 0;
  const p = s.prefetchRadius;
  for (let dx = -p; dx <= p; dx++) {
    for (let dy = -p; dy <= p; dy++) {
      const data = cellDb.getFileData(((((cx + dx) & 0xff) << 24) | (((cy + dy) & 0xff) << 16) | 0xfffe) >>> 0);
      if (data) interiorCellsInBlocks += new LandblockInfo(new DatReader(data)).numCells;
    }
  }
  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    spot: `0x${((cx << 8) | cy).toString(16).padStart(4, '0')}`,
    radius,
    objectBlocksBuilt: c.blocks,
    objectBlocksShown: c.shownBlocks,
    interiorCellsInBlocks,
    cellMeshesBuilt: c.cellMeshesBuilt,
    cellCollisionRegistered: collision.cellCount,
    staticInstancesDrawn: sum(statics.m),
    buildingInstancesDrawn: sum(buildings.m),
    sceneryInstancesDrawn: sum(scenery.m),
    ms: Math.round(ms),
  };
}

const isMain = process.argv[1]?.endsWith('landblock-content-census.ts');
if (isMain) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--radius');
  const radius = ri >= 0 ? Number(args[ri + 1]) : 8;
  const spots = args.filter((a, i) => a.startsWith('0x') && args[i - 1] !== '--radius');
  const dats = openDats();
  for (const spot of spots.length ? spots : ['0xa9b4', '0x0366']) {
    const v = parseInt(spot, 16);
    console.log(JSON.stringify(landblockContentCensus(dats, (v >> 8) & 0xff, v & 0xff, radius)));
  }
}
