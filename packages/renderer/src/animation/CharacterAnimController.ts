/**
 * CharacterAnimController — maps player input to animation state changes.
 *
 * Follows ACE MotionInterp pattern: reads input each frame, issues motion
 * commands to MotionManager. Hard-switches between animations (no blending),
 * matching the original AC client.
 *
 * Jump system: hold Space to charge, release to jump. Height = f(power,
 * Jump skill, burden). Leaving the ground plays the link into Falling;
 * touching down plays the link out of it (CMotionInterp::LeaveGround /
 * HitGround).
 */
import { MotionManager } from './MotionManager.js';
import { MotionTableState, type MotionEntry } from './MotionTableState.js';
import { MotionCommand, MotionStance, CommandMask, motionCommandFromWireIndex } from './MotionCommands.js';
import { AttackHeight, getSwingAnimation, getAnimSpeed, DEFAULT_WEAPON_SPEED, type CombatManeuverRow } from '@ac/shared';
import type { CameraController } from '../scene/CameraController.js';

/** The commands the interpreted state holds outside forward_command. */
const SIDESTEP_AND_TURN: ReadonlySet<number> = new Set([MotionCommand.SideStepRight, MotionCommand.SideStepLeft, MotionCommand.TurnRight, MotionCommand.TurnLeft]);

/**
 * Power-bar charge durations (seconds), extracted from the EoL retail
 * acclient.exe .rdata section (ClientCombatSystem::ATTACK_POWERUP_TIME /
 * DUAL_WIELD_POWERUP_TIME globals, doubles at .rdata+0x3cfc8/+0x3cfd0).
 * GetPowerBarLevel/GetJumpPowerLevel (acclient-decompiled.c:353426-353613)
 * compute fill as elapsed-wall-clock / duration, selecting the dual-wield
 * duration only when the player's current combat style is DualWieldCombat.
 */
const ATTACK_POWERUP_TIME = 1.0;
const DUAL_WIELD_POWERUP_TIME = 0.8;

/** Seconds of holding the jump key to charge a jump fully in stance `stanceId` (GetJumpPowerLevel's duration). */
export function jumpChargeSeconds(stanceId: number): number {
  return stanceId === MotionStance.DualWieldCombat ? DUAL_WIELD_POWERUP_TIME : ATTACK_POWERUP_TIME;
}

/**
 * ClientCombatSystem::GetJumpPowerLevel @ 0056b050 / DoJump @ 0056b110: the
 * jump extent never goes below MIN_JUMP_EXTENT (0.001), so a tap still jumps.
 */
export const MIN_JUMP_EXTENT = 0.001;
/** CACQualities::CanJump @ 00591b50: InqLoad (burden / capacity) must stay under 2.0. */
const MAX_JUMP_LOAD = 2.0;

/**
 * The WeenieError codes CMotionInterp's jump checks return. The retail
 * refusal lines (ClientCombatSystem::CommenceJump @ 0056af90 / DoJump
 * @ 0056b110, AddTextToScroll(…, 0x1a)) are keyed by them;
 * GeneralMovementFailure has no case there, so it refuses silently.
 */
export const JumpError = {
  None: 0,
  YouCantJumpWhileInTheAir: 0x24,
  GeneralMovementFailure: 0x47,
  YouCantJumpFromThisPosition: 0x48,
  CantJumpLoadedDown: 0x49,
} as const;

/**
 * CMotionInterp::motion_allows_jump @ 005279e0: the motions a jump cannot
 * start from — the spell windups MagicPowerUp01–10 (0x1000006f–78),
 * 0x10000128–0x10000131 (TripleThrust…MagicPowerUp07Purple), Fallen
 * (0x40000008), Reload / Unload / Pickup (0x40000016–18), the aims and
 * talisman cast gestures AimLevel…MagicPray (0x4000001e–39), and Crouch /
 * Sitting / Sleeping (0x41000012–14). Everything else — every melee swing,
 * emote, walk and run — allows it.
 */
export function motionAllowsJump(motion: number): number {
  const m = motion >>> 0;
  const blocked = (m >= 0x1000006f && m <= 0x10000078)
    || (m >= 0x10000128 && m <= 0x10000131)
    || m === 0x40000008
    || (m >= 0x40000016 && m <= 0x40000018)
    || (m >= 0x4000001e && m <= 0x40000039)
    || (m >= 0x41000012 && m <= 0x41000014);
  return blocked ? JumpError.YouCantJumpFromThisPosition : JumpError.None;
}

/** The substates the player's own input drives (everything else is the server's). */
const CONTROLLER_SUBSTATES: ReadonlySet<number> = new Set([
  MotionCommand.Ready, MotionCommand.WalkForward, MotionCommand.WalkBackwards, MotionCommand.RunForward,
  MotionCommand.TurnRight, MotionCommand.TurnLeft, MotionCommand.SideStepRight, MotionCommand.SideStepLeft,
  MotionCommand.Falling, MotionCommand.Crouch, MotionCommand.Sitting, MotionCommand.Sleeping,
].map((m) => m >>> 0));

export class CharacterAnimController {
  private mm: MotionManager;
  private currentPrimaryMotion: number = MotionCommand.Ready;
  /**
   * VISUAL.emote-poses-not-held — the held substate an emote input action set
   * (ACCmdInterp::OnAction → SetMotion(cmd, true): Crouch / Sitting /
   * Sleeping; Ready clears it). It is the idle forward motion until a
   * forward, backward or sidestep command overwrites the raw forward command.
   */
  private _heldSubstate = 0;
  /** The adjusted speed the current primary motion was requested at (a run-rate or walk ↔ run change re-requests it). */
  private currentPrimarySpeed = 1.0;
  /** The motion table's MotionState for the player (MotionTableState), built once the table is loaded. */
  private tableState: MotionTableState | null = null;
  /** The interpreted commands last handed to it (forward, sidestep, turn after adjust_motion). */
  private applied: { fwd: MotionEntry; side: MotionEntry | null; turn: MotionEntry | null } = { fwd: { motion: MotionCommand.Ready, speed: 1 }, side: null, turn: null };
  private currentStanceId: number = MotionStance.NonCombat;
  private isDead = false;

  // ── Jump state ──
  private _jumpCharging = false;
  private _jumpChargeElapsed = 0;
  private _jumpPower = 0;
  private _airborne = false;
  private _wasJumpHeld = false;
  /** CMotionInterp::standing_longjump (charge_jump @ 005281c0). */
  private _standingLongJump = false;

  /**
   * The player's load (burden / capacity, CACQualities::InqLoad) for
   * CanJump's < 2.0 rule. main.ts keeps it current.
   */
  load = 0;
  /**
   * A refused jump (CommenceJump / DoJump): the WeenieError code, for the
   * retail 0x1a line. GeneralMovementFailure is not reported (retail is silent).
   */
  onJumpRefused: ((code: number) => void) | null = null;

  /**
   * CMotionInterp::standing_longjump: this charge began standing still
   * (on the ground, forward command Ready, no sidestep, no turn). While it
   * is set the held movement keys shape the launch velocity but do not move
   * the body; the MoveToState carries it as the 0x2 contact bit.
   * ClientCombatSystem::FinishJump @ 0056a9b0 clears it with the charge.
   */
  get standingLongJump(): boolean { return this._jumpCharging && this._standingLongJump; }

  /** Run rate multiplier from character's Run skill (default 1.0). */
  runRate: number = 1.0;

  /** Whether the jump power bar is charging (read by UI). */
  get jumpCharging(): boolean { return this._jumpCharging; }

  /** Current jump power 0–1 (read by UI for power bar fill). */
  get jumpPower(): number { return this._jumpPower; }

  /** Whether the character is currently airborne (read by physics). */
  get airborne(): boolean { return this._airborne; }

  /** CommandInterpreter::PlayerIsDead @ 006b3d70 for the local player. */
  get dead(): boolean { return this.isDead; }

  /** CPhysicsObj::motions_pending: an action, substate link or style change still playing. */
  get motionsPending(): boolean {
    return this.mm.motionsPending || this.mm.isChangingStyle || this.holdsServerSubstate;
  }

  /**
   * The server put the player in a substate of its own — a cast gesture's
   * hold, Eat / Drink, Aim / Reload — and it still holds: the motion is
   * pending until the server's next motion replaces it, so UseTime does not
   * take control back meanwhile. Live A/B (sweep-cast-then-W-long): W held
   * through a cast took control back during the gesture's hold and ran
   * ~1.7 m after the cast; retail stood still.
   */
  private get holdsServerSubstate(): boolean {
    const sub = this.tableState?.substate;
    if (sub === undefined) return false;
    // The player's own held substate (a posture or state emote it applied) is not the server's.
    if ((this.applied.fwd.motion >>> 0) === (sub >>> 0)) return false;
    return !CONTROLLER_SUBSTATES.has(sub >>> 0);
  }

  /** InterpretedMotionState::current_style: the stance last set. */
  get stanceId(): number { return this.currentStanceId; }

  /** InterpretedMotionState::forward_command (PlayerInReadyPosition's missile test). */
  interpretedForwardCommand(input: CameraController | null): number {
    return this.forwardCommand(input);
  }

  constructor(motionManager: MotionManager) {
    this.mm = motionManager;
  }

  /**
   * GAP.9 — the player's CombatManeuverTable rows (portal.dat 0x30000000;
   * world DB weenie 1 PropertyDataId.CombatTable). When present,
   * queueAttack selects the swing motion exactly like ACE
   * Player_Melee.GetSwingAnimation; when absent it falls back to the old
   * hardcoded Slash/Attack1 mapping.
   */
  private combatManeuvers: CombatManeuverRow[] | null = null;
  /** Equipped melee weapon's W_AttackType flags (PropertyInt 47), null unarmed. */
  private weaponAttackType: number | null = null;
  /** GAP.12 — offhand (dual-wield) weapon's W_AttackType, null when not dual-wielding. */
  private offhandAttackType: number | null = null;
  /**
   * BUG.melee-swing-speed-ignores-quickness-weapon — inputs to
   * Creature_Combat.cs:510 GetAnimSpeed. quickness = Quickness.Current;
   * weaponSpeed = the equipped weapon's PropertyInt.WeaponTime
   * (WorldObject_Weapon.cs:270 GetWeaponSpeed), defaulting to unarmed's 40
   * (WorldObject_Weapon.cs:265). Not replicated: GetWeaponSpeed's dual-wield
   * weapon lookup runs *before* GetSwingAnimation flips DualWieldAlternate
   * (Player_Melee.cs:402-406), so on alternating swings ACE's speed and
   * motion/attack-type picks can come from opposite hands; we always use the
   * primary (main-hand/two-handed/held) weapon's speed for simplicity.
   */
  private quickness = 0;
  private weaponSpeed = DEFAULT_WEAPON_SPEED;
  /**
   * GAP.12 — ACE Creature_Melee.cs:25 DualWieldAlternate: "true if *next*
   * attack is offhand" — flipped at the top of every swing selection
   * (Player_Melee.cs:442) and reset when a new attack sequence starts
   * (Player_Melee.cs:140).
   */
  private dualWieldAlternate = false;

  setCombatManeuvers(rows: CombatManeuverRow[]): void {
    this.combatManeuvers = rows;
  }

  setWeaponAttackType(wAttackType: number | null, offhandAttackType: number | null = null): void {
    this.weaponAttackType = wAttackType;
    this.offhandAttackType = offhandAttackType;
  }

  /** BUG.melee-swing-speed-ignores-quickness-weapon — set GetAnimSpeed's inputs. */
  setAnimSpeedInputs(quickness: number, weaponSpeed: number = DEFAULT_WEAPON_SPEED): void {
    this.quickness = quickness;
    this.weaponSpeed = weaponSpeed;
  }

  /** Player_Melee.cs:140 — reset alternation when the attack button is clicked. */
  resetDualWieldAlternate(): void {
    this.dualWieldAlternate = false;
  }

  /**
   * Set the stance (NonCombat, HandCombat, SwordCombat, Magic, etc.).
   * Uses raw MotionStance ID.
   */
  setStance(stanceId: number): void {
    if (this.isDead) return;
    this.currentStanceId = stanceId;
    // The combat-mode change plays its transition (draw weapon / ready
    // hands) — MotionManager.changeStyle, CMotionTable::GetObjectSequence's
    // style branch — instead of snapping to the new stance.
    this.mm.changeStyle(stanceId);
    // Reset so motion re-applies in new stance
    this.currentPrimaryMotion = MotionCommand.Ready;
    this.resetTableState(MotionCommand.Ready);
  }

  /**
   * Queue an attack animation at the given height.
   *
   * `height` is the ACE AttackHeight enum value (per AttackHeight.cs):
   *   AttackHeight.High = 1, .Medium = 2, .Low = 3.
   *
   * Stance-appropriate MotionCommand IDs:
   *   HandCombat → AttackHigh1/Med1/Low1 (unarmed punches)
   *   Weapon stances → SlashHigh/Med/Low
   *
   * Pre-FAITHFUL.107 this function used a different 0/1/2 height encoding
   * that didn't match ACE; sendMeleeAttack had to do a 1/2/3 → 0/1/2
   * conversion before calling. Now passes the wire value through directly.
   */
  queueAttack(height: AttackHeight, powerLevel = 0.5): void {
    if (this.isDead) return;

    // BUG.melee-swing-speed-ignores-quickness-weapon — Player_Melee.cs:402
    // DoSwingMotion: baseSpeed = GetAnimSpeed() (Quickness + weapon Speed),
    // then dual-wield swings animate 20% faster on top (animSpeedMod 1.2, :403).
    const baseSpeed = getAnimSpeed(this.quickness, this.weaponSpeed);

    // GAP.9 — ACE-exact selection through the real DAT CombatManeuverTable
    // (Player_Melee.cs:440 GetSwingAnimation): weapon W_AttackType + power
    // → AttackType; (stance, height, type) → motion list; power subdivision
    // picks the slot. Pre-fix every weapon swing was hardcoded Slash* and
    // Thrust/multi-strike/Kick motions were unreachable.
    if (this.combatManeuvers) {
      // GAP.12 — dual-wield alternation, exactly Player_Melee.cs:442-445:
      // flip first, then the swing is offhand when NOT alternate. The
      // offhand swing uses the OFFHAND weapon's attack type (ACE
      // GetEquippedMeleeWeapon returns the dual-wield weapon then), and
      // dual-wield swings animate 20% faster (animSpeedMod 1.2, :403).
      const isDualWield = this.currentStanceId === MotionStance.DualWieldCombat;
      let offhand = false;
      if (isDualWield) {
        this.dualWieldAlternate = !this.dualWieldAlternate;
        offhand = !this.dualWieldAlternate;
      }
      const motion = getSwingAnimation({
        maneuvers: this.combatManeuvers,
        stance: this.currentStanceId,
        attackHeight: height,
        powerLevel,
        weaponAttackType: offhand ? this.offhandAttackType : this.weaponAttackType,
        offhand,
        isDualWieldAttack: isDualWield,
      });
      if (motion !== null) {
        this.mm.queueAction(motion, baseSpeed * (isDualWield ? 1.2 : 1.0));
        return;
      }
    }

    // Fallback (no CMT loaded): the old stance-blind mapping.
    const isHandCombat = this.currentStanceId === MotionStance.HandCombat;
    let attackMotion: number;
    switch (height) {
      case AttackHeight.High: attackMotion = isHandCombat ? MotionCommand.AttackHigh1 : MotionCommand.SlashHigh; break;
      case AttackHeight.Low:  attackMotion = isHandCombat ? MotionCommand.AttackLow1  : MotionCommand.SlashLow;  break;
      case AttackHeight.Medium:
      default:                attackMotion = isHandCombat ? MotionCommand.AttackMed1  : MotionCommand.SlashMed;  break;
    }
    const isDualWield = this.currentStanceId === MotionStance.DualWieldCombat;
    this.mm.queueAction(attackMotion, baseSpeed * (isDualWield ? 1.2 : 1.0));
  }

  /**
   * Health reached 0: stop steering the character (input, casting, jump).
   * State only — the death ANIMATION is the server's Dead UpdateMotion alone
   * (ServerObjectManager → MotionManager.playDeath; retail has no other
   * trigger), so the fall plays once (DECOMP.death-anim-restarts). The
   * link into Dead is the fall, with its Knockdown3 sound hook
   * (BUG.nonpositional-human-table-sounds).
   */
  markDead(): void {
    if (this.isDead) return;
    this.isDead = true;
    this._jumpCharging = false;
    this._airborne = false;
  }

  /**
   * Revive from death — return to stance idle.
   */
  revive(): void {
    this.isDead = false;
    this._airborne = false;
    this._jumpCharging = false;
    // The server's stand-up movement may already have left Dead
    // (ServerObjectManager) and set the substate the server sent; only a
    // body still held dead is put back in the stance here.
    if (this.mm.isDead) {
      this.mm.revive();
      this.mm.setStanceFromId(this.currentStanceId);
    }
    this.currentPrimaryMotion = MotionCommand.Ready;
    this.resetTableState(MotionCommand.Ready);
  }

  /** The held substate (0 = none) — MovementSync sends it as the forward command. */
  get heldSubstate(): number {
    return this._heldSubstate;
  }

  /** SetMotion(cmd, true) for a substate emote input action: hold it (Ready releases). */
  setHeldSubstate(motion: number): void {
    if (this.isDead) return;
    this._heldSubstate = motion === MotionCommand.Ready ? 0 : motion;
  }

  /**
   * CPhysicsObj::StopCompletely @ 00510180 → CMotionInterp::StopCompletely
   * @ 00527e40, as CommandInterpreter::StopCompletely runs it right after
   * ClearAllCommands: the forward command goes to Ready (a held substate
   * such as Sit ends) and the motion table takes it NOW — the stop link
   * starts with the next physics step, not one frame later as a key change
   * read by update() does. `input` is the CameraController whose command
   * lists were just cleared.
   */
  stopCompletely(input: CameraController): void {
    if (this.isDead) return;
    this._heldSubstate = 0;
    this.update(0, input);
  }

  /**
   * Play a chat emote animation (wave, bow, salute, etc.).
   */
  playEmote(motionId: number): void {
    if (this.isDead) return;
    this.mm.queueAction(motionId);
  }

  /**
   * CMotionInterp::HitGround @ 00528ac0 — the character touched down:
   * RemoveLinkAnimations, then apply_current_movement. There is no landing
   * clip of its own and no input lock: the next update re-applies the held
   * motion through its link out of Falling (the human table's Falling →
   * Ready / RunForward links are the landing), and movement keys act at once.
   */
  onLanded(): void {
    this._airborne = false;
    // SWEEP1006 jump links — HitGround's RemoveLinkAnimations: the
    // into-Falling link (or a swing / emote) still playing is dropped, so
    // the landing motion's link starts at once.
    if (!this.isDead) this.mm.removeLinkAnimations();
  }

  /**
   * CMotionInterp::LeaveGround @ 00528b00 — the character left the ground
   * (a jump, or walking off a ledge): standing_longjump and jump_extent
   * clear, then apply_current_movement, whose contact_allows_move fails in
   * the air, so the forward command becomes Falling — played through the
   * link from the current motion (GetObjectSequence's substate branch),
   * not snapped to the Falling cycle.
   */
  leaveGround(): void {
    if (this.isDead) return;
    this._airborne = true;
    this._standingLongJump = false;
    // SWEEP1006 jump links — LeaveGround's RemoveLinkAnimations: Falling
    // does not wait behind a swing or emote still playing.
    this.mm.removeLinkAnimations();
    const fallingKey = MotionManager.compositeKey(this.mm.styleKey, MotionCommand.Falling & 0xFFFFF);
    this.mm.setForwardMotion(fallingKey);
    this.currentPrimaryMotion = MotionCommand.Falling;
    // HitGround's apply_current_movement re-applies everything out of Falling.
    this.resetTableState(MotionCommand.Falling);
  }

  /** The motion state starts over at `substate` (a style change, a revive, Falling); the next update re-applies the input. */
  private resetTableState(substate: number): void {
    if (!this.tableState) return;
    this.tableState.reset(substate);
    this.applied = { fwd: { motion: substate, speed: 1 }, side: null, turn: null };
  }

  /**
   * The interpreted forward command (InterpretedMotionState::forward_command)
   * for the jump checks: the held forward / backward motion, else the
   * substate the motion table holds (Ready, Crouch, Sitting, a cast gesture…).
   * A standing strafe or turn is the motion table's substate, but the
   * interpreted state keeps them in sidestep_command / turn_command: its
   * forward command stays Ready (a bow build survives a strafe —
   * PlayerInReadyPosition @ 0056b820, sweep-bow-charge-C). The state
   * changes when a motion is applied, not when its animation reaches the
   * cycle: the AC1999 server sends a reload's AttackDone just before its
   * Ready, and reading the still-playing Reload link made the repeat build
   * look out of position and cancel the repeat.
   */
  private forwardCommand(input: CameraController | null): number {
    if (input?.isMovingForward) return (input.isForwardRunning ?? input.isRunning) ? MotionCommand.RunForward : MotionCommand.WalkForward;
    if (input?.isMovingBackward) return MotionCommand.WalkBackwards;
    let sub: number;
    if (this.tableState) sub = this.tableState.substate >>> 0;
    else {
      const stance = this.mm.stance;
      if (typeof stance !== 'number') return MotionCommand.Ready;
      sub = motionCommandFromWireIndex(stance & 0xFFFF) ?? MotionCommand.Ready;
    }
    return SIDESTEP_AND_TURN.has(sub) ? MotionCommand.Ready : sub;
  }

  /**
   * CMotionInterp::jump_charge_is_allowed @ 00527a50 (the same test
   * charge_jump @ 005281c0 makes): too loaded (CanJump) → CantJumpLoadedDown;
   * Fallen or Crouch / Sitting / Sleeping → YouCantJumpFromThisPosition.
   */
  private jumpChargeIsAllowed(forward: number): number {
    if (!(this.load < MAX_JUMP_LOAD)) return JumpError.CantJumpLoadedDown;
    if (forward === MotionCommand.Fallen || (forward >= MotionCommand.Crouch && forward <= MotionCommand.Sleeping)) {
      return JumpError.YouCantJumpFromThisPosition;
    }
    return JumpError.None;
  }

  /**
   * CMotionInterp::jump_is_allowed @ 005282b0 at the release: in the air →
   * YouCantJumpWhileInTheAir; then the first pending motion's jump error
   * (DoInterpretedMotion @ 00528360 stores motion_allows_jump of the motion,
   * or — for a non-action — of the forward command); then
   * jump_charge_is_allowed; then motion_allows_jump(forward command).
   */
  private jumpIsAllowed(input: CameraController | null): number {
    if (this._airborne) return JumpError.YouCantJumpWhileInTheAir;
    const forward = this.forwardCommand(input);
    if (this.mm.isPlayingAction) {
      const playing = typeof this.mm.motion === 'number' ? motionCommandFromWireIndex(this.mm.motion & 0xFFFF) : undefined;
      if (playing !== undefined) {
        let err = motionAllowsJump(playing);
        if (err === JumpError.None && (playing & CommandMask.Action) === 0) err = motionAllowsJump(forward);
        if (err !== JumpError.None) return err;
      }
    }
    const charge = this.jumpChargeIsAllowed(forward);
    if (charge !== JumpError.None) return charge;
    return motionAllowsJump(forward);
  }

  /**
   * ClientCombatSystem::FinishJump @ 0056a9b0 without a jump (Escape during
   * the charge, ClientUISystem::OnAction case 0x27): the charge and its
   * standing_longjump end; the release that follows jumps nothing.
   */
  cancelJumpCharge(): void {
    this._jumpCharging = false;
    this._jumpPower = 0;
    this._standingLongJump = false;
  }

  /**
   * CMotionInterp::is_standing_still @ 00527fa0: on the ground, forward
   * command Ready, no sidestep, no turn.
   */
  isStandingStill(input: CameraController): boolean {
    return !this._airborne && this.forwardCommand(input) === MotionCommand.Ready
      && !input.isStrafingLeft && !input.isStrafingRight && !input.isTurningLeft && !input.isTurningRight;
  }

  /**
   * ClientCombatSystem::DoJump @ 0056b110 on the jump release: the extent is
   * the power (at least MIN_JUMP_EXTENT); FinishJump ends the charge and
   * clears standing_longjump; CMotionInterp::jump runs jump_is_allowed. On
   * success the character leaves the ground (LeaveGround) and the extent is
   * returned for the launch; on a refusal onJumpRefused gets the code and
   * the result is null.
   */
  triggerJump(input: CameraController | null = null): number | null {
    const extent = Math.max(this._jumpPower, MIN_JUMP_EXTENT);
    const code = this.jumpIsAllowed(input);
    this._jumpCharging = false;
    this._jumpPower = 0;
    this._standingLongJump = false;
    if (code !== JumpError.None) {
      if (code !== JumpError.GeneralMovementFailure) this.onJumpRefused?.(code);
      return null;
    }
    this.leaveGround();
    return extent;
  }

  /**
   * Main update — read input state, issue motion commands.
   * Call this BEFORE playerAnimated.update(dt).
   *
   * Single primary motion with priority: forward/backward > strafe > turn > idle.
   * Since we have a single animation player (no multi-channel blending),
   * only one motion plays at a time — highest priority wins.
   */
  update(dt: number, input: CameraController): void {
    // Dead by the server's Dead motion (possibly before our Health=0 update).
    if (this.isDead || this.mm.isDead) return;

    // ── Jump charge ──
    // ClientCombatSystem::CommenceJump @ 0056af90 on the Jump press (edge):
    // CMotionInterp::charge_jump @ 005281c0 refuses only a load of 2+ or a
    // Fallen / Crouch / Sit / Sleep forward command — not an action, and not
    // the air (the release's jump_is_allowed refuses that). A charge begun
    // on the ground with the forward command Ready and no sidestep or turn
    // is a standing long jump.
    if (input.isJumpHeld && !this._wasJumpHeld && !this._jumpCharging) {
      const forward = this.forwardCommand(input);
      const code = this.jumpChargeIsAllowed(forward);
      if (code === JumpError.None) {
        this._standingLongJump = !this._airborne && forward === MotionCommand.Ready
          && !input.isStrafingLeft && !input.isStrafingRight
          && !input.isTurningLeft && !input.isTurningRight;
        this._jumpCharging = true;
        this._jumpChargeElapsed = 0;
        this._jumpPower = 0;
      } else {
        this.onJumpRefused?.(code);
      }
    }
    this._wasJumpHeld = input.isJumpHeld;

    // Accumulate power while held — elapsed wall-clock time / duration,
    // matching ClientCombatSystem::GetPowerBarLevel (framerate-independent).
    if (this._jumpCharging) {
      if (input.isJumpHeld) {
        this._jumpChargeElapsed += dt;
        this._jumpPower = Math.min(this._jumpChargeElapsed / jumpChargeSeconds(this.currentStanceId), 1.0);
      } else {
        // Space released — jump will be triggered by main.ts (needs physics access)
        // Don't clear here — main.ts reads jumpCharging and calls triggerJump()
      }
    }

    // ── Airborne — the Falling motion holds until HitGround ──
    if (this._airborne) {
      return;
    }

    // An action (a windup, a swing, an emote) or a style change playing does
    // not hold the commands back: GetObjectSequence keeps the playing links
    // and appends the new substate after them (remove_cyclic_anims;
    // MotionManager queues it). Retail's MoveForward pressed and released
    // during a cast windup plays its start and stop links once the windup
    // has played out (~1.7 m; sweep-cast-then-W-short).

    const isRunning = input.isRunning;
    const styleKey = this.mm.styleKey;

    // Determine primary motion (priority: forward/backward > strafe > turn > idle).
    // Running is WalkForward + HoldKey_Run: adjust_motion → apply_run_to_command
    // (@ 00527be0) makes it RunForward at run_rate
    // (DECOMP.run-cycle-ignores-run-rate).
    // A standing long jump's charge: apply_interpreted_movement @ 00528600
    // plays Ready (and stops any sidestep) whatever forward / sidestep
    // command is held; only a turn still applies.
    const longJump = this.standingLongJump;
    // The interpreted commands (adjust_motion: WalkBackwards → WalkForward at
    // −0.65, TurnLeft / SideStepLeft → the Right command at a negative speed,
    // run scaling by hold key). A standing long jump's charge
    // (apply_interpreted_movement @ 00528600) keeps Ready and drops a
    // sidestep; only a turn still applies. Autorun's forward carries its own
    // Run hold key (CameraController.isForwardRunning).
    let fwdCmd: number;
    if (longJump) fwdCmd = MotionCommand.Ready;
    else if (input.isMovingForward) { this._heldSubstate = 0; fwdCmd = MotionCommand.WalkForward; }
    else if (input.isMovingBackward) { this._heldSubstate = 0; fwdCmd = MotionCommand.WalkBackwards; }
    else fwdCmd = this._heldSubstate || MotionCommand.Ready;
    let sideCmd = 0;
    if (!longJump && input.isStrafingLeft) sideCmd = MotionCommand.SideStepLeft;
    else if (!longJump && input.isStrafingRight) sideCmd = MotionCommand.SideStepRight;
    if (sideCmd) this._heldSubstate = 0;
    const turnCmd = input.isTurningLeft ? MotionCommand.TurnLeft : input.isTurningRight ? MotionCommand.TurnRight : 0;
    const fwdRuns = fwdCmd === MotionCommand.WalkForward ? (input.isForwardRunning ?? isRunning) : isRunning;
    const fwd = MotionManager.adjustMotion(fwdCmd, 1.0, fwdRuns, this.runRate);
    const side = sideCmd ? MotionManager.adjustMotion(sideCmd, 1.0, isRunning, this.runRate) : null;
    const turn = turnCmd ? MotionManager.adjustMotion(turnCmd, 1.0, isRunning, this.runRate) : null;

    // The motion table decides which of them plays as the substate cycle
    // and which as modifiers, from its own history (MotionTableState).
    const T = this.mm.activeMotionTable;
    if (T && !this.tableState) {
      this.tableState = new MotionTableState(T, () => this.mm.currentStyleId || T.defaultStyle, (motion, speed) => {
        this.currentPrimaryMotion = motion;
        this.currentPrimarySpeed = speed;
        // The substate change goes through the motion table's links like any
        // object's (GetObjectSequence @ 00522860 SubState branch): Ready →
        // WalkForward plays its start link, then the walk cycle
        // (DECOMP.local-no-motion-links). Out of Falling (HitGround's
        // apply_current_movement) this is the landing.
        this.mm.setForwardMotion(MotionManager.compositeKey(this.mm.styleKey, motion & 0xFFFFF), speed);
      });
      this.mm.motionTableState = this.tableState;
      this.tableState.reset(this.currentPrimaryMotion);
      this.tableState.substateMod = this.currentPrimarySpeed;
    }
    const ts = this.tableState;
    if (!ts) {
      // No motion table loaded (yet): the substate is the first of forward,
      // sidestep, turn, played straight (no modifiers to track).
      const primary = fwd.motion !== MotionCommand.Ready || (!side && !turn) ? fwd : (side ?? turn)!;
      if (primary.motion !== this.currentPrimaryMotion || primary.speed !== this.currentPrimarySpeed) {
        this.currentPrimaryMotion = primary.motion;
        this.currentPrimarySpeed = primary.speed;
        this.mm.setForwardMotion(MotionManager.compositeKey(styleKey, primary.motion & 0xFFFFF), primary.speed);
      }
      return;
    }
    const same = (a: MotionEntry | null, b: { motion: number; speed: number } | null) =>
      (a === null && b === null) || (!!a && !!b && a.motion === b.motion && a.speed === b.speed);
    // Stops first (a key-up's StopInterpretedMotion), then the new commands
    // (DoInterpretedMotion), forward, sidestep, turn.
    if (this.applied.side && !side) ts.stopMotion(this.applied.side.motion);
    if (this.applied.turn && !turn) ts.stopMotion(this.applied.turn.motion);
    const fwdChanged = !same(this.applied.fwd, fwd);
    if (fwdChanged && fwd.motion === MotionCommand.Ready) ts.stopMotion(this.applied.fwd.motion);
    if (fwdChanged && fwd.motion !== MotionCommand.Ready) ts.doMotion(fwd.motion, fwd.speed);
    if (side && !same(this.applied.side, side)) ts.doMotion(side.motion, side.speed);
    if (turn && !same(this.applied.turn, turn)) ts.doMotion(turn.motion, turn.speed);
    this.applied = { fwd: { ...fwd }, side: side ? { ...side } : null, turn: turn ? { ...turn } : null };
  }
}
