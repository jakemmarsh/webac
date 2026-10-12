/**
 * UtilityBelt's Landscape Maps, the picture and its markers (docs/vtank-parity-gaps.md §11.7; UtilityBelt is
 * MIT, ported from 5fe9825a: Tools/LandscapeMaps.cs, Lib/Maps/LandscapeMarkers.cs).
 *
 * UB draws a 2048 px picture of Dereth (OptimShi's MapAC render, shipped as acmap.png). Here the picture is
 * drawn from this era's cell.dat the way MapAC draws it: one pixel per 24 m cell, coloured by the cell's
 * terrain type with the colour the Region (0x13000000) gives each type (TerrainType.TerrainColor), a road
 * cell by the road texture's mean colour, shaded by the ground's slope. 255 × 8 = 2040 cells a side, map
 * coordinate 0 at cell 1019.5 (UB Geometry.LandblockToEW / NS). The light comes from the north-west, 45°
 * up, as a printed map's relief shading does; flat ground keeps its Region colour exactly.
 *
 * Markers are UB's LandscapeMarkers types with UB's icons and zoom bands, from the era's own table
 * (tools/build-map-markers.ts).
 */

/** Cells a side: 255 landblocks × 8. */
export const TERRAIN_MAP_SIZE = 2040;
/** The map coordinate of a cell's west / south edge is (cell − 1019.5) / 10. */
export const MAP_ORIGIN_CELL = 1019.5;

/** Map coordinate → picture pixel (continuous), x from the west, y from the north. */
export function coordsToPixel(ew: number, ns: number): { x: number; y: number } {
  return { x: ew * 10 + MAP_ORIGIN_CELL, y: TERRAIN_MAP_SIZE - (ns * 10 + MAP_ORIGIN_CELL) };
}

/** Picture pixel → map coordinate. */
export function pixelToCoords(x: number, y: number): { ew: number; ns: number } {
  return { ew: (x - MAP_ORIGIN_CELL) / 10, ns: (TERRAIN_MAP_SIZE - y - MAP_ORIGIN_CELL) / 10 };
}

/** A landblock's terrain words and height bytes (CellLandblock: 9 × 9, index x · 9 + y, x from the west, y from the south). */
export interface LandblockTerrain { terrain: ArrayLike<number>; heights: ArrayLike<number> }

/** The Region's colours: TerrainType.TerrainColor (ARGB) per type, and the road colour. */
export interface TerrainPalette { types: Array<[number, number, number]>; road: [number, number, number] }

/** Region TerrainColor words (ARGB) → RGB bytes; `road` is the road texture's mean colour. */
export function terrainPalette(terrainColors: number[], road: [number, number, number]): TerrainPalette {
  return { types: terrainColors.map((c) => [(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]), road };
}

/** The mean colour of an RGBA picture (the road texture), alpha-weighted. */
export function meanColor(rgba: ArrayLike<number>): [number, number, number] {
  let r = 0; let g = 0; let b = 0; let w = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    r += rgba[i]! * a; g += rgba[i + 1]! * a; b += rgba[i + 2]! * a; w += a;
  }
  return w > 0 ? [Math.round(r / w), Math.round(g / w), Math.round(b / w)] : [0, 0, 0];
}

/** Light from the north-west, 45° up (x east, y north, z up), unit. */
const LIGHT = (() => { const v = [-1, 1, Math.SQRT2]; const l = Math.hypot(v[0]!, v[1]!, v[2]!); return [v[0]! / l, v[1]! / l, v[2]! / l] as const; })();

/**
 * The relief factor of a cell from its corner heights (m): 1 for level ground, brighter facing the light,
 * darker away from it (clamped 0.55–1.3).
 */
export function reliefShade(hSW: number, hSE: number, hNW: number): number {
  const dzdx = (hSE - hSW) / 24;
  const dzdy = (hNW - hSW) / 24;
  const l = Math.hypot(dzdx, dzdy, 1);
  const dot = (-dzdx * LIGHT[0] - dzdy * LIGHT[1] + LIGHT[2]) / l;
  return Math.max(0.55, Math.min(1.3, dot / LIGHT[2]));
}

/**
 * Paint one landblock's 8 × 8 cells into an RGBA picture TERRAIN_MAP_SIZE wide (north up). A cell takes its
 * south-west corner's terrain type (a road corner paints road) and the slope of that corner.
 */
export function paintLandblock(out: Uint8ClampedArray, lbx: number, lby: number, lb: LandblockTerrain, heightTable: ArrayLike<number>, pal: TerrainPalette): void {
  const h = (x: number, y: number) => heightTable[lb.heights[x * 9 + y]! & 0xff] ?? 0;
  for (let cx = 0; cx < 8; cx++) {
    for (let cy = 0; cy < 8; cy++) {
      const t = lb.terrain[cx * 9 + cy]!;
      const rgb = (t & 0x3) !== 0 ? pal.road : pal.types[(t & 0x7c) >> 2] ?? pal.types[0] ?? [0, 0, 0];
      const s = reliefShade(h(cx, cy), h(cx + 1, cy), h(cx, cy + 1));
      const px = lbx * 8 + cx;
      const py = TERRAIN_MAP_SIZE - 1 - (lby * 8 + cy);
      const o = (py * TERRAIN_MAP_SIZE + px) * 4;
      out[o] = rgb[0] * s; out[o + 1] = rgb[1] * s; out[o + 2] = rgb[2] * s; out[o + 3] = 255;
    }
  }
}

/**
 * The picture, built a row of landblocks at a time so the frame never stalls: `step(budgetMs)` paints until
 * the budget is spent and says whether it finished. Landblocks the DAT lacks stay transparent (the
 * window's navy shows through, as UB fills its HUD 29, 33, 59 under its picture).
 */
export class TerrainMapBuilder {
  readonly rgba: Uint8ClampedArray;
  private lbx = 0;
  done = false;

  constructor(
    private readonly read: (lbx: number, lby: number) => LandblockTerrain | null,
    private readonly heightTable: ArrayLike<number>,
    private readonly pal: TerrainPalette,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.rgba = new Uint8ClampedArray(TERRAIN_MAP_SIZE * TERRAIN_MAP_SIZE * 4);
  }

  /** Columns of landblocks done, 0–255. */
  get progress(): number { return this.lbx; }

  step(budgetMs: number): boolean {
    const t0 = this.now();
    while (!this.done) {
      for (let lby = 0; lby < 255; lby++) {
        let lb: LandblockTerrain | null = null;
        try { lb = this.read(this.lbx, lby); } catch { lb = null; }
        if (lb) paintLandblock(this.rgba, this.lbx, lby, lb, this.heightTable, this.pal);
      }
      this.lbx++;
      if (this.lbx >= 255) this.done = true;
      if (this.now() - t0 >= budgetMs) break;
    }
    return this.done;
  }
}

/** UB LandscapeMarkers.MarkerType. */
export type LandscapeMarkerType = 'Unknown' | 'Town' | 'Lifestone' | 'Vendor' | 'NPC' | 'Portal' | 'Outpost' | 'Dungeon';

/** UB SetupDisplayOptions: icon (portal.dat) and the zoom bands the icon and its label show in. */
export const LANDSCAPE_MARKER_OPTIONS: Readonly<Record<LandscapeMarkerType, { icon: number; minMarker: number; minLabel: number }>> = {
  Unknown: { icon: 100667504, minMarker: 0, minLabel: 0 },
  Town: { icon: 100667518, minMarker: 0, minLabel: 0 },
  Outpost: { icon: 100671984, minMarker: 0.1, minLabel: 0.25 },
  Portal: { icon: 100667499, minMarker: 0.1, minLabel: 0.32 },
  Dungeon: { icon: 0x06005b57, minMarker: 0.1, minLabel: 0.32 },
  Lifestone: { icon: 0x060024e1, minMarker: 0.24, minLabel: 0.4 },
  NPC: { icon: 100667446, minMarker: 0.4, minLabel: 0.8 },
  Vendor: { icon: 100672159, minMarker: 0.4, minLabel: 0.8 },
};

const TYPE_OF_LETTER: Record<string, LandscapeMarkerType> = { L: 'Lifestone', V: 'Vendor', N: 'NPC', P: 'Portal', D: 'Dungeon', T: 'Town', O: 'Outpost' };

export interface LandscapeMarker { type: LandscapeMarkerType; name: string; ns: number; ew: number }

export interface MapTable { markers: LandscapeMarker[]; dungeons: Map<number, string> }

/** An era table (tools/build-map-markers.ts output) parsed. */
export function parseMapTable(json: string): MapTable {
  const t = JSON.parse(json) as { m: Array<[string, string, number, number]>; d: Array<[string, string]> };
  return {
    markers: t.m.map(([k, name, ns, ew]) => ({ type: TYPE_OF_LETTER[k] ?? 'Unknown', name, ns, ew })),
    dungeons: new Map(t.d.map(([lb, name]) => [parseInt(lb, 16) << 16 >>> 0, name])),
  };
}

/** UB's map scale from its zoom (0–1): screen pixels per picture pixel. */
export const landscapeScale = (zoom: number): number => Math.pow(1.5, zoom * 12) - 0.8;

/** UB GetCoordinateIncrement: the coordinate step of the border ticks at a zoom. */
export function coordinateIncrement(zoom: number): number {
  if (zoom < 0.01) return 50;
  if (zoom < 0.05) return 20;
  if (zoom < 0.13) return 10;
  if (zoom < 0.3) return 5;
  if (zoom < 0.5) return 2;
  if (zoom < 0.65) return 1;
  if (zoom < 0.85) return 0.5;
  if (zoom < 0.94) return 0.2;
  return 0.1;
}

/** "42.31N, 33.60E" as UB writes the mouse's coordinates (F2), or the borders' (F1 / F0). */
export function coordText(ns: number, ew: number, digits = 2): string {
  return `${Math.abs(ns).toFixed(digits)}${ns > 0 ? 'N' : 'S'}, ${Math.abs(ew).toFixed(digits)}${ew > 0 ? 'E' : 'W'}`;
}

/** Where a label goes (UB LabelMarker.GetPotentialLabelRects): above, then clockwise round the icon. */
export function labelCandidates(x: number, y: number, w: number, h: number): Array<{ x: number; y: number; w: number; h: number }> {
  const lx = x - Math.floor(w / 2);
  const ly = y - Math.floor(h / 2) - 16;
  const hw = Math.floor(w / 2);
  return [
    { x: lx, y: ly, w, h },
    { x: lx + 4 + hw, y: ly + 2, w, h },
    { x: lx + 8 + hw, y: ly + 15, w, h },
    { x: lx + 8 + hw, y: ly + 26, w, h },
    { x: lx, y: ly + 28, w, h },
    { x: lx - 10 - hw, y: ly + 24, w, h },
    { x: lx - 10 - hw, y: ly + 15, w, h },
    { x: lx - 6 - hw, y: ly + 4, w, h },
  ];
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The first candidate that touches nothing placed yet (which it then joins), or null (UB drops the label). */
export function placeLabel(cands: Array<{ x: number; y: number; w: number; h: number }>, placed: Array<{ x: number; y: number; w: number; h: number }>): { x: number; y: number; w: number; h: number } | null {
  for (const c of cands) {
    if (!placed.some((p) => overlaps(c, p))) { placed.push(c); return c; }
  }
  return null;
}
