/**
 * BUG.remote-running-jump-snapback — an observer saw a peer's running jump
 * land ~1.5 m too far forward, then snap back.
 *
 * Root cause: our LOCAL player dropped its horizontal velocity at touchdown.
 * Retail keeps it (CMotionInterp::HitGround @ 00528ac0 sets no velocity) and
 * calc_friction @ 0050ee70 takes it away on the walkable (0.05^t, zeroed under
 * 0.25 m/s), on top of the run cycle's own motion: v / ln 20 metres of coast
 * (2.2 m for a 6.54 m/s run). The observer's copy (RemotePhysics, the same
 * functions) coasted that far; the jumper's own positions, which ACE relays,
 * did not, so the copy was pulled back. player/LandingCoast.ts now gives the
 * local body the coast.
 *
 * Covered here with the shipped code:
 *  - LandingCoast's quanta (friction, the small-velocity cut, the distance);
 *  - stepPlayerMovement carries the coast on top of the input motion;
 *  - the retail A/B capture (retail-sweep-2026-10-08.json): the real
 *    acclient.exe's positions after each recorded jump, replayed through our
 *    movement (tests/_harness/movement-sim.ts, now with the flight) — before
 *    (velocity dropped) and after;
 *  - two clients: A's movement in simulated time puts its MoveToStates,
 *    AutonomousPositions and Jump on the wire; an ACE relay turns them into
 *    the broadcasts ACE sends (Player.HandleActionJump: the blank UpdateMotion
 *    + VectorUpdate; BroadcastMovement's UpdateMotion; UpdatePosition, IsGrounded),
 *    as bytes, through the real ServerMessageHandler into an observer's
 *    ServerObjectManager — the copy's backward snap measured before and after;
 *  - a remote creature's jump (no local movement involved) is unchanged.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GameMessageOpcode } from '@ac/network';
import { PhysicsState, RUN_ANIM_SPEED } from '@ac/shared';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { SWEEP } from '../tools/lib/movement-scenarios.ts';
import { frameAt, retailKeyTimes, simulateKeys, type SimResult } from './_harness/movement-sim.js';
import { buildA9b4World } from './_harness/a9b4-world.js';
import {
  coastDistance, coastQuantum, landingGroundVelocity, bounceGroundVelocity, SMALL_VELOCITY,
} from '../packages/renderer/src/player/LandingCoast.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { MotionStance, MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { adjustMotion, HoldKey } from '../packages/renderer/src/world/RemoteMotion.js';
import { quatForHeading } from '../packages/renderer/src/world/Heading.js';
import type { DatDatabase } from '@ac/dat-parser';

const FIXTURE = resolve(__dirname, 'fixtures/movement-ab/retail-sweep-2026-10-08.json');
const haveFixture = existsSync(FIXTURE);
const haveDat = existsSync(DAT_PATHS.portal);

describe('LandingCoast — UpdatePhysicsInternal on a walkable (calc_friction @ 0050ee70)', () => {
  it('each quantum damps by (1 − 0.95)^q and moves by the damped velocity', () => {
    const r = coastQuantum({ x: 0, z: -6.54 }, 1 / 30);
    const k = Math.pow(0.05, 1 / 30);
    expect(r.velocity!.z).toBeCloseTo(-6.54 * k, 6);
    expect(r.dz).toBeCloseTo(-6.54 * k / 30, 6);
    expect(r.dx).toBe(0);
  });

  it('a velocity under small_velocity (read before the friction) is zeroed and moves nothing', () => {
    expect(coastQuantum({ x: SMALL_VELOCITY * 0.99, z: 0 }, 1 / 30)).toEqual({ dx: 0, dz: 0, velocity: null });
    expect(coastQuantum({ x: SMALL_VELOCITY * 1.01, z: 0 }, 1 / 30).velocity).not.toBeNull();
  });

  it('a 6.54 m/s landing coasts v / ln 20 ≈ 2.18 m at 60 Hz quanta, and stops within ~1.2 s', () => {
    let v = landingGroundVelocity(0, 6.54);
    let d = 0, t = 0;
    while (v) { const r = coastQuantum(v, 1 / 60); d += r.dz; v = r.velocity; t += 1 / 60; }
    expect(coastDistance(6.54)).toBeCloseTo(2.183, 3);
    expect(d).toBeGreaterThan(2.0);
    expect(d).toBeLessThan(2.2);
    expect(t).toBeLessThan(1.3);
  });

  it('a standing jump lands with nothing to coast; a wall bounces the coast (elasticity 0.05)', () => {
    expect(landingGroundVelocity(0, 0)).toBeNull();
    const b = bounceGroundVelocity({ x: 0, z: -4 }, { x: 0, z: 1 })!;
    expect(b.x).toBe(0);
    expect(b.z).toBeCloseTo(0.2, 6);
    expect(bounceGroundVelocity({ x: 3, z: 0 }, { x: 0, z: 1 })).toEqual({ x: 3, z: 0 });
  });
});

describe('stepPlayerMovement carries the ground velocity on top of the input motion', () => {
  const open = (): MovementServices => ({
    dungeonCollision: null,
    outdoorCollision: { collisionNormal: null } as never,
    terrain: {} as never,
  } as unknown as MovementServices);
  it('no input: the coast alone moves the body, and the velocity decays', () => {
    const svc = open();
    // outdoorAdjusted needs a collider: a world with nothing in it (no input and no coast ⇒ no call).
    const r = stepPlayerMovement({ x: 0, z: 0, floorY: 0, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, groundVelocity: { x: 0, z: -6 } }, 0, 0, 1 / 30, svc);
    const k = Math.pow(0.05, 1 / 30);
    expect(r.z).toBeCloseTo(-6 * k / 30, 6);
    expect(r.groundVelocity!.z).toBeCloseTo(-6 * k, 6);
    expect(r.coastMoved!.z).toBeCloseTo(-6 * k / 30, 6);
  });
  it('without a ground velocity nothing changes (the result carries none)', () => {
    const r = stepPlayerMovement({ x: 1, z: 2, floorY: 0, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, 0.1, 0, 1 / 30, open());
    expect(r).toEqual({ x: 1.1, z: 2, revertCamera: false });
  });
});

type TrackRow = [number, string, number, number, number, number, number];
interface Golden { style: string; track: TrackRow[]; moveToState: { t: number }[]; jumps: { t: number; v: number[] }[] }

const ourError = (sim: SimResult, g: Golden) => g.track.map(([t, , right, fwd]) => { const f = frameAt(sim.frames, t); return Math.hypot(f.right - right, f.fwd - fwd); });

describe.skipIf(!haveDat || !haveFixture)('the retail capture: our jumps against acclient.exe\'s positions', () => {
  let golden: Record<string, Golden> = {};
  let portal: DatDatabase;
  let services: Awaited<ReturnType<typeof buildA9b4World>>;
  let runRate = 0;
  beforeAll(async () => {
    golden = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { scenarios: Record<string, Golden> }).scenarios;
    runRate = golden['sweep-jump-W-releaseair'].jumps[0].v[1] / RUN_ANIM_SPEED;
    portal = openDat(DAT_PATHS.portal);
    services = await buildA9b4World();
  });
  const run = (name: string, drop: boolean) => {
    const s = SWEEP.find((x) => x.name === name)!;
    const g = golden[name];
    const keyTimes = retailKeyTimes(s.events, g.moveToState.map((m) => Number(m.t)));
    const endMs = Math.max(g.track[g.track.length - 1][0], keyTimes[keyTimes.length - 1]) + 1500;
    const style = g.style === 'Magic' ? MotionStance.Magic : MotionStance.NonCombat;
    return simulateKeys({ portal, events: s.events, keyTimes, endMs, style, runRate, world: () => services({ slidingNormal: null }, () => undefined), jumpVz: g.jumps[0].v[2], dropVelocityOnLanding: drop });
  };

  it('the flight launches what retail sent: the JumpPack velocity of every recorded jump', () => {
    for (const name of Object.keys(golden).filter((n) => n.startsWith('sweep-jump') && golden[n].jumps.length)) {
      const sim = run(name, false);
      const [vx, vy, vz] = golden[name].jumps[0].v;
      expect(sim.jumps.length, name).toBe(1);
      expect(sim.jumps[0].local.x, name).toBeCloseTo(vx, 1);
      expect(sim.jumps[0].local.y, name).toBeCloseTo(vy, 1);
      expect(sim.jumps[0].local.z, name).toBeCloseTo(vz, 2);
    }
  });

  it('W released in the air: retail coasts 2.1 m past the landing; ours did not (1.9 m short), now within 0.2 m', () => {
    const g = golden['sweep-jump-W-releaseair'];
    const before = ourError(run('sweep-jump-W-releaseair', true), g);
    const after = ourError(run('sweep-jump-W-releaseair', false), g);
    expect(before[before.length - 1]).toBeGreaterThan(1.7);
    expect(after[after.length - 1]).toBeLessThan(0.2);
  });

  it('every moving jump (run, strafe, back, walk, charge, turn) now within 0.55 m of every retail sample', () => {
    const moving = ['sweep-jump-C', 'sweep-jump-X', 'sweep-jump-WC', 'sweep-jump-WD', 'sweep-jump-walkW', 'sweep-jump-W-longcharge', 'sweep-jump-charge-pressW'];
    const worstBefore: number[] = [];
    for (const name of moving) {
      const before = Math.max(...ourError(run(name, true), golden[name]));
      const after = Math.max(...ourError(run(name, false), golden[name]));
      worstBefore.push(before);
      expect(after, name).toBeLessThan(0.55);
    }
    // Before, the landing lost 0.7–2.4 m against retail in each of them.
    expect(Math.min(...worstBefore)).toBeGreaterThan(0.7);
  });

  it('standing jumps (nothing to coast) are unchanged', () => {
    for (const name of ['sweep-jump-stand-pressC', 'sweep-jump-stand-pressW', 'sweep-jump-then-cast']) {
      expect(ourError(run(name, false), golden[name]), name).toEqual(ourError(run(name, true), golden[name]));
    }
  });
});

// ── Two clients through an ACE relay ──

const LB = 0xA9B40000;
const START = { x: 100, y: 20, z: 10 };
const PEER = 0x50000077;
const NON_COMBAT = 0x8000003d;

function cellOf(x: number, y: number): number {
  return (LB | ((Math.floor(x / 24) * 8 + Math.floor(y / 24)) + 1)) >>> 0;
}

/** 0xF74C: guid, instance seq, then MovementData (6-byte header, type 0, InterpretedMotionState). */
function movementEventBytes(guid: number, movementSeq: number, st: { style: number; fwd: number; fwdSpeed: number; side: number; sideSpeed: number; turn: number; turnSpeed: number } | null): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => out.push(...new Uint8Array(new Uint32Array([v >>> 0]).buffer));
  const f32 = (v: number) => out.push(...new Uint8Array(new Float32Array([v]).buffer));
  u32(guid); u16(1);
  u16(movementSeq); u16(1); u8(1); u8(0); // movement / server-control seqs, autonomous, pad
  u8(0); u8(0); u16(st ? st.style & 0xffff : 0); // MovementType.Invalid, motion flags, style
  if (!st) { u32(0); return new Uint8Array(out); } // ACE's blank InterpretedMotionState
  let flags = 0x1 | 0x2;
  if (st.fwdSpeed !== 1) flags |= 0x4;
  if (st.side) flags |= 0x8 | (st.sideSpeed !== 1 ? 0x10 : 0);
  if (st.turn) flags |= 0x20 | (st.turnSpeed !== 1 ? 0x40 : 0);
  u32(flags);
  u16(st.style & 0xffff); u16(st.fwd & 0xffff);
  if (flags & 0x8) u16(st.side & 0xffff);
  if (flags & 0x20) u16(st.turn & 0xffff);
  if (flags & 0x4) f32(st.fwdSpeed);
  if (flags & 0x10) f32(st.sideSpeed);
  if (flags & 0x40) f32(st.turnSpeed);
  while (out.length % 4) u8(0);
  return new Uint8Array(out);
}

/** 0xF748 UpdatePosition: guid, PositionPack (IsGrounded 0x4, full quaternion), four u16 stamps. */
function updatePositionBytes(guid: number, x: number, y: number, z: number, heading: number, posSeq: number, grounded = true): Uint8Array {
  const buf = new Uint8Array(4 + 4 + 4 + 12 + 16 + 8);
  const dv = new DataView(buf.buffer);
  const q = quatForHeading(heading);
  dv.setUint32(0, guid, true);
  dv.setUint32(4, grounded ? 0x4 : 0, true);
  dv.setUint32(8, cellOf(x, y), true);
  [x, y, z, q.w, q.x, q.y, q.z].forEach((v, i) => dv.setFloat32(12 + i * 4, v, true));
  dv.setUint16(40, 1, true); dv.setUint16(42, posSeq, true); dv.setUint16(44, 1, true); dv.setUint16(46, 0, true);
  return buf;
}

/** 0xF74E VectorUpdate: guid, velocity, omega, instance seq, vector seq. */
function vectorUpdateBytes(guid: number, v: { x: number; y: number; z: number }, vectorSeq: number): Uint8Array {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, guid, true);
  [v.x, v.y, v.z, 0, 0, 0].forEach((f, i) => dv.setFloat32(4 + i * 4, f, true));
  dv.setUint16(28, 1, true); dv.setUint16(30, vectorSeq, true);
  return buf;
}

interface Relayed { t: number; opcode: GameMessageOpcode; payload: Uint8Array }

/**
 * What ACE broadcasts for A's wire (ms + latency): a MoveToState → UpdateMotion
 * with its interpreted state (BroadcastMovement; adjust_motion's run rate) and,
 * at most once a second, an UpdatePosition at its position
 * (MoveToState_UpdatePosition_Threshold); an AutonomousPosition → UpdatePosition.
 * IsGrounded is the server physics' OnWalkable (PositionPack.BuildFlags): off
 * from the Jump (HandleActionJump: set_on_walkable(false)) to the landing;
 * a Jump → the blank UpdateMotion, then the VectorUpdate (HandleActionJump).
 */
function aceRelay(sim: SimResult, runRate: number, latencyMs: number): Relayed[] {
  const out: Relayed[] = [];
  let posSeq = 1, movSeq = 1, vecSeq = 1, lastMtsPos = -Infinity;
  const airborne = (t: number) => sim.jumps.some((j, i) => t >= j.t && t < (sim.landings[i] ?? Infinity));
  const at = (t: number) => { const f = frameAt(sim.frames, t); return { x: START.x + f.right, y: START.y + f.fwd, heading: f.heading }; };
  const events: { t: number; send: () => void }[] = [];
  for (const w of sim.wire) {
    if (w.a.kind === 'moveToState') {
      const raw = w.a.raw;
      const hold = raw.holdKey ?? HoldKey.None;
      const f = adjustMotion(raw.forward ?? MotionCommand.Ready, raw.forwardSpeed ?? 1, raw.forwardHold ?? HoldKey.Invalid, hold, runRate);
      const s = raw.sidestep ? adjustMotion(raw.sidestep, raw.sidestepSpeed ?? 1, raw.sidestepHold ?? HoldKey.Invalid, hold, runRate) : { motion: 0, speed: 1 };
      const tu = raw.turn ? adjustMotion(raw.turn, raw.turnSpeed ?? 1, raw.turnHold ?? HoldKey.Invalid, hold, runRate) : { motion: 0, speed: 1 };
      const t = w.t;
      events.push({ t, send: () => {
        out.push({ t: t + latencyMs, opcode: GameMessageOpcode.MovementEvent, payload: movementEventBytes(PEER, ++movSeq, { style: raw.style ?? NON_COMBAT, fwd: f.motion, fwdSpeed: f.speed, side: s.motion, sideSpeed: s.speed, turn: tu.motion, turnSpeed: tu.speed }) });
        if (t - lastMtsPos >= 1000) {
          lastMtsPos = t;
          const p = at(t);
          out.push({ t: t + latencyMs, opcode: GameMessageOpcode.UpdatePosition, payload: updatePositionBytes(PEER, p.x, p.y, START.z, p.heading, ++posSeq, !airborne(t)) });
        }
      } });
    } else if (w.a.kind === 'autoPos') {
      const t = w.t;
      events.push({ t, send: () => {
        const p = at(t);
        out.push({ t: t + latencyMs, opcode: GameMessageOpcode.UpdatePosition, payload: updatePositionBytes(PEER, p.x, p.y, START.z, p.heading, ++posSeq, !airborne(t)) });
      } });
    }
  }
  for (const j of sim.jumps) {
    events.push({ t: j.t, send: () => {
      const h = (j.heading * Math.PI) / 180;
      // set_local_velocity: AC heading turns clockwise from north.
      const v = { x: j.local.x * Math.cos(h) + j.local.y * Math.sin(h), y: j.local.y * Math.cos(h) - j.local.x * Math.sin(h), z: j.local.z };
      out.push({ t: j.t + latencyMs, opcode: GameMessageOpcode.MovementEvent, payload: movementEventBytes(PEER, ++movSeq, null) });
      out.push({ t: j.t + latencyMs, opcode: GameMessageOpcode.VectorUpdate, payload: vectorUpdateBytes(PEER, v, ++vecSeq) });
    } });
  }
  events.sort((a, b) => a.t - b.t).forEach((e) => e.send());
  return out;
}

interface ObserverTrack { t: number; x: number; y: number }

/** The observer: a ServerObjectManager with the peer's real human sequence, fed the relayed bytes through ServerMessageHandler. */
function observe(portal: DatDatabase, relayed: Relayed[], endMs: number): ObserverTrack[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(0x50000001);
  som.setTerrainCollision({ getHeightAt: () => START.z } as never);
  som.localPlayerPosition = () => ({ x: 0xa9 * 192 + START.x + 10, z: 0xb4 * 192 + START.y, y: START.z, radius: 0.45, height: 1.8 });
  som.createObject({
    guid: PEER, name: 'Jumper', weenieClassId: 1, itemType: 0x10, setupId: 0x02000001, motionTableId: 0,
    position: { landblock: cellOf(START.x, START.y), x: START.x, y: START.y, z: START.z, rw: 1, rx: 0, ry: 0, rz: 0 },
    physicsState: PhysicsState.Gravity, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
  } as never);
  const mm = new MotionManager(portal);
  mm.loadMotionTable(0x09000001);
  mm.setDefaultStance(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(PEER, { motionManager: mm, update: (dt: number, m: any) => mm.update(dt, m) } as any);
  const handler = new ServerMessageHandler();
  handler.setHandlers({
    onMovementEvent: (d) => som.handleMovementEvent(d),
    onUpdatePosition: (d) => som.updatePosition(d),
    onVectorUpdate: (d) => som.applyVectorUpdate(d.guid, d.velocity.x, d.velocity.y, d.velocity.z, d.omega.x, d.omega.y, d.omega.z, d.vectorSequence),
  });
  const track: ObserverTrack[] = [];
  const dt = 1 / 60;
  let i = 0;
  const obj = som.getObject(PEER)!;
  for (let t = 0; t <= endMs; t += dt * 1000) {
    while (i < relayed.length && relayed[i].t <= t) {
      handler.handleMessage({ type: 'direct', opcode: relayed[i].opcode, payload: relayed[i].payload });
      i++;
    }
    som.updateAnimations(dt);
    const p = obj.physics!.pos;
    track.push({ t: t + dt * 1000, x: p.x - 0xa9 * 192 - START.x, y: p.y - 0xb4 * 192 - START.y });
  }
  return track;
}

/**
 * The copy's largest move back against the jump's direction in the 1.5 s
 * after it landed — the coast's window (running max minus the position).
 */
function snapBack(track: ObserverTrack[], from: number, dir: { x: number; y: number }): number {
  let best = -Infinity, worst = 0;
  for (const p of track) {
    if (p.t < from || p.t > from + 1500) continue;
    const s = p.x * dir.x + p.y * dir.y;
    best = Math.max(best, s);
    worst = Math.max(worst, best - s);
  }
  return worst;
}

describe.skipIf(!haveDat || !haveFixture)('two clients: the observer\'s copy of a running jump no longer snaps back', () => {
  let golden: Record<string, Golden> = {};
  let portal: DatDatabase;
  let services: Awaited<ReturnType<typeof buildA9b4World>>;
  let runRate = 0;
  beforeAll(async () => {
    golden = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { scenarios: Record<string, Golden> }).scenarios;
    runRate = golden['sweep-jump-W-releaseair'].jumps[0].v[1] / RUN_ANIM_SPEED;
    portal = openDat(DAT_PATHS.portal);
    services = await buildA9b4World();
  });
  const LATENCY = 100;
  const measure = (name: string, drop: boolean) => {
    const s = SWEEP.find((x) => x.name === name)!;
    const g = golden[name];
    const keyTimes = retailKeyTimes(s.events, g.moveToState.map((m) => Number(m.t)));
    const endMs = Math.max(g.track[g.track.length - 1][0], keyTimes[keyTimes.length - 1]) + 2500;
    const style = g.style === 'Magic' ? MotionStance.Magic : MotionStance.NonCombat;
    const sim = simulateKeys({ portal, events: s.events, keyTimes, endMs, style, runRate, world: () => services({ slidingNormal: null }, () => undefined), jumpVz: g.jumps[0].v[2], dropVelocityOnLanding: drop });
    const track = observe(portal, aceRelay(sim, runRate, LATENCY), endMs + LATENCY);
    const j = sim.jumps[0];
    const h = (j.heading * Math.PI) / 180;
    const vx = j.local.x * Math.cos(h) + j.local.y * Math.sin(h), vy = j.local.y * Math.cos(h) - j.local.x * Math.sin(h);
    const len = Math.hypot(vx, vy) || 1;
    const landed = sim.landings[0] + LATENCY;
    const end = sim.frames[sim.frames.length - 1];
    const last = track[track.length - 1];
    return {
      snap: snapBack(track, landed, { x: vx / len, y: vy / len }),
      restGap: Math.hypot(last.x - end.right, last.y - end.fwd),
    };
  };

  it('W released in the air (a run that ends in the jump): the copy snapped back ~1.9 m, now ~0.2 m at most', () => {
    const before = measure('sweep-jump-W-releaseair', true);
    const after = measure('sweep-jump-W-releaseair', false);
    expect(before.snap).toBeGreaterThan(1.5);
    // What is left is the two clients' discrete steps (the observer's 1/30 s physics quanta against A's frames,
    // the take-off seen a latency late): ~0.2 m, against the 1.9 m coast that was the bug.
    expect(after.snap).toBeLessThan(0.25);
    // Both end where A rests (the AutonomousPosition), the copy only got there differently.
    expect(after.restGap).toBeLessThan(0.1);
  });

  it('the moving jumps that end at rest (strafe, back, walk, a charged run, a turn): no snap back after', () => {
    for (const name of ['sweep-jump-C', 'sweep-jump-X', 'sweep-jump-walkW', 'sweep-jump-charge-pressW', 'sweep-jump-WC']) {
      const before = measure(name, true);
      const after = measure(name, false);
      expect(after.snap, name).toBeLessThan(0.2);
      expect(after.snap, name).toBeLessThanOrEqual(before.snap + 0.1);
    }
  });
});

describe('a remote creature\'s jump (an NPC or monster: VectorUpdate with a still state) still coasts on landing', () => {
  it('the copy lands and slides v / ln 20 on the walkable (retail RemotePhysics, unchanged)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => new THREE.Group();
    som.setPlayerGuid(0x50000001);
    som.setTerrainCollision({ getHeightAt: () => START.z } as never);
    som.localPlayerPosition = () => ({ x: 0xa9 * 192 + START.x + 10, z: 0xb4 * 192 + START.y, y: START.z, radius: 0.45, height: 1.8 });
    som.createObject({
      guid: 0x80000123, name: 'Drudge', weenieClassId: 2, itemType: 0x10, setupId: 0x02000002, motionTableId: 0,
      position: { landblock: cellOf(START.x, START.y), x: START.x, y: START.y, z: START.z, rw: 1, rx: 0, ry: 0, rz: 0 },
      physicsState: PhysicsState.Gravity, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
      subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
    } as never);
    const obj = som.getObject(0x80000123)!;
    const h = new ServerMessageHandler();
    h.setHandlers({ onVectorUpdate: (d) => som.applyVectorUpdate(d.guid, d.velocity.x, d.velocity.y, d.velocity.z, 0, 0, 0, d.vectorSequence) });
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.VectorUpdate, payload: vectorUpdateBytes(0x80000123, { x: 0, y: 4, z: 2.62 }, 2) });
    const y0 = obj.physics!.pos.y;
    for (let i = 0; i < 240; i++) som.updateAnimations(1 / 60);
    const flight = 4 * (2 * 2.62 / 9.8);
    expect(obj.physics!.contact).toBe(true);
    expect(obj.physics!.pos.y - y0).toBeGreaterThan(flight + coastDistance(4) - 0.25);
    expect(obj.physics!.pos.y - y0).toBeLessThan(flight + coastDistance(4) + 0.1);
  });
});
