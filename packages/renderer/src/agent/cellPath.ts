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
import { Environment, type CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { placementFrameOf } from '../models/SetupModelGroup.js';

export interface Vec3 { x: number; y: number; z: number }

/**
 * One doorway between two cells (or a cell and the outside, other = 0xFFFF):
 * its polygon's centroid and unit normal (Newell), both in the landblock frame.
 */
/**
 * `height` is the opening's vertical extent; `bottom` is its lowest point (a doorway's floor: where feet go through).
 * A horizontal (floor / ceiling) portal also says which cell is `below` it, whether that cell's walkable floor
 * `climb`s to within CLIMB_REACH_M of it (a stair rising through the opening; else a body only falls through it),
 * and the `landing`: the walkable height in the lower cell under the opening (null = none under it).
 */
export interface CellDoor { a: number; b: number; at: Vec3; normal: Vec3; height?: number; bottom?: number; below?: number; climb?: boolean; landing?: number | null }

/** PhysicsGlobals.FloorZ: the least normal.z a walkable polygon has (ACE ObjectInfo.GetWalkableZ). */
const FLOOR_Z = 0.66417414618662751;

/**
 * How near a horizontal portal the lower cell's walkable floor must rise for a body to go UP through it:
 * the planner's own vertical reach (navPlanner's 1.5 m). The Banderling Ruin atrium (landblock 0x01E0) is a
 * 3 × 3 grid of ground rooms (floor z 0) open to the air cells above them at z 6: no floor rises toward those
 * ceiling portals, so the way up is the corner ramps, never straight up through the hole (2026-10-10).
 */
export const CLIMB_REACH_M = 1.5;

/** A walkable polygon of a cell in the landblock frame: its points and plane (n · p = d). */
interface FloorPoly { pts: Vec3[]; n: Vec3; d: number }

/** The walkable polygons (normal.z ≥ FloorZ) of a cell's physics polygons, through the cell's frame. */
function walkablePolys(cell: EnvCell, struct: CellStruct): FloorPoly[] {
  const out: FloorPoly[] = [];
  for (const poly of struct.physicsPolygons.values()) {
    if (poly.vertexIndices.length < 3) continue;
    const pts = poly.vertexIndices.map((vi) => frameToParent(cell.position, struct.vertexArray.vertices.get(vi)!.origin));
    const n = newell(pts);
    if (n.z < FLOOR_Z) continue;
    out.push({ pts, n, d: n.x * pts[0].x + n.y * pts[0].y + n.z * pts[0].z });
  }
  return out;
}

/**
 * The walkable polygons of a cell's static object (a Setup's parts at its placement frame, or a lone GfxObj),
 * from their physics polygons, in the landblock frame. A staircase is often a static, not the cell's own
 * geometry: the Holtburg archmage's tower climbs to its upper floor on Setup 0x020001B4 (2026-10-10).
 * `ok` is false when a file wasn't readable yet (a streamed set's miss).
 */
function staticFloors(portalDat: DatDatabase, id: number, at: Frame): { polys: FloorPoly[]; ok: boolean } {
  const polys: FloorPoly[] = [];
  let ok = true;
  const addGfx = (gid: number, part: Frame | null): void => {
    const data = portalDat.getFileData(gid);
    if (!data) { ok = false; return; }
    let gfx: GfxObj;
    try { gfx = new GfxObj(new DatReader(data)); } catch { return; }
    const verts = gfx.vertexArray?.vertices;
    if (!verts) return;
    for (const poly of gfx.physicsPolygons.values()) {
      if (poly.vertexIndices.length < 3) continue;
      const pts = poly.vertexIndices.map((vi) => { const o = verts.get(vi)!.origin; return frameToParent(at, part ? frameToParent(part, o) : o); });
      const n = newell(pts);
      if (n.z < FLOOR_Z) continue;
      polys.push({ pts, n, d: n.x * pts[0].x + n.y * pts[0].y + n.z * pts[0].z });
    }
  };
  const kind = id >>> 24;
  if (kind === 0x01) addGfx(id, null);
  else if (kind === 0x02) {
    const data = portalDat.getFileData(id);
    if (!data) return { polys, ok: false };
    let setup: SetupModel;
    try { setup = new SetupModel(new DatReader(data)); } catch { return { polys, ok }; }
    const placement = placementFrameOf(setup);
    setup.parts.forEach((gid, i) => addGfx(gid, placement?.frames[i] ?? null));
  }
  return { polys, ok };
}

/** The unit normal of a polygon by Newell's method (vertex order: AC's front side). */
function newell(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let j = 0; j < pts.length; j++) {
    const c = pts[j], n = pts[(j + 1) % pts.length];
    nx += (c.y - n.y) * (c.z + n.z); ny += (c.z - n.z) * (c.x + n.x); nz += (c.x - n.x) * (c.y + n.y);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / l, y: ny / l, z: nz / l };
}

/** Point (x, y) inside the polygon's outline seen from above (even-odd). */
function insideXY(pts: Vec3[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The highest walkable height at (x, y) at or under `top` among `floors`, or null. */
function floorUnder(floors: FloorPoly[], x: number, y: number, top: number): number | null {
  let best: number | null = null;
  for (const f of floors) {
    if (!insideXY(f.pts, x, y)) continue;
    const z = (f.d - f.n.x * x - f.n.y * y) / f.n.z;
    if (z <= top + 0.05 && (best === null || z > best)) best = z;
  }
  return best;
}

export interface CellGraph {
  landblock: number;
  /** Cell id (0xXXYYCCCC) → the doors of that cell. */
  doors: Map<number, CellDoor[]>;
  /** Cell id → the mean of its geometry's vertices (landblock frame): which side of a doorway is inside. */
  centers?: Map<number, Vec3>;
  /**
   * Cells with no walkable floor at all: the air over an atrium or a pit (Banderling Ruin 0x01E00120,
   * open down to 0x01E00105). A body that goes in falls through the cell's floor opening, so a route
   * through one only goes down.
   */
  airCells?: Set<number>;
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
  const floors = new Map<number, FloorPoly[]>();
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
      const fl = walkablePolys(cell, struct);
      for (const st of cell.staticObjects) {
        const r = staticFloors(portalDat, st.id, st.frame);
        fl.push(...r.polys);
        if (!r.ok) complete = false;
      }
      floors.set(id, fl);
    }
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
  // Horizontal portals: which side is below, whether its floor climbs to the opening, and where a fall through it lands.
  for (const list of doors.values()) for (const d of list) {
    if (Math.abs(d.normal.z) <= 0.7 || d.b === 0xFFFF) continue;
    const ca = centers.get(d.a), cb = centers.get(d.b);
    if (!ca || !cb) continue;
    const below = ca.z < cb.z ? d.a : d.b;
    const fl = floors.get(below) ?? [];
    const top = fl.reduce((t, f) => Math.max(t, ...f.pts.map((q) => q.z)), -Infinity);
    d.below = below;
    d.climb = top >= d.at.z - CLIMB_REACH_M;
    d.landing = floorUnder(fl, d.at.x, d.at.y, d.at.z);
  }
  const airCells = new Set([...floors].filter(([, f]) => f.length === 0).map(([c]) => c));
  // A thin floorless cell a stair climbs straight through (the archmage tower's 0.2 m slab 0xA9B4011E between
  // the stair's top at 68.8 and the upper floor at 69): the stair that climbs into it climbs on out of it.
  for (const c of [...airCells]) {
    const list = doors.get(c) ?? [];
    const into = list.filter((d) => d.below !== undefined && d.below !== c && d.climb);
    const out = list.filter((d) => d.below === c && into.some((i) => d.at.z - i.at.z <= CLIMB_REACH_M));
    if (!into.length || !out.length) continue;
    airCells.delete(c);
    for (const d of out) {
      d.climb = true;
      // The upper cell's copy of the same opening.
      for (const e of doors.get(d.b) ?? []) if (e.b === c && samePoint(e.at, d.at)) e.climb = true;
    }
  }
  return { landblock: lb, doors, centers, airCells, complete };
}

const dist = (p: Vec3, q: Vec3): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/**
 * A route point: a doorway's centroid (`floor` when it is a horizontal portal, |normal.z| > 0.7) or the target.
 * `feet` is a wall doorway's floor height, where a body's feet pass through it. The centroid is
 * 1.25–1.55 m above that in a 2.5–3.1 m door: the Holtburg tavern, 2026-10-09.
 */
export type RoutePoint = Vec3 & { floor?: boolean; feet?: number; drop?: number; landing?: number };
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
export function findRoute(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, avoid: Vec3[] = [], opts: RouteOptions = {}): RoutePoint[] | null {
  // Through body-sized openings when there's a way; any opening beats none.
  return searchRoute(g, fromCell, from, toCell, to, avoid, true, opts) ?? searchRoute(g, fromCell, from, toCell, to, avoid, false, opts);
}

/**
 * `maxDrop`: the highest fall through a floor opening the route may take (metres; default no limit).
 * The agent sets it from the fall damage the player's health can take (jumpPlan.safeDropHeight).
 */
export interface RouteOptions { maxDrop?: number }

/**
 * A fall through an opening costs this much extra route length: a walk round by stairs or a ramp up
 * to this much longer is taken instead (the agent walks when a walk exists, and drops only when not).
 */
export const DROP_PENALTY_M = 30;

/**
 * Passing door `d` from inside cell `c`: up through a floor opening only where a stair climbs to it,
 * down through one by its stair or as a fall onto a floor under it no higher than `maxDrop`.
 */
function passable(d: CellDoor, c: number, maxDrop: number): boolean {
  if (d.below === undefined || d.climb) return true;
  if (d.below === c) return false; // up through a hole in the ceiling: no floor reaches it
  return d.landing !== null && d.landing !== undefined && d.at.z - d.landing <= maxDrop;
}

function searchRoute(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, avoid: Vec3[], bodySized: boolean, opts: RouteOptions = {}): RoutePoint[] | null {
  const maxDrop = opts.maxDrop ?? Infinity;
  fromCell >>>= 0; toCell >>>= 0;
  if (fromCell === toCell) return [to];
  const key = (d: CellDoor): string => (d.a < d.b ? `${d.a}:${d.b}` : `${d.b}:${d.a}`);
  // Node positions: average both sides' centroid copies (they coincide up to float error).
  const pos = new Map<string, RoutePoint>();
  const door = new Map<string, CellDoor>();
  const cellsOf = new Map<string, number[]>();
  const usable = (d: CellDoor): boolean => d.b !== 0xFFFF && !(bodySized && tooLow(d)) && !avoid.some((a) => samePoint(a, d.at));
  for (const [cell, list] of g.doors) for (const d of list) {
    if (!usable(d)) continue;
    const k = key(d);
    if (!door.has(k)) door.set(k, d);
    if (!pos.has(k)) {
      const fall = d.below !== undefined && !d.climb && d.landing !== null && d.landing !== undefined;
      pos.set(k, Math.abs(d.normal.z) > 0.7 ? { ...d.at, floor: true, ...(fall ? { drop: d.at.z - d.landing!, landing: d.landing! } : {}) } : withFeet(d, d.at));
    }
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
        const dm = door.get(m);
        if (dm && !passable(dm, c, maxDrop)) continue;
        // In a cell with no floor the only way on is down through its floor opening (from where we
        // stand, any way: a body reported in one is at its edge, or already falling).
        if (n !== START && g.airCells?.has(c) && m !== GOAL && !(dm && dm.below !== undefined && dm.below !== c)) continue;
        const d = nd + dist(posOf(n), posOf(m)) + (posOf(m).drop !== undefined ? DROP_PENALTY_M : 0);
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
export function findRouteViaOutside(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, opts: RouteOptions = {}): RoutePoint[] | null {
  const r = routeViaOutside(g, fromCell, from, toCell, to, opts);
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

function routeViaOutside(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, opts: RouteOptions): RoutePoint[] | null {
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
    const inside = findRoute(g, fromCell, from, toCell, to, [], opts);
    if (inside) return inside;
    // Two buildings: out through one doorway, across the landscape, in through another.
    for (const out of exits) {
      const leave = findRoute(g, fromCell, from, out.a, withFeet(out, out.at), [], opts);
      if (!leave) continue;
      for (const into of exits) {
        const enter = findRoute(g, into.a, into.at, toCell, to, [], opts);
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
      const inside = findRoute(g, e.a, e.at, toCell, to, [], opts);
      route = inside ? [doorstep(g, e), withFeet(e, e.at), ...inside] : null;
    } else {
      // Inside → the doorway → outdoors.
      const inside = findRoute(g, fromCell, from, e.a, withFeet(e, e.at), [], opts);
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
