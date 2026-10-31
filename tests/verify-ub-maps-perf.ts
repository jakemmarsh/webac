// @vitest-environment happy-dom
/**
 * PERF.ub-dungeon-map (webac#14: "with UB dungeon maps open I get choppy performance"): UtilityBelt's
 * Dungeon Maps window (ui/maps/UbMaps.ts) driven for real at its 10 Hz beat over a recording 2D context.
 *
 * - The picture is unchanged: every draw call that can reach the canvas (a fill, stroke or image whose
 *   bounds touch it) is the same, in the same order with the same styles, as the pre-fix draw produced
 *   (digests captured from 975047a77's UbMaps.draw on the same fixed states). Calls wholly off the canvas
 *   draw nothing and may be skipped.
 * - The per-draw work is bounded: off-screen cells are culled, settings are read once per draw (not per
 *   polygon), and a standing polygon's two far points are found once per dungeon, not once per draw.
 * - The same over the end-of-retail cell.dat (Holtburg Dungeon 0x01F6 and the largest dungeon landblock,
 *   0x00D1, 4,213 cells) when the DATs are present.
 *
 * - The sweep: Landscape Maps over the end-of-retail marker table (4,419 markers) redraws in well under a frame.
 *
 * `UB_MAP_BENCH=1` prints the per-draw timings; `UB_MAP_CAPTURE=1` skips the digest checks (to print new
 * ones after a deliberate picture change); `UB_MAP_DUMP=<dir>` writes the DAT cases' visible calls.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.ts';
import { Environment } from '../packages/dat-parser/src/file-types/Environment.ts';
import { farthestPair, type DungeonCellGeometry, type DungeonMapSource } from '../packages/renderer/src/ui/maps/dungeonMapModel.ts';
import { UbMaps, type UbMapHost, type UbMapObject, type UbMapSelf, type UbMapUi } from '../packages/renderer/src/ui/maps/UbMaps.ts';
import { UbStore, type UbStorage } from '../packages/renderer/src/agent/ub/ubSettings.ts';
import { loadMapTable } from '../packages/renderer/src/ui/maps/ubMapHost.ts';
import type { MapTable } from '../packages/renderer/src/ui/maps/landscapeMapModel.ts';

const BENCH = process.env.UB_MAP_BENCH === '1';

// ── a lean recording 2D context ──

type Op = [string, ...unknown[]];
class OpCtx {
  ops: Op[] = [];
  private fs: unknown = '#000';
  private ss: unknown = '#000';
  private lw = 1;
  private ga = 1;
  private ise = true;
  get fillStyle() { return this.fs; } set fillStyle(v) { this.fs = v; this.ops.push(['=fillStyle', v]); }
  get strokeStyle() { return this.ss; } set strokeStyle(v) { this.ss = v; this.ops.push(['=strokeStyle', v]); }
  get lineWidth() { return this.lw; } set lineWidth(v) { this.lw = v; this.ops.push(['=lineWidth', v]); }
  get globalAlpha() { return this.ga; } set globalAlpha(v) { this.ga = v; this.ops.push(['=globalAlpha', v]); }
  get imageSmoothingEnabled() { return this.ise; } set imageSmoothingEnabled(v) { this.ise = v; }
  clearRect(...a: unknown[]) { this.ops.push(['clearRect', ...a]); }
  fillRect(...a: unknown[]) { this.ops.push(['fillRect', ...a]); }
  strokeRect(...a: unknown[]) { this.ops.push(['strokeRect', ...a]); }
  save() { this.ops.push(['save']); }
  restore() { this.ops.push(['restore']); }
  beginPath() { this.ops.push(['beginPath']); }
  closePath() { this.ops.push(['closePath']); }
  moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
  lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
  arc(...a: unknown[]) { this.ops.push(['arc', ...a]); }
  fill() { this.ops.push(['fill']); }
  stroke() { this.ops.push(['stroke']); }
  drawImage(...a: unknown[]) { this.ops.push(['drawImage', ...a]); }
  translate(...a: unknown[]) { this.ops.push(['translate', ...a]); }
  rotate(...a: unknown[]) { this.ops.push(['rotate', ...a]); }
  putImageData(...a: unknown[]) { this.ops.push(['putImageData', ...a]); }
}
type OpCanvas = HTMLCanvasElement & { ctx: OpCtx };

const r3 = (v: unknown) => (typeof v === 'number' ? (Math.round(v * 1000) / 1000).toString() : String(v));

/**
 * The draw calls that reach a `w` × `h` canvas, as text: fills / strokes / images that can touch it, with
 * the style, width and alpha they are drawn with. (The dungeon draw uses no transforms.) A path is left out
 * only when an axis separates its points' hull from the canvas grown by `pad` (1 px of antialiasing, plus
 * half the line width for a stroke): such a call cannot change a pixel.
 */
function visibleGroups(ops: Op[], w: number, h: number): string[] {
  const out: string[] = [];
  let st = { fill: '' as unknown, stroke: '' as unknown, lw: 1, alpha: 1 };
  const stack: Array<typeof st> = [];
  let pts: number[] = [];
  const hits = (x0: number, y0: number, x1: number, y1: number, pad: number) => x1 + pad >= 0 && y1 + pad >= 0 && x0 - pad <= w && y0 - pad <= h;
  // Separating axes: x, y and each edge's normal (any axis that separates proves the hull misses the canvas).
  const reaches = (p: number[], pad: number): boolean => {
    const rect = [-pad, -pad, w + pad, -pad, w + pad, h + pad, -pad, h + pad];
    const apart = (ax: number, ay: number) => {
      let p0 = Infinity; let p1 = -Infinity; let r0 = Infinity; let r1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { const d = p[i]! * ax + p[i + 1]! * ay; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
      for (let i = 0; i < 8; i += 2) { const d = rect[i]! * ax + rect[i + 1]! * ay; r0 = Math.min(r0, d); r1 = Math.max(r1, d); }
      return p1 < r0 || p0 > r1;
    };
    if (!p.length || apart(1, 0) || apart(0, 1)) return false;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      const ex = p[j]! - p[i]!; const ey = p[j + 1]! - p[i + 1]!;
      if ((ex || ey) && apart(-ey, ex)) return false;
    }
    return true;
  };
  for (const op of ops) {
    const [k] = op;
    switch (k) {
      case '=fillStyle': st.fill = op[1]; break;
      case '=strokeStyle': st.stroke = op[1]; break;
      case '=lineWidth': st.lw = op[1] as number; break;
      case '=globalAlpha': st.alpha = op[1] as number; break;
      case 'save': stack.push({ ...st }); break;
      case 'restore': st = stack.pop() ?? st; break;
      case 'clearRect': out.push(`C|${op.slice(1).map(r3).join(',')}`); break;
      case 'beginPath': pts = []; break;
      case 'moveTo': case 'lineTo': pts.push(op[1] as number, op[2] as number); break;
      case 'arc': {
        const [x, y, r] = op.slice(1) as number[];
        pts.push(x! - r!, y! - r!, x! + r!, y! - r!, x! + r!, y! + r!, x! - r!, y! + r!);
        break;
      }
      case 'fill': {
        if (reaches(pts, 1)) out.push(`F|${String(st.fill)}|${r3(st.alpha)}|${pts.map(r3).join(',')}`);
        break;
      }
      case 'stroke': {
        if (reaches(pts, st.lw / 2 + 1)) out.push(`S|${String(st.stroke)}|${r3(st.lw)}|${r3(st.alpha)}|${pts.map(r3).join(',')}`);
        break;
      }
      case 'drawImage': {
        const img = op[1] as HTMLCanvasElement;
        const [x, y, iw, ih] = [op[2] as number, op[3] as number, (op[4] as number | undefined) ?? img.width, (op[5] as number | undefined) ?? img.height];
        if (hits(x, y, x + iw, y + ih, 1)) out.push(`I|${img.dataset?.text ?? img.dataset?.image ?? '?'}|${r3(st.alpha)}|${[x, y, iw, ih].map(r3).join(',')}`);
        break;
      }
      default: break;
    }
  }
  return out;
}
const digest = (g: string[]) => createHash('sha1').update(g.join('\n')).digest('hex').slice(0, 16);

// ── the windows over a fake game ──

class MemStorage implements UbStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

function fakeUi(): { ui: UbMapUi; canvases: OpCanvas[] } {
  const canvases: OpCanvas[] = [];
  const el = (tag = 'div') => document.createElement(tag);
  const kit = {
    text: () => el('span'), textTab: (_l: string, _on: boolean, onClick: () => void) => { const d = el(); d.addEventListener('click', onClick); return d; },
    flatButton: () => el(), slider: () => el('input'), check: () => el(), input: () => el('input'), list: () => {},
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
  } as unknown as UbMapUi['kit'];
  const ui: UbMapUi = {
    kit,
    open: (_key, _title, w, h) => {
      const root = el(); const body = el();
      body.style.width = `${w - 12}px`; body.style.height = `${h - 35}px`;
      root.appendChild(body); document.body.appendChild(root);
      return { body, root };
    },
    close: () => {},
    bare: () => null,
    textCanvas: (text) => { const c = el('canvas') as HTMLCanvasElement; c.width = text.length * 6; c.height = 12; c.dataset.text = text; return c; },
    image: (id) => { const c = el('canvas') as HTMLCanvasElement; c.width = 32; c.height = 32; c.dataset.image = String(id); return c; },
    canvas: (w, h) => {
      const c = el('canvas') as OpCanvas;
      c.width = w; c.height = h;
      c.ctx = new OpCtx();
      (c as unknown as { getContext: () => unknown }).getContext = () => c.ctx;
      canvases.push(c);
      return c;
    },
  };
  return { ui, canvases };
}

class Game implements UbMapHost {
  objs: UbMapObject[] = [];
  constructor(public self: UbMapSelf, readonly src: DungeonMapSource, readonly flags: (id: number) => number | null = () => 0) {}
  me() { return this.self; }
  objects() { return this.objs; }
  dungeonSource() { return this.src; }
  envCellFlags(id: number) { return this.flags(id); }
  terrain() { return null; }
  async mapTable(): Promise<MapTable> { return { markers: [], dungeons: new Map([[this.self.cell & 0xffff0000, 'Bench Dungeon']]) }; }
}

/** A settings store that counts its reads (the old draw read two settings per polygon). */
function countingStore() {
  const storage = new MemStorage();
  const store = new UbStore(() => ({ server: 'Bench', character: 'Tester' }), () => storage);
  let reads = 0;
  const bool = store.bool.bind(store); const num = store.num.bind(store);
  store.bool = (n: string) => { reads++; return bool(n); };
  store.num = (n: string) => { reads++; return num(n); };
  return { store, reads: () => reads, reset: () => { reads = 0; } };
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let live: UbMaps | null = null;
afterEach(() => { live?.closeAll(); live = null; document.body.replaceChildren(); });

async function openOn(game: Game) {
  const { ui, canvases } = fakeUi();
  const s = countingStore();
  const maps = new UbMaps(game, ui, s.store);
  live = maps;
  maps.toggle('dungeon');
  await settle();
  maps.tick();
  const canvas = () => (maps.dungeon as unknown as { canvas: OpCanvas }).canvas;
  expect(canvases).toContain(canvas());
  return { maps, canvas, s };
}

/** One forced redraw (the window redraws when what it shows changed): its ops, reads and time. */
function drawOnce(maps: UbMaps, at: () => OpCanvas, s: ReturnType<typeof countingStore>) {
  (maps.dungeon as unknown as { dirty: boolean }).dirty = true;
  const canvas = at();
  canvas.ctx.ops = [];
  s.reset();
  const t0 = performance.now();
  maps.tick();
  return { ms: performance.now() - t0, ops: canvas.ctx.ops, reads: s.reads() };
}

// ── a synthetic dungeon (CI): 24 × 24 rooms of 10 m on three floors ──

type V = { x: number; y: number; z: number };
function cellGeom(polys: V[][], origin: V): DungeonCellGeometry {
  const vertices = new Map<number, { origin: V; normal: V; uvs: [] }>();
  const physicsPolygons = new Map<number, { vertexIndices: number[] }>();
  let k = 0;
  polys.forEach((p, i) => {
    const idx: number[] = [];
    for (const v of p) { vertices.set(k, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(k++); }
    physicsPolygons.set(i, { vertexIndices: idx });
  });
  return { cellStruct: { vertexArray: { vertexType: 1, vertices }, physicsPolygons, polygons: new Map() } as never, position: { origin, orientation: { w: 1, x: 0, y: 0, z: 0 } } };
}
function room(): V[][] {
  const f: V[] = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }];
  const c: V[] = [...f].reverse().map((v) => ({ ...v, z: 4 }));
  const wall = (a: V, b: V): V[] => [{ ...a, z: 0 }, { ...a, z: 4 }, { ...b, z: 4 }, { ...b, z: 0 }];
  const step: V[] = [{ x: 2, y: 2, z: 1 }, { x: 4, y: 2, z: 1 }, { x: 4, y: 4, z: 1 }, { x: 2, y: 4, z: 1 }];
  const riser: V[] = [{ x: 2, y: 2, z: 0 }, { x: 2, y: 2, z: 1 }, { x: 4, y: 2, z: 1 }, { x: 4, y: 2, z: 0 }];
  return [f, c, step, riser, wall(f[0]!, f[1]!), wall(f[1]!, f[2]!), wall(f[2]!, f[3]!), wall(f[3]!, f[0]!)];
}
const LB = 0x01f60000;
function syntheticSource(): DungeonMapSource {
  const cells = new Map<number, DungeonCellGeometry>();
  let id = 0x100;
  for (const z of [0, 6, 12]) for (let gx = 0; gx < 24; gx++) for (let gy = 0; gy < 24; gy++) cells.set((LB | id++) >>> 0, cellGeom(room(), { x: gx * 10, y: gy * 10, z }));
  return { cellIds: () => [...cells.keys()], cell: (i) => cells.get(i) ?? null };
}
const ME_CELL = (LB | (0x100 + 576 + 12 * 24 + 12)) >>> 0;
function syntheticGame(): Game {
  const g = new Game({ guid: 0x50000001, name: 'Tester', cell: ME_CELL, x: 125, y: 125, z: 6, heading: 37 }, syntheticSource());
  for (let i = 0; i < 40; i++) g.objs.push({ guid: 0x80000000 + i, name: `Drudge ${i}`, objectClass: i % 5 === 0 ? 14 : 5, cell: ME_CELL, x: 20 + (i * 37) % 200, y: 20 + (i * 53) % 200, z: (i % 3) * 6 });
  g.objs.push({ guid: 0x80000100, name: 'Corpse of Tester', objectClass: 27, cell: ME_CELL, x: 130, y: 120, z: 6 });
  return g;
}

/**
 * The fixed states and their visible-call digests from the pre-fix draw (975047a77). A state: zoom (UB
 * scale), All, follow (else a fixed centre and rotation).
 */
const STATES: Array<{ name: string; scale: number; all: boolean; follow: boolean }> = [
  { name: 'default zoom, following, heading 37', scale: 0.8, all: false, follow: true },
  { name: 'zoomed out, All floors', scale: 0.3, all: true, follow: true },
  { name: 'zoomed in, panned, rotated 200', scale: 3, all: false, follow: false },
];
async function applyState(maps: UbMaps, st: (typeof STATES)[number]) {
  const d = maps.dungeon;
  d.scale = st.scale;
  d.showAll = st.all;
  if (!st.follow) { d.follow = false; d.offsetX = 90; d.offsetY = -140; d.rotation = 200; }
}

const SYNTH_GOLDEN: Record<string, string> = {
  'default zoom, following, heading 37': '306cdcf9c87b7109',
  'zoomed out, All floors': '0ab8794de96c88bd',
  'zoomed in, panned, rotated 200': '8898ea959d97b6d4',
};

describe('UB Dungeon Maps: the same picture, bounded work (synthetic 1,728-cell dungeon)', () => {
  for (const st of STATES) {
    it(`${st.name}: the calls that reach the canvas are the pre-fix draw's`, async () => {
      const g = syntheticGame();
      const { maps, canvas, s } = await openOn(g);
      expect(maps.dungeon.map?.cells.size).toBe(1728);
      await applyState(maps, st);
      const r = drawOnce(maps, canvas, s);
      const vis = visibleGroups(r.ops, canvas().width, canvas().height);
      if (BENCH) process.stderr.write(`[synthetic] ${st.name}: ${vis.length} visible / ${r.ops.length} ops, ${r.reads} setting reads, ${r.ms.toFixed(2)} ms, digest ${digest(vis)}` + "\n");
      expect(vis.length).toBeGreaterThan(10);
      if (!process.env.UB_MAP_CAPTURE) expect(digest(vis)).toBe(SYNTH_GOLDEN[st.name]);
      // Bounded (the pre-fix draw: 79,762 calls and 24,401 setting reads in every state, whatever was shown).
      expect(r.reads).toBeLessThan(600);
      if (st.scale >= 0.8) expect(r.ops.length).toBeLessThan(st.scale > 1 ? 5_000 : 25_000);
    });
  }

  it('a redraw reads no cell again and its setting reads do not grow with the dungeon', async () => {
    const g = syntheticGame();
    let reads = 0;
    const src = g.src;
    const counted: DungeonMapSource = { cellIds: (lb) => src.cellIds(lb), cell: (id) => { reads++; return src.cell(id); } };
    const big = new Game(g.self, counted);
    // Everything on your floor (a one-room dungeon below has only that floor).
    const objs = g.objs.map((o) => ({ ...o, z: 6 }));
    big.objs = objs;
    const a = await openOn(big);
    expect(reads).toBe(1728);
    for (let i = 0; i < 10; i++) { big.self = { ...big.self, x: big.self.x + 0.5, heading: big.self.heading + 5 }; drawOnce(a.maps, a.canvas, a.s); }
    expect(reads).toBe(1728);
    const bigReads = drawOnce(a.maps, a.canvas, a.s).reads;
    a.maps.closeAll();
    // The same objects over a dungeon of one room: the same number of setting reads.
    const one = new Game({ ...big.self }, { cellIds: () => [ME_CELL], cell: (id) => src.cell(id) });
    one.objs = objs;
    const b = await openOn(one);
    expect(b.maps.dungeon.map?.cells.size).toBe(1);
    (b.maps.dungeon as unknown as { visited: Set<number> }).visited = new Set((a.maps.dungeon as unknown as { visited: Set<number> }).visited);
    expect(drawOnce(b.maps, b.canvas, b.s).reads).toBe(bigReads);
  });

  it('a standing polygon\'s line is found when the map is built: its two farthest-apart points', async () => {
    const { maps } = await openOn(syntheticGame());
    const cell = maps.dungeon.map!.cells.get(ME_CELL)!;
    const wall = cell.polys.find((p) => p.kind === 'wall')!;
    expect(farthestPair(wall.pts)).toEqual([wall.a, wall.b]);
    // A 10 m wall seen from above: its ends are 10 m apart.
    expect(Math.hypot(wall.pts[wall.a]! - wall.pts[wall.b]!, wall.pts[wall.a + 1]! - wall.pts[wall.b + 1]!)).toBeCloseTo(10);
    // The cell's bounds hold all its points.
    for (const p of cell.polys) for (let i = 0; i < p.pts.length; i += 2) {
      expect(p.pts[i]!).toBeGreaterThanOrEqual(cell.minX); expect(p.pts[i]!).toBeLessThanOrEqual(cell.maxX);
      expect(p.pts[i + 1]!).toBeGreaterThanOrEqual(cell.minY); expect(p.pts[i + 1]!).toBeLessThanOrEqual(cell.maxY);
    }
  });

  it('UB settings still read by any spelling (the name index)', () => {
    const { store } = countingStore();
    expect(store.num('DungeonMaps.MapZoom')).toBe(4.2);
    expect(store.num('  dungeonmaps.MAPZOOM ')).toBe(4.2);
    expect(store.name('dungeonmaps.display.walls.color')).toBe('DungeonMaps.Display.Walls.Color');
    expect(store.name('NoSuch.Setting')).toBeNull();
  });
});

// ── the end-of-retail cell.dat ──

function datSource(cellDb: DatDatabase, portalDb: DatDatabase): DungeonMapSource {
  return {
    cellIds: (lb) => {
      const out: number[] = [];
      for (let i = 0x100; i < 0xfffe; i++) { const id = ((lb & 0xffff0000) | i) >>> 0; if (cellDb.hasFile(id)) out.push(id); else if (i > 0x1200) break; }
      return out;
    },
    cell: (id) => {
      const d = cellDb.getFileData(id);
      if (!d) return null;
      const ec = new EnvCell(new DatReader(d));
      const env = portalDb.getFileData(ec.environmentId);
      if (!env) return null;
      const cs = new Environment(new DatReader(env)).cells.get(ec.cellStructure);
      return cs ? { cellStruct: cs, position: ec.position } : null;
    },
  };
}

const DAT_GOLDEN: Record<string, string> = {
  '01F6:default zoom, following, heading 37': 'b87bd6cea8852938',
  '01F6:zoomed out, All floors': '9de41ed7727e96fb',
  '01F6:zoomed in, panned, rotated 200': '0084266d79c512bb',
  '00D1:default zoom, following, heading 37': '8d298fb2fbcd7531',
  '00D1:zoomed out, All floors': 'ab7f2ebf39d1a2ef',
  '00D1:zoomed in, panned, rotated 200': 'd9bd103f22e748b0',
};

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('UB Dungeon Maps over the end-of-retail cell.dat', () => {
  let cellDb: DatDatabase;
  let portalDb: DatDatabase;
  beforeAll(() => { cellDb = openDat(DAT_PATHS.cell); portalDb = openDat(DAT_PATHS.portal); });

  for (const lb of [0x01f60000, 0x00d10000]) {
    const name = lb.toString(16).padStart(8, '0').slice(0, 4).toUpperCase();
    it(`0x${name}: the same visible picture, and walking through it stays cheap`, async () => {
      const src = datSource(cellDb, portalDb);
      const ids = src.cellIds(lb);
      // Stand in the middle cell, at its origin.
      const mid = ids[Math.floor(ids.length / 2)]!;
      const pos = new EnvCell(new DatReader(cellDb.getFileData(mid)!)).position.origin;
      const g = new Game({ guid: 0x50000001, name: 'Tester', cell: mid, x: pos.x, y: pos.y, z: pos.z, heading: 37 }, src,
        (id) => { const d = cellDb.getFileData(id); return d ? new EnvCell(new DatReader(d)).flags : null; });
      for (let i = 0; i < 60; i++) g.objs.push({ guid: 0x80000000 + i, name: `Monster ${i}`, objectClass: 5, cell: mid, x: pos.x + ((i * 7) % 60) - 30, y: pos.y + ((i * 11) % 60) - 30, z: pos.z });
      const t0 = performance.now();
      const { maps, canvas, s } = await openOn(g);
      const loadMs = performance.now() - t0;
      const m = maps.dungeon.map!;
      expect(m.cells.size).toBeGreaterThan(50);
      let polys = 0;
      for (const c of m.cells.values()) polys += c.polys.length;
      for (const st of STATES) {
        await applyState(maps, st);
        const r = drawOnce(maps, canvas, s);
        const vis = visibleGroups(r.ops, canvas().width, canvas().height);
        // Timing: a walk of 20 beats, each one a redraw.
        const times: number[] = [];
        let ops = 0;
        for (let i = 0; i < 20; i++) {
          g.self = { ...g.self, x: g.self.x + 0.3, heading: (g.self.heading + 3) % 360 };
          const w = drawOnce(maps, canvas, s);
          times.push(w.ms);
          ops = Math.max(ops, w.ops.length);
        }
        times.sort((a, b) => a - b);
        if (BENCH) process.stderr.write(`[0x${name} ${m.cells.size} cells ${polys} polys, load ${loadMs.toFixed(0)} ms] ${st.name}: median ${times[10]!.toFixed(2)} ms max ${times[19]!.toFixed(2)} ms; ${vis.length} visible / ${r.ops.length} ops; ${r.reads} setting reads; digest ${digest(vis)}` + "\n");
        g.self = { ...g.self, x: pos.x, heading: 37 };
        const key = `${name}:${st.name}`;
        if (process.env.UB_MAP_DUMP) (await import('node:fs')).writeFileSync(`${process.env.UB_MAP_DUMP}/${name}-${STATES.indexOf(st)}.txt`, vis.join('\n'));
        if (!process.env.UB_MAP_CAPTURE) expect(digest(vis)).toBe(DAT_GOLDEN[key]);
      }
    }, 120_000);
  }
});

// ── the sweep: Landscape Maps over this era's whole marker table ──

describe('UB Landscape Maps: a redraw while following you is bounded by the markers in view', () => {
  it('end-of-retail markers, zoomed in on Holtburg, walking', async () => {
    const { ui, canvases } = fakeUi();
    const s = countingStore();
    const table = await loadMapTable('eol');
    const g = new Game({ guid: 1, name: 'Tester', cell: 0xa9b40019, x: 84, y: 96, z: 50, heading: 45 }, { cellIds: () => [], cell: () => null });
    g.mapTable = async () => table;
    const maps = new UbMaps(g, ui, s.store);
    live = maps;
    maps.toggle('landscape');
    await settle();
    maps.landscape.followMe();
    const results: string[] = [];
    for (const zoom of [0.24, 0.5, 1]) {
      maps.landscape.zoom = zoom;
      const times: number[] = [];
      let ops = 0;
      for (let i = 0; i < 20; i++) {
        g.self = { ...g.self, x: g.self.x + 0.5 };
        const c = canvases.find((x) => x.dataset.ubMapCanvas === 'ubLandscapeMaps')!;
        c.ctx.ops = [];
        const t0 = performance.now();
        maps.tick();
        times.push(performance.now() - t0);
        ops = Math.max(ops, c.ctx.ops.length);
      }
      times.sort((a, b) => a - b);
      results.push(`zoom ${zoom}: median ${times[10]!.toFixed(2)} ms, ${ops} ops`);
      expect(ops).toBeGreaterThan(10);
      // A redraw over thousands of markers stays well inside a frame.
      expect(times[10]!).toBeLessThan(16);
    }
    if (BENCH) process.stderr.write(`[landscape, ${table.markers.length} markers] ${results.join('; ')}\n`);
  });
});
