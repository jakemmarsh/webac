/**
 * UtilityBelt's Dungeon Maps, the map itself (docs/vtank-parity-gaps.md §11.7; UtilityBelt is MIT, ported
 * from 5fe9825a: Lib/Dungeon/Dungeon.cs, DungeonCell.cs, DungeonLayer.cs, IsDungeon.cs).
 *
 * UB draws each cell with a pre-drawn top-down tile per Environment id (lifestoned.org's tile images,
 * recoloured to its Walls / InnerWalls / RampedWalls / Stairs / Floors colours). Here the same five kinds
 * come from the cell's own geometry in this era's DATs: each EnvCell's CellStruct physics polygons (what
 * you walk on and bump into), placed by the cell's frame, seen from above. A polygon whose normal points
 * up is ground: a floor at the cell's lowest level, stairs above it or on a slope. A standing polygon is a
 * wall: a full one from the floor up, an inner one (a ledge, a step's riser) otherwise, a ramped one when
 * its foot slopes. Ceilings are left out. The winding was measured on the end-of-retail Holtburg Dungeon
 * (0x01F6): of the level polygons, the up-facing ones (counter-clockwise from above) are 99% in the lower
 * half of their cell, the down-facing ones 98% in the upper half.
 *
 * Floors are UB's: a cell belongs to layer ⌊(z + 3) / 6⌋ · 6 of its frame's z (DungeonLayer.roundedZ).
 */
import type { CellStruct } from '@ac/dat-parser/file-types/Environment.js';

export type DungeonPolyKind = 'floor' | 'stairs' | 'wall' | 'inner' | 'ramped';

/** One polygon seen from above: its kind and its landblock-local x, y points (flattened pairs). */
export interface DungeonMapPoly { kind: DungeonPolyKind; pts: number[]; z: number }

export interface DungeonMapCell {
  id: number;
  /** The cell frame's origin, landblock-local. */
  x: number; y: number; z: number;
  layer: number;
  polys: DungeonMapPoly[];
}

export interface DungeonMap {
  landblock: number;
  cells: Map<number, DungeonMapCell>;
  /** Cells by UB layer (⌊(z + 3) / 6⌋ · 6), lowest first. */
  layers: Map<number, DungeonMapCell[]>;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
}

export interface DungeonCellGeometry {
  cellStruct: Pick<CellStruct, 'vertexArray' | 'physicsPolygons' | 'polygons'>;
  position: { origin: { x: number; y: number; z: number }; orientation: { w: number; x: number; y: number; z: number } };
}

/** Where the map reads a landblock's cells (main.ts: DungeonRenderer / EnvCellRenderer over the era's cell.dat). */
export interface DungeonMapSource {
  cellIds(landblock: number): number[];
  cell(cellId: number): DungeonCellGeometry | null;
}

/** UB's floor bucket (DungeonLayer.roundedZ, TrackedObject ZLayer). */
export const layerOf = (z: number): number => Math.floor((z + 3) / 6) * 6;

/** EnvCellFlags.SeenOutside (ACE EnvCellFlags): a building's interior, not a dungeon. */
export const ENV_CELL_SEEN_OUTSIDE = 0x01;

/**
 * UB Dungeon.IsDungeon: an interior cell (low word ≥ 0x100) whose EnvCell isn't SeenOutside. `flags` null
 * (the cell isn't known) counts as a dungeon, as UB's missing-cell branch does.
 */
export function isDungeonCell(cellId: number, flags: number | null): boolean {
  if ((cellId & 0xffff) < 0x100) return false;
  return flags === null || (flags & ENV_CELL_SEEN_OUTSIDE) === 0;
}

type V3 = { x: number; y: number; z: number };

function rotate(q: { w: number; x: number; y: number; z: number }, v: V3): V3 {
  // v' = q v q*, as v + w·t + q×t with t = 2 q×v.
  const { w, x, y, z } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}

/** Newell's normal (unit) of a polygon: counter-clockwise seen from where it points. */
export function polygonNormal(vs: V3[]): V3 {
  let nx = 0; let ny = 0; let nz = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!; const b = vs[(i + 1) % vs.length]!;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / l, y: ny / l, z: nz / l };
}

/** Level within this much (m) of the cell's floor is floor, not a step. */
const FLOOR_BAND = 0.6;
/** A standing polygon this tall (m) from the floor up is a full wall. */
const FULL_WALL = 2;

/**
 * The kind of one polygon (world-placed vertices) in a cell whose ground starts at `floorZ`, or null for a
 * ceiling or an overhang (never drawn).
 */
export function classifyPolygon(vs: V3[], floorZ: number): DungeonPolyKind | null {
  if (vs.length < 3) return null;
  const n = polygonNormal(vs);
  let minZ = Infinity; let maxZ = -Infinity; let sumZ = 0;
  for (const v of vs) { minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z); sumZ += v.z; }
  if (n.z > 0.95) return sumZ / vs.length <= floorZ + FLOOR_BAND ? 'floor' : 'stairs';
  if (n.z > 0.3) return 'stairs';
  if (n.z < -0.3) return null;
  // Standing: its foot is its lowest edge (the two lowest points).
  const low = [...vs].sort((a, b) => a.z - b.z);
  if (Math.abs(low[1]!.z - low[0]!.z) > 0.5) return 'ramped';
  return minZ <= floorZ + FLOOR_BAND && maxZ - minZ >= FULL_WALL ? 'wall' : 'inner';
}

/** One cell placed and classified. */
export function buildDungeonCell(id: number, g: DungeonCellGeometry): DungeonMapCell {
  const { origin, orientation } = g.position;
  const verts = g.cellStruct.vertexArray.vertices;
  const polys = g.cellStruct.physicsPolygons.size ? g.cellStruct.physicsPolygons : g.cellStruct.polygons;
  const placed: V3[][] = [];
  for (const [, p] of polys) {
    const vs: V3[] = [];
    for (const k of p.vertexIndices) {
      const v = verts.get(k);
      if (!v) continue;
      const r = rotate(orientation, v.origin);
      vs.push({ x: r.x + origin.x, y: r.y + origin.y, z: r.z + origin.z });
    }
    if (vs.length >= 3) placed.push(vs);
  }
  // The cell's floor: its lowest up-facing level polygon (else its lowest point).
  let floorZ = Infinity;
  for (const vs of placed) {
    if (polygonNormal(vs).z > 0.95) floorZ = Math.min(floorZ, Math.min(...vs.map((v) => v.z)));
  }
  if (!Number.isFinite(floorZ)) for (const vs of placed) for (const v of vs) floorZ = Math.min(floorZ, v.z);
  const out: DungeonMapPoly[] = [];
  for (const vs of placed) {
    const kind = classifyPolygon(vs, floorZ);
    if (!kind) continue;
    const pts: number[] = [];
    for (const v of vs) pts.push(v.x, v.y);
    out.push({ kind, pts, z: vs.reduce((s, v) => s + v.z, 0) / vs.length });
  }
  return { id, x: origin.x, y: origin.y, z: origin.z, layer: layerOf(origin.z), polys: out };
}

/** The whole dungeon (UB Dungeon.LoadCells): every interior cell of the landblock, by layer. Null when it has none. */
export function buildDungeonMap(landblock: number, src: DungeonMapSource): DungeonMap | null {
  const cells = new Map<number, DungeonMapCell>();
  const layers = new Map<number, DungeonMapCell[]>();
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const id of src.cellIds(landblock)) {
    let g: DungeonCellGeometry | null = null;
    try { g = src.cell(id); } catch { g = null; }
    if (!g) continue;
    const c = buildDungeonCell(id, g);
    if (!c.polys.length) continue;
    cells.set(id, c);
    const l = layers.get(c.layer);
    if (l) l.push(c); else layers.set(c.layer, [c]);
    for (const p of c.polys) {
      for (let i = 0; i < p.pts.length; i += 2) {
        minX = Math.min(minX, p.pts[i]!); maxX = Math.max(maxX, p.pts[i]!);
        minY = Math.min(minY, p.pts[i + 1]!); maxY = Math.max(maxY, p.pts[i + 1]!);
      }
    }
    minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
  }
  if (!cells.size) return null;
  const sorted = new Map([...layers].sort((a, b) => a[0] - b[0]));
  return { landblock: landblock & 0xffff0000, cells, layers: sorted, minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * UB DungeonMaps.GetTint: how a layer is drawn when the map shows floor `drawZ` (null: drawn as is).
 * Floors above are a grey wash (151,151,151 at alpha 121), the current floor as is, floors below darkened
 * by up to 40% per 6 m. Floors more than 10 m above or 24 m below aren't drawn at all ('hidden').
 */
export function layerTint(drawZ: number, layer: number, all: boolean): { mul: number; grey: boolean } | 'hidden' {
  if (all) return { mul: 1, grey: false };
  const d = drawZ - layer;
  if (d < -10 || d > 24) return 'hidden';
  if (d < -3) return { mul: 1, grey: true };
  if (Math.abs(d) < 3) return { mul: 1, grey: false };
  const k = Math.min(1, (Math.abs(d) / 6) * 0.4);
  return { mul: 1 - k, grey: false };
}

/** UB Dungeon.GetZLevelIndex as the ZLayer slider's 0–100 position. */
export function zSliderPosition(map: Pick<DungeonMap, 'minZ' | 'maxZ'>, z: number): number {
  const depth = map.maxZ - map.minZ;
  if (depth <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((z - map.minZ) / depth) * 100)));
}

/** The ZLayer slider's position back to a height (UB UIZSlider_Changed). */
export function zFromSlider(map: Pick<DungeonMap, 'minZ' | 'maxZ'>, pos: number): number {
  return map.minZ + (map.maxZ - map.minZ) * (pos / 100);
}

/** The Decal ObjectClass numbers UB's marker classes read (agent/decalObjectClass.ts). */
const OC = { monster: 5, container: 10, portal: 14, player: 24, vendor: 25, door: 26, corpse: 27, npc: 37 } as const;

/** UB MarkerDisplayOptions.GetMarkerNameFromTO: the marker class an object draws as. */
export function markerClassOf(objectClass: number, name: string, isMe: boolean, myName: string): string {
  switch (objectClass) {
    case OC.player: return isMe ? 'You' : 'Others';
    case OC.monster: return 'Monsters';
    case OC.npc: case OC.vendor: return 'NPCs';
    case OC.portal: return 'Portals';
    case OC.corpse: return name === `Corpse of ${myName}` ? 'MyCorpse' : 'OtherCorpses';
    case OC.door: return 'Doors';
    case OC.container: return 'Containers';
    default: return 'EverythingElse';
  }
}

/** UB TrackedObject: portals' and NPCs' names lose "Portal to " and " Portal". */
export function markerLabel(objectClass: number, name: string): string {
  return objectClass === OC.portal || objectClass === OC.npc ? name.replace('Portal to ', '').replace(' Portal', '') : name;
}
