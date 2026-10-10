/**
 * DEBT.main-ts-extractions — landblock OBJECT streaming, lifted out of
 * main.ts's main() closure: each landblock's LandblockInfo (0xXXYYFFFE)
 * statics, building exteriors, interior EnvCells and landscape scenery are
 * built (render + collision), tracked per block, and retired when the
 * player moves away — plus the collision-key bookkeeping that retires every
 * key a block registered with the outdoor collision, and the
 * LandblockLoadScheduler wiring that spreads a row crossing over frames
 * (REND.landblock-streaming-one-frame).
 *
 * PERF.5 — retail's per-ring content. The landscape grid follows the
 * Landscape Draw Distance, but a CLandBlock only instantiates its buildings,
 * statics, scenery and building-visible cells while it is full detail
 * (side_cell_count 8): the 3×3 blocks around the viewer
 * (LandscapeDrawDistance.landblockDetailReduction — LScape::get_block_orient
 * @ 00504f90, CLandBlock::notify_change_size @ 005302c0). So objects are
 * SHOWN only within objectRingRadius of the player's block. One ring further
 * is prefetched by the budgeted loader and kept built-but-hidden (and blocks
 * stay built, hidden, out to the unload hysteresis), so crossing a block
 * edge toggles visibility instead of building blocks in that frame.
 *
 * PERF.3 — interior cells are built lazily. A block builds render meshes
 * only for its building-portal stab cells (the only cells that can draw
 * while the viewer is outdoors — CLandBlock::init_buildings →
 * CBldPortal::add_to_stablist, CORE.14.b) and collision only for the cells
 * a walking player can reach from those doorways (buildingCells.
 * collectWalkableCells). Any other cell's render mesh is built the frame it
 * enters the player's current-cell PVS (ensureSurfaceCells — the only other
 * way applySurfaceCellVisibility can show a cell) and retired when the
 * player's cell leaves that block (retireSurfaceCells). Under-terrain
 * dungeon complexes no building leads into cost nothing on the surface.
 * The invisible `physcoll_` raycast proxies are no longer built: nothing
 * reads them (DungeonCollision.setPhysicsMeshes is a no-op — the cell BSPs
 * carry collision).
 */
import * as THREE from 'three';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import type { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import type { CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { DungeonCollision, collisionKey, type CollisionKey } from './DungeonCollision.js';
import { addObjectCollision, type ObjectPhysicsModel } from './ObjectCollision.js';
import { LandblockLoadScheduler, DEFAULT_LANDBLOCK_BUDGET_MS } from './LandblockLoadScheduler.js';
import { objectUnloadRadius, objectRingRadius, OBJECT_PREFETCH_RINGS } from './LandscapeDrawDistance.js';
import {
  collectBuildingStabCells, collectWalkableCells, buildBuildingGates, collectDrawingPortalPolys,
  type SurfaceCellBlock, type BuildingGate, type Vec3 as ACVec3,
} from './buildingCells.js';
import { DegradeLod } from '../models/DegradeLod.js';
import { disposeObjectTree } from '../models/MaterialOwnership.js';
import { placementFrameOf, PLACEMENT_RESTING } from '../models/SetupModelGroup.js';
import { createPortalPunch, retailPortalPunchDrawn } from './PortalPunch.js';
import { tagStaticScriptAnchor } from './StaticScriptDriver.js';
import { tagStaticDefaultAnimation } from './StaticAnimationDriver.js';
import type { InstanceEntry } from '../terrain/SceneryInstancer.js';

/** Building exterior shells with bounding boxes. `wasInside` feeds the
 *  isIndoors HUD state (radar range) and gates when the surface
 *  cell-containment scan needs to run at all. */
export interface BuildingShell {
  /** Owning landblock key — shells are retired per block on unload. */
  blockKey: number;
  /** PERF.1 — no live exterior reference: pooled exteriors render through
   *  buildingsPool, and the bbox below is computed from the same instancer
   *  templates + matrices Box3.setFromObject measured on the old
   *  per-object mesh. */
  bbox: THREE.Box3;
  /** Expanded bbox for enter detection (hysteresis prevents flicker). */
  enterBbox: THREE.Box3;
  /** Whether the player was inside this building last frame. */
  wasInside: boolean;
}

/** A cross-landblock instancing pool (terrain/SceneryInstancePool). */
export interface BlockInstancePool {
  addBlock(blockKey: number, entries: InstanceEntry[]): void;
  removeBlock(blockKey: number): void;
  setVisible(visible: boolean): void;
}

/** One block's landscape scenery (world/LandblockScenery). */
export interface BlockScenery {
  entries: InstanceEntry[];
  /** Collision keys already registered with the outdoor collision; retired with the block. */
  collisionKeys: CollisionKey[];
}

/** The world services the streamer drives (all owned by main.ts). */
export interface LandblockObjectStreamerDeps {
  cellDb: { getFileData(fileId: number): ArrayBuffer | null };
  /** sceneManager.add — every streamed mesh goes through it. */
  addToScene(obj: THREE.Object3D): void;
  /** sceneManager.scene.remove. */
  removeFromScene(obj: THREE.Object3D): void;
  /** terrainRenderer.setLandscapeVisible (the sealed-interior toggle). */
  setTerrainVisible(visible: boolean): void;
  instancer: {
    hasModel(objId: number): boolean;
    getWorldBBox(objId: number, worldMatrix: THREE.Matrix4): THREE.Box3 | null;
  };
  /**
   * RENDER.untextured-skipped-in-buildings-and-cells — the instancer whose
   * templates are built in the BUILDING pass (ModelRenderer.createMesh
   * `buildingPass`): RenderDeviceD3D::DrawBuilding @ 0059f2a0 sets
   * ObjBuildingOrBuildingPart, so D3DPolyRender::DrawMesh @ 0059d4a0 skips
   * the building's untextured surfaces. Defaults to `instancer` (test fakes).
   */
  buildingInstancer?: {
    hasModel(objId: number): boolean;
    getWorldBBox(objId: number, worldMatrix: THREE.Matrix4): THREE.Box3 | null;
  };
  sceneryPool: BlockInstancePool;
  staticsPool: BlockInstancePool;
  buildingsPool: BlockInstancePool;
  envCells: {
    createCellMesh(cellId: number): THREE.Object3D | null;
    getCellCollisionData(cellId: number): { cellStruct: CellStruct; position: Frame } | null;
    loadEnvCell(cellId: number): Pick<EnvCell, 'staticObjects' | 'cellPortals'> | null;
  };
  setupModels: {
    createSetupMesh(setupId: number, placementKey?: number, buildingPass?: boolean): THREE.Group | null;
    loadSetupModel(setupId: number): SetupModel | null;
  };
  models: {
    createMesh(gfxObjId: number, textureOverrides?: Map<number, number>, paletteColors?: number[], buildingPass?: boolean): THREE.Group | null;
    loadGfxObj(gfxObjId: number): GfxObj | null;
  };
  degradeLod: Pick<DegradeLod, 'attachPart'>;
  /** The outdoor collision world (main.ts outdoorCollision). */
  collision: DungeonCollision;
  /** Scenery/static physics models, per object id (null = unresolvable; main.ts caches). */
  objectPhysics(objId: number): ObjectPhysicsModel | null;
  /**
   * PERF.5 — one block's landscape scenery (CLandBlock::get_land_scenes,
   * world/LandblockScenery), built with the block's other objects. Absent /
   * null → the block has no scenery (no RegionDesc scene info).
   */
  buildScenery?(blockX: number, blockY: number): BlockScenery | null;
  /**
   * VISUAL.dat-static-default-scripts — every tree this streamer adds to the
   * scene goes through attach() (its tagged statics start their Setup
   * DefaultScript) and through detach() before it is disposed.
   */
  staticScripts?: { attach(root: THREE.Object3D): void; detach(root: THREE.Object3D): void };
  /** Streaming failures — counted, rate-limited, never chat. */
  warn: { warn(detail: string, err?: unknown): void };
  /** The building / cell mesh lists changed — main.ts rebuilds the collision raycast lists. */
  onCollisionMeshesChanged(): void;
  /** Initial Render.LandscapeDrawDistance, landblocks. */
  loadRadius: number;
  /**
   * RELEASE.dat-streaming — streamed DATs: whether a block's files (bundle +
   * object closure) are resident, and a request to make them so. A block
   * that is not ready is not built (not even by loadNow); `requestBlock`'s
   * promise re-queues it. Absent → every block is ready (whole DATs).
   */
  blockData?: {
    isReady(blockX: number, blockY: number): boolean;
    request(blockX: number, blockY: number): Promise<unknown>;
  };
  /**
   * RELEASE.dat-streaming — run one build step inside a streamed-DAT miss
   * scope; reports whether any read missed (DatStore.scoped). Absent → no tracking.
   */
  trackMisses?<T>(step: () => T): { result: T; missed: boolean; settled: Promise<unknown> };
  /** Scheduler clock (tests). */
  now?: () => number;
  /** Scheduler budget, ms (tests). */
  budgetMs?: number;
}

/** Everything one loaded landblock owns. */
interface ObjectBlock {
  key: number;
  bx: number;
  by: number;
  /** Within the object ring (drawn); false = built but hidden (prefetch / hysteresis). */
  shown: boolean;
  /** Per-object statics / building fallbacks + interior cell meshes. */
  objects: THREE.Object3D[];
  /** Objects THIS streamer hid (ring or sealed interior); restored when both allow. */
  suppressed: Set<THREE.Object3D>;
  /** Building fallbacks + cell meshes — the camera/collision raycast list (loadedBuildingMeshes). */
  raycastMeshes: THREE.Object3D[];
  staticEntries: InstanceEntry[];
  buildingEntries: InstanceEntry[];
  sceneryEntries: InstanceEntry[] | null;
  collisionKeys: CollisionKey[];
  /** Interior cells: render meshes built so far + stab set + doorway gates (null: no cells). */
  cells: SurfaceCellBlock<THREE.Object3D> | null;
  /** Cell indices built on PVS demand (not stab cells) — retired by retireSurfaceCells. */
  demandCells: Set<number>;
  numCells: number;
}

const GATE_IDENTITY_QUAT = { w: 1, x: 0, y: 0, z: 0 };

function keyOf(blockX: number, blockY: number): number {
  return ((blockX & 0xff) << 8) | (blockY & 0xff);
}

export class LandblockObjectStreamer {
  /** Render.LandscapeDrawDistance (the terrain grid radius). */
  private _loadRadius: number;

  private readonly loadedObjectBlocks = new Set<number>(); // LandblockInfo ids whose load has started
  private readonly blocks = new Map<number, ObjectBlock>(); // blockKey → completed block
  /** The player's block the ring is centred on (null until the first stream/load). */
  private center: { x: number; y: number } | null = null;
  // BUG.sealed-interior-renders-outdoor-terrain — inside a sealed interior
  // (EnvCell SeenOutside unset) the outdoor world must not be drawn at all:
  // the Holtburg starter cottage floor sits within meters of the host
  // landblock's terrain, so fog alone cannot hide the mound that intersects
  // the room. Each block tracks the objects the streamer hid so restoring
  // never force-shows meshes that were already invisible by design.
  private _landscapeVisible = true;
  /** blockKey → building/cell meshes for the camera raycast list. */
  readonly loadedBuildingMeshes = new Map<number, THREE.Object3D[]>();
  readonly buildingShells: BuildingShell[] = [];
  /** CORE.14.b — blockKey → the SHOWN block's interior cells for the surface visibility rule. */
  readonly surfaceCellRegistry = new Map<number, SurfaceCellBlock<THREE.Object3D>>();
  private _surfaceCellGeneration = 0; // bumped when a block's cells join / leave the registry
  /** Landblock statics + buildings placed since startup (a load-time statistic only). */
  private _totalModelsPlaced = 0;
  /** PERF.3 — interior cell meshes built so far (stab + demand), for the scene census. */
  private _cellMeshesBuilt = 0;

  /**
   * REND.landblock-streaming-one-frame — the per-frame, nearest-first,
   * time-budgeted object loader (pumped every frame in the main loop). The
   * player's own block and its neighbours always load synchronously, so
   * their collision exists before the player can reach it.
   */
  private readonly scheduler: LandblockLoadScheduler;

  constructor(private readonly deps: LandblockObjectStreamerDeps) {
    this._loadRadius = deps.loadRadius;
    this.scheduler = new LandblockLoadScheduler(
      (bx, by) => this.trackedSteps(bx, by),
      { budgetMs: deps.budgetMs ?? DEFAULT_LANDBLOCK_BUDGET_MS, syncRadius: 1, ...(deps.now ? { now: deps.now } : {}) },
    );
  }

  /** The landscape grid radius (Render.LandscapeDrawDistance). */
  get loadRadius(): number { return this._loadRadius; }
  /** PERF.5 — objects draw within this many blocks of the player's block (retail full-detail ring). */
  get objectRadius(): number { return objectRingRadius(this._loadRadius); }
  /** Object blocks are built (hidden beyond objectRadius) within this many blocks. */
  get prefetchRadius(): number { return this.objectRadius + OBJECT_PREFETCH_RINGS; }
  /** Object blocks unload beyond this many blocks. */
  get unloadRadius(): number { return objectUnloadRadius(this.objectRadius); }
  get landscapeVisible(): boolean { return this._landscapeVisible; }
  get surfaceCellGeneration(): number { return this._surfaceCellGeneration; }
  get totalModelsPlaced(): number { return this._totalModelsPlaced; }

  /** Whether a block's LandblockInfo has been (or is being) loaded. */
  isBlockLoaded(blockX: number, blockY: number): boolean {
    return this.loadedObjectBlocks.has((((blockX & 0xff) << 24) | ((blockY & 0xff) << 16) | 0xfffe) >>> 0);
  }

  /** Whether a loaded block's objects are drawn (inside the object ring). */
  isBlockShown(blockX: number, blockY: number): boolean {
    return this.blocks.get(keyOf(blockX, blockY))?.shown ?? false;
  }

  /** Collision keys currently registered for a block's statics / cells / buildings / scenery. */
  blockCollisionKeys(blockKey: number): readonly CollisionKey[] | undefined {
    return this.blocks.get(blockKey)?.collisionKeys;
  }

  /** PERF.3/PERF.5 — what the streamer holds right now (scene census / tests). */
  census(): { blocks: number; shownBlocks: number; cellMeshes: number; cellMeshesBuilt: number; demandCells: number; collisionKeys: number } {
    let shownBlocks = 0, cellMeshes = 0, demandCells = 0, collisionKeys = 0;
    for (const b of this.blocks.values()) {
      if (b.shown) shownBlocks++;
      cellMeshes += b.cells?.meshes.size ?? 0;
      demandCells += b.demandCells.size;
      collisionKeys += b.collisionKeys.length;
    }
    return { blocks: this.blocks.size, shownBlocks, cellMeshes, cellMeshesBuilt: this._cellMeshesBuilt, demandCells, collisionKeys };
  }

  /** CORE.17.h.g.a — a new Render.LandscapeDrawDistance (the object ring stays inside it). */
  setLoadRadius(r: number): void {
    this._loadRadius = r;
  }

  setLandscapeVisible(visible: boolean): void {
    if (this._landscapeVisible === visible) return;
    this._landscapeVisible = visible;
    this.deps.setTerrainVisible(visible);
    // PERF.1 — pooled scenery/statics/buildings live outside the per-block lists.
    this.deps.sceneryPool.setVisible(visible);
    this.deps.staticsPool.setVisible(visible);
    this.deps.buildingsPool.setVisible(visible);
    for (const block of this.blocks.values()) this.applyVisibility(block);
  }

  /**
   * Track whether the player is inside each building footprint. Uses
   * hysteresis: enter via the tight bbox (strict to avoid false-positives at
   * the edge), exit via the expanded enterBbox (loose to avoid flicker when
   * walking along the exterior wall).
   *
   * XZ-only containment (ignore Y): the building bbox extends from ground to
   * roof, but we only care about horizontal position — the player is "inside"
   * the building footprint regardless of how tall the roof is.
   */
  updateBuildingShells(playerX: number, playerZ: number): void {
    for (const shell of this.buildingShells) {
      // Hysteresis: strict bbox on entry, loose enterBbox on exit.
      const box = shell.wasInside ? shell.enterBbox : shell.bbox;
      shell.wasInside =
        playerX >= box.min.x && playerX <= box.max.x &&
        playerZ >= box.min.z && playerZ <= box.max.z;
    }
  }

  /** Load one landblock's objects to completion, synchronously. */
  loadNow(blockX: number, blockY: number): void {
    // A block the scheduler has half-built finishes first (it owns the load).
    this.scheduler.complete(blockX, blockY);
    const steps = this.trackedSteps(blockX, blockY);
    while (!steps.next().done) { /* drain every step now */ }
  }

  /** Blocks waiting for their streamed DAT files (RELEASE.dat-streaming). */
  private readonly awaitingData = new Set<number>();
  /** Blocks rebuilt because a build step missed a streamed file. */
  rebuiltBlockCount = 0;

  /**
   * RELEASE.dat-streaming — the block's steps, gated on its streamed files
   * and tracked for misses. Not ready → request the files, build nothing and
   * re-queue the block when they land. A build that missed a file is
   * rebuilt (unload + load) once the missed files are resident, so nothing
   * stays invisible because its bytes arrived late.
   */
  private *trackedSteps(blockX: number, blockY: number): Generator<void, void, void> {
    const d = this.deps;
    const key = keyOf(blockX, blockY);
    if (d.blockData && !this.forcedReady.has(key) && !d.blockData.isReady(blockX, blockY)) {
      if (this.awaitingData.has(key)) return;
      this.awaitingData.add(key);
      d.blockData.request(blockX, blockY).then(
        () => this.requeueAfterData(blockX, blockY),
        (err) => { d.warn.warn(`landblock 0x${key.toString(16)} DAT files failed to stream — built with what is resident`, err); this.requeueAfterData(blockX, blockY, true); },
      );
      return;
    }
    const steps = this.loadSteps(blockX, blockY);
    if (!d.trackMisses) { yield* steps; return; }
    const settled: Promise<unknown>[] = [];
    for (;;) {
      const { result, missed, settled: s } = d.trackMisses(() => steps.next());
      if (missed) settled.push(s);
      if (result.done) break;
      yield;
    }
    if (settled.length > 0) {
      Promise.all(settled).then(() => this.rebuildBlock(blockX, blockY), () => { /* failed fetch: keep what was built */ });
    }
  }

  /** Files arrived for a waiting block: queue it if the player is still near. */
  private forcedReady = new Set<number>();
  private requeueAfterData(blockX: number, blockY: number, force = false): void {
    const key = keyOf(blockX, blockY);
    this.awaitingData.delete(key);
    if (force) this.forcedReady.add(key);
    if (!this.center) return;
    const r = this.prefetchRadius;
    if (Math.abs(blockX - this.center.x) > r || Math.abs(blockY - this.center.y) > r) return;
    this.scheduler.request(blockX, blockY, 0);
  }

  /** Unload one block and queue it again (its missed streamed files are resident now). */
  private rebuildBlock(blockX: number, blockY: number): void {
    const key = keyOf(blockX, blockY);
    const block = this.blocks.get(key);
    if (!block) return;
    this.unloadBlock(key, block);
    this.rebuiltBlockCount++;
    if (!this.center) return;
    const dx = Math.abs(blockX - this.center.x), dy = Math.abs(blockY - this.center.y);
    // A shown block (the object ring) is rebuilt in the same call: queued,
    // its buildings and statics blinked out and its collision was gone for
    // the physics steps before the next pump (retail never unloads a block
    // to finish it — its DBObj::Get blocks until the file is local).
    if (dx <= this.objectRadius && dy <= this.objectRadius) { this.loadNow(blockX, blockY); return; }
    if (dx > this.prefetchRadius || dy > this.prefetchRadius) return;
    this.scheduler.request(blockX, blockY, 0);
  }

  /**
   * World entry / teleport: centre the ring on (cx, cy), build the object
   * ring synchronously and queue the hidden prefetch ring for the budgeted
   * loader (blocks beyond the unload radius — the old region — retire now).
   */
  loadAround(cx: number, cy: number): void {
    this.recenter(cx, cy);
    const r = this.objectRadius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const bx = cx + dx;
        const by = cy + dy;
        if (bx < 0 || bx > 0xff || by < 0 || by > 0xff) continue;
        this.loadNow(bx, by);
      }
    }
  }

  /**
   * REND.landblock-streaming-one-frame — the player's block changed (or the
   * radius did): re-centre the object ring, queue the prefetch window for the
   * budgeted loader, drop queued blocks the player walked away from, and
   * unload distant objects.
   */
  streamAround(cx: number, cy: number): void {
    this.recenter(cx, cy);
  }

  /**
   * Run this frame's share of queued loads (pumped every frame by main.ts).
   * PERF.5 — retail re-grids on every block change (LScape::update_loadpoint
   * @ 00506cd0 → update_block), so the ring follows the player's block here,
   * not only on main.ts's 96 m terrain-refresh cadence.
   */
  pump(playerBlockX: number, playerBlockY: number): void {
    if (!this.center || this.center.x !== playerBlockX || this.center.y !== playerBlockY) {
      this.recenter(playerBlockX, playerBlockY);
    }
    this.scheduler.pump(playerBlockX, playerBlockY);
  }

  private recenter(cx: number, cy: number): void {
    this.center = { x: cx, y: cy };
    const prefetch = this.prefetchRadius;
    this.scheduler.cancelOutside(cx, cy, prefetch);
    this.scheduler.request(cx, cy, prefetch);
    this.unloadDistant(cx, cy);
    for (const block of this.blocks.values()) this.setBlockShown(block, this.inRing(block.bx, block.by));
  }

  private inRing(bx: number, by: number): boolean {
    if (!this.center) return true;
    const r = this.objectRadius;
    return Math.abs(bx - this.center.x) <= r && Math.abs(by - this.center.y) <= r;
  }

  /** Show / hide a block's objects: pools, per-object meshes and its surface-cell registry entry. */
  private setBlockShown(block: ObjectBlock, shown: boolean): void {
    if (block.shown !== shown) {
      block.shown = shown;
      const d = this.deps;
      if (shown) {
        d.staticsPool.addBlock(block.key, block.staticEntries);
        d.buildingsPool.addBlock(block.key, block.buildingEntries);
        if (block.sceneryEntries) d.sceneryPool.addBlock(block.key, block.sceneryEntries);
        if (block.cells) {
          this.surfaceCellRegistry.set(block.key, block.cells);
          this._surfaceCellGeneration++;
        }
      } else {
        d.staticsPool.removeBlock(block.key);
        d.buildingsPool.removeBlock(block.key);
        d.sceneryPool.removeBlock(block.key);
        if (this.surfaceCellRegistry.delete(block.key)) this._surfaceCellGeneration++;
      }
    }
    this.applyVisibility(block);
  }

  /** A block's per-object meshes draw only while it is shown AND the landscape is. */
  private applyVisibility(block: ObjectBlock): void {
    if (block.shown && this._landscapeVisible) {
      for (const o of block.suppressed) o.visible = true;
      block.suppressed.clear();
    } else {
      for (const o of block.objects) {
        if (o.visible) {
          o.visible = false;
          block.suppressed.add(o);
        }
      }
    }
  }

  /**
   * PERF.3 — build the render meshes of a block's interior cells that are not
   * built yet: the player's current cell + its VisibleCells PVS (main.ts
   * updateSurfaceCellVisibility), the only non-stab cells the surface rule
   * (applySurfaceCellVisibility) can show. Called before the rule is applied
   * in the same frame, so a cell is on screen exactly when it was before.
   * Returns how many meshes were built.
   */
  ensureSurfaceCells(blockKey: number, cellIndices: Iterable<number>): number {
    const block = this.blocks.get(blockKey);
    if (!block?.cells) return 0;
    let built = 0;
    for (const idx of cellIndices) {
      if (idx < 0x0100 || idx >= 0x0100 + block.numCells || block.cells.meshes.has(idx)) continue;
      const mesh = this.buildDemandCellMesh(block, idx);
      if (!mesh) continue;
      block.demandCells.add(idx);
      built++;
    }
    if (built > 0) {
      this.applyVisibility(block);
      this.deps.onCollisionMeshesChanged();
    }
    return built;
  }

  /**
   * RELEASE.dat-streaming — a demand cell is built outside the block's
   * tracked steps, so its misses (an Environment, a texture, a static's
   * GfxObj evicted since the block was built) would leave an untextured or
   * half-furnished room until the player left the block. A build that
   * missed is dropped once the files land and the surface rule rebuilds it
   * on the next frame (surfaceCellGeneration).
   */
  private buildDemandCellMesh(block: ObjectBlock, idx: number): THREE.Object3D | null {
    const track = this.deps.trackMisses;
    if (!track) return this.buildCellMesh(block, idx);
    const { result: mesh, missed, settled } = track(() => this.buildCellMesh(block, idx));
    if (missed) {
      settled.then(() => {
        if (this.blocks.get(block.key) !== block || !block.cells) return;
        const built = block.cells.meshes.get(idx);
        if (built && built === mesh) {
          block.cells.meshes.delete(idx);
          block.demandCells.delete(idx);
          this.dropObject(block, built);
          this.deps.onCollisionMeshesChanged();
        }
        this._surfaceCellGeneration++;
      }, () => { /* failed fetch: keep what was built */ });
    }
    return mesh;
  }

  /**
   * PERF.3 — retire the demand-built cell meshes of every block except
   * `keepBlockKey` (the block whose interior the player is in; -1 = none).
   * Stab cells stay: they draw from outdoors.
   */
  retireSurfaceCells(keepBlockKey: number): number {
    let retired = 0;
    for (const block of this.blocks.values()) {
      if (block.key === keepBlockKey || block.demandCells.size === 0 || !block.cells) continue;
      for (const idx of block.demandCells) {
        const mesh = block.cells.meshes.get(idx);
        if (!mesh) continue;
        block.cells.meshes.delete(idx);
        this.dropObject(block, mesh);
        retired++;
      }
      block.demandCells.clear();
    }
    if (retired > 0) this.deps.onCollisionMeshesChanged();
    return retired;
  }

  /** Build + register one interior cell's render mesh (hidden until the surface rule shows it). */
  private buildCellMesh(block: ObjectBlock, idx: number): THREE.Object3D | null {
    const cellId = ((((block.bx & 0xff) << 24) | ((block.by & 0xff) << 16)) | idx) >>> 0;
    let mesh: THREE.Object3D | null = null;
    try { mesh = this.deps.envCells.createCellMesh(cellId); } catch (err) {
      this.deps.warn.warn(`EnvCell 0x${cellId.toString(16)} failed to build`, err);
    }
    if (!mesh) return null;
    mesh.visible = block.cells!.stabSet.has(idx);
    this.deps.addToScene(mesh);
    this.deps.staticScripts?.attach(mesh);
    block.objects.push(mesh);
    block.raycastMeshes.push(mesh);
    block.cells!.meshes.set(idx, mesh);
    this._cellMeshesBuilt++;
    return mesh;
  }

  /** Add one per-object mesh (or script anchor) a block owns to the scene. */
  private placeScriptedObject(block: ObjectBlock, obj: THREE.Object3D): void {
    this.deps.addToScene(obj);
    block.objects.push(obj);
    this.deps.staticScripts?.attach(obj);
  }

  /**
   * SWEEP1006B — a scenery placement whose Setup has a DefaultAnimation is
   * built per-object at its placement matrix and tagged for the
   * StaticAnimationDriver; false = it stays an instanced pool entry.
   * SOUND.scenery-default-scripts — get_land_scenes → makeObject →
   * InitDefaults @ 005139d0 also plays the Setup's DefaultScript (particles,
   * and a few SoundTweaked loops): the per-object mesh carries it, an
   * instanced one gets a transform-only anchor at its frame (as the batched
   * LandBlockInfo statics do).
   */
  private placeAnimatedScenery(block: ObjectBlock, entry: InstanceEntry): boolean {
    const d = this.deps;
    if (((entry.objId >> 24) & 0xff) !== PortalFileType.Setup) return false;
    const setup = d.setupModels.loadSetupModel(entry.objId);
    const animId = setup?.defaultAnimation ?? 0;
    const scriptId = setup?.defaultScript ?? 0;
    if (!animId) {
      if (scriptId) {
        const anchor = new THREE.Object3D();
        anchor.name = `scenery_script_${(entry.objId >>> 0).toString(16)}`;
        entry.matrix.decompose(anchor.position, anchor.quaternion, anchor.scale);
        tagStaticScriptAnchor(anchor, entry.objId, scriptId);
        this.placeScriptedObject(block, anchor);
      }
      return false;
    }
    let obj: THREE.Group | null = null;
    try { obj = d.setupModels.createSetupMesh(entry.objId); } catch (err) {
      d.warn.warn(`scenery 0x${(entry.objId >>> 0).toString(16)} in block 0x${block.key.toString(16)} failed to build`, err);
    }
    if (!obj) return false;
    obj.userData[DegradeLod.LAND_CELL_KEY] = true;
    entry.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    tagStaticDefaultAnimation(obj, entry.objId, animId);
    if (scriptId) tagStaticScriptAnchor(obj, entry.objId, scriptId);
    this.placeScriptedObject(block, obj);
    return true;
  }

  /** Remove + dispose one per-object mesh a block owns. */
  private dropObject(block: ObjectBlock, obj: THREE.Object3D): void {
    this.deps.staticScripts?.detach(obj);
    this.deps.removeFromScene(obj);
    // REND.shared-cached-material-disposed-faded — only owned materials go.
    disposeObjectTree(obj);
    block.suppressed.delete(obj);
    const oi = block.objects.indexOf(obj);
    if (oi >= 0) block.objects.splice(oi, 1);
    const ri = block.raycastMeshes.indexOf(obj);
    if (ri >= 0) block.raycastMeshes.splice(ri, 1);
  }

  /**
   * CORE.14.b.1 — world-space (AC coords) doorway polygons for one
   * building, keyed by CBldPortal index. Retail PView::DrawPortal
   * (@ 005a5ab0) maps each CPortalPoly in the building model's drawing BSP
   * to outdoor_portal_list[portal_index] — the building's CBldPortal at
   * that index. Validated against EoL cell.dat 2026-09-04: every
   * Holtburg/Cragstone building's BSP portal polys ↔ its CBldPortals 1:1
   * (indices 0..N-1, all polygonId lookups resolve). Any resolution
   * failure only leaves the affected portal's gate always open.
   */
  private resolveBuildingGatePolys(
    building: LandblockInfo['buildings'][number],
    worldOffsetX: number,
    worldOffsetZ: number,
  ): { gatePolys: Map<number, ACVec3[][]>; punchPolys: Map<number, ACVec3[][]> } {
    const out = new Map<number, ACVec3[][]>();
    const punch = new Map<number, ACVec3[][]>();
    const result = { gatePolys: out, punchPolys: punch };
    try {
      const highByte = (building.modelId >> 24) & 0xff;
      const parts: { gfxId: number; frame: { origin: ACVec3; orientation: { w: number; x: number; y: number; z: number } } | null }[] = [];
      if (highByte === PortalFileType.Setup) {
        const setup = this.deps.setupModels.loadSetupModel(building.modelId);
        if (!setup) return result;
        const placement = placementFrameOf(setup);
        for (let pi = 0; pi < setup.parts.length; pi++) {
          parts.push({ gfxId: setup.parts[pi], frame: placement?.frames[pi] ?? null });
        }
      } else if (highByte === PortalFileType.GraphicsObject) {
        parts.push({ gfxId: building.modelId, frame: null });
      }
      const bldgOrigin = building.frame.origin;
      const bldgQuat = building.frame.orientation;
      for (const part of parts) {
        const gfx = this.deps.models.loadGfxObj(part.gfxId);
        if (!gfx?.drawingBSP || !gfx.vertexArray) continue;
        let origin = bldgOrigin;
        let quat = bldgQuat;
        if (part.frame) {
          const composed = DungeonCollision.composeFrames(
            bldgOrigin, bldgQuat, part.frame.origin, part.frame.orientation);
          origin = composed.origin;
          quat = composed.orientation;
        }
        for (const ref of collectDrawingPortalPolys(gfx.drawingBSP.rootNode)) {
          if (ref.portalIndex < 0 || ref.portalIndex >= building.portals.length) continue;
          const poly = gfx.polygonMap.get(ref.polygonId);
          if (!poly) continue;
          const verts: ACVec3[] = [];
          for (const vi of poly.vertexIndices) {
            const v = gfx.vertexArray.vertices.get(vi);
            if (!v) { verts.length = 0; break; }
            const w = DungeonCollision.composeFrames(origin, quat, v.origin, GATE_IDENTITY_QUAT).origin;
            verts.push({ x: worldOffsetX + w.x, y: worldOffsetZ + w.y, z: w.z });
          }
          if (verts.length < 3) continue;
          const list = out.get(ref.portalIndex);
          if (list) list.push(verts);
          else out.set(ref.portalIndex, [verts]);
          // DrawPortalPolyInternal's edge guard reads the part-local vertices.
          const local = poly.vertexIndices.map(vi => gfx.vertexArray!.vertices.get(vi)!.origin);
          if (retailPortalPunchDrawn(local)) {
            const pl = punch.get(ref.portalIndex);
            if (pl) pl.push(verts);
            else punch.set(ref.portalIndex, [verts]);
          }
        }
      }
    } catch (err) {
      // Leave unresolved portals always open.
      this.deps.warn.warn(`building 0x${(building.modelId >>> 0).toString(16)} doorway gates unresolved`, err);
    }
    return result;
  }

  /**
   * REND.landblock-streaming-one-frame — a landblock's objects built as
   * resumable steps: the generator yields after each unit of work (a static
   * object, an interior cell, a building, the scenery), so the streaming
   * scheduler (LandblockLoadScheduler) can spread a row crossing over frames
   * under a time budget. Draining it in one go (loadNow) is the synchronous
   * load — the end state is identical either way.
   */
  *loadSteps(blockX: number, blockY: number): Generator<void, void, void> {
    const d = this.deps;
    const infoId = (((blockX & 0xff) << 24) | ((blockY & 0xff) << 16) | 0xfffe) >>> 0;
    if (this.loadedObjectBlocks.has(infoId)) return;
    this.loadedObjectBlocks.add(infoId);

    const blockKey = keyOf(blockX, blockY);
    const block: ObjectBlock = {
      key: blockKey, bx: blockX, by: blockY, shown: false,
      objects: [], suppressed: new Set(), raycastMeshes: [],
      staticEntries: [], buildingEntries: [], sceneryEntries: null,
      collisionKeys: [], cells: null, demandCells: new Set(), numCells: 0,
    };

    // A block without a LandblockInfo (CLandBlock::lbi_exists == 0) still
    // has its landscape scenery.
    const infoData = d.cellDb.getFileData(infoId);
    let info: LandblockInfo | null = null;
    if (infoData) {
      try { info = new LandblockInfo(new DatReader(infoData)); }
      catch (err) {
        d.warn.warn(`LandblockInfo 0x${infoId.toString(16)} unreadable — block has no statics/buildings`, err);
      }
    }
    if (info) yield* this.loadInfoSteps(block, info);

    // PERF.5 — the block's landscape scenery rides the same full-detail ring
    // (CLandBlock::init_static_objs → get_land_scenes).
    if (d.buildScenery) {
      try {
        const scenery = d.buildScenery(blockX, blockY);
        if (scenery) {
          // SWEEP1006B — scenery whose Setup has a DefaultAnimation loops it
          // (get_land_scenes → makeObject → InitDefaults): per-object.
          block.sceneryEntries = scenery.entries.filter(e => !this.placeAnimatedScenery(block, e));
          block.collisionKeys.push(...scenery.collisionKeys);
        }
      } catch (err) {
        d.warn.warn(`scenery for block 0x${blockKey.toString(16)} failed`, err);
      }
    }

    this.blocks.set(blockKey, block);
    this.loadedBuildingMeshes.set(blockKey, block.raycastMeshes);
    if (block.raycastMeshes.length > 0) d.onCollisionMeshesChanged();
    // Joins the pools / surface registry when inside the ring; otherwise
    // stays built but hidden (prefetch / hysteresis band).
    this.setBlockShown(block, this.inRing(blockX, blockY));
  }

  /** The LandblockInfo content of one block: statics, interior cells, buildings. */
  private *loadInfoSteps(block: ObjectBlock, info: LandblockInfo): Generator<void, void, void> {
    const d = this.deps;
    const { key: blockKey, bx: blockX, by: blockY } = block;
    block.numCells = info.numCells;
    const bspKeys = block.collisionKeys;

    const worldOffsetX = blockX * 192;
    const worldOffsetZ = blockY * 192;

    // CORE.14.a — landblock statics (wells, fences, carts, furniture) batch
    // through the same instancer as scenery: one InstancedMesh per (GfxObj,
    // submesh) instead of one Mesh per SetupModel part. The instance
    // matrices are the exact transforms the un-batched path applied (same
    // AC Z-up → three Y-up quaternion swap at the exact DAT frame).
    // Collision still runs per object.
    for (let oi = 0; oi < info.objects.length; oi++) {
      const stab = info.objects[oi];
      if (!stab.id) continue;
      const highByte = (stab.id >> 24) & 0xff;
      const pos = stab.frame.origin;
      const rot = stab.frame.orientation;
      // SWEEP1006B — a Setup with a DefaultAnimation loops it, so its parts
      // move: per-object, never instanced (StaticAnimationDriver).
      const defaultAnim = highByte === PortalFileType.Setup
        ? (d.setupModels.loadSetupModel(stab.id)?.defaultAnimation ?? 0) : 0;
      if (!defaultAnim && d.instancer.hasModel(stab.id)) {
        // VISUAL.holtburg-roof-plank — at the exact DAT frame, as ACE's
        // CLandBlock init_static_objs places it (and as collision does).
        block.staticEntries.push({
          objId: stab.id,
          matrix: new THREE.Matrix4().compose(
            new THREE.Vector3(worldOffsetX + pos.x, pos.z, worldOffsetZ + pos.y),
            new THREE.Quaternion(-rot.x, -rot.z, -rot.y, rot.w),
            new THREE.Vector3(1, 1, 1),
          ),
        });
        // VISUAL.dat-static-default-scripts — the batched static's DefaultScript
        // plays on a transform-only anchor at its drawn frame.
        if (highByte === PortalFileType.Setup) {
          const scriptId = d.setupModels.loadSetupModel(stab.id)?.defaultScript ?? 0;
          if (scriptId) {
            const anchor = new THREE.Object3D();
            anchor.name = `static_script_${(stab.id >>> 0).toString(16)}`;
            block.staticEntries[block.staticEntries.length - 1].matrix.decompose(anchor.position, anchor.quaternion, anchor.scale);
            tagStaticScriptAnchor(anchor, stab.id, scriptId);
            this.placeScriptedObject(block, anchor);
          }
        }
      } else {
        // Fallback per-object path for models the instancer cannot resolve.
        let obj: THREE.Group | null = null;
        if (highByte === PortalFileType.Setup) {
          try { obj = d.setupModels.createSetupMesh(stab.id); } catch (err) {
            d.warn.warn(`static 0x${(stab.id >>> 0).toString(16)} in block 0x${blockKey.toString(16)} failed to build`, err);
          }
        } else if (highByte === PortalFileType.GraphicsObject) {
          try { obj = d.models.createMesh(stab.id); } catch (err) {
            d.warn.warn(`static 0x${(stab.id >>> 0).toString(16)} in block 0x${blockKey.toString(16)} failed to build`, err);
          }
          // CORE.17.h.g.c.c.a — a bare-GfxObj static is a one-part object.
          if (obj) d.degradeLod.attachPart(obj, stab.id, id => d.models.createMesh(id), obj);
        }
        if (!obj) continue;
        // CORE.17.h.g.c.c.c — a landblock stab lives in a land cell.
        obj.userData[DegradeLod.LAND_CELL_KEY] = true;
        obj.position.set(worldOffsetX + pos.x, pos.z, worldOffsetZ + pos.y);
        obj.quaternion.set(-rot.x, -rot.z, -rot.y, rot.w);
        if (highByte === PortalFileType.Setup) {
          const scriptId = d.setupModels.loadSetupModel(stab.id)?.defaultScript ?? 0;
          if (scriptId) tagStaticScriptAnchor(obj, stab.id, scriptId);
          if (defaultAnim) tagStaticDefaultAnimation(obj, stab.id, defaultAnim);
        }
        this.placeScriptedObject(block, obj);
      }
      this._totalModelsPlaced++;

      // A landblock stab is a static CPhysicsObj: its collision is ACE
      // PhysicsObj.FindObjCollisions' rule (ObjectCollision.ts) — part BSPs
      // (each part at its placement frame, like the building loop below),
      // else the Setup's CylSpheres, else its Spheres, else none.
      const stabModel = d.objectPhysics(stab.id);
      if (stabModel) {
        try {
          bspKeys.push(...addObjectCollision(
            d.collision, (kind, i) => collisionKey.landblockStatic(blockKey, oi, kind, i), stabModel,
            { x: pos.x, y: pos.y, z: pos.z }, { w: rot.w, x: rot.x, y: rot.y, z: rot.z }, 1,
            worldOffsetX, worldOffsetZ,
          ));
        } catch (err) {
          d.warn.warn(`static 0x${(stab.id >>> 0).toString(16)} collision in block 0x${blockKey.toString(16)} failed`, err);
        }
      }
      yield;
    }

    // Interior cells. CORE.14.b — outdoors, only the cells the landblock's
    // building portals reference (CLandBlock::init_buildings builds its
    // stablist exclusively from CBldPortal otherCellId + stabList — the
    // through-the-door visible set) can draw; deeper rooms and under-terrain
    // dungeon complexes sharing the landblock draw only when the player is
    // inside (current cell + VisibleCells PVS, retail CObjCell::draw_visible,
    // main.ts updateSurfaceCellVisibility). PERF.3 — so only the stab cells'
    // render meshes are built here; the rest are built on PVS demand
    // (ensureSurfaceCells). Collision (cell BSP + cell statics) registers for
    // every cell a walking player can reach from those doorways.
    const prefix = (((blockX & 0xff) << 24) | ((blockY & 0xff) << 16)) >>> 0;
    const stabSet = collectBuildingStabCells(info.buildings, info.numCells);
    if (info.numCells > 0) {
      // CORE.14.b.1 — per-portal doorway gates, built for EVERY building
      // (even ones whose exterior mesh later fails to load) so no portal's
      // stab cells are orphaned. Union of gate cells === stabSet.
      const blockGates: BuildingGate[] = [];
      for (const building of info.buildings) {
        const { gatePolys, punchPolys } = this.resolveBuildingGatePolys(building, worldOffsetX, worldOffsetZ);
        blockGates.push(...buildBuildingGates(building.portals, gatePolys, info.numCells, (portalIndex) => {
          // VISUAL.landblock-statics-missing-vs-retail — the portal punch
          // that keeps terrain off the doorway / pit opening (PortalPunch.ts).
          const polys = punchPolys.get(portalIndex);
          const mesh = polys ? createPortalPunch(polys) : null;
          if (mesh) {
            d.addToScene(mesh);
            block.objects.push(mesh);
          }
          return mesh;
        }));
      }
      block.cells = { meshes: new Map(), stabSet, gates: blockGates };

      const envCache = new Map<number, Pick<EnvCell, 'staticObjects' | 'cellPortals'> | null>();
      const envOf = (idx: number): Pick<EnvCell, 'staticObjects' | 'cellPortals'> | null => {
        let env = envCache.get(idx);
        if (env === undefined) {
          try { env = d.envCells.loadEnvCell((prefix | idx) >>> 0); } catch (err) {
            env = null;
            d.warn.warn(`EnvCell 0x${((prefix | idx) >>> 0).toString(16)} unreadable`, err);
          }
          envCache.set(idx, env);
        }
        return env;
      };
      const walkable = collectWalkableCells(stabSet, info.numCells, idx => envOf(idx)?.cellPortals);
      for (const idx of [...walkable].sort((a, b) => a - b)) {
        const cellId = (prefix | idx) >>> 0;
        if (stabSet.has(idx)) this.buildCellMesh(block, idx);
        try {
          // Register cell BSP with outdoor collision for floor detection (stairs in surface buildings)
          const collData = d.envCells.getCellCollisionData(cellId);
          if (collData) {
            d.collision.addCell(cellId, collData.cellStruct, collData.position);
            bspKeys.push(cellId);
          }
          // Also register interior cell static objects (furniture, columns, etc.)
          // so the player cannot clip through them when inside a surface building
          // — the same FindObjCollisions rule as every other static object.
          const envCell = envOf(idx);
          if (envCell) {
            for (let si = 0; si < envCell.staticObjects.length; si++) {
              const stab = envCell.staticObjects[si];
              const model = d.objectPhysics(stab.id);
              if (!model) continue;
              try {
                bspKeys.push(...addObjectCollision(
                  d.collision, (kind, i) => collisionKey.cellStatic(cellId, si, kind, i), model,
                  stab.frame.origin, stab.frame.orientation, 1, worldOffsetX, worldOffsetZ,
                ));
              } catch (err) {
                d.warn.warn(`cell static 0x${(stab.id >>> 0).toString(16)} collision in 0x${cellId.toString(16)} failed`, err);
              }
            }
          }
        } catch (err) {
          d.warn.warn(`EnvCell 0x${cellId.toString(16)} failed to build`, err);
        }
        yield;
      }
    }

    // PERF.1 (part-bucket slice) — building exteriors join the cross-landblock
    // instancing pool: one InstancedMesh per distinct (GfxObj, submesh) across
    // ALL shown buildings. The matrix is the exact position/quaternion the
    // per-object path applied, geometry and materials are the same shared
    // templates, and the shell bbox is computed from the same templates +
    // matrices Box3.setFromObject measured. Sealed interiors hide the pool
    // wholesale (setLandscapeVisible).
    for (let bi = 0; bi < info.buildings.length; bi++) {
      const building = info.buildings[bi];
      if (!building.modelId) continue;
      const highByte = (building.modelId >> 24) & 0xff;
      const pos = building.frame.origin;
      const rot = building.frame.orientation;
      let obj: THREE.Group | null = null;
      let pooledBBox: THREE.Box3 | null = null;
      const bldgInstancer = d.buildingInstancer ?? d.instancer;
      if (bldgInstancer.hasModel(building.modelId)) {
        const worldMatrix = new THREE.Matrix4().compose(
          new THREE.Vector3(worldOffsetX + pos.x, pos.z, worldOffsetZ + pos.y),
          new THREE.Quaternion(-rot.x, -rot.z, -rot.y, rot.w),
          new THREE.Vector3(1, 1, 1),
        );
        pooledBBox = bldgInstancer.getWorldBBox(building.modelId, worldMatrix);
        if (pooledBBox) block.buildingEntries.push({ objId: building.modelId, matrix: worldMatrix });
      }
      if (!pooledBBox) {
        // Fallback per-object path for models the instancer cannot resolve.
        if (highByte === PortalFileType.Setup) {
          try { obj = d.setupModels.createSetupMesh(building.modelId, PLACEMENT_RESTING, true); } catch (err) {
            d.warn.warn(`building 0x${(building.modelId >>> 0).toString(16)} in block 0x${blockKey.toString(16)} failed to build`, err);
          }
        } else if (highByte === PortalFileType.GraphicsObject) {
          try { obj = d.models.createMesh(building.modelId, undefined, undefined, true); } catch (err) {
            d.warn.warn(`building 0x${(building.modelId >>> 0).toString(16)} in block 0x${blockKey.toString(16)} failed to build`, err);
          }
          // CORE.17.h.g.c.c.a — a bare-GfxObj building is a one-part object.
          if (obj) d.degradeLod.attachPart(obj, building.modelId, id => d.models.createMesh(id, undefined, undefined, true), obj);
        }
        if (!obj) continue;
        obj.userData[DegradeLod.LAND_CELL_KEY] = true;
        obj.position.set(worldOffsetX + pos.x, pos.z, worldOffsetZ + pos.y);
        obj.quaternion.set(-rot.x, -rot.z, -rot.y, rot.w);
        d.addToScene(obj);
        block.objects.push(obj);
        block.raycastMeshes.push(obj);
      }

      // Add building exterior's GfxObj physics BSPs to outdoor collision
      // (BuildingObj.find_building_collisions); part frames are composed
      // exactly like every other static object (ObjectCollision.addObjectCollision).
      const bldgModel = d.objectPhysics(building.modelId);
      if (bldgModel) {
        try {
          bspKeys.push(...addObjectCollision(
            d.collision, (kind, i) => collisionKey.building(blockKey, bi, kind, i), bldgModel,
            { x: pos.x, y: pos.y, z: pos.z }, { w: rot.w, x: rot.x, y: rot.y, z: rot.z }, 1,
            worldOffsetX, worldOffsetZ, { building: true },
          ));
        } catch (err) {
          d.warn.warn(`building 0x${(building.modelId >>> 0).toString(16)} collision in block 0x${blockKey.toString(16)} failed`, err);
        }
      }

      // Track the building footprint for the walk-in gate + isIndoors HUD
      // state (the bbox only gates when the containment scan needs to run).
      let bbox: THREE.Box3;
      if (pooledBBox) {
        bbox = pooledBBox;
      } else {
        obj!.updateMatrixWorld(true);
        bbox = new THREE.Box3().setFromObject(obj!);
      }
      // Expanded bbox for hysteresis: slightly larger for "enter" detection,
      // actual bbox for "exit" detection. Prevents flickering at boundaries.
      const enterBbox = bbox.clone().expandByVector(new THREE.Vector3(1.5, 0, 1.5));
      this.buildingShells.push({ blockKey, bbox, enterBbox, wasInside: false });
      this._totalModelsPlaced++;
      yield;
    }
  }

  /** Blocks unloaded so far (PERF.browser-memory-crash — the resource sweep runs after unloads). */
  unloadedBlockCount = 0;

  /** Unload objects from landblocks beyond the unload radius. */
  unloadDistant(centerBlockX: number, centerBlockY: number): void {
    const r = this.unloadRadius;
    for (const [blockKey, block] of this.blocks) {
      if (Math.abs(block.bx - centerBlockX) <= r && Math.abs(block.by - centerBlockY) <= r) continue;
      this.unloadBlock(blockKey, block);
    }
  }

  /** Retire one loaded block: its objects, shells, collision and raycast meshes. */
  private unloadBlock(blockKey: number, block: ObjectBlock): void {
    const d = this.deps;
    this.setBlockShown(block, false);
    for (const obj of [...block.objects]) this.dropObject(block, obj);
    // Remove tracked building shells for this block (pooled shells have
    // no live exterior mesh, so retire by owning block key).
    for (let i = this.buildingShells.length - 1; i >= 0; i--) {
      if (this.buildingShells[i].blockKey === blockKey) this.buildingShells.splice(i, 1);
    }
    // Every collision key the block registered (statics, cells, buildings, scenery).
    for (const key of block.collisionKeys) d.collision.removeKey(key);
    this.blocks.delete(blockKey);
    this.unloadedBlockCount++;
    if (this.loadedBuildingMeshes.delete(blockKey)) d.onCollisionMeshesChanged();
    this.loadedObjectBlocks.delete((((block.bx & 0xff) << 24) | ((block.by & 0xff) << 16) | 0xfffe) >>> 0);
  }
}
