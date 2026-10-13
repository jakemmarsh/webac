/**
 * MOVE.chunked-motion-judder — the stutter / "motion blur" players reported on
 * fast and combined motions at launch (2026-10-12).
 *
 * Retail moves a body only when its sequence steps over a whole animation
 * frame (CSequence::update_internal @ 005255d0 folds the frame's pos-frame
 * in and apply_physics @ 00524ab0 runs for 1 / framerate per frame stepped):
 * a run cycle at 30 × the run rate fps moves the body in ~0.13 m jumps. Drawn
 * at the browser's 60–144 Hz that is a staircase — 144 Hz at run rate 1.5
 * drew 0, 0, 0, 19.2 m/s… — and the camera, aimed at the body, carried it to
 * the whole screen. The fix draws the body (and aims the camera) along each
 * step at the elapsed fraction of the step interval (animation/StepSmoother);
 * the simulated position is untouched.
 *
 * The harness drives the real modules frame by frame the way main.ts does
 * (CameraController.update → the sequence step → the body moves; then
 * CharacterAnimController.update; the draw lag; RetailCameraRig at the
 * player's stiffness) at 60 / 120 / 144 Hz with jittered frame times, and
 * records per-frame simulated and drawn positions, heading and camera. Remote
 * objects run through the real ServerObjectManager.updateAnimations with a
 * real AnimatedEntity on the human motion table.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { AnimationPlayer } from '../packages/renderer/src/animation/AnimationPlayer.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig } from '../packages/renderer/src/scene/RetailCameraRig.js';
import { FrameClock } from '../packages/renderer/src/scene/FrameClock.js';
import { localSequenceStep } from '../packages/renderer/src/player/LocalSequenceStep.js';
import { StepSmoother, updateLocalStepLag, FADE_SECONDS } from '../packages/renderer/src/animation/StepSmoother.js';
import { RemotePhysicsObject } from '../packages/renderer/src/world/RemotePhysics.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsState } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';

const HAVE_DAT = existsSync(DAT_PATHS.portal);
const HUMAN = 0x09000001;

/** A seeded RNG (mulberry32) so the jittered frame times repeat. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame times at `hz`, each ±`jitter` (fraction) of the period. */
function frameTimes(hz: number, seconds: number, jitter: number, seed = 7): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let t = 0;
  while (t < seconds) {
    const dt = (1 / hz) * (1 + (r() * 2 - 1) * jitter);
    out.push(dt);
    t += dt;
  }
  return out;
}

interface Sample { dt: number; sim: THREE.Vector3; draw: THREE.Vector3; yaw: number; cam: THREE.Vector3 }

/**
 * Per-frame speeds (m/s) of a track over [from, to) seconds. `which` picks
 * the simulated or the drawn position, or the camera.
 */
function speeds(track: Sample[], which: 'sim' | 'draw' | 'cam', from: number, to: number): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 1; i < track.length; i++) {
    t += track[i].dt;
    if (t < from || t >= to) continue;
    out.push(track[i][which].distanceTo(track[i - 1][which]) / track[i].dt);
  }
  return out;
}

/** How uneven a run of per-frame speeds is. */
function judder(v: number[]): { mean: number; zeroFrames: number; ripple: number; jerk: number } {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let jerk = 0;
  for (let i = 1; i < v.length; i++) jerk = Math.max(jerk, Math.abs(v[i] - v[i - 1]));
  return {
    mean,
    zeroFrames: v.filter((s) => s < 0.05 * mean).length,
    ripple: (Math.max(...v) - Math.min(...v)) / mean,
    jerk: jerk / mean,
  };
}

interface LocalOptions { hz: number; jitter: number; keys: string[]; runRate: number; seconds: number; release?: { at: number; keys: string[] }; smooth?: boolean }

/** The local player, frame by frame in main.ts's order. */
function driveLocal(portal: ReturnType<typeof openDat>, o: LocalOptions): Sample[] {
  const mm = new MotionManager(portal);
  mm.loadMotionTable(HUMAN);
  mm.setDefaultStance(1);
  const anim = new CharacterAnimController(mm);
  anim.runRate = o.runRate;
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.runRate = o.runRate;
  cam.sequenceStep = (dt, st) => localSequenceStep({ motionManager: mm, update: (d, m) => mm.update(d, m) }, dt, st);
  const smoother = new StepSmoother();
  const rig = new RetailCameraRig();
  const player = mm.animationPlayer;
  for (const k of o.keys) cam.handleKeyDown(k);
  const sim = new THREE.Vector3();
  const track: Sample[] = [];
  let t = 0;
  let released = false;
  for (const dt of frameTimes(o.hz, o.seconds, o.jitter)) {
    t += dt;
    if (o.release && !released && t >= o.release.at) {
      for (const k of o.release.keys) cam.handleKeyUp(k);
      released = true;
    }
    const before = sim.clone();
    const prevCam = cam.camera.position.clone();
    cam.update(dt);
    sim.x += cam.camera.position.x - prevCam.x;
    sim.z += cam.camera.position.z - prevCam.z;
    const lag = o.smooth === false
      ? { x: 0, y: 0, z: 0, yaw: 0 }
      : updateLocalStepLag(smoother, {
        steps: player.takeSteps(), phase: player.stepPhase, epoch: player.nodeEpoch, sequenceDriven: true,
        before: { x: before.x, y: 0, z: before.z }, after: { x: sim.x, y: 0, z: sim.z }, dt,
      });
    const draw = new THREE.Vector3(sim.x - lag.x, 0, sim.z - lag.z);
    anim.update(dt, cam);
    rig.update({
      pivot: draw.clone().setY(1.6), facing: cam.playerYaw, back: 2.75, up: 0.825, inHead: false, inHeadAhead: 0, lookPitch: 0,
      align: false, velocity: { x: 0, y: 0, z: 0 }, contactNormal: null, tStiffness: cam.tStiffness, rStiffness: cam.rStiffness, dt,
    });
    rig.commit(rig.soughtPosition.clone());
    track.push({ dt, sim: sim.clone(), draw, yaw: cam.playerYaw, cam: rig.soughtPosition.clone() });
  }
  return track;
}

const MOTIONS: Array<{ name: string; keys: string[] }> = [
  { name: 'run', keys: ['KeyW'] },
  { name: 'run + turn', keys: ['KeyW', 'KeyD'] },
  { name: 'run + strafe', keys: ['KeyW', 'KeyC'] },
  { name: 'run + strafe + turn', keys: ['KeyW', 'KeyC', 'KeyA'] },
];

describe('StepSmoother — draw a stepping body between its steps', () => {
  it('even steps draw as even per-frame motion, never ahead of the simulation', () => {
    const s = new StepSmoother();
    // A source stepping 0.1 m every 1/45 s, drawn at 144 Hz.
    const rate = 45, dt = 1 / 144;
    let frame = 0, sim = 0, prevDraw = 0;
    const v: number[] = [];
    for (let i = 0; i < 400; i++) {
      const next = frame + rate * dt;
      const steps = Math.floor(next) - Math.floor(frame);
      frame = next;
      sim += steps * 0.1;
      const lag = s.update(steps, { x: steps * 0.1, y: 0, z: 0, yaw: 0 }, frame - Math.floor(frame), dt);
      const draw = sim - lag.x;
      expect(draw).toBeLessThanOrEqual(sim + 1e-12);
      expect(sim - draw).toBeLessThanOrEqual(0.1 + 1e-9);
      if (i > 10) v.push((draw - prevDraw) / dt);
      prevDraw = draw;
    }
    for (const x of v) expect(x).toBeCloseTo(4.5, 6); // 0.1 m × 45 Hz, every frame
  });
  it('a lag left when stepping stops fades out within FADE_SECONDS; a restart without a step keeps the drawn position', () => {
    const s = new StepSmoother();
    s.update(1, { x: 0.12, y: 0, z: 0, yaw: 0 }, 0.25, 1 / 60, 1);
    expect(s.lag.x).toBeCloseTo(0.09, 9);
    // A new node (epoch 2) restarts the interval at phase 0 with no step: the lag holds, then closes.
    s.update(0, null, 0, 1 / 120, 2);
    expect(s.lag.x).toBeCloseTo(0.09, 9);
    s.update(0, null, 0.5, 1 / 120, 2);
    expect(s.lag.x).toBeCloseTo(0.045, 9);
    // Not stepping (a framerate-0 node, airborne): gone after FADE_SECONDS.
    s.update(0, null, null, FADE_SECONDS / 2);
    expect(s.lag.x).toBeCloseTo(0.0225, 9);
    s.update(0, null, null, FADE_SECONDS);
    expect(s.lag.x).toBe(0);
  });
  it('a step too long to be a step (a teleport inside a frame) is not drawn as a lag', () => {
    const s = new StepSmoother();
    s.update(1, { x: 50, y: 0, z: 0, yaw: 0 }, 0.1, 1 / 60);
    expect(s.lag.x).toBe(0);
  });
});

describe('FrameClock — the frame simulates to the rAF timestamp', () => {
  it('uses the timestamp, never runs backwards, and falls back to the clock without one', () => {
    const c = new FrameClock();
    expect(c.next(1000, 1004.2)).toBe(1000); // the frame began at 1000; the callback ran 4.2 ms late
    expect(c.next(1016.67, 1018)).toBe(1016.67);
    expect(c.next(undefined, 1030)).toBe(1030); // the background beat
    expect(c.next(1025, 1031)).toBe(1030); // a frame that began before that beat: no time passes
    expect(c.next(5000, 1040)).toBe(1040); // a timestamp from the future is not trusted
  });
  it('even frames presented late by uneven amounts still advance the world evenly', () => {
    const c = new FrameClock();
    const r = rng(3);
    let last = c.next(0, 0);
    for (let i = 1; i < 100; i++) {
      const ts = i * 1000 / 60;
      const t = c.next(ts, ts + r() * 9); // the callback runs 0–9 ms into the frame
      expect(t - last).toBeCloseTo(1000 / 60, 9);
      last = t;
    }
  });
});

describe.skipIf(!HAVE_DAT)('MOVE.chunked-motion-judder — the local player on the human motion table (0x09000001)', () => {
  let portal: ReturnType<typeof openDat>;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  it('before: the simulated body moves in whole-frame steps (zero-move frames between double moves)', () => {
    const track = driveLocal(portal, { hz: 144, jitter: 0, keys: ['KeyW'], runRate: 1.5, seconds: 3, smooth: false });
    const j = judder(speeds(track, 'sim', 1.5, 3));
    // Run rate 1.5: the cycle steps at 45 fps, so ~2 of every 3 frames at 144 Hz do not move.
    expect(j.zeroFrames).toBeGreaterThan(100);
    expect(j.ripple).toBeGreaterThan(2);
  });

  for (const hz of [60, 120, 144]) {
    for (const runRate of [1.5, 2.9]) {
      for (const m of MOTIONS) {
        it(`${m.name} at ${hz} Hz, run rate ${runRate}, ±25% frame-time jitter: the drawn body and the camera move every frame, evenly`, () => {
          const track = driveLocal(portal, { hz, jitter: 0.25, keys: m.keys, runRate, seconds: 3 });
          const sim = judder(speeds(track, 'sim', 1.5, 3));
          const draw = judder(speeds(track, 'draw', 1.5, 3));
          const cam = judder(speeds(track, 'cam', 1.5, 3));
          const rawCam = judder(speeds(driveLocal(portal, { hz, jitter: 0.25, keys: m.keys, runRate, seconds: 3, smooth: false }), 'cam', 1.5, 3));
          if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: m.name, hz, runRate, sim, draw, rawCam, cam }));
          // Same distance: the drawn body follows the simulation (it lags by under one step).
          const last = track[track.length - 1];
          expect(last.sim.distanceTo(last.draw)).toBeLessThan(0.15);
          expect(draw.mean).toBeCloseTo(sim.mean, 0);
          expect(draw.zeroFrames).toBe(0);
          expect(cam.zeroFrames).toBe(0);
          // The run cycle has no pos-frame gait, so its drawn speed is flat to within a few %
          // (the sidestep modifier, the cycle's own pos-frames and the turn add their small ripple).
          expect(draw.ripple).toBeLessThan(m.name === 'run' ? 0.05 : 0.6);
          expect(draw.jerk).toBeLessThan(m.name === 'run' ? 0.05 : 0.3);
          expect(cam.jerk).toBeLessThan(0.3);
          if (hz >= 120) expect(sim.zeroFrames).toBeGreaterThan(0); // the staircase it smooths
          // Heading advances by turn rate × dt every frame (no stepping).
          if (m.keys.includes('KeyD') || m.keys.includes('KeyA')) {
            const rates = track.slice(1).map((s, i) => Math.abs(s.yaw - track[i].yaw) / s.dt);
            const steady = rates.slice(Math.floor(rates.length / 2));
            expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(1e-6);
          }
        });
      }
    }
  }

  it('on release the drawn body coasts with the stop link and comes to rest exactly on the simulated position', () => {
    const track = driveLocal(portal, { hz: 144, jitter: 0.25, keys: ['KeyW'], runRate: 2.9, seconds: 3, release: { at: 1.5, keys: ['KeyW'] } });
    const last = track[track.length - 1];
    expect(last.draw.distanceTo(last.sim)).toBeLessThan(1e-9);
  });

  it('a strafe alone (the sidestep cycle\'s own pos-frame gait): no zero-move frames, its speed changes smoothly', () => {
    const track = driveLocal(portal, { hz: 144, jitter: 0.25, keys: ['KeyZ'], runRate: 2.9, seconds: 3 });
    const before = judder(speeds(driveLocal(portal, { hz: 144, jitter: 0.25, keys: ['KeyZ'], runRate: 2.9, seconds: 3, smooth: false }), 'sim', 1.5, 3));
    const after = judder(speeds(track, 'draw', 1.5, 3));
    if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: 'strafe', before, after }));
    expect(before.zeroFrames).toBeGreaterThan(50);
    expect(after.zeroFrames).toBe(0);
    expect(after.jerk).toBeLessThan(0.35); // the gait itself (before: ~3)
  });
});

// ─── every era's motion data (shared movement code, each era's own DAT) ──────

const ERA_PORTALS: Array<[string, string]> = [
  ['end of retail', DAT_PATHS.portal],
  ['Dark Majesty (classic-dereth)', 'dat/sets/classic-dereth/client_portal.dat'],
  ['AC1999', 'dat/sets/ac1999-retail/portal.dat'],
];
for (const [era, path] of ERA_PORTALS) {
  describe.skipIf(!existsSync(resolve(__dirname, '..', path)))(`MOVE.chunked-motion-judder — ${era} human motion table`, () => {
    let portal: ReturnType<typeof openDat>;
    beforeAll(() => { portal = openDat(path); });
    it('run + strafe + turn at 144 Hz with jittered frames: the simulation steps, the drawn body does not', () => {
      const track = driveLocal(portal, { hz: 144, jitter: 0.25, keys: ['KeyW', 'KeyC', 'KeyA'], runRate: 2.2, seconds: 3 });
      const sim = judder(speeds(track, 'sim', 1.5, 3));
      const draw = judder(speeds(track, 'draw', 1.5, 3));
      if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: `era ${era}`, sim, draw }));
      expect(sim.mean).toBeGreaterThan(4);
      expect(sim.zeroFrames).toBeGreaterThan(0);
      expect(draw.zeroFrames).toBe(0);
      expect(draw.jerk).toBeLessThan(0.3);
    });
  });
}

// ─── remote objects (ServerObjectManager.updateAnimations) ─────────────────

const STYLE = 0x8000003d;
const LB = 0xA9B40017;

function data(guid: number): CreateObjectData {
  return {
    guid, name: 'Peer', weenieClassId: 1, itemType: 0x10, setupId: 0x02000001, motionTableId: 0,
    position: { landblock: LB, x: 100, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 },
    iconId: 0, physicsState: PhysicsState.Gravity, objectDescFlags: 0, radarColor: 0, radarBehavior: 0, basePalette: 0,
    subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0,
    parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0,
    useRadius: 0.6, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0,
    defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
  } as CreateObjectData;
}

/** 0xF74C body: an InterpretedMotionState (style, forward + speed, optional turn + speed). */
function interpreted(fwd: number, fwdSpeed: number, turn = 0, turnSpeed = 1): Uint8Array {
  const flags = 0x1 | 0x2 | 0x4 | (turn ? 0x20 | 0x40 : 0);
  const bytes: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0x3d, 0];
  const push32 = (v: number) => bytes.push(...new Uint8Array(new Uint32Array([v]).buffer));
  const pushF = (v: number) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  const push16 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  push32(flags);
  push16(0x3d); push16(fwd & 0xffff);
  if (turn) push16(turn & 0xffff);
  pushF(fwdSpeed);
  if (turn) pushF(turnSpeed);
  return new Uint8Array(bytes);
}

describe.skipIf(!HAVE_DAT)('MOVE.chunked-motion-judder — remote players / creatures (ServerObjectManager)', () => {
  let portal: ReturnType<typeof openDat>;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  async function drivePeer(hz: number, motion: Uint8Array): Promise<{ sim: number[]; draw: number[]; yawDraw: number[]; dts: number[] }> {
    const { AnimatedEntity } = await import('../packages/renderer/src/animation/AnimatedEntity.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => new THREE.Group();
    som.setPlayerGuid(0x50000001);
    som.setTerrainCollision({ getHeightAt: () => 10 } as never);
    som.localPlayerPosition = () => ({ x: 0xa9 * 192 + 100, z: 0xb4 * 192 + 110, y: 10, radius: 0.45, height: 1.8 });
    const obj = som.createObject(data(0x80000200))!;
    const entity = new AnimatedEntity(obj.mesh as THREE.Group, portal);
    entity.initFromMotionTable(HUMAN);
    som.registerAnimatedEntity(obj.guid, entity);
    som.handleMovementEvent({ guid: obj.guid, movementData: motion } as never);
    const sim: number[] = [], draw: number[] = [], yawDraw: number[] = [], dts: number[] = [];
    let p0 = { x: obj.worldX, z: obj.worldZ };
    let d0 = obj.mesh!.position.clone();
    let q0 = obj.mesh!.quaternion.clone();
    let t = 0;
    for (const dt of frameTimes(hz, 3, 0.25)) {
      som.updateAnimations(dt);
      t += dt;
      if (t > 1.5) {
        sim.push(Math.hypot(obj.worldX - p0.x, obj.worldZ - p0.z) / dt);
        draw.push(obj.mesh!.position.distanceTo(d0) / dt);
        yawDraw.push(obj.mesh!.quaternion.angleTo(q0) / dt);
        dts.push(dt);
      }
      p0 = { x: obj.worldX, z: obj.worldZ };
      d0 = obj.mesh!.position.clone();
      q0 = obj.mesh!.quaternion.clone();
    }
    return { sim, draw, yawDraw, dts };
  }

  for (const hz of [60, 144]) {
    it(`a peer running (RunForward 2.9) at ${hz} Hz: the mesh moves every frame, evenly`, async () => {
      const r = await drivePeer(hz, interpreted(MotionCommand.RunForward, 2.9));
      const sim = judder(r.sim), draw = judder(r.draw);
      if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: 'peer run', hz, sim, draw }));
      expect(draw.mean).toBeCloseTo(sim.mean, 0);
      expect(sim.zeroFrames + Math.round(sim.ripple)).toBeGreaterThan(0); // the steps it smooths
      expect(draw.zeroFrames).toBe(0);
      expect(draw.ripple).toBeLessThan(0.05);
    });
    it(`a peer running and turning at ${hz} Hz: the mesh turns every frame, evenly`, async () => {
      const r = await drivePeer(hz, interpreted(MotionCommand.RunForward, 2.9, MotionCommand.TurnRight, 1.5));
      const turn = judder(r.yawDraw);
      if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: 'peer run+turn (yaw)', hz, draw: turn, pos: judder(r.draw) }));
      expect(turn.zeroFrames).toBe(0);
      expect(turn.ripple).toBeLessThan(0.05);
      expect(judder(r.draw).zeroFrames).toBe(0);
    });
  }
});

describe('MOVE.chunked-motion-judder — a remote body on its own velocity (MIN_QUANTUM updates)', () => {
  it('a peer\'s jump arc is drawn every frame at 144 Hz though it is simulated at 30 Hz', () => {
    const body = new RemotePhysicsObject({
      position: { cell: LB, pos: { x: 100, y: 100, z: 10 }, orient: { w: 1, x: 0, y: 0, z: 0 } },
      state: PhysicsState.Gravity,
    });
    body.contact = false; body.onWalkable = false;
    body.calcAcceleration();
    body.setVelocity({ x: 3, y: 0, z: 6 });
    const env = { terrainHeight: () => 0 };
    const sim: number[] = [], draw: number[] = [];
    let s0 = { ...body.pos }, d0 = body.drawPosition();
    for (let i = 0; i < 100; i++) {
      body.update(1 / 144, null, env, i / 144);
      const d = body.drawPosition();
      if (i > 10) {
        sim.push(Math.abs(body.pos.x - s0.x) * 144);
        draw.push(Math.abs(d.x - d0.x) * 144);
      }
      s0 = { ...body.pos }; d0 = d;
    }
    if (process.env.JUDDER_REPORT) console.log(JSON.stringify({ motion: 'peer jump', sim: judder(sim), draw: judder(draw) }));
    expect(judder(sim).zeroFrames).toBeGreaterThan(50);
    expect(judder(draw).zeroFrames).toBe(0);
    expect(judder(draw).ripple).toBeLessThan(0.05);
  });
  it('AnimationPlayer counts the frames that move the body and reports the phase to the next one', () => {
    const p = new AnimationPlayer();
    const anim = { numFrames: 10, partFrames: Array.from({ length: 10 }, () => ({ frames: [], hooks: [] })), posFrames: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.play(anim as any, 0, 9, 30, 1.5, true);
    const e = p.nodeEpoch;
    const m = { frame: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, velocity: { x: 0, y: 4, z: 0 }, omega: { x: 0, y: 0, z: 0 } };
    p.update(0.05, m); // 45 fps × 0.05 s = 2.25 frames
    expect(p.takeSteps()).toBe(2);
    expect(p.takeSteps()).toBe(0);
    expect(p.stepPhase).toBeCloseTo(0.25, 9);
    expect(p.nodeEpoch).toBe(e);
    p.update(0.05); // no root-motion sink: nothing moved
    expect(p.takeSteps()).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.play(anim as any, 0, 9, 0, 1, true);
    expect(p.nodeEpoch).toBe(e + 1);
    expect(p.stepPhase).toBeNull(); // framerate 0 moves by elapsed time
  });
});
