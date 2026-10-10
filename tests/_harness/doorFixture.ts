/**
 * A server door for collision tests (BUG.door-collision-static-pose-no-hold):
 * a real ServerObjectManager object built by createObject with an initial
 * motion blob, animated by its real MotionManager, posed for collision by
 * getBlockersNear → addCreatureObstacles → DungeonCollision, as main.ts
 * does every movement step.
 *
 * Two door sources: a synthetic one (bytes for a MotionTable and an
 * Animation shaped like retail's door table 0x09000202 / animation
 * 0x03000C20, plus a one-part slab GfxObj) that runs in CI, and the real
 * DAT door (Setup 0x020019FF), opened by the caller inside beforeAll.
 */
import * as THREE from 'three';
import { makePlane, PhysicsState, type PhysicsPolygon } from '@ac/shared';
import { parseMovementData, type CreateObjectData } from '@ac/network';
import { ServerObjectManager } from '../../packages/renderer/src/world/ServerObjectManager.js';
import { addCreatureObstacles } from '../../packages/renderer/src/world/CreatureCollision.js';
import { DungeonCollision } from '../../packages/renderer/src/world/DungeonCollision.js';
import type { ObjectPhysicsModel } from '../../packages/renderer/src/world/ObjectCollision.js';
import { MotionCommand, MotionStance } from '../../packages/renderer/src/animation/MotionCommands.js';

export const NONCOMBAT = MotionStance.NonCombat >>> 0; // 0x8000003D
export const ON = MotionCommand.On >>> 0; // 0x4000000B
export const OFF = MotionCommand.Off >>> 0; // 0x4000000C
/** A closed ACE door: HasPhysicsBSP | ReportCollisions. */
export const DOOR_STATE = PhysicsState.HasPhysicsBSP | PhysicsState.ReportCollisions; // 0x10008

class Bytes {
  private out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.out.push(...b); return this; }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.out.push(...b); return this; }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.out.push(...b); return this; }
  pad4() { while (this.out.length % 4) this.out.push(0); return this; }
  done(): Uint8Array { return new Uint8Array(this.out); }
}

// ── the synthetic door ──────────────────────────────────────────────

export const SYN_SETUP = 0x02000f01;
export const SYN_TABLE = 0x09000f01;
export const SYN_ANIM = 0x03000f01;
export const SYN_FRAMES = 10;
/** The leaf swings this far about its hinge (the part origin) at the last frame. */
export const SYN_OPEN_ANGLE = Math.PI / 2;

/**
 * The open/close animation: one part, frame i turns it SYN_OPEN_ANGLE·i/(n−1)
 * about AC +Z; frame 1 carries Ethereal(1) forward and Ethereal(0)
 * backward, as 0x03000C20 does.
 */
function synAnimationBytes(): Uint8Array {
  const b = new Bytes().u32(SYN_ANIM).u32(0).u32(1).u32(SYN_FRAMES);
  for (let i = 0; i < SYN_FRAMES; i++) {
    const half = (SYN_OPEN_ANGLE * i) / (SYN_FRAMES - 1) / 2;
    b.f32(0).f32(0).f32(0).f32(Math.cos(half)).f32(0).f32(0).f32(Math.sin(half));
    if (i === 1) b.u32(2).u32(6).i32(1).i32(1).u32(6).i32(-1).i32(0);
    else b.u32(0);
  }
  return b.done();
}

/**
 * The door table, shaped like 0x09000202: NonCombat defaults to Off; cycle
 * On holds the last frame, cycle Off the first; Off→On plays the animation
 * forward at 30 fps, On→Off backward.
 */
function synMotionTableBytes(): Uint8Array {
  const key = (motion: number) => (((NONCOMBAT & 0xffff) << 16) | (motion & 0xffff)) >>> 0;
  const motion = (b: Bytes, low: number, rate: number) => b.u8(1).u8(0).u8(0).pad4().u32(SYN_ANIM).i32(low).i32(-1).f32(rate);
  const b = new Bytes().u32(SYN_TABLE).u32(NONCOMBAT).u32(1).u32(NONCOMBAT).u32(OFF);
  b.u32(2);
  motion(b.u32(key(ON)), SYN_FRAMES - 1, 0);
  motion(b.u32(key(OFF)), 0, 0);
  b.u32(0); // modifiers
  b.u32(2); // links
  motion(b.u32(key(ON)).u32(1).u32(OFF), 0, -30);
  motion(b.u32(key(OFF)).u32(1).u32(ON), 0, 30);
  return b.done();
}

/** The synthetic portal: just the door table and its animation. */
export function synPortal(): { getFileData(id: number): ArrayBuffer | null } {
  const files = new Map<number, Uint8Array>([[SYN_TABLE, synMotionTableBytes()], [SYN_ANIM, synAnimationBytes()]]);
  return { getFileData: (id) => files.get(id)?.slice().buffer ?? null };
}

type V3 = [number, number, number];
function quad(a: V3, b: V3, c: V3, d: V3): PhysicsPolygon {
  const vertices = [a, b, c, d].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

/**
 * The leaf: a 0.2 m thick, 2 m wide, 3 m tall slab hinged at the part
 * origin — x ∈ [−0.1, 0.1], y ∈ [0, 2], z ∈ [0, 3] (part-local). Closed it
 * spans the doorway along +Y; open (90° about +Z) it lies along −X.
 */
function slabGfx() {
  const polys = [
    quad([0.1, 2, 3], [0.1, 0, 3], [0.1, 0, 0], [0.1, 2, 0]),
    quad([-0.1, 0, 3], [-0.1, 2, 3], [-0.1, 2, 0], [-0.1, 0, 0]),
    quad([-0.1, 2, 3], [0.1, 2, 3], [0.1, 2, 0], [-0.1, 2, 0]),
    quad([0.1, 0, 3], [-0.1, 0, 3], [-0.1, 0, 0], [0.1, 0, 0]),
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
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 1, z: 1.5 }, radius: 2.2 }, inPolys: [0, 1, 2, 3] } },
    drawingBSP: null,
    physicsPolygons,
    vertexArray: { vertices },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SLAB = slabGfx();
const IDQ = { w: 1, x: 0, y: 0, z: 0 };
/** The synthetic door's physics model: its one slab part at the identity placement frame. */
export function synPhysics(setupId: number): ObjectPhysicsModel | null {
  if (setupId !== SYN_SETUP) return null;
  return {
    parts: [{ gfx: SLAB, frame: { origin: { x: 0, y: 0, z: 0 }, orientation: IDQ } }],
    hasPhysicsBSP: true, cylSpheres: [], spheres: [],
    sortingSphere: { origin: { x: 0, y: 1, z: 1.5 }, radius: 2.2 },
  };
}

// ── the manager ─────────────────────────────────────────────────────

/** A headerless MovementData blob (the CreateObject form): NonCombat + ForwardCommand. */
function motionBlob(forward: number): Uint8Array {
  const buf = new Uint8Array(12);
  const v = new DataView(buf.buffer);
  v.setUint8(0, 0); // movement_type Invalid (interpreted state)
  v.setUint16(2, NONCOMBAT & 0xffff, true);
  v.setUint32(4, 0x1 | 0x2, true); // CurrentStyle | ForwardCommand
  v.setUint16(8, NONCOMBAT & 0xffff, true);
  v.setUint16(10, forward & 0xffff, true);
  return buf;
}

/** A 0xF74C MovementEvent body (6-byte header, then the blob). */
export function motionEvent(guid: number, forward: number): { guid: number; movementData: Uint8Array } {
  const buf = new Uint8Array(18);
  buf.set(motionBlob(forward), 6);
  return { guid, movementData: buf };
}

/** The door's outdoor cell (Holtburg, 0xA9B4). */
export const DOOR_CELL = 0xa9b40017;

/** A complete CreateObject record (every field the manager reads), with `over` applied. */
export function objectData(over: Partial<CreateObjectData>): CreateObjectData {
  return {
    guid: 0, name: '', weenieClassId: 0, itemType: 0, position: null, setupId: 0, motionTableId: 0, iconId: 0,
    physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0, basePalette: 0, subPalettes: [],
    textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0,
    velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
    iconOverlayId: 0, iconUnderlayId: 0,
    ...over,
  } as unknown as CreateObjectData;
}

export interface DoorRig {
  som: ServerObjectManager;
  guid: number;
  /** The door's origin (AC global x, y = THREE x, z) and its floor (THREE y). */
  ox: number; oy: number; floor: number;
  physics: (setupId: number) => ObjectPhysicsModel | null;
}

export function makeDoor(opts: {
  portal: { getFileData(id: number): ArrayBuffer | null };
  setupId: number;
  motionTableId: number;
  physics: (setupId: number) => ObjectPhysicsModel | null;
  numParts: number;
  initial: number; // ON or OFF
  state: number;
  /** Heading quaternion (AC). */
  rot?: { w: number; z: number };
  guid?: number;
}): DoorRig {
  const smr = {
    createSetupMeshWithOverrides: () => {
      const g = new THREE.Group();
      for (let i = 0; i < opts.numParts; i++) { const p = new THREE.Group(); p.name = `part_${i}`; g.add(p); }
      return g;
    },
    loadSetupModel: () => ({ defaultAnimation: 0, defaultMotionTable: 0, cylSpheres: [], spheres: [], radius: 1.5, height: 3 }),
  };
  const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
  som.setPortalDb(opts.portal as never);
  som.setPlayerGuid(0x50000001);
  const guid = opts.guid ?? 0x7a9b401e;
  const data = objectData({
    guid, name: 'Door', weenieClassId: 412, itemType: 0x80,
    position: { landblock: DOOR_CELL, x: 100, y: 120, z: 12, rw: opts.rot?.w ?? 1, rx: 0, ry: 0, rz: opts.rot?.z ?? 0 },
    setupId: opts.setupId, motionTableId: opts.motionTableId, physicsState: opts.state, objectDescFlags: 0x1000,
    initialMotion: parseMovementData(motionBlob(opts.initial), false) ?? undefined,
  });
  const door = som.createObject(data);
  if (!door) throw new Error('door not created');
  if (!som.getAnimated(guid)) throw new Error('door has no sequence');
  return { som, guid, ox: door.worldX, oy: door.worldZ, floor: door.worldY, physics: opts.physics };
}

/** Advance the manager's animations `seconds` at 60 Hz. */
export function tick(som: ServerObjectManager, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) som.updateAnimations(1 / 60);
}

/**
 * Walk a body from (door + from) along `dir` (AC, unit) for `dist` metres
 * in 0.05 m steps, registering the blockers near it for each step as
 * main.ts's creatureObstacles does. Returns the end, door-relative (AC).
 */
export function walk(rig: DoorRig, from: { x: number; y: number }, dir: { x: number; y: number }, dist: number): { x: number; y: number } {
  const dc = new DungeonCollision();
  const p = new THREE.Vector3(rig.ox + from.x, rig.floor, rig.oy + from.y);
  const step = 0.05;
  for (let s = 0; s < dist; s += step) {
    const keys = addCreatureObstacles(dc, rig.som.getBlockersNear(p.x, p.z, 10), rig.physics);
    const [ax, az] = dc.getAdjustedMovement(p, dir.x * step, dir.y * step);
    for (const k of keys) dc.removeKey(k);
    p.x += ax; p.z += az;
  }
  return { x: p.x - rig.ox, y: p.z - rig.oy };
}
