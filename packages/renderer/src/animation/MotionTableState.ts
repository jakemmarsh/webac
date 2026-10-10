/**
 * The motion table's own record of what an object is doing — MotionState as
 * CMotionTable keeps it (substate, substate_mod, the modifier list) — and the
 * decisions CMotionTable::GetObjectSequence @ 00522860 / StopSequenceMotion
 * @ 00522fc0 / re_modify @ 005222e0 make with it for the locomotion commands.
 *
 * Which of a held turn and sidestep plays as the substate cycle and which as
 * a modifier depends on history, not on the commands alone:
 *  - a turn or sidestep becomes the substate only from the style's default
 *    substate (is_allowed @ 005226c0: both cycles carry bitfield 0x2);
 *    otherwise it is a modifier (add_modifier pushes at the HEAD of the list);
 *  - a new forward command (Walk / Run) takes the substate, and a turn or
 *    sidestep that was the substate becomes a modifier (add_modifier_no_check);
 *  - the forward command stopping returns the substate to the default and
 *    re_modify re-applies the modifiers head first — so the most recently
 *    added one becomes the substate and the rest stay modifiers.
 * The sequence velocity is an accumulator, as CSequence keeps it: a
 * substate change SETS it to the new cycle's (add_motion → set_velocity), a
 * modifier ADDS its own (combine_motion), stopping a modifier SUBTRACTS it
 * once (subtract_motion). re_modify takes each modifier off the list with
 * remove_modifier — which subtracts nothing — and applies it again; when a
 * nested re_modify (inside the substate change the first one caused) has
 * already re-added a modifier, the outer loop applies it a second time and
 * its velocity counts twice. That is retail's sliding: run with a sidestep
 * and a turn held, release the run, and the sidestep runs at double speed;
 * release the sidestep and one copy stays — the player slides sideways until
 * the next substate change clears the physics (MOVE.combination-sweep,
 * sweep-triple-W?? recordings: ~2.9 m/s then ~1.5 m/s after the key-up).
 *
 * The animation side (links, cycles) stays MotionManager's: `onSubstate`
 * hears every substate change, in order, with the speed to play it at.
 */
import type { MotionTable } from '@ac/dat-parser';
import { MotionCommand } from './MotionCommands.js';
import { cycleOf, modifierOf } from '../world/RemoteMotion.js';

export interface MotionEntry { motion: number; speed: number }

const SUBSTATE_CLASS = 0x40000000;
const MODIFIER_CLASS = 0x20000000;

export class MotionTableState {
  substate: number = MotionCommand.Ready;
  substateMod = 1;
  /** Head first (MotionState::modifier_head). */
  modifiers: MotionEntry[] = [];

  /** CSequence::velocity / omega (object-local). */
  velocity = { x: 0, y: 0, z: 0 };
  omega = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly table: MotionTable,
    private readonly style: () => number,
    private readonly onSubstate: (motion: number, speed: number) => void,
  ) {}

  private get defaultSubstate(): number {
    const st = this.style();
    return this.table.styleDefaults.get(st) ?? this.table.styleDefaults.get(this.table.defaultStyle) ?? MotionCommand.Ready;
  }

  /** CMotionTable::is_allowed @ 005226c0. */
  private isAllowed(motion: number): boolean {
    const cyc = cycleOf(this.table, this.style(), motion);
    if (!cyc) return false;
    if ((cyc.bitfield & 2) === 0) return true;
    return motion === this.substate || this.substate === this.defaultSubstate;
  }

  /** DoObjMotion → GetObjectSequence for a substate / modifier command. False: the table refused it. */
  doMotion(motion: number, speed: number, fromStop = false): boolean {
    const def = this.defaultSubstate;
    // DoMotion(default) on a turn / sidestep substate (not from a stop) is a no-op.
    if (motion === def && !fromStop && (this.substate & MODIFIER_CLASS) !== 0) return true;
    if ((motion & SUBSTATE_CLASS) !== 0 && this.isAllowed(motion)) {
      const cyc = cycleOf(this.table, this.style(), motion);
      if (motion === this.substate && Math.sign(speed) === Math.sign(this.substateMod) && speed !== 0) {
        // change_cycle_speed + subtract_motion(old) + combine_motion(new).
        this.accumulate(cyc, -this.substateMod);
        this.accumulate(cyc, speed);
        this.substateMod = speed;
        this.onSubstate(motion, speed);
        return true;
      }
      if (cyc && (cyc.bitfield & 1) !== 0) this.modifiers = [];
      const old = this.substate;
      // clear_physics, then add_motion of the links and the cycle: the last
      // set_velocity wins — the cycle's at the new speed.
      this.velocity = { x: 0, y: 0, z: 0 };
      this.omega = { x: 0, y: 0, z: 0 };
      this.accumulate(cyc, speed);
      // GetObjectSequence :282294 — a turn / sidestep substate becomes a
      // modifier of the new substate, unless the new one is the default.
      if (old !== motion && (old & MODIFIER_CLASS) !== 0 && motion !== def) {
        this.modifiers.unshift({ motion: old, speed: this.substateMod }); // add_modifier_no_check
      }
      this.substate = motion;
      this.substateMod = speed;
      this.onSubstate(motion, speed);
      this.reModify();
      return true;
    }
    if ((motion & MODIFIER_CLASS) !== 0) {
      const subCyc = cycleOf(this.table, this.style(), this.substate);
      if (!subCyc || (subCyc.bitfield & 1) !== 0) return false;
      const mod = modifierOf(this.table, this.style(), motion);
      if (!mod) return false;
      if (!this.addModifier(motion, speed)) {
        this.stopMotion(motion);
        if (!this.addModifier(motion, speed)) return false;
      }
      this.accumulate(mod, speed); // combine_motion
      return true;
    }
    return false;
  }

  /** StopSequenceMotion @ 00522fc0. */
  stopMotion(motion: number): void {
    if ((motion & SUBSTATE_CLASS) !== 0 && motion === this.substate) {
      this.doMotion(this.defaultSubstate, 1, true);
      return;
    }
    if ((motion & MODIFIER_CLASS) !== 0) {
      const i = this.modifiers.findIndex((m) => m.motion === motion);
      if (i < 0) return;
      this.accumulate(modifierOf(this.table, this.style(), motion), -this.modifiers[i].speed); // subtract_motion
      this.modifiers.splice(i, 1);
    }
  }

  /** MotionState::add_modifier @ 00526340: no duplicate, not the substate; pushed at the head. */
  private addModifier(motion: number, speed: number): boolean {
    if (this.modifiers.some((m) => m.motion === motion) || this.substate === motion) return false;
    this.modifiers.unshift({ motion, speed });
    return true;
  }

  /**
   * re_modify @ 005222e0, as written: a copy of the list counts the passes;
   * each pass takes the state's CURRENT head off (remove_modifier: the list
   * only, no subtract_motion) and runs it through GetObjectSequence again.
   */
  private reModify(): void {
    if (!this.modifiers.length) return;
    let passes = this.modifiers.length;
    while (passes-- > 0) {
      const head = this.modifiers.shift();
      if (!head) return;
      this.doMotion(head.motion, head.speed);
    }
  }

  private accumulate(d: { velocity?: { x: number; y: number; z: number }; omega?: { x: number; y: number; z: number } } | undefined, s: number): void {
    if (!d) return;
    if (d.velocity) { this.velocity.x += d.velocity.x * s; this.velocity.y += d.velocity.y * s; this.velocity.z += d.velocity.z * s; }
    if (d.omega) { this.omega.x += d.omega.x * s; this.omega.y += d.omega.y * s; this.omega.z += d.omega.z * s; }
  }

  /** Back to `substate` with no modifiers and no physics (a style change, a revive, Falling). */
  reset(substate: number): void {
    this.substate = substate;
    this.substateMod = 1;
    this.modifiers = [];
    this.velocity = { x: 0, y: 0, z: 0 };
    this.omega = { x: 0, y: 0, z: 0 };
    this.accumulate(cycleOf(this.table, this.style(), substate), 1);
  }

  /** The sequence velocity / omega now (CSequence::velocity / omega). */
  physics(): { velocity: { x: number; y: number; z: number }; omega: { x: number; y: number; z: number } } {
    return { velocity: { ...this.velocity }, omega: { ...this.omega } };
  }
}
