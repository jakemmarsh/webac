/**
 * Area packs (RELEASE.streaming-area-packs): the portal leaves a client needs
 * in each tile of landblocks, so the publish tool (tools/publish-dats-r2.ts)
 * can ship them as one object per tile and a cold portal-space gate costs a
 * request or two instead of a dependency chain of hundreds of single files
 * (docs/dat-streaming.md §6.12).
 *
 * The edges are the client's own: DatClosure.edges (the walk the gate runs)
 * over a ClosureStore backed by the local DATs, where every file is resident.
 * A landblock's leaves are the closure of its CellLandblock + LandblockInfo
 * (its EnvCells, buildings, statics and scenery) plus the world DB's static
 * objects placed there and their generators' spawns, from their Setup /
 * MotionTable / PhysicsEffectTable data ids (tools/lib/world-db-roots.ts).
 *
 * A leaf more than `commonThreshold` landblocks need (trees, rocks) goes to
 * the one common pack; every other leaf goes to the pack of each tile whose
 * landblocks need it. Leaves the set's boot / world / ui packs carry go to
 * neither.
 */
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import type { RegionDesc } from '../../packages/dat-parser/src/file-types/RegionDesc.js';
import { type DatName, SKELETON_TYPES, areaTileOf } from '../../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatClosure, type ClosureStore } from '../../packages/renderer/src/dat/streaming/DatClosure.js';
import { type FileKey, fileKey, splitFileKey } from '../../packages/renderer/src/dat/streaming/DatStore.js';

const ITERATION_FILE_ID = 0xffff0001;

/** A ClosureStore over local DATs: everything resident, nothing to fetch. */
export class LocalClosureStore {
  private readonly cellByBlock = new Map<number, number[]>();
  /** Structural portal files are read again per landblock (scenes, setups): keep them. */
  private readonly portalCache = new Map<number, Uint8Array | null>();

  constructor(private readonly dbs: Partial<Record<DatName, DatDatabase>>, private readonly onRead?: () => void) {
    for (const id of dbs.cell?.listFileIds() ?? []) {
      if (id === ITERATION_FILE_ID || (id & 0xffff) === 0xffff) continue;
      const lb = id >>> 16;
      let l = this.cellByBlock.get(lb);
      if (!l) this.cellByBlock.set(lb, l = []);
      l.push(id >>> 0);
    }
  }

  /** Landblocks (0xXXYY) with a bundle (LandblockInfo / EnvCells). */
  bundleBlocks(): number[] { return [...this.cellByBlock.keys()]; }

  onEvict(): () => void { return () => {}; }
  isResident(dat: DatName, id: number): boolean { return this.exists(dat, id); }
  async ensure(): Promise<void> { /* resident */ }
  async ensureBundle(): Promise<void> { /* resident */ }
  isBundleResident(): boolean { return true; }
  bundleIds(landblock: number): readonly number[] { return this.cellByBlock.get(landblock & 0xffff) ?? []; }
  exists(dat: DatName, id: number): boolean { return this.dbs[dat]?.hasFile(id >>> 0) ?? false; }
  peek(dat: DatName, id: number): Uint8Array | null {
    id >>>= 0;
    const structural = dat === 'portal' && SKELETON_TYPES.has(id >>> 24);
    if (structural && this.portalCache.has(id)) return this.portalCache.get(id)!;
    let d: ArrayBuffer | null = null;
    try { d = this.dbs[dat]?.getFileData(id) ?? null; } catch { d = null; } // a file that does not read (or translate) has no edges
    this.onRead?.();
    const out = d ? new Uint8Array(d) : null;
    if (structural) this.portalCache.set(id, out);
    return out;
  }
}

export interface AreaPlanOptions {
  portal: DatDatabase;
  cell: DatDatabase;
  regionDesc: RegionDesc | null;
  /** Portal data ids of the server objects a landblock starts with (world DB; may be empty). */
  serverRoots?: (landblock: number) => readonly number[];
  /** A leaf more than this many landblocks need goes to the common pack. */
  commonThreshold: number;
  /** Landblocks per tile side (DatSetFormat areaTileOf). */
  tileSize: number;
  /** Leaves the set's resident packs already carry (boot / world / ui): in no area pack. */
  inPacks?: ReadonlySet<number>;
  /** Landblocks to plan (default: every landblock with terrain or a bundle). */
  landblocks?: readonly number[];
  onProgress?: (done: number, total: number) => void;
  /** After every DAT read (the 1999 overlay drops its translation cache now and then). */
  onRead?: () => void;
}

export interface AreaPlan {
  /** Tile key (areaTileOf) → the portal leaf ids its area pack carries (sorted; empty tiles left out). */
  tiles: Map<number, number[]>;
  /** Portal leaf ids in the common pack (sorted). */
  common: number[];
  /** Landblock (0xXXYY) → every leaf it needs (before the common / tile split). */
  blockLeaves: Map<number, ReadonlySet<number>>;
}

/** Is a portal id a per-file leaf in the published set (not a skeleton-pack file)? */
export function isPortalLeaf(id: number): boolean {
  return !SKELETON_TYPES.has(id >>> 24);
}

/** Plan every tile's area pack and the common pack. */
export function planAreas(opts: AreaPlanOptions): AreaPlan {
  const store = new LocalClosureStore({ portal: opts.portal, cell: opts.cell }, opts.onRead);
  const closure = new DatClosure(store as unknown as ClosureStore, { regionDesc: () => opts.regionDesc });
  // A portal file's whole leaf closure, once: Setups / GfxObjs recur across thousands of blocks.
  const portalMemo = new Map<FileKey, ReadonlySet<number>>();
  const portalClosure = (root: FileKey): ReadonlySet<number> => {
    const known = portalMemo.get(root);
    if (known) return known;
    const out = new Set<number>();
    const seen = new Set<FileKey>();
    const stack = [root];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      const { dat, id } = splitFileKey(k);
      if (dat === 'portal' && isPortalLeaf(id)) out.add(id);
      for (const c of closure.edges(k)) stack.push(c);
    }
    portalMemo.set(root, out);
    return out;
  };
  const blocks = opts.landblocks ?? (() => {
    const all = new Set<number>(store.bundleBlocks());
    for (const id of opts.cell.listFileIds()) if (id !== ITERATION_FILE_ID && (id & 0xffff) === 0xffff) all.add(id >>> 16);
    return [...all].sort((a, b) => a - b);
  })();
  const blockLeaves = new Map<number, ReadonlySet<number>>();
  const uses = new Map<number, number>();
  let done = 0;
  for (const lb of blocks) {
    // The cell side (terrain, bundle files) walks per block; each portal file it reaches comes from the memo.
    const leaves = new Set<number>();
    const seen = new Set<FileKey>();
    const stack: FileKey[] = [fileKey('cell', ((lb << 16) | 0xffff) >>> 0), fileKey('cell', ((lb << 16) | 0xfffe) >>> 0)];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      if (splitFileKey(k).dat === 'portal') { for (const id of portalClosure(k)) leaves.add(id); continue; }
      for (const c of closure.edges(k)) stack.push(c);
    }
    for (const id of opts.serverRoots?.(lb) ?? []) {
      if (opts.portal.hasFile(id >>> 0)) for (const leaf of portalClosure(fileKey('portal', id >>> 0))) leaves.add(leaf);
    }
    if (opts.inPacks) for (const id of leaves) if (opts.inPacks.has(id)) leaves.delete(id);
    if (leaves.size > 0) {
      blockLeaves.set(lb, leaves);
      for (const id of leaves) uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    if (++done % 2048 === 0) opts.onProgress?.(done, blocks.length);
  }
  const common = [...uses].filter(([, n]) => n > opts.commonThreshold).map(([id]) => id).sort((a, b) => a - b);
  const commonSet = new Set(common);
  const tileSets = new Map<number, Set<number>>();
  for (const [lb, leaves] of blockLeaves) {
    const tile = areaTileOf(lb, opts.tileSize);
    let t = tileSets.get(tile);
    for (const id of leaves) {
      if (commonSet.has(id)) continue;
      if (!t) tileSets.set(tile, t = new Set());
      t.add(id);
    }
  }
  const tiles = new Map<number, number[]>();
  for (const [tile, ids] of tileSets) tiles.set(tile, [...ids].sort((a, b) => a - b));
  return { tiles, common, blockLeaves };
}
