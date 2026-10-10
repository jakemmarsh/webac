/**
 * MOVE.combination-sweep — animation/MotionTableState.ts against the human
 * motion table 0x09000001 (DAT): CMotionTable::GetObjectSequence @ 00522860's
 * substate / modifier decisions, StopSequenceMotion @ 00522fc0, re_modify
 * @ 005222e0 as written, and CSequence's velocity accumulator — including
 * the retail slide: run + strafe + turn, release the run, and the strafe's
 * velocity counts twice; release the strafe and one copy stays.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { MotionTable } from '@ac/dat-parser';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { MotionTableState } from '../packages/renderer/src/animation/MotionTableState.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';

const PEACE = 0x8000003d;
const RUN = 1.635;
const SIDE = 2.04; // SideStepRight at a run (0.5 × 3.12 / 1.25 × 1.635)

describe.skipIf(!existsSync(DAT_PATHS.portal))('MotionTableState (GetObjectSequence / re_modify / the sequence velocity)', () => {
  let table: MotionTable;
  beforeAll(async () => {
    const { MotionTable: MT, DatReader } = await import('@ac/dat-parser');
    table = new MT(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x09000001)!));
  });
  const make = () => {
    const subs: number[] = [];
    const st = new MotionTableState(table, () => PEACE, (m) => subs.push(m));
    st.reset(MotionCommand.Ready);
    return { st, subs };
  };
  // The SideStepRight modifier's velocity (x 1.25 m/s per unit speed; DAT).
  const sideV = (k: number) => 1.25 * SIDE * k;

  it('a strafe from Ready is the substate; a turn on top is a modifier', () => {
    const { st } = make();
    st.doMotion(MotionCommand.SideStepRight, SIDE);
    expect(st.substate).toBe(MotionCommand.SideStepRight);
    st.doMotion(MotionCommand.TurnRight, 1.5);
    expect(st.substate).toBe(MotionCommand.SideStepRight);
    expect(st.modifiers.map((m) => m.motion)).toEqual([MotionCommand.TurnRight]);
  });

  it('turn first, then strafe: the turn keeps the substate, the strafe is a modifier at once', () => {
    const { st } = make();
    st.doMotion(MotionCommand.TurnRight, 1.5);
    st.doMotion(MotionCommand.SideStepRight, SIDE);
    expect(st.substate).toBe(MotionCommand.TurnRight);
    expect(st.velocity.x).toBeCloseTo(sideV(1), 4);
  });

  it('a run takes the substate; a strafe substate before it is demoted to a modifier', () => {
    const { st } = make();
    st.doMotion(MotionCommand.SideStepRight, SIDE);
    st.doMotion(MotionCommand.RunForward, RUN);
    expect(st.substate).toBe(MotionCommand.RunForward);
    expect(st.modifiers.map((m) => m.motion)).toEqual([MotionCommand.SideStepRight]);
    expect(st.velocity.x).toBeCloseTo(sideV(1), 4);
  });

  it('the run stopping with only a strafe held: the strafe becomes the substate (no double)', () => {
    const { st } = make();
    st.doMotion(MotionCommand.RunForward, RUN);
    st.doMotion(MotionCommand.SideStepRight, SIDE);
    st.stopMotion(MotionCommand.RunForward);
    expect(st.substate).toBe(MotionCommand.SideStepRight);
    expect(st.modifiers).toEqual([]);
    expect(st.velocity.x).toBeCloseTo(0, 6); // the strafe cycle moves by its frames, not a velocity
  });

  it('THE SLIDE: run + strafe + turn, release the run → the strafe counts twice; release the strafe → one copy stays until the next substate change', () => {
    const { st, subs } = make();
    st.doMotion(MotionCommand.RunForward, RUN);
    st.doMotion(MotionCommand.SideStepRight, SIDE);
    st.doMotion(MotionCommand.TurnRight, 1.5);
    expect(st.modifiers.map((m) => m.motion)).toEqual([MotionCommand.TurnRight, MotionCommand.SideStepRight]);
    expect(st.velocity.x).toBeCloseTo(sideV(1), 4);
    st.stopMotion(MotionCommand.RunForward);
    // Ready, then re_modify: the turn (head) becomes the substate; the nested
    // re_modify re-adds the strafe, and the outer pass adds it again.
    expect(subs.slice(-2)).toEqual([MotionCommand.Ready, MotionCommand.TurnRight]);
    expect(st.substate).toBe(MotionCommand.TurnRight);
    expect(st.modifiers.map((m) => m.motion)).toEqual([MotionCommand.SideStepRight]);
    expect(st.velocity.x).toBeCloseTo(sideV(2), 4);
    st.stopMotion(MotionCommand.SideStepRight);
    expect(st.modifiers).toEqual([]);
    expect(st.velocity.x).toBeCloseTo(sideV(1), 4); // still sliding, no key held
    st.stopMotion(MotionCommand.TurnRight);
    expect(st.substate).toBe(MotionCommand.Ready);
    expect(st.velocity.x).toBeCloseTo(0, 6); // the substate change cleared it
  });

  it('a substate cycle with the run sets the velocity (add_motion), a speed change re-speeds it (change_cycle_speed)', () => {
    const { st } = make();
    st.doMotion(MotionCommand.TurnRight, 1);
    expect(st.omega.z).toBeCloseTo(-1.5, 5);
    st.doMotion(MotionCommand.TurnRight, 1.5);
    expect(st.omega.z).toBeCloseTo(-2.25, 5);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('CharacterAnimController.motionsPending holds while the server\'s substate holds', () => {
  it('a server cast gesture held keeps motions pending (UseTime does not take control back); the player\'s own posture does not', async () => {
    const { MotionManager } = await import('../packages/renderer/src/animation/MotionManager.js');
    const { CharacterAnimController } = await import('../packages/renderer/src/animation/CharacterAnimController.js');
    const { applyServerForwardToLocalPlayer } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const mm = new MotionManager(openDat(DAT_PATHS.portal));
    mm.loadMotionTable(0x09000001); mm.setDefaultStance(1);
    const anim = new CharacterAnimController(mm);
    anim.setStance(0x80000049);
    for (let i = 0; i < 300; i++) mm.update(1 / 60);
    const idle = { isMovingForward: false, isMovingBackward: false, isStrafingLeft: false, isStrafingRight: false, isTurningLeft: false, isTurningRight: false, isRunning: true } as never;
    anim.update(1 / 60, idle);
    applyServerForwardToLocalPlayer(mm, 0x2d, 2, 0x80000049); // MagicHeal gesture (substate class)
    for (let i = 0; i < 240; i++) { mm.update(1 / 60); anim.update(1 / 60, idle); } // the link done; the hold cycle holds
    expect(mm.isPlayingAction).toBe(false);
    expect(anim.motionsPending).toBe(true);
    applyServerForwardToLocalPlayer(mm, 0x03, 1, 0x80000049); // the server's Ready
    for (let i = 0; i < 240; i++) { mm.update(1 / 60); anim.update(1 / 60, idle); }
    expect(anim.motionsPending).toBe(false);
    anim.setHeldSubstate(MotionCommand.Sitting);
    for (let i = 0; i < 240; i++) { mm.update(1 / 60); anim.update(1 / 60, idle); }
    expect(anim.motionsPending).toBe(false);
  });
});
