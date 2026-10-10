/**
 * How other objects move on our screen, as the retail client moves them
 * (decomp-diff sweep 2026-09-30, world objects):
 *
 *  - DECOMP.remote-motion-no-displacement (W4): an object moves / turns by
 *    its sequence — root pos-frames plus the motion's velocity / omega —
 *    every frame (CPhysicsObj::UpdatePositionInternal @ 00512c30 →
 *    CPartArray::Update → CSequence::update_internal @ 005255d0).
 *  - DECOMP.position-interpolation (W5): SmartBox::HandleReceivedPosition
 *    @ 00453fd0 stale drop, MoveOrTeleport @ 00516330 teleport snap /
 *    MAX_PHYSICS_DISTANCE / no-contact, InterpolationManager speed cap and
 *    blip.
 *  - DECOMP.remote-vector-update (W7): SmartBox::DoVectorUpdate @ 004521c0
 *    on any object, with gravity and landing.
 *  - DECOMP.remote-turnto-dropped (W3) / DECOMP.remote-moveto-walk-seed (A6):
 *    MovementType 6–9 on any object, through the MoveToManager.
 *
 * Drives the real ServerObjectManager / RemotePhysics / AnimationPlayer; the
 * remote object's sequence is a stand-in whose motion table carries the
 * human table's physics (TurnRight omega z = −1.5; RunForward's 4 m/s lives
 * in its pos-frames — see the DAT-backed block at the end for the real one).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { RemotePhysicsObject, newerStamp, MAX_INTERPOLATED_VELOCITY } from '../packages/renderer/src/world/RemotePhysics.js';
import { resolveMotion, sequencePhysicsFor, adjustMotion, HoldKey, readyMotion } from '../packages/renderer/src/world/RemoteMotion.js';
import { AnimationPlayer } from '../packages/renderer/src/animation/AnimationPlayer.js';
import { applySequencePhysics, identityFrame, type SequenceMotion } from '../packages/renderer/src/animation/SequenceFrame.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { headingOfQuat, quatForHeading, headingFromTo } from '../packages/renderer/src/world/Heading.js';
import { PhysicsState } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const STYLE = 0x8000003d;
const key = (m: number) => MotionManager.compositeKey(STYLE, m);
const ME = 0x50000001;
const LB = 0xA9B40017; // outdoor
const BASE_X = 0xa9 * 192, BASE_Y = 0xb4 * 192;

/** The human table's locomotion physics (0x09000001): TurnRight cycle / modifier omega −1.5, SideStepRight modifier +1.25 x. */
function table() {
  const cyc = (bitfield: number, extra: object = {}) => ({ numAnims: 1, bitfield, flags: 0, anims: [], ...extra });
  return {
    defaultStyle: STYLE,
    styleDefaults: new Map([[STYLE, MotionCommand.Ready]]),
    cycles: new Map<number, object>([
      [key(MotionCommand.Ready), cyc(0)],
      [key(MotionCommand.WalkForward), cyc(0)],
      [key(MotionCommand.RunForward), cyc(0)],
      [key(MotionCommand.TurnRight), cyc(2, { omega: { x: 0, y: 0, z: -1.5 } })],
      [key(MotionCommand.SideStepRight), cyc(2)],
    ]),
    modifiers: new Map<number, object>([
      [MotionCommand.TurnRight & 0xfffff, cyc(0, { omega: { x: 0, y: 0, z: -1.5 } })],
      [MotionCommand.SideStepRight & 0xfffff, cyc(0, { velocity: { x: 1.25, y: 0, z: 0 } })],
    ]),
    links: new Map(),
  };
}

/**
 * A remote object's animated entity: the motion manager records what it is
 * told to play; `update` is CSequence::update on a framerate-0 node (the
 * sequence physics for the whole dt) plus the RunForward cycle's root
 * motion (4 m/s × speed, forward), which the real pos-frames supply.
 */
function fakeAnimated() {
  const played: [number, number][] = [];
  const mm = {
    activeMotionTable: table(), currentStyleId: STYLE, isPlayingAction: false, isChangingStyle: false, motion: 0,
    setForwardMotion: (k: number, sp: number) => { played.push([k & 0xffff, sp]); return true; },
    setStanceFromId: () => true, changeStyle: () => true, queueAction: () => {}, playDeath: () => true,
    targetSubstate: 0, isDead: false, removeLinkAnimations: () => {},
  };
  const update = (dt: number, motion?: SequenceMotion) => {
    if (!motion) return;
    applySequencePhysics(motion.frame, motion, dt, dt);
    const last = played[played.length - 1];
    if (last && last[0] === (MotionCommand.RunForward & 0xffff)) motion.frame.origin.y += 4 * last[1] * dt;
  };
  return { entity: { motionManager: mm, update }, played };
}

function data(guid: number, over: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid, name: 'Drudge', weenieClassId: 7, itemType: 0x10, setupId: 0x02000001, motionTableId: 0,
    position: { landblock: LB, x: 100, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 },
    iconId: 0, physicsState: PhysicsState.Gravity, objectDescFlags: 0, radarColor: 0, radarBehavior: 0, basePalette: 0,
    subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0,
    parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0,
    useRadius: 0.6, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0,
    defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    ...over,
  } as CreateObjectData;
}

function rig(opts: { terrainZ?: number; player?: { x: number; y: number } } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(ME);
  const tz = opts.terrainZ ?? 10;
  som.setTerrainCollision({ getHeightAt: () => tz } as never);
  const p = opts.player ?? { x: BASE_X + 100, y: BASE_Y + 110 };
  som.localPlayerPosition = () => ({ x: p.x, z: p.y, y: tz, radius: 0.45, height: 1.8 });
  return { som, player: p };
}

function spawn(som: ServerObjectManager, guid: number, over: Partial<CreateObjectData> = {}) {
  const obj = som.createObject(data(guid, over))!;
  const { entity, played } = fakeAnimated();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(guid, entity as any);
  return { obj, played };
}

/** 0xF74C body: header + InterpretedMotionState (style, forward, turn — each with speed). */
function interpreted(fwd: number, fwdSpeed: number, turn = 0, turnSpeed = 1): Uint8Array {
  const flags = 0x1 | 0x2 | 0x4 | (turn ? 0x20 | 0x40 : 0);
  const bytes: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0x3d, 0];
  const push32 = (v: number) => { const b = new Uint8Array(new Uint32Array([v]).buffer); bytes.push(...b); };
  const pushF = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); bytes.push(...b); };
  const push16 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  push32(flags);
  push16(0x3d); push16(fwd & 0xffff);
  if (turn) push16(turn & 0xffff);
  pushF(fwdSpeed);
  if (turn) pushF(turnSpeed);
  return new Uint8Array(bytes);
}

/** 0xF74C body of a TurnToObject (type 8). */
function turnToObject(target: number, speed = 1): Uint8Array {
  const b = new Uint8Array(6 + 4 + 8 + 12);
  const v = new DataView(b.buffer);
  v.setUint8(6, 8); v.setUint16(8, 0x3d, true);
  v.setUint32(10, target, true); v.setFloat32(14, 0, true);
  v.setUint32(18, 0x1ee0f, true); v.setFloat32(22, speed, true); v.setFloat32(26, 0, true);
  return b;
}

/** 0xF74C body of a MoveToObject (type 6), ACE Monster_Navigation's chase. */
function moveToObject(target: number, runRate: number): Uint8Array {
  const b = new Uint8Array(6 + 4 + 4 + 16 + 28 + 4);
  const v = new DataView(b.buffer);
  let o = 6;
  v.setUint8(o, 6); o += 2; v.setUint16(o, 0x3d, true); o += 2;
  v.setUint32(o, target, true); o += 4;
  v.setUint32(o, LB, true); o += 4;
  o += 12;
  v.setUint32(o, 0x1ee0f | 0x10 | 0x20 | 0x40 | 0x80 | 0x100, true); o += 4;
  for (const f of [0.6, 0, 15, 1, 1, 0]) { v.setFloat32(o, f, true); o += 4; }
  v.setFloat32(o, runRate, true);
  return b;
}

const frames = (som: ServerObjectManager, seconds: number, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) som.updateAnimations(dt); };

// ─── W4 ──────────────────────────────────────────────────────────────────

describe('DECOMP.remote-motion-no-displacement — objects move by their motion', () => {
  it('RemoteMotion: a turn from Ready is the substate (TurnRight cycle, flagged 0x2); while running it is a modifier adding omega', () => {
    const t = table() as never;
    const turning = { ...readyMotion(), turn: MotionCommand.TurnRight, turnSpeed: 1 };
    expect(resolveMotion(t, STYLE, turning).substate).toBe(MotionCommand.TurnRight);
    const running = { ...turning, forward: MotionCommand.RunForward, forwardSpeed: 2 };
    const r = resolveMotion(t, STYLE, running);
    expect(r.substate).toBe(MotionCommand.RunForward);
    expect(r.modifiers).toEqual([{ motion: MotionCommand.TurnRight, speed: 1 }]);
    expect(sequencePhysicsFor(t, STYLE, running).omega.z).toBeCloseTo(-1.5, 6);
  });
  it('adjust_motion: TurnLeft → TurnRight × −1; WalkForward + HoldKey Run → RunForward × run rate; turns × 1.5 when running', () => {
    expect(adjustMotion(MotionCommand.TurnLeft, 1, HoldKey.None, HoldKey.None, 2)).toEqual({ motion: MotionCommand.TurnRight, speed: -1 });
    expect(adjustMotion(MotionCommand.WalkForward, 1, HoldKey.Run, HoldKey.None, 2.5)).toEqual({ motion: MotionCommand.RunForward, speed: 2.5 });
    expect(adjustMotion(MotionCommand.TurnRight, 1, HoldKey.Run, HoldKey.None, 2.5)).toEqual({ motion: MotionCommand.TurnRight, speed: 1.5 });
    expect(adjustMotion(MotionCommand.WalkBackwards, 1, HoldKey.None, HoldKey.None, 1).speed).toBeCloseTo(-0.65, 6);
  });
  it('a peer turning in place (Ready + TurnRight) rotates at the cycle omega × speed', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000100);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.Ready, 1, MotionCommand.TurnRight, 1) } as never);
    frames(som, 1);
    expect(obj.physics!.heading).toBeCloseTo(1.5 * 180 / Math.PI, 0); // ≈ 86° to the right
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.mesh!.quaternion);
    expect(fwd.x).toBeGreaterThan(0.9); // the mesh faces ~east (AC heading 86°)
  });
  it('a peer running forward moves by its run cycle every frame, not only on position updates', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000101);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.RunForward, 2.5) } as never);
    const z0 = obj.worldZ;
    frames(som, 0.5);
    expect(obj.worldZ - z0).toBeCloseTo(4 * 2.5 * 0.5, 1); // north = +Three z
    expect(obj.mesh!.position.z).toBeCloseTo(obj.worldZ, 6);
  });
  it('in the air (not on a walkable surface) the motion\'s translation is dropped', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000102);
    obj.physics!.pos = { ...obj.physics!.pos, z: 20 }; // 10 m above the ground
    obj.physics!.contact = false; obj.physics!.onWalkable = false;
    obj.physics!.setState(0); // no gravity: hold height
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.RunForward, 2) } as never);
    const z0 = obj.worldZ;
    frames(som, 0.5);
    expect(obj.worldZ).toBeCloseTo(z0, 6);
  });
  it('AnimationPlayer: each stepped-over frame folds in its root pos-frame, forward and backward', () => {
    const posFrame = { origin: { x: 0, y: 0.1, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };
    const anim = { numFrames: 10, partFrames: Array.from({ length: 10 }, () => ({ frames: [], hooks: [] })), posFrames: Array.from({ length: 10 }, () => posFrame) };
    const p = new AnimationPlayer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.play(anim as any, 0, 9, 30, 1, true);
    const m: SequenceMotion = { frame: identityFrame(), velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } };
    p.update(20 / 30, m); // two loops
    // update_internal folds in the frames it steps OVER: 0..8 each loop (the
    // node ends clamped on frame 9, whose pos-frame is not applied), and
    // advance_to_next_animation @ 005252b0 combines the starting frame 0 on
    // each arrival (BUG.local-movement-ignores-links): 10 frames per loop.
    expect(m.frame.origin.y).toBeCloseTo(2.0, 5);
    const back = new AnimationPlayer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    back.play(anim as any, 0, 9, 30, -1, true);
    const mb: SequenceMotion = { frame: identityFrame(), velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } };
    back.update(10 / 30, mb);
    expect(mb.frame.origin.y).toBeLessThan(-0.8);
  });
});

// ─── W5 ──────────────────────────────────────────────────────────────────

function pos(guid: number, x: number, y: number, z = 10, extra: Record<string, number> = {}) {
  return { guid, flags: 0x4, landblock: LB, x, y, z, rw: 1, rx: 0, ry: 0, rz: 0, instanceSequence: 1, positionSequence: 2, teleportSequence: 1, forcePositionSequence: 1, ...extra };
}

describe('DECOMP.position-interpolation — HandleReceivedPosition / MoveOrTeleport / InterpolationManager', () => {
  it('newer_event: a wrapping ushort compare, equal is not newer', () => {
    expect(newerStamp(2, 1)).toBe(true);
    expect(newerStamp(1, 1)).toBe(false);
    expect(newerStamp(0, 0xffff)).toBe(true);
    expect(newerStamp(0xffff, 0)).toBe(false);
  });
  it('a stale POSITION_TS is dropped; a newer one is interpolated to at ≤ 2 × max speed', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000200);
    som.updatePosition(pos(obj.guid, 110, 100, 10, { positionSequence: 1 }) as never); // == CreateObject's 1: stale
    expect(obj.physics!.interp.queue).toHaveLength(0);
    som.updatePosition(pos(obj.guid, 110, 100) as never);
    expect(obj.physics!.interp.queue).toHaveLength(1);
    som.updateAnimations(0.1);
    // Max speed = run_anim_speed × my_run_rate (1) = 4 → cap 8 m/s × 0.1 s.
    expect(obj.worldX - (BASE_X + 100)).toBeCloseTo(0.8, 3);
    frames(som, 2);
    expect(obj.worldX).toBeCloseTo(BASE_X + 110, 1);
    expect(obj.physics!.interp.queue).toHaveLength(0);
  });
  it('a newer TELEPORT_TS snaps; an older one is dropped', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000201);
    som.updatePosition(pos(obj.guid, 150, 150, 10, { teleportSequence: 2 }) as never);
    expect(obj.worldX).toBeCloseTo(BASE_X + 150, 5);
    som.updatePosition(pos(obj.guid, 10, 10, 10, { positionSequence: 3, teleportSequence: 1 }) as never);
    expect(obj.worldX).toBeCloseTo(BASE_X + 150, 5);
    expect(obj.physics!.interp.queue).toHaveLength(0);
  });
  it('beyond MAX_PHYSICS_DISTANCE (96 m) from the player a position snaps; without contact it is ignored', () => {
    const { som } = rig({ player: { x: BASE_X + 0, y: BASE_Y + 0 } });
    const { obj } = spawn(som, 0x80000202, { position: { landblock: LB, x: 150, y: 150, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 } });
    som.updatePosition(pos(obj.guid, 160, 150) as never);
    expect(obj.worldX).toBeCloseTo(BASE_X + 160, 5);
    som.updatePosition({ ...pos(obj.guid, 170, 150, 10, { positionSequence: 3 }), flags: 0 } as never);
    expect(obj.worldX).toBeCloseTo(BASE_X + 160, 5);
  });
  it('a target past the blip distance (100 m outdoors) snaps at once', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000203, { position: { landblock: LB, x: 0, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 } });
    som.updatePosition(pos(obj.guid, 150, 100) as never); // 150 m away, within 96 m of the player
    som.updateAnimations(1 / 60);
    expect(obj.worldX).toBeCloseTo(BASE_X + 150, 5);
  });
  it('the interpolation cap without a motion interpreter is MAX_INTERPOLATED_VELOCITY', () => {
    const body = new RemotePhysicsObject({ position: { cell: LB, pos: { x: 0, y: 0, z: 0 }, orient: { w: 1, x: 0, y: 0, z: 0 } }, state: 0 });
    body.receivePosition({ cell: LB, pos: { x: 10, y: 0, z: 0 }, orient: { w: 1, x: 0, y: 0, z: 0 }, contact: true }, 0);
    body.update(0.1, null, { terrainHeight: () => null }, 0);
    expect(body.pos.x).toBeCloseTo(MAX_INTERPOLATED_VELOCITY * 0.1, 5);
  });
});

// ─── W7 ──────────────────────────────────────────────────────────────────

describe('DECOMP.remote-vector-update — VectorUpdate on any object', () => {
  it('a peer\'s jump: up on the vector, down by gravity, landing on the ground', () => {
    const { som } = rig({ terrainZ: 10 });
    const { obj } = spawn(som, 0x80000300);
    expect(som.applyVectorUpdate(obj.guid, 0, 0, 5, 0, 0, 0, 2)).toBe(true);
    frames(som, 0.4);
    expect(obj.worldY).toBeGreaterThan(10.5);
    expect(obj.physics!.contact).toBe(false);
    frames(som, 1.2);
    expect(obj.worldY).toBeCloseTo(10, 5);
    expect(obj.physics!.contact).toBe(true);
    expect(obj.physics!.velocity.z).toBe(0);
  });
  it('a stale VECTOR_TS is dropped; the velocity is clamped to max_velocity (50)', () => {
    const { som } = rig();
    const { obj } = spawn(som, 0x80000301);
    expect(som.applyVectorUpdate(obj.guid, 0, 0, 5, 0, 0, 0, 1)).toBe(false); // CreateObject's VECTOR_TS is 1
    som.applyVectorUpdate(obj.guid, 300, 0, 400, 0, 0, 0, 2);
    expect(Math.hypot(obj.physics!.velocity.x, obj.physics!.velocity.z)).toBeCloseTo(50, 4);
  });
});

// ─── W3 / A6 ─────────────────────────────────────────────────────────────

describe('DECOMP.remote-turnto-dropped / DECOMP.remote-moveto-walk-seed — MovementType 6–9 on any object', () => {
  it('a vendor turns to face the player: TurnRight / TurnLeft cycle, the omega turns it, then Ready', () => {
    const { som, player } = rig({ player: { x: BASE_X + 100, y: BASE_Y + 95 } }); // due south of the vendor
    const { obj, played } = spawn(som, 0x80000400); // facing north
    som.handleMovementEvent({ guid: obj.guid, movementData: turnToObject(ME) } as never);
    expect(played.some(([m]) => m === (MotionCommand.TurnRight & 0xffff))).toBe(true);
    frames(som, 3);
    const want = headingFromTo(obj.physics!.pos, { x: player.x, y: player.y, z: 0 });
    expect(headingOfQuat(obj.physics!.orient)).toBeCloseTo(want, 3);
    expect(played[played.length - 1][0]).toBe(MotionCommand.Ready & 0xffff);
  });
  it('a chasing monster facing away turns in place first, then runs at the MoveTo run rate — never a walk seeded at 1.0', () => {
    const { som } = rig({ player: { x: BASE_X + 100, y: BASE_Y + 80 } });
    const { obj, played } = spawn(som, 0x80000401);
    som.handleMovementEvent({ guid: obj.guid, movementData: moveToObject(ME, 2.2) } as never);
    // StopCompletely (Ready), then the turn node — no forward motion yet.
    expect(played.filter(([m]) => m !== (MotionCommand.Ready & 0xffff))[0][0]).toBe(MotionCommand.TurnRight & 0xffff);
    expect(played.some(([m]) => m === (MotionCommand.WalkForward & 0xffff))).toBe(false);
    frames(som, 2.5);
    expect(played.some(([m, s]) => m === (MotionCommand.RunForward & 0xffff) && Math.abs(s - 2.2) < 1e-6)).toBe(true);
    expect(obj.worldZ).toBeLessThan(BASE_Y + 99); // it ran south toward us
  });
  it('any other movement cancels the MoveTo (unpack_movement → cancel_moveto)', () => {
    const { som } = rig({ player: { x: BASE_X + 100, y: BASE_Y + 80 } });
    const { obj } = spawn(som, 0x80000402);
    som.handleMovementEvent({ guid: obj.guid, movementData: moveToObject(ME, 1) } as never);
    expect(obj.moveTo!.isMovingTo()).toBe(true);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.Ready, 1) } as never);
    expect(obj.moveTo!.isMovingTo()).toBe(false);
  });
});

// ─── The real sequence: human motion table 0x09000001 ─────────────────────

const HAVE_DAT = existsSync(DAT_PATHS.portal);

describe.skipIf(!HAVE_DAT)('DAT: the human RunForward / TurnRight sequence moves the object (0x09000001)', () => {
  let db: ReturnType<typeof openDat>;
  beforeAll(() => { db = openDat(DAT_PATHS.portal); });

  it('RunForward at speed 1 carries the object 4 m/s through its pos-frames; TurnRight at speed 1 turns it 1.5 rad/s', async () => {
    const { AnimatedEntity } = await import('../packages/renderer/src/animation/AnimatedEntity.js');
    const run = new AnimatedEntity(new THREE.Group(), db);
    expect(run.initFromMotionTable(0x09000001)).toBe(true);
    run.motionManager.setForwardMotion(key(MotionCommand.RunForward), 1);
    // Let the Ready→Run link finish, then measure one second of the cycle.
    run.update(1);
    const m: SequenceMotion = { frame: identityFrame(), velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } };
    run.update(1, m);
    expect(m.frame.origin.y).toBeGreaterThan(3.5);
    expect(m.frame.origin.y).toBeLessThan(4.5);

    const turn = new AnimatedEntity(new THREE.Group(), db);
    turn.initFromMotionTable(0x09000001);
    turn.motionManager.setForwardMotion(key(MotionCommand.TurnRight), 1);
    turn.update(1);
    const table = turn.motionManager.activeMotionTable!;
    const phys = sequencePhysicsFor(table, STYLE, { ...readyMotion(), turn: MotionCommand.TurnRight, turnSpeed: 1 });
    expect(phys.omega.z).toBeCloseTo(-1.5, 5);
    const t: SequenceMotion = { frame: identityFrame(), velocity: phys.velocity, omega: phys.omega };
    turn.update(1, t);
    const h = headingOfQuat(t.frame.orientation);
    expect(h).toBeGreaterThan(80);
    expect(h).toBeLessThan(92); // ≈ 86° clockwise
    expect(headingOfQuat(quatForHeading(h))).toBeCloseTo(h, 6);
  });
});
