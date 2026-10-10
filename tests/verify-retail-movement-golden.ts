/**
 * Golden traces from the retail client (docs/movement-ab.md): the recorded
 * retail run of tools/retail-movement-ab.ts (what ACE received from the real
 * acclient.exe for each scripted key sequence, tests/fixtures/movement-ab/)
 * against OUR movement code driven by the same timed keys in simulated time —
 * the real CameraController (CommandLists, turning, the movement it applies),
 * CharacterAnimController (input → motion-table substates, links included),
 * MotionManager / AnimationPlayer (the sequence) and player/LocalSequenceStep
 * (UpdatePositionInternal: the body moves by the sequence's root offset), with
 * the human motion table from portal.dat in the stance retail was in.
 *
 * Before BUG.local-movement-ignores-links the body moved at the run cycle's
 * averaged velocity from the first frame: four 0.5 s run taps (stop-start)
 * covered 13.2 m against retail's 7.45 m, and every start / stop was off by
 * the start link's slow steps and the stop link's coast.
 *
 * The send rules for a jump (ClientCombatSystem::CommenceJump / DoJump) are
 * checked on MovementSync's real wire bytes against the same capture.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { parseMoveToStatePayload } from '@ac/network';
import { GameActionType } from '@ac/network';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { localSequenceStep } from '../packages/renderer/src/player/LocalSequenceStep.js';
import { AnimationPlayer } from '../packages/renderer/src/animation/AnimationPlayer.js';
import { identityFrame, type SequenceMotion } from '../packages/renderer/src/animation/SequenceFrame.js';
import { RUN_ANIM_SPEED, getClientRunRate } from '@ac/shared';
import { maybeStopCompletely } from '../packages/renderer/src/controllers/StopCompletely.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { SCENARIOS } from '../tools/lib/movement-scenarios.ts';

type TrackRow = [number, string, number, number, number, number, number];
interface GoldenScenario {
  style: 'Magic' | 'NonCombat';
  displacement: { fwd: number; right: number };
  finalHeading: number;
  track: TrackRow[];
  moveToState: Array<Record<string, unknown>>;
  jumps: Array<{ t: number; extent: number; v: number[] }>;
  counts: { mts: number; ap: number };
  casts?: Array<{ t: number; spell: number }>;
  cast?: { result: string; ms: number };
}
const GOLDEN = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/movement-ab/retail-2026-10-04.json'), 'utf8')) as { scenarios: Record<string, GoldenScenario> };

/**
 * The retail mover's run rate, from the capture itself: its running jump's
 * launch velocity (get_leave_ground_velocity → get_state_velocity) is
 * RunForward × run_anim_speed × run rate = 6.54 m/s forward.
 */
const RETAIL_RUN_RATE = GOLDEN.scenarios['jump-run'].jumps[0].v[1] / RUN_ANIM_SPEED;
/** The retail default keymap's backpedal (Move Backward) is X; ours maps it to the canonical KeyS. */
const CANONICAL: Record<string, string> = { KeyX: 'KeyS' };
const HUMAN_MOTION_TABLE = 0x09000001;
/**
 * The cast recordings' mover was @god'd: Run = 9999 (Quickness) + 5000 init
 * + 226 ranks = 15225, and the retail client's GetRunRate @ 006b0950 caps at
 * exactly 800 only, so its run rate is (15225/15425 · 11 + 4) / 4 ≈ 3.71
 * (getClientRunRate) — 14.9 m/s, what the capture shows.
 */
const GOD_RUN_RATE = getClientRunRate(0, 15225);
const FRAME = 1 / 60;

interface SimFrame { t: number; right: number; fwd: number; heading: number }

/**
 * Our movement for a scenario: each key at the time the retail client acted
 * on it (retailKeyTimes), 60 frames/s,
 * each frame the main loop's order: CameraController.update (turn + the
 * sequence step's movement), then CharacterAnimController.update (substate
 * changes from the keys).
 */
function simulate(name: string, style: number, keyTimes: number[], endMs: number, runRate = RETAIL_RUN_RATE, wire?: MovementSync, clock?: { t: number }): SimFrame[] {
  const s = SCENARIOS.find((x) => x.name === name)!;
  const mm = new MotionManager(openDat(DAT_PATHS.portal));
  mm.loadMotionTable(HUMAN_MOTION_TABLE);
  mm.setDefaultStance(1);
  const anim = new CharacterAnimController(mm);
  anim.runRate = runRate;
  if (style !== MotionStance.NonCombat) {
    anim.setStance(style);
    for (let i = 0; i < 300; i++) mm.update(FRAME); // the stance change settles
  }
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.runRate = runRate;
  cam.sequenceStep = (dt, st) => localSequenceStep({ motionManager: mm, update: (d, m) => mm.update(d, m) }, dt, st);
  const out: SimFrame[] = [];
  const state = (): MovementState => ({ forward: cam.isMovingForward, backward: cam.isMovingBackward, turnLeft: cam.isTurningLeft, turnRight: cam.isTurningRight, strafeLeft: cam.isStrafingLeft, strafeRight: cam.isStrafingRight, running: cam.isRunning });
  // Where the wire is concerned only that the body moves: the start spot plus the scene offset.
  const pos = (): PlayerPosition => ({ worldX: 85 + 169 * 192 + cam.camera.position.x, worldZ: 20.5 + 180 * 192 + cam.camera.position.z, groundY: 94, playerYaw: cam.playerYaw, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true });
  let ei = 0;
  for (let i = 0; i * FRAME * 1000 <= endMs; i++) {
    const t = i * FRAME * 1000;
    if (clock) clock.t = t;
    while (ei < s.events.length && keyTimes[ei] <= t) {
      const [, dir, code] = s.events[ei++];
      const k = CANONICAL[code] ?? code;
      if (code === 'Digit1') {
        // The spell bar's cast: ClientMagicSystem::CastSpell @ 00568040 →
        // cmdinterp->MaybeStopCompletely(), wired as main.ts wires it.
        if (dir === 'down') {
          maybeStopCompletely({
            controlledByServer: () => false,
            clearAllCommands: () => cam.stopCompletely(),
            stopPhysics: () => anim.stopCompletely(cam),
            sendMovementEvent: () => wire?.sendMovementEventNow(state(), pos(), t),
          });
        }
        continue;
      }
      if (dir === 'down') cam.simulateKeyDown(k); else cam.simulateKeyUp(k);
    }
    cam.update(FRAME);
    anim.update(FRAME, cam);
    wire?.update(state(), pos(), t);
    // Scene axes: x = east, −z = north (forward at yaw 0 is (−sin yaw, −cos yaw)); right = east here.
    const p = cam.camera.position;
    const deg = ((cam.playerYaw * 180) / Math.PI % 360 + 360) % 360;
    out.push({ t: t + FRAME * 1000, right: -p.x, fwd: -p.z, heading: deg });
  }
  return out;
}

/**
 * When the retail client acted on each key event: the MoveToState it sent
 * for it (the first one within 150 ms after the event) — each key reaches
 * the retail client 15–80 ms after the driver posts it and is acted on at
 * its next frame — else the scenario's median latency.
 */
function retailKeyTimes(name: string, g: GoldenScenario): number[] {
  const ev = SCENARIOS.find((x) => x.name === name)!.events.map((e) => e[0]);
  const mts = g.moveToState.map((m) => Number(m.t));
  const caused = ev.map((e) => mts.find((t) => t >= e && t - e <= 150));
  const lags = caused.flatMap((t, i) => (t === undefined ? [] : [t - ev[i]])).sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
  return ev.map((e, i) => caused[i] ?? e + median);
}

function at(frames: SimFrame[], t: number): SimFrame {
  let best = frames[0];
  for (const f of frames) { if (f.t <= t) best = f; else break; }
  return best;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Per-sample tolerance. A wire sample is the position at the frame the client
 * sent it, retail runs at its own frame rate and the driver's key timing jitters
 * by a frame or two, so a sample may be ~50 ms off: at run speed (6.5 m/s)
 * 0.33 m, plus 6% of the distance covered.
 */
const tolerance = (dist: number) => 0.45 + 0.06 * dist;

/**
 * Scenarios whose straight-north run reaches the stone the start spot faces
 * (~15 m ahead): retail slides along it (the r drift), our simulation has no
 * collision — samples past 14.5 m forward are not compared for them.
 */
const OBSTACLE = new Set(['run', 'shift-toggle', 'jump-run']);

const haveDat = existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('BUG.local-movement-ignores-links — our movement against the retail golden traces', () => {
  const sims = new Map<string, SimFrame[]>();
  const cases = Object.entries(GOLDEN.scenarios).filter(([n]) => !n.startsWith('jump') && !n.startsWith('cast'));
  beforeAll(() => {
    for (const [name, g] of cases) {
      const keyTimes = retailKeyTimes(name, g);
      const end = g.track[g.track.length - 1][0];
      sims.set(name, simulate(name, g.style === 'Magic' ? MotionStance.Magic : MotionStance.NonCombat, keyTimes, end));
    }
  });

  it('the retail run rate comes from the capture (6.54 m/s jump launch / run_anim_speed 4)', () => {
    expect(RETAIL_RUN_RATE).toBeCloseTo(1.635, 3);
  });

  for (const [name, g] of cases) {
    it(`${name} (${g.style}): every retail position sample, and the resting spot, within ${'0.45 m + 6%'}`, () => {
      const frames = sims.get(name)!;
      const misses: string[] = [];
      for (const [t, kind, right, fwd] of g.track) {
        if (OBSTACLE.has(name) && fwd > 14.5) continue;
        const f = at(frames, t);
        const err = Math.hypot(f.right - right, f.fwd - fwd);
        if (err > tolerance(Math.hypot(right, fwd))) misses.push(`${kind}@${t}: retail (${right}, ${fwd}) ours (${f.right.toFixed(2)}, ${f.fwd.toFixed(2)})`);
      }
      expect(misses).toEqual([]);
    });
    it(`${name}: the heading after the turns within 6°`, () => {
      const frames = sims.get(name)!;
      const last = frames[frames.length - 1];
      expect(angleDiff(last.heading, g.finalHeading)).toBeLessThanOrEqual(6);
    });
  }

  it('stop-start: the start link and the stop link set the pace — 7.45 m in retail, not the 13.2 m of the averaged run velocity', () => {
    const frames = sims.get('stop-start')!;
    const end = frames[frames.length - 1];
    expect(end.fwd).toBeGreaterThan(7.45 * 0.95);
    expect(end.fwd).toBeLessThan(7.45 * 1.05);
  });
});

/**
 * BUG.cast-while-moving-keeps-moving — the second retail recording: Heal
 * Self VI on the spell bar (Digit1) at 0.8 s while W, C or W+C stay held to
 * 4.8 s. Retail's CastSpell @ 00568040 calls cmdinterp->MaybeStopCompletely
 * (CommandInterpreter::StopCompletely @ 006b3b50: ClearAllCommands, autorun
 * off, CMotionInterp::StopCompletely → Ready, SendMovementEvent) before the
 * cast goes out. The player coasts the stop link and stays put with the keys
 * still down; the key-ups send nothing. Before the port ours ran on through
 * the cast (15.4 m against retail's 11.3 m in cast-run, and the
 * run-strafe cast was "Your movement disrupted spell casting!").
 */
describe.skipIf(!haveDat)('BUG.cast-while-moving-keeps-moving — casting while moving against the retail golden traces', () => {
  const casts = Object.entries(GOLDEN.scenarios).filter(([n]) => n.startsWith('cast'));
  const runs = new Map<string, { frames: SimFrame[]; wire: Array<{ t: number; kind: number; bytes: Uint8Array }>; castAt: number }>();
  beforeAll(() => {
    for (const [name, g] of casts) {
      const keyTimes = retailKeyTimes(name, g);
      const clock = { t: 0 };
      const wire: Array<{ t: number; kind: number; bytes: Uint8Array }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { wire.push({ t: clock.t, kind: new DataView(b.buffer, b.byteOffset).getUint32(8, true), bytes: b }); } } as any, () => 1);
      const end = g.track[g.track.length - 1][0] + 3000;
      const frames = simulate(name, MotionStance.Magic, keyTimes, end, GOD_RUN_RATE, sync, clock);
      const castAt = keyTimes[SCENARIOS.find((x) => x.name === name)!.events.findIndex((e) => e[2] === 'Digit1')];
      runs.set(name, { frames, wire, castAt });
    }
  });

  /**
   * The sample-timing allowance of `tolerance` (a wire sample ~50 ms off) at
   * this mover's speed: 50 ms of a 4 × 3.71 = 14.9 m/s run is 0.74 m.
   */
  const castTolerance = (dist: number) => 0.05 * RUN_ANIM_SPEED * GOD_RUN_RATE + 0.06 * dist;

  it('the recording has the three cast scenarios, each cast landing', () => {
    expect(casts.map(([n]) => n)).toEqual(['cast-run', 'cast-strafe', 'cast-run-strafe']);
    for (const [, g] of casts) expect(g.cast?.result).toMatch(/^You cast Heal Self VI/);
  });

  for (const [name, g] of casts) {
    it(`${name}: every retail position sample, and the resting spot, within 50 ms of god-speed running + 6%`, () => {
      const { frames } = runs.get(name)!;
      const misses: string[] = [];
      for (const [t, kind, right, fwd] of g.track) {
        const f = at(frames, t);
        if (Math.hypot(f.right - right, f.fwd - fwd) > castTolerance(Math.hypot(right, fwd))) misses.push(`${kind}@${t}: retail (${right}, ${fwd}) ours (${f.right.toFixed(2)}, ${f.fwd.toFixed(2)})`);
      }
      expect(misses).toEqual([]);
    });

    it(`${name}: the keys stay down to 4.8 s but the body stops for good after the cast (within 10% of retail's ${g.displacement.fwd} f / ${g.displacement.right} r)`, () => {
      const { frames } = runs.get(name)!;
      const end = frames[frames.length - 1];
      const held = at(frames, 4700);
      expect(Math.hypot(end.fwd - held.fwd, end.right - held.right)).toBeLessThan(0.01);
      for (const [ours, retail] of [[end.fwd, g.displacement.fwd], [end.right, g.displacement.right]]) {
        expect(Math.abs(ours - retail)).toBeLessThanOrEqual(Math.max(0.1 * Math.abs(retail), 0.3));
      }
    });

    it(`${name}: the stopped MoveToState goes out with the cast, and nothing after (retail: ${g.counts.mts} MoveToStates)`, () => {
      const { wire, castAt } = runs.get(name)!;
      const mts = wire.filter((m) => m.kind === GameActionType.MoveToState);
      expect(mts).toHaveLength(g.counts.mts);
      const last = mts[mts.length - 1];
      // The frame that takes the cast key (the first at or after retail's cast time).
      expect(last.t).toBeGreaterThanOrEqual(castAt);
      expect(last.t - castAt).toBeLessThan(FRAME * 1000);
      const { motion } = parseMoveToStatePayload(last.bytes.subarray(12));
      expect(motion.forwardCommand ?? 0).toBe(0);
      expect(motion.sidestepCommand ?? 0).toBe(0);
      expect(motion.turnCommand ?? 0).toBe(0);
      expect(g.moveToState[g.moveToState.length - 1]).toMatchObject({ t: g.casts![0].t, flags: '0x3' });
    });
  }
});

describe('jump send rules against the retail capture (CommenceJump @ 0056af90, DoJump @ 0056b110, SendPositionEvent @ 006b4770)', () => {
  const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: Math.PI, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
  const idle: MovementState = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
  function capture() {
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
    const kind = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(8, true);
    return { sync, sent, mts: () => sent.filter((m) => kind(m) === GameActionType.MoveToState), ap: () => sent.filter((m) => kind(m) === GameActionType.AutonomousPosition) };
  }

  it('jump-stand: one MoveToState at the charge (contact + standing long jump), none at the release, no AutonomousPosition in the air or on landing', () => {
    const g = GOLDEN.scenarios['jump-stand'];
    expect(g.counts).toEqual({ mts: 1, ap: 0 });
    expect(g.moveToState[0].clj).toBe(3);
    const c = capture();
    c.sync.update(idle, POS, 0); // the arrival position (before the scenario)
    const before = c.sent.length;
    let t = 1000;
    // Space down: charge (standing still → standing long jump), held 400 ms.
    for (; t < 1400; t += 16) c.sync.update({ ...idle, jumpCharging: true, standingLongJump: true }, POS, t);
    // Release: DoJump sends the Jump; the body is airborne ~0.6 s, then lands on the same spot.
    c.sync.noteJump();
    for (let k = 0; t < 2000; t += 16, k++) c.sync.update(idle, { ...POS, groundY: 94 + Math.sin((k / 37) * Math.PI) * 0.37, onGround: false }, t);
    for (; t < 4400; t += 16) c.sync.update(idle, POS, t);
    const mts = c.mts();
    expect(mts).toHaveLength(1);
    const tail = parseMoveToStatePayload(mts[0].subarray(12)).position;
    expect(tail.standingLongJump).toBe(true);
    expect(tail.contact).toBe(true);
    expect(c.sent.length - before).toBe(1);
  });

  it('jump-run: the charge resends the unchanged running state (retail\'s second MoveToState); the flight sends no position', () => {
    const g = GOLDEN.scenarios['jump-run'];
    expect(g.moveToState.map((m) => m.fwd ?? null)).toEqual(['WalkForward', 'WalkForward', null]);
    const c = capture();
    const run = { ...idle, forward: true };
    c.sync.update(run, POS, 0);
    const mtsBefore = c.mts().length;
    let t = 16; let x = POS.worldX;
    const step = (s: MovementState, onGround: boolean) => { x += 0.1; c.sync.update(s, { ...POS, worldX: x, onGround }, t); t += 16; };
    while (t < 1000) step(run, true);
    while (t < 1150) step({ ...run, jumpCharging: true }, true);
    expect(c.mts().length - mtsBefore).toBe(1);
    c.sync.noteJump();
    const apBefore = c.ap().length;
    while (t < 1700) step(run, false);
    expect(c.ap().length).toBe(apBefore);
    // Back on the ground the usual rule resumes (the contact plane is back, the position has moved).
    while (t < 3000) step(run, true);
    expect(c.ap().length).toBeGreaterThan(apBefore);
  });

  it('a walk-off-ledge fall (no Jump) still reports the descent (GAP.7, ACE falling damage)', () => {
    const c = capture();
    c.sync.update(idle, POS, 0);
    const n = c.ap().length;
    c.sync.update(idle, { ...POS, groundY: 90, onGround: false }, 16);
    expect(c.ap().length).toBe(n + 1);
  });
});

describe('advance_to_next_animation @ 005252b0 — arriving on a forward node moves the body by its starting frame', () => {
  const anim = (dy: number[]) => ({
    numFrames: dy.length, partFrames: dy.map(() => ({ frames: [], hooks: [] })),
    posFrames: dy.map((y) => ({ origin: { x: 0, y, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } })),
  });
  const sink = (): SequenceMotion => ({ frame: identityFrame(), velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } });

  it('enterNode combines the starting frame (forward) and nothing for a backwards node', () => {
    const p = new AnimationPlayer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.play(anim([0.5, 0.1, 0.1]) as any, 0, 2, 30, 1, false);
    const m = sink();
    p.enterNode(m);
    expect(m.frame.origin.y).toBeCloseTo(0.5, 6);
    const b = new AnimationPlayer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.play(anim([0.5, 0.1, 0.1]) as any, 0, 2, 30, -1, false);
    const mb = sink();
    b.enterNode(mb);
    expect(mb.frame.origin.y).toBe(0);
  });

  it('a looping node: every wrap re-enters it, so a loop moves by all N frames (frame 0 twice, the clamped last frame never)', () => {
    const p = new AnimationPlayer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.play(anim([1, 0, 0, 0]) as any, 0, 3, 30, 1, true);
    const m = sink();
    p.update(4 / 30 + 1e-6, m); // one loop and a hair: steps 0..2 (+1), the wrap's arrival (+1)
    expect(m.frame.origin.y).toBeCloseTo(2, 6);
  });
});
