import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import type { EnvCellRenderer } from './EnvCellRenderer.js';
import { landblockX, landblockY } from '@ac/shared';
import { disposeObjectTree } from '../models/MaterialOwnership.js';
import { datMissEpoch, noDatMissSince, onDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';

/** Cell origin in AC coords (before Y/Z swap), cached for proximity checks. */
interface CellInfo {
  cellId: number;
  x: number;  // AC x
  y: number;  // AC y (north)
  z: number;  // AC z (up)
}

/**
 * DungeonRenderer — renders complete dungeons by loading and assembling
 * EnvCells within a landblock's interior space.
 *
 * Supports proximity-based streaming: only cells near the player are loaded.
 * As the player moves, nearby cells are loaded and distant ones unloaded.
 */
export class DungeonRenderer {
  private cellDb: DatDatabase;
  private envCellRenderer: EnvCellRenderer;
  private loadedDungeons = new Map<number, THREE.Group>();

  /** All cell origins for the active dungeon (for proximity lookup). */
  private cellInfos: CellInfo[] = [];
  /** Which cells are currently loaded as meshes. */
  private loadedCellMeshes = new Map<number, THREE.Group>();
  /** The parent group for the active streamed dungeon. */
  private streamGroup: THREE.Group | null = null;
  /** Landblock world offset for proximity checks (AC coords). */
  private streamOffsetX = 0;
  private streamOffsetY = 0;
  /**
   * RELEASE.dat-streaming — cells of the active dungeon whose EnvCell missed
   * at the pre-scan (re-scanned by updateStream until they arrive), and
   * streamed cell meshes built across a miss (rebuilt once files land).
   * Retail's DBObj::Get blocks until the file is local; without these a
   * missed cell stayed undrawn, or untextured, for the whole stay.
   */
  private unscannedCellIds: number[] = [];
  private incompleteCells = new Set<number>();
  private stopMissListener: (() => void) | null = null;

  /** Radius (AC units) within which cells are loaded. */
  static readonly LOAD_RADIUS = 80;
  /** Radius beyond which cells are unloaded. */
  static readonly UNLOAD_RADIUS = 120;

  /**
   * VISUAL.dat-static-default-scripts — streamed cells' statics start their
   * Setup DefaultScript when the cell joins the stream and stop when it is
   * disposed (main.ts StaticScriptDriver).
   */
  staticScripts: { attach(root: THREE.Object3D): void; detach(root: THREE.Object3D): void } | null = null;

  constructor(cellDb: DatDatabase, envCellRenderer: EnvCellRenderer) {
    this.cellDb = cellDb;
    this.envCellRenderer = envCellRenderer;
  }

  /**
   * Load a LandblockInfo from cell.dat (0xXXYYFFFE).
   */
  loadLandblockInfo(landblockId: number): LandblockInfo | null {
    // LandblockInfo ID = landblock high bytes + 0xFFFE
    const infoId = (landblockId & 0xFFFF0000) | 0xFFFE;
    const data = this.cellDb.getFileData(infoId);
    if (!data) return null;
    return new LandblockInfo(new DatReader(data));
  }

  /**
   * Find all interior cell IDs for a landblock.
   * Interior cells range from 0xXXYY0100 to 0xXXYYFEFF.
   */
  findInteriorCells(landblockId: number): number[] {
    const prefix = landblockId & 0xFFFF0000;
    const cells: number[] = [];

    // Use LandblockInfo.numCells to know how many to expect. Without it
    // (a streamed miss), scan the whole interior range rather than guess:
    // hasFile is a directory / manifest lookup, and a guessed 200 cut big
    // dungeons short.
    const info = this.loadLandblockInfo(landblockId);
    const maxCells = info ? info.numCells : 0xFFFE - 0x0100;

    // Interior cell IDs start at 0x0100, matching ACViewer's R_Landblock.BuildEnvCells()
    for (let i = 0; i < maxCells; i++) {
      const cellId = (prefix | (0x0100 + i)) >>> 0;
      if (this.cellDb.hasFile(cellId)) {
        cells.push(cellId);
      }
    }

    return cells;
  }

  /**
   * Render all interior cells of a dungeon landblock into a single Three.js Group.
   */
  createDungeon(landblockId: number): THREE.Group | null {
    const cached = this.loadedDungeons.get(landblockId);
    if (cached) return cached;

    const cellIds = this.findInteriorCells(landblockId);
    if (cellIds.length === 0) return null;

    const group = new THREE.Group();
    group.name = `dungeon_${(landblockId >>> 16).toString(16).padStart(4, '0')}`;

    for (const cellId of cellIds) {
      const cellMesh = this.envCellRenderer.createCellMesh(cellId);
      if (cellMesh) {
        group.add(cellMesh);
      }
    }

    if (group.children.length === 0) return null;

    this.loadedDungeons.set(landblockId, group);
    return group;
  }

  /**
   * Initialize streaming for a dungeon. Pre-scans all cell origins
   * and returns a Group that will be populated by updateStream().
   */
  initStream(landblockId: number): THREE.Group | null {
    const cellIds = this.findInteriorCells(landblockId);
    if (cellIds.length === 0) return null;

    this.streamOffsetX = landblockX(landblockId) * 192;
    this.streamOffsetY = landblockY(landblockId) * 192;

    // Pre-scan all cell origins (fast — just parses position, doesn't build geometry)
    this.cellInfos = [];
    this.unscannedCellIds = [];
    this.incompleteCells.clear();
    this.scanCells(cellIds);

    this.streamGroup = new THREE.Group();
    this.streamGroup.name = `dungeon_stream_${(landblockId >>> 16).toString(16).padStart(4, '0')}`;
    // ASSESS: dispose cells left over from a previous dungeon — clear() alone
    // leaked their geometry + cloned materials on every dungeon switch.
    for (const mesh of this.loadedCellMeshes.values()) {
      this.disposeCellMesh(mesh);
    }
    this.loadedCellMeshes.clear();

    console.log(`[AC] Dungeon stream init: ${this.cellInfos.length} cells indexed for landblock 0x${(landblockId >>> 16).toString(16)}`);
    return this.streamGroup;
  }

  /**
   * Update streamed dungeon cells based on player position.
   * Loads nearby cells, unloads distant ones. Call each frame or on movement.
   * @param playerLocalX Player X in AC landblock-local coords
   * @param playerLocalY Player Y in AC landblock-local coords (north)
   */
  updateStream(playerLocalX: number, playerLocalY: number): void {
    if (!this.streamGroup) return;
    if (this.unscannedCellIds.length > 0) {
      const pending = this.unscannedCellIds;
      this.unscannedCellIds = [];
      this.scanCells(pending);
    }

    const loadR2 = DungeonRenderer.LOAD_RADIUS * DungeonRenderer.LOAD_RADIUS;
    const unloadR2 = DungeonRenderer.UNLOAD_RADIUS * DungeonRenderer.UNLOAD_RADIUS;

    // Load nearby cells
    for (const info of this.cellInfos) {
      if (this.loadedCellMeshes.has(info.cellId)) continue;
      const dx = info.x - playerLocalX;
      const dy = info.y - playerLocalY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= loadR2) {
        const epoch = datMissEpoch();
        const mesh = this.envCellRenderer.createCellMesh(info.cellId);
        if (mesh) {
          this.streamGroup.add(mesh);
          this.loadedCellMeshes.set(info.cellId, mesh);
          this.staticScripts?.attach(mesh);
          if (!noDatMissSince(epoch)) this.markIncomplete(info.cellId);
        }
      }
    }

    // Unload distant cells
    for (const [cellId, mesh] of this.loadedCellMeshes) {
      const info = this.cellInfos.find(c => c.cellId === cellId);
      if (!info) continue;
      const dx = info.x - playerLocalX;
      const dy = info.y - playerLocalY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > unloadR2) {
        this.streamGroup.remove(mesh);
        this.disposeCellMesh(mesh);
        this.loadedCellMeshes.delete(cellId);
      }
    }

  }

  /**
   * ASSESS: dispose a streamed cell's GPU resources with correct ownership:
   * geometry is always per-mesh (dispose it); the cell-geometry materials
   * are per-cell clones (EnvCellRenderer buildCellGeometry `.clone()`) and
   * are freed, while static-object meshes (torches/furniture) draw SHARED
   * MaterialFactory-cached materials that must survive (disposing them
   * forced a shader/program re-init for every other live mesh sharing it).
   * PERF.1 instanced furniture batches free only their instance buffer.
   * REND.shared-cached-material-disposed-faded — the one ownership rule
   * (MaterialOwnership.disposeObjectTree) every dispose path now shares.
   */
  private disposeCellMesh(root: THREE.Object3D): void {
    this.staticScripts?.detach(root);
    disposeObjectTree(root);
  }

  /** Parse each cell's origin; a cell whose EnvCell is not resident yet waits for the next update. */
  private scanCells(cellIds: number[]): void {
    for (const cellId of cellIds) {
      const envCell = this.envCellRenderer.loadEnvCell(cellId);
      if (envCell) {
        this.cellInfos.push({
          cellId,
          x: envCell.position.origin.x,
          y: envCell.position.origin.y,
          z: envCell.position.origin.z,
        });
      } else if (this.cellDb.hasFile(cellId)) {
        this.unscannedCellIds.push(cellId);
      }
    }
  }

  /** A streamed cell mesh missed files: drop it once they land so updateStream builds it whole. */
  private markIncomplete(cellId: number): void {
    this.incompleteCells.add(cellId);
    this.stopMissListener ??= onDatMissResolved(() => {
      for (const id of this.incompleteCells) {
        const mesh = this.loadedCellMeshes.get(id);
        if (!mesh) continue;
        this.streamGroup?.remove(mesh);
        this.disposeCellMesh(mesh);
        this.loadedCellMeshes.delete(id);
      }
      this.incompleteCells.clear();
      this.stopMissListener?.();
      this.stopMissListener = null;
    });
  }

  /** Number of currently loaded cells in the stream. */
  get streamCellCount(): number {
    return this.loadedCellMeshes.size;
  }

  /**
   * GAP.2 (culling half) — retail portal-graph visibility: each EnvCell
   * carries a precomputed VisibleCells list (the PVS the original engine
   * both rendered and searched — ACE EnvCell.cs VisibleCells /
   * find_visible_child_cell). With the player's live cell known (BUG.10),
   * only that cell + its VisibleCells render; everything else in the
   * stream radius is hidden.
   *
   * Conservative fallbacks keep the world visible rather than wrongly
   * hidden: an unknown current cell (0 — mid-portal or out-of-bounds) or
   * an unloadable EnvCell shows every streamed cell.
   */
  applyPortalVisibility(currentCellId: number): void {
    if (!this.streamGroup) return;
    let pvs: Set<number> | null = null;
    if (currentCellId) {
      const env = this.envCellRenderer.loadEnvCell(currentCellId);
      if (env) pvs = new Set(env.visibleCells);
    }
    const curIdx = currentCellId & 0xffff;
    for (const [cellId, mesh] of this.loadedCellMeshes) {
      const idx = cellId & 0xffff;
      mesh.visible = pvs === null || idx === curIdx || pvs.has(idx);
    }
  }

  /**
   * DECOMP.interior-objects-culled — whether a streamed cell draws this
   * frame (applyPortalVisibility's result); undefined when the cell is not
   * streamed. Objects in the cell draw with it (`PView::DrawCells` @
   * 005a4840).
   */
  isCellDrawn(cellId: number): boolean | undefined {
    return this.loadedCellMeshes.get(cellId >>> 0)?.visible;
  }

  /** Get the landblock-local coords for proximity checks from world coords. */
  worldToLocal(worldX: number, worldZ: number): { localX: number; localY: number } {
    return {
      localX: worldX - this.streamOffsetX,
      localY: worldZ - this.streamOffsetY,
    };
  }

  /**
   * Get portal connections for a specific interior cell.
   * Returns an array of connected cell IDs.
   */
  getCellPortalConnections(cellId: number): number[] {
    const envCell = this.envCellRenderer.loadEnvCell(cellId);
    if (!envCell) return [];

    const prefix = cellId & 0xFFFF0000;
    return envCell.cellPortals.map(portal => (prefix | portal.otherCellId) >>> 0);
  }

  /**
   * Check if a landblock has interior cells (is a dungeon).
   */
  hasDungeon(landblockId: number): boolean {
    const info = this.loadLandblockInfo(landblockId);
    return info !== null && info.numCells > 0;
  }

  /**
   * Get the number of cached dungeon renders.
   */
  get cacheSize(): number {
    return this.loadedDungeons.size;
  }

  /**
   * Clear all cached dungeon data.
   */
  clear(): void {
    this.loadedDungeons.clear();
    this.cellInfos = [];
    // ASSESS: dispose streamed cells on teardown (was a silent drop)
    for (const mesh of this.loadedCellMeshes.values()) {
      this.disposeCellMesh(mesh);
    }
    this.loadedCellMeshes.clear();
    this.streamGroup = null;
  }
}
