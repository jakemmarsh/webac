/**
 * DECOMP.escape-key-action — plain Escape is KeyMap action 0x27;
 * ClientUISystem::OnAction case 0x27 (decomp ~:347472): cancel a jump
 * charge; else drop UI focus; else (standing, no repeat attack) clear a
 * pending vendor target mode / toggle the Options Gameplay page with no
 * selection / deselect willingly; else StopCompletely, "Action interrupted"
 * when moving, AbortAutomaticAttack when a repeat attack runs.
 *
 * The old handler closed every panel (invented) and always deselected.
 * Behavioral: the real EscapeAction port, AttackRequestController,
 * CameraController, CharacterAnimController and GameUI method.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { escapeAction, ACTION_INTERRUPTED_TEXT, type EscapeActionDeps } from '../packages/renderer/src/controllers/EscapeAction.js';
import { AttackRequestController, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';
import { CLIENT_NOTICES } from '../packages/renderer/src/ui/ClientNotices.js';

function deps(over: Partial<Record<keyof EscapeActionDeps, unknown>> = {}) {
  const calls: string[] = [];
  const d: EscapeActionDeps = {
    jumpCharging: () => false,
    cancelJumpCharge: () => { calls.push('cancelJump'); },
    hasUiFocus: () => false,
    relinquishUiFocus: () => { calls.push('relinquish'); },
    isStandingStill: () => true,
    repeatAttackInProgress: () => false,
    abortAutomaticAttack: () => { calls.push('abort'); },
    vendorOpenPending: () => false,
    clearTargetMode: () => { calls.push('clearTargetMode'); },
    selectedId: () => 0,
    toggleGameplayOptions: () => { calls.push('toggleOptions'); },
    deselectWillingly: () => { calls.push('deselect'); },
    stopCompletely: () => { calls.push('stop'); },
    notice: (t: string) => { calls.push(`notice:${t}`); },
    ...(over as Partial<EscapeActionDeps>),
  };
  return { d, calls };
}

describe('ClientUISystem::OnAction case 0x27 — the order of the Escape branches', () => {
  it('1. a jump charge is cancelled and nothing else happens', () => {
    const { d, calls } = deps({ jumpCharging: () => true, hasUiFocus: () => true, selectedId: () => 5 });
    expect(escapeAction(d)).toBe('cancel-jump');
    expect(calls).toEqual(['cancelJump']);
  });

  it('2. a focused UI element gives up focus and nothing else happens', () => {
    const { d, calls } = deps({ hasUiFocus: () => true, selectedId: () => 5 });
    expect(escapeAction(d)).toBe('relinquish-focus');
    expect(calls).toEqual(['relinquish']);
  });

  it('3a. standing with nothing selected toggles the Options Gameplay page — no panel closing, no deselect', () => {
    const { d, calls } = deps();
    expect(escapeAction(d)).toBe('toggle-gameplay-options');
    expect(calls).toEqual(['toggleOptions']);
  });

  it('3b. standing with a selection deselects (willingly) and does not touch the options', () => {
    const { d, calls } = deps({ selectedId: () => 0x80000001 });
    expect(escapeAction(d)).toBe('deselect');
    expect(calls).toEqual(['deselect']);
  });

  it('3c. a pending vendor open only clears the target mode', () => {
    const { d, calls } = deps({ vendorOpenPending: () => true, selectedId: () => 7 });
    expect(escapeAction(d)).toBe('clear-target-mode');
    expect(calls).toEqual(['clearTargetMode']);
  });

  it('4a. moving: stop completely and say "Action interrupted"; the selection stays', () => {
    const { d, calls } = deps({ isStandingStill: () => false, selectedId: () => 5 });
    expect(escapeAction(d)).toBe('stop');
    expect(calls).toEqual(['stop', `notice:${ACTION_INTERRUPTED_TEXT}`]);
  });

  it('4b. standing but repeat-attacking: stop and abort the automatic attack, no notice', () => {
    const { d, calls } = deps({ repeatAttackInProgress: () => true, selectedId: () => 5 });
    expect(escapeAction(d)).toBe('stop');
    expect(calls).toEqual(['stop', 'abort']);
  });

  it('4c. moving and repeat-attacking: stop, notice, abort', () => {
    const { d, calls } = deps({ isStandingStill: () => false, repeatAttackInProgress: () => true });
    escapeAction(d);
    expect(calls).toEqual(['stop', `notice:${ACTION_INTERRUPTED_TEXT}`, 'abort']);
  });

  it('the notice is the retail 0x1a line', () => {
    expect(CLIENT_NOTICES.actionInterrupted.text).toBe('Action interrupted');
    expect(CLIENT_NOTICES.actionInterrupted.sink).toBe('spew');
  });
});

function attackHarness(repeat: boolean) {
  const state = { cancels: 0, bar: [] as number[] };
  const d: AttackRequestDeps = {
    now: () => 100, getTarget: () => 0x80000001, isAttackable: () => true, inReadyPosition: () => true,
    combatMode: () => 'melee', currentStyle: () => 0x8000003c, sliderPower: () => 0.5, autoRepeat: () => repeat,
    sendAttack: () => {}, setPowerBarLevel: (l) => state.bar.push(l), showError: () => {},
    sendCancelAttack: () => { state.cancels++; }, autoTarget: () => false, lastAttacker: () => 0,
    objectPresent: () => false, selectObject: () => {}, selectNextCompassItem: () => {},
  };
  return { c: new AttackRequestController(d), state };
}

describe('AttackRequestController — RepeatAttackInProgress @ 0056a860 / AbortAutomaticAttack @ 0056ae90', () => {
  it('RepeatAttackInProgress needs the Repeat Attacks option and an attack in progress or the combat bar up', () => {
    const off = attackHarness(false);
    off.c.handleCommenceAttack();
    expect(off.c.repeatAttackInProgress()).toBe(false);
    const on = attackHarness(true);
    expect(on.c.repeatAttackInProgress()).toBe(false);
    on.c.handleCommenceAttack();
    expect(on.c.repeatAttackInProgress()).toBe(true);
    const building = attackHarness(true);
    building.c.startAttackRequest(); // the combat power bar comes up
    expect(building.c.repeatAttackInProgress()).toBe(true);
  });

  it('AbortAutomaticAttack sends CancelAttack and ends the repeat only when an attack flag is set', () => {
    const idle = attackHarness(true);
    idle.c.abortAutomaticAttack();
    expect(idle.state.cancels).toBe(0);

    const busy = attackHarness(true);
    busy.c.handleCommenceAttack();
    busy.c.repeatAttacking = true;
    busy.c.abortAutomaticAttack();
    expect(busy.state.cancels).toBe(1);
    expect(busy.c.repeatAttacking).toBe(false);
  });

  it('a running combat build\'s power bar hides', () => {
    const h = attackHarness(true);
    h.c.startAttackRequest();
    expect(h.c.buildInProgress).toBe(true);
    h.c.abortAutomaticAttack();
    expect(h.state.cancels).toBe(1);
    expect(h.c.buildInProgress).toBe(false);
    expect(h.state.bar[h.state.bar.length - 1]).toBe(0);
  });
});

describe('Escape\'s motion side — StopCompletely, jump cancel, is_standing_still', () => {
  it('CameraController.stopCompletely clears the command lists and autorun; held keys move nothing', () => {
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 1, 0.1, 100));
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyDown('KeyD');
    cc.autoRun = true;
    cc.stopCompletely();
    expect(cc.autoRun).toBe(false);
    expect(cc.isMovingForward).toBe(false);
    expect(cc.isTurningRight).toBe(false);
    // The key must be pressed again to move.
    cc.simulateKeyUp('KeyW');
    cc.simulateKeyDown('KeyW');
    expect(cc.isMovingForward).toBe(true);
  });

  function anim() {
    const key = (m: number) => MotionManager.compositeKey(0x3d, m & 0xFFFFF);
    const mm = {
      queueAction: () => {}, setStanceFromId: () => {}, changeStyle: () => true,
      requestMotion: () => true, setForwardMotion: () => true, removeLinkAnimations: () => {},
      isPlayingAction: false, styleKey: 0x3d, stance: key(MotionCommand.Ready), motion: key(MotionCommand.Ready),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new CharacterAnimController(mm as any);
  }

  it('cancelJumpCharge ends the charge: the Space release that follows does not jump', () => {
    const cac = anim();
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 1, 0.1, 100));
    cc.simulateKeyDown('Space');
    cac.update(0, cc);
    cac.update(0.3, cc);
    expect(cac.jumpCharging).toBe(true);
    cac.cancelJumpCharge();
    expect(cac.jumpCharging).toBe(false);
    expect(cac.standingLongJump).toBe(false);
    cc.simulateKeyUp('Space');
    cac.update(0.016, cc);
    expect(cac.jumpCharging).toBe(false); // main.ts only jumps while charging
  });

  it('isStandingStill: on the ground, no forward / sidestep / turn', () => {
    const cac = anim();
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 1, 0.1, 100));
    expect(cac.isStandingStill(cc)).toBe(true);
    cc.simulateKeyDown('KeyA');
    expect(cac.isStandingStill(cc)).toBe(false);
    cc.simulateKeyUp('KeyA');
    cac.leaveGround();
    expect(cac.isStandingStill(cc)).toBe(false);
  });
});

describe('GameUI.toggleGameplayOptionsPage — DoVisibilityToggleAction(0x1000001b)', () => {
  function fakeUi(visible: boolean, tab: string) {
    const calls: string[] = [];
    const ui = {
      optionsPanelVisible: visible,
      optionsTab: tab,
      optionsSettings: { optionsTab: tab },
      saveOptionsSettings: () => { calls.push('save'); },
      renderOptionsPanel: () => { calls.push('render'); },
      setPanelsWindowPanel: (_p: unknown, show: boolean) => { calls.push(show ? 'show' : 'hide'); ui.optionsPanelVisible = show; },
    };
    return { ui, calls };
  }
  const toggle = GameUI.prototype.toggleGameplayOptionsPage;

  it('closed → opens on the Gameplay page', () => {
    const { ui, calls } = fakeUi(false, 'chat');
    toggle.call(ui as unknown as GameUI);
    expect(ui.optionsTab).toBe('gameplay');
    expect(ui.optionsPanelVisible).toBe(true);
    expect(calls).toContain('show');
  });

  it('open on Gameplay → hides', () => {
    const { ui, calls } = fakeUi(true, 'gameplay');
    toggle.call(ui as unknown as GameUI);
    expect(calls).toEqual(['hide']);
    expect(ui.optionsPanelVisible).toBe(false);
  });

  it('open on another page → switches to Gameplay, stays open', () => {
    const { ui, calls } = fakeUi(true, 'config');
    toggle.call(ui as unknown as GameUI);
    expect(ui.optionsTab).toBe('gameplay');
    expect(calls).toContain('render');
    expect(calls).not.toContain('hide');
  });
});
