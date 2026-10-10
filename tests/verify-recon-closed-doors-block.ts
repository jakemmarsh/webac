/**
 * RECON.closed-doors-walkthrough — closed doors and gates are server objects
 * whose PhysicsState carries HasPhysicsBSP (0x10000): CPhysicsObj::
 * FindObjCollisions @ 0050f050 tests their part BSPs, the same as a building.
 * The client used to register only creatures (by cylspheres / spheres), so a
 * closed door was walk-through. Drives the real ServerObjectManager.
 * getBlockersNear → CreatureCollision.addCreatureObstacles → DungeonCollision.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsState, makePlane, type PhysicsPolygon } from '@ac/shared';
import { addCreatureObstacles, type CreatureBlocker } from '../packages/renderer/src/world/CreatureCollision.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import type { ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

type V3 = [number, number, number];
function quad(a: V3, b: V3, c: V3, d: V3): PhysicsPolygon {
  const vertices = [a, b, c, d].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}
/** A door leaf: a 0.2 m thick, 2 m wide, 3 m tall slab across AC +Y, centred on the origin. */
function doorGfx() {
  const polys = [
    quad([0.1, 1, 3], [0.1, -1, 3], [0.1, -1, 0], [0.1, 1, 0]),
    quad([-0.1, -1, 3], [-0.1, 1, 3], [-0.1, 1, 0], [-0.1, -1, 0]),
    quad([-0.1, 1, 3], [0.1, 1, 3], [0.1, 1, 0], [-0.1, 1, 0]),
    quad([0.1, -1, 3], [-0.1, -1, 3], [-0.1, -1, 0], [0.1, -1, 0]),
  ];
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const idx: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); idx.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices: idx, numVertices: 4, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 1.5 }, radius: 1.9 }, inPolys: [0, 1, 2, 3] } },
    drawingBSP: null,
    physicsPolygons,
    vertexArray: { vertices },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const DOOR_SETUP = 0x02000a00;
const BSP_CREATURE_SETUP = 0x02000a01;
const IDQ = { w: 1, x: 0, y: 0, z: 0 };
const door = doorGfx();
function physics(setupId: number): ObjectPhysicsModel | null {
  const part = { gfx: door, frame: { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ } };
  const sorting = { origin: { x: 0, y: 0, z: 1.5 }, radius: 1.9 };
  if (setupId === DOOR_SETUP) return { parts: [part], hasPhysicsBSP: true, cylSpheres: [], spheres: [], sortingSphere: sorting };
  // A creature whose part happens to carry a BSP: the server state has no HasPhysicsBSP.
  if (setupId === BSP_CREATURE_SETUP) {
    return { parts: [part], hasPhysicsBSP: true, cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: 0.5, height: 1.8 }], spheres: [], sortingSphere: sorting };
  }
  return null;
}

const DOOR_STATE = PhysicsState.ReportCollisions | PhysicsState.HasPhysicsBSP; // a closed ACE door
function blocker(over: Partial<CreatureBlocker> = {}): CreatureBlocker {
  return { guid: 0x7a000001, worldX: 50, worldY: 0, worldZ: 50, collisionRadius: 0, setupId: DOOR_SETUP, quat: IDQ, scale: 1, physicsState: DOOR_STATE, ...over };
}

/** Walk the feet +X (THREE x = AC x) from 2 m west of the door toward it in 0.1 m steps; returns the final x. */
function walkInto(dc: DungeonCollision, steps = 30): number {
  const p = new THREE.Vector3(48, 0, 50);
  for (let i = 0; i < steps; i++) {
    const [ax, az] = dc.getAdjustedMovement(p, 0.1, 0);
    p.x += ax; p.z += az;
  }
  return p.x;
}

describe('addCreatureObstacles — a HasPhysicsBSP object collides by its part BSPs', () => {
  it('a closed door stops the walk at its face', () => {
    const dc = new DungeonCollision();
    const keys = addCreatureObstacles(dc, [blocker()], physics);
    expect(keys.length).toBe(1);
    const x = walkInto(dc);
    expect(x).toBeLessThan(50 - 0.1); // never through the slab's west face
    expect(x).toBeGreaterThan(48.5); // but walked up to it
    for (const k of keys) dc.removeKey(k);
    expect(walkInto(dc)).toBeGreaterThan(50.5); // gone after the step: walk straight on
  });

  it('a door turned 90° blocks along the other axis', () => {
    // AC quaternion for a 90° heading about Z: the slab now spans X, not Y.
    const s = Math.SQRT1_2;
    const dc = new DungeonCollision();
    addCreatureObstacles(dc, [blocker({ quat: { w: s, x: 0, y: 0, z: s } })], physics);
    const p = new THREE.Vector3(50, 0, 48);
    for (let i = 0; i < 30; i++) { const [ax, az] = dc.getAdjustedMovement(p, 0, 0.1); p.x += ax; p.z += az; }
    expect(p.z).toBeLessThan(50 - 0.1);
  });

  it('without HasPhysicsBSP in its state the object uses its shapes, not its parts\' BSPs', () => {
    const dc = new DungeonCollision();
    addCreatureObstacles(dc, [blocker({ setupId: BSP_CREATURE_SETUP, physicsState: PhysicsState.ReportCollisions })], physics);
    expect(dc.cylinderCount).toBe(1);
    // A BSP-only object whose state lacks the bit has no shape at all: walk-through.
    const dc2 = new DungeonCollision();
    expect(addCreatureObstacles(dc2, [blocker({ physicsState: PhysicsState.ReportCollisions })], physics)).toEqual([]);
    expect(walkInto(dc2)).toBeGreaterThan(50.5);
  });
});

describe('ServerObjectManager.getBlockersNear — every in-cell object, not only creatures', () => {
  const LB = 0xA9B40017;
  function som() {
    const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => ({ radius: 1, height: 3, cylSpheres: [], spheres: [] }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
    m.setPlayerGuid(0x50000001);
    return m;
  }
  const data = (guid: number, over: Record<string, unknown> = {}) => ({
    guid, name: 'Door', weenieClassId: 412, itemType: 0x80 /* Misc */,
    position: { landblock: LB, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 }, setupId: DOOR_SETUP, motionTableId: 0, iconId: 0,
    physicsState: DOOR_STATE, objectDescFlags: 0x1000 /* Door */, radarColor: 0, radarBehavior: 0, basePalette: 0, subPalettes: [],
    textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0,
    velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
    iconOverlayId: 0, iconUnderlayId: 0, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  it('a closed door is a blocker carrying its PhysicsState; opened (Ethereal) it is not', () => {
    const m = som();
    const d = m.createObject(data(0x7a000001))!;
    const b = m.getBlockersNear(d.worldX, d.worldZ, 15);
    expect(b.map((x) => x.guid)).toEqual([0x7a000001]);
    expect(b[0].physicsState & PhysicsState.HasPhysicsBSP).toBeTruthy();
    // ACE Door.Open: Ethereal on (SetState).
    m.setPhysicsState(0x7a000001, DOOR_STATE | PhysicsState.Ethereal);
    expect(m.getBlockersNear(d.worldX, d.worldZ, 15)).toEqual([]);
    m.setPhysicsState(0x7a000001, DOOR_STATE);
    expect(m.getBlockersNear(d.worldX, d.worldZ, 15)).toHaveLength(1);
  });

  it('contained (never placed) and wielded objects are not in the way; out-of-range ones are skipped', () => {
    const m = som();
    const d = m.createObject(data(0x7a000002))!;
    m.createObject(data(0x7a000003, { position: null, containerId: 0x50000001 }));
    m.createObject(data(0x7a000004, { position: null, wielderId: 0x80000009 }));
    expect(m.getBlockersNear(d.worldX, d.worldZ, 15).map((x) => x.guid)).toEqual([0x7a000002]);
    expect(m.getBlockersNear(d.worldX + 40, d.worldZ, 15)).toEqual([]);
  });

  it('end to end: the blocker list from the manager stops a walk into the door', () => {
    const m = som();
    const d = m.createObject(data(0x7a000005))!;
    const dc = new DungeonCollision();
    // getBlockersNear is THREE world; place the walk relative to the door.
    const blockers = m.getBlockersNear(d.worldX, d.worldZ, 15).map((b) => ({ ...b, worldX: 50, worldY: 0, worldZ: 50 }));
    addCreatureObstacles(dc, blockers, physics);
    expect(walkInto(dc)).toBeLessThan(50 - 0.1);
  });
});
