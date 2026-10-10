/**
 * AGENT navigation: paths around walls, door frames, pillars and furniture,
 * found with the client's OWN movement collision. `probe(from, to)` walks the
 * player's body from `from` toward `to` exactly as held movement keys would
 * (OutdoorMovement.stepPlayerMovement through the same collision services)
 * and returns where it stops, or null when there is no ground to stand on. An
 * edge between two grid points is open only when the body arrives, so a path
 * found here is one the player can actually walk; nothing about the geometry
 * is guessed.
 *
 * Coordinates are the agent's global metres (x east, y north; z = feet).
 * The search is A* over a square grid anchored at the start, bounded by a box
 * around start and goal, and runs incrementally (`step(budgetMs)`) so it can
 * share frames with rendering.
 */

export interface NavPoint { x: number; y: number; z: number }
export type NavProbe = (from: NavPoint, to: { x: number; y: number }) => NavPoint | null;

export interface PlanOptions {
  /** Grid spacing in metres (default 0.6: under the body's diameter, so door gaps aren't skipped). */
  spacing?: number;
  /** How far beyond the start→goal box the search may wander, metres (default 12). */
  margin?: number;
  /** Close enough to the goal to stop, metres (default the spacing). */
  within?: number;
  /** Most grid points expanded before giving up (default 6000). */
  maxNodes?: number;
  /** An edge is open when the probe ends this close to its end (default 0.15 m). */
  tolerance?: number;
}

export type PlanResult =
  | { status: 'found'; path: NavPoint[]; expanded: number }
  | { status: 'none'; expanded: number; nearest: NavPoint | null };

const DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** A binary min-heap of node keys by f-score. */
class Heap {
  private keys: number[] = [];
  private f: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, f: number): void {
    this.keys.push(key); this.f.push(f);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.keys[0];
    const lastK = this.keys.pop()!; const lastF = this.f.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastK; this.f[0] = lastF;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.f.length && this.f[l] < this.f[m]) m = l;
        if (r < this.f.length && this.f[r] < this.f[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.f[a], this.f[b]] = [this.f[b], this.f[a]];
  }
}

/**
 * An incremental A* from `start` to `goal`. Call `step(ms)` until it returns
 * a result; each call spends about `ms` of probing.
 */
export class PathSearch {
  private readonly spacing: number;
  private readonly within: number;
  private readonly maxNodes: number;
  private readonly tolerance: number;
  private readonly minI: number; private readonly maxI: number;
  private readonly minJ: number; private readonly maxJ: number;
  private readonly open = new Heap();
  private readonly g = new Map<number, number>();
  private readonly at = new Map<number, NavPoint>();
  private readonly from = new Map<number, number>();
  private readonly closed = new Set<number>();
  private expanded = 0;
  private bestKey: number;
  private bestH: number;
  private done: PlanResult | null = null;

  /**
   * `goal.z` (feet height) when the goal is on a known floor: a walkway over a hall reaches the
   * hall only down its stairs, so nodes are kept apart by floor (2 m bands of height) as well as by
   * position, and the goal counts as reached on its own floor only.
   */
  constructor(private readonly probe: NavProbe, private readonly start: NavPoint, private readonly goal: { x: number; y: number; z?: number }, opts: PlanOptions = {}) {
    this.spacing = opts.spacing ?? 0.6;
    this.within = opts.within ?? this.spacing;
    this.maxNodes = opts.maxNodes ?? 6000;
    this.tolerance = opts.tolerance ?? 0.15;
    const margin = opts.margin ?? 12;
    const gi = (goal.x - start.x) / this.spacing, gj = (goal.y - start.y) / this.spacing;
    const m = Math.ceil(margin / this.spacing);
    this.minI = Math.floor(Math.min(0, gi)) - m; this.maxI = Math.ceil(Math.max(0, gi)) + m;
    this.minJ = Math.floor(Math.min(0, gj)) - m; this.maxJ = Math.ceil(Math.max(0, gj)) + m;
    const k = this.key(0, 0, 0);
    this.g.set(k, 0);
    this.at.set(k, start);
    this.bestKey = k;
    this.bestH = this.h(start);
    this.open.push(k, this.bestH);
  }

  /** A grid point on a floor band (2 m of height, relative to the start; ±62 m). */
  private key(i: number, j: number, b: number): number { return ((i - this.minI) * 100_003 + (j - this.minJ)) * 64 + (Math.max(-32, Math.min(31, b)) + 32); }
  private ijb(k: number): [number, number, number] {
    const b = (k % 64) - 32, ij = Math.floor(k / 64);
    return [Math.floor(ij / 100_003) + this.minI, (ij % 100_003) + this.minJ, b];
  }
  private band(z: number): number { return Math.round((z - this.start.z) / 2); }
  private h(p: { x: number; y: number; z?: number }): number {
    return Math.hypot(this.goal.x - p.x, this.goal.y - p.y) + (this.goal.z !== undefined && p.z !== undefined ? Math.abs(this.goal.z - p.z) : 0);
  }
  private reached(p: NavPoint): boolean {
    return Math.hypot(this.goal.x - p.x, this.goal.y - p.y) <= this.within && (this.goal.z === undefined || Math.abs(this.goal.z - p.z) <= 1.5);
  }

  /** Probe for about `budgetMs`; the result once the search ends, else null. */
  step(budgetMs = 8, now: () => number = () => performance.now()): PlanResult | null {
    if (this.done) return this.done;
    const t0 = now();
    while (this.open.size) {
      if (now() - t0 > budgetMs) return null;
      const k = this.open.pop();
      if (this.closed.has(k)) continue;
      this.closed.add(k);
      const p = this.at.get(k)!;
      const hp = this.h(p);
      if (hp < this.bestH) { this.bestH = hp; this.bestKey = k; }
      if (this.reached(p)) return (this.done = { status: 'found', path: this.smooth(this.trace(k)), expanded: this.expanded });
      if (++this.expanded > this.maxNodes) break;
      const [i, j] = this.ijb(k);
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < this.minI || ni > this.maxI || nj < this.minJ || nj > this.maxJ) continue;
        const target = { x: this.start.x + ni * this.spacing, y: this.start.y + nj * this.spacing };
        const got = this.probe(p, target);
        if (!got || Math.hypot(got.x - target.x, got.y - target.y) > this.tolerance) continue;
        const nk = this.key(ni, nj, this.band(got.z));
        if (this.closed.has(nk)) continue;
        const ng = this.g.get(k)! + Math.hypot(di, dj) * this.spacing;
        if (ng >= (this.g.get(nk) ?? Infinity)) continue;
        this.g.set(nk, ng);
        this.at.set(nk, { x: target.x, y: target.y, z: got.z });
        this.from.set(nk, k);
        this.open.push(nk, ng + this.h({ ...target, z: got.z }));
      }
    }
    return (this.done = { status: 'none', expanded: this.expanded, nearest: this.bestKey === this.key(0, 0, 0) ? null : this.at.get(this.bestKey) ?? null });
  }

  private trace(k: number): NavPoint[] {
    const out: NavPoint[] = [];
    for (let c: number | undefined = k; c !== undefined; c = this.from.get(c)) out.push(this.at.get(c)!);
    return out.reverse();
  }

  /** Drop grid points a straight walk can skip (the probe decides), so the body steers in long legs. */
  private smooth(path: NavPoint[]): NavPoint[] {
    if (path.length <= 2) return path.slice(1);
    const out: NavPoint[] = [];
    let a = 0;
    while (a < path.length - 1) {
      let b = path.length - 1;
      for (; b > a + 1; b--) if (this.straight(path[a], path[b])) break;
      out.push(path[b]);
      a = b;
    }
    return out;
  }

  /** A straight walk from a to b arrives, on b's floor, checked in grid-sized legs. */
  private straight(a: NavPoint, b: NavPoint): boolean {
    return straightWalk(this.probe, a, b, this.spacing, this.tolerance);
  }
}

/**
 * A straight walk from a to b arrives (the probe, in legs of `spacing`), and on b's floor when b
 * has a height: overhead on a walkway is not at a point in the hall below.
 */
export function straightWalk(probe: NavProbe, a: NavPoint, b: { x: number; y: number; z?: number }, spacing = 0.6, tolerance = 0.15): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / spacing));
  let p = a;
  for (let s = 1; s <= n; s++) {
    const t = { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n };
    const got = probe(p, t);
    if (!got || Math.hypot(got.x - t.x, got.y - t.y) > tolerance) return false;
    p = got;
  }
  return b.z === undefined || Math.abs(p.z - b.z) <= 1.5;
}

/** Run a search to the end (tests, small plans). */
export function planPath(probe: NavProbe, start: NavPoint, goal: { x: number; y: number; z?: number }, opts: PlanOptions = {}): PlanResult {
  const s = new PathSearch(probe, start, goal, opts);
  for (;;) { const r = s.step(Infinity); if (r) return r; }
}

/**
 * A text floor plan around `center` for an agent: the floor the body can
 * reach from there (flood fill with the same probe), walls and drops as
 * blanks, objects as letters. North is up. Returns the lines and a legend.
 */
export function floorPlan(
  probe: NavProbe, center: NavPoint,
  marks: ReadonlyArray<{ x: number; y: number; ch: string; label: string }>,
  opts: { radius?: number; spacing?: number; maxProbes?: number } = {},
): { lines: string[]; legend: string[]; reached: number } {
  const spacing = opts.spacing ?? 1;
  const r = Math.round((opts.radius ?? 15) / spacing);
  const maxProbes = opts.maxProbes ?? 6000;
  const size = 2 * r + 1;
  const reach: Array<NavPoint | null> = new Array(size * size).fill(null);
  const idx = (i: number, j: number): number => (j + r) * size + (i + r);
  reach[idx(0, 0)] = center;
  const queue: Array<[number, number]> = [[0, 0]];
  let probes = 0;
  while (queue.length && probes < maxProbes) {
    const [i, j] = queue.shift()!;
    const p = reach[idx(i, j)]!;
    for (const [di, dj] of DIRS.slice(0, 4)) {
      const ni = i + di, nj = j + dj;
      if (Math.abs(ni) > r || Math.abs(nj) > r || reach[idx(ni, nj)]) continue;
      const t = { x: center.x + ni * spacing, y: center.y + nj * spacing };
      probes++;
      const got = probe(p, t);
      if (!got || Math.hypot(got.x - t.x, got.y - t.y) > 0.25 * spacing) continue;
      reach[idx(ni, nj)] = { x: t.x, y: t.y, z: got.z };
      queue.push([ni, nj]);
    }
  }
  const grid: string[][] = [];
  for (let j = r; j >= -r; j--) {
    const row: string[] = [];
    for (let i = -r; i <= r; i++) {
      const p = reach[idx(i, j)];
      // Floor you can reach: '.', a step up or down of more than 1 m: ':' — else a wall, a drop or out of reach: '#'.
      row.push(p ? (Math.abs(p.z - center.z) > 1 ? ':' : '.') : '#');
    }
    grid.push(row);
  }
  const legend: string[] = [];
  for (const m of marks) {
    const i = Math.round((m.x - center.x) / spacing), j = Math.round((m.y - center.y) / spacing);
    if (Math.abs(i) > r || Math.abs(j) > r) continue;
    grid[r - j][i + r] = m.ch;
    legend.push(`${m.ch} ${m.label}`);
  }
  grid[r][r] = '@';
  return { lines: grid.map((row) => row.join('')), legend, reached: reach.filter(Boolean).length };
}
