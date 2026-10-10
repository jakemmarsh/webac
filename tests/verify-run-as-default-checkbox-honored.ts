/**
 * FAITHFUL.373 + CORE.2 — "Run As Default" movement polarity, tested
 * BEHAVIORALLY against the shipped CameraController (converted from a
 * source-text pin per the pin-conversion rule; the old pin regex-matched
 * CameraController.ts/main.ts source and could not catch a real inversion).
 *
 * Retail ground truth:
 *   - ACE CharacterOptions1.cs:24 — ToggleRun = 0x00000400, and :47 — the
 *     fresh-character Default flags INCLUDE ToggleRun (RunAsDefaultMovement
 *     ON). ACE PlayerFactory.cs:655 applies CharacterOptions1Default at
 *     character creation.
 *   - ACE CharacterOption.cs:45-46 — RunAsDefaultMovement = 0x0A maps to
 *     the ToggleRun bit ("ToggleRun_PlayerOption" in the retail client).
 *   - Decompiled retail client: ACCmdInterp::UITogglesRun @ 0058b180 reads
 *     PlayerModule::ToggleRun (@ 005d2da0); CommandInterpreter @ 006b3c80
 *     drives hold_run from it. Option ON = released keys RUN, Shift WALKS.
 *
 * So: default (no persisted opt-out) must be run-by-default; holding Shift
 * must WALK; the Options checkbox (runIsDefault=false) inverts both; NumLock
 * auto-run always runs forward (its own hold key; turns and sidesteps keep Shift's).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';
import {
  CharacterOptions1,
  CHARACTER_OPTIONS1_DEFAULT,
  CHARACTER_OPTION_BIT_MAP,
  characterOptionIsSet,
} from '../packages/shared/src/ace-enums';
import { WALK_ANIM_SPEED } from '../packages/shared/src/physics/MovementSystem';

function makeController(): CameraController {
  return new CameraController(new THREE.PerspectiveCamera());
}

/** Displacement magnitude from one 1s update() with the given keys held. */
function forwardDistance(cc: CameraController, keys: string[]): number {
  const cam = new THREE.PerspectiveCamera();
  (cc as unknown as { camera: THREE.PerspectiveCamera }).camera = cam;
  cam.position.set(0, 0, 0);
  for (const k of keys) cc.simulateKeyDown(k);
  cc.update(1.0);
  for (const k of keys) cc.simulateKeyUp(k);
  return cam.position.length();
}

describe('CORE.2 — run is default, Shift walks (ACE CharacterOptions1.Default + retail hold_run)', () => {
  it('fresh controller defaults to runIsDefault = true (retail default)', () => {
    expect(makeController().runIsDefault).toBe(true);
  });

  it('idle (no Shift) → isRunning true; Shift held → false (either Shift key)', () => {
    const cc = makeController();
    expect(cc.isRunning).toBe(true);
    cc.simulateKeyDown('ShiftLeft');
    expect(cc.isRunning).toBe(false);
    cc.simulateKeyUp('ShiftLeft');
    cc.simulateKeyDown('ShiftRight');
    expect(cc.isRunning).toBe(false);
    cc.simulateKeyUp('ShiftRight');
    expect(cc.isRunning).toBe(true);
  });

  it('W with no Shift moves at RUN speed (4.0×runRate); W+Shift at WALK speed (3.12)', () => {
    const cc = makeController();
    cc.runRate = 1.5;
    const run = forwardDistance(cc, ['KeyW']);
    const walk = forwardDistance(cc, ['KeyW', 'ShiftLeft']);
    expect(run).toBeCloseTo(RUN_ANIM_SPEED * 1.5, 3);
    expect(walk).toBeCloseTo(WALK_ANIM_SPEED, 3);
    expect(run).toBeGreaterThan(walk);
  });

  it('runIsDefault=false (Options opt-out) inverts the polarity', () => {
    const cc = makeController();
    cc.runIsDefault = false;
    expect(cc.isRunning).toBe(false);
    cc.simulateKeyDown('ShiftLeft');
    expect(cc.isRunning).toBe(true);
    cc.simulateKeyUp('ShiftLeft');
    const walk = forwardDistance(cc, ['KeyW']);
    const run = forwardDistance(cc, ['KeyW', 'ShiftLeft']);
    expect(walk).toBeCloseTo(WALK_ANIM_SPEED, 3);
    expect(run).toBeCloseTo(RUN_ANIM_SPEED * cc.runRate, 3);
  });

  it('auto-run always runs FORWARD, regardless of Shift or runIsDefault; turns and sidesteps keep the current hold key', () => {
    // ApplyCurrentMovement @ 006b3430: autorun is MovePlayer(WalkForward, …,
    // hold_run = 1) — HoldKey_Run on the forward command alone; adjust_motion
    // @ 00528010 gives every other command the current hold key (Shift XOR
    // Run as Default). MOVE.combination-sweep F2.
    const cc = makeController();
    cc.autoRun = true;
    cc.simulateKeyDown('ShiftLeft');
    expect(cc.isForwardRunning).toBe(true);
    expect(cc.isRunning).toBe(false);
    cc.runIsDefault = false;
    expect(cc.isForwardRunning).toBe(true);
    expect(cc.isRunning).toBe(true);
    expect(forwardDistance(cc, [])).toBeCloseTo(RUN_ANIM_SPEED * cc.runRate, 3);
  });

  it('even the floor runRate (Run skill 50 → ~1.55) keeps run faster than walk', () => {
    // getRunRate(0, 50) = ((1×(50/250×11))+4)/4 = 1.55 → run 6.2 > walk 3.12.
    // Guards the "run feels slower than walk" inversion at minimum skill.
    const cc = makeController();
    cc.runRate = 1.55;
    expect(forwardDistance(cc, ['KeyW'])).toBeGreaterThan(forwardDistance(cc, ['KeyW', 'ShiftLeft']));
  });
});

describe('CORE.2 — fresh-character server flags restore to run-by-default', () => {
  it('ACE CharacterOptions1.Default includes ToggleRun (0x400)', () => {
    expect(CharacterOptions1.ToggleRun).toBe(0x00000400);
    expect((CHARACTER_OPTIONS1_DEFAULT & CharacterOptions1.ToggleRun) !== 0).toBe(true);
  });

  it('option 0x0A (RunAsDefaultMovement) decodes as SET from the default CO1 word', () => {
    expect(CHARACTER_OPTION_BIT_MAP[0x0A]).toEqual({ field: 1, mask: CharacterOptions1.ToggleRun });
    expect(characterOptionIsSet(0x0A, CHARACTER_OPTIONS1_DEFAULT, 0)).toBe(true);
  });
});
