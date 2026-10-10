import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { MotionTable, type AnimData, type MotionData } from '@ac/dat-parser/file-types/MotionTable.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { AnimationPlayer, SEQUENCE_EPSILON, type HookCallback } from './AnimationPlayer.js';
import type { SequenceMotion } from './SequenceFrame.js';
import { MotionCommand, MotionSpeed, motionCommandFromWireIndex, isActionCommand } from './MotionCommands.js';
import { wavePrefetch } from '../audio/WavePrefetch.js';

/** `same_sign @ 00522260`: both ≥ 0, or both < 0. */
export function sameSign(a: number, b: number): boolean {
  return a >= 0 ? b >= 0 : b < 0;
}

/** One link of a chain (CMotionTable::add_motion(sequence, link, speed)), with the action's completion callback on the action's own link. */
interface ChainLink { data: MotionData; speed: number; onComplete?: () => void }

/**
 * MotionManager — high-level animation state machine.
 *
 * Manages stance/action transitions using MotionTable data,
 * drives an AnimationPlayer for playback.
 *
 * Every cycle loops (DECOMP.emote-cycles-freeze): `CSequence::advance_to_next_animation
 * @ 005252b0` wraps past the last node to `first_cyclic`, whatever the cycle
 * is. A hold (a door's open / shut pose, the Dead pose, a cast gesture's
 * hands-out) is DATA — a framerate-0 node never advances.
 */
export class MotionManager {
  private portalDb: DatDatabase;
  private motionTable: MotionTable | null = null;
  private player: AnimationPlayer;
  private currentStance = 0;
  private currentMotion = 0;
  /** MotionState::substate_mod — the speed the current substate cycle plays at. */
  private currentSubstateSpeed = 1.0;
  /**
   * What follows the playing link / action, in order (CSequence's pending
   * anims): an ACTION entry plays link(substate → action) and returns to the
   * substate cycle; a SUBSTATE entry (a substate change that arrived while a
   * link or action was still playing — GetObjectSequence only drops the
   * CYCLIC tail, `remove_cyclic_anims`, so the playing links finish first)
   * plays link(substate → new) and makes the new substate current.
   */
  private actionQueue: { motionId: number; speed: number; onComplete?: () => void; substate?: boolean }[] = [];
  /**
   * The MotionData being played node by node (retail appends EVERY AnimData
   * of a link / cycle to the sequence — ACE MotionTable.add_motion); `index`
   * is the node on the player. A multi-node cycle loops over all its nodes.
   */
  private nodeSeq: { data: MotionData; speed: number; looping: boolean; index: number; onComplete?: () => void } | null = null;
  private animationCache = new Map<number, Animation>();
  private playingAction = false;
  /**
   * The links of the playing chain still to come, each at its own speed
   * (GetObjectSequence appends link(current → default) at substate_mod,
   * link(default → target) at the new speed, …).
   */
  private linkQueue: ChainLink[] = [];
  /** What the playing chain is: a substate change's links, an action, a style change, or the death fall. */
  private chainKind: 'substate' | 'action' | 'style' | 'death' | null = null;
  private _currentStyleId = 0;
  private _isDead = false;
  private _deathCycleKey = 0;
  /**
   * STREAM.initial-motion-not-retried — the last node put on the player found
   * its Animation not resident (a streamed DAT miss). The motion state is
   * committed regardless (CMotionInterp holds it whatever the parts show);
   * only the drawing is behind, and retryMissedAnimation catches it up.
   */
  private _animationMissed = false;

  constructor(portalDb: DatDatabase) {
    this.portalDb = portalDb;
    this.player = new AnimationPlayer();
  }

  get animationPlayer(): AnimationPlayer {
    return this.player;
  }

  get activeMotionTable(): MotionTable | null {
    return this.motionTable;
  }

  get stance(): number {
    return this.currentStance;
  }

  get motion(): number {
    return this.currentMotion;
  }

  /** Raw stance ID (e.g. 0x8000003d for NonCombat). */
  get currentStyleId(): number {
    return this._currentStyleId;
  }

  /** Lower 16 bits of current style, for compositeKey building. */
  get styleKey(): number {
    return this._currentStyleId & 0xFFFF;
  }

  /** Override the style ID without replaying the stance animation.
   *  Used by CharacterAnimController to enforce combat stance
   *  without interrupting movement animations. */
  overrideStyleId(stanceId: number): void {
    this._currentStyleId = stanceId;
  }

  /**
   * The local player's motion-table state (animation/MotionTableState.ts),
   * set by its CharacterAnimController: localSequenceStep takes the sequence
   * velocity from it. Null for every other object.
   */
  motionTableState: import('./MotionTableState.js').MotionTableState | null = null;

  /** Whether an action (attack/cast/emote) is currently playing. */
  get isPlayingAction(): boolean {
    return this.playingAction;
  }

  /**
   * CPhysicsObj::motions_pending @ 0050eab0 (CMotionInterp's pending_motions
   * list): a motion still playing out — an action, a link chain — or one
   * queued behind it.
   */
  get motionsPending(): boolean {
    return this.playingAction || this.actionQueue.length > 0;
  }

  /**
   * The playing chain is only a substate change's links (Ready → WalkForward
   * …), not an action, style change or death: the next substate change is
   * simply appended after it (GetObjectSequence's `remove_cyclic_anims`
   * keeps the links), so the local controller keeps steering through it.
   */
  get isPlayingSubstateLink(): boolean {
    return this.playingAction && this.chainKind === 'substate';
  }

  /** Whether the entity is dead (holds death pose, no return to idle). */
  get isDead(): boolean {
    return this._isDead;
  }

  /**
   * Load a MotionTable from portal.dat.
   */
  loadMotionTable(motionTableId: number): MotionTable | null {
    const data = this.portalDb.getFileData(motionTableId);
    if (!data) return null;
    this.motionTable = new MotionTable(new DatReader(data));
    return this.motionTable;
  }

  /**
   * Set the MotionTable directly (e.g., from cache).
   */
  setMotionTable(mt: MotionTable): void {
    this.motionTable = mt;
  }

  /**
   * Load an Animation from portal.dat (cached).
   */
  loadAnimation(animId: number): Animation | null {
    const cached = this.animationCache.get(animId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(animId);
    if (!data) return null;

    const anim = new Animation(new DatReader(data));
    this.animationCache.set(animId, anim);
    wavePrefetch().hooks(anim.partFrames); // SOUND.wave-precache — SoundHook/SoundTweakedHook::UnPack
    return anim;
  }

  /**
   * Build composite cycle key from stance and motion.
   * ACE format: (stance << 16) | (motion & 0xFFFFF)
   */
  static compositeKey(stance: number, motion: number): number {
    return ((stance & 0xFFFF) << 16) | (motion & 0xFFFFF);
  }

  /**
   * The state's style: the style id last set, else the one the current
   * substate's key carries (a table driven by composite keys alone).
   */
  private get stateStyle(): number {
    return this._currentStyleId || ((0x80000000 | (this.currentStance >>> 16)) >>> 0);
  }

  /** The link from the current substate (at its speed) to `wireIndex` at forward speed 1.0. */
  private findLink(wireIndex: number): MotionData | null {
    return this.getLink(this.stateStyle, this.currentStance & 0xFFFF, this.currentSubstateSpeed, wireIndex, 1.0);
  }

  /**
   * GetObjectSequence's SubState branch links (CMotionTable::GetObjectSequence
   * @ 00522860, :282266-282286) from the current substate at its speed to
   * `targetWire` at `speed`:
   *   link = get_link(style, substate, substate_mod, target, speed);
   *   no link, or the speed changes sign → link = get_link(style, substate,
   *   substate_mod, default, 1.0) and via = get_link(style, default, 1.0,
   *   target, speed);
   *   no via → link at speed (negated when substate_mod < 0 < speed);
   *   else    → link at substate_mod, then via at speed.
   * Links without animations add nothing (add_motion of an empty list).
   */
  private substateLinks(targetWire: number, speed: number): ChainLink[] {
    const T = this.motionTable;
    if (!T) return [];
    const style = this.stateStyle;
    const cur = this.currentStance & 0xFFFF;
    const mod = this.currentSubstateSpeed;
    let link = this.getLink(style, cur, mod, targetWire, speed);
    let via: MotionData | null = null;
    if (!link || !sameSign(speed, mod)) {
      const def = T.styleDefaults.get(style) ?? 0;
      link = this.getLink(style, cur, mod, def, 1.0);
      via = this.getLink(style, def, 1.0, targetWire, speed);
    }
    const chain: ChainLink[] = [];
    if (!via) {
      if (link) chain.push({ data: link, speed: mod < 0 && speed > 0 ? -speed : speed });
    } else {
      if (link) chain.push({ data: link, speed: mod });
      chain.push({ data: via, speed });
    }
    return chain.filter((l) => l.data.anims.length > 0);
  }

  /** Start a chain of links (none → false); the rest follow node by node (advanceFinishedNode). */
  private playChain(chain: ChainLink[], kind: 'substate' | 'action' | 'style' | 'death'): boolean {
    const first = chain[0];
    if (!first) return false;
    this.playingAction = true;
    this.chainKind = kind;
    this.linkQueue = chain.slice(1);
    return this.playMotionData(first.data, first.speed, false, first.onComplete);
  }

  /**
   * `change_cycle_speed @ 00522290`: a same-substate request at the same
   * sign only re-speeds the cyclic tail — multiply_cyclic_animation_fr by
   * new / old (old ≈ 0: only a new ≈ 0 zeroes it). Links still playing keep
   * their speed; the frame number is not reset.
   */
  private changeCycleSpeed(speed: number): void {
    const old = this.currentSubstateSpeed;
    this.currentSubstateSpeed = speed;
    let factor: number | null = null;
    if (Math.abs(old) > SEQUENCE_EPSILON) factor = speed / old;
    else if (Math.abs(speed) < SEQUENCE_EPSILON) factor = 0;
    if (factor === null || this.playingAction || !this.nodeSeq) return;
    this.nodeSeq.speed *= factor;
    this.player.setSpeed(this.player.playbackSpeed * factor);
  }

  /**
   * Leave the dead state (our own player's respawn: the same physics object
   * lives on, unlike a creature whose corpse is a new object). Without this
   * an action finishing after a respawn never returned to the stance cycle
   * (advanceFinishedNode's dead branch holds the pose).
   */
  revive(): void {
    this._isDead = false;
    this._deathCycleKey = 0;
  }

  /**
   * The Dead substate (the server's Dead UpdateMotion — the only death
   * trigger, DECOMP.death-anim-restarts): GetObjectSequence's SubState
   * branch — the link into Dead (the fall), through the style default when
   * the current substate has none (running → Ready → Dead,
   * DECOMP.death-action-via-default), then the Dead cycle (a framerate-0
   * hold). A re-sent Dead while already dead is a same-substate request:
   * it only re-speeds the cycle (:282254-282260) — the fall never restarts.
   *
   * @param wireMotionIndex — lower 16 bits of Dead command (0x0011)
   */
  playDeath(wireMotionIndex: number, speed = 1.0): boolean {
    const T = this.motionTable;
    if (!T) return false;
    const cycleKey = MotionManager.compositeKey(this._currentStyleId, wireMotionIndex);
    if (this._isDead && this.currentStance === cycleKey && sameSign(speed, this.currentSubstateSpeed)) {
      this.changeCycleSpeed(speed);
      return true;
    }
    const cycle = this.substateCycle(cycleKey);
    const chain = cycle ? this.substateLinks(wireMotionIndex, speed) : [];

    this._isDead = true;
    this._deathCycleKey = cycleKey;
    this.actionQueue.length = 0;
    this._styleTransitionActive = false;
    this.currentStance = cycleKey;
    this.currentMotion = cycleKey;
    this.currentSubstateSpeed = speed;
    if (this.playChain(chain, 'death')) return true;
    this.playingAction = false;
    this.chainKind = null;
    this.linkQueue = [];
    return cycle ? this.playMotionData(cycle, speed, true) : false;
  }

  /**
   * Exact port of ACE MotionInterp.adjust_motion() + apply_run_to_command().
   * Converts left/backward motions to right/forward with negative speed,
   * applies sidestep factor, and promotes walk→run when running.
   *
   * @param runRate — character's run rate from GetRunRate() (Run skill based).
   *   When running, animation speed and movement velocity are both scaled by this.
   *
   * Returns { motion, speed } with the canonical motion and adjusted speed.
   *
   * `CMotionInterp::adjust_motion @ 00528010` returns a raw RunForward
   * untouched: running is WalkForward + HoldKey_Run, which
   * `apply_run_to_command @ 00527be0` turns into RunForward at
   * run_rate × speed (DECOMP.run-cycle-ignores-run-rate).
   */
  static adjustMotion(
    motion: number,
    speed: number,
    isRunning: boolean,
    runRate: number = 1.0,
  ): { motion: number; speed: number } {
    if (motion === MotionCommand.RunForward) return { motion, speed };
    let m = motion;
    let s = speed;

    // WalkBackwards → WalkForward with reversed and reduced speed
    if (m === MotionCommand.WalkBackwards) {
      m = MotionCommand.WalkForward;
      s *= -MotionSpeed.BackwardsFactor;
    }

    // TurnLeft → TurnRight with reversed speed
    if (m === MotionCommand.TurnLeft) {
      m = MotionCommand.TurnRight;
      s *= -1.0;
    }

    // SideStepLeft → SideStepRight with reversed speed
    if (m === MotionCommand.SideStepLeft) {
      m = MotionCommand.SideStepRight;
      s *= -1.0;
    }

    // Apply sidestep speed factor
    if (m === MotionCommand.SideStepRight) {
      s *= MotionSpeed.SidestepFactor * (MotionSpeed.WalkAnimSpeed / MotionSpeed.SidestepAnimSpeed);
    }

    // apply_run_to_command: promote to run variants and scale by run rate
    if (isRunning) {
      if (m === MotionCommand.WalkForward) {
        // Only promote to RunForward if moving forward (speed > 0).
        // Backward (speed < 0) stays as WalkForward played in reverse.
        if (s > 0) m = MotionCommand.RunForward;
        // Run rate applies to both forward AND backward when in run mode
        s *= runRate;
      } else if (m === MotionCommand.TurnRight) {
        s *= MotionSpeed.RunTurnFactor;
      } else if (m === MotionCommand.SideStepRight) {
        // FAITHFUL.597 — ACE MotionInterp.cs:550-560: the running SideStepRight
        // case multiplies by speedMod (the character's run rate — the SAME
        // scalar the forward branch applies at :543), then clamps to
        // MaxSidestepAnimRate. Pre-fix this was a hardcoded 2.0: too fast for
        // 0-Run characters (~1x in retail), too slow for high-Run (cap ~3x).
        s = Math.min(Math.abs(s) * runRate, MotionSpeed.MaxSidestepAnimRate) * Math.sign(s || 1);
      }
    }

    return { motion: m, speed: s };
  }

  /**
   * Set stance from a raw MotionStance ID (e.g. 0x8000003d).
   * Looks up styleDefaults for the default motion, builds composite key, calls setStance().
   */
  setStanceFromId(stanceId: number, speed = 1.0): boolean {
    if (!this.motionTable) return false;

    this._currentStyleId = stanceId;

    const motion = this.motionTable.styleDefaults.get(stanceId);
    if (motion === undefined) {
      // Fall back to default style
      return this.setDefaultStance(speed);
    }

    const key = MotionManager.compositeKey(stanceId, motion);
    return this.setStance(key, speed);
  }

  /**
   * CMotionTable::GetObjectSequence's STYLE branch (ACE MotionTable.cs:76-117):
   * a style change (peace ↔ melee ↔ magic …) plays its transition animations
   * before the new style's cycle — the draw-weapon / ready-hands motion —
   * instead of snapping:
   *   1. current substate → the old style's default substate (if not there);
   *   2. get_link(oldStyle, oldDefault → newStyle);
   *      none → get_link(oldStyle, oldDefault → DefaultStyle) then
   *      get_link(DefaultStyle, its default → newStyle);
   *   3. the NEW style's cycle for the old default substate
   *      (Cycles[(newStyle << 16) | oldDefault]).
   * No table / no such cycle → the old snap (setStanceFromId).
   */
  changeStyle(newStyle: number, speed = 1.0): boolean {
    const T = this.motionTable;
    if (!T) return false;
    const oldStyle = this._currentStyleId;
    if (oldStyle === newStyle) return true;
    const oldDefault = T.styleDefaults.get(oldStyle);
    if (!oldStyle || oldDefault === undefined) return this.setStanceFromId(newStyle, speed);
    const cycleKey = MotionManager.compositeKey(newStyle, oldDefault);
    const cycle = T.cycles.get(cycleKey);
    if (!cycle || cycle.anims.length === 0) return this.setStanceFromId(newStyle, speed);

    // CMotionTable::GetObjectSequence @ 00522860 style branch (:282188-282213):
    // link(substate → old default) at substate_mod, link(old default →
    // newStyle), else via the table's default style at 1.0; every node,
    // the new cycle included, at the DoMotion speed.
    const mod = this.currentSubstateSpeed;
    const curSub = this.currentStance & 0xFFFF;
    const toIdle = curSub !== (oldDefault & 0xFFFF) ? this.getLink(oldStyle, curSub, mod, oldDefault, speed) : null;
    let toStyle = this.getLink(oldStyle, oldDefault, mod, newStyle, speed);
    let viaDefault: MotionData | null = null;
    if (!toStyle) {
      const defStyle = T.defaultStyle;
      const defDefault = T.styleDefaults.get(defStyle);
      toStyle = this.getLink(oldStyle, oldDefault, 1.0, defStyle, 1.0);
      viaDefault = defDefault !== undefined ? this.getLink(defStyle, defDefault, 1.0, newStyle, 1.0) : null;
    }

    this._currentStyleId = newStyle;
    this.currentStance = cycleKey;
    this.currentMotion = cycleKey;
    this.currentSubstateSpeed = speed;
    this.actionQueue.length = 0;
    const chain = [toIdle, toStyle, viaDefault]
      .filter((m): m is MotionData => !!m && m.anims.length > 0)
      .map((data) => ({ data, speed }));
    if (chain.length === 0) return this.setStance(cycleKey, speed);
    this._styleTransitionActive = true;
    return this.playChain(chain, 'style');
  }

  /**
   * `CMotionTable::get_link @ 00522710` (:282100; ACE MotionTable.get_link):
   *   forward (speed ≥ 0 and substateSpeed ≥ 0):
   *     Links[(style << 16) | substate][motion],
   *     else the style's any-substate bucket Links[style << 16][motion];
   *   either speed negative — the link is looked up REVERSED
   *   (DECOMP.get-link-negative-speed), keyed by the target and played
   *   backwards: Links[(style << 16) | motion][substate],
   *     else Links[(style << 16) | substate][styleDefaults[style]].
   * A found bucket without the motion falls through to the second lookup.
   * Inner keys are full MotionCommand ids; callers hold wire indices (and
   * substates as composite keys), so they match on the low 16 bits.
   */
  private getLink(style: number, substate: number, substateSpeed: number, motion: number, speed: number): MotionData | null {
    const T = this.motionTable;
    if (!T) return null;
    const pick = (outer: number, inner: number): MotionData | null => {
      const bucket = T.links.get(outer >>> 0);
      if (!bucket) return null;
      for (const [key, data] of bucket) if ((key & 0xFFFF) === (inner & 0xFFFF)) return data;
      return null;
    };
    if (speed < 0 || substateSpeed < 0) {
      const found = pick(MotionManager.compositeKey(style, motion), substate);
      if (found) return found;
      const def = T.styleDefaults.get(style);
      return def === undefined ? null : pick(MotionManager.compositeKey(style, substate), def);
    }
    return pick(MotionManager.compositeKey(style, substate), motion)
      ?? pick((style & 0xFFFF) << 16, motion);
  }

  /** A style change's transition animations are still playing. */
  get isChangingStyle(): boolean {
    return this._styleTransitionActive;
  }
  private _styleTransitionActive = false;

  /**
   * Set stance using a composite cycle key (already in cycles map format).
   */
  setStance(stanceMotionId: number, speed = 1.0): boolean {
    if (!this.motionTable) return false;

    // Look up the cycle for this stance
    const motionData = this.motionTable.cycles.get(stanceMotionId);
    if (!motionData || motionData.anims.length === 0) return false;

    this.currentStance = stanceMotionId;
    this.currentMotion = stanceMotionId;
    this.currentSubstateSpeed = speed;
    this.playingAction = false;
    this.chainKind = null;
    this.actionQueue.length = 0;
    this.linkQueue = [];
    this._styleTransitionActive = false;

    return this.playMotionData(motionData, speed, true);
  }

  /**
   * Set default stance from the MotionTable's defaultStyle and styleDefaults.
   * Returns true if successful.
   */
  setDefaultStance(speed = 1.0): boolean {
    if (!this.motionTable) return false;

    const style = this.motionTable.defaultStyle;
    this._currentStyleId = style;
    const motion = this.motionTable.styleDefaults.get(style);
    if (motion === undefined) return false;

    // Build composite key: (style_lower16 << 16) | (motion_lower20)
    const key = MotionManager.compositeKey(style, motion);
    return this.setStance(key, speed);
  }

  /**
   * Queue an action (attack, cast, emote, etc.) to play.
   * Action plays to completion, then returns to current stance cycle.
   */
  queueAction(actionMotionId: number, speed = 1.0, onComplete?: () => void): void {
    this.actionQueue.push({ motionId: actionMotionId, speed, onComplete });
    if (!this.playingAction) {
      this.playNextAction();
    }
  }

  /**
   * Set a forward motion from server (door open/close, movement, idle).
   * Checks for a link transition from current stance first — if found,
   * plays the transition as an action, then update() will hold the target cycle.
   * Falls back to requestMotion if no link exists.
   */
  setForwardMotion(targetMotionId: number, speed = 1.0): boolean {
    if (!this.motionTable) return false;
    // A style change's links are not cut by what follows: GetObjectSequence
    // only removes the cyclic tail (remove_cyclic_anims), so a run sent with
    // (or right after) a weapon draw plays after the draw, and re-asking for
    // the new style's idle just leaves it standing (DECOMP.style-change-speed
    // — the draw at 1.0 is then actually seen). Both land in the queue below.

    const wireIndex = targetMotionId & 0xFFFF;

    // An ACTION-class command (a spell windup MagicPowerUp*, a swing, an
    // emote) sent as the forward command is a one-shot: GetObjectSequence's
    // Action branch plays link(substate → action) and then the CURRENT
    // substate's cycle again — it never becomes the substate (ACE
    // MotionTable.cs Action branch; CMotionTable::GetObjectSequence
    // @ 00522860). Making it the substate froze the pose on the action's
    // last frame and left the next command without a link to play.
    const full = motionCommandFromWireIndex(wireIndex);
    if (full !== undefined && isActionCommand(full)) {
      this.queueAction(targetMotionId, speed);
      return true;
    }

    // A substate change arriving while a link / action still plays is
    // appended after it: GetObjectSequence drops only the cyclic tail
    // (Sequence.remove_cyclic_anims), so the playing links finish first —
    // a talisman cast gesture sent while the windup is still on screen waits
    // for it instead of cutting it off.
    if (this.playingAction && !this._isDead) {
      this.actionQueue.push({ motionId: targetMotionId, speed, substate: true });
      return true;
    }
    return this.applySubstate(targetMotionId, speed);
  }

  /**
   * The substate the sequence ends in once every queued node has played —
   * a queued substate change, else the current one.
   */
  get targetSubstate(): number {
    for (let i = this.actionQueue.length - 1; i >= 0; i--) {
      if (this.actionQueue[i].substate) return this.actionQueue[i].motionId;
    }
    return this.currentStance;
  }

  /**
   * GetObjectSequence's SubState branch (CMotionTable::GetObjectSequence
   * @ 00522860, :282244-282305): the target's cycle; the same substate at
   * the same sign only re-speeds it (change_cycle_speed — a re-sent door On
   * keeps holding the open frame, a re-sent Dead never restarts the fall);
   * otherwise the links from the current substate (substateLinks — through
   * the style default when there is no direct link or the speed changes
   * sign: a cast gesture's hold, which links only back to Ready, goes
   * release → Ready → run; walking forward → backward goes Walk → Ready at
   * +1, then the Ready → Walk link reversed), then the cycle at the new speed.
   */
  private applySubstate(targetMotionId: number, speed: number): boolean {
    const T = this.motionTable;
    if (!T) return false;
    const cycle = this.substateCycle(targetMotionId);
    // No such cycle: not a substate this table plays (a modifier / link-only motion).
    if (!cycle || cycle.anims.length === 0) return this.requestMotion(targetMotionId, speed);

    if (targetMotionId === this.currentStance && sameSign(speed, this.currentSubstateSpeed) && this.player.currentAnimation) {
      this.changeCycleSpeed(speed);
      return true;
    }

    const chain = this.substateLinks(targetMotionId & 0xFFFF, speed);
    // The target is the substate from here on: the links finish into its cycle (advanceFinishedNode).
    this.currentStance = targetMotionId;
    this.currentMotion = targetMotionId;
    this.currentSubstateSpeed = speed;
    if (this.playChain(chain, 'substate')) return true;
    this.playingAction = false;
    this.chainKind = null;
    this.linkQueue = [];
    return this.playMotionData(cycle, speed, true);
  }

  /**
   * Request any motion by compositeKey. Checks cycles first, then modifiers, then links.
   * Links are looked up by matching lower 16 bits (wire index) since
   * the links map uses full MotionCommand IDs, not compositeKeys.
   */
  requestMotion(motionId: number, speed = 1.0): boolean {
    if (!this.motionTable) return false;

    // Check cycles first (the default style's when this style has none)
    const cycle = this.substateCycle(motionId);
    if (cycle && cycle.anims.length > 0) {
      this.currentMotion = motionId;
      // A cycle is the new substate (GetObjectSequence sets
      // state->substate): an action finishing later returns to it, and the
      // next substate change links from it.
      if (!this._isDead) {
        this.currentStance = motionId;
        this.currentSubstateSpeed = speed;
      }
      // The cycle replaces whatever chain was playing.
      this.playingAction = false;
      this.chainKind = null;
      this.linkQueue = [];
      this._styleTransitionActive = false;
      return this.playMotionData(cycle, speed, true);
    }

    // Check modifiers (use lower 16 bits to match full MotionCommand IDs)
    const wireIndex = motionId & 0xFFFF;
    for (const [key, mod] of this.motionTable.modifiers) {
      if ((key & 0xFFFF) === wireIndex && mod.anims.length > 0) {
        this.currentMotion = motionId;
        return this.playMotionData(mod, speed, false);
      }
    }

    // Check links from current stance (match by lower 16 bits)
    // Links are transition animations (e.g., door opening, stance change).
    // Mark as action so update() transitions to the target stance cycle after it finishes.
    const linkData = this.findLink(wireIndex);
    if (linkData && linkData.anims.length > 0) {
      this.playingAction = true;
      this.chainKind = 'action';
      this.linkQueue = [];
      this.currentMotion = motionId;
      return this.playMotionData(linkData, speed, false);
    }

    return false;
  }

  /**
   * Register a hook callback on the player.
   */
  onHook(callback: HookCallback): void {
    this.player.onHook(callback);
  }

  /**
   * Advance the animation state by deltaTime seconds.
   */
  update(deltaTime: number, motion?: SequenceMotion): void {
    this.player.update(deltaTime, motion);
    // CSequence::update_internal carries a finished node's overshoot into
    // the node that follows it (advance_to_next_animation, then recurse).
    for (let guard = 0; guard < 16; guard++) {
      if (this.player.isPlaying) return;
      const leftover = this.player.leftoverTime;
      this.advanceFinishedNode();
      if (!this.player.isPlaying) return;
      // advance_to_next_animation: the node it arrives on moves the body by its starting frame.
      if (motion) this.player.enterNode(motion);
      if (!(leftover > 0)) return;
      this.player.update(leftover, motion);
    }
  }

  /**
   * The next node of the MotionData on the player — a link / cycle is a
   * LIST of AnimData (the spell windup is raise-hands then lower-hands, a
   * cast gesture's return is release then settle), each appended to the
   * sequence by ACE MotionTable.add_motion. Returns false once the list
   * (non-looping) is exhausted.
   */
  private advanceWithinMotionData(): boolean {
    const seq = this.nodeSeq;
    if (!seq) return false;
    if (seq.index + 1 < seq.data.anims.length) return this.playNode(seq.index + 1);
    if (seq.looping && seq.data.anims.length > 1) return this.playNode(0);
    return false;
  }

  /** A finished link / action hands over to the next node: the chain's next link, the death cycle, the next queued action, or the stance cycle. */
  private advanceFinishedNode(): void {
    if (!this.player.isPlaying && this.advanceWithinMotionData()) return;
    if (!this.playingAction || this.player.isPlaying) return;
    // The chain's next link (via-default, style change), at its own speed.
    const nextLink = this.linkQueue.shift();
    if (nextLink) { this.playMotionData(nextLink.data, nextLink.speed, false, nextLink.onComplete); return; }
    this.chainKind = null;
    // Dead: after the fall, the Dead cycle (a framerate-0 hold) — never back to idle.
    if (this._isDead) {
      this.playingAction = false;
      const cycle = this.substateCycle(this._deathCycleKey);
      if (cycle) this.playMotionData(cycle, this.currentSubstateSpeed, true);
      return;
    }

    // If action finished playing, return to stance or next action
    {
      this._styleTransitionActive = false;
      this.playingAction = false;
      if (this.actionQueue.length > 0) {
        this.playNextAction();
      } else {
        // Return to the substate cycle at its own speed (GetObjectSequence
        // appends the cycle with the same speed_mod as the link before it —
        // ACE MotionTable.cs add_motion(sequence, cycles, speedMod)).
        this.setStance(this.currentStance, this.currentSubstateSpeed);
      }
    }
  }

  /**
   * Get the current per-part Frame transforms from the player.
   */
  getPartTransforms() {
    return this.player.getPartTransforms();
  }

  /**
   * Get the velocity from the current motion data (for movement animations).
   */
  getVelocity(): { x: number; y: number; z: number } | null {
    if (!this.motionTable) return null;
    const data = this.substateCycle(this.currentMotion);
    return data?.velocity ?? null;
  }

  /**
   * Exact port of ACE MotionTable.GetCycleLength (MotionTable.cs:69-83) +
   * GetAnimationLength(AnimData) (:162-182): sum, over every AnimData in the
   * cycle keyed by compositeKey, of (highFrame - lowFrame) / abs(framerate),
   * treating highFrame === -1 (or > the animation's real frame count) as the
   * animation's numFrames. Returns 0 if the cycle or motion table isn't loaded.
   */
  getCycleLength(compositeKey: number): number {
    if (!this.motionTable) return 0;
    const motionData = this.motionTable.cycles.get(compositeKey);
    if (!motionData) return 0;

    let length = 0;
    for (const anim of motionData.anims) {
      const animation = this.loadAnimation(anim.animId);
      if (!animation) continue;

      let highFrame = anim.highFrame;
      if (highFrame === -1) highFrame = animation.numFrames;
      if (highFrame > animation.numFrames) highFrame = animation.numFrames;

      const numFrames = highFrame - anim.lowFrame;
      length += numFrames / Math.abs(anim.framerate);
    }
    return length;
  }

  private playMotionData(motionData: MotionData, speed: number, looping: boolean, onComplete?: () => void): boolean {
    if (motionData.anims.length === 0) return false;
    this.nodeSeq = { data: motionData, speed, looping, index: 0, onComplete };
    return this.playNode(0);
  }

  /** Put node `index` of the current MotionData on the player (AnimSequenceNode.set_animation_id). */
  private playNode(index: number): boolean {
    const seq = this.nodeSeq;
    if (!seq) return false;
    seq.index = index;
    const count = seq.data.anims.length;
    const animData = seq.data.anims[index];
    if (!animData) return false;
    const speed = seq.speed;
    // A one-node cycle loops on the player; a multi-node one advances node
    // by node (advanceWithinMotionData) and wraps.
    const looping = seq.looping && count === 1;
    const onComplete = index === count - 1 ? seq.onComplete : undefined;

    const anim = this.loadAnimation(animData.animId);
    if (!anim) { this._animationMissed = true; return false; }
    this._animationMissed = false;

    // Negative framerate means reverse playback (e.g. door close uses -30fps);
    // 0 holds the starting frame (a hold cycle — CSequence never advances it).
    const absFramerate = Math.abs(animData.framerate);
    const direction = animData.framerate < 0 ? -1 : 1;

    // Clamp low/high frames to valid range (matching ACViewer AnimSequenceNode.set_animation_id)
    let low = animData.lowFrame >= 0 ? animData.lowFrame : 0;
    let high = animData.highFrame >= 0 ? animData.highFrame : anim.numFrames - 1;
    if (low >= anim.numFrames) low = anim.numFrames - 1;
    if (high >= anim.numFrames) high = anim.numFrames - 1;
    if (low > high) high = low;

    this.player.play(anim, low, high, absFramerate, speed * direction, looping, onComplete);
    return true;
  }

  private playNextAction(): void {
    while (this.actionQueue.length > 0 && this.motionTable) {
      const entry = this.actionQueue.shift()!;
      if (entry.substate) {
        // A substate change queued behind a link / action (setForwardMotion).
        if (entry.motionId === this.currentStance && sameSign(entry.speed, this.currentSubstateSpeed)) {
          this.currentSubstateSpeed = entry.speed;
          this.resumeSubstateCycle();
        } else {
          this.applySubstate(entry.motionId, entry.speed);
        }
        if (this.playingAction) return;
        continue;
      }
      if (this.startAction(entry)) return;
    }
    // Nothing left to play: back to the substate's cycle (a dropped action
    // must not leave the pose frozen on the previous link's last frame).
    if (!this.playingAction && !this.player.isPlaying) this.resumeSubstateCycle();
  }

  /**
   * `CPhysicsObj::RemoveLinkAnimations` → `CSequence::remove_link_animations`:
   * every link / action node still to play is dropped, and the sequence
   * stands in the cycle of the substate it was heading for (a queued
   * substate change included). CMotionInterp::LeaveGround @ 00528b00 /
   * HitGround @ 00528ac0 run it before apply_current_movement, so the air /
   * landing motion's own link starts at once instead of after the old one.
   */
  removeLinkAnimations(): void {
    if (!this.playingAction || this._isDead || !this.motionTable) return;
    let target = this.currentStance;
    let speed = this.currentSubstateSpeed;
    for (const a of this.actionQueue) if (a.substate) { target = a.motionId; speed = a.speed; }
    this.actionQueue = [];
    this.linkQueue = [];
    this.playingAction = false;
    this.chainKind = null;
    this._styleTransitionActive = false;
    this.currentStance = target;
    this.currentSubstateSpeed = speed;
    this.resumeSubstateCycle();
  }

  /**
   * `CPhysicsObj::enter_world @ 00516170` (:268480-268484) →
   * CPartArray::RemoveLinkAnimations @ 00517d70 → MotionTableManager::
   * RemoveLinkAnimations @ 0051bdd0 → `CSequence::remove_all_link_animations
   * @ 00524ca0`: an object entering the world drops every link and action
   * its created motion state queued and stands in the target cycle at its
   * starting frame — a corpse appears lying (no second fall), an open door
   * open (no swing), a sitting creature seated. Unlike removeLinkAnimations
   * it applies to the dead too: the fall is a link like any other.
   */
  removeAllLinkAnimations(): void {
    if (!this.playingAction || !this.motionTable) return;
    if (!this._isDead) { this.removeLinkAnimations(); return; }
    this.actionQueue = [];
    this.linkQueue = [];
    this.playingAction = false;
    this.chainKind = null;
    this._styleTransitionActive = false;
    const cycle = this.substateCycle(this._deathCycleKey);
    if (cycle && cycle.anims.length > 0) {
      this.currentMotion = this._deathCycleKey;
      this.playMotionData(cycle, this.currentSubstateSpeed, true);
    }
  }

  /**
   * SWEEP1006 default-style fallback — a substate's cycle as
   * CMotionTable::GetObjectSequence @ 00522860 finds it (:282244-282249):
   * cycles[style << 16 | substate], else cycles[default_style << 16 |
   * substate]. Crouch, Sit, Sleep and the held emotes exist only in the
   * NonCombat style of the human table, and play in any combat style.
   */
  private substateCycle(key: number): MotionData | undefined {
    const T = this.motionTable;
    if (!T) return undefined;
    const own = T.cycles.get(key);
    if (own) return own;
    return T.cycles.get(MotionManager.compositeKey(T.defaultStyle, key & 0xFFFF));
  }

  /** The current substate's cycle, without touching the queue (add_motion(sequence, cycles, substateMod)). */
  /** Whether the sequence is behind its motion state because an Animation was not resident. */
  get animationMissed(): boolean {
    return this._animationMissed;
  }

  /**
   * STREAM.initial-motion-not-retried — after a streamed rebuild, put the
   * committed state's cycle on the player when its Animation missed (the
   * previous cycle kept looping: a combat-stance creature in its peace idle,
   * an open door drawn shut, a corpse standing). The object is already in
   * that state, so the cycle plays without the links that led to it, as
   * removeAllLinkAnimations leaves an object entering the world. A chain
   * still playing is left to finish: a link that misses is skipped
   * (advanceFinishedNode) or its action dropped with its callback
   * (dropAction), and the chain ends on the cycle, which tries again.
   * Returns whether a cycle was put on the player.
   */
  retryMissedAnimation(): boolean {
    if (!this._animationMissed || !this.motionTable || this.playingAction) return false;
    const key = this._isDead ? this._deathCycleKey : this.currentStance;
    const cycle = this.substateCycle(key);
    if (!cycle || cycle.anims.length === 0) return false;
    this._styleTransitionActive = false;
    this.currentMotion = key;
    return this.playMotionData(cycle, this.currentSubstateSpeed, true);
  }

  private resumeSubstateCycle(): void {
    const cycle = this.substateCycle(this.currentStance);
    if (!cycle || cycle.anims.length === 0) return;
    this.currentMotion = this.currentStance;
    this.playMotionData(cycle, this.currentSubstateSpeed, true);
  }

  /**
   * GetObjectSequence's Action branch (CMotionTable::GetObjectSequence
   * @ 00522860, :282314-282352): link(substate → action) at the action's
   * speed, then the substate's cycle again. With no direct link — an action
   * from a non-default substate, a wave while walking — it goes through the
   * style default (DECOMP.death-action-via-default): link(substate → default)
   * at 1.0, link(default → action), link(default → substate) at 1.0, then
   * the substate's cycle — when both of the first two exist.
   */
  private startAction(action: { motionId: number; speed: number; onComplete?: () => void }): boolean {
    const T = this.motionTable;
    if (!T) return false;
    const wireIndex = action.motionId & 0xFFFF;
    const style = this.stateStyle;
    const cur = this.currentStance & 0xFFFF;
    const mod = this.currentSubstateSpeed;

    const linkData = this.getLink(style, cur, mod, wireIndex, action.speed);
    if (linkData && linkData.anims.length > 0) {
      this.currentMotion = action.motionId;
      return this.playChain([{ data: linkData, speed: action.speed, onComplete: action.onComplete }], 'action') || this.dropAction(action);
    }
    if (!linkData && T.cycles.has(this.currentStance)) {
      const def = T.styleDefaults.get(style);
      const toDefault = def !== undefined ? this.getLink(style, cur, mod, def, 1.0) : null;
      const act = toDefault && def !== undefined ? this.getLink(style, def, 1.0, wireIndex, action.speed) : null;
      if (toDefault && act && act.anims.length > 0 && def !== undefined) {
        const back = this.getLink(style, def, 1.0, cur, mod);
        const chain: ChainLink[] = [
          { data: toDefault, speed: 1.0 },
          // The action's own link carries its completion callback.
          { data: act, speed: action.speed, onComplete: action.onComplete },
        ];
        if (back) chain.push({ data: back, speed: 1.0 });
        this.currentMotion = action.motionId;
        return this.playChain(chain.filter((l) => l.data.anims.length > 0), 'action') || this.dropAction(action);
      }
    }

    // Check modifiers (match by lower 16 bits)
    for (const [key, mod] of T.modifiers) {
      if ((key & 0xFFFF) === wireIndex && mod.anims.length > 0) {
        this.playingAction = true;
        this.chainKind = 'action';
        this.linkQueue = [];
        this.currentMotion = action.motionId;
        return this.playMotionData(mod, action.speed, false, action.onComplete) || this.dropAction(action);
      }
    }

    // Try cycles (less common for actions)
    const cycle = T.cycles.get(action.motionId);
    if (cycle && cycle.anims.length > 0) {
      this.playingAction = true;
      this.chainKind = 'action';
      this.linkQueue = [];
      this.currentMotion = action.motionId;
      return this.playMotionData(cycle, action.speed, false, action.onComplete) || this.dropAction(action);
    }

    // Action had no link, modifier, or cycle in the motion table. Fire the
    // onComplete so callers awaiting it don't hang, and log enough to diagnose.
    console.warn(`[Motion] No animation found for action 0x${action.motionId.toString(16)} from stance 0x${this.currentStance.toString(16)}`);
    return this.dropAction(action);
  }

  private dropAction(action: { onComplete?: () => void }): false {
    this.playingAction = false;
    this.chainKind = null;
    this.linkQueue = [];
    action.onComplete?.();
    return false;
  }

  /**
   * Clear animation cache.
   */
  clearCache(): void {
    this.animationCache.clear();
  }
}
