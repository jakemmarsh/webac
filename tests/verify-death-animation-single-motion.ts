/**
 * GAP.53 — "Death animation per heritage + per cause". PREMISE CORRECTION:
 * retail AC plays a SINGLE death motion (MotionCommand.Dead) for every
 * death — there is no per-cause and no explicit per-heritage death
 * animation. The cause of death varies only the server-sent death MESSAGE
 * text; heritage variation is implicit (each character/creature model has
 * its own Dead cycle in its own MotionTable — not a separate system).
 *
 * ACE ground truth (both player and creature death):
 *   Player_Death.cs:185   var deathAnim  = new Motion(MotionStance.NonCombat, MotionCommand.Dead);
 *   Creature_Death.cs:120 var motionDeath = new Motion(MotionStance.NonCombat, MotionCommand.Dead);
 *   MotionCommand.cs      Dead = 0x40000011
 * One motion, cause-independent.
 *
 * DECOMP.death-anim-restarts — that server motion is the ONLY death
 * trigger: the local Health=0 path (CharacterAnimController.markDead) is
 * state only and requests no animation, and a re-sent Dead while dead is a
 * same-substate request that only re-speeds the cycle
 * (CMotionTable::GetObjectSequence @ 00522860, :282254-282260), so the fall
 * never restarts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { Sound } from '@ac/shared';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { openDat } from './_harness/dat.js';

const DEAD_WIRE_INDEX = 0x11; // low bits of MotionCommand.Dead (0x40000011)

/** Minimal MotionManager stub recording every animation request. */
function makeStub(styleId: number, alreadyDead = false) {
  const calls: string[] = [];
  let stance = styleId;
  let dead = alreadyDead;
  return {
    calls,
    get styleKey() { return stance & 0xffff; },
    get isDead() { return dead; },
    isPlayingAction: false,
    isPlayingSubstateLink: false,
    requestMotion(key: number) { calls.push(`request ${key.toString(16)}`); return true; },
    setForwardMotion(key: number) { calls.push(`forward ${key.toString(16)}`); return true; },
    playDeath(wireIndex: number) { calls.push(`death ${wireIndex.toString(16)}`); dead = true; return true; },
    revive() { dead = false; },
    setStanceFromId(id: number) { stance = id; return true; },
    setStance(id: number) { stance = id; },
  };
}

const idle = {
  isJumpHeld: false, isMovingForward: false, isMovingBackward: false, isStrafingLeft: false,
  isStrafingRight: false, isTurningLeft: false, isTurningRight: false, isRunning: false,
} as never;
const walking = { ...(idle as object), isMovingForward: true } as never;

describe('GAP.53 — death animation is a single cause-independent MotionCommand.Dead', () => {
  it('MotionCommand.Dead === 0x40000011 (ACE-anchored; played for every death)', () => {
    expect(MotionCommand.Dead).toBe(0x40000011);
  });
});

describe('DECOMP.death-anim-restarts — the local Health=0 path is state only', () => {
  it('markDead() requests no animation (the server Dead motion is the only trigger)', () => {
    const stub = makeStub(MotionStance.NonCombat);
    const c = new CharacterAnimController(stub as unknown as MotionManager);
    c.markDead();
    expect(stub.calls).toEqual([]);
  });

  it('once dead (by markDead or by the server motion) input no longer drives locomotion', () => {
    const a = makeStub(MotionStance.NonCombat);
    const ca = new CharacterAnimController(a as unknown as MotionManager);
    ca.markDead();
    ca.update(1 / 30, walking);
    expect(a.calls).toEqual([]);

    // The Dead motion can land before our own Health=0 update.
    const b = makeStub(MotionStance.NonCombat, true);
    const cb = new CharacterAnimController(b as unknown as MotionManager);
    cb.update(1 / 30, walking);
    expect(b.calls).toEqual([]);
  });

  it('revive() clears both dead states so input drives locomotion again', () => {
    const stub = makeStub(MotionStance.NonCombat, true);
    const c = new CharacterAnimController(stub as unknown as MotionManager);
    c.markDead();
    c.revive();
    expect(stub.isDead).toBe(false);
    c.update(1 / 30, walking);
    expect(stub.calls.some((s) => s.startsWith('forward'))).toBe(true);
  });
});

describe('BUG.nonpositional-human-table-sounds / DECOMP.death-anim-restarts — the server Dead motion', () => {
  const hasDat = fs.existsSync('dat/client_portal.dat');
  describe.skipIf(!hasDat)('DAT: human motion table 0x09000001', () => {
    let db: DatDatabase;
    beforeAll(() => { db = openDat('dat/client_portal.dat'); });

    function human() {
      const mm = new MotionManager(db as never);
      expect(mm.loadMotionTable(0x09000001)).not.toBeNull();
      mm.setStanceFromId(MotionStance.NonCombat);
      const hooks: Array<{ hookType: number; soundType?: number }> = [];
      mm.onHook((hook) => { hooks.push(hook as unknown as { hookType: number; soundType?: number }); });
      return { mm, hooks };
    }
    const knockdowns = (hooks: Array<{ hookType: number; soundType?: number }>) =>
      hooks.filter((h) => h.hookType === AnimationHookType.SoundTable && h.soundType === Sound.Knockdown3).length;

    it('dying from NonCombat plays the 0x030000C6 link, whose frame-0 hook is the Knockdown3 fall sound', () => {
      const { mm, hooks } = human();
      mm.playDeath(DEAD_WIRE_INDEX);
      expect(mm.isDead).toBe(true);
      for (let i = 0; i < 90; i++) mm.update(1 / 30);
      expect(knockdowns(hooks)).toBe(1);
      expect(hooks.some((h) => h.soundType === Sound.Death1)).toBe(false);
    });

    it('a re-sent Dead mid-fall does not restart it (one fall, one Knockdown3)', () => {
      const { mm, hooks } = human();
      mm.playDeath(DEAD_WIRE_INDEX);
      for (let i = 0; i < 10; i++) mm.update(1 / 30);
      const frame = mm.animationPlayer.currentFrameIndex;
      expect(frame).toBeGreaterThan(0);
      expect(mm.playDeath(DEAD_WIRE_INDEX)).toBe(true);
      expect(mm.animationPlayer.currentFrameIndex).toBe(frame);
      for (let i = 0; i < 90; i++) mm.update(1 / 30);
      expect(knockdowns(hooks)).toBe(1);
    });

    it('a re-sent Dead once lying dead keeps the Dead pose (no second fall)', () => {
      const { mm, hooks } = human();
      mm.playDeath(DEAD_WIRE_INDEX);
      for (let i = 0; i < 120; i++) mm.update(1 / 30);
      const deadKey = MotionManager.compositeKey(MotionStance.NonCombat, DEAD_WIRE_INDEX);
      expect(mm.stance).toBe(deadKey);
      expect(mm.isPlayingAction).toBe(false);
      mm.playDeath(DEAD_WIRE_INDEX);
      expect(mm.isPlayingAction).toBe(false);
      for (let i = 0; i < 60; i++) mm.update(1 / 30);
      expect(knockdowns(hooks)).toBe(1);
    });
  });
});
