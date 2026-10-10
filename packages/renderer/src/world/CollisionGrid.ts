/**
 * REND.scenery-collision-never-removed — a uniform XZ hash grid over the
 * collision sources DungeonCollision holds, so a movement / floor query only
 * visits the sources whose footprint can reach the query point instead of
 * every source ever registered.
 *
 * Behaviour-preserving by construction: an entry is filed under every grid
 * cell its (conservative) XZ bounding disc touches, a query collects every
 * entry filed under the cells its own disc/box touches, and the result comes
 * back in REGISTRATION order (`seq`), which is the order the old Map scans
 * visited them in — so the first hit a scan returns is the same hit.
 */
export interface GridEntry {
  /** Registration order (first insert of the key; re-registering a key keeps it, like Map.set). */
  seq: number;
  /** Grid cells this entry is filed under (null = unbounded, always returned). */
  gridCells: number[] | null;
}

/** Grid pitch: one outdoor land cell (LandDefs square_length 24 m). */
export const COLLISION_GRID_SIZE = 24;

/** Keeps grid coordinates non-negative for the packed key (world X/Z are 0..49152). */
const KEY_OFFSET = 32768;

function cellKey(ix: number, iz: number): number {
  return (ix + KEY_OFFSET) * 65536 + (iz + KEY_OFFSET);
}

export class CollisionGrid<T extends GridEntry> {
  private readonly grid = new Map<number, Set<T>>();
  private readonly unbounded = new Set<T>();

  constructor(private readonly size = COLLISION_GRID_SIZE) {}

  /** File `entry` under the cells its XZ disc (cx, cz, radius) touches; non-finite discs are unbounded. */
  insert(entry: T, cx: number, cz: number, radius: number): void {
    this.remove(entry);
    if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(radius) || radius < 0) {
      entry.gridCells = null;
      this.unbounded.add(entry);
      return;
    }
    const keys: number[] = [];
    const x0 = Math.floor((cx - radius) / this.size);
    const x1 = Math.floor((cx + radius) / this.size);
    const z0 = Math.floor((cz - radius) / this.size);
    const z1 = Math.floor((cz + radius) / this.size);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = cellKey(ix, iz);
        let set = this.grid.get(k);
        if (!set) { set = new Set(); this.grid.set(k, set); }
        set.add(entry);
        keys.push(k);
      }
    }
    entry.gridCells = keys;
  }

  remove(entry: T): void {
    if (entry.gridCells === null) {
      this.unbounded.delete(entry);
      return;
    }
    for (const k of entry.gridCells) {
      const set = this.grid.get(k);
      if (!set) continue;
      set.delete(entry);
      if (set.size === 0) this.grid.delete(k);
    }
    entry.gridCells = [];
  }

  /** Entries whose cells touch the XZ box [xMin,xMax]×[zMin,zMax], in registration order. */
  queryBox(xMin: number, xMax: number, zMin: number, zMax: number): T[] {
    const out = new Set<T>(this.unbounded);
    const x0 = Math.floor(xMin / this.size);
    const x1 = Math.floor(xMax / this.size);
    const z0 = Math.floor(zMin / this.size);
    const z1 = Math.floor(zMax / this.size);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const set = this.grid.get(cellKey(ix, iz));
        if (set) for (const e of set) out.add(e);
      }
    }
    return [...out].sort((a, b) => a.seq - b.seq);
  }

  /** Entries whose cells touch the XZ disc (x, z, radius), in registration order. */
  queryDisc(x: number, z: number, radius: number): T[] {
    return this.queryBox(x - radius, x + radius, z - radius, z + radius);
  }
}
