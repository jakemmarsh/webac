/**
 * BUG.scenery-pop-in-order — "small trees/plants pop in right next to me
 * while big ones far away are already drawn" (Jake, around Holtburg).
 *
 * Retail never had an order to show: LScape::update_block @ 005063a0 loads
 * every block of its grid synchronously from the local DAT (DBObj::Get /
 * LScape::get_all) and a full-detail block builds its statics, buildings and
 * scenery at once (CLandBlock::init_static_objs @ 00530a40 → get_land_scenes
 * @ 00530460). Objects then appear only at their DIDDegrade distances
 * (GfxObjDegradeInfo::get_degrade @ 0051e4b0) — unchanged here.
 *
 * Ours streams each block's files. Root causes pinned below:
 *  1. The object loader scored blocks by block-centre distance from the
 *     player's BLOCK, so the prefetch ring tied in fours and went lowest key
 *     first: walking east out of Holtburg the block BEHIND (0xA7B4) was
 *     fetched first, the ones ahead 4th and 11th–16th.
 *  2. Every block was fetched at prefetch priority, all at once: a block the
 *     object ring had already reached waited behind the rest of the ring
 *     (and behind blocks issued for a direction the player left, or for the
 *     place they teleported from).
 *  3. A degrade level whose GfxObj missed (streamed DATs) when first needed
 *     was cached as "no meshes" for the family's / part's lifetime: those
 *     instances drew nothing until the player was close enough for another
 *     level — a pop-in right next to them.
 * Fix: nearest-and-ahead scoring from the player's position and facing
 * (re-scored every pump), critical priority for blocks inside the object
 * ring (promoted when the ring reaches a waiting block), at most
 * MAX_PREFETCH_BLOCK_FETCHES prefetch fetches in flight (re-scored as each
 * lands; blocks left behind hold no slot), and missed degrade levels retried
 * when their files land.
 *
 * The real-DAT walks (tools/probe-scenery-popin-order.ts) drive the shipped
 * streamer + scenery builder + degrade selection over all three eras' DATs.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { LandblockLoadScheduler, blockLoadScore, type LoadViewer } from '../packages/renderer/src/world/LandblockLoadScheduler.js';
import { LandblockObjectStreamer, MAX_PREFETCH_BLOCK_FETCHES, type LandblockObjectStreamerDeps } from '../packages/renderer/src/world/LandblockObjectStreamer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import { DegradeLod, INVALID_DID, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import { noteDatMiss, noteDatMissResolved, DAT_ARRIVAL_COALESCE_MS } from '@ac/dat-parser/streaming/DatMiss.js';
import type { GfxObjLOD } from '@ac/dat-parser';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';
import { DatClosure, type ClosureStore } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { FetchPriority } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { runPopinWalk, walkPath, type WalkDats } from '../tools/probe-scenery-popin-order.js';

const hex = (k: number) => k.toString(16);
const B = 192;
/** Holtburg's block centre, facing east. */
const HOLTBURG_EAST: LoadViewer = { x: 0xa9 * B + 96, z: 0xb4 * B + 96, dirX: 1, dirZ: 0 };

describe('BUG.scenery-pop-in-order — load order: nearest and ahead first, re-scored as the player moves', () => {
  const ringOrder = (viewer: LoadViewer | null) => {
    const s = new LandblockLoadScheduler(() => [][Symbol.iterator](), { syncRadius: -1 });
    s.request(0xa9, 0xb4, 2);
    s.cancelOutside(0xa9, 0xb4, 2);
    // only the prefetch ring (Chebyshev 2): the 3×3 loads synchronously
    return s.queueOrder(0xa9, 0xb4, viewer).filter(([bx, by]) => Math.max(Math.abs(bx - 0xa9), Math.abs(by - 0xb4)) === 2).map(([bx, by]) => hex((bx << 8) | by));
  };

  it('before: block-centre distance ties broke lowest key first — the block behind went first', () => {
    const order = ringOrder(null);
    expect(order.slice(0, 4)).toEqual(['a7b4', 'a9b2', 'a9b6', 'abb4']);
  });

  it('after: facing east, the three blocks ahead lead and the three behind come last', () => {
    const order = ringOrder(HOLTBURG_EAST);
    expect(order.slice(0, 5)).toEqual(['abb4', 'abb3', 'abb5', 'aab2', 'aab6']);
    // the column behind comes after everything level with the player
    const behind = Math.min(...['a7b2', 'a7b3', 'a7b4', 'a7b5', 'a7b6'].map(k => order.indexOf(k)));
    for (const k of ['a9b2', 'a9b6', 'a8b2', 'a8b6']) expect(order.indexOf(k)).toBeLessThan(behind);
  });

  it('turning around reverses it (re-scored from the current facing, not the queue order)', () => {
    const order = ringOrder({ ...HOLTBURG_EAST, dirX: -1 });
    expect(order.slice(0, 3)).toEqual(['a7b4', 'a7b3', 'a7b5']);
  });

  it('a block the player stands next to beats one a block away whatever the heading', () => {
    // at the east edge of 0xA9B4 facing west: 0xAAB4 (touching, behind) vs 0xA8B4 (192 m ahead)
    const v: LoadViewer = { x: 0xaa * B - 1, z: 0xb4 * B + 96, dirX: -1, dirZ: 0 };
    expect(blockLoadScore(0xaa, 0xb4, v)).toBeLessThan(blockLoadScore(0xa8, 0xb4, v));
  });

  it('pump re-scores between steps: the block in progress finishes, then the next pick follows the new facing', () => {
    const started: string[] = [];
    let t = 0;
    const s2 = new LandblockLoadScheduler((bx, by) => { started.push(hex((bx << 8) | by)); return [][Symbol.iterator]() as Iterator<void>; }, { syncRadius: 0, budgetMs: 1, now: () => (t += 0.6) });
    s2.request(0xa9, 0xb4, 2);
    s2.pump(0xa9, 0xb4, HOLTBURG_EAST);
    const firstEast = started.filter(k => k !== 'a9b4'); // the player's own block loads synchronously
    started.length = 0;
    s2.pump(0xa9, 0xb4, { ...HOLTBURG_EAST, dirX: -1 });
    expect(firstEast[0]).toBe('aab4'); // nearest: the touching block ahead
    expect(started[0]).toBe('a8b4');    // after the turn: the touching block on the new side
  });
});

/** A minimal streamer over a fake block network (no DATs: blocks with no LandblockInfo / scenery). */
function fakeNetStreamer() {
  const ready = new Set<number>();
  const calls: Array<{ key: number; urgent: boolean }> = [];
  const lands = new Map<number, () => void>();
  const pool = () => ({ addBlock: () => {}, removeBlock: () => {}, setVisible: () => {} });
  const deps: LandblockObjectStreamerDeps = {
    cellDb: { getFileData: () => null },
    addToScene: () => {}, removeFromScene: () => {}, setTerrainVisible: () => {},
    instancer: { hasModel: () => false, getWorldBBox: () => null },
    sceneryPool: pool(), staticsPool: pool(), buildingsPool: pool(),
    envCells: { createCellMesh: () => null, getCellCollisionData: () => null, loadEnvCell: () => null },
    setupModels: { createSetupMesh: () => null, loadSetupModel: () => null },
    models: { createMesh: () => null, loadGfxObj: () => null },
    degradeLod: { attachPart: () => false } as unknown as LandblockObjectStreamerDeps['degradeLod'],
    collision: new DungeonCollision(),
    objectPhysics: () => null,
    warn: { warn: () => {} },
    onCollisionMeshesChanged: () => {},
    loadRadius: 8,
    budgetMs: 1e9,
    blockData: {
      isReady: (bx, by) => ready.has((bx << 8) | by),
      request: (bx, by, urgent) => {
        const key = (bx << 8) | by;
        calls.push({ key, urgent: !!urgent });
        if (lands.has(key)) return new Promise(() => {});
        return new Promise<void>((r) => { lands.set(key, () => { ready.add(key); lands.delete(key); r(); }); });
      },
    },
  };
  const streamer = new LandblockObjectStreamer(deps);
  const land = async (key: number) => { lands.get(key)?.(); for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { streamer, calls, ready, land, lands };
}

describe('BUG.scenery-pop-in-order — streamed blocks: the object ring is critical, the prefetch ring is metered', () => {
  it('blocks inside the object ring are fetched urgent; prefetch blocks at most MAX_PREFETCH_BLOCK_FETCHES at once', () => {
    const h = fakeNetStreamer();
    h.streamer.streamAround(0xa9, 0xb4);
    h.streamer.pump(0xa9, 0xb4, HOLTBURG_EAST);
    const urgent = h.calls.filter(c => c.urgent).map(c => c.key);
    const prefetch = h.calls.filter(c => !c.urgent).map(c => c.key);
    expect(urgent).toHaveLength(9);
    for (const k of urgent) expect(Math.max(Math.abs((k >> 8) - 0xa9), Math.abs((k & 0xff) - 0xb4))).toBeLessThanOrEqual(1);
    expect(prefetch.map(hex)).toEqual(['abb4', 'abb3', 'abb5', 'aab2'].slice(0, MAX_PREFETCH_BLOCK_FETCHES));
  });

  it('nothing stops appearing: as fetches land, the deferred prefetch blocks follow until the whole 5×5 is built', async () => {
    const h = fakeNetStreamer();
    h.streamer.streamAround(0xa9, 0xb4);
    h.streamer.pump(0xa9, 0xb4, HOLTBURG_EAST);
    let maxPrefetch = 0;
    const urgentKeys = () => new Set(h.calls.filter(c => c.urgent).map(c => c.key));
    for (let round = 0; round < 40 && h.lands.size > 0; round++) {
      const u = urgentKeys();
      maxPrefetch = Math.max(maxPrefetch, [...h.lands.keys()].filter(k => !u.has(k)).length);
      for (const k of [...h.lands.keys()]) await h.land(k);
      h.streamer.pump(0xa9, 0xb4, HOLTBURG_EAST);
    }
    const missing: string[] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (!h.streamer.isBlockLoaded(0xa9 + dx, 0xb4 + dy)) missing.push(hex(((0xa9 + dx) << 8) | (0xb4 + dy)));
    expect(missing).toEqual([]);
    // never more than MAX_PREFETCH_BLOCK_FETCHES prefetch fetches were waiting at once
    expect(maxPrefetch).toBe(MAX_PREFETCH_BLOCK_FETCHES);
  });

  it('a waiting prefetch block is promoted to urgent the moment the ring reaches it', () => {
    const h = fakeNetStreamer();
    h.streamer.streamAround(0xa9, 0xb4);
    h.streamer.pump(0xa9, 0xb4, HOLTBURG_EAST);
    expect(h.calls.filter(c => c.key === 0xabb4).map(c => c.urgent)).toEqual([false]);
    h.streamer.pump(0xaa, 0xb4, { ...HOLTBURG_EAST, x: 0xaa * B + 5 }); // crossed east: 0xABB4 is in the 3×3 now
    expect(h.calls.filter(c => c.key === 0xabb4).map(c => c.urgent)).toEqual([false, true]);
  });

  it('fast travel: blocks still in flight at the old place hold no prefetch slot at the arrival', () => {
    const h = fakeNetStreamer();
    h.streamer.streamAround(0xa9, 0xb4);
    h.streamer.pump(0xa9, 0xb4, HOLTBURG_EAST); // 4 prefetch fetches in flight around Holtburg, none land
    h.calls.length = 0;
    const arrival = { x: 0xda * B + 96, z: 0x55 * B + 96, dirX: 0, dirZ: 1 };
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) h.ready.add(((0xda + dx) << 8) | (0x55 + dy)); // the portal-space gate
    h.streamer.loadAround(0xda, 0x55);
    h.streamer.pump(0xda, 0x55, arrival);
    const fresh = h.calls.filter(c => !c.urgent && Math.abs((c.key >> 8) - 0xda) <= 2);
    expect(fresh).toHaveLength(MAX_PREFETCH_BLOCK_FETCHES);
    expect(hex(fresh[0].key)).toBe('da57'); // straight ahead (north)
  });
});

describe('BUG.scenery-pop-in-order — DatClosure.ensureLandblock promotes an in-flight block load', () => {
  it('a second, more urgent request re-asks the bundle and area pack at that priority; a less urgent one does not', async () => {
    const asked: Array<[string, number, FetchPriority]> = [];
    let landBundle!: () => void;
    const store = {
      onEvict: () => () => {},
      isResident: () => false,
      ensure: async () => {},
      peek: () => null,
      exists: () => false,
      bundleIds: () => [],
      isBundleResident: () => false,
      ensureBundle: (lb: number, pr: FetchPriority) => { asked.push(['bundle', lb, pr]); return new Promise<void>((r) => { landBundle ??= r; }); },
      ensureArea: async (lb: number, pr: FetchPriority) => { asked.push(['area', lb, pr]); },
    } as unknown as ClosureStore;
    const closure = new DatClosure(store);
    const first = closure.ensureLandblock(0xabb4, FetchPriority.Prefetch);
    closure.ensureLandblock(0xabb4, FetchPriority.Background); // less urgent: nothing new
    expect(asked).toEqual([['bundle', 0xabb4, FetchPriority.Prefetch], ['area', 0xabb4, FetchPriority.Prefetch]]);
    const again = closure.ensureLandblock(0xabb4, FetchPriority.Critical);
    expect(again).toBe(first); // one load, re-prioritised
    expect(asked.slice(2)).toEqual([['bundle', 0xabb4, FetchPriority.Critical], ['area', 0xabb4, FetchPriority.Critical]]);
    closure.ensureLandblock(0xabb4, FetchPriority.Critical); // already critical: asked once
    expect(asked).toHaveLength(4);
    landBundle();
    await first;
    expect(closure.isLandblockReady(0xabb4)).toBe(true);
  });
});

// ── 3. degrade levels that missed are retried ─────────────────────────────

const lodEntry = (gfxObjId: number, min: number, ideal: number, max: number): GfxObjLOD => ({ gfxObjId, degradeMode: 1, minDist: min, idealDist: ideal, maxDist: max });
const PLANT = 0x01000aaa, PLANT_L1 = 0x01000aab;
const PLANT_CHAIN: DegradeChain = {
  infoId: 0x11000aaa,
  degrades: [lodEntry(PLANT, 0, 10, 20), lodEntry(PLANT_L1, 10, 20, 40), lodEntry(INVALID_DID, 3.4e38, 3.4e38, 3.4e38)],
  levelIds: [PLANT, PLANT_L1, INVALID_DID],
  sortCenter: new THREE.Vector3(),
};
const box = () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial())); return g; };
const arrive = async () => { noteDatMissResolved(); await new Promise((r) => setTimeout(r, DAT_ARRIVAL_COALESCE_MS + 20)); };

describe('BUG.scenery-pop-in-order — a degrade level whose GfxObj missed draws once its files land', () => {
  it('pooled scenery: the level-1 instances draw after the miss resolves (were hidden for the family\'s life)', async () => {
    let l1Resident = false;
    const createMesh = vi.fn((id: number) => {
      if (id === PLANT_L1 && !l1Resident) { noteDatMiss(); return null; }
      return box();
    });
    const lod = new DegradeLod(null);
    lod.setPrefs({ degradeDistance: 0, adaptiveDegrade: false, adaptiveDegradeBias: 0 });
    lod.setChain(PLANT, PLANT_CHAIN);
    const inst = new SceneryInstancer({ createMesh }, { loadSetupModel: () => null });
    const meshes = new Set<THREE.InstancedMesh>();
    const pool = new SceneryInstancePool(inst, 'scn', (m) => meshes.add(m as THREE.InstancedMesh), (m) => meshes.delete(m as THREE.InstancedMesh), { lod, landCells: false });
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    const at = (x: number): InstanceEntry => ({ objId: PLANT, matrix: new THREE.Matrix4().makeTranslation(x, 0, 0) });
    pool.addBlock(1, [at(5), at(15)]); // 5 m → level 0, 15 m → level 1
    const drawn = () => [...meshes].filter(m => m.visible).reduce((n, m) => n + m.count, 0);
    expect(drawn()).toBe(1); // the level-1 plant is missing while its GfxObj is not resident
    l1Resident = true;
    await arrive();
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(drawn()).toBe(2);
  });

  it('whole DATs (no miss): a level with no meshes stays cached as none (no retry churn)', () => {
    const createMesh = vi.fn((id: number) => (id === PLANT_L1 ? null : box()));
    const lod = new DegradeLod(null);
    lod.setPrefs({ degradeDistance: 0, adaptiveDegrade: false, adaptiveDegradeBias: 0 });
    lod.setChain(PLANT, PLANT_CHAIN);
    const inst = new SceneryInstancer({ createMesh }, { loadSetupModel: () => null });
    const pool = new SceneryInstancePool(inst, 'scn', () => {}, () => {}, { lod, landCells: false });
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    pool.addBlock(1, [{ objId: PLANT, matrix: new THREE.Matrix4().makeTranslation(15, 0, 0) }]);
    const calls = createMesh.mock.calls.filter(([id]) => id === PLANT_L1).length;
    pool.updateLod(new THREE.Vector3(0, 0, 0.1));
    pool.updateLod(new THREE.Vector3(0, 0, 0.2));
    expect(createMesh.mock.calls.filter(([id]) => id === PLANT_L1).length).toBe(calls);
  });

  it('per-object parts (DegradeLod.holderFor): a missed level is built when its files land', async () => {
    let l1Resident = false;
    const lod = new DegradeLod(null);
    lod.setPrefs({ degradeDistance: 0, adaptiveDegrade: false, adaptiveDegradeBias: 0 });
    lod.setChain(PLANT, PLANT_CHAIN);
    const scene = new THREE.Scene();
    const obj = new THREE.Group();
    const part = new THREE.Group();
    part.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    obj.add(part);
    obj.position.set(15, 0, 0);
    scene.add(obj);
    scene.updateMatrixWorld(true);
    lod.attachPart(part, PLANT, (id) => { if (id === PLANT_L1 && !l1Resident) { noteDatMiss(); return null; } return box(); }, obj);
    const viewer = new THREE.Vector3(0, 0, 0);
    lod.updateParts(viewer, scene);
    const visibleLod1 = () => part.children.some(c => c.name === 'lod_1' && c.visible);
    expect(visibleLod1()).toBe(false);
    l1Resident = true;
    await arrive();
    lod.updateParts(viewer, scene);
    expect(visibleLod1()).toBe(true);
  });
});

// ── real-DAT walks, all three eras ────────────────────────────────────────

const ERAS: Array<{ era: string; portal: string; cell: string; ac1999?: boolean }> = [
  { era: 'end of retail', portal: DAT_PATHS.portal, cell: DAT_PATHS.cell },
  { era: 'Dark Majesty (classic-dereth-1.1)', portal: resolve(DAT_SETS_DIR, 'classic-dereth-1.1', 'client_portal.dat'), cell: resolve(DAT_SETS_DIR, 'classic-dereth-1.1', 'client_cell_1.dat') },
  { era: 'AC1999', portal: resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat'), cell: resolve(DAT_SETS_DIR, 'ac1999-retail', 'cell.dat'), ac1999: true },
];

for (const e of ERAS) {
  describe.skipIf(!existsSync(e.portal) || !existsSync(e.cell))(`BUG.scenery-pop-in-order — running east out of Holtburg over the real DATs (${e.era})`, () => {
    let dats: WalkDats;
    beforeAll(async () => {
      dats = { portalDb: openDat(e.portal), cellDb: openDat(e.cell) };
      if (e.ac1999) {
        const { ac1999PortalOverlay, ac1999CellOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
        if (!dats.portalDb.overlayKind) dats.portalDb.setOverlay(ac1999PortalOverlay());
        if (!dats.cellDb.overlayKind) dats.cellDb.setOverlay(ac1999CellOverlay());
      }
    });

    it('whole DATs: every object draws exactly when retail draws it (the order change adds nothing, holds nothing back)', async () => {
      const r = await runPopinWalk(dats, { ...walkPath('east'), net: null });
      expect(r.objectsSeen).toBeGreaterThan(2000);
      expect(r.late).toHaveLength(0);
      expect(r.neverDrawn).toBe(0);
    }, 120_000);

    it('streamed (4 s per block, 2 at a time, 10 m/s): before, hundreds of objects popped in late; after, none', async () => {
      const net = { latencyS: 4, concurrency: 2 };
      const before = await runPopinWalk(dats, { ...walkPath('east'), net, legacy: true });
      const after = await runPopinWalk(dats, { ...walkPath('east'), net });
      expect(before.late.length).toBeGreaterThan(150);
      expect(after.late).toHaveLength(0);
      expect(after.neverDrawn).toBe(0);
      // the first prefetch fetch: the block behind before, the block ahead after
      expect(hex(before.fetchOrder[0])).toBe('a7b4');
      expect(hex(after.fetchOrder[0])).toBe('abb4');
    }, 120_000);

    it('fast travel: the arrival area is not starved by the fetches left behind (Holtburg → 0xDA55 halfway)', async () => {
      const net = { latencyS: 4, concurrency: 2 };
      const before = await runPopinWalk(dats, { ...walkPath('teleport'), net, legacy: true });
      const after = await runPopinWalk(dats, { ...walkPath('teleport'), net });
      expect(after.late.length).toBeLessThan(before.late.length);
      expect(after.lateNear).toBe(0);
      expect(after.neverDrawn).toBe(0);
    }, 120_000);
  });
}
