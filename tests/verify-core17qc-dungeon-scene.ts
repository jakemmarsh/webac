/**
 * CORE.17.q.c — the whole-screen harness's dungeon scene could not show a
 * lighting delta: the Training Academy cave (0x86020115) has no retail
 * reference and its probe frames were pixel-identical under every lighting
 * change (verification/core17q). This adds a light-stone torch-lit scene on
 * the set the retail references rawg_04 / rawg_09 actually show — the
 * Holtburg Dungeon (0x01F6): wall 0x0800016f (tan cobble), beams 0x08000176,
 * the dark brick floor 0x0800016e, 157 lit stabs — plus a midnight variant,
 * landing on the portal's own Destination from the world DB
 * (portalholtburgdungeon → 0x01F60289 (96.7, -10, 0)).
 *
 * Under test: (1) the scene table the harness runs (tools/capture-scenes.ts,
 * imported — the harness itself runs on import): both scenes, their drop
 * point, the noon / midnight pins, the retail refs; (2) the DAT premise
 * through the shipped parsers: the drop cell parses as a sealed EnvCell of
 * that landblock, the landblock's dominant textured surface is the tan cobble
 * and it is torch-lit (SetupModel lights on its stabs) — the two properties
 * the scene exists for.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES, DUNGEON_STONE, DUNGEON } from '../tools/capture-scenes.js';
import { DatDatabase, EnvCell, EnvCellFlags, Surface, SetupModel } from '../packages/dat-parser/src/index.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const CELL_DAT = resolve(ROOT, 'dat/client_cell_1.dat');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const HAVE_DATS = existsSync(CELL_DAT) && existsSync(PORTAL_DAT);

const DROP_CELL = 0x01f60289;
const LANDBLOCK = 0x01f6;
const TAN_COBBLE = 0x0800016f;

function parseTeleloc(cmd: string) {
  const m = /^@teleloc (0x[0-9A-Fa-f]{8}) \[(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/.exec(cmd);
  if (!m) throw new Error('not a full @teleloc: ' + cmd);
  return { cell: parseInt(m[1], 16), x: +m[2], y: +m[3], z: +m[4], q: [+m[5], +m[6], +m[7], +m[8]] };
}

describe('CORE.17.q.c — the scene table carries a light-stone torch-lit dungeon + its night variant', () => {
  const day = SCENES.find((s) => s.name === 'world-dungeon-stone')!;
  const night = SCENES.find((s) => s.name === 'world-dungeon-stone-night')!;

  it('both scenes exist, next to (not instead of) the Academy cave scene', () => {
    expect(day).toBeDefined();
    expect(night).toBeDefined();
    const cave = SCENES.find((s) => s.name === 'world-dungeon');
    expect(cave?.teleport).toBe(DUNGEON);
    expect(SCENES.filter((s) => s.teleport === DUNGEON_STONE).map((s) => s.name)).toEqual(['world-dungeon-stone', 'world-dungeon-stone-night']);
  });

  it("the drop point is ACE's full @teleloc form into the Holtburg Dungeon's portal Destination cell", () => {
    const t = parseTeleloc(DUNGEON_STONE);
    expect(t.cell).toBe(DROP_CELL);
    expect(t.cell >>> 16).toBe(LANDBLOCK);
    expect(t.x).toBeCloseTo(96.7, 1);
    expect(t.y).toBeCloseTo(-10, 1);
    expect(t.z).toBe(0);
    // a unit quaternion (the portal's facing), not the bare '1 0 0 0'
    const n = Math.hypot(...t.q);
    expect(n).toBeCloseTo(1, 2);
    expect(day.teleport).toBe(DUNGEON_STONE);
    expect(night.teleport).toBe(DUNGEON_STONE);
  });

  it('noon and midnight pins, the same framing, no weather, the retail dungeon refs', () => {
    expect(day.timeOfDay).toBe(0.5);
    expect(night.timeOfDay).toBe(0.0);
    expect(day.yaw).toBe(night.yaw);
    expect(day.yaw).toBeCloseTo(1.6, 5);
    expect(day.weather).toBeUndefined();
    expect(night.weather).toBeUndefined();
    for (const s of [day, night]) {
      expect(s.refs).toContain('rawg_04.jpg');
      expect(s.refs).toContain('rawg_09.jpg');
      expect(s.settleMs).toBeGreaterThanOrEqual(9000);
    }
  });

  it('the scene names are unique across the table', () => {
    const names = SCENES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.skipIf(!HAVE_DATS)('CORE.17.q.c — the DAT premise: a sealed, tan-cobble, torch-lit landblock', () => {
  let cell: DatDatabase;
  let portal: DatDatabase;
  let cells: EnvCell[];

  beforeAll(() => {
    cell = openDat(CELL_DAT);
    portal = openDat(PORTAL_DAT);
    cells = cell
      .listFileIds()
      .filter((id) => id >>> 16 === LANDBLOCK && (id & 0xffff) >= 0x100 && (id & 0xffff) <= 0xfffd)
      .map((id) => new EnvCell(cell.getReader(id)));
  });

  it('the drop cell parses as an EnvCell of the landblock and nothing in it is SeenOutside', () => {
    expect(cell.hasFile(DROP_CELL)).toBe(true);
    const drop = new EnvCell(cell.getReader(DROP_CELL));
    expect(drop.id).toBe(DROP_CELL);
    expect(cells.length).toBeGreaterThan(300);
    expect(cells.every((c) => (c.flags & EnvCellFlags.SeenOutside) === 0)).toBe(true);
  });

  it('the dominant textured surface is the tan cobble wall 0x0800016f (the rawg_04 set)', () => {
    const count = new Map<number, number>();
    for (const c of cells) for (const s of c.surfaces) count.set(s, (count.get(s) ?? 0) + 1);
    const textured = [...count.entries()]
      .filter(([sid]) => Surface.read(portal.getReader(sid)).origTextureId !== 0)
      .sort((a, b) => b[1] - a[1]);
    // the wall and the grate floor 0x08000170 share the top two slots (385 / 369 cells)
    expect(textured.slice(0, 2).map(([sid]) => sid)).toContain(TAN_COBBLE);
    // in most of the landblock's cells, not a single room
    expect(count.get(TAN_COBBLE)! / cells.length).toBeGreaterThan(0.75);
    // the drop cell is the portal's own arrival room (surfaces 0x08000174 /
    // 0x08000175) opening into the set — the scene's yaw 1.6 looks through it
    const drop = new EnvCell(cell.getReader(DROP_CELL));
    expect(drop.cellPortals.length).toBeGreaterThan(0);
    expect(drop.visibleCells.some((low) => cells.find((c) => (c.id & 0xffff) === low)?.surfaces.includes(TAN_COBBLE))).toBe(true);
  });

  it('it is torch-lit: over a hundred stabs carry SetupModel lights', () => {
    const lit = new Map<number, boolean>();
    let torches = 0;
    for (const c of cells) for (const so of c.staticObjects) {
      if (!lit.has(so.id)) lit.set(so.id, (so.id >>> 24) === 0x02 && new SetupModel(portal.getReader(so.id)).lights.size > 0);
      if (lit.get(so.id)) torches++;
    }
    expect(torches).toBeGreaterThan(100);
  });
});
