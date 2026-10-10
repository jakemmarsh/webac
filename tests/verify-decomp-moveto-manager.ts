/**
 * DECOMP.remote-moveto-walk-seed + DECOMP.server-moveto-steering +
 * DECOMP.remote-turnto-dropped (the TurnTo half) + DECOMP.client-use-approach
 * (the walk the server's MoveTo now drives) — the retail MoveToManager port
 * (controllers/MoveToManager.ts) every server-driven move runs on: a turn-in-
 * place node first, walk / run decided once by MovementParameters::
 * get_command @ 0052aa00 (CanCharge ⇒ run), aux turns past 20°,
 * UseFinalHeading 0x40, Sticky, FailDistance; no timeout.
 *
 * Drives the real MoveToManager against a simulated object whose motions go
 * through the real adjust_motion (world/RemoteMotion.ts) and move it the way
 * the motion table does (RunForward 4 m/s × speed, WalkForward 3.12 m/s ×
 * speed, TurnRight 1.5 rad/s × speed).
 */
import { describe, it, expect } from 'vitest';
import {
  MoveToManager, MoveFlag, MoveType, getCommand, defaultMovementParams, headingDiff, headingGreater,
  cylinderDistance, performServerMovement, moveToDestination, type MoveToHost, type MovementParams,
} from '../packages/renderer/src/controllers/MoveToManager.js';
import {
  adjustMotion, applyInterpretedMotion, removeInterpretedMotion, readyMotion, HoldKey, type InterpretedMotion,
} from '../packages/renderer/src/world/RemoteMotion.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { headingFromTo } from '../packages/renderer/src/world/Heading.js';
import type { SeqV3 } from '../packages/renderer/src/animation/SequenceFrame.js';

const DEG = 180 / Math.PI;

interface Sim {
  mgr: MoveToManager;
  pos: SeqV3;
  heading: number;
  st: InterpretedMotion;
  /** Every _DoMotion as (adjusted command, speed). */
  motions: [number, number][];
  done: number[];
  stuck: number[];
  targets: Map<number, { pos: SeqV3; radius: number; height: number }>;
  step(dt: number): void;
  run(seconds: number, dt?: number): void;
}

function sim(opts: { pos?: SeqV3; heading?: number; runRate?: number } = {}): Sim {
  let t = 0;
  const s = {
    pos: { ...(opts.pos ?? { x: 0, y: 0, z: 0 }) },
    heading: opts.heading ?? 0,
    st: readyMotion(),
    motions: [] as [number, number][],
    done: [] as number[],
    stuck: [] as number[],
    targets: new Map<number, { pos: SeqV3; radius: number; height: number }>(),
  } as Sim;
  const runRate = opts.runRate ?? 2;
  const host: MoveToHost = {
    position: () => s.pos,
    heading: () => s.heading,
    setHeading: (h) => { s.heading = h; },
    radius: () => 0.5,
    height: () => 1.8,
    doMotion: (cmd, speed, hk) => {
      const a = adjustMotion(cmd, speed, hk, HoldKey.None, runRate);
      s.motions.push([a.motion, a.speed]);
      applyInterpretedMotion(s.st, a.motion, a.speed);
      return 0;
    },
    stopMotion: (cmd, speed, hk) => { removeInterpretedMotion(s.st, adjustMotion(cmd, speed, hk, HoldKey.None, runRate).motion); return 0; },
    stopCompletely: () => { Object.assign(s.st, readyMotion()); },
    motionsPending: () => false,
    hasContact: () => true,
    target: (id) => s.targets.get(id) ?? null,
    stickTo: (id) => { s.stuck.push(id); },
    onComplete: (status) => { s.done.push(status); },
    now: () => t,
  };
  s.mgr = new MoveToManager(host);
  s.step = (dt: number) => {
    s.mgr.useTime();
    const st = s.st;
    if (st.turn) s.heading = (((s.heading + 1.5 * st.turnSpeed * dt * DEG) % 360) + 360) % 360;
    const v = st.forward === MotionCommand.RunForward ? 4 * st.forwardSpeed
      : st.forward === MotionCommand.WalkForward ? 3.12 * st.forwardSpeed : 0;
    const h = s.heading / DEG;
    s.pos = { x: s.pos.x + Math.sin(h) * v * dt, y: s.pos.y + Math.cos(h) * v * dt, z: s.pos.z };
    t += dt;
  };
  s.run = (seconds: number, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) s.step(dt); };
  return s;
}

function params(over: Partial<MovementParams> = {}): MovementParams {
  return { ...defaultMovementParams(), ...over };
}

describe('MovementParameters::get_command @ 0052aa00', () => {
  it('CanCharge always runs; otherwise run only beyond WalkRunThreshold (default 15) or when it cannot walk', () => {
    const base = params();
    expect(getCommand({ ...base, flags: base.flags | MoveFlag.CanCharge }, 2)).toEqual({ motion: MotionCommand.WalkForward, holdKey: HoldKey.Run, movingAway: false });
    expect(getCommand(base, 10).holdKey).toBe(HoldKey.None);
    expect(getCommand(base, 16).holdKey).toBe(HoldKey.Run);
    expect(getCommand({ ...base, flags: base.flags & ~MoveFlag.CanWalk }, 2).holdKey).toBe(HoldKey.Run);
    expect(getCommand(base, 0.5).motion).toBe(0); // inside DistanceToObject 0.6
  });
  it('towards_and_away backs off inside MinDistance', () => {
    const p = params({ flags: MoveFlag.MoveTowards | MoveFlag.MoveAway | MoveFlag.CanRun | MoveFlag.CanWalk, distanceToObject: 2, minDistance: 1 });
    expect(getCommand(p, 3).motion).toBe(MotionCommand.WalkForward);
    expect(getCommand(p, 0.5)).toMatchObject({ motion: MotionCommand.WalkBackwards, movingAway: true });
    expect(getCommand(p, 1.5).motion).toBe(0);
  });
  it('heading_diff / heading_greater (@ 00528fb0 / 00528f60)', () => {
    expect(headingDiff(90, 0, MotionCommand.TurnRight)).toBe(90);
    expect(headingDiff(90, 0, MotionCommand.TurnLeft)).toBe(270);
    expect(headingGreater(10, 350, MotionCommand.TurnRight)).toBe(true); // wrapped past north
    expect(headingGreater(10, 350, MotionCommand.TurnLeft)).toBe(false);
  });
  it('cylinder_distance subtracts both radii and adds the vertical gap', () => {
    expect(cylinderDistance(0.5, 2, { x: 0, y: 0, z: 0 }, 0.5, 2, { x: 3, y: 0, z: 0 })).toBeCloseTo(2, 6);
    expect(cylinderDistance(0.5, 1, { x: 0, y: 0, z: 0 }, 0.5, 1, { x: 3, y: 0, z: 4 })).toBeCloseTo(Math.hypot(Math.hypot(3, 4) - 1, 3), 6);
  });
});

describe('MoveToObject — a turn node, then ONE walk/run decision (DECOMP.remote-moveto-walk-seed)', () => {
  it('a creature facing away turns in place first, then runs (CanCharge) at speed × run rate, stops inside DistanceToObject and returns to Ready', () => {
    const s = sim({ heading: 180, runRate: 2 });
    s.targets.set(7, { pos: { x: 0, y: 20, z: 0 }, radius: 0.5, height: 1.8 });
    // ACE Monster_Navigation: CanCharge | FailWalk | UseFinalHeading | Sticky | MoveAway, WRT 1.
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.CanCharge | MoveFlag.UseFinalHeading | MoveFlag.MoveAway, walkRunThreshold: 1 }));
    expect(s.motions[0][0]).toBe(MotionCommand.TurnRight); // 180° → TurnRight (diff ≤ 180)
    expect(s.motions.some(([m]) => m === MotionCommand.WalkForward)).toBe(false);
    s.run(1.5);
    // Turned onto north, then RunForward at 1 × runRate 2.
    const run = s.motions.find(([m]) => m === MotionCommand.RunForward);
    expect(run).toEqual([MotionCommand.RunForward, 2]);
    s.run(6);
    const d = cylinderDistance(0.5, 1.8, s.pos, 0.5, 1.8, { x: 0, y: 20, z: 0 });
    expect(d).toBeLessThanOrEqual(0.6);
    expect(d).toBeGreaterThan(0.3);
    expect(s.mgr.isMovingTo()).toBe(false);
    expect(s.st.forward).toBe(MotionCommand.Ready);
    expect(s.done).toEqual([0]);
  });
  it('without CanCharge a nearby target (inside WalkRunThreshold) is walked to, and the gait never changes on the way', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 0, y: 6, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params());
    s.run(3);
    const fwd = s.motions.filter(([m]) => m === MotionCommand.WalkForward || m === MotionCommand.RunForward);
    expect(fwd).toEqual([[MotionCommand.WalkForward, 1]]);
    expect(s.mgr.isMovingTo()).toBe(false);
  });
  it('UseFinalHeading ends with a turn onto the heading to the target (+ desired_heading)', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 3, y: 3, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.UseFinalHeading, desiredHeading: 90 }));
    s.run(6);
    expect(s.mgr.isMovingTo()).toBe(false);
    expect(s.heading).toBeCloseTo(45 + 90, 3); // snapped by HandleTurnToHeading
  });
  it('steers with an aux turn once the target is more than 20° off, and runs straight inside it', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 0, y: 30, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.CanCharge }));
    s.run(0.5);
    expect(s.st.turn).toBe(0);
    s.targets.get(7)!.pos = { x: 25, y: 10, z: 0 }; // the target darts east
    s.step(1 / 60);
    expect(s.st.turn).toBe(MotionCommand.TurnRight);
    expect(s.st.forward).toBe(MotionCommand.RunForward); // still running while turning
  });
  it('charging farther than FailDistance from the start cancels with YouChargedTooFar (0x3d)', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 0, y: 40, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.CanCharge, failDistance: 5 }));
    s.run(3);
    expect(s.done).toEqual([0x3d]);
    expect(s.st.forward).toBe(MotionCommand.Ready);
  });
  it('a Sticky move sticks to the target on arrival (PositionManager::StickTo)', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 0, y: 5, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.Sticky }));
    s.run(3);
    expect(s.stuck).toEqual([7]);
  });
  it('the target leaving cancels; there is no timeout', () => {
    const s = sim({ heading: 0 });
    s.targets.set(7, { pos: { x: 0, y: 200, z: 0 }, radius: 0.5, height: 1.8 });
    s.mgr.moveToObject(7, params({ flags: 0x1ee0f | MoveFlag.CanCharge }));
    s.run(20);
    expect(s.mgr.isMovingTo()).toBe(true); // 20 s in, still going
    s.targets.delete(7);
    s.step(1 / 60);
    expect(s.mgr.isMovingTo()).toBe(false);
    expect(s.done).toEqual([0x37]);
  });
});

describe('MoveToPosition — a portal Use (DECOMP.client-use-approach)', () => {
  it('ACE CreateMoveToChain → MoveToPosition(portal, DistanceToObject 0): walks into the portal cylinder', () => {
    const s = sim({ heading: 270 });
    const portal = { x: 0, y: 8, z: 0 };
    s.mgr.moveToPosition(portal, params({ distanceToObject: 0 }));
    s.run(5);
    expect(s.mgr.isMovingTo()).toBe(false);
    // UseSpheres: the player's cylinder (radius 0.5) now overlaps the portal origin.
    expect(Math.hypot(s.pos.x - portal.x, s.pos.y - portal.y)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(s.done).toEqual([0]);
  });
});

describe('TurnToObject / TurnToHeading (DECOMP.remote-turnto-dropped)', () => {
  it('TurnToHeading turns the short way at the turn rate and lands exactly on the heading', () => {
    const s = sim({ heading: 10 });
    s.mgr.turnToHeading(params({ desiredHeading: 300 }));
    expect(s.motions[0][0]).toBe(MotionCommand.TurnRight);
    expect(s.motions[0][1]).toBeLessThan(0); // TurnLeft adjusted to TurnRight × −1
    s.run(0.5);
    expect(s.heading).toBeGreaterThan(300); // partway (≈ 367° − 43°)
    s.run(2);
    expect(s.heading).toBe(300);
    expect(s.st.turn).toBe(0);
    expect(s.done).toEqual([0]);
  });
  it('TurnToObject faces the target (a vendor turning to the player)', () => {
    const s = sim({ heading: 0 });
    s.targets.set(9, { pos: { x: -5, y: 0, z: 0 }, radius: 0.4, height: 1.8 });
    s.mgr.turnToObject(9, params({ desiredHeading: 123 }));
    s.run(3);
    expect(s.heading).toBeCloseTo(headingFromTo(s.pos, { x: -5, y: 0, z: 0 }), 4);
    expect(s.heading).toBeCloseTo(270, 4);
  });
  it('unpack_movement: an unknown TurnToObject target turns to the sent heading; an unknown MoveToObject target walks to the sent origin', () => {
    const s = sim({ heading: 0 });
    performServerMovement(s.mgr, MoveType.TurnToObject, { turnTo: { target: 0x999, flags: 0x1ee0f, speed: 1, desiredHeading: 90 } }, () => false);
    s.run(2);
    expect(s.heading).toBe(90);
    const m = {
      target: 0x999, cellId: 0x01020003, origin: { x: 10, y: 20, z: 0 }, flags: 0x1ee0f,
      distanceToObject: 0.6, minDistance: 0, failDistance: 3.4e38, speed: 1, walkRunThreshold: 15, desiredHeading: 0, runRate: 1.7,
    };
    expect(moveToDestination(m)).toEqual({ x: 1 * 192 + 10, y: 2 * 192 + 20, z: 0 });
    expect(performServerMovement(s.mgr, MoveType.MoveToObject, { moveTo: m }, () => false)).toBe(1.7);
    expect(s.mgr.movementType).toBe(MoveType.MoveToPosition);
  });
  it('a new movement cancels the old one (PerformMovement → CancelMoveTo 0x36)', () => {
    const s = sim({ heading: 0 });
    s.mgr.turnToHeading(params({ desiredHeading: 180 }));
    s.mgr.turnToHeading(params({ desiredHeading: 90 }));
    expect(s.done).toEqual([0x36]);
  });
});
