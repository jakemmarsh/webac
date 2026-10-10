/**
 * DEBT.main-ts-extractions — world/LandblockObjectStreamer (landblock
 * statics / interior cells / building exteriors / scenery, their collision
 * keys, the sealed-interior landscape toggle and the budgeted load
 * scheduler), lifted out of main.ts's main() closure. Driven with real
 * LandblockInfo bytes (0xXXYYFFFE layout per ACE LandblockInfo.Unpack / our
 * parser), a real DungeonCollision as the outdoor collision world, and stub
 * renderers.
 *
 * Pins: a block's objects + collision keys register on load and ALL retire
 * on unload (REND.scenery-collision-never-removed for the scenery keys too);
 * the unload radius keeps its hysteresis past the object ring; blocks
 * streamed in while inside a sealed interior arrive hidden and come back
 * with the landscape without force-showing invisible-by-design meshes; the
 * scheduler loads the player's block synchronously and the rest over pumps.
 *
 * PERF.5 — retail per-ring content (LScape::get_block_orient @ 00504f90,
 * CLandBlock::notify_change_size @ 005302c0): objects draw only on the 3×3
 * full-detail blocks around the player whatever the landscape radius; one
 * ring further is prefetched hidden; crossing a block edge re-centres the ring.
 *
 * PERF.3 — interior cells are lazy: render meshes for the building-portal
 * stab cells only (the PVS cells build on demand and retire with the
 * player's block), collision for the cells walkable from those doorways.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { LandblockObjectStreamer, type LandblockObjectStreamerDeps, type BlockInstancePool } from '../packages/renderer/src/world/LandblockObjectStreamer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import type { ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import type { CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { STATIC_SCRIPT_KEY } from '../packages/renderer/src/world/StaticScriptDriver.js';
import { STATIC_ANIM_KEY } from '../packages/renderer/src/world/StaticAnimationDriver.js';
import { objectUnloadRadius, landblockDetailReduction, RETAIL_FULL_DETAIL_RADIUS, objectRingRadius } from '../packages/renderer/src/world/LandscapeDrawDistance.js';
import { collectWalkableCells } from '../packages/renderer/src/world/buildingCells.js';

const POOLED_STATIC = 0x01000001;   // the instancer resolves it → staticsPool
const FALLBACK_STATIC = 0x02000002; // the instancer cannot → per-object mesh
const BUILDING = 0x01000010;        // pooled building exterior

interface PortalSpec { flags?: number; otherCellId: number; stabs?: number[] }

/** LandblockInfo bytes: id, numCells, two stabs, one building (with `portals`), no restriction table. */
function landblockInfoBytes(infoId: number, numCells: number, portals: PortalSpec[] = [], stabIds: readonly number[] = [POOLED_STATIC, FALLBACK_STATIC]): ArrayBuffer {
  const out: Array<['u32' | 'u16' | 'f32', number]> = [];
  out.push(['u32', infoId], ['u32', numCells]);
  const stabs = stabIds.map((id, i) => ({ id, x: 20 + 40 * i, y: 30 + 40 * i, z: 5 }));
  out.push(['u32', stabs.length]);
  // The second stab is yawed 90° about AC z (w = z = √½).
  for (const [i, s] of stabs.entries()) {
    const q = i === 1 ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [1, 0, 0, 0];
    out.push(['u32', s.id], ['f32', s.x], ['f32', s.y], ['f32', s.z], ['f32', q[0]], ['f32', q[1]], ['f32', q[2]], ['f32', q[3]]);
  }
  out.push(['u16', 1], ['u16', 0]); // one building, packMask 0
  out.push(['u32', BUILDING], ['f32', 100], ['f32', 100], ['f32', 0], ['f32', 1], ['f32', 0], ['f32', 0], ['f32', 0]);
  out.push(['u32', 0], ['u32', portals.length]); // numLeaves, portal count
  for (const p of portals) {
    const list = p.stabs ?? [];
    out.push(['u16', p.flags ?? 0], ['u16', p.otherCellId], ['u16', 0], ['u16', list.length]);
    for (const c of list) out.push(['u16', c]);
    if (list.length % 2 === 1) out.push(['u16', 0]); // CBldPortal align(4)
  }
  const size = out.reduce((n, [t]) => n + (t === 'u16' ? 2 : 4), 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  for (const [t, v] of out) {
    if (t === 'u32') { dv.setUint32(o, v >>> 0, true); o += 4; }
    else if (t === 'u16') { dv.setUint16(o, v, true); o += 2; }
    else { dv.setFloat32(o, v, true); o += 4; }
  }
  return buf;
}

/** A CylSphere-only physics model (posts, lamps): one cylinder obstacle per object. */
const POST_MODEL: ObjectPhysicsModel = {
  parts: [], hasPhysicsBSP: false,
  cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: 0.5, height: 2 }],
  spheres: [], sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 0.5 },
};

class RecordingPool implements BlockInstancePool {
  readonly blocks = new Map<number, number>();
  readonly entries = new Map<number, unknown[]>();
  visible = true;
  addBlock(blockKey: number, entries: unknown[]): void { this.blocks.set(blockKey, entries.length); this.entries.set(blockKey, entries); }
  removeBlock(blockKey: number): void { this.blocks.delete(blockKey); }
  setVisible(v: boolean): void { this.visible = v; }
}

interface HarnessOpts {
  loadRadius?: number;
  numCells?: number;
  portals?: PortalSpec[];
  /** cell index → its CellPortals' otherCellIds (0xFFFF = outside). */
  cellPortals?: Record<number, number[]>;
  scenery?: boolean;
  /** The two LandblockInfo stabs' ids (default POOLED_STATIC, FALLBACK_STATIC). */
  stabIds?: readonly number[];
  /** Pooled (instancer-resolvable) ids beyond POOLED_STATIC / BUILDING. */
  pooledIds?: readonly number[];
  /** Setup id → its DefaultScript. */
  defaultScripts?: Record<number, number>;
  /** Setup id → its DefaultAnimation (SWEEP1006B). */
  defaultAnims?: Record<number, number>;
  /** Scenery entries' object ids (default two pooled 0x01000077 GfxObjs). */
  sceneryIds?: readonly number[];
  /** Extra deps (RELEASE.dat-streaming: blockData / trackMisses). */
  extra?: Partial<LandblockObjectStreamerDeps>;
}

function makeStreamer(opts: HarnessOpts = {}) {
  const scene = new Set<THREE.Object3D>();
  const collision = new DungeonCollision();
  // Cell BSPs: record the registrations instead of building real BSPs.
  const cellKeys = new Set<number>();
  vi.spyOn(collision, 'addCell').mockImplementation((id: number) => { cellKeys.add(id); });
  const realRemove = collision.removeKey.bind(collision);
  vi.spyOn(collision, 'removeKey').mockImplementation((key) => { if (typeof key === 'number') cellKeys.delete(key); realRemove(key); });
  const pools = { scenery: new RecordingPool(), statics: new RecordingPool(), buildings: new RecordingPool() };
  let terrainVisible = true;
  let dirty = 0;
  const cellMeshCalls: number[] = [];
  const sceneryCalls: number[] = [];
  const numCells = opts.numCells ?? 1;
  const attached: THREE.Object3D[] = [];
  const detached: THREE.Object3D[] = [];
  const deps: LandblockObjectStreamerDeps = {
    cellDb: { getFileData: (id) => ((id & 0xffff) === 0xfffe ? landblockInfoBytes(id, numCells, opts.portals, opts.stabIds) : null) },
    addToScene: (o) => { scene.add(o); },
    removeFromScene: (o) => { scene.delete(o); },
    setTerrainVisible: (v) => { terrainVisible = v; },
    instancer: {
      hasModel: (id) => id === POOLED_STATIC || id === BUILDING || (opts.pooledIds ?? []).includes(id),
      getWorldBBox: (_id, m) => new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 8, 5)).applyMatrix4(m),
    },
    sceneryPool: pools.scenery, staticsPool: pools.statics, buildingsPool: pools.buildings,
    envCells: {
      createCellMesh: (cellId) => { cellMeshCalls.push(cellId); const g = new THREE.Group(); g.name = `envcell_${cellId.toString(16)}`; return g; },
      getCellCollisionData: () => ({ cellStruct: {} as CellStruct, position: {} as Frame }),
      loadEnvCell: (cellId) => ({
        staticObjects: [],
        cellPortals: (opts.cellPortals?.[cellId & 0xffff] ?? []).map((otherCellId) => ({ flags: 0, polygonId: 0, otherCellId, otherPortalId: 0 })),
      }),
    },
    setupModels: {
      createSetupMesh: () => new THREE.Group(),
      loadSetupModel: (id) => (opts.defaultScripts?.[id] || opts.defaultAnims?.[id]
        ? ({ defaultScript: opts.defaultScripts?.[id] ?? 0, defaultAnimation: opts.defaultAnims?.[id] ?? 0 } as unknown as SetupModel) : null),
    },
    staticScripts: { attach: (o) => { attached.push(o); }, detach: (o) => { detached.push(o); } },
    // A pivot-centred model (vertices from −1 to +1 in height): it must still
    // be placed at its exact frame (VISUAL.holtburg-roof-plank).
    models: {
      createMesh: () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1))); return g; },
      loadGfxObj: () => null,
    },
    degradeLod: { attachPart: () => {} } as unknown as LandblockObjectStreamerDeps['degradeLod'],
    collision,
    objectPhysics: () => POST_MODEL,
    ...(opts.scenery ? {
      buildScenery: (bx: number, by: number) => {
        sceneryCalls.push((bx << 8) | by);
        const key = `sc:${bx}:${by}`;
        collision.addCylinderObstacle(key, bx * 192 + 10, by * 192 + 10, 1);
        const ids = opts.sceneryIds ?? [0x01000077, 0x01000077];
        const entries = ids.map((objId, i) => ({
          objId,
          matrix: new THREE.Matrix4().compose(new THREE.Vector3(bx * 192 + 10 + i, 3, by * 192 + 10), new THREE.Quaternion(), new THREE.Vector3(1.25, 1.25, 1.25)),
        }));
        return { entries, collisionKeys: [key] };
      },
    } : {}),
    warn: { warn: (d) => { throw new Error(`unexpected streaming warning: ${d}`); } },
    onCollisionMeshesChanged: () => { dirty++; },
    loadRadius: opts.loadRadius ?? 1,
    budgetMs: 1e9,
    ...opts.extra,
  };
  const streamer = new LandblockObjectStreamer(deps);
  return {
    streamer, scene, collision, pools, cellKeys, cellMeshCalls, sceneryCalls, attached, detached,
    get terrainVisible() { return terrainVisible; }, get dirty() { return dirty; },
  };
}

const cellsOf = (h: ReturnType<typeof makeStreamer>, blockKey: number) => h.streamer.surfaceCellRegistry.get(blockKey)?.meshes;

describe('LandblockObjectStreamer — load registers, unload retires', () => {
  it("loads a block's statics (pooled + per-object), building shell and collision keys", () => {
    const h = makeStreamer();
    h.streamer.loadNow(0x20, 0x30);
    const blockKey = (0x20 << 8) | 0x30;
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(true);
    expect(h.streamer.isBlockShown(0x20, 0x30)).toBe(true); // no ring centre yet → shown
    expect(h.pools.statics.blocks.get(blockKey)).toBe(1);   // the pooled static
    expect(h.pools.buildings.blocks.get(blockKey)).toBe(1); // the pooled exterior
    // Only the per-object static: the block's one interior cell is not
    // referenced by any building portal (PERF.3 — no mesh, no collision), and
    // no invisible physcoll_ raycast proxy is built any more.
    expect(h.scene.size).toBe(1);
    // 2 statics + 1 building, each one CylSphere → one cylinder obstacle.
    expect(h.collision.cylinderCount).toBe(3);
    expect(h.streamer.blockCollisionKeys(blockKey)).toHaveLength(3);
    expect(h.streamer.buildingShells).toHaveLength(1);
    expect(h.streamer.buildingShells[0].blockKey).toBe(blockKey);
    expect(h.streamer.surfaceCellRegistry.has(blockKey)).toBe(true);
    expect(h.streamer.totalModelsPlaced).toBe(3);
    // Loading again is a no-op (the LandblockInfo id is tracked).
    h.streamer.loadNow(0x20, 0x30);
    expect(h.collision.cylinderCount).toBe(3);
  });

  it('moving beyond the unload radius retires every object, pool range, shell, cell and collision key; the block can reload', () => {
    const h = makeStreamer({ loadRadius: 8, numCells: 2, portals: [{ otherCellId: 0x100 }], scenery: true });
    h.streamer.loadNow(0x20, 0x30);
    const blockKey = (0x20 << 8) | 0x30;
    expect(h.cellKeys.has(0x20300100)).toBe(true);
    expect(h.collision.cylinderCount).toBe(4); // 3 objects + 1 scenery obstacle
    const gen0 = h.streamer.surfaceCellGeneration;
    // The unload radius is the object ring + the 2-block hysteresis, whatever the landscape radius.
    const keep = objectUnloadRadius(RETAIL_FULL_DETAIL_RADIUS);
    expect(h.streamer.unloadRadius).toBe(keep);
    h.streamer.unloadDistant(0x20 + keep, 0x30);
    expect(h.collision.cylinderCount).toBe(4);
    // One block further: everything goes (REND.scenery-collision-never-removed: scenery keys too).
    h.streamer.unloadDistant(0x20 + keep + 1, 0x30);
    expect(h.collision.cylinderCount).toBe(0);
    expect(h.cellKeys.size).toBe(0);
    expect(h.scene.size).toBe(0);
    expect(h.pools.statics.blocks.has(blockKey)).toBe(false);
    expect(h.pools.buildings.blocks.has(blockKey)).toBe(false);
    expect(h.pools.scenery.blocks.has(blockKey)).toBe(false);
    expect(h.streamer.buildingShells).toHaveLength(0);
    expect(h.streamer.surfaceCellRegistry.has(blockKey)).toBe(false);
    expect(h.streamer.surfaceCellGeneration).toBe(gen0 + 1);
    expect(h.streamer.loadedBuildingMeshes.has(blockKey)).toBe(false);
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(false);
    h.streamer.loadNow(0x20, 0x30);
    expect(h.collision.cylinderCount).toBe(4);
  });

  it('setLoadRadius moves the landscape radius; the object ring stays the retail 3×3 (PERF.5)', () => {
    const h = makeStreamer({ loadRadius: 8 });
    expect(h.streamer.objectRadius).toBe(1);
    h.streamer.setLoadRadius(3);
    expect(h.streamer.loadRadius).toBe(3);
    expect(h.streamer.objectRadius).toBe(1);
    expect(h.streamer.unloadRadius).toBe(objectUnloadRadius(1));
  });
});

describe('LandblockObjectStreamer — sealed-interior landscape toggle', () => {
  it('hides loaded + newly streamed objects and the pools; restoring shows only what it hid', () => {
    const h = makeStreamer({ numCells: 1, portals: [{ otherCellId: 0x100 }], cellPortals: {} });
    h.streamer.loadNow(0x20, 0x30);
    // An invisible-by-design mesh (the surface rule hid the stab cell).
    const cell = cellsOf(h, (0x20 << 8) | 0x30)!.get(0x100)!;
    cell.visible = false;
    h.streamer.setLandscapeVisible(false);
    expect(h.terrainVisible).toBe(false);
    expect(h.pools.statics.visible).toBe(false);
    expect([...h.scene].every((o) => !o.visible)).toBe(true);
    h.streamer.loadNow(0x21, 0x30); // streamed in while inside
    expect([...h.scene].every((o) => !o.visible)).toBe(true);
    h.streamer.setLandscapeVisible(true);
    expect(h.terrainVisible).toBe(true);
    expect(h.pools.statics.visible).toBe(true);
    expect(cell.visible).toBe(false); // never force-shown
    // Each block: the per-object static comes back; block 0x2130's stab cell
    // (visible when built) comes back too.
    expect([...h.scene].filter((o) => o.visible)).toHaveLength(3);
  });
});

describe('LandblockObjectStreamer — REND.landblock-streaming-one-frame scheduler wiring', () => {
  it("streamAround queues the prefetch window; a pump loads the player's block synchronously and the budget fills the rest", () => {
    const h = makeStreamer({ loadRadius: 8 });
    h.streamer.streamAround(0x40, 0x40);
    expect(h.streamer.isBlockLoaded(0x40, 0x40)).toBe(false); // queued, not built
    h.streamer.pump(0x40, 0x40);
    const p = h.streamer.prefetchRadius;
    expect(p).toBe(2);
    for (let dx = -p; dx <= p; dx++) {
      for (let dy = -p; dy <= p; dy++) expect(h.streamer.isBlockLoaded(0x40 + dx, 0x40 + dy), `${dx},${dy}`).toBe(true);
    }
    // PERF.5 — nothing beyond the prefetch ring is built at landscape radius 8.
    expect(h.streamer.isBlockLoaded(0x43, 0x40)).toBe(false);
  });

  it('loadAround builds the object ring synchronously (world entry / teleport)', () => {
    const h = makeStreamer({ loadRadius: 8 });
    h.streamer.loadAround(0x40, 0x40);
    expect(h.collision.cylinderCount).toBe(9 * 3);
    expect(h.streamer.isBlockLoaded(0x42, 0x40)).toBe(false); // the prefetch ring waits for the pump
  });
});

describe('PERF.5 — retail per-ring landblock content (LScape::get_block_orient @ 00504f90)', () => {
  it('reduction by Chebyshev distance: d<2 → 1, d<3 → 2, d≤4 → 4, else 8; full detail is the 3×3', () => {
    expect(landblockDetailReduction(0, 0)).toBe(1);
    expect(landblockDetailReduction(1, -1)).toBe(1);
    expect(landblockDetailReduction(-2, 0)).toBe(2);
    expect(landblockDetailReduction(2, 2)).toBe(2);
    expect(landblockDetailReduction(3, 1)).toBe(4);
    expect(landblockDetailReduction(0, -4)).toBe(4);
    expect(landblockDetailReduction(5, 0)).toBe(8);
    expect(landblockDetailReduction(8, 8)).toBe(8);
    expect(RETAIL_FULL_DETAIL_RADIUS).toBe(1);
    for (const r of [3, 5, 8, 11, 15, 25]) expect(objectRingRadius(r)).toBe(1);
  });

  it('at landscape radius 8 only the 3×3 around the player draws; the prefetch ring is built but hidden', () => {
    const h = makeStreamer({ loadRadius: 8, scenery: true });
    h.streamer.loadAround(0x40, 0x40);
    h.streamer.pump(0x40, 0x40);
    const shown: number[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const inner = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
        const key = ((0x40 + dx) << 8) | (0x40 + dy);
        expect(h.streamer.isBlockShown(0x40 + dx, 0x40 + dy), `${dx},${dy}`).toBe(inner);
        expect(h.pools.statics.blocks.has(key)).toBe(inner);
        expect(h.pools.buildings.blocks.has(key)).toBe(inner);
        expect(h.pools.scenery.blocks.has(key)).toBe(inner);
        if (inner) shown.push(key);
      }
    }
    expect(h.pools.scenery.blocks.size).toBe(9);
    // Hidden blocks' per-object statics are invisible; shown ones draw.
    const visibleStatics = [...h.scene].filter((o) => o.visible).length;
    expect(visibleStatics).toBe(9);
    expect(h.streamer.census()).toMatchObject({ blocks: 25, shownBlocks: 9 });
  });

  it('crossing a block edge re-centres the ring from the per-frame pump without rebuilding anything', () => {
    const h = makeStreamer({ loadRadius: 8, scenery: true });
    h.streamer.loadAround(0x40, 0x40);
    h.streamer.pump(0x40, 0x40);
    const builtBefore = h.sceneryCalls.length;
    h.streamer.pump(0x41, 0x40); // one block east — main.ts's 96 m terrain refresh has not fired
    expect(h.streamer.isBlockShown(0x42, 0x40)).toBe(true);  // was prefetched hidden
    expect(h.streamer.isBlockShown(0x3f, 0x40)).toBe(false); // left the ring: hidden, still built
    expect(h.streamer.isBlockLoaded(0x3f, 0x40)).toBe(true);
    expect(h.pools.statics.blocks.has((0x42 << 8) | 0x40)).toBe(true);
    expect(h.pools.statics.blocks.has((0x3f << 8) | 0x40)).toBe(false);
    // The newly shown column was already built; the pump then prefetched the next ring.
    expect(h.sceneryCalls.length - builtBefore).toBe(5);
    expect(h.streamer.isBlockLoaded(0x43, 0x40)).toBe(true);
    // Moving back shows the old column again (no rebuild).
    const n = h.sceneryCalls.length;
    h.streamer.pump(0x40, 0x40);
    expect(h.streamer.isBlockShown(0x3f, 0x40)).toBe(true);
    expect(h.sceneryCalls.length).toBe(n);
  });
});

describe('PERF.3 — lazy interior cells', () => {
  // Block with 6 cells: a building doorway → 0x100 (stab list 0x100, 0x101);
  // 0x100 ↔ 0x101 ↔ 0x102 by CellPortals (0x102 = a deeper room); 0x101 also
  // has a portal to outside (0xFFFF). 0x103..0x105 are a sealed complex no
  // building leads into (0x103 ↔ 0x104 ↔ 0x105).
  const portals: PortalSpec[] = [{ flags: 0, otherCellId: 0x100, stabs: [0x100, 0x101] }];
  const cellPortals = { 0x100: [0x101], 0x101: [0x100, 0x102, 0xffff], 0x102: [0x101], 0x103: [0x104], 0x104: [0x103, 0x105], 0x105: [0x104] };
  const BK = (0x20 << 8) | 0x30;
  const id = (idx: number) => (0x20300000 | idx) >>> 0;

  it('collectWalkableCells is the portal closure of the doorway cells (0xFFFF = outside is not a cell)', () => {
    const walk = collectWalkableCells([0x100, 0x101], 6, (idx) => (cellPortals as Record<number, number[]>)[idx]?.map((otherCellId) => ({ otherCellId })));
    expect([...walk].sort()).toEqual([0x100, 0x101, 0x102]);
    expect(collectWalkableCells([], 6, () => [])).toEqual(new Set());
  });

  it('builds render meshes only for the stab cells and collision only for the walkable cells', () => {
    const h = makeStreamer({ numCells: 6, portals, cellPortals });
    h.streamer.loadNow(0x20, 0x30);
    expect([...cellsOf(h, BK)!.keys()].sort()).toEqual([0x100, 0x101]);
    expect(h.cellMeshCalls).toEqual([id(0x100), id(0x101)]);
    expect([...h.cellKeys].sort()).toEqual([id(0x100), id(0x101), id(0x102)]);
    // Stab cells start visible (the outdoor rule), exactly as before.
    for (const m of cellsOf(h, BK)!.values()) expect(m.visible).toBe(true);
    expect(h.streamer.loadedBuildingMeshes.get(BK)).toHaveLength(2);
  });

  it("the player's cell + PVS build on demand, retire when the player's cell leaves the block, and rebuild on re-entry", () => {
    const h = makeStreamer({ numCells: 6, portals, cellPortals });
    h.streamer.loadNow(0x20, 0x30);
    const dirty0 = h.dirty;
    // Standing in 0x101, whose PVS is {0x100, 0x101, 0x102}.
    expect(h.streamer.ensureSurfaceCells(BK, [0x101, 0x100, 0x102])).toBe(1);
    const deeper = cellsOf(h, BK)!.get(0x102)!;
    expect(deeper).toBeDefined();
    expect(h.scene.has(deeper)).toBe(true);
    expect(deeper.visible).toBe(false); // the surface rule decides; not a stab cell
    expect(h.dirty).toBeGreaterThan(dirty0); // camera raycast list rebuilt
    // Idempotent; out-of-range indices are ignored.
    expect(h.streamer.ensureSurfaceCells(BK, [0x102, 0x0ff, 0x200])).toBe(0);
    // Same block kept → nothing retires.
    expect(h.streamer.retireSurfaceCells(BK)).toBe(0);
    // Player's cell left the block → the demand cell goes, stab cells stay.
    expect(h.streamer.retireSurfaceCells(-1)).toBe(1);
    expect(h.scene.has(deeper)).toBe(false);
    expect([...cellsOf(h, BK)!.keys()].sort()).toEqual([0x100, 0x101]);
    // Collision was never tied to the render mesh.
    expect(h.cellKeys.has(id(0x102))).toBe(true);
    expect(h.streamer.ensureSurfaceCells(BK, [0x102])).toBe(1);
    expect(h.streamer.census().cellMeshesBuilt).toBe(4);
  });

  it('STREAM.demand-cell-miss-kept — a demand cell built across a streamed miss is rebuilt once the files land', async () => {
    let missing = false;
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const h = makeStreamer({
      numCells: 6, portals, cellPortals,
      extra: {
        trackMisses: <T,>(step: () => T) => ({ result: step(), missed: missing, settled }),
      },
    });
    h.streamer.loadNow(0x20, 0x30);
    missing = true; // the deeper room's Environment / textures aren't resident yet
    expect(h.streamer.ensureSurfaceCells(BK, [0x101, 0x100, 0x102])).toBe(1);
    const partial = cellsOf(h, BK)!.get(0x102)!;
    const gen = h.streamer.surfaceCellGeneration;
    missing = false;
    settle();
    await new Promise((r) => setTimeout(r, 0));
    // The incomplete room is gone and the surface rule is told to run again…
    expect(h.scene.has(partial)).toBe(false);
    expect(cellsOf(h, BK)!.has(0x102)).toBe(false);
    expect(h.streamer.surfaceCellGeneration).toBe(gen + 1);
    // …which builds it again from the resident files.
    expect(h.streamer.ensureSurfaceCells(BK, [0x101, 0x100, 0x102])).toBe(1);
    expect(cellsOf(h, BK)!.get(0x102)).not.toBe(partial);
  });

  it('a hidden (prefetch-ring) block builds nothing visible on demand and unload disposes demand cells', () => {
    const h = makeStreamer({ loadRadius: 8, numCells: 6, portals, cellPortals });
    h.streamer.loadAround(0x22, 0x30); // block 0x2030 is two blocks west: prefetch ring
    h.streamer.pump(0x22, 0x30);
    expect(h.streamer.isBlockShown(0x20, 0x30)).toBe(false);
    expect(h.streamer.surfaceCellRegistry.has(BK)).toBe(false);
    expect(h.streamer.ensureSurfaceCells(BK, [0x102])).toBe(1);
    // Hidden block: its cells draw nothing.
    expect([...h.scene].filter((o) => o.name.startsWith('envcell_20300') && o.visible)).toHaveLength(0);
    h.streamer.unloadDistant(0x30, 0x30);
    expect([...h.scene].filter((o) => o.name.startsWith('envcell_20300'))).toHaveLength(0);
    expect([...h.cellKeys].filter((k) => (k >>> 16) === 0x2030)).toHaveLength(0);
  });

  it('a dungeon block no building leads into builds no cell mesh and no cell collision', () => {
    const h = makeStreamer({ numCells: 6, portals: [], cellPortals });
    h.streamer.loadNow(0x20, 0x30);
    expect(h.cellMeshCalls).toHaveLength(0);
    expect(h.cellKeys.size).toBe(0);
    // Still registered so a PVS demand could build (never happens without walkable cells).
    expect(cellsOf(h, BK)!.size).toBe(0);
  });
});

describe('VISUAL.dat-static-default-scripts — landblock statics carry their Setup DefaultScript', () => {
  const POOLED_TORCH = 0x020001eb;   // batched Setup static, DefaultScript 0x3300000b
  const FALLBACK_LAMP = 0x020005d8;  // per-object Setup static, DefaultScript 0x330006f8

  it('a batched Setup static gets a transform-only script anchor at its drawn frame; a per-object one is its own anchor', () => {
    const h = makeStreamer({
      stabIds: [POOLED_TORCH, FALLBACK_LAMP],
      pooledIds: [POOLED_TORCH],
      defaultScripts: { [POOLED_TORCH]: 0x3300000b, [FALLBACK_LAMP]: 0x330006f8 },
    });
    h.streamer.loadNow(0x20, 0x30);
    const tagged = h.attached.filter(o => o.userData[STATIC_SCRIPT_KEY]);
    expect(tagged.map(o => o.userData[STATIC_SCRIPT_KEY])).toEqual([0x3300000b, 0x330006f8]);
    const [torch, lamp] = tagged;
    expect(torch.userData.setupId).toBe(POOLED_TORCH);
    // AC (20, 30, 5) in block (0x20, 0x30) → three (x, y=z, z=y)
    expect(torch.position.toArray()).toEqual([0x20 * 192 + 20, 5, 0x30 * 192 + 30]);
    expect(lamp.userData.setupId).toBe(FALLBACK_LAMP);
    // The per-object lamp keeps its 90° yaw (AC quat w=z=√½ → three (-x,-z,-y,w)).
    expect(lamp.quaternion.y).toBeCloseTo(-Math.SQRT1_2, 5);
    // Both are in the scene, owned by the block.
    expect(h.scene.has(torch)).toBe(true);
    expect(h.scene.has(lamp)).toBe(true);
  });

  it('statics without a DefaultScript get no anchor; unloading the block detaches every tree it attached', () => {
    const h = makeStreamer({ stabIds: [POOLED_TORCH, FALLBACK_LAMP], pooledIds: [POOLED_TORCH], defaultScripts: { [FALLBACK_LAMP]: 0x330006f8 } });
    h.streamer.loadNow(0x20, 0x30);
    expect(h.attached.filter(o => o.userData[STATIC_SCRIPT_KEY])).toHaveLength(1);
    expect([...h.scene].filter(o => o.name.startsWith('static_script_'))).toHaveLength(0);
    const keep = objectUnloadRadius(RETAIL_FULL_DETAIL_RADIUS);
    h.streamer.unloadDistant(0x20 + keep + 1, 0x30);
    expect(h.scene.size).toBe(0);
    expect(new Set(h.detached)).toEqual(new Set(h.attached));
  });
});

describe('SOUND.scenery-default-scripts — landscape scenery plays its Setup DefaultScript (InitDefaults)', () => {
  const FLAME = 0x02000407;   // instanced scenery Setup with a particle DefaultScript
  const BROOK = 0x020007c4;   // its DefaultScript loops Wave 0x0A000207
  const WINDMILL = 0x02000300; // animated scenery (DefaultAnimation) that also has a script

  it('instanced scenery with a DefaultScript keeps its pool entry and gains a script anchor at its frame', () => {
    const h = makeStreamer({ scenery: true, sceneryIds: [FLAME, BROOK, 0x01000077], defaultScripts: { [FLAME]: 0x330001aa, [BROOK]: 0x330004c1 } });
    h.streamer.loadNow(0x20, 0x30);
    const anchors = h.attached.filter(o => o.name.startsWith('scenery_script_'));
    expect(anchors.map(o => o.userData[STATIC_SCRIPT_KEY])).toEqual([0x330001aa, 0x330004c1]);
    expect(anchors[0].userData.setupId).toBe(FLAME);
    // The anchor sits at the entry's placement (bx·192+10+i, 3, by·192+10).
    expect(anchors[1].position.toArray()).toEqual([0x20 * 192 + 11, 3, 0x30 * 192 + 10]);
    expect(h.scene.has(anchors[0])).toBe(true);
    // All three stay instanced (no DefaultAnimation).
    expect(h.pools.scenery.entries.get((0x20 << 8) | 0x30)).toHaveLength(3);
  });

  it('animated scenery carries its DefaultScript on its own mesh; scenery without one gets no anchor; unload detaches', () => {
    const h = makeStreamer({ scenery: true, sceneryIds: [WINDMILL, 0x01000077], defaultAnims: { [WINDMILL]: 0x03000aaa }, defaultScripts: { [WINDMILL]: 0x33000bbb } });
    h.streamer.loadNow(0x20, 0x30);
    const tagged = h.attached.filter(o => o.userData[STATIC_SCRIPT_KEY]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].userData[STATIC_SCRIPT_KEY]).toBe(0x33000bbb);
    expect(tagged[0].name.startsWith('scenery_script_')).toBe(false); // the mesh itself
    const keep = objectUnloadRadius(RETAIL_FULL_DETAIL_RADIUS);
    h.streamer.unloadDistant(0x20 + keep + 1, 0x30);
    expect(new Set(h.detached)).toEqual(new Set(h.attached));
  });
});

describe('VISUAL.holtburg-roof-plank — statics sit at their exact DAT frame (no base lift)', () => {
  it('a pooled static\'s instance matrix is the frame origin, height = AC z', () => {
    const h = makeStreamer();
    h.streamer.loadNow(0x20, 0x30);
    const blockKey = (0x20 << 8) | 0x30;
    const [entry] = h.pools.statics.entries.get(blockKey) as { objId: number; matrix: THREE.Matrix4 }[];
    const p = new THREE.Vector3().setFromMatrixPosition(entry.matrix);
    expect(p.toArray()).toEqual([0x20 * 192 + 20, 5, 0x30 * 192 + 30]);
  });

  it('a per-object static with geometry below its pivot is not lifted', () => {
    const h = makeStreamer({ stabIds: [POOLED_STATIC, 0x01000555] });
    h.streamer.loadNow(0x20, 0x30);
    const placed = [...h.scene].find((o) => Math.abs(o.position.x - (0x20 * 192 + 60)) < 1e-6);
    expect(placed).toBeTruthy();
    expect(placed!.position.y).toBe(5);
  });
});

describe('RELEASE.dat-streaming — blocks wait for their streamed DAT files', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a block whose files are not resident builds nothing (even via loadNow) until they land, then the pump builds it', async () => {
    const ready = new Set<number>();
    const requested: number[] = [];
    let land!: () => void;
    const h = makeStreamer({
      extra: {
        blockData: {
          isReady: (bx, by) => ready.has((bx << 8) | by),
          request: (bx, by) => { requested.push((bx << 8) | by); return new Promise<void>((r) => { land = () => { ready.add((bx << 8) | by); r(); }; }); },
        },
      },
    });
    h.streamer.streamAround(0x20, 0x30);
    h.streamer.loadNow(0x20, 0x30);
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(false);
    expect(h.collision.cylinderCount).toBe(0);
    expect(requested).toEqual([0x2030]);
    h.streamer.loadNow(0x20, 0x30); // a second attempt while waiting requests nothing new
    expect(requested).toEqual([0x2030]);
    land();
    await flush();
    h.streamer.pump(0x20, 0x30);
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(true);
    expect(h.collision.cylinderCount).toBe(3);
  });

  it('a failed stream still builds the block with what is resident (never stuck invisible)', async () => {
    const warns: string[] = [];
    const h = makeStreamer({
      extra: {
        blockData: { isReady: () => false, request: () => Promise.reject(new Error('offline')) },
        warn: { warn: (d) => { warns.push(d); } },
      },
    });
    h.streamer.streamAround(0x20, 0x30);
    h.streamer.loadNow(0x20, 0x30);
    await flush();
    h.streamer.pump(0x20, 0x30);
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(true);
    expect(warns.some((w) => /failed to stream/.test(w))).toBe(true);
  });

  it('a build step that missed a streamed file rebuilds the block once the file is resident', async () => {
    let missNext = true;
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const h = makeStreamer({
      extra: {
        trackMisses: <T,>(step: () => T) => {
          const result = step();
          const missed = missNext;
          missNext = false;
          return { result, missed, settled };
        },
      },
    });
    h.streamer.loadNow(0x20, 0x30);
    expect(h.collision.cylinderCount).toBe(3);
    const unloadsBefore = h.streamer.unloadedBlockCount;
    settle();
    await flush();
    expect(h.streamer.rebuiltBlockCount).toBe(1);
    expect(h.streamer.unloadedBlockCount).toBe(unloadsBefore + 1);
    expect(h.collision.cylinderCount).toBe(0);
    h.streamer.loadNow(0x20, 0x30); // (no ring centre: the caller's next load rebuilds it)
    // Rebuilt from scratch: the same objects + keys, no duplicates.
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(true);
    expect(h.collision.cylinderCount).toBe(3);
    expect(h.streamer.blockCollisionKeys((0x20 << 8) | 0x30)).toHaveLength(3);
  });

  it('STREAM.block-rebuild-collision-gap — a shown block is rebuilt in the same call (no frame without its collision)', async () => {
    let missNext = true;
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const h = makeStreamer({
      extra: {
        trackMisses: <T,>(step: () => T) => {
          const result = step();
          const missed = missNext;
          missNext = false;
          return { result, missed, settled };
        },
      },
    });
    h.streamer.streamAround(0x20, 0x30); // the player's block: inside the object ring
    h.streamer.loadNow(0x20, 0x30);
    expect(h.collision.cylinderCount).toBe(3);
    settle();
    await flush();
    expect(h.streamer.rebuiltBlockCount).toBe(1);
    // No pump in between: rebuilt already, same objects + keys, no duplicates.
    expect(h.streamer.isBlockLoaded(0x20, 0x30)).toBe(true);
    expect(h.collision.cylinderCount).toBe(3);
    expect(h.streamer.blockCollisionKeys((0x20 << 8) | 0x30)).toHaveLength(3);
  });
});

describe('SWEEP1006B — DAT statics with a Setup DefaultAnimation are per-object and tagged', () => {
  // CPartArray::InitDefaults @ 00518980 → CPhysicsObj::InitDefaults
  // @ 005139d0: a STATIC object with default_anim_id joins
  // static_animating_objects; its parts move, so it can't be instanced.
  const ANIM_STATIC = 0x02000ccd;
  const ANIM_SCENERY = 0x020005ac;

  it('an instancer-resolvable static with a DefaultAnimation leaves the pool and is tagged', () => {
    const h = makeStreamer({ stabIds: [ANIM_STATIC, POOLED_STATIC], pooledIds: [ANIM_STATIC], defaultAnims: { [ANIM_STATIC]: 0x0300091d } });
    h.streamer.loadNow(0x20, 0x30);
    const blockKey = (0x20 << 8) | 0x30;
    expect(h.pools.statics.blocks.get(blockKey)).toBe(1); // only POOLED_STATIC
    const tagged = h.attached.filter(o => o.userData[STATIC_ANIM_KEY]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].userData[STATIC_ANIM_KEY]).toBe(0x0300091d);
    expect(tagged[0].userData.setupId).toBe(ANIM_STATIC);
    expect(tagged[0].position.toArray()).toEqual([0x20 * 192 + 20, 5, 0x30 * 192 + 30]);
    expect(h.scene.has(tagged[0])).toBe(true);
  });

  it('animated scenery placements become per-object meshes at their placement matrix; the rest stay pooled', () => {
    const h = makeStreamer({ scenery: true, sceneryIds: [0x01000077, ANIM_SCENERY], defaultAnims: { [ANIM_SCENERY]: 0x03000751 } });
    h.streamer.loadNow(0x20, 0x30);
    const blockKey = (0x20 << 8) | 0x30;
    expect(h.pools.scenery.blocks.get(blockKey)).toBe(1);
    const tagged = h.attached.filter(o => o.userData[STATIC_ANIM_KEY] === 0x03000751);
    expect(tagged).toHaveLength(1);
    const o = tagged[0];
    expect(o.position.x).toBeCloseTo(0x20 * 192 + 11, 5);
    expect(o.position.y).toBeCloseTo(3, 5);
    expect(o.scale.x).toBeCloseTo(1.25, 5);
    expect(h.scene.has(o)).toBe(true);
    const keep = objectUnloadRadius(RETAIL_FULL_DETAIL_RADIUS);
    h.streamer.unloadDistant(0x20 + keep + 1, 0x30);
    expect(h.scene.has(o)).toBe(false);
    expect(h.detached).toContain(o);
  });
});
