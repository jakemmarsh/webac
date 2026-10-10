/**
 * BUG.jump-charge-frame-dependent — jump power bar must fill by elapsed
 * wall-clock time, not by update() call count, so charge speed is the same
 * at any framerate.
 *
 * ACE ground truth (client-side only — ACE server has no charge timer):
 *  - acclient-decompiled.c:353426-353467 ClientCombatSystem::GetPowerBarLevel
 *    — fill = (now - buildStartTime) / duration, clamped [0,1].
 *  - acclient-decompiled.c:353595-353613 GetJumpPowerLevel — calls
 *    GetPowerBarLevel directly (jump shares the attack power-bar timer).
 *  - duration is ATTACK_POWERUP_TIME (1.0s) normally, or
 *    DUAL_WIELD_POWERUP_TIME (0.8s) when current_style is dual-wield —
 *    both extracted as IEEE-754 doubles from acclient.exe's .rdata section
 *    (.rdata+0x3cfc8 / +0x3cfd0) via the retail PDB's global symbol records.
 */
import { describe, it, expect } from 'vitest';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';

function makeController() {
  const mm = {
    queueAction: () => {},
    setStanceFromId: () => {},
    changeStyle: () => true,
    requestMotion: () => {},
    isPlayingAction: false,
    styleKey: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CharacterAnimController(mm as any);
}

function noInput(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    isJumpHeld: false,
    isMovingForward: false,
    isMovingBackward: false,
    isStrafingLeft: false,
    isStrafingRight: false,
    isTurningLeft: false,
    isTurningRight: false,
    isRunning: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('BUG.jump-charge-frame-dependent — elapsed-time jump charge', () => {
  it('reaches the same power after the same elapsed real time at different framerates', () => {
    // 30 fps: 15 frames of dt=1/30 = 0.5s elapsed
    const cac30 = makeController();
    cac30.update(0, noInput({ isJumpHeld: true })); // edge-detect start (dt=0 so no charge yet)
    for (let i = 0; i < 15; i++) cac30.update(1 / 30, noInput({ isJumpHeld: true }));

    // 144 fps: 72 frames of dt=1/144 = 0.5s elapsed
    const cac144 = makeController();
    cac144.update(0, noInput({ isJumpHeld: true }));
    for (let i = 0; i < 72; i++) cac144.update(1 / 144, noInput({ isJumpHeld: true }));

    expect(cac30.jumpPower).toBeCloseTo(0.5, 6);
    expect(cac144.jumpPower).toBeCloseTo(0.5, 6);
  });

  it('caps at full power after ATTACK_POWERUP_TIME (1.0s) and does not overshoot', () => {
    const cac = makeController();
    cac.update(0, noInput({ isJumpHeld: true }));
    for (let i = 0; i < 200; i++) cac.update(1 / 144, noInput({ isJumpHeld: true }));
    expect(cac.jumpPower).toBe(1.0);
  });

  it('uses the shorter DUAL_WIELD_POWERUP_TIME (0.8s) duration in dual-wield stance', () => {
    const cac = makeController();
    cac.setStance(MotionStance.DualWieldCombat);
    cac.update(0, noInput({ isJumpHeld: true }));
    for (let i = 0; i < 12; i++) cac.update(1 / 30, noInput({ isJumpHeld: true })); // 0.4s elapsed
    // 0.4s / 0.8s duration == 0.5 power (would be 0.4 under the 1.0s single-weapon duration)
    expect(cac.jumpPower).toBeCloseTo(0.5, 6);
  });

  it('does not charge while jump is not held', () => {
    const cac = makeController();
    for (let i = 0; i < 30; i++) cac.update(1 / 30, noInput());
    expect(cac.jumpPower).toBe(0);
    expect(cac.jumpCharging).toBe(false);
  });
});
