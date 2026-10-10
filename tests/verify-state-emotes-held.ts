/**
 * SWEEP1006 state emotes — ACCmdInterp::OnAction / ClientCommunicationSystem::
 * Pose send an emote through SetMotion(cmd, true): a SubState-class command
 * (0x43xxxxxx, the "… State" emotes, *dance* / *afk* / *kneel*) becomes the
 * held forward command, so GetObjectSequence's SubState branch holds its
 * cycle (the DAT human table loops the dance, holds the bow). Ours played
 * them once and snapped back. main.ts (the command system's playPoseMotion)
 * routes isSubstateCommand emotes to
 * CharacterAnimController.setHeldSubstate; action-class emotes stay one-shots.
 */
import { describe, it, expect } from 'vitest';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { isSubstateCommand, MotionCommand as MC } from '../packages/renderer/src/animation/MotionCommands.js';
import { string2command } from '../packages/renderer/src/chat/commands/RetailCommandStrings.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';

describe('which emotes are held', () => {
  // Pose @ 00580480 looks the word up in the ChatPoseTable (0x0E000007) and
  // runs string2command on its state name: *dance* → DrudgeDanceState,
  // *afk* → AFKState, *kneel* → KneelState, *wave* → Wave
  // (docs/retail-commands/chatposetable.tsv, from the EoL DAT).
  it('*dance* / *afk* / *kneel* are State (substate) commands; *wave* / Wave / BowDeep are actions', () => {
    for (const state of ['DrudgeDanceState', 'AFKState', 'KneelState']) expect(isSubstateCommand(string2command(state)), state).toBe(true);
    expect(isSubstateCommand(string2command('Wave'))).toBe(false);
    expect(string2command('AFKState')).toBe(MC.AFKState);
    expect(isSubstateCommand(MC.BowDeep)).toBe(false);
    expect(isSubstateCommand(MC.BowDeepState)).toBe(true);
  });
});

describe('a held State emote stays until movement', () => {
  it('setHeldSubstate(AFKState): the AFK cycle is requested and held; walking forward ends it', () => {
    const STYLE = 0x3d;
    const key = (m: number) => MotionManager.compositeKey(STYLE, m & 0xFFFFF);
    const links: number[] = [];
    const mm = {
      queueAction: () => {}, setStanceFromId: () => {}, changeStyle: () => true,
      requestMotion: () => true, setForwardMotion: (k: number) => { links.push(k); return true; },
      getCycleLength: () => 1, isPlayingAction: false, styleKey: STYLE, stance: key(MC.Ready), motion: key(MC.Ready),
      removeLinkAnimations: () => {},
    };
    const cac = new CharacterAnimController(mm as never);
    const input = (fwd = false) => ({ isJumpHeld: false, isMovingForward: fwd, isMovingBackward: false, isStrafingLeft: false,
      isStrafingRight: false, isTurningLeft: false, isTurningRight: false, isRunning: true }) as never;
    cac.update(0.016, input());
    cac.setHeldSubstate(MC.AFKState);
    cac.update(0.016, input());
    expect(links.at(-1)).toBe(key(MC.AFKState));
    expect(cac.heldSubstate).toBe(MC.AFKState);
    cac.update(0.016, input());
    expect(cac.heldSubstate).toBe(MC.AFKState); // held across frames
    cac.update(0.016, input(true));
    expect(cac.heldSubstate).toBe(0);
  });
});
