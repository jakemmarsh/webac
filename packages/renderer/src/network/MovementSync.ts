/**
 * MovementSync — sends player movement state to the ACE server.
 *
 * Two message types:
 *   1. MoveToState (GameAction 0xF61C): sent when movement keys change (start/stop moving)
 *   2. AutonomousPosition (0xF753): retail's position-event rule, checked
 *      every frame — see shouldSendPositionEvent (CommandInterpreter::
 *      ShouldSendPositionEvent @ 006b45e0). It fires on ANY change of the
 *      player's position, keyed-in or not (collision push-out, sliding,
 *      landing, a server MoveTo), so ACE — which adopts our reported
 *      position as Player.Location (Player_Tick.cs UpdatePlayerPosition) —
 *      never keeps a stale one.
 *
 * Wire construction (RawMotionState packed flags + conditional fields,
 * Position landblock+xyz+quaternion, sequence numbers) lives in
 * @ac/network's buildMoveToStatePayload / buildAutonomousPositionPayload
 * (GAP.87) — this file only derives the MotionCommand/Position field
 * values from local state and calls those shared builders.
 */

import {
  serializeGameAction,
  GameActionType, GameMessageGroup,
  buildMoveToStatePayload, buildAutonomousPositionPayload,
  PhysicsTimestamp,
} from '@ac/network';
import type { NetConnection, RawMotionStateFields, MovementPositionFields } from '@ac/network';
import { MotionCommand, MotionStance } from '../animation/MotionCommands.js';
import { acQuaternionFromYaw } from '../scene/AcHeading.js';

const MC_WALK_FORWARD     = MotionCommand.WalkForward;
const MC_WALK_BACKWARDS   = MotionCommand.WalkBackwards;
const MC_TURN_RIGHT       = MotionCommand.TurnRight;
const MC_TURN_LEFT        = MotionCommand.TurnLeft;
const MC_SIDESTEP_RIGHT   = MotionCommand.SideStepRight;
const MC_SIDESTEP_LEFT    = MotionCommand.SideStepLeft;

const STANCE_NON_COMBAT   = MotionStance.NonCombat;

/** Stand-in contact plane when the caller supplies none (grounded, plane unknown). */
const LEVEL_PLANE: ContactPlane = { nx: 0, ny: 0, nz: 1, d: 0 };

/**
 * CommandInterpreter::time_between_position_events — 1.0 s (the constructor
 * @ 006b3e40 stores the double 0x3ff00000_00000000), in ms.
 */
export const TIME_BETWEEN_POSITION_EVENTS_MS = 1000;
/** ::F_EPSILON (0.0002) — Frame::is_equal / Plane::operator== tolerance. */
export const POSITION_EVENT_EPSILON = 0.0002;
// Heartbeat: send encrypted position update even when idle to prevent
// ACE session timeout (60s). Cleartext ACK packets alone may not reset
// the server's timeout because they don't advance ISAAC state.
const HEARTBEAT_INTERVAL = 20_000; // 20 seconds — well within 60s timeout

/** CameraSet::m_LastServerMessage + 0.5 (0x3fe0000000000000) — the mouse-turn resend, ms. */
const TURN_SPEED_RESEND_MS = 500;

/**
 * The raw motion the player's input asks for. Each axis is its CommandList
 * head (CameraController: CommandList::AddCommand @ 006b4b80 keeps the most
 * recent press first, ApplyListHeadMovement @ 006b3510 applies only the
 * head), so at most one of forward / backward, turnLeft / turnRight and
 * strafeLeft / strafeRight is set — the MoveToState fields are those heads.
 */
export interface MovementState {
  forward: boolean;
  backward: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
  running: boolean;  // current_holdkey: Shift XOR Run as Default (true = run)
  /** Autorun: the forward command carries HoldKey_Run itself (ForwardHoldKey). */
  forwardHoldRun?: boolean;
  /**
   * CameraController.movementEvents: the count of movement events the
   * command interpreter has raised (a key-down, a key-up while not server
   * controlled, the autorun toggle, Stop Moving). When given, a MoveToState
   * goes out when it changes — retail sends one per input event, even one
   * that changes no list head — rather than on a change of the heads.
   */
  movementEvent?: number;
  /**
   * The run toggle (CharacterOption RunAsDefaultMovement; auto-run), as
   * opposed to the hold-run key (Shift). Retail sends a movement event when
   * the toggle changes (CommandInterpreter::UpdateToggleRun @ 006b3c80 →
   * SendMovementEvent) but not when the hold key does: SetHoldRun @ 006b3370
   * only calls CMotionInterp::set_hold_run @ 00528b70 on the local motion
   * state, and the next movement event carries the new hold key. The retail
   * A/B shift-toggle scenario shows it: two MoveToStates for a run with two
   * Shift taps (docs/movement-ab.md). When given, a change of `running` with
   * an unchanged `runToggle` sends nothing; when omitted, any change sends.
   */
  runToggle?: boolean;
  /** The turn's speed (Use Mouse Turning: min(2 × |mouse x|, 1.5)); 1 when omitted. */
  turnSpeed?: number;
  /**
   * CommandInterpreter::controlled_by_server (CameraController.
   * controlledByServer), or the frame UseTime took control back: the state
   * changes the player's lists see now are not movement events — a key-up
   * under server control only runs NukeCommand, and UseTime's
   * TakeControlFromServer sends nothing. The change is absorbed (the next
   * real event carries the whole state); the AutonomousPosition rule runs on.
   */
  serverControlled?: boolean;
  /**
   * CMotionInterp::standing_longjump: a jump charge that began standing
   * still. SendMovementEvent @ 006b4680 packs it as the ContactLongJump 0x2
   * bit of every MoveToState while it is set (ACE then ignores the forward /
   * sidestep commands for peers — MovementData.cs:104/123).
   */
  standingLongJump?: boolean;
  /**
   * The jump power bar is charging (ClientCombatSystem::jump_pending). Its
   * start is ClientCombatSystem::CommenceJump @ 0056af90, which sends a
   * movement event (cmdinterp vtable +0x4c, SendMovementEvent) whatever the
   * keys are; its end (DoJump @ 0056b110 → FinishJump @ 0056a9b0, which
   * clears standing_longjump directly) sends none — the Jump action follows.
   */
  jumpCharging?: boolean;
  /**
   * VISUAL.emote-poses-not-held — a held forward-command substate from the
   * emote input actions (ACCmdInterp::OnAction → SetMotion(cmd, true):
   * Crouch 0x41000012, Sitting 0x41000013, Sleeping 0x41000014). It is the
   * raw forward_command while no forward / backward key is held.
   */
  substate?: number;
}

export interface PlayerPosition {
  worldX: number;
  worldZ: number;    // Three.js Z = AC Y
  groundY: number;   // Three.js Y = AC Z (height)
  playerYaw: number; // radians, CameraController convention (0 faces south) — see scene/AcHeading.ts
  /**
   * The heading at input time, before this frame's physics turned the
   * player. Retail's CommandInterpreter sends the MoveToState from input
   * handling, ahead of the physics tick, so a turn's first MoveToState carries
   * the pre-turn heading (retail capture: 0°; ours stamped 16°). Used for the
   * MoveToState only; AutonomousPosition reports the current heading.
   */
  moveToStateYaw?: number;
  landblock: number; // full landblock ID (0xXXYYFFFF for outdoor)
  localX: number;    // position within landblock (AC X, 0-192)
  localY: number;    // position within landblock (AC Y, 0-192)
  localZ: number;    // height (AC Z)
  inDungeon: boolean;
  /**
   * Outdoors, the surface building's interior cell the player stands in
   * (0xXXYY01xx; 0 or absent = an outdoor land cell). Retail
   * CommandInterpreter::SendPositionEvent @ 006b4770 sends m_position, whose
   * cell is that EnvCell; reporting the land cell instead had ACE store an
   * outdoor cell inside a building and relocate the player at the next login.
   */
  surfaceCell?: number;
  /**
   * The contact plane (see ContactPlane), read lazily by the position-event
   * rule. Omitted = only contact presence (onGround) is compared.
   */
  contactPlane?: () => ContactPlane | null;
  /** GAP.7 — TRUE when the player is on the ground. ACE reads this byte
   *  (GameActionAutonomousPosition.cs:26 LastContact; MoveToState contact)
   *  and only integrates server-side fall physics while it's FALSE — with
   *  it hardcoded to Contact, HandleFallingDamage could never trigger. */
  onGround?: boolean;
}

/**
 * The plane the player stands on (CPhysicsObj::contact_plane), in AC
 * landblock-local space (Z up): N·p + d = 0. null = no contact (airborne).
 */
export interface ContactPlane { nx: number; ny: number; nz: number; d: number }

/** What the last AutonomousPosition carried (CommandInterpreter::last_sent_position / last_sent_contact_plane). */
export interface SentPositionEvent {
  cellId: number;
  x: number; y: number; z: number;
  qw: number; qx: number; qy: number; qz: number;
  contactPlane: ContactPlane | null;
}

/**
 * The contact plane from a floor normal in Three.js axes (Y up) and a point
 * on that floor (world X, world Z, floor height): AC axes are (x, z, y), and
 * d = −N·P. World coordinates (not block-local) are fine — planes are only
 * compared within one cell.
 */
export function contactPlaneFromNormal(
  n: { x: number; y: number; z: number }, worldX: number, worldZ: number, floorY: number,
): ContactPlane {
  const nx = n.x, ny = n.z, nz = n.y;
  return { nx, ny, nz, d: -(nx * worldX + ny * worldZ + nz * floorY) };
}

type PositionFrame =Omit<SentPositionEvent, 'cellId' | 'contactPlane'>;

const within = (a: number, b: number): boolean => Math.abs(a - b) <= POSITION_EVENT_EPSILON;

/** Frame::is_equal @ 00424c30 — origin (Vector3Math::AreEqual, |Δ| ≤ ε) and quaternion (|Δ| < ε). */
export function framesEqual(a: PositionFrame, b: PositionFrame): boolean {
  return within(a.x, b.x) && within(a.y, b.y) && within(a.z, b.z)
    && Math.abs(a.qw - b.qw) < POSITION_EVENT_EPSILON && Math.abs(a.qx - b.qx) < POSITION_EVENT_EPSILON
    && Math.abs(a.qy - b.qy) < POSITION_EVENT_EPSILON && Math.abs(a.qz - b.qz) < POSITION_EVENT_EPSILON;
}

/** Plane::operator== @ 006b3dd0 (N within ε, d under ε); no contact compares by presence. */
export function contactPlanesEqual(a: ContactPlane | null, b: ContactPlane | null): boolean {
  if (!a || !b) return a === b;
  return within(a.nx, b.nx) && within(a.ny, b.ny) && within(a.nz, b.nz) && Math.abs(a.d - b.d) < POSITION_EVENT_EPSILON;
}

/**
 * CommandInterpreter::ShouldSendPositionEvent @ 006b45e0, run every frame by
 * CommandInterpreter::UseTime @ 006b3bf0 (→ SendPositionEvent @ 006b4770):
 *   - once time_between_position_events (1 s) has passed since the last
 *     position OR movement event: send iff the cell or the frame changed
 *     since the last sent position;
 *   - inside that second: send iff the cell changed, or the contact plane
 *     changed (landing, stepping onto another polygon).
 * `last` null = nothing sent yet (retail's last_sent_position starts at cell
 * 0, so the first frame always sends). `contactPlane` is read lazily — only
 * the inside-the-window branch with an unchanged cell needs it.
 */
export function shouldSendPositionEvent(
  last: SentPositionEvent | null,
  lastSentTimeMs: number,
  cur: Omit<SentPositionEvent, 'contactPlane'>,
  contactPlane: () => ContactPlane | null,
  nowMs: number,
): boolean {
  if (last === null || last.cellId !== cur.cellId) return true;
  if (nowMs - lastSentTimeMs > TIME_BETWEEN_POSITION_EVENTS_MS) return !framesEqual(last, cur);
  return !contactPlanesEqual(last.contactPlane, contactPlane());
}

export class MovementSync {
  /**
   * Report a surface building's interior cell in outgoing positions (retail
   * SendPositionEvent sends m_position's EnvCell). On by default. It was
   * switched off as a mitigation (a8e3e9c7) while a login inside such a cell
   * dropped the client into dungeon movement mode and stranded the player
   * (acjs-c8, tavern 0xA9B40165, 2026-10-09); BUG.seen-outside-arrival-
   * dungeon-mode keeps a SeenOutside arrival in outdoor mode
   * (world/arrivalMode.ts), so ACE storing the interior cell is safe again.
   * The switch stays as a kill switch: off, ACE gets the land cell and
   * relocates such a login to the drop point.
   */
  static reportSurfaceInteriorCells = true;

  private connection: Pick<NetConnection, 'sendMessage'>;
  private actionSequence: () => number; // getter that increments and returns

  // Sequence numbers (tracked from server messages)
  instanceSequence = 0;
  serverControlSequence = 0;
  teleportSequence = 0;
  forcePositionSequence = 0;

  /**
   * Adopt the update timestamps from OUR OWN CreateObject's PhysicsDesc.
   * Retail CPhysicsObj::set_description copies that array into
   * update_times[], and the autonomous-position / jump / MoveToState packs
   * stamp update_times[INSTANCE_TS, SERVER_CONTROLLED_MOVE_TS, TELEPORT_TS,
   * FORCE_POSITION_TS]. Before this, the four stayed 0 until the first
   * self UpdatePosition, which a fresh login may never get: GDLE drops every
   * AutonomousPosition whose instance stamp differs from the player's
   * (ClientEvents.cpp MOVEMENT_AUTONOMOUS_POSITION: "Bad instance.") or
   * whose teleport/force-position stamp is older than its own, so the server
   * never heard where we walked. ACE does not check these stamps.
   * A missing array (synthetic fixtures) leaves the sequences unchanged.
   */
  adoptPhysicsTimestamps(timestamps: readonly number[] | undefined): void {
    if (!timestamps || timestamps.length <= PhysicsTimestamp.Instance) return;
    this.instanceSequence = timestamps[PhysicsTimestamp.Instance];
    this.serverControlSequence = timestamps[PhysicsTimestamp.ServerControlledMove];
    this.teleportSequence = timestamps[PhysicsTimestamp.Teleport];
    this.forcePositionSequence = timestamps[PhysicsTimestamp.ForcePosition];
  }

  /**
   * The player's motion style (RawMotionState::current_style) — what
   * MoveToState packs as CurrentStyle. ACE copies it into its own physics
   * motion state on every MoveToState (Player.OnMoveToState_ServerMethod →
   * RawMotionState.SetState, absent = NonCombat), and refuses a cast unless
   * that style is Magic ("You're too busy", Player_Magic
   * HandleActionCastTargetedSpell). A fixed NonCombat here reset ACE to peace
   * with every key press, so no spell could be cast after moving in magic
   * mode (BUG.movetostate-style-always-noncombat). main.ts supplies the
   * local motion manager's style.
   */
  stanceProvider: (() => number) | null = null;
  private get currentStance(): number {
    const s = this.stanceProvider?.() ?? 0;
    return s ? s >>> 0 : STANCE_NON_COMBAT;
  }
  /** When the turn speed last went out (the 0.5 s Use Mouse Turning resend). */
  private lastTurnSpeedSent = -Infinity;

  // Previous movement state for change detection
  private prevState: MovementState = {
    forward: false, backward: false,
    turnLeft: false, turnRight: false,
    strafeLeft: false, strafeRight: false,
    running: true,
  };

  /**
   * CommandInterpreter::last_sent_position_time — stamped by BOTH an
   * AutonomousPosition (SendPositionEvent) and a MoveToState
   * (SendMovementEvent @ 006b4680). null until the first frame: retail
   * initialises it to the construction time.
   */
  private lastSentTime: number | null = null;
  /** last_sent_position + last_sent_contact_plane — AutonomousPosition only. */
  private lastSentPosition: SentPositionEvent | null = null;
  /** Debug/probe counter: AutonomousPositions sent this session. */
  autonomousPositionsSent = 0;

  /** The cell (0xXXYYCCCC) of the last AutonomousPosition sent, i.e. where the server is told the player is; null before the first. */
  get lastSentCellId(): number | null {
    return this.lastSentPosition ? this.lastSentPosition.cellId >>> 0 : null;
  }

  /** The last AutonomousPosition sent: cell + origin in that cell's landblock frame (ACE Position); null before the first. */
  /** The last sent position's frame quaternion (Position::frame.q). */
  get lastSentQuaternion(): { w: number; x: number; y: number; z: number } | null {
    const p = this.lastSentPosition;
    return p ? { w: p.qw, x: p.qx, y: p.qy, z: p.qz } : null;
  }

  get lastSentFrame(): { cellId: number; x: number; y: number; z: number } | null {
    const p = this.lastSentPosition;
    return p ? { cellId: p.cellId >>> 0, x: p.x, y: p.y, z: p.z } : null;
  }

  constructor(
    connection: Pick<NetConnection, 'sendMessage'>,
    actionSequence: () => number,
  ) {
    this.connection = connection;
    this.actionSequence = actionSequence;
  }

  /**
   * Called every frame with current movement state and position.
   * Sends MoveToState when keys change, AutonomousPosition periodically.
   */
  update(state: MovementState, pos: PlayerPosition, now: number): void {
    if (this.lastSentTime === null) this.lastSentTime = now;
    const commenceJump = state.jumpCharging === true && !this.prevJumpCharging;
    this.prevJumpCharging = state.jumpCharging === true;
    // Back on the ground: the jump's airborne stretch is over.
    if (pos.onGround !== false) this.ownJumpAirborne = false;
    // Detect movement state changes → send MoveToState (and CommenceJump's
    // unconditional movement event at the start of a jump charge).
    // The first frame with event counting sets the baseline: retail sends a
    // movement event only for an input, never for the state it starts in.
    const baseline = state.movementEvent !== undefined && this.prevState.movementEvent === undefined;
    if ((state.serverControlled || baseline) && !commenceJump) {
      this.prevState = { ...state };
    } else if (this.hasStateChanged(state) || commenceJump) {
      this.sendMoveToState(state, pos, now);
      this.prevState = { ...state };
      this.lastTurnSpeedSent = now;
    } else if ((state.turnSpeed ?? 1) !== (this.prevState.turnSpeed ?? 1) &&
        now - this.lastTurnSpeedSent > TURN_SPEED_RESEND_MS) {
      // Use Mouse Turning: the turn speed follows the mouse every frame
      // locally, but CameraSet::Rotate / MouseLookHandler resend the movement
      // event (cmdinterp +0x4c) at most every 0.5 s (m_LastServerMessage).
      this.sendMoveToState(state, pos, now);
      this.prevState = { ...state };
      this.lastTurnSpeedSent = now;
    }

    // Retail's per-frame position-event rule (shouldSendPositionEvent). It
    // replaces the old "every ~1 s while a key is held" cadence, which never
    // reported a position change the player didn't key in — a collision
    // push-out after a teleport onto a creature, a slide along a wall, a
    // landing — so ACE kept the stale position (it only learns ours from
    // these messages) until the 20 s heartbeat.
    //
    // One deliberate difference: retail's SendPositionEvent also requires
    // Contact + OnWalkable (transient_state & 3), i.e. it never reports
    // mid-air. GAP.7 keeps reporting airborne positions with the contact
    // byte clear, because ACE only integrates a fall server-side (and so
    // only deals falling damage, WeenieObject.cs:236 → Player_Move.cs:247)
    // while the client says it is NOT in contact — live-verified 2026-07-05.
    // Retail's SendPositionEvent @ 006b4770 sends only with Contact +
    // OnWalkable (transient_state & 3). GAP.7 keeps reporting a FALL (ACE
    // integrates falling damage only while told we are out of contact), but
    // a jump is reported by the Jump action itself: retail sends no position
    // from the take-off to the landing (retail A/B capture: a standing jump
    // sends one MoveToState at the charge, the Jump, and nothing else), and
    // the landing spot only goes out by the usual rule.
    if (this.ownJumpAirborne && pos.onGround === false) return;
    const built = this.buildPosition(pos);
    const cur = { cellId: built.landblockId, x: built.x, y: built.y, z: built.z, qw: built.qw, qx: built.qx, qy: built.qy, qz: built.qz };
    if (shouldSendPositionEvent(this.lastSentPosition, this.lastSentTime, cur, () => this.contactPlaneOf(pos), now)) {
      this.sendAutonomousPosition(pos, now);
      return;
    }

    // Heartbeat: an encrypted message at least every 20 s even when idle to
    // keep the ACE session alive (not a retail rule — cleartext ACKs alone
    // may not reset ACE's 60 s timeout because they don't advance ISAAC).
    if (now - this.lastSentTime >= HEARTBEAT_INTERVAL) {
      this.sendAutonomousPosition(pos, now);
    }
  }

  /** The contact plane the position rule compares: the caller's, else presence from onGround. */
  private contactPlaneOf(pos: PlayerPosition): ContactPlane | null {
    if (pos.onGround === false) return null;
    return pos.contactPlane ? pos.contactPlane() : LEVEL_PLANE;
  }

  /**
   * Force send current position (e.g., after teleport, login, combat approach).
   * Sends BOTH MoveToState (movement state) AND AutonomousPosition (position update).
   * ACE only updates the player's actual position from AutonomousPosition, not MoveToState.
   */
  /**
   * AutonomousPosition only — no MoveToState. A server-run MoveTo (ACE
   * CreateMoveToChain) reads our reported position for its WithinUseRadius
   * checks, but any MoveToState cancels the chain
   * (GameActionMoveToState.cs:22 StopExistingMoveToChains).
   */
  sendAutonomousPositionNow(pos: PlayerPosition, now: number = performance.now()): void {
    this.sendAutonomousPosition(pos, now);
  }

  sendPositionNow(state: MovementState, pos: PlayerPosition, now: number = performance.now()): void {
    this.sendMoveToState(state, pos, now);
    this.prevState = { ...state };
    this.sendAutonomousPosition(pos, now);
  }

  /**
   * MoveToState only, with the current movement state — retail's
   * CommandInterpreter::PlayerTeleported @ 006b32b0 (SetAutoRun(0) +
   * SendMovementEvent) on a teleport arrival (SmartBox::PlayerPositionUpdated
   * @ 00453870). It stamps the event time but NOT the last sent position, so
   * the next position event (after 1 s, or on a cell change) still reports
   * the arrival — including any collision push-out resolved meanwhile.
   */
  sendMovementEventNow(state: MovementState, pos: PlayerPosition, now: number = performance.now()): void {
    this.sendMoveToState(state, pos, now);
    this.prevState = { ...state };
  }

  /**
   * Our own Jump action went out (DoJump @ 0056b110 → CM_Movement::Event_Jump):
   * until we touch down again no AutonomousPosition is sent (see update).
   */
  noteJump(): void {
    this.ownJumpAirborne = true;
  }

  /** The last frame's jumpCharging (CommenceJump is its rising edge). */
  private prevJumpCharging = false;
  /** Airborne from our own jump (noteJump) — cleared on the first grounded frame. */
  private ownJumpAirborne = false;

  /**
   * A change of a CommandList head or the hold key (ApplyListHeadMovement /
   * the run toggle each send a movement event). standing_longjump is not
   * one: it is set by charge_jump inside CommenceJump, whose own movement
   * event carries it, and cleared by FinishJump, which sends nothing.
   */
  private hasStateChanged(state: MovementState): boolean {
    if (state.movementEvent !== undefined && this.prevState.movementEvent !== undefined) {
      // Keyed changes are events; the rest still go by the state (the run
      // toggle — UpdateToggleRun @ 006b3c80 sends —, a held posture, the
      // mouse turn).
      return state.movementEvent !== this.prevState.movementEvent ||
        state.runToggle !== this.prevState.runToggle ||
        (state.substate ?? 0) !== (this.prevState.substate ?? 0);
    }
    return state.forward !== this.prevState.forward ||
      state.backward !== this.prevState.backward ||
      state.turnLeft !== this.prevState.turnLeft ||
      state.turnRight !== this.prevState.turnRight ||
      state.strafeLeft !== this.prevState.strafeLeft ||
      state.strafeRight !== this.prevState.strafeRight ||
      (state.runToggle === undefined || this.prevState.runToggle === undefined
        ? state.running !== this.prevState.running
        : state.runToggle !== this.prevState.runToggle) ||
      (state.substate ?? 0) !== (this.prevState.substate ?? 0);
  }

  // ─── MoveToState (GameAction 0xF61C) ───────────────────────

  /** MoveToStates sent this session (automation sends a standing one before its first action when none has gone: agentPrimeMoveState in main.ts). */
  moveToStatesSent = 0;

  private sendMoveToState(state: MovementState, pos: PlayerPosition, now: number): void {
    this.lastSentTime = now; // SendMovementEvent stamps last_sent_position_time
    this.moveToStatesSent++;
    const motion: RawMotionStateFields = {
      running: state.running,
      currentStance: this.currentStance,
      forwardCommand: this.getForwardCommand(state),
      forwardHoldRun: state.forwardHoldRun === true,
      sidestepCommand: this.getSidestepCommand(state),
      turnCommand: this.getTurnCommand(state),
      turnSpeed: state.turnSpeed ?? 1,
      commands: [],
    };
    const payload = buildMoveToStatePayload(motion, {
      ...this.buildPosition(pos.moveToStateYaw === undefined ? pos : { ...pos, playerYaw: pos.moveToStateYaw }),
      standingLongJump: state.standingLongJump === true,
    });
    const msg = serializeGameAction(this.actionSequence(), GameActionType.MoveToState, payload);
    this.connection.sendMessage(msg, GameMessageGroup.SmartboxQueue);
  }

  /**
   * BUG.movetostate-raw-runforward — the RAW forward command is WalkForward
   * whether walking or running; running rides on the Run hold key.
   * Retail's RawMotionState::ApplyMotion @ 0051eb60 never stores RunForward
   * (0x44000007) as the raw forward_command. The promotion to RunForward at
   * the run rate happens on the interpreting side: ACE's MovementData
   * (WalkForward + HoldKey.Run → RunForward, ForwardSpeed = GetRunRate())
   * and MotionInterp.adjust_motion → apply_run_to_command. A raw RunForward
   * skips both (`case RunForward: return` / the plain copy), so peers saw
   * us run at speed 1.0 and FastTick's server sim mis-moved us.
   */
  private getForwardCommand(state: MovementState): number {
    if (state.forward) {
      return MC_WALK_FORWARD;
    }
    if (state.backward) {
      return MC_WALK_BACKWARDS; // backward is always walk speed
    }
    return state.substate ?? 0;
  }

  private getSidestepCommand(state: MovementState): number {
    if (state.strafeLeft) return MC_SIDESTEP_LEFT;
    if (state.strafeRight) return MC_SIDESTEP_RIGHT;
    return 0;
  }

  private getTurnCommand(state: MovementState): number {
    if (state.turnLeft) return MC_TURN_LEFT;
    if (state.turnRight) return MC_TURN_RIGHT;
    return 0;
  }

  // ─── Soul-Emote MoveToState ─────────────────────────────────

  /**
   * FAITHFUL.391 — Client motion sequence counter. ACE
   * MotionItem.cs:91-106 writes packedSequence as
   * `(motionSequence & 0x7FFF) | (autonomous << 15)`. Each client-
   * initiated motion bumps this counter; the server tracks per-
   * WorldObject motion sequences and rejects out-of-order.
   */
  private motionSequence = 0;

  /**
   * FAITHFUL.391 — Send a soul-emote MotionCommand as a MoveToState
   * with a single CommandList entry (Speed=1.0, autonomous bit set).
   * Per ACE RawMotionState.cs:90 the server only accepts MotionCommand
   * in `SoulEmote.SoulEmotes.Contains()` AND speed==1.0; the broadcast
   * is then echoed to nearby observers so they see the animation too.
   *
   * The motion flag bits (Forward/Sidestep/Turn Command + HoldKey +
   * Speed) stay zero — only CurrentHoldKey + CurrentStyle are set, plus
   * CommandListLength=1.
   */
  sendSoulEmoteMotion(motion: number, pos: PlayerPosition, running: boolean): void {
    // MotionItem: rawCommand u16 + packedSequence u16 + speed f32.
    // packedSequence = (sequence & 0x7FFF) | (autonomous << 15); autonomous
    // = true (client-initiated) so the high bit is always set here.
    this.motionSequence = (this.motionSequence + 1) & 0x7FFF;
    const motionState: RawMotionStateFields = {
      running,
      currentStance: this.currentStance,
      forwardCommand: 0,
      sidestepCommand: 0,
      turnCommand: 0,
      commands: [{ motionCommand: motion, sequence: this.motionSequence, autonomous: true, speed: 1.0 }],
    };
    const payload = buildMoveToStatePayload(motionState, this.buildPosition(pos));
    const msg = serializeGameAction(this.actionSequence(), GameActionType.MoveToState, payload);
    this.connection.sendMessage(msg, GameMessageGroup.SmartboxQueue);
  }

  // ─── AutonomousPosition ─────────────────────────────────────

  private sendAutonomousPosition(pos: PlayerPosition, now: number): void {
    const fields = this.buildPosition(pos);
    const payload = buildAutonomousPositionPayload(fields);
    const msg = serializeGameAction(this.actionSequence(), GameActionType.AutonomousPosition, payload);
    this.connection.sendMessage(msg, GameMessageGroup.SmartboxQueue);
    // SendPositionEvent: last_sent_position_time, last_sent_position, last_sent_contact_plane.
    this.lastSentTime = now;
    this.lastSentPosition = {
      cellId: fields.landblockId, x: fields.x, y: fields.y, z: fields.z,
      qw: fields.qw, qx: fields.qx, qy: fields.qy, qz: fields.qz,
      contactPlane: this.contactPlaneOf(pos),
    };
    this.autonomousPositionsSent++;
  }

  /** The last AutonomousPosition's position (null before the first) — for probes/tests. */
  get lastSentPositionEvent(): SentPositionEvent | null {
    return this.lastSentPosition;
  }

  // ─── Position serialization ─────────────────────────────────

  /**
   * GAP.7 — bit 0 of the trailing ContactLongJump byte now reflects the
   * real airborne state so ACE's server physics can integrate falls
   * (WeenieObject.cs:236 → HandleFallingDamage needs a not-in-contact
   * descent to accumulate Z velocity). The standing long-jump bit (0x2) is
   * added by sendMoveToState only (AutonomousPositionPack has no such bit).
   */
  private buildPosition(pos: PlayerPosition): MovementPositionFields {
    let landblockId: number;
    let localX: number;
    let localY: number;
    const surfaceCell = MovementSync.reportSurfaceInteriorCells ? (pos.surfaceCell ?? 0) >>> 0 : 0;
    if (pos.inDungeon || (surfaceCell & 0xFFFF) >= 0x100) {
      // In dungeons and surface-building interiors, report the stored interior cell ID — and derive the
      // local origin relative to THAT cell's landblock, never by floor
      // division of the world position. Interior geometry can extend
      // outside its host block (the starter cottages sit at y=-28.482 in
      // their cell's frame, per portal.dat CharGen), so the cell-relative
      // origin may legitimately fall outside [0,192). Floor division here
      // put the origin in the neighboring block's frame while still naming
      // the interior cell, telling ACE we stood 192m away from reality
      // (echoed back via Player_Tick.cs:513-516 as a snap teleport).
      const cell = pos.inDungeon ? pos.landblock >>> 0 : surfaceCell;
      landblockId = cell;
      localX = pos.worldX - ((cell >>> 24) & 0xFF) * 192;
      localY = pos.worldZ - ((cell >>> 16) & 0xFF) * 192; // Three.js Z → AC Y
    } else {
      // Outdoor: compute landblock from world position, cell ID from local
      // position. Each landblock is 8×8 cells, each cell is 24m.
      const lbX = Math.floor(pos.worldX / 192) & 0xFF;
      const lbY = Math.floor(pos.worldZ / 192) & 0xFF;
      localX = pos.worldX - lbX * 192;
      localY = pos.worldZ - lbY * 192; // Three.js Z → AC Y
      const cellX = Math.floor(localX / 24);
      const cellY = Math.floor(localY / 24);
      const cellId = cellX * 8 + cellY + 1; // 1-based, row-major
      landblockId = ((lbX << 24) | (lbY << 16) | (cellId & 0xFFFF)) >>> 0;
    }

    // CORE.18.a — the AC orientation for the camera yaw: heading θ = π − yaw
    // about +Z (scene/AcHeading.ts). Sending θ = yaw told ACE a heading
    // reflected about the east-west axis.
    const q = acQuaternionFromYaw(pos.playerYaw);

    return {
      landblockId,
      x: localX,          // AC X = local X within landblock
      y: localY,          // AC Y = local Y within landblock (from Three.js Z)
      z: pos.groundY,      // AC Z = height
      qw: q.qw,
      qx: q.qx,
      qy: q.qy,
      qz: q.qz,
      instanceSequence: this.instanceSequence,
      serverControlSequence: this.serverControlSequence,
      teleportSequence: this.teleportSequence,
      forcePositionSequence: this.forcePositionSequence,
      contact: pos.onGround !== false,
    };
  }
}
