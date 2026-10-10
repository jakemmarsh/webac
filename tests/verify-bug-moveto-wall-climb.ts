/**
 * BUG.moveto-wall-climb-flying-target — Jake watched a character run up
 * inside a wall of the Holtburg academy while the server MoveTo approached a
 * Carpenter Wasp in the garden behind it. The Blacksmith's corridor
 * (0x860201F6) has an arched opening in its west wall into a shallow alcove
 * (0x860201E0) whose back is a 51° face (normal z 0.629). Player movement
 * tested BSP faces against LandingZ (0.087): the face was "floor", the
 * sphere sweep skipped it and the floor search climbed it until the body
 * left every cell and ran through the void into the garden. Keyed movement
 * did the same; MoveTo only made it easy to hit (a straight line at a
 * target behind the wall).
 *
 * Retail: a body on the ground has CPhysicsObj::get_walkable_z =
 * PhysicsGlobals.FloorZ (0.664), and a step up is a StepDown onto a contact
 * plane at least that flat (ACE Transition.StepUp). So the face is a wall,
 * and the body stops against it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  makePlane, posHitsSphere, collectWalkableFloorHeights, FLOOR_WALKABLE_Z,
  type CollisionBSPNode, type PhysicsPolygon,
} from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { stepMoveToMotion, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { openDat } from './_harness/dat.js';

type V = [number, number, number];
const poly = (...pts: V[]): PhysicsPolygon => {
  const vertices = pts.map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: vertices.length } as PhysicsPolygon;
};

/** The alcove's back face in its own frame: rising 2 m over 1.6 m of run toward -x (51°), facing +x. */
const SLOPE_51 = poly([0, -2.3, 0], [0, 2.3, 0], [-1.6, 0, 2]);

/** A GfxObj-shaped wrapper (DungeonCollision.addGfxObjCollision) around physics polygons. */
function gfxOf(polys: PhysicsPolygon[]) {
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const vertexIndices: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); vertexIndices.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices, numVertices: p.vertices.length, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsPolygons,
    vertexArray: { vertices },
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: polys.map((_, i) => i) } },
  } as never;
}

describe('BUG.moveto-wall-climb-flying-target — the walkable allowance of a body on the ground', () => {
  it('FloorZ is PhysicsGlobals.FloorZ (cos 48.4°)', () => {
    expect(FLOOR_WALKABLE_Z).toBeCloseTo(0.66417414618662751, 12);
  });

  it('a 51° face is a wall at FloorZ: a sphere moving into it hits; at LandingZ it was skipped', () => {
    expect(SLOPE_51.plane.normal.z).toBeGreaterThan(0.0871557);
    expect(SLOPE_51.plane.normal.z).toBeLessThan(FLOOR_WALKABLE_Z);
    // A feet sphere 0.2 m into the face's foot, moving toward -x.
    const sphere = { center: { x: -0.2, y: 0, z: 0.475 }, radius: 0.48 };
    const move = { x: -0.1, y: 0, z: 0 };
    expect(posHitsSphere(SLOPE_51, sphere, move, FLOOR_WALKABLE_Z)).not.toBeNull();
    expect(posHitsSphere(SLOPE_51, sphere, move)).toBeNull();
  });

  it('a walkable ramp (42°, the academy stairs) and ceilings are still skipped', () => {
    const ramp42 = poly([0, -1, 0], [0, 1, 0], [-1, 0, Math.tan((42 * Math.PI) / 180)]);
    expect(ramp42.plane.normal.z).toBeGreaterThan(FLOOR_WALKABLE_Z);
    const sphere = { center: { x: -0.2, y: 0, z: 0.475 }, radius: 0.48 };
    expect(posHitsSphere(ramp42, sphere, { x: -0.1, y: 0, z: 0 }, FLOOR_WALKABLE_Z)).toBeNull();
    const ceiling = poly([0, -1, 1], [-2, 0, 1], [0, 1, 1]);
    expect(ceiling.plane.normal.z).toBeLessThan(0);
    expect(posHitsSphere(ceiling, { center: { x: -0.5, y: 0, z: 0.6 }, radius: 0.48 }, { x: 0, y: 0, z: 0.1 }, FLOOR_WALKABLE_Z)).toBeNull();
  });

  it('the floor search at FloorZ does not stand a body on a 51° face', () => {
    const leaf = { type: 'LEAF', polygons: [SLOPE_51] } as CollisionBSPNode;
    expect(collectWalkableFloorHeights(leaf, -0.8, 0)).toHaveLength(1);
    expect(collectWalkableFloorHeights(leaf, -0.8, 0, FLOOR_WALKABLE_Z)).toEqual([]);
  });

  it('DungeonCollision: walking into the face stops at it instead of climbing it', () => {
    const dc = new DungeonCollision();
    // A floor up to the face's foot at x 0, the face rising behind it.
    const floor = poly([0, -2.3, 0], [3, -2.3, 0], [3, 2.3, 0], [0, 2.3, 0]);
    dc.addGfxObjCollision(1, gfxOf([floor, SLOPE_51]), { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    let x = 2;
    let y = 0;
    for (let i = 0; i < 40; i++) {
      const [ax] = dc.getAdjustedMovement(new THREE.Vector3(x, y, 0), -0.1, 0);
      x += ax;
      y = dc.getFloorHeight(x, 0, y + dc.lastStepUp) ?? y;
    }
    // The feet sphere (centre 0.475 up, radius 0.48) touches the face at x ≈ 0.23.
    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(0.3);
    expect(y).toBeCloseTo(0, 6);
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

describe.skipIf(!datPresent)('BUG.moveto-wall-climb-flying-target — the academy alcove 0x860201E0 (needs DAT files)', () => {
  const BX = 0x86 * 192;
  const BY = 0x02 * 192;
  const LB = 0x86020000;
  let col: DungeonCollision;
  let services: MovementServices;

  beforeAll(async () => {
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const materialFactory = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const env = new EnvCellRenderer(portalDb, cellDb, materialFactory, new SetupModelRenderer(portalDb, modelRenderer), modelRenderer);
    col = new DungeonCollision();
    for (let c = 0x100; c <= 0x3ff; c++) {
      const cellId = (LB | c) >>> 0;
      const coll = env.getCellCollisionData(cellId);
      if (coll) col.addCell(cellId, coll.cellStruct, coll.position);
    }
    services = {
      dungeonCollision: col,
      outdoorCollision: col,
      terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null } as never,
      water: { waterDepthAt: () => 0 } as never,
      creatureObstacles: null,
      defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS,
      edgeSlide: true,
      stepDownHeight: 1.5,
    };
  }, 120_000);

  it('the corridor opens west into the alcove, whose back face is too steep to stand on', () => {
    expect(col.findCellContaining(BX + 37.88, BY - 89.23, 0.475)).toBe(0x860201f6);
    expect(col.findCellContaining(BX + 33.5, BY - 89.23, 0.475)).toBe(0x860201e0);
    // Over the back face (x 31.0–32.6) there is no floor a body stands on.
    expect(col.getFloorHeight(BX + 32.0, BY - 89.23, 0.5)).toBeNull();
  });

  it('a server MoveTo run west from the Blacksmith corridor stops at the alcove wall on the floor', () => {
    let x = BX + 37.88;
    let z = BY - 89.23;
    let y = 0;
    const yawWest = Math.PI / 2; // heading −x (OutdoorMovement: dir = (−sin yaw, −cos yaw))
    const runSpeed = 4.0 * 2.0; // a fast run, m/s
    const steps = [1 / 60];
    for (let frame = 0; frame < 4 * 60; frame++) {
      const moved = stepMoveToMotion({ x, z, floorY: y, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 },
        yawWest, runSpeed, steps, services);
      x = moved.x;
      z = moved.z;
      y = col.getFloorHeight(x, z, y + col.lastStepUp) ?? y;
      expect(y).toBeCloseTo(0, 3);
    }
    // Against the 51° back face (feet-sphere contact at x ≈ 32.83), inside the alcove.
    expect(x - BX).toBeGreaterThan(32.7);
    expect(x - BX).toBeLessThan(33.0);
    expect(col.findCellContaining(x, z, y + col.lowerSphereHeight)).toBe(0x860201e0);
  });

  it('the same run with the player\'s own floor follow (getBodyFloorHeight) stays on the floor at the wall', () => {
    // RECON.transition-stepup-stepdown-port.e — main.ts follows the feet
    // sphere's step-down contact; the 51° face is no walkable, so it is no
    // contact either.
    let x = BX + 37.88;
    let z = BY - 89.23;
    let y = 0;
    for (let frame = 0; frame < 4 * 60; frame++) {
      const moved = stepMoveToMotion({ x, z, floorY: y, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 },
        Math.PI / 2, 8.0, [1 / 60], services);
      x = moved.x;
      z = moved.z;
      y = col.getBodyFloorHeight(x, z, y + col.lastStepUp, 0.6) ?? y;
      expect(y).toBeCloseTo(0, 3);
    }
    expect(x - BX).toBeGreaterThan(32.7);
    expect(x - BX).toBeLessThan(33.0);
  });
});
