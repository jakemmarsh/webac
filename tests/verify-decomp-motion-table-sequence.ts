/**
 * Decomp-diff sweep 2026-09-30, animation group — the motion-table sequence
 * rules of the retail client, driven through the real MotionManager /
 * CharacterAnimController / ServerObjectManager:
 *
 *  - DECOMP.run-cycle-ignores-run-rate — running is WalkForward +
 *    HoldKey_Run; `CMotionInterp::adjust_motion @ 00528010` →
 *    `apply_run_to_command @ 00527be0` makes it RunForward at run_rate (a raw
 *    RunForward is returned untouched), so the own run cycle plays at the
 *    Run-skill rate.
 *  - DECOMP.emote-cycles-freeze — every cycle loops
 *    (`CSequence::advance_to_next_animation @ 005252b0` wraps to
 *    first_cyclic); a hold is a framerate-0 node.
 *  - DECOMP.local-no-motion-links — the own character's locomotion goes
 *    through GetObjectSequence's SubState branch like any object's: link,
 *    then cycle.
 *  - DECOMP.death-action-via-default — no direct link from the current
 *    substate → through the style default (Dead from a run; an action while
 *    walking) (`CMotionTable::GetObjectSequence @ 00522860`).
 *  - DECOMP.get-link-negative-speed — `CMotionTable::get_link @ 00522710`
 *    looks a link up REVERSED when either speed is negative.
 *  - DECOMP.style-change-speed — the style is DoMotion'd at speed 1.0
 *    (`MovementManager::unpack_movement @ 00524440`), and its links are not
 *    cut by the substate that follows.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import type { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { MotionTable, MotionData } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { MotionCommand, MotionSpeed, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { openDat } from './_harness/dat.js';

const NC = MotionStance.NonCombat;   // 0x8000003d
const HC = MotionStance.HandCombat;  // 0x8000003c
const READY = MotionCommand.Ready;
const WALK = MotionCommand.WalkForward;
const RUN = MotionCommand.RunForward;
const DEAD = MotionCommand.Dead;
const WAVE = MotionCommand.Wave;
const AFK = MotionCommand.AFKState;
const key = MotionManager.compositeKey;

// Synthetic animations: each is identified by its id; part 0 sits at x = frame.
const A = {
  READY: 0x03001001, WALK: 0x03001002, RUN: 0x03001003,
  R2W: 0x03001004, W2R: 0x03001005, R2RUN: 0x03001006, RUN2R: 0x03001007,
  FALL: 0x03001008, DEAD: 0x03001009, WAVE: 0x0300100a, AFK: 0x0300100b,
  DRAW: 0x0300100c, HC_READY: 0x0300100d, HC_RUN: 0x0300100e, HC_R2RUN: 0x0300100f,
};

function anim(id: number, frames = 10): Animation {
  const partFrames = Array.from({ length: frames }, (_, i) => ({
    frames: [{ origin: { x: i, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }],
    hooks: [],
  }));
  return { id, flags: 0, numParts: 1, numFrames: frames, posFrames: [], partFrames } as unknown as Animation;
}
const md = (animId: number, framerate = 30, lowFrame = 0, highFrame = -1): MotionData =>
  ({ numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId, lowFrame, highFrame, framerate }] }) as unknown as MotionData;

/** A small humanoid table: NonCombat Ready / Walk / Run / Dead / AFK; links only out of Ready (and Walk/Run → Ready); a HandCombat style. */
function syntheticTable(): MotionTable {
  return {
    defaultStyle: NC,
    styleDefaults: new Map<number, number>([[NC, READY], [HC, READY]]),
    cycles: new Map<number, MotionData>([
      [key(NC, READY), md(A.READY)], [key(NC, WALK), md(A.WALK)], [key(NC, RUN), md(A.RUN)],
      [key(NC, DEAD), md(A.DEAD, 0, 9)], [key(NC, AFK), md(A.AFK, 15, 2, 8)],
      [key(HC, READY), md(A.HC_READY)], [key(HC, RUN), md(A.HC_RUN)],
    ]),
    modifiers: new Map(),
    links: new Map<number, Map<number, MotionData>>([
      [key(NC, READY), new Map<number, MotionData>([[WALK, md(A.R2W)], [RUN, md(A.R2RUN)], [DEAD, md(A.FALL)], [WAVE, md(A.WAVE)]])],
      [key(NC, WALK), new Map<number, MotionData>([[READY, md(A.W2R)]])],
      [key(NC, RUN), new Map<number, MotionData>([[READY, md(A.RUN2R)]])],
      [(((NC & 0xffff) << 16) >>> 0), new Map<number, MotionData>([[HC, md(A.DRAW, 30)]])],
      [key(HC, READY), new Map<number, MotionData>([[RUN, md(A.HC_R2RUN)]])],
    ]),
  } as unknown as MotionTable;
}

function makeMM(): MotionManager {
  const mm = new MotionManager({ getFileData: () => null } as never);
  mm.setMotionTable(syntheticTable());
  const cache = (mm as unknown as { animationCache: Map<number, Animation> }).animationCache;
  for (const id of Object.values(A)) cache.set(id, anim(id, id === A.DRAW ? 30 : 10));
  expect(mm.setStanceFromId(NC)).toBe(true);
  return mm;
}

/** The distinct nodes the player plays over `seconds` (animation id and speed sign), starting with the current one. */
function trace(mm: MotionManager, seconds: number, step = 1 / 60): string[] {
  const out: string[] = [];
  const note = () => {
    const a = mm.animationPlayer.currentAnimation;
    const tag = `${a ? a.id.toString(16) : 'none'}${mm.animationPlayer.playbackSpeed < 0 ? '-' : '+'}`;
    if (out[out.length - 1] !== tag) out.push(tag);
  };
  note();
  for (let t = 0; t < seconds; t += step) { mm.update(step); note(); }
  return out;
}
const h = (id: number, sign: '+' | '-' = '+') => `${id.toString(16)}${sign}`;

const input = (o: Partial<Record<string, boolean>> = {}) => ({
  isJumpHeld: false, isMovingForward: false, isMovingBackward: false, isStrafingLeft: false,
  isStrafingRight: false, isTurningLeft: false, isTurningRight: false, isRunning: false, ...o,
}) as never;

describe('DECOMP.run-cycle-ignores-run-rate — running is WalkForward + HoldKey_Run', () => {
  it('adjust_motion returns a raw RunForward untouched; WalkForward + run → RunForward at run_rate', () => {
    expect(MotionManager.adjustMotion(RUN, 1.0, true, 2.5)).toEqual({ motion: RUN, speed: 1.0 });
    expect(MotionManager.adjustMotion(WALK, 1.0, true, 2.5)).toEqual({ motion: RUN, speed: 2.5 });
    const back = MotionManager.adjustMotion(MotionCommand.WalkBackwards, 1.0, true, 2.5);
    expect(back.motion).toBe(WALK);
    expect(back.speed).toBeCloseTo(-MotionSpeed.BackwardsFactor * 2.5, 6);
  });

  it('the own run plays the Ready → Run link and the Run cycle at the run rate, not 1.0', () => {
    const mm = makeMM();
    const c = new CharacterAnimController(mm);
    c.runRate = 2.0;
    c.update(1 / 60, input({ isMovingForward: true, isRunning: true }));
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.R2RUN);
    expect(mm.animationPlayer.playbackSpeed).toBe(2.0);
    for (let i = 0; i < 60; i++) { mm.update(1 / 60); c.update(1 / 60, input({ isMovingForward: true, isRunning: true })); }
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.RUN);
    expect(mm.animationPlayer.playbackSpeed).toBe(2.0);
  });

  it('a run-rate change mid-run re-speeds the cycle in place (change_cycle_speed), no restart', () => {
    const mm = makeMM();
    const c = new CharacterAnimController(mm);
    c.runRate = 2.0;
    for (let i = 0; i < 90; i++) { c.update(1 / 60, input({ isMovingForward: true, isRunning: true })); mm.update(1 / 60); }
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.RUN);
    const frame = mm.animationPlayer.currentFrame;
    c.runRate = 3.0;
    c.update(1 / 60, input({ isMovingForward: true, isRunning: true }));
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.RUN);
    expect(mm.animationPlayer.playbackSpeed).toBe(3.0);
    expect(mm.animationPlayer.currentFrame).toBe(frame);
  });
});

describe('DECOMP.local-no-motion-links — the own locomotion plays the motion-table links', () => {
  it('start walking: Ready → Walk link, then the Walk cycle; stop: Walk → Ready link, then Ready', () => {
    const mm = makeMM();
    const c = new CharacterAnimController(mm);
    c.update(1 / 60, input({ isMovingForward: true }));
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.R2W);
    expect(trace(mm, 0.5)).toEqual([h(A.R2W), h(A.WALK)]);
    c.update(1 / 60, input());
    expect(trace(mm, 0.5)).toEqual([h(A.W2R), h(A.READY)]);
  });

  it('a stop pressed during the start link is appended after it (the link is not cut)', () => {
    const mm = makeMM();
    const c = new CharacterAnimController(mm);
    c.update(1 / 60, input({ isMovingForward: true }));
    mm.update(0.05);
    c.update(1 / 60, input());
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.R2W);
    expect(trace(mm, 1)).toEqual([h(A.R2W), h(A.W2R), h(A.READY)]);
  });
});

describe('DECOMP.get-link-negative-speed — a negative speed looks the link up reversed', () => {
  it('Ready → walking backward plays the Walk → Ready link backwards (not Ready → Walk)', () => {
    const mm = makeMM();
    mm.setForwardMotion(key(NC, WALK), -0.65);
    expect(trace(mm, 0.6)).toEqual([h(A.W2R, '-'), h(A.WALK, '-')]);
  });

  it('backward → Ready (sign change) plays the Ready → Walk link backwards, then Ready', () => {
    const mm = makeMM();
    mm.setForwardMotion(key(NC, WALK), -0.65);
    trace(mm, 1);
    mm.setForwardMotion(key(NC, READY), 1.0);
    expect(trace(mm, 0.6)).toEqual([h(A.R2W, '-'), h(A.READY)]);
  });

  it('the own backward walk through the controller takes the reversed link', () => {
    const mm = makeMM();
    const c = new CharacterAnimController(mm);
    c.update(1 / 60, input({ isMovingBackward: true }));
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.W2R);
    expect(mm.animationPlayer.playbackSpeed).toBeLessThan(0);
  });
});

describe('DECOMP.death-action-via-default — no direct link → through the style default', () => {
  it('Dead from walking: Walk → Ready, Ready → Dead (the fall), then the Dead hold', () => {
    const mm = makeMM();
    mm.setForwardMotion(key(NC, WALK), 1.0);
    trace(mm, 1);
    mm.playDeath(DEAD & 0xffff);
    expect(trace(mm, 2)).toEqual([h(A.W2R), h(A.FALL), h(A.DEAD)]);
    expect(mm.isDead).toBe(true);
  });

  it('an action while walking: Walk → Ready, Ready → Wave, Ready → Walk, then walking again; onComplete after the wave', () => {
    const mm = makeMM();
    mm.setForwardMotion(key(NC, WALK), 1.0);
    trace(mm, 1);
    let done = -1;
    const seen: string[] = [];
    mm.queueAction(key(NC, WAVE), 1.0, () => { done = seen.length; });
    const t = trace(mm, 2, 1 / 60);
    seen.push(...t);
    expect(t).toEqual([h(A.W2R), h(A.WAVE), h(A.R2W), h(A.WALK)]);
    expect(done).toBeGreaterThanOrEqual(0);
    expect(mm.stance).toBe(key(NC, WALK));
  });
});

describe('DECOMP.emote-cycles-freeze — every cycle loops; holds are framerate-0 data', () => {
  it('an emote state cycle (AFK sway) keeps looping', () => {
    const mm = makeMM();
    mm.setForwardMotion(key(NC, AFK), 1.0);
    const frames = new Set<number>();
    for (let i = 0; i < 600; i++) { mm.update(1 / 60); frames.add(mm.animationPlayer.currentFrameIndex); }
    expect(mm.animationPlayer.isPlaying).toBe(true);
    // Still moving through the 2..8 range after 10 s (7 frames at 15 fps = 0.47 s per loop).
    const before = mm.animationPlayer.currentFrameIndex;
    mm.update(0.2);
    expect(mm.animationPlayer.currentFrameIndex).not.toBe(before);
    expect([...frames].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('a framerate-0 cycle (the Dead pose) holds its frame', () => {
    const mm = makeMM();
    mm.playDeath(DEAD & 0xffff);
    trace(mm, 2);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.DEAD);
    const x = mm.animationPlayer.currentFrameIndex;
    mm.update(5);
    expect(mm.animationPlayer.currentFrameIndex).toBe(x);
  });
});

describe('DECOMP.style-change-speed — a style change plays at 1.0 and is not cut by the run that follows', () => {
  it('a remote player drawing while running (HandCombat + RunForward @ 2.5): the draw at 1.0, then the run link and cycle at 2.5', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
    const group = new THREE.Group();
    const p = new THREE.Object3D(); p.name = 'part_0'; group.add(p);
    const ent = new AnimatedEntity(group, { getFileData: () => null } as never);
    const mm = ent.motionManager;
    mm.setMotionTable(syntheticTable());
    const cache = (mm as unknown as { animationCache: Map<number, Animation> }).animationCache;
    for (const id of Object.values(A)) cache.set(id, anim(id, id === A.DRAW ? 30 : 10));
    mm.setStanceFromId(NC);
    const GUID = 0x50000001;
    som.registerAnimatedEntity(GUID, ent);

    // 0xF74C: header, movement_type Invalid, outer style; CurrentStyle | ForwardCommand | ForwardSpeed.
    const buf = new Uint8Array(6 + 4 + 4 + 4 + 4);
    const v = new DataView(buf.buffer);
    v.setUint16(8, HC & 0xffff, true);
    v.setUint32(10, 0x1 | 0x2 | 0x4, true);
    v.setUint16(14, HC & 0xffff, true);
    v.setUint16(16, RUN & 0xffff, true);
    v.setFloat32(18, 2.5, true);
    som.handleMovementEvent({ guid: GUID, movementData: buf } as never);

    expect(mm.animationPlayer.currentAnimation?.id).toBe(A.DRAW);
    expect(mm.animationPlayer.playbackSpeed).toBe(1.0);
    expect(trace(mm, 1.5)).toEqual([h(A.DRAW), h(A.HC_R2RUN), h(A.HC_RUN)]);
    expect(mm.animationPlayer.playbackSpeed).toBe(2.5);
  });
});

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
describe.skipIf(!fs.existsSync(PORTAL))('the real human motion table 0x09000001', () => {
  let db: { getFileData(id: number): ArrayBuffer | null };
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    db = openDat(PORTAL) as never;
  });
  const human = () => {
    const mm = new MotionManager(db as never);
    expect(mm.loadMotionTable(0x09000001)).not.toBeNull();
    expect(mm.setStanceFromId(NC)).toBe(true);
    return mm;
  };

  it('own walk start: link 0x03000006, then the walk cycle 0x03000003; the run at the run rate (0x03000005 → 0x03000002)', () => {
    const mm = human();
    const c = new CharacterAnimController(mm);
    c.update(1 / 60, input({ isMovingForward: true }));
    expect(trace(mm, 1.5)).toEqual([h(0x03000006), h(0x03000003)]);
    const mm2 = human();
    const c2 = new CharacterAnimController(mm2);
    c2.runRate = 2.2;
    c2.update(1 / 60, input({ isMovingForward: true, isRunning: true }));
    expect(trace(mm2, 1.5)).toEqual([h(0x03000005), h(0x03000002)]);
    expect(mm2.animationPlayer.playbackSpeed).toBeCloseTo(2.2, 6);
  });

  it('Dead from a run (no Run → Dead link): Run → Ready 0x03000007, the fall 0x030000C6, the Dead hold 0x03000397', () => {
    const mm = human();
    mm.setForwardMotion(key(NC, RUN), 2.0);
    trace(mm, 1);
    mm.playDeath(DEAD & 0xffff);
    expect(trace(mm, 4)).toEqual([h(0x03000007), h(0x030000c6), h(0x03000397)]);
  });

  it('backward from Ready takes the reversed Walk → Ready link 0x03000009', () => {
    const mm = human();
    mm.setForwardMotion(key(NC, WALK), -0.65);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(0x03000009);
    expect(mm.animationPlayer.playbackSpeed).toBeLessThan(0);
  });

  it('the AFK state cycle 0x3d011b (0x030007bc frames 35–55 @ 15) keeps swaying', () => {
    const mm = human();
    mm.setForwardMotion(key(NC, AFK), 1.0);
    for (let i = 0; i < 600; i++) mm.update(1 / 60);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(0x030007bc);
    expect(mm.animationPlayer.isPlaying).toBe(true);
    const before = mm.animationPlayer.currentFrameIndex;
    mm.update(0.3);
    expect(mm.animationPlayer.currentFrameIndex).not.toBe(before);
  });
});
