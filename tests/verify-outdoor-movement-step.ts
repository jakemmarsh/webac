/**
 * DEBT.main-ts-extractions — the per-substep player movement step
 * (player/OutdoorMovement.stepPlayerMovement), lifted out of main.ts
 * animate(), driven against the REAL collision services main.ts wires in:
 * DungeonCollision (the outdoor world: cylinder obstacles stand in for a
 * wall), shared TerrainCollision (GAP.5 slope) and shared WaterMap (GAP.6:
 * a landblock of open sea stops a player; a river's flooded cells are waded).
 *
 * Also pins the airborne fix: ACE collides every transition, airborne ones
 * included — LandCell.FindEnvCollisions returns Collided for a non-viewer,
 * non-missile object entering an EntirelyWater landblock (LandCell.cs:54-58) and
 * FindObjCollisions stops the sphere at walls — where the in-closure code
 * applied jump momentum with no check at all.
 */
import { describe, it, expect } from 'vitest';
import {
  stepPlayerMovement, stepMoveToMotion, transitionNumSteps, TRANSITIONAL_PERCENT_OF_RADIUS, cliffSlideOffset,
  type MovementServices, type MovementStepState, type MovementCollider, type MovementCreatureObstacles,
} from '../packages/renderer/src/player/OutdoorMovement.js';
import * as THREE from 'three';
import { addCreatureObstacles, type CreatureBlocker } from '../packages/renderer/src/world/CreatureCollision.js';
import type { ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { MAX_QUANTUM } from '../packages/shared/src/physics/PhysicsQuantum.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap, LandWaterType } from '../packages/shared/src/physics/WaterMap.js';

// Landblock (10, 10): world X/Z 1920..2112, dry grass (0x00) in columns
// 0..3 and fully flooded cells (all four corners terrain type 0x14 —
// WaterDeepSea) in columns >= 4: a lake shore, waded. Landblock (11, 10),
// X 2112..2304, is all water: open sea (an EntirelyWater block), which
// stops a player (CLandCell::find_env_collisions' get_block_water_type).
const BX = 10, BY = 10;
const BLOCK_X0 = BX * 192, BLOCK_Z0 = BY * 192;
const LAKE_EDGE_X = BLOCK_X0 + 4 * 24; // 2016
const WATER_EDGE_X = BLOCK_X0 + 192; // 2112: the sea block's west edge

function flatTerrain(): TerrainCollision {
  const t = new TerrainCollision();
  t.setLandblock(BX, BY, { heights: new Array(81).fill(10), blockX: BX, blockY: BY });
  t.setLandblock(BX + 1, BY, { heights: new Array(81).fill(10), blockX: BX + 1, blockY: BY });
  return t;
}

function waterMap(): WaterMap {
  const w = new WaterMap();
  const corners: number[] = [];
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 8; row++) {
      const t = col >= 4 ? 0x14 : 0x00;
      corners.push(t, t, t, t);
    }
  }
  w.setLandblock(BX, BY, corners);
  w.setLandblock(BX + 1, BY, new Array(256).fill(0x14));
  return w;
}

function services(over: Partial<MovementServices> = {}): MovementServices {
  return {
    dungeonCollision: null,
    outdoorCollision: new DungeonCollision(),
    terrain: flatTerrain(),
    water: waterMap(),
    creatureObstacles: null,
    defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS,
    edgeSlide: true,
    stepDownHeight: 1.5,
    ...over,
  };
}

function state(over: Partial<MovementStepState> = {}): MovementStepState {
  return {
    x: BLOCK_X0 + 40, z: BLOCK_Z0 + 40, floorY: 10,
    inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0,
    ...over,
  };
}

/** A post in the outdoor world (a cylinder obstacle, as ObjectCollision registers CylSpheres). */
function worldWithPost(x: number, z: number, radius: number): DungeonCollision {
  const c = new DungeonCollision();
  c.addCylinderObstacle('test:post', x, z, radius);
  return c;
}

describe('stepPlayerMovement — grounded outdoor', () => {
  it('flat run: the input delta is applied unchanged and the camera keeps its motion', () => {
    const s = state();
    const r = stepPlayerMovement(s, 0.5, -0.25, 0.05, services());
    expect(r.x).toBeCloseTo(s.x + 0.5, 9);
    expect(r.z).toBeCloseTo(s.z - 0.25, 9);
    expect(r.revertCamera).toBe(false);
  });

  it('wall slide: running at a post never enters it, and a glancing run slides past', () => {
    const post = { x: BLOCK_X0 + 50, z: BLOCK_Z0 + 40, r: 1 };
    const sv = services({ outdoorCollision: worldWithPost(post.x, post.z, post.r) });
    // Walls stop the body spheres (DungeonCollision.BODY_SPHERE_RADIUS), not the cylinder radius.
    const minDist = post.r + DungeonCollision.BODY_SPHERE_RADIUS;
    // Head-on: 40 substeps of 0.25 m straight at the post.
    let s = state();
    for (let i = 0; i < 40; i++) {
      const r = stepPlayerMovement(s, 0.25, 0, 0.05, sv);
      s = { ...s, x: r.x, z: r.z };
      expect(Math.hypot(s.x - post.x, s.z - post.z)).toBeGreaterThanOrEqual(minDist - 1e-6);
    }
    expect(s.x).toBeLessThan(post.x - minDist + 0.3); // stopped at the post, not through it
    // Glancing: offset 1 m sideways — the player slides around and keeps going.
    s = state({ z: BLOCK_Z0 + 41 });
    for (let i = 0; i < 80; i++) {
      const r = stepPlayerMovement(s, 0.25, 0, 0.05, sv);
      s = { ...s, x: r.x, z: r.z };
      expect(Math.hypot(s.x - post.x, s.z - post.z)).toBeGreaterThanOrEqual(minDist - 1e-6);
    }
    expect(s.x).toBeGreaterThan(post.x + minDist); // made it past the post
  });

  it('GAP.6 — a fully flooded cell in a block with dry land (a lake, a river) is waded, not a wall', () => {
    const sv = services();
    const w = sv.water as WaterMap;
    expect(w.cellWaterTypeAt(LAKE_EDGE_X + 0.5, BLOCK_Z0 + 40)).toBe(LandWaterType.EntirelyWater);
    expect(w.blockWaterTypeAt(LAKE_EDGE_X + 0.5, BLOCK_Z0 + 40)).toBe(LandWaterType.PartiallyWater);
    const s = state({ x: LAKE_EDGE_X - 0.3 });
    const r = stepPlayerMovement(s, 0.5, 0, 0.05, sv);
    expect(r.x).toBeCloseTo(s.x + 0.5, 9);
    // …0.9 m deep (get_water_depth for an ENTIRELY_WATER cell).
    expect(w.waterDepthAt(r.x, r.z)).toBeCloseTo(0.9, 6);
  });

  it('GAP.6 — entering a landblock of open sea is blocked (find_env_collisions: get_block_water_type)', () => {
    const sv = services();
    expect((sv.water as WaterMap).blockWaterTypeAt(WATER_EDGE_X + 0.5, BLOCK_Z0 + 40)).toBe(LandWaterType.EntirelyWater);
    const s = state({ x: WATER_EDGE_X - 0.3 });
    // A sub-radius move is one transition step: the whole step is rejected.
    const r = stepPlayerMovement(s, 0.4, 0, 0.05, sv);
    expect(r.x).toBe(s.x);
    expect(r.z).toBe(s.z);
    // A longer move is swept in radius steps (retail calc_num_steps): it
    // advances through the dry steps and stops at the last one before water.
    const far = stepPlayerMovement(s, 0.5, 0, 0.05, sv);
    expect(far.x).toBeCloseTo(s.x + 0.25, 9);
    expect(far.x).toBeLessThan(WATER_EDGE_X);
  });

  it('GAP.6 — leaving the open sea for land is allowed', () => {
    const s = state({ x: WATER_EDGE_X + 0.2 });
    const r = stepPlayerMovement(s, -0.5, 0, 0.05, services());
    expect(r.x).toBeCloseTo(s.x - 0.5, 9);
  });

  it('GAP.5 — ascending onto unwalkable terrain is rejected; descending it is allowed', () => {
    // A 30 m rise per 24 m cell along one grid axis — normal.Z ≈ 0.62, under
    // PhysicsGlobals.FloorZ (0.664).
    const terrain = new TerrainCollision();
    terrain.setLandblock(BX, BY, { heights: Array.from({ length: 81 }, (_, i) => Math.floor(i / 9) * 30), blockX: BX, blockY: BY });
    const sv = services({ terrain });
    const x = BLOCK_X0 + 60, z = BLOCK_Z0 + 60;
    expect(terrain.isWalkable(x, z)).toBe(false);
    // Find the uphill direction along X from the real sampler.
    const up = (terrain.getHeightAt(x + 0.5, z)! > terrain.getHeightAt(x, z)!) ? 0.5 : -0.5;
    const s = state({ x, z });
    const blocked = stepPlayerMovement(s, up, 0, 0.05, sv);
    expect(blocked.x).toBe(x);
    const down = stepPlayerMovement(s, -up, 0, 0.05, sv);
    expect(down.x).toBeCloseTo(x - up, 9);
  });

  it('idle player: a creature moving into a standing player does not displace it (retail UpdateObjectInternal skips transition on zero motion)', () => {
    const s = state();
    let queried = false;
    const sv = services({ creatureObstacles: (c, x, z, range) => { queried = true; return creatureService()(c, x, z, range); } });
    for (let i = 0; i < 20; i++) {
      const r = stepPlayerMovement(s, 0, 0, 0.05, sv);
      expect(r.x).toBe(s.x);
      expect(r.z).toBe(s.z);
    }
    expect(queried).toBe(false);
  });
});

/**
 * A plateau at height 100 for grid columns 0..3 (X < BLOCK_X0 + 72), then a
 * cliff falling 30 m per 24 m column along +X (normal.Z ≈ 0.62 < FloorZ).
 * Every height depends on the column only, so both triangles of a cell share
 * one plane whatever the cell's split.
 */
const CLIFF_EDGE_X = BLOCK_X0 + 3 * 24;
function cliffTerrain(): TerrainCollision {
  const t = new TerrainCollision();
  t.setLandblock(BX, BY, {
    heights: Array.from({ length: 81 }, (_, i) => { const col = Math.floor(i / 9); return col <= 3 ? 100 : 100 - (col - 3) * 30; }),
    blockX: BX, blockY: BY,
  });
  return t;
}

describe('RECON.transition-stepup-stepdown-port — terrain step-down / edge_slide', () => {
  const z = BLOCK_Z0 + 40;

  it('the terrain plane is the cliff triangle: walkable plateau, unwalkable face', () => {
    const t = cliffTerrain();
    expect(t.isWalkable(CLIFF_EDGE_X - 1, z)).toBe(true);
    expect(t.isWalkable(CLIFF_EDGE_X + 1, z)).toBe(false);
    const n = t.getTriangleNormalAt(CLIFF_EDGE_X + 1, z)!;
    expect(n.y).toBeCloseTo(24 / Math.hypot(24, 30), 9);
    expect(n.x).toBeGreaterThan(0); // faces down the +X slope
  });

  it('walking straight off the plateau onto the cliff face is stopped at the edge (cliff_slide leaves nothing)', () => {
    const sv = services({ terrain: cliffTerrain() });
    let s = state({ x: CLIFF_EDGE_X - 1, z, floorY: 100 });
    for (let i = 0; i < 20; i++) {
      const r = stepPlayerMovement(s, 0.3, 0, 0.05, sv);
      s = { ...s, x: r.x, z: r.z };
    }
    expect(s.x).toBeLessThanOrEqual(CLIFF_EDGE_X);
    expect(s.x).toBeGreaterThan(CLIFF_EDGE_X - 0.31); // walked up to the edge first
  });

  it('a diagonal walk into the cliff slides along the edge (the crossing line), never down the face', () => {
    const sv = services({ terrain: cliffTerrain() });
    let s = state({ x: CLIFF_EDGE_X - 0.1, z, floorY: 100 });
    const r = stepPlayerMovement(s, 0.3, 0.3, 0.05, sv);
    expect(r.x).toBeCloseTo(s.x, 9);
    expect(r.z).toBeCloseTo(s.z + 0.3, 9);
    s = { ...s, x: r.x, z: r.z };
    for (let i = 0; i < 20; i++) {
      const q = stepPlayerMovement(s, 0.2, 0.3, 0.05, sv);
      s = { ...s, x: q.x, z: q.z };
    }
    expect(s.x).toBeLessThanOrEqual(CLIFF_EDGE_X);
    expect(s.z).toBeGreaterThan(z + 5);
  });

  it('a stale per-frame floorY (a later substep of a long frame) still edge-slides', () => {
    // main.ts refreshes floorY once per frame; a 0.5 s SwiftShader frame runs
    // several substeps that start metres from where it was measured. Live
    // regression: the edge rule keyed off floorY and let the player walk off.
    const sv = services({ terrain: cliffTerrain() });
    const s = state({ x: CLIFF_EDGE_X - 0.1, z, floorY: 103.7 });
    const r = stepPlayerMovement(s, 0.8, 0, 0.2, sv);
    expect(r.x).toBeLessThanOrEqual(CLIFF_EDGE_X);
  });

  it('ordinary steps never run the BSP floor search (only a descent onto an unwalkable face resolves the contact)', () => {
    let calls = 0;
    const sv = services({ terrain: cliffTerrain(), groundAt: () => { calls++; return null; } });
    let s = state({ x: CLIFF_EDGE_X - 10, z, floorY: 100 });
    for (let i = 0; i < 20; i++) {
      const r = stepPlayerMovement(s, 0.2, 0.1, 0.05, sv);
      s = { ...s, x: r.x, z: r.z };
    }
    expect(calls).toBe(0);
    stepPlayerMovement(state({ x: CLIFF_EDGE_X - 0.1, z, floorY: 100 }), 0.3, 0, 0.05, sv);
    expect(calls).toBeGreaterThan(0);
  });

  it('no EdgeSlide state: the step walks down the face (edge_slide returns OK without sliding)', () => {
    const sv = services({ terrain: cliffTerrain(), edgeSlide: false });
    const s = state({ x: CLIFF_EDGE_X - 0.1, z, floorY: 100 });
    const r = stepPlayerMovement(s, 0.3, 0, 0.05, sv);
    expect(r.x).toBeCloseTo(s.x + 0.3, 9);
  });

  it('a drop beyond StepDownHeight is Collided outright (no contact, a land cell sets no walkable)', () => {
    const sv = services({ terrain: cliffTerrain(), stepDownHeight: 0.1 });
    const s = state({ x: CLIFF_EDGE_X - 0.05, z, floorY: 100 });
    // 0.25 m past the edge is 0.31 m down the face: out of a 0.1 m step-down.
    const r = stepPlayerMovement(s, 0.3, 0.3, 0.05, sv);
    expect(r.x).toBe(s.x);
    expect(r.z).toBe(s.z);
  });

  it('a BSP floor over the face (a bridge) is the contact there: the terrain rule does not apply', () => {
    const sv = services({ terrain: cliffTerrain(), groundAt: (x, _z, fromY) => (x > CLIFF_EDGE_X ? fromY : null) });
    const s = state({ x: CLIFF_EDGE_X - 0.1, z, floorY: 100 });
    const r = stepPlayerMovement(s, 0.3, 0, 0.05, sv);
    expect(r.x).toBeCloseTo(s.x + 0.3, 9);
  });

  it('standing on the face (not OnWalkable) is not edge-slid: descending stays allowed', () => {
    const sv = services({ terrain: cliffTerrain() });
    const x = CLIFF_EDGE_X + 6;
    const s = state({ x, z, floorY: sv.terrain.getHeightAt(x, z)! });
    const r = stepPlayerMovement(s, 0.3, 0, 0.05, sv);
    expect(r.x).toBeCloseTo(x + 0.3, 9);
  });

  it('walking back up onto the plateau from below the lip is unaffected; walking along the plateau is unaffected', () => {
    const sv = services({ terrain: cliffTerrain() });
    const s = state({ x: CLIFF_EDGE_X - 3, z, floorY: 100 });
    const r = stepPlayerMovement(s, -0.3, 0.2, 0.05, sv);
    expect(r.x).toBeCloseTo(s.x - 0.3, 9);
    expect(r.z).toBeCloseTo(s.z + 0.2, 9);
  });

  it('cliffSlideOffset is cliff_slide: both branches remove |offset·n| along the crossing normal', () => {
    const flat = { x: 0, y: 1, z: 0 };
    const face = { x: 0.78, y: 0.62, z: 0 }; // falls toward +X
    // Into the face: the X component goes, Z survives.
    const [ax, az] = cliffSlideOffset(0.3, 0.2, face, flat)!;
    expect(ax).toBeCloseTo(0, 9);
    expect(az).toBeCloseTo(0.2, 9);
    // angle <= 0 branch (offset against the slide normal): offset + n·angle.
    const [bx, bz] = cliffSlideOffset(-0.3, 0.2, face, flat)!;
    expect(bx).toBeCloseTo(-0.6, 9);
    expect(bz).toBeCloseTo(0.2, 9);
    // Parallel planes: normalize_check_small → no slide.
    expect(cliffSlideOffset(0.3, 0, flat, flat)).toBeNull();
  });
});

describe('stepPlayerMovement — airborne (jump momentum)', () => {
  it('input is ignored; momentum moves the player and the camera motion is reverted', () => {
    const s = state({ airborne: true, jumpVelocityX: 4, jumpVelocityZ: -2 });
    const r = stepPlayerMovement(s, 9, 9, 0.1, services());
    expect(r.x).toBeCloseTo(s.x + 0.4, 9);
    expect(r.z).toBeCloseTo(s.z - 0.2, 9);
    expect(r.revertCamera).toBe(true);
  });

  it('a jump into a wall stops at the wall instead of passing through it', () => {
    const post = { x: BLOCK_X0 + 45, z: BLOCK_Z0 + 40, r: 1.5 };
    const sv = services({ outdoorCollision: worldWithPost(post.x, post.z, post.r) });
    let s = state({ airborne: true, jumpVelocityX: 6 });
    for (let i = 0; i < 30; i++) {
      const r = stepPlayerMovement(s, 0, 0, 0.1, sv);
      s = { ...s, x: r.x, z: r.z };
      expect(Math.hypot(s.x - post.x, s.z - post.z)).toBeGreaterThanOrEqual(post.r + DungeonCollision.BODY_SPHERE_RADIUS - 1e-6);
    }
    expect(s.x).toBeLessThan(post.x);
  });

  it('a jump toward deep water stops at the shoreline (EntirelyWater is Collided on every transition)', () => {
    let s = state({ x: WATER_EDGE_X - 1, airborne: true, jumpVelocityX: 4 });
    for (let i = 0; i < 10; i++) {
      const r = stepPlayerMovement(s, 0, 0, 0.1, services());
      s = { ...s, x: r.x, z: r.z };
    }
    expect(s.x).toBeLessThan(WATER_EDGE_X);
    expect(services().water.blockWaterTypeAt(s.x, s.z)).toBe(LandWaterType.PartiallyWater);
  });

  it('the slope rule does not gate an airborne step (it is a contact-plane rule)', () => {
    const terrain = new TerrainCollision();
    terrain.setLandblock(BX, BY, { heights: Array.from({ length: 81 }, (_, i) => Math.floor(i / 9) * 30), blockX: BX, blockY: BY });
    const x = BLOCK_X0 + 60, z = BLOCK_Z0 + 60;
    const up = (terrain.getHeightAt(x + 0.5, z)! > terrain.getHeightAt(x, z)!) ? 5 : -5;
    const s = state({ x, z, airborne: true, jumpVelocityX: up });
    const r = stepPlayerMovement(s, 0, 0, 0.1, services({ terrain }));
    expect(r.x).toBeCloseTo(x + up * 0.1, 9);
  });
});

describe('stepPlayerMovement — dungeon', () => {
  it('grounded input is wall-slid through the dungeon collision and the camera reverted', () => {
    const dungeon = worldWithPost(BLOCK_X0 + 41.5, BLOCK_Z0 + 40, 1);
    const s = state({ inDungeon: true });
    const r = stepPlayerMovement(s, 1, 0, 0.05, services({ dungeonCollision: dungeon }));
    expect(r.revertCamera).toBe(true);
    expect(Math.hypot(r.x - (BLOCK_X0 + 41.5), r.z - s.z)).toBeGreaterThanOrEqual(1 + DungeonCollision.BODY_SPHERE_RADIUS - 1e-6);
  });

  it('with no dungeon collision loaded the delta passes straight through (unchanged behaviour)', () => {
    const s = state({ inDungeon: true });
    const r = stepPlayerMovement(s, 1, 0.5, 0.05, services());
    expect(r.x).toBeCloseTo(s.x + 1, 9);
    expect(r.z).toBeCloseTo(s.z + 0.5, 9);
    expect(r.revertCamera).toBe(false);
  });
});

/**
 * BUG.max-quantum-server-value — retail CTransition::calc_num_steps @0050a0b0
 * (ACE Transition.cs:97-127): a transition is swept in
 * ceil(dist / (TRANSITIONAL_PERCENT_OF_RADIUS * sphere radius)) steps. With the
 * retail MAX_QUANTUM of 0.2s a hitch substep can carry a fast runner ~2.3m;
 * the sweep keeps each collision probe within one body-sphere radius.
 */
describe('stepPlayerMovement — retail transition steps (calc_num_steps)', () => {
  const R = DungeonCollision.BODY_SPHERE_RADIUS;
  // A high-run-skill player (runRate ~2.9 → ~11.7 m/s) over one MAX_QUANTUM substep.
  const hitchLeap = 11.7 * MAX_QUANTUM;

  it('step count: ceil(dist / radius) above one radius, one step at or below it, none for no motion', () => {
    expect(TRANSITIONAL_PERCENT_OF_RADIUS).toBe(1);
    expect(transitionNumSteps(0, 0, R)).toBe(0);
    expect(transitionNumSteps(0.1, 0, R)).toBe(1);
    expect(transitionNumSteps(R, 0, R)).toBe(1);
    expect(transitionNumSteps(R + 0.01, 0, R)).toBe(2);
    expect(transitionNumSteps(hitchLeap, 0, R)).toBe(Math.ceil(hitchLeap / R));
    expect(transitionNumSteps(3, 4, 1)).toBe(5);
  });

  it('a normal 60fps frame is still ONE collider call with the untouched delta (no behaviour change)', () => {
    const calls: Array<[number, number, number, number]> = [];
    const spy: MovementCollider & { lastStepUp: number } = {
      playerRadius: DungeonCollision.PLAYER_RADIUS,
      transitionSphereRadius: R,
      lastStepUp: 0,
      getAdjustedMovement(pos, dx, dz) { calls.push([pos.x, pos.z, dx, dz]); return [dx, dz]; },
    };
    const s = state();
    const d = 11.7 / 60;
    stepPlayerMovement(s, d, 0, 1 / 60, services({ outdoorCollision: spy }));
    expect(calls).toEqual([[s.x, s.z, d, 0]]);
  });

  it('a hitch substep is probed in radius-sized steps from each advanced position', () => {
    const calls: Array<[number, number, number, number]> = [];
    const spy: MovementCollider & { lastStepUp: number } = {
      playerRadius: DungeonCollision.PLAYER_RADIUS,
      transitionSphereRadius: R,
      lastStepUp: 0,
      getAdjustedMovement(pos, dx, dz) { calls.push([pos.x, pos.z, dx, dz]); return [dx, dz]; },
    };
    const s = state();
    const r = stepPlayerMovement(s, hitchLeap, 0, MAX_QUANTUM, services({ outdoorCollision: spy }));
    const n = Math.ceil(hitchLeap / R);
    expect(calls.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(calls[i][0]).toBeCloseTo(s.x + (hitchLeap / n) * i, 9);
      expect(calls[i][2]).toBeCloseTo(hitchLeap / n, 12);
      expect(Math.hypot(calls[i][2], calls[i][3])).toBeLessThanOrEqual(R);
    }
    expect(r.x).toBeCloseTo(s.x + hitchLeap, 9);
  });

  it('a hitch substep can no longer tunnel through a thin post (grounded, airborne, dungeon)', () => {
    const post = { x: BLOCK_X0 + 41.2, z: BLOCK_Z0 + 40, r: 0.2 };
    const minDist = post.r + R;
    // Destination-only testing would land 2.34 m on, clear of the post (1.14 m past it).
    expect(Math.abs(BLOCK_X0 + 40 + hitchLeap - post.x)).toBeGreaterThan(minDist);

    const grounded = stepPlayerMovement(state(), hitchLeap, 0, MAX_QUANTUM,
      services({ outdoorCollision: worldWithPost(post.x, post.z, post.r) }));
    expect(grounded.x).toBeLessThan(post.x - minDist + 1e-6);

    const airborne = stepPlayerMovement(state({ airborne: true, jumpVelocityX: 11.7 }), 0, 0, MAX_QUANTUM,
      services({ outdoorCollision: worldWithPost(post.x, post.z, post.r) }));
    expect(airborne.x).toBeLessThan(post.x - minDist + 1e-6);

    const dungeon = stepPlayerMovement(state({ inDungeon: true }), hitchLeap, 0, MAX_QUANTUM,
      services({ dungeonCollision: worldWithPost(post.x, post.z, post.r) }));
    expect(dungeon.x).toBeLessThan(post.x - minDist + 1e-6);
  });

  it('the collider keeps the largest step-up any transition step resolved (main.ts floor bias reads it)', () => {
    let call = 0;
    const spy: MovementCollider & { lastStepUp: number } = {
      playerRadius: DungeonCollision.PLAYER_RADIUS,
      transitionSphereRadius: R,
      lastStepUp: 0,
      getAdjustedMovement(_pos, dx, dz) { this.lastStepUp = call++ === 1 ? 0.6 : 0; return [dx, dz]; },
    };
    stepPlayerMovement(state(), hitchLeap, 0, MAX_QUANTUM, services({ outdoorCollision: spy }));
    expect(call).toBeGreaterThan(2);
    expect(spy.lastStepUp).toBe(0.6);
  });

  it('DungeonCollision exposes its resolved body-sphere radius as the transition radius', () => {
    expect(new DungeonCollision().transitionSphereRadius).toBe(R);
  });
});

// ── VERIFY.position-drift-beside-fighting-creature.a.a ─────────────────────
// Creatures collide INSIDE the player's transition (ACE FindObjCollisions →
// CylSphere/Sphere.IntersectsSphere → StepSphereUp / SlideSphere,
// Physics/CylSphere.cs:222-295) through the real addCreatureObstacles +
// DungeonCollision, instead of the old post-move radial push-out.

const CREATURE_R = 0.5;
const SHORT_SETUP = 0x0200_0001;
const TALL_SETUP = 0x0200_0002;
const SPHERE_SETUP = 0x0200_0003;

function creatureModel(setupId: number): ObjectPhysicsModel | null {
  const base = { parts: [], hasPhysicsBSP: true, sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 1 } };
  if (setupId === TALL_SETUP) return { ...base, cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: CREATURE_R, height: 1.8 }], spheres: [] };
  if (setupId === SHORT_SETUP) return { ...base, cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: CREATURE_R, height: 0.2 }], spheres: [] };
  if (setupId === SPHERE_SETUP) return { ...base, cylSpheres: [], spheres: [{ origin: { x: 0, y: 0, z: 0.5 }, radius: CREATURE_R }] };
  return null;
}

function blocker(x: number, z: number, setupId = TALL_SETUP, y = 10): CreatureBlocker {
  return { guid: 0x80000001, worldX: x, worldY: y, worldZ: z, collisionRadius: CREATURE_R, setupId, quat: { w: 1, x: 0, y: 0, z: 0 }, scale: 1, physicsState: 0 };
}

/** main.ts's service, over a fixed blocker list. */
function creatureService(blockers: CreatureBlocker[] = []): MovementCreatureObstacles {
  return (collider, x, z, range) => {
    const c = collider as DungeonCollision;
    const near = blockers.filter((b) => Math.hypot(b.worldX - x, b.worldZ - z) <= range);
    const keys = addCreatureObstacles(c, near, creatureModel);
    return () => { for (const k of keys) c.removeKey(k); };
  };
}

/** Walk (dx, dz) per 0.05 s substep, n times; returns every position. */
function walk(s: MovementStepState, dx: number, dz: number, n: number, sv: MovementServices): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = stepPlayerMovement(s, dx, dz, 0.05, sv);
    s.x = r.x; s.z = r.z;
    out.push({ x: r.x, z: r.z });
  }
  return out;
}

describe('stepPlayerMovement — creatures collide inside the transition', () => {
  it('walking straight into a creature stops at contact: never inside the radius sum, never pushed back', () => {
    const s = state();
    const npc = blocker(s.x + 3, s.z);
    const sv = services({ creatureObstacles: creatureService([npc]) });
    const path = walk(s, 0.2, 0, 40, sv);
    const radsum = DungeonCollision.BODY_SPHERE_RADIUS + CREATURE_R; // body sphere vs cylinder (IntersectsSphere)
    for (let i = 0; i < path.length; i++) {
      expect(Math.hypot(path[i].x - npc.worldX, path[i].z - npc.worldZ)).toBeGreaterThanOrEqual(radsum - 0.001);
      if (i > 0) expect(path[i].x).toBeGreaterThanOrEqual(path[i - 1].x); // never moved backward
      expect(path[i].z).toBe(s.z); // head-on: no sideways shove
    }
    const last = path[path.length - 1];
    // Stopped within one step of contact.
    expect(npc.worldX - last.x).toBeLessThan(radsum + 0.2);
  });

  it('a glancing approach slides along the creature and gets past it', () => {
    const s = state();
    const z0 = s.z;
    const npc = blocker(s.x + 3, s.z + 0.4);
    const sv = services({ creatureObstacles: creatureService([npc]) });
    const path = walk(s, 0.2, 0, 60, sv);
    const radsum = DungeonCollision.BODY_SPHERE_RADIUS + CREATURE_R; // body sphere vs cylinder (IntersectsSphere)
    for (const p of path) expect(Math.hypot(p.x - npc.worldX, p.z - npc.worldZ)).toBeGreaterThanOrEqual(radsum - 0.001);
    expect(path[path.length - 1].x).toBeGreaterThan(npc.worldX + 1); // got past
    expect(Math.min(...path.map((p) => p.z))).toBeLessThan(z0); // by sliding round its side
  });

  it('a sphere-shaped creature (drudge-style Setup spheres) stops the walk the same way', () => {
    const s = state();
    const npc = blocker(s.x + 3, s.z, SPHERE_SETUP);
    const sv = services({ creatureObstacles: creatureService([npc]) });
    const path = walk(s, 0.2, 0, 40, sv);
    expect(path[path.length - 1].x).toBeLessThan(npc.worldX - CREATURE_R);
  });

  it('a creature shorter than the step-up height is stepped onto, a tall one is not', () => {
    const s = state();
    const x0 = s.x;
    const sv = services({ creatureObstacles: creatureService([blocker(x0 + 1, s.z, SHORT_SETUP)]) });
    const path = walk(s, 0.2, 0, 15, sv);
    expect(path[path.length - 1].x).toBeGreaterThan(x0 + 2); // walked on over it
    const tall = state();
    const sv2 = services({ creatureObstacles: creatureService([blocker(x0 + 1, tall.z, TALL_SETUP)]) });
    const path2 = walk(tall, 0.2, 0, 15, sv2);
    expect(path2[path2.length - 1].x).toBeLessThan(x0 + 1 - CREATURE_R);
  });

  it('the creature obstacles are gone from the collider after every step', () => {
    const outdoor = new DungeonCollision();
    const s = state();
    const sv = services({ outdoorCollision: outdoor, creatureObstacles: creatureService([blocker(s.x + 3, s.z)]) });
    stepPlayerMovement(s, 0.2, 0, 0.05, sv);
    expect(outdoor.cylinderCount).toBe(0);
  });

  it('in a dungeon the creatures go into the dungeon collider', () => {
    const dungeon = new DungeonCollision();
    const s = state({ inDungeon: true });
    const npc = blocker(s.x + 3, s.z);
    const sv = services({ dungeonCollision: dungeon, creatureObstacles: creatureService([npc]) });
    const path = walk(s, 0.2, 0, 40, sv);
    expect(path[path.length - 1].x).toBeLessThan(npc.worldX - CREATURE_R);
    expect(dungeon.cylinderCount).toBe(0);
  });

  it('a hitch substep (MAX_QUANTUM of running) cannot tunnel through a creature', () => {
    const s = state();
    const npc = blocker(s.x + 1.5, s.z);
    const sv = services({ creatureObstacles: creatureService([npc]) });
    const r = stepPlayerMovement(s, 4 * MAX_QUANTUM * 3, 0, MAX_QUANTUM, sv);
    expect(r.x).toBeLessThan(npc.worldX);
  });

  it('addCreatureObstacles places the cylsphere at the creature frame and scale, LowPoint .. LowPoint + Height', () => {
    const c = new DungeonCollision();
    const b = { ...blocker(100, 200, TALL_SETUP, 5), scale: 2 };
    const keys = addCreatureObstacles(c, [b], creatureModel);
    expect(keys).toEqual(['creature:2147483649:c0']);
    // Blocks a body at the right height and range only.
    const probe = new THREE.Vector3(100 - 2 * CREATURE_R - DungeonCollision.BODY_SPHERE_RADIUS - 0.05, 5, 200);
    expect(c.getAdjustedMovement(probe, 0.1, 0)).toEqual([0, 0]);
    const above = new THREE.Vector3(probe.x, 5 + 2 * 1.8 + 2, 200);
    expect(c.getAdjustedMovement(above, 0.1, 0)).toEqual([0.1, 0]);
  });
});

describe('RELEASE.gdle-npc-use-teleport — server MoveTo motion is collided (stepMoveToMotion)', () => {
  // Retail moves MoveTo-driven motion through CPhysicsObj::UpdateObjectInternal
  // @ 005156b0 like any other: a post in the path stops the walk.
  it('a MoveTo walk into a post stops at the post instead of passing through it', () => {
    const start = state();
    const postX = start.x + 3;
    const svc = services({ outdoorCollision: worldWithPost(postX, start.z, 0.5) });
    // yaw -π/2 heads +X (dirX = -sin(yaw) = 1).
    const steps = Array.from({ length: 30 }, () => MAX_QUANTUM);
    const r = stepMoveToMotion(start, -Math.PI / 2, 4, steps, svc);
    expect(r.x).toBeLessThan(postX - 0.5);
    expect(r.x).toBeGreaterThan(start.x + 1);
    // Without the post the same walk covers its whole distance.
    const free = stepMoveToMotion(start, -Math.PI / 2, 4, steps, services());
    expect(free.x).toBeCloseTo(start.x + 4 * 30 * MAX_QUANTUM, 5);
    expect(free.z).toBeCloseTo(start.z, 5);
  });

  it('airborne, the motion does not move the body (jump momentum does)', () => {
    const r = stepMoveToMotion(state({ airborne: true }), 0, 4, [MAX_QUANTUM], services());
    expect(r).toEqual({ x: state().x, z: state().z });
  });
});
