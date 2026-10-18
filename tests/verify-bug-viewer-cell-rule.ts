/**
 * BUG.bunker-camera-in-head — the camera boom meets the land cells (the
 * terrain, building shells, scenery and land objects) from an env cell only
 * out through that cell's outside portals.
 *
 * Retail: SmartBox::update_viewer @ 00453ce0 sweeps the 0.3 m viewer sphere
 * (CTransition::init_object(player, 0x5c): IsViewer | PathClipped |
 * FreeRotate | PerfectClip) from the player's cell; from an env cell the pivot
 * is placed by CPhysicsObj::AdjustPosition (ACE PhysicsObj.cs:232-262). At
 * each radius step CEnvCell::find_transit_cells @ 0052c820 adds the land cells
 * (CLandCell::add_all_outside_cells) only while the sphere is within its
 * radius of an outside portal's plane (ACE EnvCell.cs:311-371), and
 * OBJECTINFO::validate_walkable @ 0050d010's IsViewer branch (ACE
 * ObjectInfo.ValidateWalkable) lets a path that began in an env cell meet the
 * terrain only on the step that crosses the terrain plane.
 *
 * Ours before: from an env cell with the pivot at or above the terrain under
 * it the whole boom swept the heightfield, and the building-shell meshes and
 * scenery cylinders always counted: at the top of the classic town bunker's
 * stairs (A9B4 0x187) and halfway up the end-of-retail drudge statue ramp
 * (A9B4 0x177) the camera sat in the player's head.
 *
 * The shipped helpers (RetailCamera viewerLandFrom / viewerBeginsIndoors,
 * TerrainCollision viewerTerrainStepCollides + its viewer sweep,
 * DungeonCollision getCameraDistance's landFrom / viewerReachesLand, and the
 * composition main.ts runs, ViewerBoom surfaceViewerDistance /
 * surfaceViewerCell) on synthetic worlds, then on the real DATs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { TerrainCollision, viewerTerrainStepCollides } from '../packages/shared/src/physics/TerrainCollision.js';
import { DungeonCollision, collisionKey } from '../packages/renderer/src/world/DungeonCollision.js';
import { viewerBeginsIndoors, viewerLandFrom } from '../packages/renderer/src/scene/RetailCamera.js';
import { surfaceViewerCell, surfaceViewerDistance, type SurfaceViewerWorld } from '../packages/renderer/src/scene/ViewerBoom.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const R = DungeonCollision.VIEWER_SPHERE_RADIUS;

describe('viewerTerrainStepCollides (validate_walkable, IsViewer)', () => {
  it('a sphere clear of the plane never collides', () => {
    expect(viewerTerrainStepCollides(0.1, 0.4, false)).toBe(false);
    expect(viewerTerrainStepCollides(-0.0001, 0.4, false)).toBe(false); // above −F_EPSILON
  });
  it('a path that began outdoors collides whenever the sphere dips in', () => {
    expect(viewerTerrainStepCollides(-0.1, 0.2, false)).toBe(true);
    expect(viewerTerrainStepCollides(-2, -1.9, false)).toBe(true);
  });
  it('a path that began in an env cell collides only on the step that crosses the plane', () => {
    expect(viewerTerrainStepCollides(-0.1, 0.2, true)).toBe(true); // from above to under: angle 0.33
    expect(viewerTerrainStepCollides(-0.1, 0, true)).toBe(true); // angle exactly 1
    expect(viewerTerrainStepCollides(-2, -1.9, true)).toBe(false); // already under the ground
    expect(viewerTerrainStepCollides(-0.1, -0.1, true)).toBe(false); // parallel: no crossing
  });
});

describe('viewerBeginsIndoors (update_viewer + AdjustPosition)', () => {
  it('an outdoor player\'s viewer begins outdoors', () => {
    expect(viewerBeginsIndoors(0xa9b40031, 0, true)).toBe(false);
    expect(viewerBeginsIndoors(0xa9b40031, 0xa9b40185, true)).toBe(false);
  });
  it('from an env cell: the pivot\'s cell; out of every cell, a SeenOutside cell lets it outside, a sealed one keeps it', () => {
    expect(viewerBeginsIndoors(0xa9b40187, 0xa9b40188, true)).toBe(true);
    expect(viewerBeginsIndoors(0xa9b40187, 0, true)).toBe(false);
    expect(viewerBeginsIndoors(0xa9b40187, 0, false)).toBe(true);
  });
});

describe('viewerLandFrom (find_transit_cells per radius step)', () => {
  it('returns the first radius step that reaches the land cells', () => {
    const asked: number[] = [];
    expect(viewerLandFrom(2.87, R, (t) => { asked.push(t); return t > 1; })).toBeCloseTo(1.2, 9);
    expect(asked.map((t) => +t.toFixed(3))).toEqual([0, 0.3, 0.6, 0.9, 1.2]);
  });
  it('0 when the pivot already reaches them; Infinity when the boom never does; the last step is the remainder', () => {
    expect(viewerLandFrom(2.87, R, () => true)).toBe(0);
    const asked: number[] = [];
    expect(viewerLandFrom(1, R, (t) => { asked.push(t); return false; })).toBe(Infinity);
    expect(asked.map((t) => +t.toFixed(3))).toEqual([0, 0.3, 0.6, 0.9, 1]);
  });
});

// ── A synthetic surface cell under the ground (DAT-free) ─────────────────────

type V3 = [number, number, number];
const IDQ = { w: 1, x: 0, y: 0, z: 0 };
/** The room's frame: cell-local (0, 0, 0) at AC global (20, 20, 0), inside landblock (0, 0). */
const RX = 20, RY = 20;

function polyMesh(polys: V3[][]) {
  const vertices = new Map<number, unknown>();
  const polygons = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const idx: number[] = [];
    for (const [x, y, z] of p) { vertices.set(vi, { origin: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(vi++); }
    polygons.set(pi, { vertexIndices: idx, numPts: idx.length, stippling: 0, sidesType: 0, posSurface: 0, negSurface: 0, posUVIndices: [], negUVIndices: [] });
  });
  const pts = polys.flat();
  const c = pts.reduce((a, [x, y, z]) => [a[0] + x / pts.length, a[1] + y / pts.length, a[2] + z / pts.length], [0, 0, 0]);
  const r = Math.max(...pts.map(([x, y, z]) => Math.hypot(x - c[0], y - c[1], z - c[2])));
  const leaf = { type: 'LEAF', solid: 0, sphere: { origin: { x: c[0], y: c[1], z: c[2] }, radius: r }, inPolys: [...polygons.keys()] };
  return { vertexArray: { vertices }, polygons, leaf };
}

/** The CELL BSP of a box x −5..5, y −2..2, z −1..4 (cell-local). */
function boxCellBsp() {
  const planes: [V3, number][] = [[[1, 0, 0], 5], [[-1, 0, 0], 5], [[0, 1, 0], 2], [[0, -1, 0], 2], [[0, 0, 1], 1], [[0, 0, -1], 4]];
  let node: unknown;
  for (const [[x, y, z], distance] of planes.reverse()) node = { splittingPlane: { normal: { x, y, z }, distance }, posNode: node };
  return node;
}

/** The room: floor at z 0; polygon 1, across its west end (local x −5 = global x 15), its outside portal. */
function room() {
  const m = polyMesh([
    [[-5, -2, 0], [5, -2, 0], [5, 2, 0], [-5, 2, 0]],
    [[-5, 2, 3], [-5, -2, 3], [-5, -2, 0], [-5, 2, 0]],
  ]);
  const floorOnly = new Map([[0, m.polygons.get(0)]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { vertexArray: m.vertexArray, polygons: m.polygons, portals: [1], physicsPolygons: floorOnly, physicsBSP: { rootNode: { ...m.leaf, inPolys: [0] } }, cellBSP: { rootNode: boxCellBsp() }, drawingBSP: null } as any;
}

const CELL = 0x00000100;

/** A 10 × 10 m wall render mesh across global AC x = `x` (THREE x), as a building shell or (in a cell group) cell geometry. */
function wallMesh(x: number, envCellId?: number): THREE.Object3D {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  m.rotation.y = Math.PI / 2;
  m.position.set(x, 1.5, RY);
  if (envCellId === undefined) return m;
  const g = new THREE.Group();
  g.userData.envCellId = envCellId;
  g.add(m);
  return g;
}

function flatTerrain(z: number): TerrainCollision {
  const t = new TerrainCollision();
  t.setLandblock(0, 0, { heights: new Array(81).fill(z), blockX: 0, blockY: 0 });
  return t;
}

function surfaceWorld(terrainZ: number, opts: { meshes?: THREE.Object3D[]; sealed?: boolean } = {}): SurfaceViewerWorld & { dc: DungeonCollision } {
  const dc = new DungeonCollision();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.addCell(CELL, room(), { origin: { x: RX, y: RY, z: 0 }, orientation: IDQ } as any, [1]);
  dc.setMeshes(opts.meshes ?? []);
  return { dc, collision: dc, terrain: flatTerrain(terrainZ), seenOutside: () => !opts.sealed };
}

/** The pivot 1.5 m over feet on the room floor at global AC (x, RY), THREE axes. */
const pivotAt = (x: number) => new THREE.Vector3(x, 1.5, RY);
/** The default boom: 2.75 m back along AC ±x, 0.825 m up. */
const BACK = 2.75, UP = 0.825, LEN = Math.hypot(BACK, UP);

describe('the boom from a cell under the ground (surfaceViewerDistance)', () => {
  // Terrain at z 1.4: the pivot (z 1.5) is just over it, so the pre-fix rule swept the whole heightfield.
  it('deep in the cell the terrain overhead never clips the boom (pre-fix: the camera in the head)', () => {
    const w = surfaceWorld(1.4);
    // The outdoor sweep from the same pivot meets the ground at once.
    expect(w.terrain.getCameraDistance(22, 1.5, RY, BACK, 0, LEN, UP)).toBeLessThan(0.05);
    expect(surfaceViewerDistance(w, CELL, pivotAt(22), BACK, UP, 0, LEN)).toBeCloseTo(LEN, 6);
  });

  it('out through the outside portal, the step that crosses the terrain plane meets it', () => {
    // Terrain at z 1.0, the pivot clear of it; a boom west and down leaves by the portal (x 15) and crosses the
    // ground past it: from x 16 the sphere is within its radius of the portal plane at t ≈ 0.7.
    const w = surfaceWorld(1.0);
    const d = surfaceViewerDistance(w, CELL, pivotAt(16), -BACK, -0.6, 0, Math.hypot(BACK, 0.6));
    expect(d).toBeLessThan(Math.hypot(BACK, 0.6) - 0.5);
    expect(d).toBeGreaterThan(0.7);
    // The same downward boom deeper in, east, crosses the terrain plane inside the cell: no contact.
    expect(surfaceViewerDistance(w, CELL, pivotAt(20), BACK, -0.6, 0, Math.hypot(BACK, 0.6))).toBeCloseTo(Math.hypot(BACK, 0.6), 6);
  });

  it('a building shell inside the cell is no wall to the boom; the cell\'s own geometry is', () => {
    // A shell wall 2 m west of the pivot, 3 m short of the portal.
    const shell = surfaceWorld(-10, { meshes: [wallMesh(18)] });
    expect(shell.dc.getCameraDistance(pivotAt(20), -BACK, 0, LEN, UP)).toBeLessThan(2); // the pre-fix answer
    expect(surfaceViewerDistance(shell, CELL, pivotAt(20), -BACK, UP, 0, LEN)).toBeCloseTo(LEN, 6);
    const cellWall = surfaceWorld(-10, { meshes: [wallMesh(18, CELL)] });
    const d = surfaceViewerDistance(cellWall, CELL, pivotAt(20), -BACK, UP, 0, LEN);
    expect(d).toBeGreaterThan(1.7);
    expect(d).toBeLessThan(1.8);
  });

  it('past the outside portal the shells count again', () => {
    // From x 16 the boom west leaves by the portal at x 15; a shell wall at x 14.
    const w = surfaceWorld(-10, { meshes: [wallMesh(14)] });
    const d = surfaceViewerDistance(w, CELL, pivotAt(16), -BACK, UP, 0, LEN);
    expect(d).toBeLessThan(2);
    expect(d).toBeGreaterThan(1.6);
  });

  it('a scenery cylinder inside the cell is skipped; a cell static\'s cylinder is not', () => {
    const scen = surfaceWorld(-10);
    scen.dc.addCylinderObstacle(collisionKey.scenery(0, 0, 'c', 0), 18, RY, 0.4, 0, 3);
    expect(scen.dc.getCameraDistance(pivotAt(20), -BACK, 0, LEN, UP)).toBeLessThan(1.5); // the pre-fix answer
    expect(surfaceViewerDistance(scen, CELL, pivotAt(20), -BACK, UP, 0, LEN)).toBeCloseTo(LEN, 6);
    const stat = surfaceWorld(-10);
    stat.dc.addCylinderObstacle(collisionKey.cellStatic(CELL, 0, 'c', 0), 18, RY, 0.4, 0, 3);
    expect(surfaceViewerDistance(stat, CELL, pivotAt(20), -BACK, UP, 0, LEN)).toBeLessThan(1.5);
  });

  it('outdoors nothing changes: shells, cylinders and terrain all clip', () => {
    const w = surfaceWorld(1.4, { meshes: [wallMesh(18)] });
    const outdoor = 0x00000001;
    const d = surfaceViewerDistance(w, outdoor, new THREE.Vector3(30, 1.5, RY), BACK, UP, 0, LEN);
    expect(d).toBeCloseTo(Math.min(
      w.dc.getCameraDistance(new THREE.Vector3(30, 1.5, RY), BACK, 0, LEN, UP),
      w.terrain.getCameraDistance(30, 1.5, RY, BACK, 0, LEN, UP)), 9);
    expect(d).toBeLessThan(0.05);
  });

  it('the viewer\'s cell is the camera\'s: in the cell, outdoors once out by the doorway (a sealed cell holds it)', () => {
    const w = surfaceWorld(-10);
    expect(surfaceViewerCell(w, CELL, new THREE.Vector3(18, 2, RY))).toBe(CELL);
    expect(surfaceViewerCell(w, CELL, new THREE.Vector3(13, 2, RY))).toBe(0);
    expect(surfaceViewerCell(surfaceWorld(-10, { sealed: true }), CELL, new THREE.Vector3(13, 2, RY))).toBe(CELL);
    expect(surfaceViewerCell(w, 0x00000001, new THREE.Vector3(18, 2, RY))).toBe(0x00000001);
  });
});

// ── The real cells (DAT) ─────────────────────────────────────────────────────

/** The block's collision world with its interiors, plus the render meshes main.ts raycasts (shells + cell meshes). */
async function cameraWorld(BX: number, BY: number, dats: { portal: string; cell: string }) {
  const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
  const base = (await buildLandblockWorld(BX, BY, { interiors: true, dats }))({ slidingNormal: null });
  const dc = base.outdoorCollision as DungeonCollision;
  const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
  const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
  const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
  const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
  const { LandblockInfo, DatReader } = await import('@ac/dat-parser');
  const portal = openDat(dats.portal);
  const cell = openDat(dats.cell);
  const mf = new MaterialFactory(portal, new TextureManager(portal));
  const mr = new ModelRenderer(portal, mf);
  const sr = new SetupModelRenderer(portal, mr);
  const env = new EnvCellRenderer(portal, cell, mf, sr, mr);
  const prefix = ((BX << 24) | (BY << 16)) >>> 0;
  const info = new LandblockInfo(new DatReader(cell.getFileData((prefix | 0xfffe) >>> 0)!));
  const objs: THREE.Object3D[] = [];
  // As LandblockObjectStreamer places them (building pass meshes at the DAT frame; cells by createCellMesh).
  for (const b of info.buildings) {
    const g = (b.modelId >>> 24) === 2 ? sr.createSetupMesh(b.modelId, undefined, true) : mr.createMesh(b.modelId, undefined, undefined, true);
    if (!g) continue;
    const p = b.frame.origin, q = b.frame.orientation;
    g.position.set(BX * 192 + p.x, p.z, BY * 192 + p.y);
    g.quaternion.set(-q.x, -q.z, -q.y, q.w);
    objs.push(g);
  }
  for (let i = 0x100; i < 0x100 + info.numCells; i++) {
    const m = env.createCellMesh((prefix | i) >>> 0);
    if (m) objs.push(m);
  }
  dc.setMeshes(objs);
  const world: SurfaceViewerWorld = {
    collision: dc, terrain: base.terrain as TerrainCollision,
    seenOutside: (id) => ((env.loadEnvCell(id)?.flags ?? 0) & 1) !== 0,
  };
  return { dc, world, terrain: base.terrain as TerrainCollision };
}

const CLASSIC = {
  portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'),
  cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat'),
};

describe.skipIf(!existsSync(CLASSIC.portal) || !existsSync(CLASSIC.cell))('the classic Holtburg bunker\'s stairs (A9B4 0x187, Dark Majesty DATs)', () => {
  const OX = 0xa9 * 192, OY = 0xb4 * 192;
  let c: Awaited<ReturnType<typeof cameraWorld>>;
  beforeAll(async () => { c = await cameraWorld(0xa9, 0xb4, CLASSIC); }, 120_000);

  it('at the top of the stairs, the pivot just over the terrain, the camera stays behind the player both ways', () => {
    const feet = c.dc.getFloorHeight(OX + 108, OY + 83.5, 79)!;
    expect(feet).toBeGreaterThan(78.3);
    expect(feet).toBeLessThan(78.8);
    const cell = c.dc.findCellContaining(OX + 108, OY + 83.5, feet + 0.5);
    expect(cell).toBe(0xa9b40187);
    const pivot = new THREE.Vector3(OX + 108, feet + 1.5, OY + 83.5);
    // The pre-fix rule's preconditions: pivot at or over the terrain under it, whose sweep stops at once.
    expect(pivot.y).toBeGreaterThanOrEqual(c.terrain.getHeightAt(pivot.x, pivot.z)!);
    for (const bz of [BACK, -BACK]) {
      expect(c.terrain.getCameraDistance(pivot.x, pivot.y, pivot.z, 0, bz, LEN, UP)).toBeLessThan(0.05);
      expect(surfaceViewerDistance(c.world, cell, pivot, 0, UP, bz, LEN), `boom ${bz > 0 ? 'north' : 'south'}`).toBeGreaterThan(2.5);
    }
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('the end-of-retail Holtburg drudge statue ramp (A9B4 0x177)', () => {
  const OX = 0xa9 * 192, OY = 0xb4 * 192;
  let c: Awaited<ReturnType<typeof cameraWorld>>;
  beforeAll(async () => { c = await cameraWorld(0xa9, 0xb4, { portal: DAT_PATHS.portal, cell: DAT_PATHS.cell }); }, 120_000);

  function onRamp(x: number) {
    const feet = c.dc.getBodyFloorHeight(OX + x, OY + 156.7, 66.3, 0.6)!;
    const cell = c.dc.findCellContaining(OX + x, OY + 156.7, feet + 0.5);
    return { feet, cell, pivot: new THREE.Vector3(OX + x, feet + 1.5, OY + 156.7) };
  }

  it('2 m down the ramp (the pivot just over the town\'s ground) the camera stays behind the player up and down the ramp', () => {
    const { feet, cell, pivot } = onRamp(64.5);
    expect(cell).toBe(0xa9b40177);
    expect(feet).toBeCloseTo(64.6, 1);
    expect(pivot.y).toBeGreaterThanOrEqual(c.terrain.getHeightAt(pivot.x, pivot.z)!);
    for (const bx of [BACK, -BACK]) {
      expect(c.terrain.getCameraDistance(pivot.x, pivot.y, pivot.z, bx, 0, LEN, UP)).toBeLessThan(0.05);
      expect(surfaceViewerDistance(c.world, cell, pivot, bx, UP, 0, LEN), `boom ${bx > 0 ? 'east' : 'west'}`).toBeGreaterThan(2.5);
    }
  });

  it('near the doorway a boom out through it still meets the pedestal\'s shell (land cells reached)', () => {
    const { cell, pivot } = onRamp(63);
    const bx = -1.94, bz = 1.94, len = Math.hypot(bx, bz, UP);
    const shellAndCells = c.dc.getCameraDistance(pivot, bx, bz, len, UP);
    const cellsOnly = c.dc.getCameraDistance(pivot, bx, bz, len, UP, Infinity);
    expect(shellAndCells).toBeLessThan(cellsOnly - 1);
    expect(surfaceViewerDistance(c.world, cell, pivot, bx, UP, bz, len)).toBeCloseTo(shellAndCells, 6);
  });
});
