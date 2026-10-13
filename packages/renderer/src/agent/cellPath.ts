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
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { Environment, type CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { TerrainCollision } from '@ac/shared';
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
/**
 * An outside doorway (b = 0xFFFF) is `grounded` when a body on the landscape can walk up to it: the terrain is at
 * its feet, or the walkable surfaces outside it (the building's own porch, a landblock static's ramp or steps) join
 * up, a step at a time, down to the terrain. false: a door on a ledge with no way up to it (Nanto's scriveners'
 * hall 0xE63D: four doors 5 m up on porches no stair reaches, and a ground door up a ramp static, 2026-10-11).
 * undefined: not known (no terrain to measure against).
 */
export interface CellDoor { a: number; b: number; at: Vec3; normal: Vec3; height?: number; bottom?: number; below?: number; climb?: boolean; landing?: number | null; grounded?: boolean }

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
export interface FloorPoly { pts: Vec3[]; n: Vec3; d: number }

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
   * The walkable surfaces just outside each outside doorway, joined a step at a time (its porch, a ramp up to
   * it): whether a body standing on the landscape is already up there (CellDoor.grounded).
   */
  exitFloors?: Map<CellDoor, FloorPoly[]>;
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

/**
 * `landHeightTable`: the region's LandDefs.LandHeightTable (RegionDesc 0x13000000), for the terrain under each
 * outside doorway (CellDoor.grounded). Without it no doorway's grounding is known.
 */
export interface CellGraphOptions { landHeightTable?: ArrayLike<number> }

/** The human body (Setup 0x02000001): how high it steps up (StepUpHeight, 0.6 m in the end-of-retail DAT). */
const HUMAN_SETUP = 0x02000001;

/** Read every EnvCell of `landblock` (0xXXYY0000) and its doors. */
export function loadCellGraph(cellDat: DatDatabase, portalDat: DatDatabase, landblock: number, opts: CellGraphOptions = {}): CellGraph {
  const lb = (landblock & 0xFFFF0000) >>> 0;
  const envs = new Map<number, Environment | null>();
  const doors = new Map<number, CellDoor[]>();
  const centers = new Map<number, Vec3>();
  const floors = new Map<number, FloorPoly[]>();
  let complete = true;
  // The landblock's LandblockInfo says how many EnvCells it has (NumCells, numbered from 0x0100; any past them are
  // orphans). Without it, read on until the first gap. A streamed store answers a cell still in flight with null:
  // a gap below NumCells is a miss, not the end, so the graph is incomplete (not kept) rather than cut short.
  const infoData = cellDat.getFileData((lb | 0xFFFE) >>> 0);
  let info: LandblockInfo | null = null;
  if (infoData) { try { info = new LandblockInfo(new DatReader(infoData)); } catch { info = null; } }
  const last = info ? 0x0100 + info.numCells - 1 : 0xFFFD;
  for (let n = 0x0100; n <= last; n++) {
    const id = (lb | n) >>> 0;
    const data = cellDat.getFileData(id);
    if (!data) { if (info || n === 0x0100) complete = false; if (info) continue; break; } // none at all may be a bundle still in flight
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
  const graph: CellGraph = { landblock: lb, doors, centers, airCells, complete };
  if (info && opts.landHeightTable) {
    const r = groundExits(graph, cellDat, portalDat, info, opts.landHeightTable);
    if (!r) graph.complete = false;
  }
  return graph;
}

/** Height of polygon `f`'s plane at (x, y). */
const zOn = (f: FloorPoly, x: number, y: number): number => (f.d - f.n.x * x - f.n.y * y) / f.n.z;

/** How far apart (seen from above) two surfaces' edges may be and still join: a body's foot crosses the seam. */
const SEAM_M = 0.25;

/**
 * Whether a body steps from surface `a` onto surface `b`: a corner of one lies on an edge of the other (within
 * SEAM_M seen from above) no more than a step (`step`) above or below it.
 */
function joins(a: FloorPoly, b: FloorPoly, step: number): boolean {
  const touch = (p: FloorPoly, q: FloorPoly): boolean => {
    for (const v of p.pts) {
      for (let i = 0; i < q.pts.length; i++) {
        const e0 = q.pts[i], e1 = q.pts[(i + 1) % q.pts.length];
        const ex = e1.x - e0.x, ey = e1.y - e0.y;
        const l2 = ex * ex + ey * ey;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((v.x - e0.x) * ex + (v.y - e0.y) * ey) / l2)) : 0;
        const cx = e0.x + ex * t, cy = e0.y + ey * t;
        if (Math.hypot(v.x - cx, v.y - cy) <= SEAM_M && Math.abs(v.z - (e0.z + (e1.z - e0.z) * t)) <= step) return true;
      }
    }
    return false;
  };
  return touch(a, b) || touch(b, a);
}

/**
 * Mark each outside doorway grounded or not (CellDoor.grounded) and keep the surfaces outside it
 * (CellGraph.exitFloors). The surfaces are the walkable physics polygons of the landblock's buildings and
 * statics (LandblockInfo Buildings and Objects); the ground is the terrain (CellLandblock heights through the
 * LandHeightTable, split as the client splits it). From the surface a body stands on just outside the doorway,
 * the walk spreads to every surface that joins it a step up or down (the human StepUpHeight); it is grounded
 * when one of them meets the terrain. Returns false when a file it needed was not readable yet.
 */
function groundExits(g: CellGraph, cellDat: DatDatabase, portalDat: DatDatabase, info: LandblockInfo, table: ArrayLike<number>): boolean {
  const lbData = cellDat.getFileData((g.landblock | 0xFFFF) >>> 0);
  const humanData = portalDat.getFileData(HUMAN_SETUP);
  if (!lbData || !humanData) return false;
  let land: CellLandblock, step: number;
  try { land = CellLandblock.read(new DatReader(lbData)); step = new SetupModel(new DatReader(humanData)).stepUpHeight; } catch { return true; }
  const heights = land.heights.map((h) => table[h]);
  const bx = (g.landblock >>> 24) & 0xFF, by = (g.landblock >>> 16) & 0xFF;
  const ground = (x: number, y: number): number => TerrainCollision.sampleHeight(heights, x, y, bx, by);
  const polys: FloorPoly[] = [];
  let ok = true;
  for (const b of info.buildings) { const r = staticFloors(portalDat, b.modelId, b.frame); polys.push(...r.polys); ok &&= r.ok; }
  for (const o of info.objects) { const r = staticFloors(portalDat, o.id, o.frame); polys.push(...r.polys); ok &&= r.ok; }
  // A surface meets the terrain where a corner is within a step of it, or its edge passes through it.
  const meetsGround = (f: FloorPoly): boolean => {
    let above = false, below = false;
    for (const v of f.pts) {
      const dz = v.z - ground(v.x, v.y);
      if (Math.abs(dz) <= step) return true;
      if (dz > 0) above = true; else below = true;
    }
    return above && below;
  };
  const exitFloors = new Map<CellDoor, FloorPoly[]>();
  for (const list of g.doors.values()) for (const d of list) {
    if (d.b !== 0xFFFF || !walkableExit(d) || d.bottom === undefined) continue;
    const c = g.centers?.get(d.a);
    const h = Math.hypot(d.normal.x, d.normal.y);
    if (!c) continue;
    const nx = d.normal.x / h, ny = d.normal.y / h;
    const side = (c.x - d.at.x) * nx + (c.y - d.at.y) * ny > 0 ? -1 : 1;
    // Where a body's feet are just through the doorway, on the outside.
    const q = { x: d.at.x + side * nx * 0.3, y: d.at.y + side * ny * 0.3 };
    const feet = d.bottom;
    const seen = new Set<FloorPoly>(polys.filter((f) => insideXY(f.pts, q.x, q.y) && Math.abs(zOn(f, q.x, q.y) - feet) <= step));
    const queue = [...seen];
    let grounded = Math.abs(ground(q.x, q.y) - feet) <= step;
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i];
      if (meetsGround(f)) grounded = true;
      for (const o of polys) if (!seen.has(o) && joins(f, o, step)) { seen.add(o); queue.push(o); }
    }
    d.grounded = grounded;
    exitFloors.set(d, queue);
  }
  g.exitFloors = exitFloors;
  return ok;
}

/** Whether `p` (feet) stands on one of the surfaces outside doorway `d`: already up on its porch. */
function standsOutside(g: CellGraph, d: CellDoor, p: Vec3): boolean {
  return (g.exitFloors?.get(d) ?? []).some((f) => insideXY(f.pts, p.x, p.y) && Math.abs(zOn(f, p.x, p.y) - p.z) <= 0.5);
}

const dist = (p: Vec3, q: Vec3): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/**
 * A route point: a doorway's centroid (`floor` when it is a horizontal portal, |normal.z| > 0.7) or the target.
 * `feet` is a wall doorway's floor height, where a body's feet pass through it. The centroid is
 * 1.25–1.55 m above that in a 2.5–3.1 m door: the Holtburg tavern, 2026-10-09.
 */
export type RoutePoint = Vec3 & { floor?: boolean; feet?: number; drop?: number; landing?: number;
  /** The route's end: where a body stands to deal with a goal across a counter or window (counterSpot), not the goal itself. */
  across?: boolean };
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
  const all = opts.avoid?.length ? [...avoid, ...opts.avoid] : avoid;
  return searchRoute(g, fromCell, from, toCell, to, all, true, opts) ?? (opts.bodyOnly ? null : searchRoute(g, fromCell, from, toCell, to, all, false, opts));
}

/**
 * `maxDrop`: the highest fall through a floor opening the route may take (metres; default no limit).
 * The agent sets it from the fall damage the player's health can take (jumpPlan.safeDropHeight).
 */
export interface RouteOptions {
  maxDrop?: number;
  /**
   * Where a door stands that a Use did not open (locked, or opened only by a key or a quest item): every doorway
   * within CLOSED_DOOR_M of one is left out of the route. The Holtburg drudge statue's Pedestal Weak Spot (a Door
   * weenie in the pedestal's opening 0xA9B40178) sent a walk to open it again and again (2026-10-11).
   */
  closed?: Vec3[];
  /**
   * Doorways (their centroids, as a route point gives them) the walk found it can't pass: a fall through a
   * floor opening with a rail round it higher than the player's jump clears. The AC1999 tutorial's balcony
   * fence is 2 m tall: below Jump 65 the way down is the ramp and the key room's locked door (2026-10-11).
   */
  avoid?: Vec3[];
  /** Only openings a body walks through (no window or counter as a last resort). */
  bodyOnly?: boolean;
}

/** How near a doorway a door that would not open stands (seen from above; within 3 m of height). */
export const CLOSED_DOOR_M = 2.5;
const shutIn = (d: CellDoor, closed: Vec3[] | undefined): boolean =>
  !!closed?.some((c) => Math.hypot(c.x - d.at.x, c.y - d.at.y) <= CLOSED_DOOR_M && Math.abs(c.z - (d.bottom ?? d.at.z)) <= 3);

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
  const usable = (d: CellDoor): boolean => d.b !== 0xFFFF && !(bodySized && tooLow(d)) && !avoid.some((a) => samePoint(a, d.at)) && !shutIn(d, opts.closed);
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
  const nodes: string[] = [];
  for (let n = GOAL; n !== START; n = prev.get(n)!) nodes.unshift(n);
  // A wall doorway into a floorless cell, with the route's next step a fall through that cell's floor
  // opening, is not a point a body stands on: the cell is air, and a rail or fence often stands in the
  // doorway itself. The AC1999 tutorial's balcony 0x017E012E looks into the air over the training pit
  // (0x017E012D) through a doorway whose centre is in the line of its fence (statics 0x020003B3/B4), so the
  // walk to that point never arrived and the drop was never tried (2026-10-11). The walk goes from the
  // doorway before straight to the drop: its search finds the edge (or the rail) to drop or jump from.
  const intoAir = (n: string, m: string): boolean => {
    if (n === START || n === GOAL || m === GOAL || posOf(n).floor || posOf(m).drop === undefined) return false;
    const below = door.get(m)?.below;
    return (cellsOf.get(n) ?? []).some((c) => c !== below && !!g.airCells?.has(c) && (cellsOf.get(m) ?? []).includes(c));
  };
  return nodes.filter((n, i) => !intoAir(n, nodes[i + 1])).map(posOf);
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
  // A goal behind a counter (a shopkeeper in his booth): no body walks to it; the route goes to where a player stands
  // to deal with it, across the counter. The route used to climb through the counter as "any opening beats none"
  // and the walk stood at it for 45 s (Renald the Elder, behind Holtburg's street window 0xA9B4014F, 2026-10-12).
  let r = isInterior(toCell) && !opts.bodyOnly ? routeViaOutside(g, fromCell, from, toCell, to, { ...opts, bodyOnly: true }) : null;
  if (!r && isInterior(toCell)) {
    const spot = counterSpot(g, toCell, to);
    if (spot) {
      const there = spot.cell === toCell ? null : routeViaOutside(g, fromCell, from, spot.cell, spot.at, { ...opts, bodyOnly: true });
      if (there) r = [...there.slice(0, -1), { ...spot.at, across: true }];
    }
  }
  r ??= routeViaOutside(g, fromCell, from, toCell, to, opts);
  return r && r.filter((p, i) => i === 0 || !samePoint(p, r![i - 1]));
}

/** How far beyond a counter or window's plane a body stands to deal across it (its radius, 0.48 m, and a margin). */
export const COUNTER_STAND_M = 0.8;

/**
 * Where a player stands to deal with someone at `to` in `toCell` when only counters and windows lead there: the cells
 * reached from `toCell` through too-low openings (the booth, the thin cell of a service window) are the far side; each
 * too-low opening out of them onto a cell outside that set, or onto the landscape, has a standing spot COUNTER_STAND_M
 * past its plane. The spot nearest the goal (the service window it stands at). Null when none.
 */
export function counterSpot(g: CellGraph, toCell: number, to: Vec3): { cell: number; at: RoutePoint } | null {
  toCell >>>= 0;
  const behind = new Set<number>([toCell]);
  const queue = [toCell];
  while (queue.length) {
    const c = queue.shift()!;
    for (const d of g.doors.get(c) ?? []) if (d.b !== 0xFFFF && tooLow(d) && !behind.has(d.b >>> 0)) { behind.add(d.b >>> 0); queue.push(d.b >>> 0); }
  }
  let best: { cell: number; at: RoutePoint; d: number } | null = null;
  for (const c of behind) {
    const centre = g.centers?.get(c);
    for (const d of g.doors.get(c) ?? []) {
      if (!tooLow(d) || (d.b !== 0xFFFF && behind.has(d.b >>> 0))) continue;
      const h = Math.hypot(d.normal.x, d.normal.y);
      if (!centre || h < 0.5) continue;
      const nx = d.normal.x / h, ny = d.normal.y / h;
      // Away from the booth's side of the opening.
      const side = (centre.x - d.at.x) * nx + (centre.y - d.at.y) * ny > 0 ? -1 : 1;
      const feet = d.b === 0xFFFF ? undefined : (g.doors.get(d.b >>> 0) ?? []).length ? counterFloor(g, d) : undefined;
      const at: RoutePoint = { x: d.at.x + side * nx * COUNTER_STAND_M, y: d.at.y + side * ny * COUNTER_STAND_M, z: feet ?? to.z };
      const cell = d.b === 0xFFFF ? ((toCell & 0xffff0000) | 0x0001) >>> 0 : d.b >>> 0;
      const dd = Math.hypot(at.x - to.x, at.y - to.y);
      if (!best || dd < best.d) best = { cell, at, d: dd };
    }
  }
  return best && { cell: best.cell, at: best.at };
}

/** The floor a body stands on in front of a counter: the lowest walk-in doorway's sill of the cell on the far side, else the goal's. */
function counterFloor(g: CellGraph, d: CellDoor): number | undefined {
  const sills = (g.doors.get(d.b >>> 0) ?? []).filter((x) => !tooLow(x) && Math.abs(x.normal.z) <= 0.7 && x.bottom !== undefined).map((x) => x.bottom!);
  return sills.length ? Math.min(...sills) : undefined;
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
  if (fromIn && toIn) {
    const inside = findRoute(g, fromCell, from, toCell, to, [], opts);
    if (inside) return inside;
  }
  const all: CellDoor[] = [];
  for (const list of g.doors.values()) for (const d of list) if (d.b === 0xFFFF && !shutIn(d, opts.closed)) all.push(d);
  const doors = all.filter(walkableExit);
  const exits = doors.length ? doors : all; // a building with no door-sized opening: any way out beats none
  // A doorway the landscape walks up to, or one whose porch the outdoor end already stands on, before a door on a
  // ledge no stair reaches: Nanto's scriveners' hall has four doors 5 m up and one up a ramp (2026-10-11). With
  // none of those giving a route, any doorway (the walk's jumps may still get there).
  const reachable = (e: CellDoor, outdoorEnd: Vec3 | null): boolean => e.grounded !== false || (outdoorEnd !== null && standsOutside(g, e, outdoorEnd));
  const outdoorEnd = fromIn ? (toIn ? null : to) : from;
  const preferred = exits.filter((e) => reachable(e, outdoorEnd));
  return (preferred.length ? bestViaExits(g, fromCell, from, toCell, to, preferred, opts) : null)
    ?? (preferred.length < exits.length ? bestViaExits(g, fromCell, from, toCell, to, exits, opts) : null);
}

/** The shortest route through one of `exits` (out of one building and into another through two of them). */
function bestViaExits(g: CellGraph, fromCell: number, from: Vec3, toCell: number, to: Vec3, exits: CellDoor[], opts: RouteOptions): RoutePoint[] | null {
  const fromIn = isInterior(fromCell), toIn = isInterior(toCell);
  let best: RoutePoint[] | null = null;
  let bestLen = Infinity;
  const length = (start: Vec3, pts: RoutePoint[]): number => pts.reduce((t, p, i) => t + dist(i ? pts[i - 1] : start, p), 0);
  if (fromIn && toIn) {
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
