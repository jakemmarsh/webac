/**
 * BUG.ac1999-monster-jitter — "a drudge slinker … jumping back and forth and wasn't able to get to
 * me" (Jake, AC1999 prod, an archer).
 *
 * A creature's chase is one MoveToObject the client runs itself; the AC1999 server corrects it with an
 * 0xF748 every 0.2 s while it is mid-moveto (Moves.cpp Movement_Think / IsCreatureHeartbeatDue,
 * creature_position_interval). The server's copy moves under the retail physics (PhatSDK): it cannot
 * climb a terrain face whose Normal.Z is under FloorZ (SetPositionInternal → set_on_walkable(false),
 * calc_acceleration → gravity, UpdatePositionInternal @ 00512c30 drops the animation offset). Ours
 * followed the terrain height whatever its slope, so it ran up the face, and each correction pulled it
 * back down.
 *
 * Drives the real RemotePhysicsObject (world/RemotePhysics.ts) on a synthetic landscape.
 */
import { describe, expect, it } from 'vitest';
import { FLOOR_Z, RemotePhysicsObject, type RemotePhysicsEnv } from '../packages/renderer/src/world/RemotePhysics.js';
import { identityFrame, type SequenceFrame } from '../packages/renderer/src/animation/SequenceFrame.js';
import { PhysicsState } from '@ac/shared';
import { CreatureCorrectionLog, correctionLine, CORRECTION_REPORT_INTERVAL_MS } from '../packages/renderer/src/world/CreatureCorrectionLog.js';
import { pageLogLine } from '../tools/ac-agent/daemon.js';

const CELL = 0xa9b40017; // an outdoor land cell
const FOOT = 10; // the slope starts 10 m north of the origin

/** Flat to y = FOOT, then rising northward at `rise` m per m. */
function hill(rise: number): RemotePhysicsEnv {
  const len = Math.hypot(rise, 1);
  return {
    terrainHeight: (_x, y) => (y > FOOT ? (y - FOOT) * rise : 0),
    terrainNormal: (_x, y) => (y > FOOT ? { x: 0, y: -rise / len, z: 1 / len } : { x: 0, y: 0, z: 1 }),
  };
}

/** A creature running north (its RunForward root motion, 6 m/s), facing +y. */
function creature() {
  const body = new RemotePhysicsObject({
    position: { cell: CELL, pos: { x: 50, y: 0, z: 0 }, orient: { w: 1, x: 0, y: 0, z: 0 } },
    state: PhysicsState.Gravity | PhysicsState.ReportCollisions,
  });
  const events: string[] = [];
  body.motion = {
    ...body.motion,
    leaveGround: () => { events.push('leave'); body.setLocalVelocity({ x: 0, y: 6, z: 0 }); },
    hitGround: () => { events.push('hit'); },
    adjustedMaxSpeed: () => 6,
    maxSpeed: () => 6,
    isMovingTo: () => true,
  };
  return { body, events };
}

const run = (dt: number): SequenceFrame => {
  const f = identityFrame();
  f.origin = { x: 0, y: 6 * dt, z: 0 };
  return f;
};

/** Step `secs` at 60 fps; `server` (if given) is the corrections loop: a position every 0.2 s. */
function simulate(body: RemotePhysicsObject, env: RemotePhysicsEnv, secs: number, server?: () => { y: number; z: number }) {
  const dt = 1 / 60;
  let t = 0, nextCorrection = 0.2, stamp = 1;
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < secs * 60; i++) {
    t += dt;
    if (server && t >= nextCorrection) {
      nextCorrection += 0.2;
      const s = server();
      body.receivePosition({ cell: CELL, pos: { x: 50, y: s.y, z: s.z }, orient: { w: 1, x: 0, y: 0, z: 0 }, contact: true, positionTs: ++stamp }, 5);
    }
    body.update(dt, run(dt), env, t);
    ys.push(body.pos.y);
    zs.push(body.pos.z);
  }
  return Object.assign(ys, { zs });
}

describe('BUG.ac1999-monster-jitter: a remote creature cannot run up a face it cannot stand on', () => {
  it('FLOOR_Z is PhysicsGlobals::floor_z (ACE PhysicsGlobals.FloorZ)', () => {
    expect(FLOOR_Z).toBeCloseTo(0.66417414618662751, 15);
  });

  it('a walkable slope (Normal.Z 0.89) is climbed as before', () => {
    const { body, events } = creature();
    const env = hill(0.5);
    simulate(body, env, 4);
    expect(body.pos.y).toBeGreaterThan(FOOT + 10);
    expect(body.pos.z).toBeCloseTo((body.pos.y - FOOT) * 0.5, 3);
    expect(body.sliding).toBe(false);
    expect(events).toEqual([]);
  });

  it('a steep face (Normal.Z 0.45 < FloorZ) is not climbed: LeaveGround, the slide down, HitGround at its foot', () => {
    const { body, events } = creature();
    const env = hill(2);
    const ys = simulate(body, env, 4);
    // Pre-fix it followed the terrain up: 24 m on in 4 s, 28 m above the foot.
    expect(Math.max(...ys)).toBeLessThan(FOOT + 1.5);
    expect(events[0]).toBe('leave');
    expect(events).toContain('hit');
    expect(body.pos.z).toBeLessThan(3);
  });

  it('the server\'s copy held at the foot by the same face: the corrections no longer swing it metres back and forth', () => {
    const { body } = creature();
    const env = hill(2);
    // The server's creature stands pressed against the face's foot.
    const ys = simulate(body, env, 6, () => ({ y: FOOT, z: 0 }));
    const late = ys.slice(120);
    const swing = Math.max(...late) - Math.min(...late);
    const lift = Math.max(...ys.zs.slice(120));
    // Pre-fix: 0.9 m up the face and 1.8 m into the air, then back down, on every correction (5 a second).
    expect(swing).toBeLessThan(0.6);
    expect(lift).toBeLessThan(1);
  });

  it('a standing object on a steep face stays where the server put it (only a move is judged)', () => {
    const { body, events } = creature();
    const env = hill(2);
    body.setPositionSimple({ cell: CELL, pos: { x: 50, y: FOOT + 2, z: 4 }, orient: { w: 1, x: 0, y: 0, z: 0 } });
    for (let i = 0; i < 60; i++) body.update(1 / 60, identityFrame(), env, i / 60);
    expect(body.pos).toMatchObject({ y: FOOT + 2, z: 4 });
    expect(events).toEqual([]);
  });

  it('an object without Gravity is never judged (nothing else falls)', () => {
    const body = new RemotePhysicsObject({
      position: { cell: CELL, pos: { x: 50, y: 0, z: 0 }, orient: { w: 1, x: 0, y: 0, z: 0 } },
      state: 0,
    });
    simulate(body, hill(2), 3);
    expect(body.sliding).toBe(false);
    expect(body.pos.y).toBeGreaterThan(FOOT + 5);
  });
});

describe('BUG.ac1999-monster-jitter: the [AC:Move] correction line tells a held server copy from an oscillating one', () => {
  const sample = (sx: number, cx: number) => ({
    guid: 0x8000_0a1c, name: 'Drudge Slinker', cell: 0xa9b40017,
    server: { x: sx, y: 20, z: 3 }, client: { x: cx, y: 20, z: 4 },
    movingTo: true, sliding: false, contact: true, result: 'interpolate',
  });

  it('a correction a metre or more from our copy is reported with both positions', () => {
    expect(correctionLine(sample(100, 100.5))).toBeNull();
    expect(correctionLine(sample(100, 101.25))).toBe(
      '[AC:Move] correction 0x80000a1c "Drudge Slinker" 1.25 m: server=(100.0, 20.0, 3.0) cell 0xa9b40017 '
      + 'client=(101.3, 20.0, 4.0) movingTo=1 sliding=0 contact=1 interpolate');
  });

  it('at most one line a second per creature', () => {
    const lines: string[] = [];
    const log = new CreatureCorrectionLog((l) => lines.push(l));
    for (let t = 0; t < 2000; t += 200) log.report(sample(100, 102), t);
    expect(lines).toHaveLength(Math.ceil(2000 / CORRECTION_REPORT_INTERVAL_MS));
    log.report({ ...sample(100, 102), guid: 0x80000a1d }, 1900);
    expect(lines).toHaveLength(3);
  });

  it('the agent daemon keeps the line in its log', () => {
    expect(pageLogLine(correctionLine(sample(100, 102))!)).toMatch(/\[page\] \[AC:Move\] correction 0x80000a1c/);
  });
});
