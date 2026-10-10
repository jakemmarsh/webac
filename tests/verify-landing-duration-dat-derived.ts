/**
 * DECOMP.jump-landing-anims — take-off and landing go through the motion
 * table's LINKS, with no landing clip of their own and no input lock.
 *
 * Retail CMotionInterp::HitGround @ 00528ac0 is
 * `RemoveLinkAnimations(); apply_current_movement(0, 0)` and LeaveGround
 * @ 00528b00 is the same after setting the leave-ground velocity. In the
 * air contact_allows_move fails, so apply_interpreted_movement's forward
 * command becomes Falling (0x40000015); on the ground it is the held motion
 * again. GetObjectSequence plays link(current → Falling) on take-off and
 * link(Falling → held motion) on landing — the human table's Falling →
 * Ready / RunForward links ARE the landing.
 *
 * This file used to pin BUG.landing-duration-hardcoded-vs-dat: a landing
 * that played the Interpolating (0x40000009) cycle — which the human table
 * maps to a TurnRight-like clip — for its DAT length and locked movement out
 * for 40% of it. Neither the cycle nor the lock exists in retail; the
 * MotionManager.getCycleLength port it relied on is still pinned below.
 */
import { describe, it, expect } from 'vitest';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import type { MotionTable, MotionData } from '@ac/dat-parser/file-types/MotionTable.js';

const STYLE = 0x3d; // NonCombat
const key = (motion: number): number => MotionManager.compositeKey(STYLE, motion & 0xFFFFF);

function makeController() {
  const calls: { via: 'link' | 'cycle'; key: number }[] = [];
  /** CPhysicsObj::RemoveLinkAnimations calls (LeaveGround / HitGround), with how many motion calls preceded each. */
  const removed: number[] = [];
  const mm = {
    removeLinkAnimations: () => { removed.push(calls.length); },
    queueAction: () => {},
    setStanceFromId: () => {},
    changeStyle: () => true,
    requestMotion: (k: number) => { calls.push({ via: 'cycle', key: k }); return true; },
    // Locomotion goes through the substate path (DECOMP.local-no-motion-links).
    setForwardMotion: (k: number) => { calls.push({ via: 'link', key: k }); return true; },
    getCycleLength: () => 20 / 30,
    isPlayingAction: false,
    styleKey: STYLE,
    stance: key(MotionCommand.Ready),
    motion: key(MotionCommand.Ready),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { cac: new CharacterAnimController(mm as any), calls, removed };
}

function input(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    isJumpHeld: false,
    isMovingForward: false,
    isMovingBackward: false,
    isStrafingLeft: false,
    isStrafingRight: false,
    isTurningLeft: false,
    isTurningRight: false,
    isRunning: true,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('DECOMP.jump-landing-anims — LeaveGround / HitGround play links', () => {
  it('take-off requests Falling through the link from the current motion (setForwardMotion), not the bare cycle', () => {
    const { cac, calls } = makeController();
    cac.update(0.016, input()); // settle into Ready
    calls.length = 0;
    cac.update(0.016, input({ isJumpHeld: true }));
    cac.update(0.2, input({ isJumpHeld: true }));
    expect(cac.triggerJump(input())).not.toBeNull();
    expect(calls).toEqual([{ via: 'link', key: key(MotionCommand.Falling) }]);
    expect(cac.airborne).toBe(true);
  });

  it('a walk-off (leaveGround with no jump) also links into Falling', () => {
    const { cac, calls } = makeController();
    cac.leaveGround();
    expect(calls).toEqual([{ via: 'link', key: key(MotionCommand.Falling) }]);
  });

  it('landing never plays the Interpolating cycle and holds no lock: the held run starts on the very next update, through its link out of Falling', () => {
    const { cac, calls } = makeController();
    cac.leaveGround();
    calls.length = 0;
    cac.onLanded();
    expect(calls).toEqual([]); // HitGround itself requests no clip of its own
    cac.update(0.001, input({ isMovingForward: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0].via).toBe('link');
    expect(calls[0].key).toBe(key(MotionCommand.RunForward));
    expect(calls.some((c) => (c.key & 0xFFFF) === (MotionCommand.Interpolating & 0xFFFF))).toBe(false);
  });

  it('landing idle links back to Ready at once (no 0.3 s / 0.667 s landing hold)', () => {
    const { cac, calls } = makeController();
    cac.leaveGround();
    calls.length = 0;
    cac.onLanded();
    cac.update(0.001, input());
    expect(calls).toEqual([{ via: 'link', key: key(MotionCommand.Ready) }]);
  });

  it('while airborne the Falling motion holds — no ground motion is requested', () => {
    const { cac, calls } = makeController();
    cac.leaveGround();
    calls.length = 0;
    for (let i = 0; i < 10; i++) cac.update(0.05, input({ isMovingForward: true }));
    expect(calls).toEqual([]);
  });

  it('after landing, ground changes keep going through the substate path', () => {
    const { cac, calls } = makeController();
    cac.leaveGround();
    cac.onLanded();
    cac.update(0.016, input());
    calls.length = 0;
    cac.update(0.016, input({ isMovingForward: true }));
    expect(calls).toEqual([{ via: 'link', key: key(MotionCommand.RunForward) }]);
  });
});

describe('MotionManager.getCycleLength — exact port of MotionTable.GetCycleLength (MotionTable.cs:69-83)', () => {
  function fakeTable(cycles: Map<number, MotionData>): MotionTable {
    return {
      id: 0,
      defaultStyle: 0,
      styleDefaults: new Map(),
      cycles,
      modifiers: new Map(),
      links: new Map(),
    } as MotionTable;
  }

  it('sums (highFrame - lowFrame) / abs(framerate) across every AnimData in the cycle', () => {
    const mm = new MotionManager({} as DatDatabase);
    const k = (0x3d << 16) | 0x0009; // NonCombat/Interpolating
    mm.setMotionTable(fakeTable(new Map([
      [k, { numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId: 1, lowFrame: 0, highFrame: -1, framerate: 30 }] }],
    ])));
    // highFrame === -1 -> use the animation's real numFrames (20)
    mm.loadAnimation = (animId: number) => (animId === 1 ? ({ numFrames: 20 } as ReturnType<MotionManager['loadAnimation']>) : null);

    expect(mm.getCycleLength(k)).toBeCloseTo(20 / 30, 6);
  });

  it('clamps highFrame to the animation numFrames when the DAT data overshoots it', () => {
    const mm = new MotionManager({} as DatDatabase);
    const k = 0x1234;
    mm.setMotionTable(fakeTable(new Map([
      [k, { numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId: 1, lowFrame: 0, highFrame: 999, framerate: 30 }] }],
    ])));
    mm.loadAnimation = () => ({ numFrames: 20 } as ReturnType<MotionManager['loadAnimation']>);

    expect(mm.getCycleLength(k)).toBeCloseTo(20 / 30, 6);
  });

  it('returns 0 when the cycle key is not present', () => {
    const mm = new MotionManager({} as DatDatabase);
    mm.setMotionTable(fakeTable(new Map()));
    expect(mm.getCycleLength(0xdead)).toBe(0);
  });

  it('returns 0 when no MotionTable is loaded', () => {
    const mm = new MotionManager({} as DatDatabase);
    expect(mm.getCycleLength(0x1234)).toBe(0);
  });
});

/**
 * SWEEP1006 jump links — CMotionInterp::LeaveGround @ 00528b00 and
 * HitGround @ 00528ac0 call CPhysicsObj::RemoveLinkAnimations before
 * apply_current_movement: Falling never waits behind a swing or emote, and
 * landing never waits behind the into-Falling link.
 */
describe('LeaveGround / HitGround drop the playing links first', () => {
  it('take-off: RemoveLinkAnimations, then Falling', () => {
    const { cac, calls, removed } = makeController();
    cac.update(0.016, input());
    calls.length = 0; removed.length = 0;
    cac.leaveGround();
    expect(removed).toEqual([0]); // before any motion call
    expect(calls[0].key).toBe(key(MotionCommand.Falling));
  });
  it('landing: RemoveLinkAnimations', () => {
    const { cac, removed } = makeController();
    cac.leaveGround();
    removed.length = 0;
    cac.onLanded();
    expect(removed.length).toBe(1);
  });
});

describe('MotionManager.removeLinkAnimations ends a playing action (CSequence::remove_link_animations)', () => {
  it('a swing in progress is dropped, the queued substate becomes current', () => {
    const mm = new MotionManager({} as never);
    const m = mm as unknown as { playingAction: boolean; actionQueue: unknown[]; linkQueue: unknown[]; motionTable: unknown; currentStance: number; _isDead: boolean };
    m.motionTable = { cycles: new Map() };
    m.playingAction = true;
    m.actionQueue = [{ motionId: key(MotionCommand.Falling), speed: 1, substate: true }];
    mm.removeLinkAnimations();
    expect(m.playingAction).toBe(false);
    expect(m.actionQueue).toEqual([]);
    expect(m.currentStance).toBe(key(MotionCommand.Falling));
  });
});
