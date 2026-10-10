import { LandblockMesh } from './LandblockMesh.js';

/**
 * TerrainManager — manages loading/unloading of terrain landblocks
 * around the camera position.
 *
 * Each landblock covers 192m × 192m in world space.
 * World position: x = blockX * 192, z = blockY * 192
 * where blockX = (landblockId >> 24) & 0xFF, blockY = (landblockId >> 16) & 0xFF
 */
export interface TerrainManagerConfig {
  /** How many landblocks to load around the camera in each direction (default: 2 = 5×5 grid) */
  loadRadius?: number;
  /** LandHeightTable from RegionDesc for accurate terrain heights */
  landHeightTable?: Float32Array;
}

export interface CellLandblockData {
  heights: number[];
  terrain?: number[];
}

export interface DatDatabaseLike {
  hasFile(fileId: number): boolean;
  getReader(fileId: number): any;
}

export interface CellLandblockReader {
  read(reader: any): CellLandblockData;
}

export class TerrainManager {
  private loadRadius: number;
  private loadedBlocks: Map<number, LandblockMesh> = new Map();
  private cellDb: DatDatabaseLike | null = null;
  private landblockReader: CellLandblockReader | null = null;
  private landHeightTable: Float32Array | undefined;

  constructor(config?: TerrainManagerConfig) {
    this.loadRadius = config?.loadRadius ?? 2;
    this.landHeightTable = config?.landHeightTable;
  }

  /** Set the land height table (from RegionDesc) for accurate terrain heights */
  setLandHeightTable(table: Float32Array): void {
    this.landHeightTable = table;
  }

  /** Current radius in landblocks (the grid is (2R+1)² blocks — LScape::mid_width). */
  getLoadRadius(): number {
    return this.loadRadius;
  }

  /**
   * CORE.17.h.g.a — resize the streamed grid (retail LScape::SetMidRadius @
   * 00504c00: only a positive radius is accepted; mid_width = 2R + 1). The
   * next update() loads the blocks a larger window now needs and unloads the
   * ones a smaller window no longer covers — already-loaded blocks inside the
   * new window are kept as they are. Returns whether the radius changed.
   */
  setLoadRadius(radius: number): boolean {
    if (!Number.isInteger(radius) || radius <= 0) return false;
    if (radius === this.loadRadius) return false;
    this.loadRadius = radius;
    return true;
  }

  /** Connect the terrain manager to a cell.dat database and parser */
  init(cellDb: DatDatabaseLike, landblockReader: CellLandblockReader): void {
    this.cellDb = cellDb;
    this.landblockReader = landblockReader;
  }

  /** Convert world coordinates to landblock grid coordinates */
  static worldToBlock(worldX: number, worldZ: number): { blockX: number; blockY: number } {
    return {
      blockX: Math.floor(worldX / 192) & 0xff,
      blockY: Math.floor(worldZ / 192) & 0xff,
    };
  }

  /** Convert block grid coordinates to a landblock file ID (for cell.dat) */
  static blockToFileId(blockX: number, blockY: number): number {
    return (((blockX & 0xff) << 24) | ((blockY & 0xff) << 16) | 0xffff) >>> 0;
  }

  /** Extract block coordinates from a landblock file ID */
  static fileIdToBlock(fileId: number): { blockX: number; blockY: number } {
    return {
      blockX: (fileId >> 24) & 0xff,
      blockY: (fileId >> 16) & 0xff,
    };
  }

  /**
   * Update terrain around the given world position.
   * Loads new landblocks within radius, unloads those outside.
   */
  update(worldX: number, worldZ: number): { loaded: number[]; unloaded: number[] } {
    if (!this.cellDb || !this.landblockReader) {
      return { loaded: [], unloaded: [] };
    }

    const { blockX, blockY } = TerrainManager.worldToBlock(worldX, worldZ);
    const r = this.loadRadius;
    const neededIds = new Set<number>();

    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const bx = blockX + dx;
        const by = blockY + dy;
        if (bx >= 0 && bx <= 0xff && by >= 0 && by <= 0xff) {
          neededIds.add(TerrainManager.blockToFileId(bx, by));
        }
      }
    }

    // Unload blocks no longer needed
    const unloaded: number[] = [];
    for (const id of this.loadedBlocks.keys()) {
      if (!neededIds.has(id)) {
        this.loadedBlocks.delete(id);
        unloaded.push(id);
      }
    }

    // Load new blocks
    const loaded: number[] = [];
    for (const id of neededIds) {
      if (!this.loadedBlocks.has(id) && this.cellDb.hasFile(id)) {
        try {
          const reader = this.cellDb.getReader(id);
          const lb = this.landblockReader.read(reader);
          const mesh = new LandblockMesh({
            ...lb,
            landHeightTable: this.landHeightTable,
            landblockId: id,
          });
          this.loadedBlocks.set(id, mesh);
          loaded.push(id);
        } catch {
          // Skip unreadable landblocks
        }
      }
    }

    return { loaded, unloaded };
  }

  /** Get a loaded landblock mesh by file ID */
  getMesh(fileId: number): LandblockMesh | undefined {
    return this.loadedBlocks.get(fileId);
  }

  /** Get all currently loaded meshes */
  getLoadedMeshes(): Map<number, LandblockMesh> {
    return this.loadedBlocks;
  }

  /** Clear all loaded terrain */
  clear(): void {
    this.loadedBlocks.clear();
  }
}
