/**
 * VERIFY.spell-projectile-arc-ring-dungeon — the projectile cases the
 * BUG.spell-projectile-physics pass had not flown live: an Arc (Gravity), a
 * Ring, a wall / volley / blast, a streak, and missiles inside a dungeon.
 *
 * tools/probe-spell-projectile.ts (2026-09-28, plantprobe, ACE local) flew
 * them all: every client stop matched the server's SetState within 6–65 ms
 * (arc hit, 35 m lob, streak, blast, volley, ring range-outs, dungeon walls
 * in four headings). Two divergences from the retail client surfaced and are
 * fixed here:
 *
 *  1. Missiles collided only with CREATURES. Retail CObjCell::
 *     find_obj_collisions runs CPhysicsObj::FindObjCollisions on every
 *     un-parented object in the cell (0052b750); a closed dungeon door
 *     (`door` 0x0200024F, HasPhysicsBSP) stopped our bolt only when the
 *     server's SetState arrived. Which objects obstruct, and how, now follows
 *     FindObjCollisions @ 0050f050 / OBJECTINFO::missile_ignore @ 0050ceb0 /
 *     report_object_collision @ 00513060 (MissilePhysics.
 *     classifyMissileObstacle); the object's own Setup collision comes from
 *     ObjectCollision.createServerObjectMissileSweep.
 *  2. Our own character was not in the sweep: a monster's Throwing Axe or
 *     Lightning Bolt flew through us until the server's DeleteObject /
 *     SetState. ServerObjectManager.missileLocalPlayer puts our cylinder in.
 *
 * Live numbers below are the probe's (THREE world: x, y = height, z).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, parseCreateObjectFromReader, type CreateObjectData } from '@ac/network';
import { PhysicsState, ItemType, makePlane } from '@ac/shared';
import type { CollisionBSPNode } from '@ac/shared';
import {
  classifyMissileObstacle, applyObstacleKind, createMissileBody, stepMissileQuantum, sweepSpheres,
  type MissileCollisionEvent, type V3,
} from '../packages/renderer/src/world/MissilePhysics.js';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { createServerObjectMissileSweep, type ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

/** Flame Bolt VI / Flame Arc VI / Cassius' Ring of Fire, as ACE sent them live. */
const BOLT_STATE = 0x28b48;
const ARC_STATE = 0x28f48; // + Gravity (0x400)
const RING_STATE = 0x20b48; // no ScriptedCollision (SpellProjectile.Setup: rings)
/** The closed `door` (wcid 278) in the Holtburg Dungeon: ReportCollisions | IgnoreCollisions | HasPhysicsBSP. */
const DOOR_STATE = 0x10018;
const PLAYER_GUID = 0x50000009;

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

function u32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return Array.from(b); }
function u16(n: number): number[] { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); return Array.from(b); }
function f32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return Array.from(b); }

/** A missile CreateObject (PhysicsDesc velocity only) framed like ACE's. */
function missileData(guid: number, state: number, thx: number, thy: number, thz: number, acVel: V3): CreateObjectData {
  const payload = new Uint8Array([
    ...u32(guid), 0x11, 0, 0, 0,
    ...u32(0x4), ...u32(state),
    ...f32(acVel.x), ...f32(acVel.y), ...f32(acVel.z),
    ...Array(18).fill(0), 0, 0,
    ...u32(0), ...u16(0), 0, 0,
    ...u16(1636), ...u16(0x10), ...u32(0x0), ...u32(0),
  ]);
  const base = parseCreateObjectFromReader(new BinaryReader(payload));
  const lbX = Math.floor(thx / 192), lbY = Math.floor(thz / 192);
  return {
    ...base, guid, name: 'Flame Bolt', setupId: 0x02000123, physicsState: state,
    position: { landblock: ((lbX << 24) | (lbY << 16) | 0x21) >>> 0, x: thx - lbX * 192, y: thz - lbY * 192, z: thy, rw: 1, rx: 0, ry: 0, rz: 0 },
  } as CreateObjectData;
}

/**
 * The Drudge Skulker's Setup 0x020007dd (portal DAT): no CylSpheres, two
 * spheres r 0.436 at z 0.4325 / 1.09 (bounding radius 0.617, height 1.53).
 * Its weenie scales it 0.95 (wcid 7 / 5595 / 19257, PropertyFloat 39).
 */
const DRUDGE_SETUP = 0x020007dd;
const DRUDGE_SPHERES = [{ origin: v(0, 0, 0.4325), radius: 0.436 }, { origin: v(0, 0, 1.09), radius: 0.436 }];

function makeSOM(sphereRadius: number): ServerObjectManager {
  const som = new ServerObjectManager(
    { loadSetupModel: (id: number) => (id === DRUDGE_SETUP
      ? { cylSpheres: [], spheres: DRUDGE_SPHERES, radius: 0.617, height: 1.53 }
      : { spheres: [{ origin: v(0, 0, 0), radius: sphereRadius }], radius: 0.5, height: 1.8 }) } as never,
    {} as never,
    new THREE.Scene(),
  );
  (som as unknown as { buildMesh: () => THREE.Group }).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(PLAYER_GUID);
  return som;
}

/** Put a world object straight into the objects map (THREE world position). */
function place(som: ServerObjectManager, over: Partial<ServerObject> & { guid: number; worldX: number; worldY: number; worldZ: number }): ServerObject {
  const o = {
    name: 'Thing', itemType: 0, physicsState: 0, mesh: new THREE.Group(), setupId: 0x02000999,
    collisionRadius: 0, collisionHeight: 0, cellId: 0x21, wielderId: 0,
    lerpT: 1, velX: 0, velY: 0, velZ: 0, ...over,
  } as unknown as ServerObject;
  o.mesh!.position.set(o.worldX, o.worldY, o.worldZ);
  (som as unknown as { objects: Map<number, ServerObject> }).objects.set(o.guid, o);
  return o;
}

/** A single upright CylSphere Setup (radius, height) — FindObjCollisions' cylsphere branch. */
const cylModel = (radius: number, height: number): ObjectPhysicsModel => ({
  parts: [], hasPhysicsBSP: false, cylSpheres: [{ origin: v(0, 0, 0), radius, height }], spheres: [],
  sortingSphere: { origin: v(0, 0, height / 2), radius: Math.max(radius, height / 2) },
});

const fly = (som: ServerObjectManager, seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) som.updateAnimations(1 / 60); };

/* ── Which objects obstruct a missile, and as what ── */

describe('classifyMissileObstacle — FindObjCollisions / missile_ignore / report_object_collision', () => {
  it('missiles never hit missiles; ethereal objects never stop one', () => {
    expect(classifyMissileObstacle(BOLT_STATE, BOLT_STATE)).toBe('ignore');
    expect(classifyMissileObstacle(PhysicsState.Ethereal, BOLT_STATE)).toBe('ignore');
    expect(classifyMissileObstacle(PhysicsState.Ethereal | PhysicsState.Static, BOLT_STATE)).toBe('ignore');
  });

  it('a Static object — or one that ReportCollisionsAsEnvironment — is an environment collision', () => {
    expect(classifyMissileObstacle(PhysicsState.Static, BOLT_STATE)).toBe('environment');
    expect(classifyMissileObstacle(PhysicsState.ReportCollisionsAsEnvironment, BOLT_STATE)).toBe('environment');
  });

  it('IgnoreCollisions stops the missile silently; anything else solid is an object collision', () => {
    expect(classifyMissileObstacle(DOOR_STATE, BOLT_STATE)).toBe('object-silent');
    expect(classifyMissileObstacle(0x408 /* a live Undead */, BOLT_STATE)).toBe('object');
    expect(classifyMissileObstacle(0, BOLT_STATE)).toBe('object');
  });

  it('a spent (Ethereal) missile passes through objects but still stops on a Static one', () => {
    const spent = 0x128374; // ACE ProjectileImpact SetState
    expect(classifyMissileObstacle(0, spent)).toBe('ignore');
    expect(classifyMissileObstacle(PhysicsState.Static, spent)).toBe('environment');
  });

  it('applyObstacleKind tags the contact (environment drops the guid; silent flags it)', () => {
    const c = { t: 0.5, normal: v(0, -1, 0) };
    expect(applyObstacleKind(c, 'ignore', 7)).toBeNull();
    expect(applyObstacleKind(c, 'environment', 7)).toEqual(c);
    expect(applyObstacleKind(c, 'object', 7)).toEqual({ ...c, objectGuid: 7 });
    expect(applyObstacleKind(c, 'object-silent', 7)).toEqual({ ...c, objectGuid: 7, silent: true });
    expect(applyObstacleKind(null, 'object', 7)).toBeNull();
  });

  it('a silent (IgnoreCollisions) hit stops an inelastic missile but keeps its Missile bits and reports nothing', () => {
    const b = createMissileBody({ pos: v(0, 0, 1), vel: v(0, 15, 0), orient: { w: 1, x: 0, y: 0, z: 0 }, state: BOLT_STATE, radius: 0.1 });
    const events: MissileCollisionEvent[] = [];
    stepMissileQuantum(b, 0.1, () => ({ t: 0.5, normal: v(0, -1, 0), objectGuid: 9, silent: true }), events);
    expect(events).toHaveLength(1);
    expect(events[0].playDefaultScript).toBe(false);
    expect(b.state & PhysicsState.Missile).toBe(PhysicsState.Missile);
    expect(b.vel).toEqual(v(0, 0, 0));
  });
});

/* ── Non-creature server objects in the missile's path ── */

describe('ServerObjectManager — a missile vs the other weenie objects in the cell', () => {
  const X = 0xA9 * 192 + 100, Y = 5, Z = 0xB4 * 192 + 50;
  function launch(som: ServerObjectManager, played: number[]): ServerObject {
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    som.missileObjectSweep = createServerObjectMissileSweep(() => cylModel(0.6, 3)).sweep;
    return som.createObject(missileData(0x80000100, BOLT_STATE, X, Y, Z, v(0, 15, 0)))!;
  }

  it('a closed door (IgnoreCollisions + HasPhysicsBSP) stops the bolt at its collision, silently', () => {
    const som = makeSOM(0.1);
    const played: number[] = [];
    const bolt = launch(som, played);
    place(som, { guid: 0x701f6011, name: 'Door', itemType: ItemType.Misc, physicsState: DOOR_STATE, worldX: X, worldY: Y - 1, worldZ: Z + 4 });
    fly(som, 1);
    expect(bolt.worldZ).toBeGreaterThan(Z + 4 - 0.7 - 0.25);
    expect(bolt.worldZ).toBeLessThanOrEqual(Z + 4 - 0.7 + 1e-6);
    expect(played).toEqual([]); // report_object_collision returns before the attack profile
    expect(som.getMissileBody(bolt.guid)!.state & PhysicsState.Missile).toBe(PhysicsState.Missile);
  });

  it('a solid chest plays the missile\'s collision script (AtkCollisionProfile) and clears its Missile bits', () => {
    const som = makeSOM(0.1);
    const played: number[] = [];
    const bolt = launch(som, played);
    place(som, { guid: 0x701f6012, name: 'Chest', itemType: ItemType.Container, physicsState: PhysicsState.ReportCollisions, worldX: X, worldY: Y - 1, worldZ: Z + 4 });
    fly(som, 1);
    expect(bolt.worldZ).toBeLessThan(Z + 4);
    expect(played).toEqual([bolt.guid]);
    expect(som.getMissileBody(bolt.guid)!.state & PhysicsState.Missile).toBe(0);
  });

  it('a Static object is an environment contact: stops, no script', () => {
    const som = makeSOM(0.1);
    const played: number[] = [];
    const bolt = launch(som, played);
    place(som, { guid: 0x701f6013, name: 'Statue', physicsState: PhysicsState.Static, worldX: X, worldY: Y - 1, worldZ: Z + 4 });
    fly(som, 1);
    expect(bolt.worldZ).toBeLessThan(Z + 4);
    expect(played).toEqual([]);
  });

  it('an open (Ethereal) door, another missile and a wielded item do not obstruct', () => {
    const som = makeSOM(0.1);
    const played: number[] = [];
    const bolt = launch(som, played);
    place(som, { guid: 0x701f6014, name: 'Door', physicsState: DOOR_STATE | PhysicsState.Ethereal, worldX: X, worldY: Y - 1, worldZ: Z + 3 });
    place(som, { guid: 0x80000200, name: 'Flame Bolt', physicsState: BOLT_STATE, worldX: X, worldY: Y - 1, worldZ: Z + 5 });
    place(som, { guid: 0x80000201, name: 'Sword', physicsState: 0, wielderId: 0x80000300, worldX: X, worldY: Y - 1, worldZ: Z + 7 });
    fly(som, 1);
    expect(bolt.worldZ).toBeGreaterThan(Z + 14);
    expect(played).toEqual([]);
  });
});

/* ── Our own character ── */

describe('ServerObjectManager — a monster missile stops at our character locally', () => {
  // The live door-room fight: an Undead's Lightning Bolt (radius 0.15) at
  // (299.87, −16.78, 47023.75), AC velocity (13.71, −6.08, 0.08); we stood
  // at (302.00, −18, 47022.80).
  const me = { x: 302.0, z: 47022.8, feet: -18, radius: 0.48, height: 1.8 };
  function lightning(som: ServerObjectManager): ServerObject {
    return som.createObject(missileData(0x800003f0, BOLT_STATE, 299.87, -16.78, 47023.75, v(13.71, -6.08, 0.08)))!;
  }

  it('without our cylinder the bolt flies through us (the pre-fix client)', () => {
    const som = makeSOM(0.15);
    const bolt = lightning(som);
    fly(som, 0.5);
    expect(bolt.worldX).toBeGreaterThan(me.x + 3);
  });

  it('with it, the bolt stops at our cylinder and plays its collision script', () => {
    const som = makeSOM(0.15);
    const played: number[] = [];
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    som.missileLocalPlayer = () => ({ x: me.x, y: me.z, z: me.feet, radius: me.radius, height: me.height });
    const bolt = lightning(som);
    fly(som, 0.5);
    const gap = Math.hypot(bolt.worldX - me.x, bolt.worldZ - me.z);
    expect(gap).toBeGreaterThan(me.radius + 0.15 - 0.3);
    expect(gap).toBeLessThanOrEqual(me.radius + 0.15 + 1e-6);
    expect(played).toEqual([bolt.guid]);
    // The live stop: (301.24, −16.78, 47023.14), 20–40 ms before the server's SetState.
    expect(bolt.worldX).toBeCloseTo(301.24, 0);
  });

  it('a spent missile (the server\'s Ethereal impact SetState) no longer collides with us', () => {
    const som = makeSOM(0.15);
    const played: number[] = [];
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    som.missileLocalPlayer = () => ({ x: me.x, y: me.z, z: me.feet, radius: me.radius, height: me.height });
    const bolt = lightning(som);
    som.setPhysicsState(bolt.guid, 0x128374);
    fly(som, 0.5);
    expect(bolt.worldX).toBeGreaterThan(me.x + 3);
    expect(played).toEqual([]);
  });

  it('our own bolt leaving our cylinder is not stopped by it', () => {
    const som = makeSOM(0.1);
    som.missileLocalPlayer = () => ({ x: me.x, y: me.z, z: me.feet, radius: me.radius, height: me.height });
    // ACE spawns it radsum = our radius + its radius ahead (CalculateProjectileOrigins).
    const bolt = som.createObject(missileData(0x80000101, BOLT_STATE, me.x, -16.78, me.z + me.radius + 0.1, v(0, 15, 0)))!;
    fly(som, 0.5);
    expect(bolt.worldZ - me.z).toBeGreaterThan(7);
  });
});

/* ── Arc: gravity lob, replayed from the live 35 m cast ── */

describe('Flame Arc VI — the server\'s ballistic solution, flown with gravity, lands on the drudge', () => {
  it('lobs under −9.8 and stops on the drudge where the server said it hit', () => {
    const som = makeSOM(0.1);
    // Live: CreateObject at (32624.46, 43.42, 34744.21), state 0x28f48, AC
    // velocity (0, 40, −3.46); Drudge Skulker at (32624.46, 35.77, 34778.06),
    // cylinder r 0.62 h 1.53. Our local contact (32624.46, 37.19, 34777.34);
    // the server's SetState came 65 ms later with the bolt parked there.
    const arc = som.createObject(missileData(0x800008d0, ARC_STATE, 32624.46, 43.42, 34744.21, v(0, 40, -3.46)))!;
    const drudge = place(som, {
      guid: 0x800008cc, name: 'Drudge Skulker', itemType: ItemType.Creature, physicsState: 0x408, setupId: DRUDGE_SETUP,
      worldX: 32624.46, worldY: 35.77, worldZ: 34778.06, collisionRadius: 0.62, collisionHeight: 1.53,
    });
    drudge.mesh!.scale.setScalar(0.95);
    const played: number[] = [];
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    fly(som, 1.5);
    // BUG.missile-creature-shape — it stops on one of the drudge's Setup
    // spheres x 0.95 (FindObjCollisions → CSphere::intersects_sphere), not
    // on the 0.62 bounding cylinder the pre-fix sweep used: the bolt's
    // centre sits r_sphere x 0.95 + 0.1 from a sphere centre, in front of it.
    const gap = Math.min(...DRUDGE_SPHERES.map((sp) => Math.hypot(
      arc.worldX - drudge.worldX, arc.worldY - (drudge.worldY + sp.origin.z * 0.95), arc.worldZ - drudge.worldZ)));
    expect(gap).toBeCloseTo(0.436 * 0.95 + 0.1, 2);
    expect(arc.worldZ).toBeLessThan(drudge.worldZ);
    // Gravity, not a straight line: the no-gravity line would be at 40.55 there.
    const straight = 43.42 - 3.46 * ((arc.worldZ - 34744.21) / 40);
    expect(straight - arc.worldY).toBeGreaterThan(3);
    expect(played).toEqual([arc.guid]);
  });

  it('an untargeted arc fired level onto a dungeon floor lands on it (cell BSP floor, normal up)', () => {
    const som = makeSOM(0.1);
    const dc = new DungeonCollision();
    // A 60 m floor at height 0 (AC z = 0), one polygon, identity frame.
    const floorVerts = [v(200, 47190, 0), v(320, 47190, 0), v(320, 47250, 0), v(200, 47250, 0)];
    let plane = makePlane(floorVerts);
    const verts = plane.normal.z > 0 ? floorVerts : [...floorVerts].reverse();
    plane = makePlane(verts);
    const leaf: CollisionBSPNode = { type: 'LEAF', polygons: [{ vertices: verts, plane, numPts: 4 }] };
    (dc as unknown as { registerCell: (k: string, d: unknown) => void }).registerCell('floor', {
      bsp: leaf, floorBounds: null, cellBspRoot: undefined,
      origin: v(0, 0, 0), quat: { w: 1, x: 0, y: 0, z: 0 }, blockOffsetX: 0, blockOffsetY: 0, scale: 1,
    });
    // main.ts's in-dungeon branch: the dungeon cells' sweep, AC ↔ THREE axes.
    som.missileEnvironmentSweep = (from, to, r) => {
      const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
      return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
    };
    // Live dungeon arc: spawned at (287.54, 1.84, 47222), AC velocity (−40, 0, 0).
    const arc = som.createObject(missileData(0x80000901, ARC_STATE, 287.54, 1.84, 47222, v(-40, 0, 0)))!;
    fly(som, 1.5);
    expect(arc.worldY).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(arc.worldY).toBeLessThan(0.1 + 0.35);
    // ½·9.8·t² = 1.74 → t ≈ 0.6 s → ~23.8 m west.
    expect(287.54 - arc.worldX).toBeGreaterThan(22);
    expect(287.54 - arc.worldX).toBeLessThan(25);
    expect(som.getMissileBody(arc.guid)!.vel).toEqual(v(0, 0, 0));
    // A level bolt (no Gravity) over the same floor never touches it.
    const bolt = som.createObject(missileData(0x80000902, BOLT_STATE, 287.54, 1.23, 47222, v(-15, 0, 0)))!;
    fly(som, 1.5);
    expect(bolt.worldY).toBeCloseTo(1.23, 5);
    expect(287.54 - bolt.worldX).toBeGreaterThan(20);
  });
});

/* ── Ring: nine projectiles in a circle ── */

describe("Cassius' Ring of Fire — nine server missiles fly straight out from the caster", () => {
  it('none hits the caster or a sibling; each keeps its own radial velocity', () => {
    const som = makeSOM(0.2);
    // Live create positions (x, z) and AC velocities (y height 34.17): ACE
    // spawns them at 0.6 · radsum around the caster; the 180° slot twice.
    const ring: [number, number, number, number][] = [
      [32630.46, 34774.77, 0, 2], [32629.88, 34774.53, -1.41, 1.41], [32631.04, 34774.53, 1.41, 1.41],
      [32629.64, 34773.95, -2, 0], [32631.28, 34773.95, 2, 0], [32629.88, 34773.37, -1.41, -1.41],
      [32631.04, 34773.37, 1.41, -1.41], [32630.46, 34773.13, 0, -2], [32630.46, 34773.13, 0, -2],
    ];
    som.missileLocalPlayer = () => ({ x: 32630.46, y: 34773.95, z: 32.77, radius: 0.48, height: 1.8 });
    const played: number[] = [];
    som.onMissileDefaultScript = (o) => played.push(o.guid);
    const objs = ring.map(([x, z, vx, vy], i) => som.createObject(missileData(0x80000756 + i, RING_STATE, x, 34.17, z, v(vx, vy, 0)))!);
    fly(som, 2);
    objs.forEach((o, i) => {
      const [x, z, vx, vy] = ring[i];
      expect(o.worldX).toBeCloseTo(x + vx * 2, 1);
      expect(o.worldZ).toBeCloseTo(z + vy * 2, 1);
      expect(o.worldY).toBeCloseTo(34.17, 5); // no Gravity bit
    });
    expect(played).toEqual([]);
  });
});

describe('sweepCylinders — a missile born overlapping a creature (CCylSphere::intersects_sphere has no start exemption)', () => {
  const drudge = { guid: 0x80000372, x: 0, y: 1, z: 0, radius: 0.62, height: 1.53 };
  it('heading into it: contact at once (live: the ring missile the server stopped 136 ms after launch)', async () => {
    const { sweepCylinders } = await import('../packages/renderer/src/world/MissilePhysics.js');
    const c = sweepCylinders(v(0, 0.5, 1), v(0, 0.53, 1), 0.2, [drudge])!;
    expect(c.t).toBe(0);
    expect(c.objectGuid).toBe(drudge.guid);
    expect(c.normal).toEqual(v(0, -1, 0));
  });
  it('heading out of it (leaving the body it grazes): passes', async () => {
    const { sweepCylinders } = await import('../packages/renderer/src/world/MissilePhysics.js');
    expect(sweepCylinders(v(0, 0.5, 1), v(0, 0.47, 1), 0.2, [drudge])).toBeNull();
  });
});

/* ── The real door (DAT) ── */

describe.skipIf(!existsSync(PORTAL))('Holtburg Dungeon `door` 0x0200024F — its part BSP stops a bolt (DAT)', () => {
  let sweep: ReturnType<typeof createServerObjectMissileSweep>['sweep'];
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { resolveObjectPhysics } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const portalDb = openDat(PORTAL);
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    sweep = createServerObjectMissileSweep((id) => resolveObjectPhysics(id, src)).sweep;
  });

  // Live: the door at THREE (302, −18, 47026.76), identity rotation; our bolt
  // at height −16.78 heading north stopped at z 47025.79–47025.91.
  const door = { guid: 0x701f6011, setupId: 0x0200024f, worldX: 302, worldY: -18, worldZ: 47026.76, mesh: new THREE.Group() };

  it('a bolt heading north at the door leaf contacts it just short of the door origin', () => {
    const c = sweep(door, v(302, 47024.17, -16.78), v(302, 47028.17, -16.78), 0.1)!;
    expect(c).not.toBeNull();
    const y = 47024.17 + 4 * c.t;
    expect(y).toBeGreaterThan(47025.3);
    expect(y).toBeLessThan(47026.76);
    expect(Math.abs(c.normal.y)).toBeGreaterThan(0.4); // faces back down the corridor
  });

  it('a bolt passing 3 m to the side misses it', () => {
    expect(sweep(door, v(305.5, 47024.17, -16.78), v(305.5, 47028.17, -16.78), 0.1)).toBeNull();
  });
});

/* ── BUG.missile-creature-shape — creatures by their Setup spheres × scale ── */

describe('a missile against a creature\'s own Setup shapes', () => {
  it('sweepSpheres: first entry along the move, a start overlap only stops an inward move', () => {
    const s = [{ guid: 7, x: 0, y: 5, z: 1, radius: 0.4 }];
    const hit = sweepSpheres(v(0, 0, 1), v(0, 10, 1), 0.1, s)!;
    expect(hit.t * 10).toBeCloseTo(5 - 0.5, 5);
    expect(hit.normal!.y).toBeCloseTo(-1, 5);
    expect(hit.objectGuid).toBe(7);
    expect(sweepSpheres(v(1, 0, 1), v(1, 10, 1), 0.1, s)).toBeNull(); // passes beside it
    expect(sweepSpheres(v(0, 4.8, 1), v(0, 4.9, 1), 0.1, s)!.t).toBe(0); // inside, heading in
    expect(sweepSpheres(v(0, 4.8, 1), v(0, 4.7, 1), 0.1, s)).toBeNull(); // inside, heading out
  });

  it('a scaled creature is bigger: its spheres grow with its ObjScale', () => {
    const contactZ = (scale: number) => {
      const som = makeSOM(0.1);
      const bolt = som.createObject(missileData(0x80000901, BOLT_STATE, 32624.46, 36.8, 34770, v(0, 15, 0)))!;
      const d = place(som, { guid: 0x800009cc, itemType: ItemType.Creature, setupId: DRUDGE_SETUP, worldX: 32624.46, worldY: 35.77, worldZ: 34778.06, collisionRadius: 0.62, collisionHeight: 1.53 });
      d.mesh!.scale.setScalar(scale);
      fly(som, 1);
      return d.worldZ - bolt.worldZ;
    };
    expect(contactZ(1.8)).toBeGreaterThan(contactZ(1) + 0.2);
  });
});
