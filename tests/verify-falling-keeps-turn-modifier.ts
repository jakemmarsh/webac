/**
 * The local motion-table state through a jump (MotionTableState, kept by
 * CharacterAnimController): retail's CMotionInterp::LeaveGround @ 00528b00 →
 * apply_interpreted_movement @ 00528600 does DoInterpretedMotion(Falling) as an
 * ordinary substate change in CMotionTable::GetObjectSequence @ 00522860. The
 * human table's Falling cycle (0x3D0015 in NonCombat) has bitfield 0, so
 * clear_modifiers does not run and re_modify keeps a held turn modifier; the
 * held turn is then done again, and add_modifier's duplicate refusal +
 * StopSequenceMotion leave one copy. HitGround @ 00528ac0 →
 * apply_current_movement re-applies the forward command out of Falling the
 * same way: the turn rides through re_modify, still once.
 *
 * Ours used to reset the state to a bare Falling (no modifiers, no omega),
 * which retail does only for a cycle with bitfield & 1. Nothing reads the
 * state's omega for the heading today (CameraController turns the body), but
 * the state is the motion table's record and must match retail.
 *
 * Behavioural: the real CharacterAnimController + CameraController + the human
 * motion table from the portal DAT.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { DEFAULT_KEYBINDS, MOVEMENT_CANONICAL, activeInputMaps } from '../packages/renderer/src/input/KeybindDefaults.js';
import { CombatMode } from '@ac/shared';
import type { DatDatabase } from '@ac/dat-parser';

const haveDat = existsSync(DAT_PATHS.portal);
const FALLING = MotionCommand.Falling >>> 0;
const TURN = MotionCommand.TurnRight >>> 0;

describe.skipIf(!haveDat)('a held turn modifier survives Falling and is re-applied once at HitGround (GetObjectSequence @ 00522860)', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  function rig() {
    const mm = new MotionManager(portal);
    mm.loadMotionTable(0x09000001);
    mm.setDefaultStance(1);
    const anim = new CharacterAnimController(mm);
    anim.runRate = 1.635;
    const cam = new CameraController(new THREE.PerspectiveCamera());
    cam.runRate = 1.635;
    const keys = new KeybindRegistry(DEFAULT_KEYBINDS);
    keys.setActiveInputMaps(activeInputMaps(CombatMode.NonCombat));
    cam.keyTranslator = (code: string) => { const id = keys.resolve(code); return id != null ? MOVEMENT_CANONICAL[id] ?? null : null; };
    const tick = (n = 1) => { for (let i = 0; i < n; i++) { cam.update(1 / 60); anim.update(1 / 60, cam); } };
    return { mm, anim, cam, tick, state: () => mm.motionTableState! };
  }

  const turnCopies = (st: { modifiers: { motion: number }[] }) => st.modifiers.filter((m) => (m.motion >>> 0) === TURN).length;

  it('the human Falling cycle has bitfield 0 (the DAT fact the rule rests on)', () => {
    const { mm } = rig();
    const t = mm.activeMotionTable!;
    const falling = t.cycles.get(MotionManager.compositeKey(t.defaultStyle, FALLING & 0xffffff));
    expect(falling).toBeDefined();
    expect(falling!.bitfield & 1).toBe(0);
  });

  it('running and turning: in the air the substate is Falling with the turn still a modifier (one copy, its omega on)', () => {
    const { anim, cam, tick, state } = rig();
    cam.handleKeyDown('KeyW', false, false);
    cam.handleKeyDown('KeyD', false, false);
    tick(30);
    const omegaGround = state().omega.z;
    expect((state().substate >>> 0)).toBe(MotionCommand.RunForward >>> 0);
    expect(turnCopies(state())).toBe(1);
    expect(omegaGround).toBeLessThan(0);

    anim.leaveGround();
    expect(state().substate >>> 0).toBe(FALLING);
    expect(turnCopies(state())).toBe(1);
    // Falling's own cycle has no omega: only the turn's, once.
    expect(state().omega.z).toBeCloseTo(omegaGround, 6);
    tick(20); // the flight: the held keys change nothing
    expect(state().substate >>> 0).toBe(FALLING);
    expect(turnCopies(state())).toBe(1);
  });

  it('HitGround: the run comes back out of Falling and the turn is applied once (omega as before the jump)', () => {
    const { anim, cam, tick, state } = rig();
    cam.handleKeyDown('KeyW', false, false);
    cam.handleKeyDown('KeyD', false, false);
    tick(30);
    const omegaGround = state().omega.z;
    anim.leaveGround();
    tick(20);
    anim.onLanded();
    tick(2);
    expect(state().substate >>> 0).toBe(MotionCommand.RunForward >>> 0);
    expect(turnCopies(state())).toBe(1);
    expect(state().omega.z).toBeCloseTo(omegaGround, 6);
  });

  it('a standing jump while turning: the turn substate is not a modifier — Falling takes over and the turn returns as a modifier of Falling, then the substate again after landing', () => {
    const { anim, cam, tick, state } = rig();
    cam.handleKeyDown('KeyD', false, false);
    tick(30);
    expect(state().substate >>> 0).toBe(TURN);
    const omegaGround = state().omega.z;
    anim.leaveGround();
    expect(state().substate >>> 0).toBe(FALLING);
    // GetObjectSequence: the turn that was the substate becomes Falling's modifier (add_modifier_no_check).
    expect(turnCopies(state())).toBe(1);
    expect(state().omega.z).toBeCloseTo(omegaGround, 6);
    anim.onLanded();
    tick(2);
    expect(turnCopies(state()) + ((state().substate >>> 0) === TURN ? 1 : 0)).toBe(1);
    expect(state().omega.z).toBeCloseTo(omegaGround, 6);
  });

  it('no turn held: Falling carries no modifiers and no omega, and landing returns to the run', () => {
    const { anim, cam, tick, state } = rig();
    cam.handleKeyDown('KeyW', false, false);
    tick(30);
    anim.leaveGround();
    expect(state().modifiers).toEqual([]);
    expect(state().omega.z).toBe(0);
    anim.onLanded();
    tick(2);
    expect(state().substate >>> 0).toBe(MotionCommand.RunForward >>> 0);
    expect(state().modifiers).toEqual([]);
  });
});
