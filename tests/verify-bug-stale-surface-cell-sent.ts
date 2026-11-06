/**
 * BUG.stale-surface-cell-sent (Coldeve, ACE, end of retail, trace 4eb5c38a35de7ef2, 2026-11-06).
 *
 * Two walk-ins into the Drudge Hideout portal (wcid 2068, cell 0xA9B30002) did nothing (portal_use_failed,
 * no refusal) after the same walk-in had worked half an hour earlier. The position the client last SENT
 * named cell 0xA9B40162, a room of a Holtburg building ~200 m away, with the origin at local y ≈ −156: the
 * real spot in 0xA9B3 expressed in the wrong block's frame. ACE takes the client's cell (Player_Tick.cs
 * UpdatePlayerPosition → LScape.get_landcell(newPosition.Cell)), so it had the player indoors and its
 * transition never reached the outdoor portal.
 *
 * Root cause: the surface-cell tracking (main.ts updateSurfaceCellVisibility → DungeonCollision.nextBodyCell)
 * keeps a body's env cell while the body is in no cell's volume and reaches no outside portal of that cell
 * (strayScope: retail keeps the env cell when check_other_cells finds no new one). 0xA9B40162 has no outside
 * portal of its own (all six portals lead to other rooms), so once the body left it without a swept
 * transition (a server blip — applyServerPositionCorrection's snap / blend moves the body straight to the
 * server's spot, through walls) the cell was kept everywhere in the world, and every AutonomousPosition named it.
 *
 * Fixes: strayScope keeps the cell only while the body is beside it (STRAY_CELL_REACH); a server snap
 * outdoors restarts the surface cell at the destination; MovementSync never sends a surface room whose frame
 * puts the body outside SURFACE_CELL_FRAME_SLACK of the room's block (the land cell goes instead, counted
 * and reported once). Dungeon frames are never checked (their cells' frames are their own).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DungeonCollision, STRAY_CELL_REACH } from '../packages/renderer/src/world/DungeonCollision.js';
import { MovementSync, SURFACE_CELL_FRAME_SLACK, surfaceCellFrameSane, type PlayerPosition, type MovementState } from '../packages/renderer/src/network/MovementSync.js';
import { DAT_PATHS } from './_harness/dat.js';

type V3 = [number, number, number];
const IDQ = { w: 1, x: 0, y: 0, z: 0 };

/** The plane chain of a box x −5..5, y −2..2, z −1..4 (CELL BSP: behind any plane = outside). */
function boxCellBsp() {
  const planes: [V3, number][] = [[[1, 0, 0], 5], [[-1, 0, 0], 5], [[0, 1, 0], 2], [[0, -1, 0], 2], [[0, 0, 1], 1], [[0, 0, -1], 4]];
  let node: unknown;
  for (const [[x, y, z], distance] of planes.reverse()) node = { splittingPlane: { normal: { x, y, z }, distance }, posNode: node };
  return node;
}

/** A room (the box) with a floor at z 0 and no portal to the outside. */
function room() {
  const vertices = new Map<number, unknown>();
  const quad: V3[] = [[-5, -2, 0], [5, -2, 0], [5, 2, 0], [-5, 2, 0]];
  quad.forEach(([x, y, z], i) => vertices.set(i, { origin: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, uvs: [] }));
  const poly = { vertexIndices: [0, 1, 2, 3], numPts: 4, stippling: 0, sidesType: 0, posSurface: 0, negSurface: 0, posUVIndices: [], negUVIndices: [] };
  const polygons = new Map([[0, poly]]);
  const leaf = { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 6 }, inPolys: [0] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { vertexArray: { vertices }, polygons, portals: [], physicsPolygons: polygons, physicsBSP: { rootNode: leaf }, cellBSP: { rootNode: boxCellBsp() }, drawingBSP: null } as any;
}

/** Block 0x0101 (global offset 192, 192); the room at block-local (50, 50). */
const ROOM = 0x01010100;
function world(): DungeonCollision {
  const dc = new DungeonCollision();
  // Registered with its portals: no outside portal, one neighbour (another room of the building, far off).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.addCell(ROOM, room(), { origin: { x: 50, y: 50, z: 0 }, orientation: IDQ } as any, [], [0x01010101]);
  return dc;
}
const G = 192;

describe('nextBodyCell — a body keeps its env cell only while it is beside it', () => {
  it('in the room: the room', () => {
    expect(world().nextBodyCell(ROOM, G + 50, G + 50, 0.1)).toBe(ROOM);
  });
  it('a seam just past the wall (the walls reach past the volume): still the room, as retail keeps it', () => {
    expect(world().nextBodyCell(ROOM, G + 50, G + 52.8, 0.1)).toBe(ROOM);
  });
  it('blipped 200 m away (no swept transition left the room): outdoors, not the room (was: the room, forever)', () => {
    const dc = world();
    expect(dc.nextBodyCell(ROOM, G + 50, G - 150, 0.1)).toBe(0);
    expect(dc.reachesLandCells(G + 50, G - 150, 0.1)).toBe(true);
    // Just past the reach: gone too.
    expect(dc.nextBodyCell(ROOM, G + 50, G + 52 + STRAY_CELL_REACH + 1.5, 0.1)).toBe(0);
  });
  it('the body cell set to the room no longer cuts a far body off the land cells (the terrain rules apply)', () => {
    const dc = world();
    dc.setBodyCell(ROOM);
    expect(dc.reachesLandCells(G + 50, G - 150, 0.1)).toBe(true);
    expect(dc.reachesLandCells(G + 50, G + 52.8, 0.1)).toBe(false);
  });
});

// ── The outgoing position ──

const IDLE: MovementState = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };

function sync() {
  const sent: Uint8Array[] = [];
  const ms = new MovementSync({ sendMessage: (m: Uint8Array) => { sent.push(m); } } as never, () => 1);
  const corrected: [number, number][] = [];
  ms.onSurfaceCellCorrected = (stale, cell) => corrected.push([stale >>> 0, cell >>> 0]);
  return { ms, sent, corrected };
}

function at(worldX: number, worldZ: number, extra: Partial<PlayerPosition> = {}): PlayerPosition {
  return {
    worldX, worldZ, groundY: 94, playerYaw: 0,
    landblock: 0, localX: 0, localY: 0, localZ: 94, inDungeon: false, onGround: true, ...extra,
  };
}

/** The prod frame: the body at 0xA9B3 (14.3, 36), the surface cell still 0xA9B40162. */
const A9B3 = { x: 0xa9 * 192 + 14.3, y: 0xb3 * 192 + 36 };

describe('MovementSync — an outgoing position never names a surface room the body is nowhere near', () => {
  it('the Coldeve frame goes out as the land cell under the body (was: 0xA9B40162 at local y −156)', () => {
    const { ms, corrected } = sync();
    ms.update(IDLE, at(A9B3.x, A9B3.y, { surfaceCell: 0xa9b40162 }), 1000);
    const f = ms.lastSentFrame!;
    expect((f.cellId >>> 16).toString(16)).toBe('a9b3');
    expect(f.cellId & 0xffff).toBeLessThan(0x100);
    expect(f.cellId & 0xffff).toBe(Math.floor(14.3 / 24) * 8 + Math.floor(36 / 24) + 1);
    expect(f.x).toBeCloseTo(14.3, 4);
    expect(f.y).toBeCloseTo(36, 4);
    expect(ms.surfaceCellCorrections).toBe(1);
    expect(corrected).toEqual([[0xa9b40162, f.cellId >>> 0]]);
  });

  it('counted once while the same stale room keeps coming (a frame builds its position twice)', () => {
    const { ms, corrected } = sync();
    ms.update(IDLE, at(A9B3.x, A9B3.y, { surfaceCell: 0xa9b40162 }), 1000);
    ms.update(IDLE, at(A9B3.x + 3, A9B3.y, { surfaceCell: 0xa9b40162 }), 3000);
    expect(ms.surfaceCellCorrections).toBe(1);
    expect(corrected.length).toBe(1);
  });

  it('a room the body is in still goes out as the room, in its own block\'s frame', () => {
    const { ms } = sync();
    ms.update(IDLE, at(0xa9 * 192 + 107.5, 0xb4 * 192 + 36, { surfaceCell: 0xa9b40162 }), 1000);
    expect(ms.lastSentFrame).toMatchObject({ cellId: 0xa9b40162 });
    expect(ms.lastSentFrame!.x).toBeCloseTo(107.5, 4);
    expect(ms.surfaceCellCorrections).toBe(0);
  });

  it('a starter cottage\'s room south of its block (portal.dat CharGen: y −28.482) is kept', () => {
    const { ms } = sync();
    ms.update(IDLE, at(0x12 * 192 + 60, 0x34 * 192 - 28.482, { surfaceCell: 0x12340105 }), 1000);
    expect(ms.lastSentFrame).toMatchObject({ cellId: 0x12340105 });
    expect(ms.lastSentFrame!.y).toBeCloseTo(-28.482, 3);
    expect(ms.surfaceCellCorrections).toBe(0);
  });

  it('a dungeon\'s frame is never checked (its cell and coordinates are its own)', () => {
    const { ms } = sync();
    // A 0x01xx dungeon block: the body's world position far from 0x019E × 192 is the dungeon's own frame.
    ms.update(IDLE, at(0x01 * 192 - 400, 0x9e * 192 + 900, { inDungeon: true, landblock: 0x019e0120 }), 1000);
    expect(ms.lastSentFrame).toMatchObject({ cellId: 0x019e0120 });
    expect(ms.lastSentFrame!.x).toBeCloseTo(-400, 3);
    expect(ms.surfaceCellCorrections).toBe(0);
  });

  it('outdoors with no room: the land cell, local coordinates in [0, 192)', () => {
    const { ms } = sync();
    ms.update(IDLE, at(A9B3.x, A9B3.y), 1000);
    const f = ms.lastSentFrame!;
    expect(f.cellId >>> 16).toBe(0xa9b3);
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeLessThan(192);
    expect(ms.surfaceCellCorrections).toBe(0);
  });

  it('surfaceCellFrameSane: the slack covers every SeenOutside room origin of the end-of-retail cell.dat (x −38..226, y −30..245)', () => {
    expect(SURFACE_CELL_FRAME_SLACK).toBeGreaterThanOrEqual(60);
    expect(surfaceCellFrameSane(-38 - 20, 245 + 20)).toBe(true);
    expect(surfaceCellFrameSane(14.3, -156)).toBe(false);
  });
});

// ── The real room: Holtburg 0xA9B40162 (end-of-retail DATs) ──

const haveDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!haveDat)('Holtburg 0xA9B40162 — the room the Coldeve player was held in', () => {
  let dc: DungeonCollision;
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    const base = (await buildLandblockWorld(0xa9, 0xb4, { interiors: true }))({ slidingNormal: null });
    dc = base.outdoorCollision as DungeonCollision;
  }, 120_000);

  it('the room is registered with no outside portal of its own (so the doorway rule alone never let it go)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cell = (dc as any).envCells.get(0xa9b40162) as { outsidePlanes?: unknown[]; neighbors?: number[] };
    expect(cell.outsidePlanes).toEqual([]);
    expect(cell.neighbors?.length).toBe(6);
  });

  it('a body blipped from it to the Drudge Hideout portal (0xA9B3 (14.3, 36)) is outdoors (was: still 0xA9B40162)', () => {
    expect(dc.nextBodyCell(0xa9b40162, A9B3.x, A9B3.y, 94)).toBe(0);
    let kept = 0;
    for (let x = 0; x < 192; x += 8) for (let y = 0; y < 192; y += 8) {
      if (dc.nextBodyCell(0xa9b40162, 0xa9 * 192 + x, 0xb3 * 192 + y, 94) === 0xa9b40162) kept++;
    }
    expect(kept).toBe(0);
  });
});
