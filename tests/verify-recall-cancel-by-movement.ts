/**
 * BUG.recall-not-cancelled-by-moving (Jake, playwebac.com, Coldeve ACE,
 * 2026-10-12): "I moved during /ls and the recall still completed."
 *
 * ACE (Player_Location.cs:132-190) cancels a recall only if, when the
 * recall animation's length has passed, the server's Location (set only by
 * our AutonomousPosition / MoveToState positions) is more than 8 m
 * (RecallMoveThreshold) from where it began. The server times the recall by
 * GetAnimationLength(LifestoneRecall): the same link the client plays.
 *
 * Retail (decomp, checked): a movement key during the server's recall action
 * takes control back (CommandInterpreter::TakeControlFromServer @ 006b32d0:
 * CPhysicsObj::StopCompletely, then ApplyCurrentMovement) and the
 * MoveToState goes out at once, but CMotionTable::GetObjectSequence's
 * SubState branch (:282244-282305) only drops the cyclic tail
 * (remove_cyclic_anims), so RunForward is appended AFTER the recall link
 * (CMotionInterp::StopCompletely @ 00527e40 removes links only with no
 * cell). The human run cycle has no sequence velocity: the body moves by its
 * pos-frames, so it stands until the link ends, which is when the server's
 * timer fires. Walking therefore cannot cancel a recall in retail either; the
 * same queueing is what the retail A/B capture sweep-cast-then-W-short
 * recorded for a cast windup (docs/movement-ab.md R5).
 *
 * What does cancel it: a jump. motion_allows_jump @ 005279e0 refuses none of
 * the recall motions, and CMotionInterp::LeaveGround @ 00528b00 runs
 * RemoveLinkAnimations, so the recall link is dropped and the body flies on
 * the interpreted run's velocity, then runs on landing (HitGround @ 00528ac0).
 *
 * Drives the real CameraController, CharacterAnimController, MotionManager
 * (human MotionTable 0x09000001 from portal.dat), LocalSequenceStep and
 * MovementSync (tests/_harness/movement-sim.ts) and checks the wire.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser';
import { existsSync } from 'node:fs';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { simulateKeys, FRAME } from './_harness/movement-sim.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController, motionAllowsJump } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { localSequenceStep } from '../packages/renderer/src/player/LocalSequenceStep.js';
import { applyServerForwardToLocalPlayer } from '../packages/renderer/src/world/ServerObjectManager.js';

const RECALLS: Array<[string, number]> = [
  ['LifestoneRecall', MotionCommand.LifestoneRecall],
  ['MarketplaceRecall', MotionCommand.MarketplaceRecall],
  ['HouseRecall', MotionCommand.HouseRecall],
  ['AllegianceHometownRecall', MotionCommand.AllegianceHometownRecall],
  ['PKArenaRecall', MotionCommand.PKArenaRecall],
  // Attuning at a lifestone / bindstone (Lifestone.cs:60, Bindstone.cs:76):
  // EnqueueMotion sends Sanctuary as the forward command, and the attune
  // fails with YouHaveMovedTooFar when the player has left the use radius.
  ['Sanctuary', MotionCommand.Sanctuary],
];

describe('every recall / attune motion lets the player jump (motion_allows_jump @ 005279e0)', () => {
  it.each(RECALLS)('%s', (_name, motion) => {
    expect(motionAllowsJump(motion)).toBe(0);
  });
});

const haveDat = existsSync(DAT_PATHS.portal);
const NONCOMBAT = MotionStance.NonCombat >>> 0;

describe.skipIf(!haveDat)('moving during a recall (BUG.recall-not-cancelled-by-moving)', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  /** The recall link's play time (what ACE's GetAnimationLength times the teleport by). */
  function recallSeconds(motion: number): number {
    const mm = new MotionManager(portal);
    mm.loadMotionTable(0x09000001);
    mm.setDefaultStance(1);
    mm.queueAction(MotionManager.compositeKey(NONCOMBAT, motion & 0xffff), 1);
    let t = 0;
    while (mm.motionsPending && t < 60) { mm.update(FRAME); t += FRAME; }
    return t;
  }

  it('a fresh W during /ls sends a running MoveToState at once; the body waits behind the recall link, as retail queues it', () => {
    const link = recallSeconds(MotionCommand.LifestoneRecall);
    expect(link).toBeGreaterThan(10); // the kneel is ~15 s
    const endMs = Math.ceil(link * 1000) + 4000;
    const r = simulateKeys({
      portal, events: [[1000, 'down', 'KeyW'], [endMs - 500, 'up', 'KeyW']], keyTimes: [1000, endMs - 500], endMs,
      style: MotionStance.NonCombat, runRate: 2.5,
      serverMotions: [{ t: 0, type: 0, style: NONCOMBAT & 0xffff, fwd: MotionCommand.Ready & 0xffff, fwdSpeed: 1, actions: [[MotionCommand.LifestoneRecall & 0xffff, 1]] }],
    });
    // The key took control back and the server heard it at once.
    const mts = r.wire.find((w) => w.a.kind === 'moveToState' && w.t >= 1000);
    expect(mts?.t).toBe(1000);
    expect(mts && mts.a.kind === 'moveToState' ? mts.a.raw.forward : 0).toBe(MotionCommand.WalkForward >>> 0);
    expect(mts && mts.a.kind === 'moveToState' ? mts.a.raw.holdKey : 0).toBe(2); // HoldKey.Run
    // Retail's sequence: no step until the recall link has played out…
    const at = (ms: number) => r.frames.filter((f) => f.t <= ms).pop()!;
    expect(Math.abs(at(link * 1000 - 500).fwd)).toBeLessThan(0.05);
    // …then the queued run moves the body.
    expect(at(endMs - 500).fwd).toBeGreaterThan(8);
  });

  /**
   * main.ts's jump, reduced to the animation side: Space charges, the
   * release runs triggerJump (jump_is_allowed → LeaveGround), the landing
   * runs onLanded (HitGround). The air time moves the body on the launch
   * velocity in main.ts; here only the sequence's offset after landing counts.
   */
  it.each(RECALLS)('a jump during %s drops the recall link, and the run that follows covers more than 8 m long before it would have ended', (_name, motion) => {
    const mm = new MotionManager(portal);
    mm.loadMotionTable(0x09000001);
    mm.setDefaultStance(1);
    const anim = new CharacterAnimController(mm);
    anim.runRate = 2.5;
    const cam = new CameraController(new THREE.PerspectiveCamera());
    cam.runRate = 2.5;
    cam.sequenceStep = (dt, st) => localSequenceStep({ motionManager: mm, update: (d, m) => mm.update(d, m) }, dt, st);
    cam.onTakeControlFromServer = () => anim.stopCompletely(cam);
    for (let i = 0; i < 30; i++) { cam.update(FRAME); anim.update(FRAME, cam); }
    // The server's recall motion (SendMotionAsCommands): control goes to the server.
    cam.loseControlToServer();
    if (motion === MotionCommand.Sanctuary) applyServerForwardToLocalPlayer(mm, motion & 0xffff, 1, NONCOMBAT);
    else {
      // SendMotionAsCommands: Ready, the recall in the commands list.
      applyServerForwardToLocalPlayer(mm, MotionCommand.Ready & 0xffff, 1, NONCOMBAT);
      mm.queueAction(MotionManager.compositeKey(NONCOMBAT, motion & 0xffff), 1);
    }
    const hasLink = mm.motionsPending;
    expect(hasLink).toBe(true); // the human table plays every recall from NonCombat Ready
    const step = () => { cam.update(FRAME); cam.useTime(anim.motionsPending, false); anim.update(FRAME, cam); };
    for (let i = 0; i < 30; i++) step();
    cam.handleKeyDown('KeyW', false, false);
    expect(cam.controlledByServer).toBe(false);
    for (let i = 0; i < 30; i++) step();
    // Space: charge, release, leave the ground.
    cam.handleKeyDown('Space', false, false);
    for (let i = 0; i < 10; i++) step();
    cam.handleKeyUp('Space');
    expect(anim.triggerJump(cam)).not.toBeNull();
    expect(mm.motionsPending && (mm.motion >>> 0) === (MotionManager.compositeKey(NONCOMBAT, motion & 0xffff) >>> 0)).toBe(false);
    for (let i = 0; i < 30; i++) step();
    anim.onLanded();
    const z0 = cam.camera.position.z;
    for (let i = 0; i < 180; i++) step(); // 3 s of running after the landing
    expect(-(cam.camera.position.z - z0)).toBeGreaterThan(8);
  });
});
