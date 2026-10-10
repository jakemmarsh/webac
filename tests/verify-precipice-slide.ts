/**
 * RECON.transition-stepup-stepdown-port.b — an EdgeSlide body (every player:
 * the `human` weenie carries AllowEdgeSlide, so ACE sends PhysicsState
 * 0x00400000) cannot walk off a walkable BSP polygon whose far side drops
 * more than StepDownHeight. CTransition::edge_slide @ 0050b3d0 runs
 * SPHEREPATH::precipice_slide @ 0050cc80: CPolygon::find_crossed_edge on the
 * polygon under the body, the edge normal turned against the step, and
 * CSphere::slide_sphere along the edge (ACE Transition.cs:268 EdgeSlide,
 * SpherePath.cs:232 PrecipiceSlide, Polygon.cs:175 find_crossed_edge,
 * Sphere.cs:558 SlideSphere).
 *
 * Behavioral: drives the shipped findCrossedEdge, DungeonCollision and
 * stepPlayerMovement against a roof slab in a real collision world.
 */
import { describe, it, expect } from 'vitest';
import { findCrossedEdge, makePlane, type PhysicsPolygon } from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY } from '../packages/renderer/src/world/outdoorGround.js';
import {
  stepPlayerMovement, precipiceStep, type MovementServices, type MovementStepState,
} from '../packages/renderer/src/player/OutdoorMovement.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../packages/shared/src/physics/WaterMap.js';

/** A flat square of half-size h at local z, counter-clockwise from above (AC axes). */
function slab(h: number, z = 0): PhysicsPolygon {
  const vertices = [
    { x: -h, y: -h, z }, { x: h, y: -h, z }, { x: h, y: h, z }, { x: -h, y: h, z },
  ];
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

function mockGfx(poly: PhysicsPolygon) {
  const vertices = new Map<number, unknown>();
  poly.vertices.forEach((v, i) => vertices.set(i, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }));
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: [0] } },
    physicsPolygons: new Map([[0, { vertexIndices: [0, 1, 2, 3], numVertices: 4, stippling: 0, sidesType: 0, portalIndex: -1, polyId: 0 }]]),
    vertexArray: { vertices },
  } as never;
}

const UP = { x: 0, y: 0, z: 1 };
const IDENTITY = { w: 1, x: 0, y: 0, z: 0 };

describe('CPolygon::find_crossed_edge', () => {
  it('a point inside every edge crosses none', () => {
    expect(findCrossedEdge(slab(2), { x: 0.5, y: -1, z: 0.48 }, UP)).toBeNull();
  });

  it('a point beyond an edge returns plane.N x edge, normalized (inward for a counter-clockwise polygon)', () => {
    const e = findCrossedEdge(slab(2), { x: 2.3, y: 0, z: 0.48 }, UP)!;
    expect(e.x).toBeCloseTo(-1, 9);
    expect(e.y).toBeCloseTo(0, 9);
    expect(e.z).toBeCloseTo(0, 9);
    const n = findCrossedEdge(slab(2), { x: 0, y: -2.5, z: 3 }, UP)!; // height is projected out along up
    expect(n.y).toBeCloseTo(1, 9);
  });

  it('up parallel to the plane finds nothing (|N·up| < EPSILON)', () => {
    expect(findCrossedEdge(slab(2), { x: 3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
  });
});

describe('DungeonCollision.precipiceEdge', () => {
  it('names the walkable under the body and the edge the step crosses (renderer axes)', () => {
    const dc = new DungeonCollision();
    dc.addGfxObjCollision(1, mockGfx(slab(2)), { x: 10, y: 10, z: 20 }, IDENTITY, 0, 0);
    // Renderer (x, z) = AC (x, y). Step from the middle past the +x edge.
    const pe = dc.precipiceEdge(10, 10, 20, 12.4, 10)!;
    expect(pe.floorNormal.y).toBeCloseTo(1, 9);
    expect(pe.edge!.x).toBeCloseTo(-1, 9);
    expect(pe.edge!.z).toBeCloseTo(0, 9);
    // Past the +AC-y edge = renderer +z.
    expect(dc.precipiceEdge(10, 10, 20, 10, 12.4)!.edge!.z).toBeCloseTo(-1, 9);
    // Inside the slab: on the walkable, no edge crossed.
    expect(dc.precipiceEdge(10, 10, 20, 11, 10)).toEqual({ edge: null, floorNormal: expect.anything() });
  });

  it('carries the cell rotation into the edge normal', () => {
    const dc = new DungeonCollision();
    const q = { w: Math.cos(Math.PI / 8), x: 0, y: 0, z: Math.sin(Math.PI / 8) }; // +45° about z
    dc.addGfxObjCollision(2, mockGfx(slab(2)), { x: 10, y: 10, z: 20 }, q, 0, 0);
    // The local +x edge lies along global (cos45, sin45); its normal points back in.
    const e = dc.precipiceEdge(10, 10, 20, 10 + 2.5 * Math.SQRT1_2, 10 + 2.5 * Math.SQRT1_2)!.edge!;
    expect(e.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(e.z).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it('null off any BSP floor (terrain is the contact)', () => {
    const dc = new DungeonCollision();
    dc.addGfxObjCollision(3, mockGfx(slab(2)), { x: 10, y: 10, z: 20 }, IDENTITY, 0, 0);
    expect(dc.precipiceEdge(10, 10, 15, 13, 10)).toBeNull();
    expect(dc.precipiceEdge(30, 30, 20, 33, 30)).toBeNull();
  });
});

describe('precipiceStep — slide_sphere along the crossed edge', () => {
  const edgeX = {
    precipiceEdge: () => ({ edge: { x: 1, y: 0, z: 0 }, floorNormal: { x: 0, y: 1, z: 0 } }),
    collisionNormal: null as { x: number; z: number } | null,
  };
  /** The roof (20) under the start (x = 0), `g` under the destination. */
  const beyond = (g: number) => (x: number) => (x === 0 ? 20 : g);
  const farBelow = beyond(0);

  it('keeps only the component along the edge and sets the collision normal', () => {
    const c = { ...edgeX };
    const r = precipiceStep(c, 0, 0, 20, 0.3, 0.4, 1.5, farBelow);
    expect(r).not.toBe('collided');
    const [dx, dz] = r as [number, number];
    expect(dx).toBeCloseTo(0, 9);
    expect(dz).toBeCloseTo(0.4, 9);
    expect(c.collisionNormal!.x).toBeCloseTo(-1, 9); // turned against the step
  });

  it('a step straight at the edge is Collided (the slide is shorter than sqrt(EPSILON))', () => {
    expect(precipiceStep({ ...edgeX }, 0, 0, 20, 0.3, 0, 1.5, farBelow)).toBe('collided');
  });

  it('a walkable within StepDownHeight below the destination keeps the step', () => {
    expect(precipiceStep({ ...edgeX }, 0, 0, 20, 0.3, 0.4, 1.5, beyond(18.6))).toBeNull();
    expect(precipiceStep({ ...edgeX }, 0, 0, 20, 0.3, 0.4, 1.5, beyond(18.4))).not.toBeNull();
  });

  it('measures from the floor under the step, not the frame\'s floorY (a sloped floor has moved on)', () => {
    // floorY 20.3 is stale; the floor here is 20, so 18.6 below the destination is in reach.
    expect(precipiceStep({ ...edgeX }, 0, 0, 20.3, 0.3, 0.4, 1.5, beyond(18.6))).toBeNull();
    let asked = NaN;
    const c = { precipiceEdge: (_x: number, _z: number, y: number) => { asked = y; return null; } };
    precipiceStep(c, 0, 0, 20.3, 0.3, 0.4, 1.5, farBelow);
    expect(asked).toBe(20);
  });

  it('no crossed edge on the walkable is Collided; no BSP walkable leaves the step to the terrain rules', () => {
    const noEdge = { precipiceEdge: () => ({ edge: null, floorNormal: { x: 0, y: 1, z: 0 } }) };
    expect(precipiceStep(noEdge, 0, 0, 20, 0.3, 0.4, 1.5, farBelow)).toBe('collided');
    expect(precipiceStep({ precipiceEdge: () => null }, 0, 0, 20, 0.3, 0.4, 1.5, farBelow)).toBeNull();
  });
});

// ── Whole movement steps on a roof 10 m above flat terrain ──
const BX = 10, BY = 10;
const X0 = BX * 192 + 40, Z0 = BY * 192 + 40;
const ROOF_Y = 20;
const HALF = 3;

function terrainAt10(): TerrainCollision {
  const t = new TerrainCollision();
  t.setLandblock(BX, BY, { heights: new Array(81).fill(10), blockX: BX, blockY: BY });
  return t;
}

function dryWater(): WaterMap {
  const w = new WaterMap();
  w.setLandblock(BX, BY, new Array(256).fill(0));
  return w;
}

function roofWorld(roofY = ROOF_Y): DungeonCollision {
  const dc = new DungeonCollision();
  dc.addGfxObjCollision('roof', mockGfx(slab(HALF)), { x: X0, y: Z0, z: roofY }, IDENTITY, 0, 0);
  return dc;
}

function outdoorServices(dc: DungeonCollision, edgeSlide = true): MovementServices {
  const terrain = terrainAt10();
  return {
    dungeonCollision: null,
    outdoorCollision: dc,
    terrain,
    water: dryWater(),
    creatureObstacles: null,
    defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS,
    edgeSlide,
    stepDownHeight: 1.5,
    groundAt: (x, z, fromY) => outdoorGroundY(
      { terrainHeight: (a, b) => terrain.getHeightAt(a, b), floorHeight: (a, b, y) => dc.getFloorHeight(a, b, y) }, x, z, fromY),
  };
}

function run(s: MovementStepState, sv: MovementServices, dx: number, dz: number, steps: number): MovementStepState {
  for (let i = 0; i < steps; i++) {
    const r = stepPlayerMovement(s, dx, dz, 0.05, sv);
    s = { ...s, x: r.x, z: r.z };
  }
  return s;
}

function onRoof(over: Partial<MovementStepState> = {}): MovementStepState {
  return { x: X0, z: Z0, floorY: ROOF_Y, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, ...over };
}

describe('stepPlayerMovement — an EdgeSlide player on a roof', () => {
  it('running straight at the edge stops on the roof instead of walking off', () => {
    const s = run(onRoof(), outdoorServices(roofWorld()), 0.25, 0, 40);
    expect(s.x).toBeLessThanOrEqual(X0 + HALF + 1e-6);
    expect(s.x).toBeGreaterThan(X0 + HALF - 0.3);
    expect(s.z).toBeCloseTo(Z0, 6);
  });

  it('a diagonal run slides along the edge', () => {
    const s = run(onRoof(), outdoorServices(roofWorld()), 0.2, 0.1, 40);
    expect(s.x).toBeLessThanOrEqual(X0 + HALF + 1e-6);
    // Along the +z edge too: it ends at the corner, still on the roof.
    expect(s.z).toBeLessThanOrEqual(Z0 + HALF + 1e-6);
    expect(s.z).toBeGreaterThan(Z0 + 1.5); // it kept moving along the edge after reaching x's edge
  });

  it('without EdgeSlide (PhysicsState 0x00400000 clear) the step goes over the edge (GAP.7 walk-off)', () => {
    const s = run(onRoof(), outdoorServices(roofWorld(), false), 0.25, 0, 40);
    expect(s.x).toBeGreaterThan(X0 + HALF + 1);
  });

  it('a ledge within StepDownHeight is stepped off', () => {
    const s = run(onRoof({ floorY: 11 }), outdoorServices(roofWorld(11)), 0.25, 0, 40);
    expect(s.x).toBeGreaterThan(X0 + HALF + 1);
  });

  it('an airborne body is not held by the edge', () => {
    const s = run(onRoof({ airborne: true, jumpVelocityX: 5 }), outdoorServices(roofWorld()), 0, 0, 40);
    expect(s.x).toBeGreaterThan(X0 + HALF + 1);
  });
});

describe('stepPlayerMovement — a dungeon ledge', () => {
  it('stops at a ledge over a 10 m drop; walks off one in reach', () => {
    const ledge = (y: number) => {
      const dc = new DungeonCollision();
      dc.addGfxObjCollision('ledge', mockGfx(slab(HALF)), { x: X0, y: Z0, z: y }, IDENTITY, 0, 0);
      dc.addGfxObjCollision('pit', mockGfx(slab(30)), { x: X0, y: Z0, z: 10 }, IDENTITY, 0, 0);
      return dc;
    };
    const sv = (dc: DungeonCollision): MovementServices => ({
      ...outdoorServices(dc),
      dungeonCollision: dc,
      dungeonGroundAt: (x, z, fromY) => dc.getFloorHeight(x, z, fromY, Infinity),
    });
    const high = ledge(20);
    const s = run(onRoof({ inDungeon: true }), sv(high), 0.25, 0, 40);
    expect(s.x).toBeLessThanOrEqual(X0 + HALF + 1e-6);
    const low = ledge(11);
    const t = run(onRoof({ inDungeon: true, floorY: 11 }), sv(low), 0.25, 0, 40);
    expect(t.x).toBeGreaterThan(X0 + HALF + 1);
  });
});

describe('DungeonCollision.floorPlanesAt — every upward-facing polygon under a point', () => {
  it('lists unwalkable faces too (the gap a walkable-only floor query skips), highest first', () => {
    const dc = new DungeonCollision();
    dc.addGfxObjCollision('flat', mockGfx(slab(2)), { x: 10, y: 10, z: 20 }, IDENTITY, 0, 0);
    // A 55° face (normal z 0.57 < FloorZ 0.664) under the same point, lower down.
    const t = Math.tan(55 * Math.PI / 180);
    const steep: PhysicsPolygon = (() => {
      const vertices = [{ x: -2, y: -2, z: -2 * t }, { x: 2, y: -2, z: -2 * t }, { x: 2, y: 2, z: 2 * t }, { x: -2, y: 2, z: 2 * t }];
      return { vertices, plane: makePlane(vertices), numPts: 4 };
    })();
    dc.addGfxObjCollision('steep', mockGfx(steep), { x: 10, y: 10, z: 10 }, IDENTITY, 0, 0);
    const planes = dc.floorPlanesAt(10, 10);
    expect(planes.map((p) => +p.y.toFixed(3))).toEqual([20, 10]);
    expect(planes[0].normalZ).toBeCloseTo(1, 9);
    expect(planes[1].normalZ).toBeCloseTo(Math.cos(55 * Math.PI / 180), 6);
    // Walkable-only: the steep face is left out, as getFloorHeight leaves it out.
    expect(dc.floorPlanesAt(10, 10, 0.664).map((p) => +p.y.toFixed(3))).toEqual([20]);
  });
});
