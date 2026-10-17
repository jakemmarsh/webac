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

import { dropDamage, jumpOptions, type JumpKit, type JumpSpec } from './jumpPlan.js';

export interface NavPoint { x: number; y: number; z: number }
export type NavProbe = (from: NavPoint, to: { x: number; y: number }) => NavPoint | null;
/** A path point; `jump` when it is reached by jumping (or dropping) from the point before it. */
export type NavStep = NavPoint & { jump?: JumpSpec };

/**
 * Jumps and drops the search may take (AGENT.walk-drops-jumps): where the body can't walk on (a
 * ledge, a gap, a platform's side) it tries the jumps the client's own physics would fly
 * (jumpPlan.jumpOptions), landing no harder than `maxDamage`. Each one costs `penalty` metres of
 * extra path, so a walk round is taken when it is not much longer.
 */
export interface JumpSearch {
  kit: JumpKit;
  /** The fall damage a landing may deal (jumpPlan.fallBudget of the player's health). */
  maxDamage: number;
  /** Extra path cost of one jump, metres (default 8). */
  penalty?: number;
  /** Most flights simulated before jumps stop being tried (default 1500). */
  maxFlights?: number;
  /**
   * Floor circles no jump or drop may land in or fly across (a portal's disk: portalAvoid.AvoidDisk, `span` the height
   * it counts over, default 3 m). The probe stops a walk at a portal's rim, but a flight was never probed: a jump onto
   * the Mountain Keep portal's platform landed 1.2 m from its centre, inside its reach, and took Bulwark through it on a
   * walk_to the portal itself (A8C3, 2026-10-17 05:28:40Z, WeenieError ITeleported).
   */
  avoid?: () => ReadonlyArray<{ x: number; y: number; z: number; r: number; span?: number }>;
  /**
   * Take-offs a jump or drop already came down on itself from (the body went up and landed where it left, live): no
   * jump is tried from within SKIP_TAKEOFF_M of one, so the search takes off from another spot along the edge. Two drops
   * from Arcanist's spot on the Shreth camp ledge's lip landed back on it and the walk gave up; the next walk's drop from
   * 0.3 m further along went down (0x5779, 2026-10-17 11:28:41–11:29:30Z).
   */
  skipFrom?: () => ReadonlyArray<NavPoint>;
}

/** A take-off this near (m, horizontal; within half a metre of height) one in JumpSearch.skipFrom is not jumped from. */
export const SKIP_TAKEOFF_M = 0.3;

/** Whether a flight from `a` to `b` lands in, or passes over, one of `disks` (horizontal, within each one's height span). */
export function flightCrossesDisk(a: NavPoint, b: NavPoint, disks: ReadonlyArray<{ x: number; y: number; z: number; r: number; span?: number }>): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  for (const d of disks) {
    const span = d.span ?? 3;
    if (Math.abs(a.z - d.z) > span && Math.abs(b.z - d.z) > span) continue;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((d.x - a.x) * dx + (d.y - a.y) * dy) / len2)) : 0;
    if (Math.hypot(a.x + dx * t - d.x, a.y + dy * t - d.y) < d.r) return true;
  }
  return false;
}

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
  /** Jumps and drops it may take; none without. */
  jumps?: JumpSearch;
}

/**
 * `boxed`: the search met the edge of its box (start → goal plus the margin) somewhere, so a wider
 * one may find a way it could not (the Banderling Ruin ramp lay 2 m past a 12 m margin, 2026-10-10).
 * `enclosed`: it walked every point reachable from the start (never met its box, never ran out of
 * points): the floor you stand on is closed in, so no search from here, however wide, finds a way on
 * foot (with this search's jumps, if it had any). `area`: that floor, square metres.
 */
export type PlanResult =
  | { status: 'found'; path: NavStep[]; expanded: number; jumps: number }
  | { status: 'none'; expanded: number; nearest: NavPoint | null; boxed: boolean; enclosed: boolean; area: number };

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
  /** The jump that reaches a node (its edge from `from`). */
  private readonly via = new Map<number, JumpSpec>();
  private readonly closed = new Set<number>();
  private readonly jumps: JumpSearch | null;
  private flights = 0;
  private boxed = false;
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
    this.jumps = opts.jumps ?? null;
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

  /** Whether this search may take jumps and drops. */
  get hasJumps(): boolean { return !!this.jumps; }

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
      if (this.reached(p)) {
        const path = this.smooth(this.trace(k));
        return (this.done = { status: 'found', path, expanded: this.expanded, jumps: path.filter((q) => q.jump).length });
      }
      if (++this.expanded > this.maxNodes) break;
      const [i, j] = this.ijb(k);
      const stuck: Array<[number, number]> = [];
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < this.minI || ni > this.maxI || nj < this.minJ || nj > this.maxJ) { this.boxed = true; continue; }
        const target = { x: this.start.x + ni * this.spacing, y: this.start.y + nj * this.spacing };
        const got = this.probe(p, target);
        if (!got || Math.hypot(got.x - target.x, got.y - target.y) > this.tolerance) { stuck.push([di, dj]); continue; }
        this.relax(k, this.key(ni, nj, this.band(got.z)), { x: target.x, y: target.y, z: got.z }, Math.hypot(di, dj) * this.spacing);
      }
      if (this.jumps && stuck.length) this.tryJumps(k, p, stuck);
    }
    // The open set ran dry inside the box, within the node budget and (with jumps) the flight budget: closed in.
    const exhausted = !this.open.size && this.expanded <= this.maxNodes && !this.boxed && (!this.jumps || this.flights < (this.jumps.maxFlights ?? 1500));
    return (this.done = this.none(exhausted));
  }

  private none(enclosed: boolean): PlanResult {
    return { status: 'none', expanded: this.expanded, nearest: this.bestKey === this.key(0, 0, 0) ? null : this.at.get(this.bestKey) ?? null, boxed: this.boxed, enclosed, area: Math.round(this.closed.size * this.spacing * this.spacing) };
  }

  /** End the search now, as if it had found no way (the walk ran out of time to stand searching). */
  abandon(): PlanResult {
    return this.done ?? (this.done = this.none(false));
  }

  private relax(k: number, nk: number, at: NavPoint, cost: number, jump?: JumpSpec): void {
    if (this.closed.has(nk)) return;
    const ng = this.g.get(k)! + cost;
    if (ng >= (this.g.get(nk) ?? Infinity)) return;
    this.g.set(nk, ng);
    this.at.set(nk, at);
    this.from.set(nk, k);
    if (jump) this.via.set(nk, jump); else this.via.delete(nk);
    this.open.push(nk, ng + this.h(at));
  }

  /**
   * Where the walk from `p` stopped short (a ledge, a gap, a wall), the jumps that way land
   * somewhere: each landing is a node, reached by that jump. A way the body can't go even in the
   * air (a wall that stands higher than a jump) is skipped before any flight is simulated.
   */
  private tryJumps(k: number, p: NavPoint, stuck: Array<[number, number]>): void {
    const js = this.jumps!;
    const max = js.maxFlights ?? 1500;
    if (js.skipFrom?.().some((q) => Math.hypot(q.x - p.x, q.y - p.y) < SKIP_TAKEOFF_M && Math.abs(q.z - p.z) < 0.5)) return;
    for (const [di, dj] of stuck) {
      if (this.flights >= max) return;
      const n = Math.hypot(di, dj);
      const u = { x: di / n, y: dj / n };
      // Open air that way: a 1.2 m move at knee or head height above the floor goes through.
      const open = [0.8, 1.6].some((h) => {
        const to = js.kit.airStep({ x: p.x, y: p.y, z: p.z + h }, u.x * 1.2, u.y * 1.2);
        return Math.hypot(to.x - p.x, to.y - p.y) > 0.9;
      });
      if (!open) continue;
      let flights = 0;
      const kit: typeof js.kit = { ...js.kit, launch: (power, walk) => { flights++; return js.kit.launch(power, walk); } };
      const avoid = js.avoid?.() ?? [];
      const options = jumpOptions(kit, p, u, { maxDamage: js.maxDamage, max: 2, ...(avoid.length ? { accept: (to: NavPoint) => !flightCrossesDisk(p, to, avoid) } : {}) });
      this.flights += flights;
      for (const o of options) {
        const ni = Math.round((o.to.x - this.start.x) / this.spacing), nj = Math.round((o.to.y - this.start.y) / this.spacing);
        if (ni < this.minI || ni > this.maxI || nj < this.minJ || nj > this.maxJ) { this.boxed = true; continue; }
        const nk = this.key(ni, nj, this.band(o.to.z));
        if (nk === k) continue;
        this.relax(k, nk, o.to, Math.hypot(o.to.x - p.x, o.to.y - p.y) + (js.penalty ?? 8), o);
      }
    }
  }

  private trace(k: number): NavStep[] {
    const out: NavStep[] = [];
    for (let c: number | undefined = k; c !== undefined; c = this.from.get(c)) {
      const j = this.via.get(c);
      out.push(j ? { ...this.at.get(c)!, jump: j } : this.at.get(c)!);
    }
    return out.reverse();
  }

  /**
   * Drop grid points a straight walk can skip (the probe decides), so the body steers in long legs.
   * A jump's take-off and landing stay: the walk is smoothed between them.
   */
  private smooth(path: NavStep[]): NavStep[] {
    if (path.length <= 1) return [];
    const out: NavStep[] = [];
    let a = 0;
    while (a < path.length - 1) {
      if (path[a + 1].jump) { out.push(path[a + 1]); a = a + 1; continue; }
      // The run of walking steps from a: up to the next jump's take-off.
      let end = a + 1;
      while (end + 1 < path.length && !path[end + 1].jump) end++;
      let b = end;
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
  opts: { radius?: number; spacing?: number; maxProbes?: number; jumps?: JumpSearch } = {},
): { lines: string[]; legend: string[]; reached: number; drops: number; deadly: number; jumpSpots: number } {
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
  // AGENT.walk-drops-jumps — the edges a body can drop off ('v', or '!' where the fall would hurt more
  // than you can take), and the floor only a jump reaches ('J'), from the client's own jump physics.
  let drops = 0, deadly = 0, jumpSpots = 0;
  const js = opts.jumps;
  if (js) {
    const cellAt = (i: number, j: number): string => grid[r - j][i + r];
    const setAt = (i: number, j: number, ch: string): void => { grid[r - j][i + r] = ch; };
    const edges: Array<{ p: NavPoint; i: number; j: number; di: number; dj: number }> = [];
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const p = reach[idx(i, j)];
      // Edges of the floor you stand on (the plan shows one floor per square: yours where it reaches).
      if (!p || Math.abs(p.z - center.z) > 1) continue;
      for (const [di, dj] of DIRS.slice(0, 4)) {
        const ni = i + di, nj = j + dj;
        if (Math.abs(ni) > r || Math.abs(nj) > r) continue;
        const n = reach[idx(ni, nj)];
        if (n && n.z > p.z - 1) continue; // walked on to, on this floor
        const f = js.kit.floor(center.x + ni * spacing, center.y + nj * spacing, p.z);
        if (f === null || p.z - f <= 1) continue;
        // Open air that way, at knee or head height (as the walk's jump search asks): a floor far below behind a wall
        // or solid rock is no ledge. The doll dungeon's balcony 0x029002E2 and the rock beside its rift showed rows of
        // 'v' over the halls 18–24 m down that no body gets over (2026-10-16).
        const out = (h: number): boolean => {
          const to = js.kit.airStep({ x: p.x, y: p.y, z: p.z + h }, di * spacing * 0.8, dj * spacing * 0.8);
          return Math.hypot(to.x - p.x, to.y - p.y) > 0.5 * spacing;
        };
        if (!out(0.8) && !out(1.6)) continue;
        edges.push({ p, i, j, di, dj });
        if (cellAt(ni, nj) !== '#' && cellAt(ni, nj) !== ':') continue;
        const safe = dropDamage(p.z - f, js.kit.fall) <= js.maxDamage;
        setAt(ni, nj, safe ? 'v' : '!');
        if (safe) drops++; else deadly++;
      }
    }
    // Jumps from the edges, a flight budget's worth, spread over them.
    let flights = 0;
    const maxFlights = js.maxFlights ?? 600;
    const stride = Math.max(1, Math.ceil(edges.length / 40));
    for (let e = 0; e < edges.length && flights < maxFlights; e += stride) {
      const { p, di, dj } = edges[e];
      const kit: JumpKit = { ...js.kit, launch: (power, walk) => { flights++; return js.kit.launch(power, walk); } };
      for (const o of jumpOptions(kit, p, { x: di, y: dj }, { maxDamage: js.maxDamage, max: 2 })) {
        if (o.to.z < p.z - 1) continue; // a drop's landing: the 'v' beside it says so
        const ni = Math.round((o.to.x - center.x) / spacing), nj = Math.round((o.to.y - center.y) / spacing);
        const n = Math.abs(ni) <= r && Math.abs(nj) <= r ? reach[idx(ni, nj)] : undefined;
        if (n === undefined || (n && Math.abs(n.z - o.to.z) < 1)) continue; // off the plan, or floor you walk to
        if (cellAt(ni, nj) !== 'J') jumpSpots++;
        setAt(ni, nj, 'J');
      }
    }
  }
  const legend: string[] = [];
  for (const m of marks) {
    const i = Math.round((m.x - center.x) / spacing), j = Math.round((m.y - center.y) / spacing);
    if (Math.abs(i) > r || Math.abs(j) > r) continue;
    grid[r - j][i + r] = m.ch;
    legend.push(`${m.ch} ${m.label}`);
  }
  grid[r][r] = '@';
  return { lines: grid.map((row) => row.join('')), legend, reached: reach.filter(Boolean).length, drops, deadly, jumpSpots };
}
