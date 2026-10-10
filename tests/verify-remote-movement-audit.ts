/**
 * Remote / local movement audit (2026-10-04, tools/probe-remote-movement.ts;
 * report verification/remote-movement/). Each case drives the shipped code:
 *
 *  - BUG.movetostate-style-always-noncombat — MovementSync packed CurrentStyle
 *    from a constant NonCombat; ACE copies it into its physics state on every
 *    MoveToState, so a cast after moving in magic mode was "You're too busy".
 *  - BUG.local-speed-from-state-velocity — the local body moved at
 *    get_state_velocity's constants (walk 3.12, sidesteps capped into a
 *    normalized diagonal) instead of its sequence's root motion (peace walk
 *    2.6, magic walk ~1.2, strafe-run = run + the 1.25 m/s SideStepRight
 *    modifier, uncapped).
 *  - DECOMP.remote-airborne-falling — a remote creature off the ground plays
 *    Falling (contact_allows_move @ 00528240 / apply_interpreted_movement
 *    @ 00528600) and LeaveGround / HitGround re-apply its state.
 *  - DECOMP.remote-run-rate — apply_interpreted_movement sets my_run_rate from
 *    a RunForward state (the interpolation catch-up speed after a stop).
 *  - DECOMP.remote-constraint — ConstraintManager @ 00556180: a remote object
 *    that gets no updates runs 10 m on its motion, then slows to a halt by 50.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import {
  RemotePhysicsObject, ConstraintManager, CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_START, CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_MAX,
} from '../packages/renderer/src/world/RemotePhysics.js';
import {
  contactAllowsMove, appliedMotion, leaveGroundVelocity, readyMotion, sequenceRootVelocity,
} from '../packages/renderer/src/world/RemoteMotion.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { applySequencePhysics, identityFrame, type SequenceMotion } from '../packages/renderer/src/animation/SequenceFrame.js';
import { PhysicsState } from '@ac/shared';
import { deserializeMessage, GameActionType, parseMoveToStatePayload, type CreateObjectData } from '@ac/network';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const STYLE = 0x8000003d;
const MAGIC = 0x80000049;
const key = (m: number) => MotionManager.compositeKey(STYLE, m);
const LB = 0xA9B40017;
const BASE_X = 0xa9 * 192, BASE_Y = 0xb4 * 192;

function table() {
  const cyc = (bitfield: number, extra: object = {}) => ({ numAnims: 1, bitfield, flags: 0, anims: [], ...extra });
  return {
    defaultStyle: STYLE,
    styleDefaults: new Map([[STYLE, MotionCommand.Ready]]),
    cycles: new Map<number, object>([
      [key(MotionCommand.Ready), cyc(0)],
      [key(MotionCommand.WalkForward), cyc(0)],
      [key(MotionCommand.RunForward), cyc(0)],
      [key(MotionCommand.Falling), cyc(0)],
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

/** A remote object's sequence stand-in: records what it is told to play; RunForward carries 4 m/s × speed of root motion. */
function fakeAnimated() {
  const played: number[] = [];
  let removedLinks = 0;
  let lastSpeed = 1;
  const mm = {
    activeMotionTable: table(), currentStyleId: STYLE, isPlayingAction: false, isChangingStyle: false, motion: 0,
    setForwardMotion: (k: number, sp: number) => { played.push(k & 0xffff); lastSpeed = sp; return true; },
    setStanceFromId: () => true, changeStyle: () => true, queueAction: () => {}, playDeath: () => true,
    targetSubstate: 0, isDead: false, removeLinkAnimations: () => { removedLinks++; },
  };
  const update = (dt: number, motion?: SequenceMotion) => {
    if (!motion) return;
    applySequencePhysics(motion.frame, motion, dt, dt);
    if (played[played.length - 1] === (MotionCommand.RunForward & 0xffff)) motion.frame.origin.y += 4 * lastSpeed * dt;
  };
  return { entity: { motionManager: mm, update }, played, removed: () => removedLinks };
}

function rig() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(0x50000001);
  som.setTerrainCollision({ getHeightAt: () => 10 } as never);
  som.localPlayerPosition = () => ({ x: BASE_X + 100, z: BASE_Y + 110, y: 10, radius: 0.45, height: 1.8 });
  return som;
}

function spawn(som: ServerObjectManager, guid: number) {
  som.createObject({
    guid, name: 'Peer', weenieClassId: 1, itemType: 0x10, setupId: 0x02000001, motionTableId: 0,
    position: { landblock: LB, x: 100, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 },
    physicsState: PhysicsState.Gravity, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
  } as unknown as CreateObjectData);
  const f = fakeAnimated();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(guid, f.entity as any);
  return { obj: som.getObject(guid)!, ...f };
}

/** 0xF74C body: 6-byte header, type 0, style 0x3d, then InterpretedMotionState (style + forward [+ speed]). */
function interpreted(fwd: number, fwdSpeed: number): Uint8Array {
  const bytes: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0x3d, 0];
  const push32 = (v: number) => bytes.push(...new Uint8Array(new Uint32Array([v]).buffer));
  const pushF = (v: number) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  push32(0x1 | 0x2 | 0x4);
  bytes.push(0x3d, 0, fwd & 0xff, (fwd >> 8) & 0xff);
  pushF(fwdSpeed);
  return new Uint8Array(bytes);
}

/** ACE's blank pre-jump UpdateMotion (Player.HandleActionJump): style 0, empty state. */
function blank(): Uint8Array {
  return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

const frames = (som: ServerObjectManager, seconds: number, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) som.updateAnimations(dt); };

describe('BUG.movetostate-style-always-noncombat — MoveToState packs the player\'s real style', () => {
  async function sync(style: number) {
    const { MovementSync } = await import('../packages/renderer/src/network/MovementSync.js');
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = new MovementSync({ sendMessage: (b: Uint8Array) => { const m = deserializeMessage(b); if (m.type === 'action' && m.actionType === GameActionType.MoveToState) sent.push(m.payload); } } as any, () => 1);
    s.stanceProvider = () => style;
    s.update({ forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true },
      { worldX: 100, worldZ: 200, groundY: 12.5, playerYaw: 0, landblock: 0xa9b4ffff, localX: 0, localY: 0, localZ: 0, inDungeon: false } as never, 0);
    return parseMoveToStatePayload(sent[0]);
  }
  it('in magic mode CurrentStyle is Magic, so ACE keeps its physics in Magic and the next cast is accepted', async () => {
    const p = await sync(MAGIC);
    expect(p.motion.currentStance >>> 0).toBe(MAGIC);
  });
  it('in peace mode it is omitted, as RawMotionState::Pack omits NonCombat', async () => {
    const p = await sync(STYLE);
    expect(p.motion.currentStance >>> 0).toBe(STYLE); // absent → the NonCombat default
  });
});

describe('DECOMP.remote-airborne-falling — remote creatures in the air', () => {
  it('contact_allows_move: Dead / Falling / turns always; a gravity creature needs walkable ground; non-creatures always', () => {
    expect(contactAllowsMove(MotionCommand.RunForward, true, true, false)).toBe(false);
    expect(contactAllowsMove(MotionCommand.RunForward, true, true, true)).toBe(true);
    expect(contactAllowsMove(MotionCommand.TurnLeft, true, true, false)).toBe(true);
    expect(contactAllowsMove(MotionCommand.Dead, true, true, false)).toBe(true);
    expect(contactAllowsMove(MotionCommand.RunForward, false, true, false)).toBe(true);
    expect(contactAllowsMove(MotionCommand.RunForward, true, false, false)).toBe(true);
    const st = { ...readyMotion(), forward: MotionCommand.RunForward, forwardSpeed: 2, sidestep: MotionCommand.SideStepRight, sidestepSpeed: 1, turn: MotionCommand.TurnRight, turnSpeed: 1.5 };
    expect(appliedMotion(st, false)).toEqual({ forward: MotionCommand.Falling, forwardSpeed: 1, sidestep: 0, sidestepSpeed: 1, turn: MotionCommand.TurnRight, turnSpeed: 1.5 });
    expect(appliedMotion(st, true)).toBe(st);
  });

  it('a peer\'s ACE jump (blank motion, then the VectorUpdate): Falling in the air, links dropped, its state again on landing; the jump velocity survives', () => {
    const som = rig();
    const { obj, played, removed } = spawn(som, 0x50000077);
    som.handleMovementEvent({ guid: obj.guid, movementData: blank() } as never);
    expect(som.applyVectorUpdate(obj.guid, 0, 3, 5, 0, 0, 0, 2)).toBe(true);
    frames(som, 0.2);
    expect(obj.physics!.contact).toBe(false);
    expect(played[played.length - 1]).toBe(MotionCommand.Falling & 0xffff);
    expect(removed()).toBe(1);
    expect(obj.worldY).toBeGreaterThan(10.4); // the vector's lift was kept (state velocity zero)
    frames(som, 1.5);
    expect(obj.physics!.contact).toBe(true);
    expect(played[played.length - 1]).toBe(MotionCommand.Ready & 0xffff);
    expect(removed()).toBe(2);
  });

  it('get_leave_ground_velocity: a running state replaces the velocity with the run (no lift — why ACE blanks the motion first)', () => {
    const run = { ...readyMotion(), forward: MotionCommand.RunForward, forwardSpeed: 2 };
    expect(leaveGroundVelocity(run, 2)).toEqual({ x: 0, y: 8, z: 0 });
    expect(leaveGroundVelocity(readyMotion(), 2)).toBeNull();
    const som = rig();
    const { obj } = spawn(som, 0x50000078);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.RunForward, 2) } as never);
    som.applyVectorUpdate(obj.guid, 0, 0, 5, 0, 0, 0, 2);
    frames(som, 1 / 60);
    expect(obj.physics!.velocity.z).toBeLessThan(0.5);
    expect(obj.physics!.velocity.y).toBeCloseTo(8, 0); // facing north: the run velocity
  });
});

describe('DECOMP.remote-run-rate — my_run_rate follows a RunForward state', () => {
  it('after a run at 2.5 stops, the interpolation catches up at 2 × 4 × 2.5 m/s, not 2 × 4 × 1', () => {
    const som = rig();
    const { obj } = spawn(som, 0x50000079);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.RunForward, 2.5) } as never);
    expect(obj.myRunRate).toBe(2.5);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.Ready, 1) } as never);
    const y0 = obj.physics!.pos.y;
    som.updatePosition({ guid: obj.guid, landblock: LB, x: 100, y: 130, z: 10, rw: 1, rx: 0, ry: 0, rz: 0, flags: 0x4, positionSequence: 5, teleportSequence: 1 } as never);
    som.updateAnimations(0.1);
    expect(obj.physics!.pos.y - y0).toBeCloseTo(2 * 4 * 2.5 * 0.1, 3);
  });
});

describe('DECOMP.remote-constraint — ConstraintManager', () => {
  it('adjust_offset: full offset to 10 m, scaled to zero by 50 m, accumulating its own length', () => {
    const cm = new ConstraintManager({ hasContact: () => true });
    cm.constrainTo(0, CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_START, CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_MAX);
    const step = () => { const f = identityFrame(); f.origin = { x: 0, y: 1, z: 0 }; cm.adjustOffset(f); return f.origin.y; };
    for (let i = 0; i < 10; i++) expect(step()).toBe(1);
    expect(step()).toBe(1); // at exactly 10: not past start yet
    expect(step()).toBeCloseTo((50 - 11) / 40, 6);
    for (let i = 0; i < 5000; i++) step();
    expect(cm.constraintPosOffset).toBeLessThan(50);
    expect(cm.isFullyConstrained()).toBe(true);
  });
  it('a remote runner whose updates stop runs 10 m, then slows to a halt short of 50 m; a new position re-arms it', () => {
    const som = rig();
    const { obj } = spawn(som, 0x5000007a);
    som.handleMovementEvent({ guid: obj.guid, movementData: interpreted(MotionCommand.RunForward, 2) } as never);
    som.updatePosition({ guid: obj.guid, landblock: LB, x: 100, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0, flags: 0x4, positionSequence: 2, teleportSequence: 1 } as never);
    const y0 = obj.physics!.pos.y;
    frames(som, 1.2);
    expect(obj.physics!.pos.y - y0).toBeCloseTo(8 * 1.2, 0); // full speed inside 10 m
    frames(som, 30);
    const ran = obj.physics!.pos.y - y0;
    expect(ran).toBeGreaterThan(10);
    expect(ran).toBeLessThan(50);
    const before = obj.physics!.pos.y;
    frames(som, 1);
    expect(obj.physics!.pos.y - before).toBeLessThan(0.05); // halted
    expect(new RemotePhysicsObject({ position: null, state: 0 }).constraint.isConstrained).toBe(false);
  });
});

const HAVE_DAT = existsSync(DAT_PATHS.portal);
describe.skipIf(!HAVE_DAT)('DAT: the sequence\'s root motion is how fast a character moves (human 0x09000001)', () => {
  let db: ReturnType<typeof openDat>;
  beforeAll(() => { db = openDat(DAT_PATHS.portal); });
  const st = (o: object) => ({ ...readyMotion(), ...o });

  it('sequenceRootVelocity: peace walk 2.6, run 4 × speed, magic walk ~1.2, sidestep from standing its cycle, strafe-run = run + 1.25 × speed (uncapped)', async () => {
    const { AnimatedEntity } = await import('../packages/renderer/src/animation/AnimatedEntity.js');
    const e = new AnimatedEntity(new THREE.Group(), db);
    expect(e.initFromMotionTable(0x09000001)).toBe(true);
    const mm = e.motionManager;
    const t = mm.activeMotionTable!;
    const load = (id: number) => mm.loadAnimation(id);
    const walk = sequenceRootVelocity(t, STYLE, st({ forward: MotionCommand.WalkForward, forwardSpeed: 1 }), load);
    expect(walk.y).toBeCloseTo(2.6, 1);
    expect(sequenceRootVelocity(t, STYLE, st({ forward: MotionCommand.RunForward, forwardSpeed: 2 }), load).y).toBeCloseTo(8, 1);
    expect(sequenceRootVelocity(t, MAGIC, st({ forward: MotionCommand.WalkForward, forwardSpeed: 1 }), load).y).toBeCloseTo(1.2, 1);
    const back = sequenceRootVelocity(t, STYLE, st({ forward: MotionCommand.WalkForward, forwardSpeed: -0.65 }), load);
    expect(back.y).toBeCloseTo(-2.6 * 0.65, 1);
    const side = sequenceRootVelocity(t, STYLE, st({ sidestep: MotionCommand.SideStepRight, sidestepSpeed: 1.248 }), load);
    expect(side.x).toBeCloseTo(1.2 * 1.248, 1);
    const sideLeft = sequenceRootVelocity(t, STYLE, st({ sidestep: MotionCommand.SideStepRight, sidestepSpeed: -1.248 }), load);
    expect(sideLeft.x).toBeCloseTo(-1.2 * 1.248, 1);
    const diag = sequenceRootVelocity(t, STYLE, st({ forward: MotionCommand.RunForward, forwardSpeed: 2, sidestep: MotionCommand.SideStepRight, sidestepSpeed: 2.496 }), load);
    expect(diag.y).toBeCloseTo(8, 1);
    expect(diag.x).toBeCloseTo(1.25 * 2.496, 2);
    expect(Math.hypot(diag.x, diag.y)).toBeGreaterThan(8); // the strafe-run is faster than the run
  });

  it('CameraController moves the local body by that root motion (W + C running: run + modifier, no cap); stateVelocity stays the jump\'s', async () => {
    const { AnimatedEntity } = await import('../packages/renderer/src/animation/AnimatedEntity.js');
    const { CameraController } = await import('../packages/renderer/src/scene/CameraController.js');
    const e = new AnimatedEntity(new THREE.Group(), db);
    e.initFromMotionTable(0x09000001);
    const mm = e.motionManager;
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000));
    cc.runRate = 2;
    cc.rootMotion = (s) => sequenceRootVelocity(mm.activeMotionTable!, STYLE, s, (id) => mm.loadAnimation(id));
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyDown('KeyC');
    const v = cc.motionVelocity();
    expect(v.forward).toBeCloseTo(8, 1);
    expect(v.side).toBeCloseTo(1.25 * Math.min(1.248 * 2, 3), 2);
    // get_state_velocity (the jump) caps the diagonal at run_anim_speed × the run rate.
    const j = cc.stateVelocity();
    expect(Math.hypot(j.side, j.forward)).toBeCloseTo(8, 4);
  });

  it('MotionManager.removeLinkAnimations: a playing Ready → Run link is dropped; the run cycle plays at once', async () => {
    const { AnimatedEntity } = await import('../packages/renderer/src/animation/AnimatedEntity.js');
    const e = new AnimatedEntity(new THREE.Group(), db);
    e.initFromMotionTable(0x09000001);
    const mm = e.motionManager;
    mm.setForwardMotion(key(MotionCommand.RunForward), 1.5);
    expect(mm.isPlayingAction).toBe(true); // the start link
    mm.removeLinkAnimations();
    expect(mm.isPlayingAction).toBe(false);
    expect(mm.motion >>> 0).toBe(key(MotionCommand.RunForward));
    expect(mm.animationPlayer.currentAnimation?.id).toBe(0x03000002);
    expect(mm.animationPlayer.playbackSpeed).toBeCloseTo(1.5, 6);
  });
});

