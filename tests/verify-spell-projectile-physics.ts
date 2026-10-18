/**
 * BUG.spell-projectile-physics — war-magic projectiles "lob / never miss".
 *
 * Found live (tools/probe-spell-projectile.ts, 2026-09-28): ACE DOES send the
 * caster a real SpellProjectile — CreateObject "Flame Bolt", PhysicsState
 * 0x28b48 (Missile | ReportCollisions | AlignPath | PathClipped | LightingOn |
 * ScriptedCollision | Inelastic, no Gravity), velocity (0, 14.98, −0.75) —
 * and on impact SetState 0x128374 (Ethereal | IgnoreCollisions | NoDraw |
 * Cloaked …) + VectorUpdate(0) + (5 s later) DeleteObject. On top of it the
 * client drew an INVENTED bolt (SpellEffects.spawnProjectile from the
 * incantation echo) aimed at the target mesh that "impacted" whenever it
 * passed the target point — it could never miss or be blocked — and Arc
 * spells fell under a fabricated gravity on a straight aim (the lob). The
 * FAITHFUL.218 premise ("the server never broadcasts the projectile") was
 * wrong.
 *
 * Retail: every client flies the server's missile itself with CPhysicsObj —
 * MissilePhysics.ts cites each decompiled routine. These tests drive the
 * shipped modules: the wire parse of omega/elasticity, the pure physics, the
 * ServerObjectManager flight of a CreateObject'd missile, and the collision
 * sweeps it runs against.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BinaryReader, parseCreateObjectFromReader, type CreateObjectData } from '@ac/network';
import { PhysicsState, ItemType, makePlane, sphereIntersectsPoly, sphereIntersectsAnyPoly } from '@ac/shared';
import type { CollisionBSPNode } from '@ac/shared';
import {
  createMissileBody, advanceMissile, stepMissileQuantum, vectorHeadingQuat, grotate, quatRotateV3,
  sweepCylinders, sweepHeightfield, nearestContact, acQuatToThree,
  PHYSICS_GRAVITY, MAX_VELOCITY, MAX_QUANTUM, MIN_QUANTUM, DEFAULT_ELASTICITY,
  type MissileSweep, type V3,
} from '../packages/renderer/src/world/MissilePhysics.js';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';

/** The flags ACE sent for Flame Bolt VI, live. */
const BOLT_STATE = 0x28b48;
const IMPACT_STATE = 0x128374;

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const IDENT = { w: 1, x: 0, y: 0, z: 0 };

/* ── Wire: PhysicsDesc Omega + Elasticity are kept (were read and discarded) ── */

function u32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return Array.from(b); }
function u16(n: number): number[] { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); return Array.from(b); }
function f32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return Array.from(b); }

const PHYS_VELOCITY = 0x4, PHYS_OMEGA = 0x10, PHYS_ELASTICITY = 0x200;

function missilePayload(physFlags: number, fields: number[]): Uint8Array {
  return new Uint8Array([
    ...u32(0x80001441), 0x11, 0, 0, 0,
    ...u32(physFlags), ...u32(BOLT_STATE),
    ...fields,
    ...Array(18).fill(0), 0, 0,
    ...u32(0), ...u16(0), 0, 0, // weenieFlags 0, empty name + align
    ...u16(1636), ...u16(0x10), ...u32(0x0), ...u32(0),
  ]);
}

describe('parseCreateObject — a missile\'s PhysicsDesc omega + elasticity', () => {
  it('reads Elasticity, Velocity and Omega in wire order', () => {
    const d = parseCreateObjectFromReader(new BinaryReader(missilePayload(
      PHYS_ELASTICITY | PHYS_VELOCITY | PHYS_OMEGA,
      [...f32(0.25), ...f32(0), ...f32(14.98), ...f32(-0.75), ...f32(6.2831855), ...f32(0), ...f32(0)],
    )));
    expect(d.physicsState).toBe(BOLT_STATE);
    expect(d.elasticity).toBeCloseTo(0.25, 6);
    expect([d.velocityX, d.velocityY, d.velocityZ].map((x) => +x.toFixed(2))).toEqual([0, 14.98, -0.75]);
    expect(d.omegaX).toBeCloseTo(2 * Math.PI, 5);
    expect(d.omegaY).toBe(0);
    expect(d.weenieClassId).toBe(1636); // fields after the physics block still frame
  });

  it('absent flags: omega 0, elasticity undefined (the client default applies)', () => {
    const d = parseCreateObjectFromReader(new BinaryReader(missilePayload(PHYS_VELOCITY, [...f32(1), ...f32(2), ...f32(3)])));
    expect([d.omegaX, d.omegaY, d.omegaZ]).toEqual([0, 0, 0]);
    expect(d.elasticity).toBeUndefined();
  });
});

/* ── MissilePhysics: CPhysicsObj update_object / UpdatePhysicsInternal ── */

describe('MissilePhysics — flight', () => {
  it('a bolt (no Gravity bit) flies dead straight at its launch velocity', () => {
    const b = createMissileBody({ pos: v(0, 0, 1.2), vel: v(0, 15, 0), orient: IDENT, state: BOLT_STATE });
    for (let i = 0; i < 60; i++) advanceMissile(b, 1 / 60, null);
    expect(b.pos.x).toBeCloseTo(0, 6);
    expect(b.pos.y).toBeCloseTo(15, 4);
    expect(b.pos.z).toBeCloseTo(1.2, 6); // no drop — nothing lobs without the flag
    expect(b.vel).toEqual(v(0, 15, 0));
  });

  it('an arc (Gravity bit) falls under PhysicsGlobals::gravity: z = z0 + vz·t + ½·g·t²', () => {
    const b = createMissileBody({ pos: v(0, 0, 2), vel: v(0, 10, 5), orient: IDENT, state: BOLT_STATE | PhysicsState.Gravity });
    for (let i = 0; i < 30; i++) advanceMissile(b, 1 / 30, null);
    expect(b.pos.z).toBeCloseTo(2 + 5 * 1 + 0.5 * PHYSICS_GRAVITY * 1, 4);
    expect(b.vel.z).toBeCloseTo(5 + PHYSICS_GRAVITY, 4);
    expect(b.pos.y).toBeCloseTo(10, 4);
  });

  it('velocity is clamped to max_velocity (50)', () => {
    const b = createMissileBody({ pos: v(0, 0, 0), vel: v(0, 80, 0), orient: IDENT, state: BOLT_STATE });
    advanceMissile(b, 0.1, null);
    expect(b.vel.y).toBeCloseTo(MAX_VELOCITY, 6);
    expect(b.pos.y).toBeCloseTo(5, 6);
  });

  it('update_object quantisation: >2 s dropped, long frames stepped in MAX_QUANTUM, a ≤MIN_QUANTUM remainder carried', () => {
    const b = createMissileBody({ pos: v(0, 0, 0), vel: v(0, 10, 0), orient: IDENT, state: BOLT_STATE });
    advanceMissile(b, 2.5, null);
    expect(b.pos.y).toBe(0); // HUGE_QUANTUM: the frame is dropped, not teleported through
    advanceMissile(b, MAX_QUANTUM * 2 + MIN_QUANTUM / 2, null);
    expect(b.pos.y).toBeCloseTo(10 * MAX_QUANTUM * 2, 6);
    expect(b.carry).toBeCloseTo(MIN_QUANTUM / 2, 9);
    advanceMissile(b, 0.01, null);
    expect(b.pos.y).toBeCloseTo(10 * (MAX_QUANTUM * 2 + MIN_QUANTUM / 2 + 0.01), 6);
  });

  it('a Hidden missile runs no physics', () => {
    const b = createMissileBody({ pos: v(0, 0, 0), vel: v(0, 10, 0), orient: IDENT, state: BOLT_STATE | PhysicsState.Hidden });
    advanceMissile(b, 0.1, null);
    expect(b.pos).toEqual(v(0, 0, 0));
  });
});

describe('MissilePhysics — orientation', () => {
  it('Frame::set_vector_heading: local +Y points along the direction, no roll', () => {
    for (const dir of [v(0, 1, 0), v(1, 0, 0), v(-3, 4, 0), v(1, 2, 2), v(0, 5, -1)]) {
      const q = vectorHeadingQuat(dir)!;
      const fwd = quatRotateV3(q, v(0, 1, 0));
      const l = Math.hypot(dir.x, dir.y, dir.z);
      expect(fwd.x).toBeCloseTo(dir.x / l, 6);
      expect(fwd.y).toBeCloseTo(dir.y / l, 6);
      expect(fwd.z).toBeCloseTo(dir.z / l, 6);
      expect(quatRotateV3(q, v(1, 0, 0)).z).toBeCloseTo(0, 6); // local X stays level
    }
    expect(vectorHeadingQuat(v(0, 0, 0))).toBeNull();
  });

  it('AlignPath: an arc noses over as it falls', () => {
    const b = createMissileBody({ pos: v(0, 0, 2), vel: v(0, 10, 5), orient: IDENT, state: BOLT_STATE | PhysicsState.Gravity });
    advanceMissile(b, 0.05, null);
    expect(quatRotateV3(b.orient, v(0, 1, 0)).z).toBeGreaterThan(0.3); // climbing
    for (let i = 0; i < 40; i++) advanceMissile(b, 0.05, null);
    expect(quatRotateV3(b.orient, v(0, 1, 0)).z).toBeLessThan(-0.3); // diving
  });

  it('omega spins about the GLOBAL axes (Frame::grotate) when AlignPath is off', () => {
    const b = createMissileBody({
      pos: v(0, 0, 0), vel: v(0, 10, 0), omega: v(0, 0, Math.PI), orient: IDENT,
      state: BOLT_STATE & ~PhysicsState.AlignPath,
    });
    advanceMissile(b, 0.5, null); // a quarter turn about world Z
    const fwd = quatRotateV3(b.orient, v(0, 1, 0));
    expect(fwd.x).toBeCloseTo(-1, 5);
    expect(fwd.y).toBeCloseTo(0, 5);
    // grotate is a pre-multiply: the same axis in a tilted frame still turns about WORLD z.
    const tilted = { w: Math.cos(Math.PI / 4), x: Math.sin(Math.PI / 4), y: 0, z: 0 };
    const r = grotate(tilted, v(0, 0, Math.PI / 2));
    const up = quatRotateV3(r, v(0, 1, 0)); // tilted's +Y is world +Z; a world-Z turn leaves it
    expect(up.z).toBeCloseTo(1, 5);
  });

  it('AC → THREE quaternion uses the CreateObject mapping (−x, −z, −y, w)', () => {
    expect(acQuatToThree({ w: 0.5, x: 0.1, y: 0.2, z: 0.3 })).toEqual([-0.1, -0.3, -0.2, 0.5]);
  });
});

describe('MissilePhysics — contact (handle_all_collisions)', () => {
  const wallAt = (y: number): MissileSweep => (from, to) => {
    if (to.y < y) return null;
    return { t: (y - from.y) / (to.y - from.y), normal: v(0, -1, 0) };
  };

  it('an Inelastic spell projectile stops dead at the wall and drops Missile|AlignPath|PathClipped', () => {
    const b = createMissileBody({ pos: v(0, 0, 1), vel: v(0, 15, 0), orient: IDENT, state: BOLT_STATE, radius: 0.2 });
    let events: ReturnType<typeof advanceMissile> = [];
    for (let i = 0; i < 60 && events.length === 0; i++) events = advanceMissile(b, 1 / 60, wallAt(5));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('environment');
    expect(events[0].playDefaultScript).toBe(false); // env contacts play no script
    expect(b.pos.y).toBeCloseTo(5, 6);
    expect(b.vel).toEqual(v(0, 0, 0));
    expect(b.state & (PhysicsState.Missile | PhysicsState.AlignPath | PhysicsState.PathClipped)).toBe(0);
    for (let i = 0; i < 30; i++) advanceMissile(b, 1 / 60, wallAt(5));
    expect(b.pos.y).toBeCloseTo(5, 6); // stays put — never tunnels on to the target
  });

  it('a non-Inelastic missile reflects with (elasticity + 1)', () => {
    const b = createMissileBody({
      pos: v(0, 0, 1), vel: v(0, 10, 0), orient: IDENT,
      state: BOLT_STATE & ~PhysicsState.Inelastic, radius: 0.2,
    });
    stepMissileQuantum(b, 1, wallAt(5), []);
    expect(b.vel.y).toBeCloseTo(-10 * DEFAULT_ELASTICITY, 6);
  });

  it('an object contact with ReportCollisions + ScriptedCollision asks for the default script', () => {
    const b = createMissileBody({ pos: v(0, 0, 1), vel: v(0, 15, 0), orient: IDENT, state: BOLT_STATE, radius: 0.2 });
    const events = advanceMissile(b, 0.1, () => ({ t: 0.5, normal: v(0, -1, 0), objectGuid: 0x50000001 }));
    expect(events[0]).toMatchObject({ kind: 'object', objectGuid: 0x50000001, playDefaultScript: true });
    const plain = createMissileBody({ pos: v(0, 0, 1), vel: v(0, 15, 0), orient: IDENT, state: BOLT_STATE & ~PhysicsState.ScriptedCollision, radius: 0.2 });
    expect(advanceMissile(plain, 0.1, () => ({ t: 0.5, normal: v(0, -1, 0), objectGuid: 1 }))[0].playDefaultScript).toBe(false);
  });

  it('a Setup with no collision spheres flies with no collision at all (UpdateObjectInternal)', () => {
    const b = createMissileBody({ pos: v(0, 0, 1), vel: v(0, 15, 0), orient: IDENT, state: BOLT_STATE, radius: 0 });
    for (let i = 0; i < 60; i++) advanceMissile(b, 1 / 60, wallAt(5));
    expect(b.pos.y).toBeCloseTo(15, 4);
  });
});

describe('MissilePhysics — sweeps', () => {
  const cyl = { guid: 7, x: 0, y: 10, z: 0, radius: 0.5, height: 1.8 };

  it('sweepCylinders: a bolt into a standing creature contacts its side', () => {
    const c = sweepCylinders(v(0, 0, 1), v(0, 20, 1), 0.2, [cyl])!;
    expect(c.objectGuid).toBe(7);
    expect(0 + 20 * c.t).toBeCloseTo(10 - 0.7, 6);
    expect(c.normal).toEqual(v(0, -1, 0));
  });

  it('sweepCylinders: a creature that stepped aside is missed (no homing)', () => {
    expect(sweepCylinders(v(0, 0, 1), v(0, 20, 1), 0.2, [{ ...cyl, x: 1.5 }])).toBeNull();
  });

  it('sweepCylinders: over the head misses; an arc dropping on top hits the cap', () => {
    expect(sweepCylinders(v(0, 0, 2.5), v(0, 20, 2.5), 0.2, [cyl])).toBeNull();
    const c = sweepCylinders(v(0, 10, 4), v(0, 10, 0), 0.2, [cyl])!;
    expect(c.normal).toEqual(v(0, 0, 1));
    expect(4 - 4 * c.t).toBeCloseTo(1.8 + 0.2, 6);
  });

  it('sweepCylinders: the caster the missile starts inside is exempt', () => {
    expect(sweepCylinders(v(0, 10, 1), v(0, 20, 1), 0.2, [cyl])).toBeNull();
  });

  it('sweepHeightfield: a falling arc stops on the ground; a level bolt above it does not', () => {
    const h = () => 0;
    const n = () => v(0, 0, 1);
    const c = sweepHeightfield(v(0, 0, 1), v(0, 0, -1), 0.25, h, n)!;
    expect(1 - 2 * c.t).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(c.normal).toEqual(v(0, 0, 1));
    expect(sweepHeightfield(v(0, 0, 1), v(0, 20, 1), 0.25, h, n)).toBeNull();
    expect(sweepHeightfield(v(0, 0, 1), v(0, 20, 1), 0.25, () => null, n)).toBeNull(); // unloaded ground
  });

  it('sweepHeightfield: under the terrain inside an interior cell (a cellar, a statue ramp) the land overhead is no contact', () => {
    // Terrain at z 66 over the Holtburg drudge statue's ramp; a level bolt flown 4 m under it.
    const h = () => 66;
    const n = () => v(0, 0, 1);
    const inRamp = (_x: number, y: number) => y >= 0 && y <= 10;
    expect(sweepHeightfield(v(0, 0, 62), v(0, 10, 62), 0.25, h, n, inRamp)).toBeNull();
    // Without the cell (open ground, or the pre-fix sweep) the first step is under the surface.
    expect(sweepHeightfield(v(0, 0, 62), v(0, 10, 62), 0.25, h, n)!.t).toBe(0);
    // A bolt leaving the cell hits the land where it does.
    const c = sweepHeightfield(v(0, 0, 62), v(0, 20, 62), 0.25, h, n, inRamp)!;
    expect(c.t * 20).toBeGreaterThan(9.5);
    expect(c.t * 20).toBeLessThan(10.5);
  });

  it('nearestContact keeps the earlier contact', () => {
    expect(nearestContact({ t: 0.6, normal: null }, { t: 0.2, normal: null, objectGuid: 3 })!.objectGuid).toBe(3);
    expect(nearestContact(null, null)).toBeNull();
  });
});

/* ── Collision sources: floors block missiles (unlike walking), and the DungeonCollision sweep ── */

function quadLeaf(verts: V3[]): CollisionBSPNode {
  return { type: 'LEAF', polygons: [{ vertices: verts, plane: makePlane(verts), numPts: verts.length }] };
}

describe('sphereIntersectsAnyPoly — every polygon a missile moves into, floors included', () => {
  const floor = quadLeaf([v(-5, -5, 0), v(5, -5, 0), v(5, 5, 0), v(-5, 5, 0)]);
  it('the walking test skips a walkable floor; the missile test does not', () => {
    const sphere = { center: v(0, 0, 0.1), radius: 0.2 };
    expect(sphereIntersectsPoly(floor, sphere, v(0, 0, -1))).toBeNull();
    expect(sphereIntersectsAnyPoly(floor, sphere, v(0, 0, -1))).not.toBeNull();
    expect(sphereIntersectsAnyPoly(floor, sphere, v(0, 0, 1))).toBeNull(); // moving away
  });
});

describe('DungeonCollision.sweepSphere — the world a missile hits', () => {
  it('stops at a CylSphere obstacle (tree trunk) in its path, reports the radial normal', () => {
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('tree', 0, 10, 0.5, 0, 6);
    const hit = dc.sweepSphere({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.2, z: 20 }, 0.2)!;
    expect(hit).not.toBeNull();
    expect(20 * hit.t).toBeGreaterThan(8.5);
    expect(20 * hit.t).toBeLessThan(9.4);
    expect(hit.normal.z).toBeCloseTo(-1, 3);
    expect(dc.sweepSphere({ x: 3, y: 1.2, z: 0 }, { x: 3, y: 1.2, z: 20 }, 0.2)).toBeNull();
    expect(dc.sweepSphere({ x: 0, y: 7, z: 0 }, { x: 0, y: 7, z: 20 }, 0.2)).toBeNull(); // over the top
  });

  it('stops at a BSP wall (building/static part) and at a BSP floor', () => {
    const dc = new DungeonCollision();
    // A wall across AC y = 10 (THREE z = 10), facing −y, in landblock (0,0) with an identity frame.
    const wall = quadLeaf([v(-5, 10, 0), v(-5, 10, 5), v(5, 10, 5), v(5, 10, 0)]);
    if (wall.polygons![0].plane.normal.y > 0) wall.polygons![0] = { ...wall.polygons![0], vertices: [...wall.polygons![0].vertices].reverse(), plane: makePlane([...wall.polygons![0].vertices].reverse()) };
    (dc as unknown as { registerCell: (k: string, d: unknown) => void }).registerCell('wall', {
      bsp: wall, floorBounds: null, cellBspRoot: undefined,
      origin: v(0, 0, 0), quat: IDENT, blockOffsetX: 0, blockOffsetY: 0, scale: 1,
    });
    const hit = dc.sweepSphere({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.2, z: 20 }, 0.2)!;
    expect(hit).not.toBeNull();
    expect(20 * hit.t).toBeGreaterThan(9.3);
    expect(20 * hit.t).toBeLessThanOrEqual(9.8);
    expect(hit.normal.z).toBeCloseTo(-1, 5); // AC −y → THREE −z
  });
});

/* ── ServerObjectManager: flies the server's missile, ends it on the server's word ── */

function makeSOM(sphereRadius = 0.2): ServerObjectManager {
  const som = new ServerObjectManager(
    // The bolt (setup 0x02000123) is a sphere; a creature collides by its
    // Setup's CylSpheres (BUG.missile-creature-shape) — one 0.5 x 1.6 here.
    { loadSetupModel: (id: number) => (id === 0x02000123
      ? { spheres: [{ origin: v(0, 0, 0), radius: sphereRadius }], radius: 0.5, height: 1.8 }
      : { cylSpheres: [{ origin: v(0, 0, 0), radius: 0.5, height: 1.6 }], spheres: [], radius: 0.5, height: 1.6 }) } as never,
    {} as never,
    new THREE.Scene(),
  );
  // The DAT mesh build is not under test — any group stands in for the bolt / drudge.
  (som as unknown as { buildMesh: () => THREE.Group }).buildMesh = () => new THREE.Group();
  return som;
}

/** A CreateObject for Flame Bolt as ACE sent it: landblock 0xAAB4 cell 0x0021, heading +Y. */
function boltData(over: Partial<CreateObjectData> = {}): CreateObjectData {
  const base = parseCreateObjectFromReader(new BinaryReader(missilePayload(PHYS_VELOCITY, [...f32(0), ...f32(14.98), ...f32(-0.75)])));
  return {
    ...base, guid: 0x80001441, name: 'Flame Bolt', setupId: 0x02000123, physicsState: BOLT_STATE,
    position: { landblock: 0xAAB40021, x: 50, y: 60, z: 30, rw: 1, rx: 0, ry: 0, rz: 0 },
    ...over,
  } as CreateObjectData;
}

function creature(som: ServerObjectManager, guid: number, worldX: number, worldY: number, worldZ: number): ServerObject {
  const o = {
    guid, name: 'Drudge', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(),
    worldX, worldY, worldZ, collisionRadius: 0.5, collisionHeight: 1.6, cellId: 0x21,
    lerpT: 1, velX: 0, velY: 0, velZ: 0,
  } as unknown as ServerObject;
  (som as unknown as { objects: Map<number, ServerObject> }).objects.set(guid, o);
  return o;
}

describe('ServerObjectManager — the server missile is what flies', () => {
  it('a Missile CreateObject is tracked and flies straight from its server velocity (AC y → THREE z)', () => {
    const som = makeSOM();
    const obj = som.createObject(boltData())!;
    expect(som.isProjectile(obj.guid)).toBe(true);
    const x0 = obj.mesh!.position.x, y0 = obj.mesh!.position.y, z0 = obj.mesh!.position.z;
    for (let i = 0; i < 30; i++) som.updateAnimations(1 / 60);
    expect(obj.mesh!.position.x).toBeCloseTo(x0, 5);
    expect(obj.mesh!.position.z - z0).toBeCloseTo(14.98 * 0.5, 3);
    expect(obj.mesh!.position.y - y0).toBeCloseTo(-0.75 * 0.5, 3); // straight line, no gravity lob
  });

  it('a target that moves away is not chased: the bolt keeps its line through the empty spot', () => {
    const som = makeSOM();
    const obj = som.createObject(boltData({ velocityZ: 0 }))!;
    const drudge = creature(som, 0x50000001, obj.worldX, obj.worldY - 1, obj.worldZ + 6);
    drudge.worldX += 3; // it stepped aside after the launch
    for (let i = 0; i < 60; i++) som.updateAnimations(1 / 60);
    expect(obj.worldX).toBeCloseTo(obj.mesh!.position.x, 9);
    expect(obj.mesh!.position.x).toBeCloseTo(50 + 0xAA * 192, 3); // never bent toward the drudge
    expect(obj.worldZ).toBeGreaterThan(drudge.worldZ + 5); // flew on past
  });

  it('a creature in the path stops it and plays its default script (retail AtkCollision)', () => {
    const som = makeSOM();
    const played: number[] = [];
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    const obj = som.createObject(boltData({ velocityZ: 0 }))!;
    const z0 = obj.worldZ;
    creature(som, 0x50000002, obj.worldX, obj.worldY - 1, z0 + 6);
    for (let i = 0; i < 60; i++) som.updateAnimations(1 / 60);
    // Stopped at the drudge's cylinder (radius 0.5 + bolt sphere 0.2), not 15 m on.
    expect(obj.worldZ - z0).toBeGreaterThan(6 - 0.7 - 0.25);
    expect(obj.worldZ - z0).toBeLessThanOrEqual(6 - 0.7 + 1e-6);
    expect(played).toEqual([obj.guid]);
    expect(som.getMissileBody(obj.guid)!.vel).toEqual(v(0, 0, 0));
  });

  it('the environment sweep main.ts wires stops it at a wall', () => {
    const som = makeSOM();
    som.missileEnvironmentSweep = (from, to) => {
      const wallY = 60 + 0xB4 * 192 + 4;
      if (to.y < wallY) return null;
      return { t: (wallY - from.y) / (to.y - from.y), normal: v(0, -1, 0) };
    };
    const obj = som.createObject(boltData({ velocityZ: 0 }))!;
    for (let i = 0; i < 60; i++) som.updateAnimations(1 / 60);
    expect(obj.worldZ).toBeCloseTo(60 + 0xB4 * 192 + 4, 5);
  });

  it('Gravity rides the state bit: SetState can turn it on mid-flight; the impact SetState hides it', () => {
    const som = makeSOM();
    const obj = som.createObject(boltData({ velocityZ: 0 }))!;
    const y0 = obj.worldY;
    som.setPhysicsState(obj.guid, BOLT_STATE | PhysicsState.Gravity);
    for (let i = 0; i < 30; i++) som.updateAnimations(1 / 60);
    expect(obj.worldY - y0).toBeCloseTo(0.5 * PHYSICS_GRAVITY * 0.25, 2);
    som.setPhysicsState(obj.guid, IMPACT_STATE);
    expect(obj.mesh!.visible).toBe(false);
  });

  it('VectorUpdate(0) — ACE ProjectileImpact — stops it where it is; DeleteObject removes it', () => {
    const som = makeSOM();
    const obj = som.createObject(boltData())!;
    for (let i = 0; i < 6; i++) som.updateAnimations(1 / 60);
    expect(som.applyVectorUpdate(obj.guid, 0, 0, 0)).toBe(true);
    const at = obj.mesh!.position.clone();
    for (let i = 0; i < 30; i++) som.updateAnimations(1 / 60);
    expect(obj.mesh!.position.distanceTo(at)).toBeLessThan(1e-9);
    som.deleteObject(obj.guid);
    expect(som.isProjectile(obj.guid)).toBe(false);
    expect(som.getObject(obj.guid)).toBeUndefined();
  });

  it('the mesh faces along its path (AlignPath) in THREE space', () => {
    const som = makeSOM();
    const obj = som.createObject(boltData({ velocityX: 10, velocityY: 0, velocityZ: 0 }))!;
    som.updateAnimations(1 / 60);
    // Mesh-local +Z is AC local +Y (the same axis swap as positions): it must point along world +X.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.mesh!.quaternion);
    expect(fwd.x).toBeCloseTo(1, 5);
  });
});
