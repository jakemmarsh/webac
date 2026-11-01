/**
 * BUG.walkin-dungeon-objects-lost (webac#15, Coldeve, end of retail) — on the
 * Sword of Bellenesse quest every creature in the dungeon under the "hole in
 * the ground" at 0x40D8 (132, 60, 4) was invisible and unselectable while the
 * radar still listed it, and @objsend changed nothing.
 *
 * The hole is a building: LandblockInfo 0x40D8FFFE's one building has a
 * portal into 0x40D80101, and the stairs (0x100–0x102, 0x285 … 0x274, all
 * SeenOutside) lead into ~377 rooms that are not SeenOutside (from 0x278 on,
 * the Escaped Thief's 0x40D8014E among them). A player walks in, so the
 * client never enters interior mode (no teleport); the walked-into cell is
 * tracked as currentSurfaceCellId. ObjectMaint was keyed on the outdoor
 * block and kept only SeenOutside env cells there, so every object in the
 * sealed rooms left the world (lostCell: not drawn, not pickable), and an
 * @objsend CreateObject landed in the same "unloaded" cell.
 *
 * Retail, CellManager::ChangePosition @ 004559b0: the viewer's own cell
 * decides, however the player reached it; for an env cell it always calls
 * the cell's grab_visible (vtable +0x70: the cell + its VisibleCells), and
 * releases the landscape (LScape::release_all) only when the cell is not
 * seen_outside.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { isCellLoaded, viewerLoadCell, type ViewerLoadPoint } from '../packages/renderer/src/world/ObjectMaint.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCell, EnvCellFlags } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const LB = 0x40D8;
const BOSS_CELL = 0x40D8014E;
/** Block centre in AC world metres. */
const WX = 0x40 * 192 + 132;
const WY = 0xD8 * 192 + 60;

function createData(guid: number, landblock: number) {
  return {
    guid, name: 'Escaped Thief', weenieClassId: 32833, itemType: 0x10, setupId: 0x02000001,
    position: { landblock, x: 122, y: 33.05, z: -43.6, rw: 1, rx: 0, ry: 0, rz: 0 },
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
  };
}

function som(): ServerObjectManager {
  const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => ({ lights: new Map(), cylSpheres: [], spheres: [] }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
}

describe('viewerLoadCell — the viewer\'s own cell, however the player reached it', () => {
  const seen = (id: number) => (id & 0xffff) < 0x200;
  it('outdoors: the block', () => {
    expect(viewerLoadCell({ inDungeon: false, dungeonCellId: 0, surfaceCellId: 0, worldX: WX, worldY: WY, isSeenOutside: seen }))
      .toEqual({ viewerCellId: 0x40D8FFFF, sealed: false });
  });
  it('a walked-into SeenOutside cell keeps the landscape; a walked-into sealed cell releases it', () => {
    expect(viewerLoadCell({ inDungeon: false, dungeonCellId: 0, surfaceCellId: 0x40D80101, worldX: WX, worldY: WY, isSeenOutside: seen }))
      .toEqual({ viewerCellId: 0x40D80101, sealed: false });
    expect(viewerLoadCell({ inDungeon: false, dungeonCellId: 0, surfaceCellId: 0x40D80278, worldX: WX, worldY: WY, isSeenOutside: seen }))
      .toEqual({ viewerCellId: 0x40D80278, sealed: true });
  });
  it('interior mode (a teleport in) is unchanged: its cell, sealed unless it sees outside', () => {
    expect(viewerLoadCell({ inDungeon: true, dungeonCellId: 0x01D90108, surfaceCellId: 0x40D80101, worldX: WX, worldY: WY, isSeenOutside: () => false }))
      .toEqual({ viewerCellId: 0x01D90108, sealed: true });
    expect(viewerLoadCell({ inDungeon: true, dungeonCellId: 0x40D80285, surfaceCellId: 0, worldX: WX, worldY: WY, isSeenOutside: () => true }))
      .toEqual({ viewerCellId: 0x40D80285, sealed: false });
  });
});

describe('isCellLoaded — a SeenOutside env viewer grabs its visible cells (ChangePosition @ 004559b0)', () => {
  const v = (over: Partial<ViewerLoadPoint>): ViewerLoadPoint => ({
    viewerCellId: 0x40D80277, sealed: false, midRadius: 4,
    isSeenOutside: (id) => (id & 0xffff) === 0x277 || (id & 0xffff) === 0x101,
    visibleCells: () => new Set([0x278, 0x279]), ...over,
  });
  it('keeps the landscape 3×3 and its SeenOutside cells, plus the sealed rooms on its stab list', () => {
    expect(isCellLoaded(0x40D8002B, v({}))).toBe(true);
    expect(isCellLoaded(0x41D8FFFF, v({}))).toBe(true);
    expect(isCellLoaded(0x40D80101, v({}))).toBe(true);
    expect(isCellLoaded(0x40D80278, v({}))).toBe(true);
    expect(isCellLoaded(0x40D8014E, v({}))).toBe(false); // not on 0x277's stab list
  });
  it('an outdoor viewer still drops the sealed rooms', () => {
    expect(isCellLoaded(0x40D80278, v({ viewerCellId: 0x40D8FFFF }))).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell))('webac#15 — the Sword of Bellenesse dungeon 0x40D8 (real cell.dat)', () => {
  let db: DatDatabase;
  const cells = new Map<number, EnvCell>();
  const cell = (idx: number): EnvCell => {
    let c = cells.get(idx);
    if (!c) { c = new EnvCell(new DatReader(db.getFileData(((LB << 16) | idx) >>> 0)!)); cells.set(idx, c); }
    return c;
  };
  const isSO = (id: number) => (cell(id & 0xffff).flags & EnvCellFlags.SeenOutside) !== 0;
  const vis = (id: number) => new Set(cell(id & 0xffff).visibleCells);
  /** Every cell walkable from the building's doorway, with the route back to it. */
  const prev = new Map<number, number>();
  beforeAll(() => {
    db = openDat(DAT_PATHS.cell);
    const info = new LandblockInfo(new DatReader(db.getFileData(((LB << 16) | 0xFFFE) >>> 0)!));
    expect(info.buildings).toHaveLength(1);
    const q = info.buildings[0].portals.map((p) => p.otherCellId);
    for (const c of q) prev.set(c, -1);
    while (q.length) {
      const c = q.shift()!;
      for (const p of cell(c).cellPortals) {
        if (p.otherCellId === 0xffff || prev.has(p.otherCellId)) continue;
        prev.set(p.otherCellId, c);
        q.push(p.otherCellId);
      }
    }
  });

  const load = (surfaceCellId: number): ViewerLoadPoint => ({
    ...viewerLoadCell({ inDungeon: false, dungeonCellId: 0, surfaceCellId, worldX: WX, worldY: WY, isSeenOutside: isSO }),
    midRadius: 4, isSeenOutside: isSO, visibleCells: vis,
  });

  it('the boss room is walked to from the street, and the walk crosses from SeenOutside stairs into sealed rooms', () => {
    expect(prev.has(BOSS_CELL & 0xffff)).toBe(true);
    const route: number[] = [];
    for (let c = BOSS_CELL & 0xffff; c !== -1; c = prev.get(c)!) route.unshift(c);
    expect(route[0]).toBe(0x101);
    expect(isSO(route[0])).toBe(true);
    expect(isSO(BOSS_CELL)).toBe(false);
    expect(route.findIndex((c) => !isSO(c))).toBeGreaterThan(0);
    expect(cell(0x278).flags & EnvCellFlags.SeenOutside).toBe(0);
  });

  it('every cell a walking player stands in keeps itself and its visible cells loaded (was: none of the sealed ones)', () => {
    let before = 0;
    let after = 0;
    const outdoorViewer: ViewerLoadPoint = { viewerCellId: 0x40D8FFFF, sealed: false, midRadius: 4, isSeenOutside: isSO, visibleCells: vis };
    for (const v of prev.keys()) {
      const neu = load(((LB << 16) | v) >>> 0);
      for (const t of [v, ...cell(v).visibleCells]) {
        const id = ((LB << 16) | t) >>> 0;
        if (!isCellLoaded(id, outdoorViewer)) before++;
        if (!isCellLoaded(id, neu)) after++;
      }
    }
    expect(before).toBeGreaterThan(10_000);
    expect(after).toBe(0);
  });

  it('the Escaped Thief is drawn from the rooms that see it, hidden again back on the street', () => {
    const s = som();
    const thief = s.createObject(createData(0x80001234, BOSS_CELL) as never)!;
    let v = load(0x40D8014F); // the room beside it, sealed
    expect(v.sealed).toBe(true);
    s.updateObjectMaint((id) => isCellLoaded(id, v), 0, v.viewerCellId);
    expect(thief.lostCell).toBeFalsy();
    expect(thief.mesh!.visible).toBe(true);
    // An @objsend resend while standing there stays drawn.
    s.deleteObject(thief.guid);
    const resent = s.createObject(createData(0x80001234, BOSS_CELL) as never)!;
    s.updateObjectMaint((id) => isCellLoaded(id, v), 1, v.viewerCellId);
    expect(resent.lostCell).toBeFalsy();
    expect(resent.mesh!.visible).toBe(true);
    // A room that does not see it (the stairs, SeenOutside): it leaves visibility, as in retail.
    v = load(0x40D80277);
    s.updateObjectMaint((id) => isCellLoaded(id, v), 2);
    expect(resent.lostCell).toBe(true);
    // Back out on the street: no sealed state lingers, the outdoor block is loaded.
    v = load(0);
    expect(v).toMatchObject({ viewerCellId: 0x40D8FFFF, sealed: false });
    expect(isCellLoaded(0x40D8002B, v)).toBe(true);
    expect(isCellLoaded(BOSS_CELL, v)).toBe(false);
  });
});
