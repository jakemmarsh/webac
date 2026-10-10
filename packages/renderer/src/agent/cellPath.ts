/**
 * cellPath — routes through a dungeon landblock's EnvCells: the agent API's
 * indoor walkTo (docs/agent-play.md) and the live probes
 * (HARNESS.first-hour-stairs; tools/lib/cell-path.ts re-exports this).
 *
 * ACE's MoveTo walks a straight line, so a target on another floor (the
 * academy's Outer Courtyard portal at z 12) is never reached by Use alone.
 * This builds the landblock's cell graph from the cell DAT (each EnvCell's
 * CellPortals, OtherCellId 0xFFFF = outside), places a waypoint at every
 * portal polygon's centroid in the landblock frame (Environment CellStruct
 * vertices through the EnvCell's Position frame), and finds the shortest
 * waypoint route between two points with Dijkstra. Walking the route
 * portal-to-portal keeps each straight leg inside one cell.
 */
import { DatReader } from '@ac/dat-parser/DatReader.js';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { Environment } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';

export interface Vec3 { x: number; y: number; z: number }

/**
 * One doorway between two cells (or a cell and the outside, other = 0xFFFF):
 * its polygon's centroid and unit normal (Newell), both in the landblock frame.
 */
/** `height` is the opening's vertical extent; `bottom` is its lowest point (a doorway's floor: where feet go through). */
export interface CellDoor { a: number; b: number; at: Vec3; normal: Vec3; height?: number; bottom?: number }

export interface CellGraph {
  landblock: number;
  /** Cell id (0xXXYYCCCC) → the doors of that cell. */
  doors: Map<number, CellDoor[]>;
  /** Cell id → the mean of its geometry's vertices (landblock frame): which side of a doorway is inside. */
  centers?: Map<number, Vec3>;
  /**
   * False when a file it needed was not readable yet (a streamed set's miss: the read returns null and
   * the fetch starts), so the graph may lack doors. Don't keep it; build it again on the next route.
   */
  complete?: boolean;
}

/** Rotate `v` by the unit quaternion (w, x, y, z), then add the origin: the frame's local → parent transform. */
export function frameToParent(f: Frame, v: Vec3): Vec3 {
  const { w, x, y, z } = f.orientation;
  // v' = v + 2w(q×v) + 2q×(q×v)
  const cx = y * v.z - z * v.y, cy = z * v.x - x * v.z, cz = x * v.y - y * v.x;
  const ccx = y * cz - z * cy, ccy = z * cx - x * cz, ccz = x * cy - y * cx;
  return {
    x: v.x + 2 * (w * cx + ccx) + f.origin.x,
    y: v.y + 2 * (w * cy + ccy) + f.origin.y,
    z: v.z + 2 * (w * cz + ccz) + f.origin.z,
  };
}

/** Read every EnvCell of `landblock` (0xXXYY0000) and its doors. */
export function loadCellGraph(cellDat: DatDatabase, portalDat: DatDatabase, landblock: number): CellGraph {
  const lb = (landblock & 0xFFFF0000) >>> 0;
  const envs = new Map<number, Environment | null>();
  const doors = new Map<number, CellDoor[]>();
  const centers = new Map<number, Vec3>();
  let complete = true;
  for (let n = 0x0100; n <= 0xFFFD; n++) {
    const id = (lb | n) >>> 0;
    const data = cellDat.getFileData(id);
    if (!data) { if (n === 0x0100) complete = false; break; } // EnvCells are numbered contiguously from 0x0100; none at all may be a bundle still in flight
    const cell = new EnvCell(new DatReader(data));
    if (!envs.has(cell.environmentId)) {
      const e = portalDat.getFileData(cell.environmentId);
      envs.set(cell.environmentId, e ? new Environment(new DatReader(e)) : null);
      if (!e) complete = false;
    }
    const struct = envs.get(cell.environmentId)?.cells.get(cell.cellStructure);
    if (struct) {
      let cx = 0, cy = 0, cz = 0, k = 0;
      for (const v of struct.vertexArray.vertices.values()) {
        const p = frameToParent(cell.position, v.origin);
        cx += p.x; cy += p.y; cz += p.z; k++;
      }
      if (k) centers.set(id, { x: cx / k, y: cy / k, z: cz / k });
    }
    const list: CellDoor[] = [];
    for (const p of cell.cellPortals) {
      const poly = struct?.polygons.get(p.polygonId);
      if (!struct || !poly || poly.vertexIndices.length === 0) continue;
      const pts = poly.vertexIndices.map((vi) => frameToParent(cell.position, struct.vertexArray.vertices.get(vi)!.origin));
      const k = pts.length;
      const at = { x: pts.reduce((t, q) => t + q.x, 0) / k, y: pts.reduce((t, q) => t + q.y, 0) / k, z: pts.reduce((t, q) => t + q.z, 0) / k };
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < k; j++) {
        const c = pts[j], n = pts[(j + 1) % k];
        nx += (c.y - n.y) * (c.z + n.z); ny += (c.z - n.z) * (c.x + n.x); nz += (c.x - n.x) * (c.y + n.y);
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      const normal = { x: nx / nl, y: ny / nl, z: nz / nl };
      const b = p.otherCellId === 0xFFFF ? 0xFFFF : (lb | p.otherCellId) >>> 0;
      const zs = pts.map((q) => q.z);
      list.push({ a: id, b, at, normal, height: Math.max(...zs) - Math.min(...zs), bottom: Math.min(...zs) });
    }
    doors.set(id, list);
  }
  return { landblock: lb, doors, centers, complete };
}

const dist = (p: Vec3, q: Vec3): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/**
 * A route point: a doorway's centroid (`floor` when it is a horizontal portal, |normal.z| > 0.7) or the target.
 * `feet` is a wall doorway's floor height, where a body's feet pass through it. The centroid is
 * 1.25–1.55 m above that in a 2.5–3.1 m door: the Holtburg tavern, 2026-10-09.
 */
export type RoutePoint = Vec3 & { floor?: boolean; feet?: number };
const withFeet = (d: CellDoor, p: Vec3): RoutePoint => (d.bottom === undefined ? p : { ...p, feet: d.bottom });

/** Two points within 1 cm: the same doorway (each side's copy of a door shares its centroid). */
export const samePoint = (p: Vec3, q: Vec3): boolean => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < 0.01;

/**
 * The shortest route from `from` in cell `fromCell` to `to` in cell `toCell`:
 * the doorway centroids to pass through, then `to`. Doorways at an `avoid`
 * point are left out (a floor portal found to be a drop, not a stair). Nodes are the doors;
 * two doors of one cell are joined by their straight-line distance. A door is
 * shared by the cells on both sides, so its two halves (each cell's own copy)
 * are merged by key a<b. Returns null when no route exists.
 */
export function findRoute(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, avoid: Vec3[] = []): RoutePoint[] | null {
  // Through body-sized openings when there's a way; any opening beats none.
  return searchRoute(g, fromCell, from, toCell, to, avoid, true) ?? searchRoute(g, fromCell, from, toCell, to, avoid, false);
}

function searchRoute(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, avoid: Vec3[], bodySized: boolean): RoutePoint[] | null {
  fromCell >>>= 0; toCell >>>= 0;
  if (fromCell === toCell) return [to];
  const key = (d: CellDoor): string => (d.a < d.b ? `${d.a}:${d.b}` : `${d.b}:${d.a}`);
  // Node positions: average both sides' centroid copies (they coincide up to float error).
  const pos = new Map<string, RoutePoint>();
  const cellsOf = new Map<string, number[]>();
  const usable = (d: CellDoor): boolean => d.b !== 0xFFFF && !(bodySized && tooLow(d)) && !avoid.some((a) => samePoint(a, d.at));
  for (const [cell, list] of g.doors) for (const d of list) {
    if (!usable(d)) continue;
    const k = key(d);
    if (!pos.has(k)) pos.set(k, Math.abs(d.normal.z) > 0.7 ? { ...d.at, floor: true } : withFeet(d, d.at));
    const cs = cellsOf.get(k) ?? [];
    cs.push(cell);
    cellsOf.set(k, cs);
  }
  const doorsIn = (cell: number): string[] => (g.doors.get(cell) ?? []).filter(usable).map(key);
  const START = 'start', GOAL = 'goal';
  const best = new Map<string, number>([[START, 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([START]);
  const done = new Set<string>();
  const posOf = (n: string): RoutePoint => (n === START ? from : n === GOAL ? to : pos.get(n)!);
  // Cells a node touches: start/goal are inside one cell, a door joins two.
  const cellsAt = (n: string): number[] => (n === START ? [fromCell] : n === GOAL ? [toCell] : cellsOf.get(n) ?? []);
  while (open.size) {
    let n = '', nd = Infinity;
    for (const o of open) { const d = best.get(o)!; if (d < nd) { nd = d; n = o; } }
    open.delete(n);
    if (n === GOAL) break;
    done.add(n);
    for (const c of cellsAt(n)) {
      const next = doorsIn(c);
      if (c === toCell) next.push(GOAL);
      for (const m of next) {
        if (m === n || done.has(m)) continue;
        const d = nd + dist(posOf(n), posOf(m));
        if (d < (best.get(m) ?? Infinity)) { best.set(m, d); prev.set(m, n); open.add(m); }
      }
    }
  }
  if (!best.has(GOAL)) return null;
  const route: RoutePoint[] = [];
  for (let n = GOAL; n !== START; n = prev.get(n)!) route.unshift(posOf(n));
  return route;
}

const isInterior = (cell: number): boolean => ((cell >>> 0) & 0xffff) >= 0x100;

/** How far outside an outside doorway the landscape leg aims, so it approaches the door instead of the wall behind it. */
export const DOORSTEP_M = 1.5;

/**
 * The point DOORSTEP_M outside an outside doorway: along the doorway's
 * normal, on the side away from its cell's centre. Without the cell's
 * centre, the doorway itself.
 */
export function doorstep(g: CellGraph, d: CellDoor): RoutePoint {
  const c = g.centers?.get(d.a);
  const h = Math.hypot(d.normal.x, d.normal.y);
  if (!c || h < 0.5) return withFeet(d, d.at); // no centre, or a floor/ceiling portal
  const nx = d.normal.x / h, ny = d.normal.y / h;
  const side = (c.x - d.at.x) * nx + (c.y - d.at.y) * ny > 0 ? -1 : 1;
  return withFeet(d, { x: d.at.x + side * nx * DOORSTEP_M, y: d.at.y + side * ny * DOORSTEP_M, z: d.at.z });
}

/**
 * A route that may start or end outdoors (a landscape cell, index < 0x100):
 * through the building's outside doorway (a CellPortal with OtherCellId
 * 0xFFFF) that makes the whole trip shortest. Interior to interior is
 * findRoute; outdoor to outdoor is a straight line ([to]).
 */
export function findRouteViaOutside(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3): RoutePoint[] | null {
  const r = routeViaOutside(g, fromCell, from, toCell, to);
  return r && r.filter((p, i) => i === 0 || !samePoint(p, r[i - 1]));
}

/**
 * The lowest upright opening a body walks through: the human Setup (0x02000001) is 1.835 m tall.
 * Holtburg's portals split cleanly by height. Doors are 2.49–3.9 m tall. Windows, service counters
 * and the tavern's bar are 1.5–1.8 m, with a sill up to 1 m above the floor. walk_to Sedor went to
 * the blacksmith's counter and a tavern walk to the bar, 2026-10-09.
 */
export const OPENING_MIN_HEIGHT_M = 1.83;

/** An upright portal (|normal.z| ≤ 0.7) too low for a body: a window, a counter, a vent. */
const tooLow = (d: CellDoor): boolean => Math.abs(d.normal.z) <= 0.7 && d.height !== undefined && d.height < OPENING_MIN_HEIGHT_M;

/** An outside doorway a body can walk through: an upright opening as tall as a body, not a window, counter or roof hole. */
export function walkableExit(d: CellDoor): boolean {
  return Math.abs(d.normal.z) <= 0.7 && !tooLow(d);
}

function routeViaOutside(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3): RoutePoint[] | null {
  const fromIn = isInterior(fromCell), toIn = isInterior(toCell);
  if (!fromIn && !toIn) return [to];
  const all: CellDoor[] = [];
  for (const list of g.doors.values()) for (const d of list) if (d.b === 0xFFFF) all.push(d);
  const doors = all.filter(walkableExit);
  const exits = doors.length ? doors : all; // a building with no door-sized opening: any way out beats none
  let best: RoutePoint[] | null = null;
  let bestLen = Infinity;
  const length = (start: Vec3, pts: RoutePoint[]): number => pts.reduce((t, p, i) => t + dist(i ? pts[i - 1] : start, p), 0);
  if (fromIn && toIn) {
    const inside = findRoute(g, fromCell, from, toCell, to);
    if (inside) return inside;
    // Two buildings: out through one doorway, across the landscape, in through another.
    for (const out of exits) {
      const leave = findRoute(g, fromCell, from, out.a, withFeet(out, out.at));
      if (!leave) continue;
      for (const into of exits) {
        const enter = findRoute(g, into.a, into.at, toCell, to);
        if (!enter) continue;
        const route = [...leave, doorstep(g, out), doorstep(g, into), withFeet(into, into.at), ...enter];
        const len = length(from, route);
        if (len < bestLen) { bestLen = len; best = route; }
      }
    }
    return best;
  }
  for (const e of exits) {
    let route: RoutePoint[] | null;
    if (toIn) {
      // Outdoors → the doorway → inside.
      const inside = findRoute(g, e.a, e.at, toCell, to);
      route = inside ? [doorstep(g, e), withFeet(e, e.at), ...inside] : null;
    } else {
      // Inside → the doorway → outdoors.
      const inside = findRoute(g, fromCell, from, e.a, withFeet(e, e.at));
      route = inside ? [...inside, doorstep(g, e), to] : null;
    }
    if (!route) continue;
    const len = length(from, route);
    if (len < bestLen) { bestLen = len; best = route; }
  }
  return best;
}

/**
 * The client's playerYaw that faces from `from` toward `to` (AC landblock
 * frame). The client moves forward by (−sin yaw, −cos yaw) in Three's (X, Z),
 * and Three X/Z are AC x/y (ServerObjectManager acPositionToWorld).
 */
export function yawToward(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.y - from.y));
}

/**
 * Whether feet height `z` is on the level of route point `p`. A wall doorway's
 * centroid sits 1.5–3 m above its floor; a floor portal's is the floor itself.
 * Off by more means the player stands on a floor stacked above or below it
 * (the academy's stairwells overlap in plan).
 */
export function onLevel(p: RoutePoint, z: number): boolean {
  return p.floor ? Math.abs(z - p.z) < 2 : z > p.z - 4 && z < p.z + 1;
}
