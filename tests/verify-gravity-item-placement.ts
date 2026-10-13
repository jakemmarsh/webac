/**
 * BUG.gravity-item-placed-midair — a launch-day Seedsow (GDL-Classic 1.34,
 * Dark Majesty era) report: in the Training Academy's first room the
 * "Application Form" floats ~0.6 m over the desk instead of lying on it.
 *
 * The data: GDLE's own spawn table (Bin/Data/cache.bin entry 6, lbed.bin)
 * places 0x70363004 (wcid 13236 Application Form) in cell 0x0363012F at
 * (-2.261, -30.103, 1.5) — the same as ACE-World 0363.sql. Its weenie
 * (13236 Application Form.sql) has PhysicsState 0x414 = Ethereal |
 * IgnoreCollisions | Gravity and Setup 0x02000155 (one sphere, centre z
 * 0.021, radius 0.1). The cell's desk is static 0x02000272 at
 * (-2.4186, -29.9915, 0) whose physics top is z 0.92. The end-of-retail
 * Academy (cell 0x720201AD) has the same desk at x + 10 and ACE's Bruised
 * Apple (5090, Setup 0x020000EB, PhysicsState 0x414) at z 1.5; the retail
 * client draws that apple ON the desk (verification/retail-client/
 * academy-welcome-1600x900.png), and the 2026-10-10 local-ACE probe
 * measured it resting at 0.944 = 0.92 + its sphere's 0.024 under the
 * origin.
 *
 * Retail: SmartBox::HandleCreateObject → CPhysicsObj::enter_world
 * @ 00516170 (SetPosition Placement | Slide) → CTransition::
 * find_placement_position @ 0050c170 steps the spheres down by at most the
 * placement reach; no contact → calc_acceleration gives Gravity −9.8 and
 * the non-Static object goes Active, so UpdateObjectInternal @ 005156b0
 * drops it until its transition lands its lowest sphere on the desk (a
 * static desk is collided with even by an ethereal mover — ACE
 * PhysicsObj.FindObjCollisions). Ours drew the server's z forever.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { parseCreateObject } from '@ac/network';
import { PhysicsState } from '@ac/shared';
import {
  RemotePhysicsObject, placementStepDownReach,
  type PlacementShape, type RemotePhysicsEnv,
} from '../packages/renderer/src/world/RemotePhysics.js';
import { objectLandingZ, type SurfaceCollision } from '../packages/renderer/src/world/outdoorGround.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { openDat } from './_harness/dat.js';

const GRAVITY_ITEM = PhysicsState.Ethereal | PhysicsState.IgnoreCollisions | PhysicsState.Gravity; // 0x414
/** Setup 0x02000155 (the Application Form): one sphere. */
const FORM_SHAPE: PlacementShape = {
  spheres: [{ origin: { x: 0.005, y: 0, z: 0.021 }, radius: 0.1 }],
  stepDownHeight: 0.04,
};
const DESK_TOP = 0.92;
const FORM_REST = DESK_TOP + (0.1 - 0.021); // lowest sphere point on the desk

const ACADEMY_CELL = 0x0363012f;

/**
 * A collision world holding `cells` with one walkable surface at `top`
 * (a desk) and solid geometry at and under it; `obstruction` adds a solid
 * slab [lo, hi] (a branch, a shelf edge) the spheres can meet on the way.
 */
function flatWorld(cells: number[], top: number | null, obstruction: [number, number] | null = null): SurfaceCollision {
  return {
    hasCell: (id) => cells.includes(id >>> 0),
    hasCells: cells.length > 0,
    floorBelow: (_x, _z, fromY) => (top !== null && top <= fromY ? top : null),
    spheresOverlap: (spheres) => spheres.some((s) =>
      (top !== null && s.z - s.radius < top - 1e-9)
      || (obstruction !== null && s.z - s.radius < obstruction[1] && s.z + s.radius > obstruction[0])),
    findCellContaining: (_x, _y, _z, preferred = 0) => (cells.includes(preferred >>> 0) ? preferred : 0),
  };
}

function deskEnv(top: number | null = DESK_TOP, obstruction: [number, number] | null = null): RemotePhysicsEnv {
  const world = flatWorld([ACADEMY_CELL], top, obstruction);
  return {
    terrainHeight: () => null,
    landingZ: (cell, x, y, z, spheres) => objectLandingZ({ dungeon: world, outdoor: flatWorld([], null), terrainHeight: () => null }, cell, x, y, z, spheres),
  };
}

function body(z: number, state = GRAVITY_ITEM): RemotePhysicsObject {
  return new RemotePhysicsObject({
    position: { cell: 0x0363012f, pos: { x: -2.261, y: -30.103, z }, orient: { w: 0.702712, x: 0, y: 0, z: -0.711474 } },
    state,
  });
}

function run(b: RemotePhysicsObject, env: RemotePhysicsEnv, seconds: number): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) b.update(dt, null, env, t);
}

describe('placement step-down reach (CTransition::find_placement_position @ 0050c170)', () => {
  it('a one-sphere object whose diameter is under its step-down height reaches half its radius', () => {
    expect(placementStepDownReach(1, 0.1, 0.5)).toBeCloseTo(0.05);
  });
  it('a step-down height within the diameter is one step of that height', () => {
    expect(placementStepDownReach(1, 0.1, 0.15)).toBeCloseTo(0.15);
  });
  it('two spheres keep their height; one over the diameter is tried as halves', () => {
    expect(placementStepDownReach(2, 0.2, 1.0)).toBeCloseTo(0.5);
    expect(placementStepDownReach(2, 0.48, 0.6)).toBeCloseTo(0.6);
  });
});

describe('RemotePhysicsObject.enterWorld — a Gravity item placed over a surface', () => {
  it('falls from the server z 1.5 and rests its sphere on the 0.92 desk top', () => {
    const b = body(1.5);
    b.enterWorld(() => FORM_SHAPE);
    run(b, deskEnv(), 0.1);
    expect(b.settling).toBe(true);
    expect(b.pos.z).toBeLessThan(1.5);
    run(b, deskEnv(), 1.5);
    expect(b.settling).toBe(false);
    expect(b.contact).toBe(true);
    expect(b.pos.z).toBeCloseTo(FORM_REST, 4);
    expect(b.pos.x).toBeCloseTo(-2.261, 5);
    expect(b.pos.y).toBeCloseTo(-30.103, 5);
  });

  it('takes the time a fall from 0.58 m takes (gravity, not a snap)', () => {
    const b = body(1.5);
    b.enterWorld(() => FORM_SHAPE);
    run(b, deskEnv(), 0.2);
    // ½·9.8·0.2² ≈ 0.2 m after 0.2 s (one 1/30 s quantum of zero velocity first).
    expect(b.pos.z).toBeGreaterThan(1.2);
    expect(b.pos.z).toBeLessThan(1.4);
  });

  it('an item already resting (or sunk into the surface) keeps the server frame', () => {
    for (const z of [FORM_REST, DESK_TOP, DESK_TOP + 0.03]) {
      const b = body(z);
      b.enterWorld(() => FORM_SHAPE);
      run(b, deskEnv(), 1);
      expect(b.pos.z).toBeCloseTo(z, 6);
      expect(b.contact).toBe(true);
    }
  });

  it('a gap within the placement reach is closed by the step-down at once', () => {
    const b = body(FORM_REST + 0.03); // reach = min(0.04 … 2r) = 0.04
    b.enterWorld(() => FORM_SHAPE);
    run(b, deskEnv(), 1 / 60);
    expect(b.pos.z).toBeCloseTo(FORM_REST, 6);
    expect(b.settling).toBe(false);
  });

  it('a Static object, or one without Gravity, stays where the server put it', () => {
    for (const state of [GRAVITY_ITEM | PhysicsState.Static, PhysicsState.Ethereal | PhysicsState.IgnoreCollisions]) {
      const b = body(1.5, state);
      b.enterWorld(() => FORM_SHAPE);
      run(b, deskEnv(), 1);
      expect(b.pos.z).toBeCloseTo(1.5, 6);
    }
  });

  it('waits (does not move) until the cell collision answers, then falls', () => {
    // The Academy's cell is not in the dungeon world yet (streaming), then is.
    const cells: number[] = [];
    const world = flatWorld(cells, DESK_TOP);
    const env: RemotePhysicsEnv = {
      terrainHeight: () => null,
      landingZ: (cell, x, y, z, spheres) => objectLandingZ({ dungeon: world, outdoor: flatWorld([], null), terrainHeight: () => null }, cell, x, y, z, spheres),
    };
    const b = body(1.5);
    b.enterWorld(() => FORM_SHAPE);
    run(b, env, 0.5);
    expect(b.placementPending).toBe(true);
    expect(b.pos.z).toBeCloseTo(1.5, 6);
    cells.push(ACADEMY_CELL);
    run(b, env, 1.5);
    expect(b.placementPending).toBe(false);
    expect(b.pos.z).toBeCloseTo(FORM_REST, 4);
  });

  it('waits for a streamed Setup too, and an object without spheres stays put', () => {
    let shape: PlacementShape | null = null;
    const b = body(1.5);
    b.enterWorld(() => shape);
    run(b, deskEnv(), 0.5);
    expect(b.placementPending).toBe(true);
    shape = { spheres: [], stepDownHeight: 0.04 };
    run(b, deskEnv(), 1);
    expect(b.placementPending).toBe(false);
    expect(b.pos.z).toBeCloseTo(1.5, 6);
  });

  it('the object scale scales the spheres it rests on', () => {
    const b = new RemotePhysicsObject({
      position: { cell: 0x0363012f, pos: { x: 0, y: 0, z: 2 }, orient: { w: 1, x: 0, y: 0, z: 0 } },
      state: GRAVITY_ITEM, scale: 2,
    });
    b.enterWorld(() => FORM_SHAPE);
    run(b, deskEnv(), 2);
    expect(b.pos.z).toBeCloseTo(DESK_TOP + 2 * (0.1 - 0.021), 4);
  });

  it('a fall meets geometry on the way (a branch, a shelf edge) and stops there, as its transition would', () => {
    const b = body(1.5);
    b.enterWorld(() => FORM_SHAPE);
    run(b, deskEnv(DESK_TOP, [1.2, 1.25]), 2);
    // The sphere (bottom 0.079 under the origin) rests on the slab's top at 1.25.
    expect(b.pos.z).toBeGreaterThan(1.25 + 0.079 - 0.001);
    expect(b.pos.z).toBeLessThan(1.25 + 0.079 + 0.021);
  });
});

describe('objectLandingZ — which collision world answers for a cell, and where the spheres stop', () => {
  const FORM = [{ x: 0.005, y: 0, z: 0.021, radius: 0.1 }];

  it('an interior cell asks the dungeon world once its BSP is registered, else the outdoor one, else unknown', () => {
    expect(objectLandingZ({ dungeon: flatWorld([ACADEMY_CELL], 0.92), outdoor: flatWorld([], null), terrainHeight: () => 0 }, ACADEMY_CELL, 0, 0, 1.5, FORM)).toBeCloseTo(FORM_REST, 6);
    expect(objectLandingZ({ dungeon: null, outdoor: flatWorld([0xa9b40170], 0.5), terrainHeight: () => 0 }, 0xa9b40170, 0, 0, 1.5, FORM)).toBeCloseTo(0.579, 6);
    expect(objectLandingZ({ dungeon: flatWorld([], 0.92), outdoor: flatWorld([], 0.92), terrainHeight: () => 0 }, ACADEMY_CELL, 0, 0, 1.5, FORM)).toBeNull();
  });

  it('a position outside its own cell\'s geometry, or with nothing walkable below, stays put', () => {
    const lost: SurfaceCollision = { ...flatWorld([ACADEMY_CELL], 0.92), findCellContaining: () => 0 };
    expect(objectLandingZ({ dungeon: lost, outdoor: flatWorld([], null), terrainHeight: () => 0 }, ACADEMY_CELL, 0, 0, 1.5, FORM)).toBe(1.5);
    expect(objectLandingZ({ dungeon: flatWorld([ACADEMY_CELL], null), outdoor: flatWorld([], null), terrainHeight: () => 0 }, ACADEMY_CELL, 0, 0, 1.5, FORM)).toBe(1.5);
  });

  it('an outdoor cell lands on a static / building floor over the terrain, else on the terrain', () => {
    expect(objectLandingZ({ dungeon: null, outdoor: flatWorld([1], 12.8), terrainHeight: () => 12 }, 0xa9b40031, 0, 0, 14, FORM)).toBeCloseTo(12.879, 6);
    expect(objectLandingZ({ dungeon: null, outdoor: flatWorld([1], null), terrainHeight: () => 12 }, 0xa9b40031, 0, 0, 14, FORM)).toBeCloseTo(12.079, 6);
    expect(objectLandingZ({ dungeon: null, outdoor: flatWorld([], null), terrainHeight: () => null }, 0xa9b40031, 0, 0, 14, FORM)).toBeNull();
  });
});

// ── The real thing: CreateObject bytes → ServerObjectManager → the real
//    Academy cell's collision (desk included) → the drawn mesh. ──

function u32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return Array.from(b); }
function u16(n: number): number[] { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); return Array.from(b); }
function f32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return Array.from(b); }

/** A CreateObject the way GDLE / ACE send a landblock item: Position + CSetup, its PhysicsState, a Writable weenie. */
function createObjectBytes(o: { guid: number; cell: number; x: number; y: number; z: number; setupId: number; state: number; wcid: number; name: string; itemType: number; descFlags?: number }): Uint8Array {
  const name = Array.from(new TextEncoder().encode(o.name));
  const nameBytes = [...u16(name.length), ...name];
  while (nameBytes.length % 4 !== 0) nameBytes.push(0); // string16L align
  return new Uint8Array([
    ...u32(o.guid),
    0x11, 0, 0, 0,                          // model header, no sub-blocks
    ...u32(0x008000 | 0x000001),            // PhysicsDescFlag Position | CSetup
    ...u32(o.state),
    ...u32(o.cell), ...f32(o.x), ...f32(o.y), ...f32(o.z),
    ...f32(0.702712), ...f32(0), ...f32(0), ...f32(-0.711474),
    ...u32(o.setupId),
    ...Array(18).fill(0),                   // 9 sequence timestamps
    0, 0,                                   // align(4)
    ...u32(0),                              // weenie flags
    ...nameBytes,
    ...u16(o.wcid),
    ...u16(0x23c3),                         // icon 0x060023C3
    ...u32(o.itemType),
    ...u32(o.descFlags ?? 0),
  ]);
}

interface AcademyWorld {
  collision: DungeonCollision;
  loadSetup: (id: number) => unknown;
  portalDb: import('../packages/dat-parser/src/DatDatabase.js').DatDatabase;
}

async function buildAcademyWorld(portalPath: string, cellPath: string, landblock: number): Promise<AcademyWorld> {
  const portalDb = openDat(portalPath);
  const cellDb = openDat(cellPath);
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
  const collision = new DungeonCollision();
  populateDungeonCollision(collision, landblock, {
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
  return { collision, loadSetup: (id) => sr.loadSetupModel(id), portalDb };
}

async function placeAndSettle(world: AcademyWorld, bytes: Uint8Array) {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: world.loadSetup };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, { add: () => {}, remove: () => {} } as any);
  // main.ts's wiring: the dungeon world answers for the Academy's interior cells.
  som.setPortalDb(world.portalDb);
  som.setObjectLandingQuery((cell, x, y, z, spheres) => objectLandingZ(
    { dungeon: world.collision, outdoor: new DungeonCollision(), terrainHeight: () => null }, cell, x, y, z, spheres));
  const data = parseCreateObject(bytes);
  expect(data).not.toBeNull();
  const obj = som.createObject(data!)!;
  expect(obj.mesh).not.toBeNull();
  const created = obj.mesh!.position.y;
  for (let i = 0; i < 90; i++) som.updateAnimations(1 / 60);
  return { obj, created };
}

const CLASSIC_PORTAL = resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat');
const CLASSIC_CELL = resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat');

describe.skipIf(!existsSync(CLASSIC_CELL))('Dark Majesty (Seedsow / GDLE): the Academy Application Form lies on the desk', () => {
  let world: AcademyWorld;
  beforeAll(async () => { world = await buildAcademyWorld(CLASSIC_PORTAL, CLASSIC_CELL, 0x0363ffff); });

  it('the desk under the form is in the cell collision at its 0.92 m physics top', () => {
    // AC landblock-global: landblock 0x03,0x63 → x + 3·192, y + 0x63·192.
    expect(world.collision.floorBelow(3 * 192 - 2.261, 0x63 * 192 - 30.103, 1.5)).toBeCloseTo(DESK_TOP, 3);
  });

  it('CreateObject at z 1.5 with Gravity → drawn resting on the desk (sphere on the top), x / y unchanged', async () => {
    const { obj, created } = await placeAndSettle(world, createObjectBytes({
      guid: 0x70363004, cell: 0x0363012f, x: -2.261, y: -30.103, z: 1.5,
      setupId: 0x02000155, state: 0x414, wcid: 13236, name: 'Application Form', itemType: 0x2000,
    }));
    expect(created).toBeCloseTo(1.5, 5);
    expect(obj.mesh!.position.y).toBeCloseTo(FORM_REST, 3);
    expect(obj.worldY).toBeCloseTo(FORM_REST, 3);
    expect(obj.mesh!.position.x).toBeCloseTo(3 * 192 - 2.261, 3);
    expect(obj.mesh!.position.z).toBeCloseTo(0x63 * 192 - 30.103, 3);
  });

  it('the house storage chest (IsStorage: master map → 9687) and a corpse are forced into the cell and never fall', async () => {
    const { storageWcidOf } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    expect(storageWcidOf(world.portalDb)).toBe(9687);
    const storage = await placeAndSettle(world, createObjectBytes({
      guid: 0x70363098, cell: 0x0363012f, x: -2.261, y: -30.103, z: 1.5,
      setupId: 0x02000a97, state: 0x418, wcid: 9687, name: 'Storage', itemType: 0x200,
    }));
    expect(storage.obj.mesh!.position.y).toBeCloseTo(1.5, 5);
    const corpse = await placeAndSettle(world, createObjectBytes({
      guid: 0x70363097, cell: 0x0363012f, x: -2.261, y: -30.103, z: 1.5,
      setupId: 0x02000155, state: 0x414, wcid: 13236, name: 'Corpse', itemType: 0x200, descFlags: 0x2000,
    }));
    expect(corpse.obj.mesh!.position.y).toBeCloseTo(1.5, 5);
  });

  it('the Greeter-room floor items GDLE places at z 0.005 stay at the server frame', async () => {
    const { obj } = await placeAndSettle(world, createObjectBytes({
      guid: 0x70363099, cell: 0x0363012f, x: 0, y: -32, z: 0.005,
      setupId: 0x02000155, state: 0x414, wcid: 13236, name: 'Application Form', itemType: 0x2000,
    }));
    expect(obj.mesh!.position.y).toBeCloseTo(0.005, 5);
  });
});

describe.skipIf(!existsSync(resolve(__dirname, '..', 'dat/client_cell_1.dat')))('end of retail (ACE): the Academy Bruised Apple rests where ACE\'s retail-port physics put it', () => {
  let world: AcademyWorld;
  beforeAll(async () => { world = await buildAcademyWorld('dat/client_portal.dat', 'dat/client_cell_1.dat', 0x7202ffff); });

  it('landblock_instance 0x772020A9 (z 1.5, Gravity) → 0.944, the 2026-10-10 live ACE measurement', async () => {
    const { obj } = await placeAndSettle(world, createObjectBytes({
      guid: 0x772020a9, cell: 0x720201ad, x: 7.739, y: -30.103, z: 1.5,
      setupId: 0x020000eb, state: 0x414, wcid: 5090, name: 'Bruised Apple', itemType: 0x20,
    }));
    expect(obj.mesh!.position.y).toBeCloseTo(0.944, 3);
  });
});
