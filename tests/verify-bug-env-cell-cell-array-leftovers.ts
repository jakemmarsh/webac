/**
 * BUG.env-cell-cell-array-leftovers — the rest of retail's cell rule
 * (CEnvCell::find_transit_cells @ 0052c820: a body's cell array is its
 * cell, the cells its portals lead to, and the land cells only near an
 * outside portal) after the classic bunker fixes (a1a5eb85).
 *
 * 1. Every registered env cell took part in every test, and the cell search
 *    scanned all cells in id order. A sweep of both eras' cell.dats for env
 *    cells of one landblock that overlap with no portal path between them
 *    found real ones in play: Eastham's two portal bunkers (0xCE94, both
 *    eras: Env 0x0D0003F4, the classic town bunker, whose rooms under the
 *    town overlap), and the basements of the olthoi mounds (building
 *    0x01004031) at 0xC4B5 (the Paradox-touched Olthoi) and 0xE6D3 (the
 *    Olthoi Queen's lair). In the overlap one basement's walls blocked a player walking in
 *    the other and its floors held them up, and a body stepping from one
 *    cell to the next was placed in the other building's cell (the cell
 *    tracking and the indoor view followed). In interior mode (an arrival
 *    in a sealed cell registers every cell of the landblock) a villa's
 *    dangling cell 0x03B4 (its one portal leads to 0x03B3, none back) froze
 *    the body in the villa's entry room 0x0103.
 * 2. Trees and landblock statics (CylSphere / Sphere obstacles) blocked a
 *    body in an env cell away from its outside portals.
 * 3. A missile's terrain test skipped every sample in an env cell, near its
 *    outside portal too.
 * 4. A remote body's cell jumped to the newest server position's when it
 *    came, while the interpolation still carried the body there.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import { RemotePhysicsObject, landCellAt, type RemotePhysicsEnv } from '../packages/renderer/src/world/RemotePhysics.js';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const haveEol = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const CLASSIC = {
  portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'),
  cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat'),
};
const haveClassic = existsSync(CLASSIC.portal) && existsSync(CLASSIC.cell);
const IDQ = { w: 1, x: 0, y: 0, z: 0 };

/** One step of the body from its floor at (x, y) local, as the movement asks it. */
function step(dc: DungeonCollision, bx: number, by: number, x: number, y: number, floorZ: number, dx: number, dy: number): [number, number] {
  return dc.getAdjustedMovement(new THREE.Vector3(bx * 192 + x, floorZ, by * 192 + y), dx, dy);
}

/** A point inside both cells (each found when it is the preferred one), searched on a grid over `box` (local x, y, z). */
function pointInBoth(dc: DungeonCollision, bx: number, by: number, a: number, b: number, box: [number, number, number, number, number, number]) {
  const [x0, x1, y0, y1, z0, z1] = box;
  for (let x = x0; x <= x1; x += 0.25) for (let y = y0; y <= y1; y += 0.25) for (let z = z0; z <= z1; z += 0.25) {
    const gx = bx * 192 + x, gy = by * 192 + y;
    if (dc.findCellContaining(gx, gy, z, a) === a && dc.findCellContaining(gx, gy, z, b) === b) return { gx, gy, z };
  }
  return null;
}

describe.skipIf(!haveEol)('two olthoi mounds\' basements in one space (0xC4B5, end of retail)', () => {
  let dc: DungeonCollision;
  const HOME = 0xc4b502f7; // the second mound's basement
  const OTHER = 0xc4b50342; // the third mound's, overlapping it
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    dc = (await buildLandblockWorld(0xc4, 0xb5, { interiors: true }))({ slidingNormal: null }).outdoorCollision as DungeonCollision;
  }, 180_000);

  it('the two cells are registered, overlap, and no portal path joins them', () => {
    expect(dc.hasCell(HOME) && dc.hasCell(OTHER)).toBe(true);
    expect(pointInBoth(dc, 0xc4, 0xb5, HOME, OTHER, [69, 73, 113, 117, 216.5, 219])).not.toBeNull();
  });

  it('a body in its basement walks where the other basement\'s wall stands', () => {
    dc.setBodyCell(HOME);
    // (69.3, 115.4) local on HOME's floor, a half metre south-east: blocked dead by OTHER's wall before.
    const [dx, dy] = step(dc, 0xc4, 0xb5, 69.3, 115.4, 216.45, 0.5 * Math.SQRT1_2, -0.5 * Math.SQRT1_2);
    expect(dx).toBeCloseTo(0.5 * Math.SQRT1_2, 3);
    expect(dy).toBeCloseTo(-0.5 * Math.SQRT1_2, 3);
  });

  it('its floor is its own cell\'s, not the other basement\'s 8 cm above it', () => {
    dc.setBodyCell(HOME);
    expect(dc.getFloorHeight(0xc4 * 192 + 69.8, 0xb5 * 192 + 114.9, 216.75)).toBeCloseTo(216.45, 2);
  });

  it('stepping on from a neighbour, the body is found in the next cell of its own basement', () => {
    const p = pointInBoth(dc, 0xc4, 0xb5, OTHER, HOME, [69, 74, 113, 117, 216.5, 219])!;
    // 0x0340 leads to 0x0342: by id order the scan named 0x02F7, the other mound's.
    expect(dc.findCellContaining(p.gx, p.gy, p.z, 0xc4b50340)).toBe(OTHER);
    // And from the other side, the other way.
    const q = pointInBoth(dc, 0xc4, 0xb5, HOME, OTHER, [69, 74, 113, 117, 216.5, 219])!;
    expect(dc.findCellContaining(q.gx, q.gy, q.z, 0xc4b502f8)).toBe(HOME);
  });

  it('a body outdoors (no body cell) still meets every cell', () => {
    dc.setBodyCell(0);
    expect(dc.reachesLandCells(0xc4 * 192 + 100, 0xb5 * 192 + 20, 240)).toBe(true);
  });
});

describe.skipIf(!haveEol)('the Olthoi Queen\'s lair: two mounds\' basements (0xE6D3, end of retail)', () => {
  let dc: DungeonCollision;
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    dc = (await buildLandblockWorld(0xe6, 0xd3, { interiors: true }))({ slidingNormal: null }).outdoorCollision as DungeonCollision;
  }, 180_000);

  it('a body in 0x015D walks through where 0x01A2 (the other mound) stands', () => {
    dc.setBodyCell(0xe6d3015d);
    const floor = dc.getFloorHeight(0xe6 * 192 + 27.2, 0xd3 * 192 + 92.7, -16.6)!;
    expect(floor).not.toBeNull();
    const [dx, dy] = step(dc, 0xe6, 0xd3, 27.2, 92.7, floor, 0.5 * Math.SQRT1_2, -0.5 * Math.SQRT1_2);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0.45);
  });
});

describe.skipIf(!haveEol)('interior mode registers every cell: a villa\'s dangling cell (0xD2D4, end of retail)', () => {
  let dc: DungeonCollision;
  beforeAll(async () => {
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { populateDungeonCollision } = await import('../packages/renderer/src/world/DungeonCollisionBuild.js');
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const env = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    const lbInfo = (lb: number) => {
      const d = cellDb.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0);
      return d ? new LandblockInfo(new DatReader(d)) : null;
    };
    dc = new DungeonCollision();
    // main.ts's buildDungeonCollision: every cell of the landblock (LandblockInfo.numCells).
    populateDungeonCollision(dc, 0xd2d4ffff, {
      findInteriorCells: (lb) => {
        const info = lbInfo(lb)!;
        const out: number[] = [];
        for (let i = 0; i < info.numCells; i++) {
          const id = ((lb & 0xffff0000) | (0x100 + i)) >>> 0;
          if (cellDb.hasFile(id)) out.push(id);
        }
        return out;
      },
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
      loadLandblockInfo: lbInfo,
    });
  }, 120_000);

  it('the dangling cell is registered, and its walls no longer hold a body in the entry room', () => {
    expect(dc.hasCell(0xd2d403b4)).toBe(true);
    dc.setBodyCell(0xd2d40103);
    const floor = dc.getFloorHeight(0xd2 * 192 + 129.5, 0xd4 * 192 + 185.4, 1)!;
    expect(floor).not.toBeNull();
    const [dx, dy] = step(dc, 0xd2, 0xd4, 129.5, 185.4, floor, 0.5 * Math.SQRT1_2, -0.5 * Math.SQRT1_2);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0.45);
  });

  it('the camera from the entry room passes through the dangling cell\'s geometry', () => {
    dc.setBodyCell(0xd2d40103);
    // A render mesh of the dangling cell right behind the camera's pivot: met before, now passed.
    const root = new THREE.Group();
    root.userData.envCellId = 0xd2d403b4;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial());
    wall.position.set(0xd2 * 192 + 132, -3, 0xd4 * 192 + 186.6);
    root.add(wall);
    dc.setMeshes([root]);
    // The pivot on the villa's stairs down (0x0103, z −5.6 to −0.6).
    const pivot = new THREE.Vector3(0xd2 * 192 + 132, -3, 0xd4 * 192 + 185.6);
    expect(dc.findCellContaining(pivot.x, pivot.z, pivot.y, 0xd2d40103)).toBe(0xd2d40103);
    expect(dc.getCameraDistance(pivot, 0, 1, 3)).toBe(3);
    root.userData.envCellId = 0xd2d40103; // the same mesh in the body's own cell blocks the boom
    dc.setMeshes([root]);
    expect(dc.getCameraDistance(pivot, 0, 1, 3)).toBeLessThan(1);
  });
});

for (const era of [
  { name: 'end of retail', have: haveEol, dats: undefined },
  { name: 'Dark Majesty', have: haveClassic, dats: CLASSIC },
]) {
  describe.skipIf(!era.have)(`Eastham's two portal bunkers (0xCE94, ${era.name}): their rooms under the town overlap`, () => {
    // Bunker A: room 0x0102, stairs 0x0104 (Env 0x0D0003F4, at y 160.9); bunker B: room 0x0107, stairs 0x0109 (y 174.3).
    let dc: DungeonCollision;
    beforeAll(async () => {
      const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
      dc = (await buildLandblockWorld(0xce, 0x94, { interiors: true, dats: era.dats }))({ slidingNormal: null }).outdoorCollision as DungeonCollision;
    }, 180_000);

    it('a body in bunker A\'s room walks north where bunker B\'s room wall stands', () => {
      expect(pointInBoth(dc, 0xce, 0x94, 0xce940102, 0xce940107, [29.6, 34, 166, 169.5, 14, 15.5])).not.toBeNull();
      dc.setBodyCell(0xce940102);
      const [dx, dy] = step(dc, 0xce, 0x94, 30.1, 169.0, 13.66, 0, 0.5);
      expect(dx).toBeCloseTo(0, 2);
      expect(dy).toBeCloseTo(0.5, 2);
    });

    it('coming down bunker B\'s stairs into the overlap, the body is in B\'s room, not A\'s', () => {
      const p = pointInBoth(dc, 0xce, 0x94, 0xce940107, 0xce940102, [29.6, 34, 166, 169.5, 14, 15.5])!;
      // By id order the scan named 0x0102, bunker A's room.
      expect(dc.findCellContaining(p.gx, p.gy, p.z, 0xce940109)).toBe(0xce940107);
      expect(dc.findCellContaining(p.gx, p.gy, p.z, 0xce940104)).toBe(0xce940102);
    });
  });
}

describe.skipIf(!haveClassic)('trees and landblock statics in the classic Holtburg bunker room (A9B4 0x0185)', () => {
  let dc: DungeonCollision;
  const OX = 0xa9 * 192, OY = 0xb4 * 192;
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    dc = (await buildLandblockWorld(0xa9, 0xb4, { interiors: true, dats: CLASSIC }))({ slidingNormal: null }).outdoorCollision as DungeonCollision;
  }, 180_000);

  it('a tree\'s CylSphere over the room does not block a body in it; the room\'s own static does', () => {
    dc.setBodyCell(0xa9b40185);
    const at = (): [number, number] => dc.getAdjustedMovement(new THREE.Vector3(OX + 108, 73.7, OY + 68), 0, 0.5);
    const free = at();
    expect(free[1]).toBeCloseTo(0.5, 3);
    dc.addCylinderObstacle(collisionKey.scenery(0xa9b4ffff, 9999, 'c', 0), OX + 108, OY + 68.9, 0.4, 72, 78);
    expect(at()[1]).toBeCloseTo(0.5, 3);
    dc.addSphereObstacle(collisionKey.landblockStatic(0xa9b4, 9999, 's', 0), OX + 108, 74.5, OY + 68.9, 0.5);
    expect(at()[1]).toBeCloseTo(0.5, 3);
    dc.addCylinderObstacle(collisionKey.cellStatic(0xa9b40185, 9999, 'c', 0), OX + 108, OY + 68.9, 0.4, 72, 78);
    expect(at()[1]).toBeLessThan(0.3);
    dc.removeKey(collisionKey.scenery(0xa9b4ffff, 9999, 'c', 0));
    dc.removeKey(collisionKey.landblockStatic(0xa9b4, 9999, 's', 0));
    dc.removeKey(collisionKey.cellStatic(0xa9b40185, 9999, 'c', 0));
  });

  it('a missile\'s sphere meets the land deep in the room no, at the hut\'s doorway yes (main.ts terrain sweep)', () => {
    expect(dc.viewerReachesLand(OX + 108, OY + 70, 75, 0.5)).toBe(false);
    expect(dc.viewerReachesLand(OX + 108, OY + 87.8, 80.6, 0.5)).toBe(true);
  });
});

describe('a remote body\'s cell follows the interpolation, not the newest position', () => {
  const ROOM_CELL = 0xa9b40177;
  const BASE_X = 0xa9 * 192, BASE_Y = 0xb4 * 192;
  /** North of y 10 is the ramp cell (the landscape's own env cell). */
  const env: RemotePhysicsEnv = {
    terrainHeight: () => 70,
    surfaceCellAt: (_x, y) => (y - BASE_Y > 10 ? ROOM_CELL : 0),
    holdsSurfaceCell: (cell) => cell === ROOM_CELL,
    surfaceFloorZ: () => 70,
  };

  it('interpolating out of the ramp, the body keeps the ramp\'s cell until it crosses the doorway', () => {
    const b = new RemotePhysicsObject({ position: { cell: ROOM_CELL, pos: { x: BASE_X + 50, y: BASE_Y + 14, z: 70 }, orient: IDQ }, state: 0 });
    const out = { x: BASE_X + 50, y: BASE_Y + 6, z: 70 };
    expect(b.receivePosition({ cell: landCellAt(out.x, out.y), pos: out, orient: IDQ, contact: true }, 10)).toBe('interpolate');
    b.update(1 / 30, null, env, 0);
    expect(b.pos.y - BASE_Y).toBeGreaterThan(10);
    expect(b.position().cell).toBe(ROOM_CELL);
    for (let i = 1; i < 120 && b.pos.y - BASE_Y > 6.01; i++) b.update(1 / 30, null, env, i / 30);
    expect(b.pos.y - BASE_Y).toBeLessThan(10);
    expect(b.position().cell).toBe(landCellAt(b.pos.x, b.pos.y));
  });

  it('interpolating into the ramp, the cell turns the ramp\'s only past the doorway; the server\'s height stays', () => {
    const b = new RemotePhysicsObject({ position: { cell: landCellAt(BASE_X + 50, BASE_Y + 6), pos: { x: BASE_X + 50, y: BASE_Y + 6, z: 71 }, orient: IDQ }, state: 0 });
    b.receivePosition({ cell: ROOM_CELL, pos: { x: BASE_X + 50, y: BASE_Y + 14, z: 71 }, orient: IDQ, contact: true }, 10);
    b.update(1 / 30, null, env, 0);
    expect((b.position().cell & 0xffff) < 0x100).toBe(true);
    for (let i = 1; i < 120 && b.pos.y - BASE_Y < 11; i++) b.update(1 / 30, null, env, i / 30);
    expect(b.pos.y - BASE_Y).toBeLessThan(13);
    expect(b.position().cell).toBe(ROOM_CELL);
    expect(b.pos.z).toBeCloseTo(71, 6); // still interpolating: the height is the server's, not the room's floor
  });

  it('the indoor view sorts the object by that cell (ServerObjectManager.updateInteriorVisibility)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const physics = new RemotePhysicsObject({ position: { cell: ROOM_CELL, pos: { x: BASE_X + 50, y: BASE_Y + 14, z: 70 }, orient: IDQ }, state: 0 });
    const outCell = landCellAt(BASE_X + 50, BASE_Y + 6);
    physics.receivePosition({ cell: outCell, pos: { x: BASE_X + 50, y: BASE_Y + 6, z: 70 }, orient: IDQ, contact: true }, 10);
    physics.update(1 / 30, null, env, 0);
    const o = { guid: 7, objCellId: outCell, cellId: outCell & 0xffff, physicsState: 0, mesh: { visible: true, userData: {} }, physics } as unknown as ServerObject;
    som.getAllObjects().set(7, o);
    som.updateInteriorVisibility(() => true);
    expect(o.mesh!.userData.objCellId).toBe(ROOM_CELL);
  });
});
