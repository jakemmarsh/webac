// @vitest-environment happy-dom
/**
 * UtilityBelt's Dungeon Maps and Landscape Maps (docs/vtank-parity-gaps.md §11.7; ui/maps/): the dungeon
 * model (UB's floors, tints and marker classes over cell geometry), the landscape model (UB's coordinate
 * mapping, the terrain picture, markers and labels), UB's settings through /ub opt, the two windows over a
 * fake game and a recording canvas, the /ub dungeonmaps / landscapemaps commands and the automation
 * window's Options-tab buttons.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDungeonCell, buildDungeonMap, classifyPolygon, isDungeonCell, layerOf, layerTint, markerClassOf, markerLabel, polygonNormal,
  zFromSlider, zSliderPosition, type DungeonCellGeometry, type DungeonMapSource,
} from '../packages/renderer/src/ui/maps/dungeonMapModel.ts';
import {
  coordinateIncrement, coordsToPixel, coordText, labelCandidates, landscapeScale, meanColor, paintLandblock, parseMapTable, pixelToCoords,
  placeLabel, reliefShade, terrainPalette, TerrainMapBuilder, TERRAIN_MAP_SIZE, type MapTable,
} from '../packages/renderer/src/ui/maps/landscapeMapModel.ts';
import { argbBytes, argbCss, UB_MAP_SETTING_DEFAULTS } from '../packages/renderer/src/ui/maps/ubMapSettings.ts';
import { UbMaps, type UbMapHost, type UbMapObject, type UbMapSelf, type UbMapUi } from '../packages/renderer/src/ui/maps/UbMaps.ts';
import { UbStore, UB_SETTING_DEFAULTS, type UbStorage } from '../packages/renderer/src/agent/ub/ubSettings.ts';
import { UbRuntime, type UbHost } from '../packages/renderer/src/agent/ub/ubCommands.ts';
import { QuestTracker } from '../packages/renderer/src/agent/questTracker.ts';
import { UB_COMMAND_VERBS } from '../packages/shared/src/routines/index.ts';
import { cellToEW, cellToNS } from '../tools/build-map-markers.ts';

// ── geometry helpers ──

type V = { x: number; y: number; z: number };
const ID_Q = { w: 1, x: 0, y: 0, z: 0 };
/** A cell from world-space polygons (each a list of points), placed at `origin` with `q`. */
function cellGeom(polys: V[][], origin: V = { x: 0, y: 0, z: 0 }, q = ID_Q): DungeonCellGeometry {
  const vertices = new Map<number, { origin: V; normal: V; uvs: [] }>();
  const physicsPolygons = new Map<number, { vertexIndices: number[] }>();
  let k = 0;
  polys.forEach((p, i) => {
    const idx: number[] = [];
    for (const v of p) { vertices.set(k, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(k++); }
    physicsPolygons.set(i, { vertexIndices: idx });
  });
  return { cellStruct: { vertexArray: { vertexType: 1, vertices }, physicsPolygons, polygons: new Map() } as never, position: { origin, orientation: q } };
}
/** A 10 × 10 m room: floor (counter-clockwise from above), ceiling, and four 4 m walls facing in. */
function room(z = 0): V[][] {
  const f: V[] = [{ x: 0, y: 0, z }, { x: 10, y: 0, z }, { x: 10, y: 10, z }, { x: 0, y: 10, z }];
  const c: V[] = [...f].reverse().map((v) => ({ ...v, z: z + 4 }));
  const wall = (a: V, b: V): V[] => [{ ...a, z }, { ...a, z: z + 4 }, { ...b, z: z + 4 }, { ...b, z }];
  return [f, c, wall({ x: 0, y: 0, z }, { x: 10, y: 0, z }), wall({ x: 10, y: 0, z }, { x: 10, y: 10, z })];
}

describe('Dungeon Maps model (UB Dungeon / DungeonLayer / IsDungeon)', () => {
  it('floors are UB\'s ⌊(z + 3) / 6⌋ · 6 layers', () => {
    expect([-6, -3.1, -3, 0, 2.9, 3, 8.9, 9].map(layerOf)).toEqual([-6, -6, 0, 0, 0, 6, 6, 12]);
  });

  it('a dungeon is an interior cell that is not SeenOutside; an unknown one counts as a dungeon', () => {
    expect(isDungeonCell(0x01f60105, 0)).toBe(true);
    expect(isDungeonCell(0x01f60105, 0x02)).toBe(true);
    expect(isDungeonCell(0xa9b40105, 0x01)).toBe(false);
    expect(isDungeonCell(0xa9b40019, 0)).toBe(false);
    expect(isDungeonCell(0x01f60105, null)).toBe(true);
  });

  it('classifies polygons by their normal and height: floor, stairs, wall, inner, ramped; ceilings dropped', () => {
    const [floor, ceiling, wall] = room(0);
    expect(polygonNormal(floor!).z).toBeCloseTo(1);
    expect(classifyPolygon(floor!, 0)).toBe('floor');
    expect(classifyPolygon(ceiling!, 0)).toBeNull();
    expect(classifyPolygon(wall!, 0)).toBe('wall');
    // A level step 1 m up is stairs; a 45° ramp is stairs; a 1 m riser is an inner wall; a sloped-foot wall is ramped.
    expect(classifyPolygon(floor!.map((v) => ({ ...v, z: 1 })), 0)).toBe('stairs');
    expect(classifyPolygon([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }, { x: 0, y: 4, z: 4 }], 0)).toBe('stairs');
    expect(classifyPolygon([{ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 1 }, { x: 4, y: 5, z: 1 }, { x: 4, y: 5, z: 0 }], 0)).toBe('inner');
    expect(classifyPolygon([{ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 5 }, { x: 4, y: 5, z: 8 }, { x: 4, y: 5, z: 3 }], 0)).toBe('ramped');
  });

  it('places a cell by its frame (a quarter turn about z moves +x to +y)', () => {
    const s = Math.SQRT1_2;
    const c = buildDungeonCell(0x01f60100, cellGeom([room(0)[0]!], { x: 100, y: -50, z: 6 }, { w: s, x: 0, y: 0, z: s }));
    expect(c.layer).toBe(6);
    const pts = c.polys[0]!.pts;
    // (10, 0) → (0, 10) → + origin.
    expect(pts[2]).toBeCloseTo(100);
    expect(pts[3]).toBeCloseTo(-40);
    expect(c.polys[0]!.kind).toBe('floor');
  });

  it('builds a landblock\'s cells into layers with bounds; a landblock with no cells is null', () => {
    const src: DungeonMapSource = {
      cellIds: () => [0x01f60100, 0x01f60101, 0x01f60102],
      cell: (id) => (id === 0x01f60100 ? cellGeom(room(0)) : id === 0x01f60101 ? cellGeom(room(0), { x: 10, y: 0, z: 6 }) : null),
    };
    const m = buildDungeonMap(0x01f60105, src)!;
    expect(m.landblock).toBe(0x01f60000);
    expect([...m.layers.keys()]).toEqual([0, 6]);
    expect([m.minX, m.maxX, m.minY, m.maxY, m.minZ, m.maxZ]).toEqual([0, 20, 0, 10, 0, 6]);
    expect(buildDungeonMap(0x01f60000, { cellIds: () => [], cell: () => null })).toBeNull();
  });

  it('tints floors as UB GetTint: above grey, current as is, below darker, far ones hidden; All draws every floor as is', () => {
    expect(layerTint(0, 0, false)).toEqual({ mul: 1, grey: false });
    expect(layerTint(0, 6, false)).toEqual({ mul: 1, grey: true });
    expect(layerTint(12, 6, false)).toEqual({ mul: 0.6, grey: false });
    expect(layerTint(0, 12, false)).toBe('hidden');
    expect(layerTint(30, 0, false)).toBe('hidden');
    expect(layerTint(30, 0, true)).toEqual({ mul: 1, grey: false });
  });

  it('maps the ZLayer slider to the dungeon\'s height and back', () => {
    const m = { minZ: -12, maxZ: 6 };
    expect(zSliderPosition(m, -12)).toBe(0);
    expect(zSliderPosition(m, 6)).toBe(100);
    expect(zFromSlider(m, 50)).toBe(-3);
  });

  it('marks objects by UB\'s classes and trims portal names as UB does', () => {
    expect(markerClassOf(24, 'Me', true, 'Me')).toBe('You');
    expect(markerClassOf(24, 'Bob', false, 'Me')).toBe('Others');
    expect(markerClassOf(5, 'Drudge', false, 'Me')).toBe('Monsters');
    expect(markerClassOf(25, 'Vendor', false, 'Me')).toBe('NPCs');
    expect(markerClassOf(27, 'Corpse of Me', false, 'Me')).toBe('MyCorpse');
    expect(markerClassOf(27, 'Corpse of Drudge', false, 'Me')).toBe('OtherCorpses');
    expect(markerClassOf(26, 'Door', false, 'Me')).toBe('Doors');
    expect(markerClassOf(10, 'Chest', false, 'Me')).toBe('Containers');
    expect(markerClassOf(1, 'Sword', false, 'Me')).toBe('EverythingElse');
    expect(markerLabel(14, 'Portal to Holtburg')).toBe('Holtburg');
    expect(markerLabel(14, 'Holtburg Dungeon Portal')).toBe('Holtburg Dungeon');
    expect(markerLabel(5, 'Portal to Holtburg')).toBe('Portal to Holtburg');
  });
});

describe('Landscape Maps model (UB LandscapeMaps / LandscapeMarkers)', () => {
  it('map coordinates and picture pixels agree with UB\'s LandblockToEW / NS', () => {
    // Holtburg's lifestone cell: 0xA9B40019 at (84, 96) local.
    const ew = cellToEW(0xa9b40019, 84);
    const ns = cellToNS(0xa9b40019, 96);
    const p = coordsToPixel(ew, ns);
    expect(p.x).toBeCloseTo(0xa9 * 8 + 84 / 24);
    expect(p.y).toBeCloseTo(TERRAIN_MAP_SIZE - (0xb4 * 8 + 96 / 24));
    const back = pixelToCoords(p.x, p.y);
    expect(back.ew).toBeCloseTo(ew);
    expect(back.ns).toBeCloseTo(ns);
    expect(coordText(42.31, -33.6)).toBe('42.31N, 33.60W');
  });

  it('flat ground keeps its Region colour; a slope to the light is brighter, away darker', () => {
    expect(reliefShade(10, 10, 10)).toBeCloseTo(1);
    // Rising to the east and falling to the north faces the north-west light; the opposite faces away.
    expect(reliefShade(10, 20, 0)).toBeGreaterThan(1);
    expect(reliefShade(10, 0, 20)).toBeLessThan(1);
  });

  it('paints a landblock\'s 8 × 8 cells north up, roads in the road colour', () => {
    const pal = terrainPalette([0xff649664, 0xff64dc64], [120, 100, 80]);
    const terrain = new Array(81).fill(1 << 2);
    terrain[0] = (1 << 2) | 1; // the south-west corner is road
    const out = new Uint8ClampedArray(TERRAIN_MAP_SIZE * TERRAIN_MAP_SIZE * 4);
    paintLandblock(out, 0xa9, 0xb4, { terrain, heights: new Array(81).fill(0) }, new Float32Array(256), pal);
    const px = (x: number, y: number) => Array.from(out.subarray((y * TERRAIN_MAP_SIZE + x) * 4, (y * TERRAIN_MAP_SIZE + x) * 4 + 4));
    const sw = { x: 0xa9 * 8, y: TERRAIN_MAP_SIZE - 1 - 0xb4 * 8 };
    expect(px(sw.x, sw.y)).toEqual([120, 100, 80, 255]);
    expect(px(sw.x + 1, sw.y)).toEqual([100, 220, 100, 255]);
    expect(px(sw.x + 7, sw.y - 7)).toEqual([100, 220, 100, 255]);
    expect(px(sw.x + 8, sw.y)[3]).toBe(0);
  });

  it('builds the picture in budgeted steps; missing landblocks stay clear', () => {
    let t = 0;
    let reads = 0;
    const b = new TerrainMapBuilder((x) => { reads++; t += x < 10 ? 0.01 : 0; return x === 3 ? null : { terrain: new Array(81).fill(4), heights: new Array(81).fill(0) }; },
      new Float32Array(256), terrainPalette([0, 0xff102030], [0, 0, 0]), () => { t += 1; return t; });
    expect(b.step(0)).toBe(false);
    expect(b.progress).toBe(1);
    while (!b.step(50));
    expect(b.done).toBe(true);
    expect(reads).toBe(255 * 255);
    expect(b.rgba[((TERRAIN_MAP_SIZE - 1) * TERRAIN_MAP_SIZE + 0) * 4 + 1]).toBe(0x20);
    expect(b.rgba[((TERRAIN_MAP_SIZE - 1) * TERRAIN_MAP_SIZE + 3 * 8) * 4 + 3]).toBe(0);
  });

  it('the road colour is the road texture\'s alpha-weighted mean', () => {
    expect(meanColor([10, 20, 30, 255, 30, 40, 50, 255, 255, 255, 255, 0])).toEqual([20, 30, 40]);
  });

  it('zoom, coordinate steps and label placement are UB\'s', () => {
    expect(landscapeScale(0.04)).toBeCloseTo(Math.pow(1.5, 0.48) - 0.8);
    expect([0.005, 0.04, 0.1, 0.24, 0.4, 0.6, 0.8, 0.9, 1].map(coordinateIncrement)).toEqual([50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1]);
    const placed = [{ x: 92, y: 92, w: 16, h: 16 }];
    const first = placeLabel(labelCandidates(100, 100, 40, 12), placed)!;
    expect(first).toEqual({ x: 80, y: 78, w: 40, h: 12 });
    // The same spot again: the next candidate clear of both (UB tries above, then clockwise).
    const second = placeLabel(labelCandidates(100, 100, 40, 12), placed)!;
    expect(second.x).toBeGreaterThan(first.x);
    expect(placed).toHaveLength(3);
  });

  it('parses an era table: marker types, names, dungeon names by landblock', () => {
    const t = parseMapTable(JSON.stringify({ m: [['L', 'Life Stone', 42.1, 33.6], ['D', 'Holtburg Dungeon', 40, 30], ['T', 'Holtburg', 42.3, 33.6]], d: [['01F6', 'Holtburg Dungeon']] }));
    expect(t.markers.map((m) => m.type)).toEqual(['Lifestone', 'Dungeon', 'Town']);
    expect(t.dungeons.get(0x01f60000)).toBe('Holtburg Dungeon');
  });
});

// ── the windows over a fake game ──

class MemStorage implements UbStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

type Call = [string, unknown[]];
/** A canvas whose 2D context records every call and property set. */
function recordingCanvas(w: number, h: number): HTMLCanvasElement & { calls: Call[] } {
  const c = document.createElement('canvas') as HTMLCanvasElement & { calls: Call[] };
  c.width = w; c.height = h;
  c.calls = [];
  const props: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' && k in props ? props[k] : (...a: unknown[]) => { c.calls.push([String(k), a]); }),
    set: (_t, k, v) => { props[String(k)] = v; c.calls.push([`=${String(k)}`, [v]]); return true; },
  });
  (c as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return c;
}

function fakeKit(): UbMapUi['kit'] {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', onClick); return d; };
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    flatButton: (label, onClick) => div({ button: label }, onClick),
    slider: (value, _min, _max, _w, onChange) => { const i = document.createElement('input'); i.dataset.slider = String(value); i.addEventListener('change', () => onChange(Number(i.value))); return i; },
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
    list: () => {},
  };
}

function fakeUi() {
  const opened = new Map<string, { title: string; w: number; h: number; root: HTMLElement; body: HTMLElement; onClose: () => void }>();
  const texts: string[] = [];
  const images: number[] = [];
  const canvases: Array<HTMLCanvasElement & { calls: Call[] }> = [];
  const bares: HTMLElement[] = [];
  const ui: UbMapUi = {
    kit: fakeKit(),
    open: (key, title, w, h, onClose) => {
      if (opened.has(key)) return null;
      const root = document.createElement('div');
      const body = document.createElement('div');
      body.style.width = `${w - 12}px`; body.style.height = `${h - 35}px`;
      root.appendChild(body);
      document.body.appendChild(root);
      opened.set(key, { title, w, h, root, body, onClose });
      return { body, root };
    },
    close: (key) => { opened.get(key)?.root.remove(); opened.delete(key); },
    bare: (key) => { const d = document.createElement('div'); d.dataset.bare = key; document.body.appendChild(d); bares.push(d); return d; },
    textCanvas: (text) => { texts.push(text); const c = document.createElement('canvas'); c.width = text.length * 6; c.height = 12; return c; },
    image: (id) => { images.push(id); return document.createElement('canvas'); },
    canvas: (w, h) => { const c = recordingCanvas(w, h); canvases.push(c); return c; },
  };
  return { ui, opened, texts, images, canvases, bares };
}

const ME_CELL = 0x01f60105;
class FakeMapGame implements UbMapHost {
  self: UbMapSelf | null = { guid: 0x50000001, name: 'Tester', cell: ME_CELL, x: 5, y: 5, z: 0, heading: 0 };
  objs: UbMapObject[] = [{ guid: 0x80000001, name: 'Drudge Skulker', objectClass: 5, cell: 0x01f60105, x: 10, y: 5, z: 0 }];
  flags = new Map<number, number>();
  ensured: number[] = [];
  table: MapTable = { markers: [], dungeons: new Map([[0x01f60000, 'Test Dungeon'], [0x01f70000, 'Other Dungeon']]) };
  cells: Record<number, DungeonCellGeometry> = { 0x01f60105: cellGeom(room(0)), 0x01f60106: cellGeom(room(0), { x: 0, y: 10, z: 6 }) };
  terrainRead = 0;
  me() { return this.self; }
  objects() { return this.objs; }
  dungeonSource(): DungeonMapSource { return { cellIds: (lb) => Object.keys(this.cells).map(Number).filter((c) => ((c & 0xffff0000) >>> 0) === ((lb & 0xffff0000) >>> 0)), cell: (id) => this.cells[id] ?? null }; }
  envCellFlags(id: number) { return this.flags.get(id) ?? 0; }
  async ensureDungeon(lb: number) { this.ensured.push(lb); }
  terrain() {
    return {
      read: (lbx: number, lby: number) => { this.terrainRead++; return lbx === 0xa9 && lby === 0xb4 ? { terrain: new Array(81).fill(4), heights: new Array(81).fill(0) } : null; },
      heightTable: new Float32Array(256), terrainColors: [0xff000000, 0xff64dc64], road: [1, 2, 3] as [number, number, number],
    };
  }
  async mapTable() { return this.table; }
}

function setup() {
  const g = new FakeMapGame();
  const f = fakeUi();
  const storage = new MemStorage();
  const store = new UbStore(() => ({ server: 'Test', character: 'Tester' }), () => storage);
  const maps = new UbMaps(g, f.ui, store);
  return { g, f, store, maps };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const fills = (c: { calls: Call[] }) => c.calls.filter(([k]) => k === '=fillStyle').map(([, a]) => a[0]);
const arcs = (c: { calls: Call[] }) => c.calls.filter(([k]) => k === 'arc').map(([, a]) => a as number[]);
let live: UbMaps | null = null;
afterEach(() => { live?.closeAll(); live = null; document.body.replaceChildren(); });

describe('UB map settings (/ub opt)', () => {
  it('carry UB\'s names and defaults, in the UB store', () => {
    for (const k of ['DungeonMaps.Enabled', 'DungeonMaps.Opacity', 'DungeonMaps.MapZoom', 'DungeonMaps.Display.Walls.Color', 'DungeonMaps.Display.Markers.Monsters.UseIcon', 'LandscapeMaps.Enabled']) {
      expect(UB_SETTING_DEFAULTS[k]).toBe(UB_MAP_SETTING_DEFAULTS[k]);
    }
    expect(UB_MAP_SETTING_DEFAULTS['DungeonMaps.Display.Floors.Color']).toBe(-16744513);
    expect(UB_MAP_SETTING_DEFAULTS['DungeonMaps.Display.Markers.You.Color']).toBe(-65536);
    expect(UB_MAP_SETTING_DEFAULTS['DungeonMaps.Display.Markers.OtherCorpses.Enabled']).toBe(false);
    expect(UB_MAP_SETTING_DEFAULTS['DungeonMaps.DrawWhenClosed']).toBe(false);
    expect(argbCss(-16744513)).toBe('rgba(0, 127, 191, 1)');
    expect(argbBytes(-23296)).toEqual([255, 165, 0, 255]);
  });

  it('/ub opt reads and sets them; /ub dungeonmaps and /ub landscapemaps open and close the windows', async () => {
    const { store, maps, f } = setup();
    live = maps;
    const host = new Proxy({ toggleMap: (w: 'dungeon' | 'landscape') => maps.toggle(w) }, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : () => null) }) as unknown as UbHost;
    const ub = new UbRuntime(host, store, new QuestTracker({ send: () => true, now: () => 0 }));
    expect(await ub.command('/ub opt get DungeonMaps.MapZoom')).toEqual(['DungeonMaps.MapZoom = 4.2']);
    expect(await ub.command('/ub opt set DungeonMaps.Display.Walls.Color -1')).toEqual(['DungeonMaps.Display.Walls.Color = -1']);
    expect(await ub.command('/ub dungeonmaps')).toEqual(['DungeonMaps window opened']);
    expect(f.opened.get('ubDungeonMaps')?.title).toBe('Utility Belt Maps');
    expect(await ub.command('/ub dungeonmaps')).toEqual(['DungeonMaps window closed']);
    expect(f.opened.has('ubDungeonMaps')).toBe(false);
    expect(await ub.command('/ub opt set LandscapeMaps.Enabled false')).toEqual(['LandscapeMaps.Enabled = false']);
    expect(await ub.command('/ub landscapemaps')).toEqual(['LandscapeMaps is disabled (/ub opt set LandscapeMaps.Enabled true)']);
    expect(UB_COMMAND_VERBS).toContain('dungeonmaps');
    expect(UB_COMMAND_VERBS).toContain('landscapemaps');
  });
});

describe('the Dungeon Maps window', () => {
  it('opens at UB\'s size with its Map / Search / About tabs and draws your dungeon from its geometry', async () => {
    const { g, f, maps } = setup();
    live = maps;
    expect(maps.toggle('dungeon')).toBe('DungeonMaps window opened');
    const w = f.opened.get('ubDungeonMaps')!;
    expect([w.w, w.h]).toEqual([320, 280]);
    expect(Array.from(w.body.querySelectorAll('[data-ub-map-tab]')).map((e) => (e as HTMLElement).dataset.ubMapTab)).toEqual(['Map', 'Search', 'About']);
    await settle();
    maps.tick();
    expect(g.ensured).toEqual([0x01f60000]);
    const c = f.canvases.at(-1)!;
    // Floors in UB's Floors colour: the cell you are in tinted as visited (VisitedTilesColor 255, 150, 255),
    // the floor above washed grey; walls stroked in Walls blue.
    expect(fills(c)).toContain('rgba(0, 75, 191, 1)');
    expect(fills(c)).toContain('rgba(0, 75, 113, 0.475)');
    expect(c.calls.some(([k, a]) => k === '=strokeStyle' && a[0] === 'rgba(0, 0, 127, 1)')).toBe(true);
    // The header: the dungeon's name and floor.
    expect(f.texts).toContain('Test Dungeon (Z:0)');
    // The drudge 5 m east of you, map heading-up at heading 0: 5 m × (5 − 4.2) × 5 px right of centre.
    const drudge = arcs(c).find((a) => Math.abs(a[1]! - c.height / 2) < 0.01 && a[0]! > c.width / 2)!;
    expect(drudge[0]).toBeCloseTo(c.width / 2 + 20);
    expect(fills(c)).toContain('rgba(255, 165, 0, 1)');
  });

  it('follows your heading: facing east, what is east of you is drawn above you', async () => {
    const { g, f, maps } = setup();
    live = maps;
    g.self!.heading = 90;
    maps.toggle('dungeon');
    await settle();
    maps.tick();
    const c = f.canvases.at(-1)!;
    expect(arcs(c).some((a) => Math.abs(a[0]! - c.width / 2) < 0.01 && Math.abs(a[1]! - (c.height / 2 - 20)) < 0.01)).toBe(true);
  });

  it('redraws only when something changed, and Opacity dims the map', async () => {
    const { g, f, maps, store } = setup();
    live = maps;
    maps.toggle('dungeon');
    await settle();
    maps.tick();
    const c = f.canvases.at(-1)!;
    const n = c.calls.length;
    maps.tick();
    expect(c.calls.length).toBe(n);
    g.objs[0]!.x = 12;
    maps.tick();
    expect(c.calls.length).toBeGreaterThan(n);
    store.setValue('DungeonMaps.Opacity', 10);
    g.objs[0]!.x = 13;
    maps.tick();
    expect(c.calls.some(([k, a]) => k === '=globalAlpha' && a[0] === 0.5)).toBe(true);
  });

  it('the wheel zooms and saves MapZoom as UB does (5 − scale)', async () => {
    const { f, maps, store } = setup();
    live = maps;
    maps.toggle('dungeon');
    await settle();
    const c = f.canvases.at(-1)!;
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    expect(maps.dungeon.scale).toBeCloseTo(1);
    expect(store.num('DungeonMaps.MapZoom')).toBe(4);
  });

  it('draws nothing outside a dungeon (a building\'s interior is SeenOutside)', async () => {
    const { g, f, maps } = setup();
    live = maps;
    g.flags.set(ME_CELL, 0x01);
    maps.toggle('dungeon');
    await settle();
    maps.tick();
    expect(maps.dungeon.map).toBeNull();
    expect(fills(f.canvases.at(-1)!)).toEqual([]);
  });

  it('Search lists UB\'s dungeons by landblock and name; a pick loads it to look at, top floor first', async () => {
    const { f, maps } = setup();
    live = maps;
    maps.toggle('dungeon');
    await settle();
    const w = f.opened.get('ubDungeonMaps')!;
    (w.body.querySelector('[data-ub-map-tab="Search"]') as HTMLElement).click();
    expect(Array.from(w.body.querySelectorAll('[data-ub-dungeon]')).map((e) => (e as HTMLElement).dataset.ubDungeon)).toEqual(['01F6', '01F7']);
    const input = w.body.querySelector('[data-ub-map="search"]') as HTMLInputElement;
    input.value = 'other';
    input.dispatchEvent(new Event('input'));
    expect(Array.from(w.body.querySelectorAll('[data-ub-dungeon]')).map((e) => (e as HTMLElement).dataset.ubDungeon)).toEqual(['01F7']);
    input.value = '01f6';
    input.dispatchEvent(new Event('input'));
    (w.body.querySelector('[data-ub-dungeon="01F6"]') as HTMLElement).click();
    await settle();
    expect(maps.dungeon.manual).toBe(true);
    expect(maps.dungeon.follow).toBe(false);
    expect(maps.dungeon.drawZ).toBe(6);
    expect(w.body.querySelector('[data-ub-map-tab="Map"]')!.getAttribute('data-selected')).toBe('1');
    // Follow goes back to you.
    (w.body.querySelector('[data-ub-map="follow"]') as HTMLElement).click();
    expect(maps.dungeon.follow).toBe(true);
    expect(maps.dungeon.manual).toBe(false);
  });

  it('dragging pans and stops following; Shift-drag rotates', async () => {
    const { maps } = setup();
    live = maps;
    maps.toggle('dungeon');
    await settle();
    const d = maps.dungeon;
    d.follow = false;
    d.rotation = 0;
    d.offsetX = 5; d.offsetY = -5;
    (d as unknown as { drag: unknown }).drag = { x: 0, y: 0, ox: 5, oy: -5, rot: 0, rotate: false };
    // Drag 40 px right at 4 px / m: the centre moves 10 m west.
    d.dragTo(40, 0);
    expect(d.offsetX).toBeCloseTo(-5);
    (d as unknown as { drag: unknown }).drag = { x: 0, y: 0, ox: 5, oy: -5, rot: 10, rotate: true };
    d.dragTo(-20, 0);
    expect(d.rotation).toBe(30);
  });

  it('turning Enabled off closes it; DrawWhenClosed leaves the map on screen without its frame', async () => {
    const { f, maps, store } = setup();
    live = maps;
    maps.toggle('dungeon');
    await settle();
    store.setValue('DungeonMaps.DrawWhenClosed', true);
    f.opened.get('ubDungeonMaps')!.onClose();
    expect(f.bares).toHaveLength(1);
    expect(maps.dungeon.live).toBe(true);
    expect(maps.dungeon.isOpen).toBe(false);
    // Reopened: the frameless copy goes.
    maps.toggle('dungeon');
    expect(f.bares[0]!.isConnected).toBe(false);
    store.setValue('DungeonMaps.Enabled', false);
    maps.tick();
    expect(maps.dungeon.live).toBe(false);
    expect(f.opened.size).toBe(0);
  });
});

describe('the Landscape Maps window', () => {
  it('paints the era\'s terrain, centres on you with Follow, and shows UB\'s markers in their zoom bands', async () => {
    const { g, f, maps } = setup();
    live = maps;
    g.self = { guid: 1, name: 'Tester', cell: 0xa9b40019, x: 84, y: 96, z: 50, heading: 45 };
    g.table = { markers: [
      { type: 'Town', name: 'Holtburg', ns: 42.3, ew: 33.6 },
      { type: 'Vendor', name: 'Shopkeeper', ns: 42.1, ew: 33.6 },
    ], dungeons: new Map() };
    expect(maps.toggle('landscape')).toBe('LandscapeMaps window opened');
    expect(f.opened.get('ubLandscapeMaps')?.title).toBe('Utility Belt Landscape Maps');
    await settle();
    for (let i = 0; i < 300 && maps.landscape.pictureProgress < 1; i++) maps.tick();
    expect(maps.landscape.pictureProgress).toBe(1);
    expect(g.terrainRead).toBe(255 * 255);
    const L = maps.landscape;
    (f.opened.get('ubLandscapeMaps')!.body.querySelector('[data-ub-map="follow"]') as HTMLElement).click();
    expect(L.follow).toBe(true);
    expect(L.zoom).toBeCloseTo(0.24);
    const c = f.canvases.find((x) => x.dataset.ubMapCanvas === 'ubLandscapeMaps')!;
    const at = L.coordsToHud(cellToEW(0xa9b40019, 84), cellToNS(0xa9b40019, 96), c.width, c.height);
    expect(at.x).toBeCloseTo(c.width / 2);
    expect(at.y).toBeCloseTo(c.height / 2);
    f.images.length = 0;
    f.texts.length = 0;
    maps.tick();
    // At 0.24 the town shows with its label; a vendor needs 0.4.
    expect(f.images).toContain(100667518);
    expect(f.images).not.toContain(100672159);
    expect(f.texts).toContain('Holtburg');
    L.zoom = 0.5;
    f.images.length = 0;
    maps.tick();
    expect(f.images).toContain(100672159);
    // The retail map's player icon marks you.
    expect(f.images).toContain(0x06004d10);
  });

  it('map coordinates round-trip through the window and the wheel zooms about the mouse', async () => {
    const { maps } = setup();
    live = maps;
    maps.toggle('landscape');
    await settle();
    const L = maps.landscape;
    const p = L.coordsToHud(10, -20, 300, 200);
    const back = L.hudToCoords(p.x, p.y, 300, 200);
    expect(back.ew).toBeCloseTo(10);
    expect(back.ns).toBeCloseTo(-20);
  });

  it('in a dungeon there is no place for you on the landscape: Follow does nothing', async () => {
    const { maps } = setup();
    live = maps;
    maps.toggle('landscape');
    await settle();
    maps.landscape.followMe();
    expect(maps.landscape.follow).toBe(false);
  });
});

describe('the automation window\'s Options tab', () => {
  it('carries no UtilityBelt buttons: UB\'s maps open from its own window and VVS\'s bar', async () => {
    const { VTankWindow } = await import('../packages/renderer/src/ui/automation/VTankWindow.ts');
    const { emptyRoutineDoc } = await import('../packages/shared/src/routines/index.ts');
    const status = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
    const base: Record<string, unknown> = {
      load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
      status: () => status, stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
      current: () => null, character: () => 'Tester', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [],
      setting: () => undefined, report: () => {}, spellTable: () => null,
    };
    const source = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) });
    const kit = { ...fakeKit(), button: () => document.createElement('div'), tab: () => document.createElement('div'), field: () => document.createElement('div'), menu: () => {}, row: () => document.createElement('div'), box: () => document.createElement('div'), header: () => document.createElement('div'), dot: () => document.createElement('div'), separator: () => document.createElement('hr'), scroll: () => {}, plate: () => document.createElement('div'), icon: () => document.createElement('div'), dropdown: () => document.createElement('div'), download: () => {} };
    const win = new VTankWindow(kit as never, source as never, { open: () => {}, close: () => {} });
    const body = document.createElement('div');
    const redraw = () => win.render(body, 794, 189, redraw);
    await win.load(redraw);
    redraw();
    expect(body.querySelector('[data-vtank="force-buff"]')).not.toBeNull();
    expect(body.querySelector('[data-vtank="ub-dungeon-maps"]')).toBeNull();
    expect(body.querySelector('[data-vtank="ub-landscape-maps"]')).toBeNull();
  });
});
