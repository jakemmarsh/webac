/**
 * RECON.transition-stepup-stepdown-port.a — a body in contact with a terrain
 * face it cannot stand on (Normal.Z < FloorZ) slides down it under gravity:
 * the held keys move nothing (UpdatePositionInternal zeroes the animation
 * offset off a walkable), the gravity offset is projected onto the face
 * (CTransition::adjust_offset), a walkable ends it (HitGround) and three
 * stationary transitions stand the body on a level plane (StationaryStuck).
 * ACE PhysicsObj.cs:1171-1256 / 1834-1875 / 2073 / 2656, Transition.cs:34 / 980-1057.
 *
 * Driven against the real shared TerrainCollision / WaterMap and the outdoor
 * DungeonCollision world main.ts wires in.
 */
import { describe, it, expect } from 'vitest';
import {
  slideStep, bounceVelocity, resolveSlopeContact, initialSlopeContact,
  SLIDE_GRAVITY, MAX_VELOCITY, DEFAULT_ELASTICITY, STATIONARY_STUCK_FRAMES, type Vec3,
} from '../packages/renderer/src/player/SteepSlide.js';
import {
  stepPlayerMovement, stepMoveToMotion, type MovementServices, type MovementStepState,
} from '../packages/renderer/src/player/OutdoorMovement.js';
import { advanceAirborne } from '../packages/renderer/src/world/fallPhysics.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../packages/shared/src/physics/WaterMap.js';

const BX = 10, BY = 10;
const X0 = BX * 192, Z0 = BY * 192;

/** Heights rise 40 m per 24 m column along +X: Normal.Z ≈ 0.51 < FloorZ, downhill is −X. */
function rampTerrain(height: (col: number) => number = (c) => 100 + 40 * c): TerrainCollision {
  const t = new TerrainCollision();
  const heights = Array.from({ length: 81 }, (_, i) => height(Math.floor(i / 9)));
  t.setLandblock(BX, BY, { heights, blockX: BX, blockY: BY });
  return t;
}

function dryWater(): WaterMap {
  const w = new WaterMap();
  w.setLandblock(BX, BY, new Array(256).fill(0));
  return w;
}

function services(terrain: TerrainCollision, outdoor = new DungeonCollision()): MovementServices {
  return {
    dungeonCollision: null,
    outdoorCollision: outdoor,
    terrain,
    water: dryWater(),
    creatureObstacles: null,
    defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS,
    edgeSlide: true,
    stepDownHeight: 1.5,
  };
}

function state(terrain: TerrainCollision, x: number, z: number, slideVelocity: Vec3 | null): MovementStepState {
  return {
    x, z, floorY: terrain.getHeightAt(x, z) ?? 0,
    inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity,
  };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

describe('slideStep — UpdatePhysicsInternal + adjust_offset on an unwalkable plane', () => {
  const t = rampTerrain();
  const n = t.getTriangleNormalAt(X0 + 40, Z0 + 40)!;

  it('the ramp is a face the player cannot stand on', () => {
    expect(n.y).toBeLessThan(TerrainCollision.ACE_FLOOR_Z);
    expect(t.isWalkable(X0 + 40, Z0 + 40)).toBe(false);
  });

  it('from rest the gravity offset lies in the plane and points downhill; velocity gains g·dt', () => {
    const r = slideStep(ZERO, n, 1 / 30);
    expect(dot(r.offset, n)).toBeCloseTo(0, 12);
    expect(r.offset.x).toBeLessThan(0); // downhill is −X
    expect(r.offset.y).toBeLessThan(0);
    expect(r.velocity.y).toBeCloseTo(SLIDE_GRAVITY / 30, 12);
  });

  it('integrated over 1 s the slide covers a frictionless incline: ½·g·Nz·|Nh|·t² downhill', () => {
    let v = ZERO;
    let dx = 0;
    for (let i = 0; i < 60; i++) {
      const r = slideStep(v, n, 1 / 60);
      dx += r.offset.x;
      v = r.velocity;
    }
    const nh = Math.hypot(n.x, n.z);
    expect(-dx).toBeCloseTo(0.5 * 9.8 * n.y * nh, 6);
  });

  it('an offset away from the plane is snapped onto it, keeping its horizontal part', () => {
    const r = slideStep({ x: 0, y: 20, z: 0 }, n, 0.1);
    expect(dot(r.offset, n)).toBeCloseTo(0, 9);
    expect(r.offset.x).toBe(0);
  });

  it('|velocity| is clamped to MaxVelocity before it moves the body', () => {
    const r = slideStep({ x: 0, y: -200, z: 0 }, { x: 0, y: 1, z: 0 }, 0.1);
    expect(r.velocity.y).toBeCloseTo(-MAX_VELOCITY + SLIDE_GRAVITY * 0.1, 9);
  });
});

describe('bounceVelocity — handle_all_collisions', () => {
  it('reflects the into-plane component by the elasticity and leaves the rest', () => {
    const v = bounceVelocity({ x: 3, y: -10, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(v.y).toBeCloseTo(10 * DEFAULT_ELASTICITY, 12);
    expect(v.x).toBe(3);
    expect(v.z).toBe(1);
  });
  it('a velocity leaving the plane is unchanged', () => {
    expect(bounceVelocity({ x: 1, y: 2, z: 3 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('stepPlayerMovement — sliding substeps', () => {
  it('the held keys move nothing: uphill input still slides the body downhill', () => {
    const t = rampTerrain();
    const svc = services(t);
    let s = state(t, X0 + 60, Z0 + 40, ZERO);
    for (let i = 0; i < 60; i++) {
      const r = stepPlayerMovement(s, 0.1 /* uphill input */, 0, 1 / 60, svc);
      expect(r.revertCamera).toBe(true);
      expect(r.slideMoved).toBe(true);
      s = { ...s, x: r.x, z: r.z, slideVelocity: r.slideVelocity! };
    }
    expect(s.x).toBeLessThan(X0 + 60 - 1); // slid over a metre down in 1 s
    expect(s.z).toBeCloseTo(Z0 + 40, 9);
  });

  it('without a slide velocity the same input walks (the existing grounded path)', () => {
    const t = rampTerrain();
    const r = stepPlayerMovement(state(t, X0 + 60, Z0 + 40, null), -0.1, 0, 1 / 60, services(t));
    expect(r.x).toBeCloseTo(X0 + 60 - 0.1, 9);
    expect(r.slideVelocity).toBeUndefined();
  });

  it('a slide stopped by an obstacle is a stationary transition and loses its velocity', () => {
    const t = rampTerrain();
    const world = new DungeonCollision();
    const x = X0 + 60;
    // Touching the post downhill: walls stop the body spheres (BODY_SPHERE_RADIUS).
    world.addCylinderObstacle('test:post', x - DungeonCollision.BODY_SPHERE_RADIUS - 0.5 - 1e-4, Z0 + 40, 0.5);
    const r = stepPlayerMovement(state(t, x, Z0 + 40, { x: 0, y: -5, z: 0 }), 0, 0, 1 / 30, services(t, world));
    expect(r.slideMoved).toBe(false);
    expect(r.slideVelocity).toEqual(ZERO);
    expect(r.x).toBe(x);
  });

  it('a server MoveTo does not walk a sliding body', () => {
    const t = rampTerrain();
    const s = state(t, X0 + 60, Z0 + 40, ZERO);
    expect(stepMoveToMotion(s, 0, 4, [1 / 60, 1 / 60], services(t))).toEqual({ x: s.x, z: s.z });
  });
});

describe('resolveSlopeContact — SetPositionInternal\'s OnWalkable decision', () => {
  const leave = () => ({ x: 1, y: 0, z: 2 });

  it('walkable → unwalkable: LeaveGround with get_leave_ground_velocity', () => {
    const r = resolveSlopeContact(initialSlopeContact(), true, true, leave);
    expect(r.event).toBe('leave');
    expect(r.state.velocity).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('sliding onto a walkable: HitGround, state cleared', () => {
    const r = resolveSlopeContact({ velocity: { x: 0, y: -3, z: 0 }, stationaryFrames: 0, stuck: false }, false, true, leave);
    expect(r.event).toBe('hit');
    expect(r.state).toEqual(initialSlopeContact());
  });

  it('walkable stays walkable with no event', () => {
    expect(resolveSlopeContact(initialSlopeContact(), false, true, leave).event).toBeNull();
  });

  it('the third stationary transition stands the body (StationaryStuck) until it moves again', () => {
    const stuck = resolveSlopeContact(
      { velocity: ZERO, stationaryFrames: STATIONARY_STUCK_FRAMES, stuck: false }, true, false, leave);
    expect(stuck.event).toBe('hit');
    expect(stuck.state).toEqual({ velocity: null, stationaryFrames: 0, stuck: true });
    const still = resolveSlopeContact(stuck.state, true, false, leave);
    expect(still.event).toBeNull();
    expect(still.state.stuck).toBe(true);
    const walked = resolveSlopeContact(still.state, true, true, leave);
    expect(walked.event).toBe('leave');
    expect(walked.state.stuck).toBe(false);
  });

  it('fewer stationary transitions keep the slide', () => {
    const s = { velocity: ZERO, stationaryFrames: STATIONARY_STUCK_FRAMES - 1, stuck: false };
    expect(resolveSlopeContact(s, true, false, leave)).toEqual({ state: s, event: null });
  });
});

describe('the frame loop: a slide ends on the walkable below, or stuck in a crease', () => {
  /** main.ts's per-frame order: substeps, then the OnWalkable decision. */
  function run(t: TerrainCollision, x: number, frames: number) {
    const svc = services(t);
    let contact = resolveSlopeContact(initialSlopeContact(), true, true, () => ZERO).state;
    const events: string[] = ['leave'];
    let px = x;
    for (let f = 0; f < frames; f++) {
      const prevX = px;
      if (contact.velocity) {
        const r = stepPlayerMovement(state(t, px, Z0 + 40, contact.velocity), 0.2, 0, 1 / 60, svc);
        px = r.x;
        contact = {
          ...contact,
          velocity: r.slideVelocity!,
          stationaryFrames: r.slideMoved ? 0 : contact.stationaryFrames + 1,
        };
      }
      const unwalkable = !t.isWalkable(px, Z0 + 40);
      const res = resolveSlopeContact(contact, unwalkable, px !== prevX, () => ZERO);
      contact = res.state;
      if (res.event) events.push(res.event);
      if (!contact.velocity) break;
    }
    return { x: px, contact, events };
  }

  it('a ramp onto a flat valley floor: slides down, then HitGround on the floor', () => {
    // Flat (walkable) for columns 0..2, steep from column 2 up.
    const t = rampTerrain((c) => (c <= 2 ? 100 : 100 + 40 * (c - 2)));
    const r = run(t, X0 + 70, 600);
    expect(r.events).toEqual(['leave', 'hit']);
    expect(r.contact.stuck).toBe(false);
    expect(r.x).toBeLessThanOrEqual(X0 + 48 + 0.5);
    expect(t.isWalkable(r.x, Z0 + 40)).toBe(true);
  });

  it('a V crease between two steep faces: the slide stops and the body stands stuck', () => {
    const t = rampTerrain((c) => 100 + 40 * Math.abs(c - 4));
    const r = run(t, X0 + 60, 600);
    expect(r.events).toEqual(['leave', 'hit']);
    expect(r.contact.stuck).toBe(true);
    expect(Math.abs(r.x - (X0 + 96))).toBeLessThan(2);
  });
});

describe('advanceAirborne — the landing velocity a slide inherits', () => {
  it('reports the vertical velocity at the landing chunk', () => {
    const r = advanceAirborne(10, 0, 0, [0.5], 9, -9.8);
    expect(r.landed).toBe(true);
    expect(r.velocityY).toBe(0);
    expect(r.impactVelocityY).toBeCloseTo(-4.9, 9);
  });
  it('is 0 while still in the air', () => {
    expect(advanceAirborne(10, 0, 5, [0.1], 0, -9.8).impactVelocityY).toBe(0);
  });
});

describe('a concave bend: the gentler face bounces the slide velocity', () => {
  it('crossing from a steep face onto a gentler (still unwalkable) one loses the velocity into the new face', () => {
    // Columns 0..2 rise 30 m per column (gentler, still < FloorZ), 2.. rise 60 m (steeper); downhill is −X.
    const t = rampTerrain((c) => (c <= 2 ? 100 + 30 * c : 160 + 60 * (c - 2)));
    const steep = t.getTriangleNormalAt(X0 + 60, Z0 + 40)!;
    const gentle = t.getTriangleNormalAt(X0 + 40, Z0 + 40)!;
    expect(gentle.y).toBeGreaterThan(steep.y);
    expect(gentle.y).toBeLessThan(TerrainCollision.ACE_FLOOR_Z);
    const v: Vec3 = { x: 0, y: -20, z: 0 };
    const r = stepPlayerMovement(state(t, X0 + 48.05, Z0 + 40, v), 0, 0, 1 / 30, services(t));
    expect(r.x).toBeLessThan(X0 + 48); // crossed the bend
    expect(dot(r.slideVelocity!, gentle)).toBeGreaterThanOrEqual(-1e-9); // no longer into the gentler face
    // On one plane the velocity stays ACE's unprojected gravity accumulation.
    const same = stepPlayerMovement(state(t, X0 + 60, Z0 + 40, v), 0, 0, 1 / 30, services(t));
    expect(same.slideVelocity!.x).toBe(0);
    expect(same.slideVelocity!.y).toBeCloseTo(-20 + SLIDE_GRAVITY / 30, 9);
  });
});
