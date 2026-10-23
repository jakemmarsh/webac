import * as THREE from 'three';
import {
  CAMERA_DEFAULT_ADJUSTMENT_SPEED, CAMERA_DEFAULT_STIFFNESS, CAMERA_FAR_LIMIT, CAMERA_IN_HEAD_Y,
  CAMERA_MAP_DISTANCE, CAMERA_MIN_CHAR_DIST, CAMERA_ROTATE_RADIANS, CAMERA_STIFF_BELOW_Z, CAMERA_TURN_INCREMENT,
  DEFAULT_VIEWER_DISTANCE, DEFAULT_VIEWER_ELEVATION, F_EPSILON, FrameRateMeter, LOOK_DOWN_OFFSET, LOOK_DOWN_PITCH,
  MOUSE_LOOK_SCALE, MOUSE_TURNING_RAISE_SCALE, OUT_OF_HEAD_OFFSET,
  inHeadRaiseLower, lookDownSlide, minOrbitElevation, targetForOffset, viewPitchForOffset, zoomStepFactor,
} from './RetailCamera.js';
// ACE MotionInterp.cs speed constants — single source in @ac/shared.
import {
  RUN_ANIM_SPEED, WALK_ANIM_SPEED, SIDESTEP_ANIM_SPEED, BACKWARDS_FACTOR,
  SIDESTEP_FACTOR, MAX_SIDESTEP_ANIM_RATE, RUN_TURN_FACTOR,
} from '@ac/shared';
import { MotionCommand } from '../animation/MotionCommands.js';
import { baseOfCode, mouseEventToCode, wheelEventToCode } from '../input/MouseControls.js';
import { wheelNotches, WheelNotchCounter } from '../ui/wheelScroll.js';
import { suppressesBrowserKeyDefault } from '../input/BrowserDefaults.js';

/** The local player's interpreted locomotion (InterpretedMotionState's forward / sidestep after adjust_motion). */
export interface LocalInterpretedMotion {
  forward: number;
  forwardSpeed: number;
  sidestep: number;
  sidestepSpeed: number;
  turn: number;
  turnSpeed: number;
  /** The turn became active before the sidestep (RemoteMotion InterpretedMotion.turnFirst). */
  turnFirst?: boolean;
}

export interface CameraControllerConfig {
  lookSpeed?: number;     // radians per pixel of mouse movement (default: 0.002)
  minPitch?: number;      // min pitch in radians (default: -PI/2 + 0.1)
  maxPitch?: number;      // max pitch in radians (default: PI/2 - 0.1)
}

// Base turn rate from MotionTable TurnRight cycle omega (z = -1.5 rad/s)
const BASE_TURN_RATE = 1.5;
/** CameraSet::Rotate (Use Mouse Turning): |f| below 0.02 (0x3f947ae147ae147b) stops the turn. */
const MOUSE_TURN_STOP = 0.02;
/** CameraSet::Rotate (Use Mouse Turning): the turn speed caps at 1.5 (0x3ff8000000000000). */
const MOUSE_TURN_MAX_SPEED = 1.5;
/** CInputManager_WIN32: a (0, 0) mouse-look call after 0.2 s (0x3fc999999999999a) still. */
const MOUSE_STILL_SECONDS = 0.2;
/** The SubstateList's mouse entry: HandleSelectLeft's MovePlayer(WalkForward, …, mouse 1) run. */
const MOUSE_FORWARD = 'mouse:forward';

function removeFrom(list: string[], entry: string): void {
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
}

/**
 * CameraController — AC-style WASD + right-click mouse look controller.
 *
 * Movement speeds are derived from ACE's MotionInterp constants:
 *   Forward run  = RunAnimSpeed  × runRate  (4.0 × runRate)
 *   Forward walk = WalkAnimSpeed            (3.12)
 *   Backward     = WalkAnimSpeed × 0.65 × (running ? runRate : 1)
 *   Strafe       = SidestepAnimSpeed × adjusted factor
 *   Turn         = 1.5 rad/s base (× 1.5 when running)
 *
 * The runRate property should be set from the character's Run skill
 * via getRunRate() so movement and animation stay in sync.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;

  lookSpeed: number;
  minPitch: number;
  maxPitch: number;

  // CORE.18.b.a.a — Config "Camera Stiffness" (Camera.Stiffness, retail
  // units 0.2857..1.0, default 0.45): CameraSet::current_stiffness. The
  // viewer frame eases toward its target at stiffnessBlend(t/rStiffness, dt)
  // (RetailCameraRig); CameraSet::SetStiffness @ 004577f0 sets both, or only
  // the rotational one in the head. Set via setStiffness from GameUI.
  private currentStiffness = CAMERA_DEFAULT_STIFFNESS;
  /** CameraManager::t_stiffness — translational ease of the viewer. */
  tStiffness = CAMERA_DEFAULT_STIFFNESS;
  /** CameraManager::r_stiffness — rotational ease of the viewer. */
  rStiffness = CAMERA_DEFAULT_STIFFNESS;
  /** Config "Align camera to slope" (Camera.AlignToSlope, default on): CameraManager::m_bAlignCameraToSlope. */
  alignToSlope = true;
  /** Config "Camera Adjustment Speed" (Camera.AdjustmentSpeed 5..80, default 40): m_rCameraAdjustmentSpeed. */
  adjustmentSpeed = CAMERA_DEFAULT_ADJUSTMENT_SPEED;
  /**
   * SceneTool::m_FramesPerSecond — the render loop pushes each RENDER frame's
   * dt (update() runs per physics substep); a wheel notch's tick is 1 / fps long.
   */
  readonly frameRate = new FrameRateMeter();
  /** A held Zoom Camera In / Out key (CameraSet::closer / farther): −1 in, +1 out, 0 none. */
  private heldZoom: -1 | 0 | 1 = 0;

  // CORE.17.h.g — Config "Invert mouselook axes" (Input.InvertMouseLookYAxis,
  // CInputManager m_InvertMouseLookYAxis). Retail negates BOTH axes
  // (CameraSet::MouseLookHandler @ 00458d80: param_1 = −param_1;
  // param_2 = −param_2 — the option is "Invert mouselook AXES"). Set from
  // GameUI.applyCameraConfig; default OFF like the retail SetDefaultValue(0).
  invertMouseLookY = false;
  /**
   * Config "Mouse Look Sensitivity" (Input.MouseLookSensitivity 0.01..1.0,
   * option default 0.55; CInputManager::m_MouseLookSensitivity). Scales each
   * mouse-look delta with 0.0667 (0x3d888889) into the Rotate / Raise /
   * Lower magnitude.
   */
  mouseLookSensitivity = 0.55;
  /**
   * Mouse-look is ON (CameraSet::mouselook_active). Retail default: OFF;
   * on only while the MIDDLE mouse button is held (KeyMap 0x14000002 map 5:
   * Toggle Mouselook 0x3d) or F2 / Numpad-/ is held (0x14000000: Toggle
   * Alternate Camera Mode 0x3e, which also turns mouse-look on).
   * CameraManager::OnAction @ 00455f40 → CameraSet::ToggleMouseLook(m_fStart).
   */
  private mouseLookActive = false;
  /** CameraSet::mouselook_x_extent / _y_extent: consecutive non-zero handler calls. */
  private mouseLookExtentX = 0;
  private mouseLookExtentY = 0;
  /**
   * The wheel drives Zoom Camera In / Out only after the player applies the
   * mouse-turning key bindings (gmGameplayOptionsUI element 0x100005cc →
   * global message 0xc → UIOption_ActionKeyMap::SetMouseTurningDefaults
   * @ 004886f0 binds 0x80101 / 0x80201 to 0x33 / 0x34). Retail's default
   * KeyMap binds the wheel to map 0xa (UIElement_Scrollbar /
   * UIElement_Scrollable::RegisterInputMaps), which only scrolls UI, so the
   * default is OFF: the wheel over the 3D world does nothing.
   *
   * Per sub-control: −1 = the notch fires Zoom Camera In, +1 = Zoom Camera
   * Out, 0 = unbound (MouseTurningDefaults.wheelZoomDirections derives it
   * from the key map).
   */
  wheelZoom: { up: -1 | 0 | 1; down: -1 | 0 | 1 } = { up: 0, down: 0 };
  get wheelZoomBound(): boolean { return this.wheelZoom.up !== 0 || this.wheelZoom.down !== 0; }
  /** Shorthand for the mouse-turning bindings (wheel up = in, down = out) or none. */
  set wheelZoomBound(on: boolean) { this.wheelZoom = on ? { up: -1, down: 1 } : { up: 0, down: 0 }; }

  // FAITHFUL.495 — Global UseMouseTurning state per ACE
  // CharacterOption.UseMouseTurning (0x31). Static so the
  // mousemove handler can read without a per-instance reference.
  // Callers set via `CameraController.setUseMouseTurning()` from
  // GameUI's onCharacterOptionToggle handler.
  private static useMouseTurning = false;
  static isMouseTurningEnabled(): boolean { return CameraController.useMouseTurning; }
  static setUseMouseTurning(enabled: boolean): void { CameraController.useMouseTurning = enabled; }
  /**
   * SWEEP1999.character — the 1999 options page's Right-click mouselook (options_ 0x4000): the
   * world's right-button press starts mouse-look instead of picking (ItemHolder 0x0059dc50 case 2:
   * 0x00594c50 set → 0x004f3b10(1)), held until the release. End of retail pins it off.
   */
  private static rightClickMouseLook = false;
  static setRightClickMouseLook(enabled: boolean): void { CameraController.rightClickMouseLook = enabled; }
  /** The right button holds mouse-look: Use Mouse Turning (end of retail) or Right-click mouselook (1999). */
  static rightButtonHoldsMouseLook(): boolean { return CameraController.useMouseTurning || CameraController.rightClickMouseLook; }

  /**
   * CORE.18.b.a.a.a.a.a.b — the turn motion Use Mouse Turning's mouse-look
   * drives (CameraSet::Rotate @ 00458310, non-keyboard branch →
   * CommandInterpreter::MovePlayer(0x6500000d / 0x6500000e, 1, speed, 1, 1)):
   * `left` = TurnLeft, `speed` = min(2 × |x|, 1.5). Null = not turning.
   */
  private mouseTurn: { left: boolean; speed: number } | null = null;
  /** Timer::cur_time of the last non-zero mouse-look delta (the 0.2 s stillness stop). */
  private lastMouseLookMove = 0;

  /** Run rate multiplier from character's Run skill (default 1.0 = 0 Run skill). */
  runRate: number = 1.0;

  /**
   * CommandInterpreter::auto_run — the run lock (Autorun, ActionMap 0x30).
   * Assigning goes through setAutoRun, so every change raises its notice.
   */
  get autoRun(): boolean { return this._autoRun; }
  set autoRun(on: boolean) { this.setAutoRun(on); }
  private _autoRun = false;
  /**
   * CommandInterpreter::SetAutoRun @ 006b4850 raises "AutoRun ON" /
   * "AutoRun OFF" through ECM_UI::SendNotice_DisplayStringInfo(0x1a) on
   * every change; main.ts routes it to the spew box.
   */
  onAutoRunChange: ((on: boolean) => void) | null = null;

  /**
   * CommandInterpreter::controlled_by_server — the server is moving the
   * player. Every non-autonomous movement ACE sends for us (a cast windup or
   * gesture, a swing, a server Ready, a MoveTo / TurnTo, a stance change) is
   * applied to the player (CPhysics::SetObjectMovement @ 00509690) and then
   * hands control to the server: LoseControlToServer @ 006b3170. While it is
   * set the command lists still track the keys, but they move nothing (the
   * server's motion state is the player's), and a key-up sends nothing
   * (HandleKeyboardCommand @ 006b3690: NukeCommand only). A fresh key-down,
   * or UseTime @ 006b3bf0 once the server's motions are done, takes control
   * back (TakeControlFromServer). This is the stutter of running through a
   * windup: each server motion stops the run until it has played out.
   */
  get controlledByServer(): boolean { return this._controlledByServer; }
  private _controlledByServer = false;
  /**
   * ACCmdInterp::TakeControlFromServer @ 0058b160's first step, run on every
   * movement key event (HandleKeyboardCommand calls it for each key-down, and
   * for each key-up while the player is its own): ClientCombatSystem::
   * AbortAutomaticAttack @ 0056ae90 — CancelAttack when an attack is
   * pending, building, in progress or repeating.
   */
  onAbortAutomaticAttack: (() => void) | null = null;
  /**
   * CommandInterpreter::TakeControlFromServer @ 006b32d0 while the server
   * had control: CPhysicsObj::StopCompletely(player) — the server's MoveTo /
   * TurnTo is cancelled locally and the motion goes to Ready — then the held
   * lists are applied again (ApplyCurrentMovement).
   */
  onTakeControlFromServer: (() => void) | null = null;
  /** PlayerIsDead @ 006b3d70: the interpreted forward command is Dead (main.ts → CharacterAnimController). */
  playerIsDead: (() => boolean) | null = null;
  /** LoseControlToServer's FinishJump (cmdinterp +0x50): a jump charge in progress ends without a jump. */
  onFinishJump: (() => void) | null = null;
  /** UseTime's take-back sends no movement event (see consumeSilentTakeBack). */
  private silentTakeBack = false;
  /**
   * Stop Moving (S, action 0x2b) set the raw forward command to Ready while
   * a Move Forward / Backward key is still in the SubstateList: ACCmdInterp::
   * OnAction @ 0058b370 → SetMotion(Ready) → MovePlayer → DoMotion(Ready).
   * The held key moves nothing until it is pressed again, or a release
   * hands the list head to another key (NukeCommand re-applies the head);
   * its own key-up changes nothing (RawMotionState::RemoveMotion @ 0051e6e0
   * clears the forward command only when it is that key's).
   */
  private forwardStopped = false;
  /** When the turn / sidestep last became active (an event count): which DoMotion came first. */
  private turnSince = 0;
  private sidestepSince = 0;
  private motionClock = 0;
  /**
   * Bumped for every movement event CommandInterpreter sends
   * (SendMovementEvent, cmdinterp +0x4c): HandleKeyboardCommand @ 006b3690
   * sends one for every movement key-down, every key-up while the player is
   * its own (the released key need not be a list head), the autorun toggle
   * and Stop Moving. MovementSync sends a MoveToState when it changes.
   */
  get movementEvents(): number { return this._movementEvents; }
  private _movementEvents = 0;
  /**
   * SendMovementEvent itself, at the input event: HandleKeyboardCommand
   * sends inside the key handler, with the lists as that key left them —
   * two keys in one frame send two MoveToStates (main.ts → MovementSync.
   * sendMovementEventNow).
   */
  onMovementEvent: (() => void) | null = null;
  private raiseMovementEvent(): void {
    this._movementEvents++;
    this.onMovementEvent?.();
  }

  /**
   * CMotionInterp::standing_longjump — a jump charge that began standing
   * still (CMotionInterp::charge_jump @ 005281c0). While it is set,
   * DoInterpretedMotion @ 00528360 records WalkForward / RunForward /
   * SideStepRight in the interpreted state but does not move the body, so
   * the held keys only shape the launch velocity. main.ts mirrors it from
   * CharacterAnimController every frame.
   */
  standingLongJump = false;

  /**
   * Optional physical-key → canonical-movement-code translator (VISUAL.127).
   * The Keyboard Config dialog rebinds movement by routing through this: a
   * pressed key is resolved to its bound movement command, then mapped to the
   * canonical code (KeyW/KeyS/KeyA/KeyD/KeyZ/KeyC/Space/NumLock/ShiftLeft) the
   * getters below already understand. Returns the input unchanged when the key
   * isn't a (re)bound movement key, so WASD/arrows keep working out of the box.
   * Default = identity (no remap).
   */
  /**
   * Physical key → the canonical movement code it is bound to, or null when
   * it is bound to no movement command (main.ts resolves the keymap). A key
   * bound elsewhere must not move the player because its physical name
   * happens to be a canonical code: S is Stop Moving in the retail keymap,
   * and passed through raw it walked backwards too (MOVE.combination-sweep).
   * The default (no keymap) passes every code through.
   */
  keyTranslator: (code: string) => string | null = (c) => c;

  /**
   * RECON.keyboard-dialog — whether a mouse control (MouseControls code, e.g.
   * "MouseButton2") is bound to Toggle Mouselook 0x3d, "Toggles mouselook
   * on/off while depressed". Default = the DAT DefaultMap's middle button;
   * main.ts answers from the KeybindRegistry so a rebind takes effect. A
   * meta-qualified press with no binding of its own counts as the bare
   * control (Shift-walking while the middle button looks).
   */
  isMouseLookControl: (code: string) => boolean = (c) => baseOfCode(c) === 'MouseButton2';

  /**
   * RECON.keyboard-dialog — a mouse control bound (through Keyboard Config)
   * to a one-shot / held command, pressed (down) or released over the 3D
   * world. Returns whether the press was a bound command; the release of a
   * consumed press always reaches it. Default = nothing bound.
   */
  mouseControlHandler: ((code: string, down: boolean) => boolean) | null = null;

  /**
   * FAITHFUL.373 — Honors the "Run As Default" Options checkbox.
   * Maps to ACE CharacterOption.RunAsDefaultMovement (0x0A,
   * CharacterOptions1.ToggleRun = 0x00000800). When true (retail
   * default), holding Shift makes the player WALK; when false, the
   * inverse — released keys walk, Shift makes the player RUN. Server
   * round-trip handled by FAITHFUL.372's onCharacterOptionToggle path.
   */
  runIsDefault: boolean = true;

  // Current state
  /** Total camera yaw = playerYaw + cameraYawOffset. Read-only shorthand. */
  get yaw(): number { return this.playerYaw + this.cameraYawOffset; }

  /** Player facing direction — only modified by A/D keyboard turning. */
  playerYaw: number = 0;
  /** Camera orbit offset from right-click drag. */
  cameraYawOffset: number = 0;
  pitch: number = 0;  // vertical rotation (radians, positive = looking up)

  // Input state
  private keys = new Set<string>();
  /**
   * CommandInterpreter's three CommandLists, most recent press first
   * (CommandList::AddCommand @ 006b4b80 pushes at the head; RemoveCommand
   * @ 006b4960 unlinks wherever the entry is). Only each list's head moves
   * the player (ApplyListHeadMovement @ 006b3510): the latest of opposite
   * keys wins and releasing it hands over to the one still held
   * (NukeCommand @ 006b3a20 re-applies the new head). SubstateList holds
   * Move Forward / Backward (and the mouse-look left-button run), TurnList
   * Turn Left / Right, SidestepList Strafe Left / Right (WhichList @ 006b3950).
   */
  private substateList: string[] = [];
  private turnList: string[] = [];
  private sidestepList: string[] = [];
  /**
   * Physical key (e.code) → the canonical code its keydown produced. The
   * keyup releases THAT code: the translation can change while the key is
   * held (F2 / Numpad-/ registers input map 6, where the arrows become
   * camera actions), and re-translating on keyup would leave the movement
   * code held forever.
   */
  private keyTranslations = new Map<string, string>();
  private mouseDeltaX: number = 0;
  private mouseDeltaY: number = 0;
  /** The browser button holding mouse-look (the Toggle Mouselook control), or null. */
  private mouseLookButton: number | null = null;
  /** Browser button → the bound control its press started (a movement code or a command's mouse code). */
  private mouseButtonHeld = new Map<number, { code: string; movement: boolean }>();

  // ── Camera zoom (mouse wheel) — CORE.18.b retail rig ───────────────
  // The 3rd-person viewer sits on a boom from the pivot (CAMERA_DEFAULT_PIVOT_Z
  // above the feet) at `cameraDistance`, raised `orbitElevation` above the
  // pivot's horizontal plane — retail's viewer_offset in polar form
  // (RetailCamera.ts). The default is SetDefaultOffsets' (0, −2.5, 0.75) × 1.1.
  /** Pivot-to-viewer distance of the retail default offset (≈ 2.871 m). */
  readonly defaultCameraDistance = DEFAULT_VIEWER_DISTANCE;
  /**
   * The boom length (|viewer_offset|). Retail's zoom steps change the offset
   * at once; the smooth motion the player sees is the viewer frame easing
   * toward it at the camera stiffness (RetailCameraRig).
   */
  private currentCameraDistance: number = DEFAULT_VIEWER_DISTANCE;
  /** The view pitch SetTargetForOffset aims the target frame with (radians, + = up). */
  private appliedViewPitch: number = -DEFAULT_VIEWER_ELEVATION;

  /**
   * CORE.18.b.a — the retail in-head view (CameraSet::SetInHead, action
   * 0x3a "First Person Camera"): the viewer sits CAMERA_IN_HEAD_Y ahead of
   * the pivot, looking level. Only that action enters it; the zoom steps
   * never cross into it (CameraSet::Closer refuses below CAMERA_MIN_CHAR_DIST).
   */
  private inHead = false;
  /** The orbit elevation last update (a Raise / Lower step re-applies the z <= −1.8 stiffness rule). */
  private lastElevation = DEFAULT_VIEWER_ELEVATION;

  /**
   * CORE.18.b.a.a.a.a — Overhead View (CameraSet::LookDown, action 0x3b):
   * the offset is LOOK_DOWN_OFFSET looking along LOOK_DOWN_PITCH; the
   * offset it replaced (boom, elevation, orbit, in-head) is saved for the
   * way out.
   */
  private lookingDown = false;
  private lookDownSaved: { distance: number; pitch: number; orbit: number; inHead: boolean } | null = null;
  /**
   * CORE.18.b.a.a.a.a.a — the look-down viewer_offset's −y: LookDown's 2,
   * Map View's CAMERA_MAP_DISTANCE; Raise / Lower slide it (lookDownSlide).
   */
  private lookDownBack: number = LOOK_DOWN_OFFSET.back;
  /** CameraSet::in_map_mode — Map View (action 0x3c) is on. */
  private inMapMode = false;
  /**
   * Map View's SmartBox::DisableDegrades / DisableFogging: called with true
   * when map mode turns on and false when LookDown(0) ends it. main.ts
   * turns the scene fog and the degrade selection off / back on.
   */
  onMapModeChange: ((on: boolean) => void) | null = null;

  /**
   * CORE.18.b.a.a.a.a.a — the held keyboard camera actions (CameraManager::
   * OnAction 0x35–0x38): CameraSet::rot_left / rot_right and raise / lower,
   * ticked once per render frame by CameraSet::UpdateCamera (tickHeldActions).
   */
  private heldRotate: 'left' | 'right' | null = null;
  private heldVertical: 'raise' | 'lower' | null = null;
  /** CameraSet::m_ttLastRotate / m_ttLastRaiseOrLower (0 = unset), in `clock` seconds. */
  private lastRotateTime = 0;
  private lastRaiseLowerTime = 0;
  /** Timer::cur_time — seconds. Tests inject a fake clock. */
  clock: () => number = () => performance.now() / 1000;

  /**
   * CORE.18.b.a.a.a.a — CameraSet::Rotate in the head issues
   * CommandInterpreter::TurnToHeading(heading ± CAMERA_TURN_INCREMENT): the
   * player turns (at the turn motion's rate) through this many radians
   * (+ = right). 0 = no mouse turn pending.
   */
  private headTurnRemaining = 0;

  /** 3rd-person boom length the render loop should use (0 in the head). */
  get cameraDistance(): number {
    if (this.lookingDown) return Math.hypot(this.lookDownBack, LOOK_DOWN_OFFSET.up);
    return this.inHead ? 0 : this.currentCameraDistance;
  }
  /** True in the retail in-head view (player fully translucent, camera ahead of the pivot). */
  get isFirstPerson(): boolean { return this.inHead; }

  /**
   * The 3rd-person boom's elevation above the pivot plane. Mouse-look
   * vertical moves the viewer around the pivot (CameraSet::Raise / Lower
   * rotate viewer_offset's pitch); `pitch` (+ = look up) lowers the viewer.
   */
  get orbitElevation(): number { return DEFAULT_VIEWER_ELEVATION - this.pitch; }

  /** The pitch (radians, + = up) the camera is rendered with this frame. */
  get viewPitch(): number { return this.appliedViewPitch; }

  /**
   * The 3rd-person boom from the pivot to the viewer: `back` metres behind
   * the pivot along the view heading and `up` metres above it.
   */
  thirdPersonBoom(): { back: number; up: number } {
    if (this.lookingDown) return { back: this.lookDownBack, up: LOOK_DOWN_OFFSET.up };
    const d = this.currentCameraDistance;
    const e = this.orbitElevation;
    return { back: d * Math.cos(e), up: d * Math.sin(e) };
  }

  // ASSESS: the move vector is hoisted out of update() (fresh-eyes audit
  // 2026-06-10 §performance); it is fully re-set every update(), so no
  // state aliases across frames.
  private readonly scratchMove = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, config?: CameraControllerConfig) {
    this.camera = camera;
    this.lookSpeed = config?.lookSpeed ?? 0.002;
    this.minPitch = config?.minPitch ?? (-Math.PI / 2 + 0.1);
    this.maxPitch = config?.maxPitch ?? (Math.PI / 2 - 0.1);
  }

  /**
   * Mouse-wheel zoom. Positive `notches` zoom OUT (wheel toward you), negative
   * zoom IN. Each notch is one CameraSet::Farther / Closer tick fired by
   * CInputManager_WIN32::GenerateMouseWheelEvent's back-to-back press and
   * release: the offset scales by zoomStepFactor over 1 / SceneTool::
   * m_FramesPerSecond (≈ ×0.867 in / ×1.133 out at 60 fps with the default
   * adjustment speed 40). A fractional notch (a trackpad's pixel delta) is
   * that fraction of a tick.
   */
  zoomBy(notches: number): void {
    const fps = this.frameRate.fps;
    let remaining = Math.abs(notches);
    const out = notches > 0;
    while (remaining > 1e-6) {
      const step = Math.min(1, remaining);
      remaining -= step;
      // Retail with no frame time yet: 1 / 0 → the step overshoots and is refused.
      if (!(fps > 0)) break;
      if (!this.zoomTick(!out, step / fps)) break;
    }
  }

  /**
   * CameraManager::OnAction 0x33 / 0x34 (Zoom Camera In / Out, Numpad − / +)
   * with m_fStart: the first tick runs at once (1 / fps, like a wheel notch)
   * and CameraSet::UpdateCamera keeps ticking every update with the real
   * elapsed time until the key is released (StopCloser / StopFarther).
   */
  startZoom(direction: -1 | 1): void {
    this.heldZoom = direction;
    const fps = this.frameRate.fps;
    if (fps > 0) this.zoomTick(direction < 0, 1 / fps);
  }

  stopZoom(): void {
    this.heldZoom = 0;
  }

  /** A zoom key is being held (CameraSet::closer / farther set). */
  get isZoomHeld(): boolean { return this.heldZoom !== 0; }

  /**
   * One CameraSet::Closer / Farther tick of `elapsed` seconds. Closer refuses
   * a step that would leave the viewer under CAMERA_MIN_CHAR_DIST from the
   * pivot and does nothing in the head; Farther refuses one that would put
   * the viewer more than CAMERA_FAR_LIMIT behind, and from the head steps out
   * to retail's unscaled (0, −0.6, 0.5). An accepted step sets stiffness 1
   * when the new offset is at or below CAMERA_STIFF_BELOW_Z, current
   * otherwise. Returns false when the tick was refused.
   */
  private zoomTick(closer: boolean, elapsed: number): boolean {
    // CameraSet::Closer / Farther end the overhead view first.
    if (this.lookingDown) this.setLookDown(false);
    if (this.inHead) {
      if (closer) return false;
      this.leaveHead();
      return true;
    }
    const factor = zoomStepFactor(closer, elapsed, this.adjustmentSpeed);
    if (factor === null) return false;
    const next = this.currentCameraDistance * factor;
    if (closer) {
      if (!(next >= CAMERA_MIN_CHAR_DIST)) return false;
    } else if (next * Math.cos(this.orbitElevation) > CAMERA_FAR_LIMIT) {
      return false;
    }
    this.currentCameraDistance = next;
    this.applyOffsetStiffness();
    return true;
  }

  /** CameraManager::SetStiffness(z <= −1.8 ? 1 : current_stiffness) — both axes. */
  private applyOffsetStiffness(): void {
    const z = this.currentCameraDistance * Math.sin(this.orbitElevation);
    const s = z <= CAMERA_STIFF_BELOW_Z ? 1 : this.currentStiffness;
    this.tStiffness = s;
    this.rStiffness = s;
  }

  /**
   * Config Camera Stiffness → CameraSet::SetStiffness @ 004577f0:
   * current_stiffness, and the manager's translational + rotational
   * stiffness — only the rotational one in the head (translational stays 1).
   */
  setStiffness(stiffness: number): void {
    if (!(stiffness >= 0 && stiffness <= 1)) return;
    this.currentStiffness = stiffness;
    if (!this.inHead) this.tStiffness = stiffness;
    this.rStiffness = stiffness;
  }

  get cameraStiffness(): number { return this.currentStiffness; }

  /**
   * Retail "First Person Camera" (CameraManager::OnAction 0x3a →
   * CameraSet::SetInHead @ 00458ce0): the viewer jumps (translational
   * stiffness 1) to CAMERA_IN_HEAD_Y ahead of the pivot and looks level
   * along the heading (SetTargetDirection (0, 1, 0)).
   */
  enterHead(): void {
    if (this.lookingDown) this.setLookDown(false);
    this.inHead = true;
    // The in-head offset replaces viewer_offset: the mouse-look orbit is gone.
    this.cameraYawOffset = 0;
    this.tStiffness = 1;
    this.pitch = 0;
    this.appliedViewPitch = 0;
  }

  /**
   * CameraSet::Farther from the head: viewer_offset (0, −0.6, 0.5) — boom
   * length 0.78 m at 39.8° above the pivot plane; 0.5 m up is inside
   * SetTargetForOffset's level band, so the view stays level.
   */
  private leaveHead(): void {
    this.inHead = false;
    this.currentCameraDistance = Math.hypot(OUT_OF_HEAD_OFFSET.back, OUT_OF_HEAD_OFFSET.up);
    this.pitch = DEFAULT_VIEWER_ELEVATION - Math.atan2(OUT_OF_HEAD_OFFSET.up, OUT_OF_HEAD_OFFSET.back);
    // Farther from the head: SetTranslational/RotationalStiffness(current_stiffness).
    this.tStiffness = this.currentStiffness;
    this.rStiffness = this.currentStiffness;
  }

  /**
   * Retail "Move camera to default" (CameraManager::OnAction 0x39 →
   * CameraSet::SetDefaultOffsets): the default boom straight behind the
   * player at its default elevation.
   */
  resetZoom(): void {
    if (this.lookingDown) this.setLookDown(false);
    this.inHead = false;
    this.currentCameraDistance = this.defaultCameraDistance;
    this.cameraYawOffset = 0;
    this.pitch = 0;
    // SetDefaultOffsets: SetTranslational/RotationalStiffness(current_stiffness).
    this.tStiffness = this.currentStiffness;
    this.rStiffness = this.currentStiffness;
  }

  /** True in the retail Overhead View (CameraSet::looking_down). */
  get isLookingDown(): boolean { return this.lookingDown; }

  /** Retail "Overhead View" (CameraManager::OnAction 0x3b → CameraSet::ToggleLookDown @ 00455e40). */
  toggleLookDown(): void {
    this.setLookDown(!this.lookingDown);
  }

  /**
   * CameraSet::LookDown @ 00457ff0. On: saves the offset and sets the
   * look-down offset looking along LOOK_DOWN_PITCH — (0, −2, 0.75), from the
   * head at the current stiffness; in map mode (0, −CAMERA_MAP_DISTANCE,
   * 0.75) at stiffness 1 with degrades and fog off. Off: restores the saved
   * offset — back into the head at stiffness 1; out of map mode at the
   * current stiffness (unless into the head), degrades and fog back on.
   */
  setLookDown(on: boolean): void {
    if (on === this.lookingDown) return;
    this.lookingDown = on;
    if (on) {
      this.lookDownSaved = {
        distance: this.currentCameraDistance, pitch: this.pitch, orbit: this.cameraYawOffset, inHead: this.inHead,
      };
      if (this.inMapMode) {
        this.lookDownBack = CAMERA_MAP_DISTANCE;
        this.tStiffness = 1;
        this.rStiffness = 1;
      } else {
        this.lookDownBack = LOOK_DOWN_OFFSET.back;
        if (this.inHead) {
          this.tStiffness = this.currentStiffness;
          this.rStiffness = this.currentStiffness;
        }
      }
      this.inHead = false;
      this.cameraYawOffset = 0;
      this.appliedViewPitch = LOOK_DOWN_PITCH;
      if (this.inMapMode) this.onMapModeChange?.(true);
      return;
    }
    const saved = this.lookDownSaved;
    this.lookDownSaved = null;
    const wasMap = this.inMapMode;
    this.inMapMode = false;
    if (saved) {
      this.currentCameraDistance = saved.distance;
      this.pitch = saved.pitch;
      this.cameraYawOffset = saved.orbit;
      this.inHead = saved.inHead;
    }
    const intoHead = saved?.inHead === true;
    if (wasMap) {
      if (!intoHead) {
        this.tStiffness = this.currentStiffness;
        this.rStiffness = this.currentStiffness;
      }
    } else if (intoHead) {
      this.tStiffness = 1;
      this.rStiffness = 1;
    }
    this.updateViewPitch();
    if (wasMap) this.onMapModeChange?.(false);
  }

  /** True in the retail Map View (CameraSet::in_map_mode). */
  get isInMapMode(): boolean { return this.inMapMode; }

  /** Retail "Map View" (CameraManager::OnAction 0x3c → CameraSet::ToggleMapMode @ 00455e60). */
  toggleMapMode(): void {
    this.setMapMode(!this.inMapMode);
  }

  /**
   * CameraSet::SetMapMode @ 004581d0: on → in_map_mode, stiffness 1, then
   * LookDown(1); already looking down (Overhead View), LookDown(1) is a no-op
   * and SetMapMode itself moves the offset out to −CAMERA_MAP_DISTANCE and
   * turns degrades / fog off (the overhead view's saved offset stays the one
   * to restore). Off → LookDown(0).
   */
  setMapMode(on: boolean): void {
    if (on === this.inMapMode) return;
    if (!on) {
      this.setLookDown(false);
      return;
    }
    this.inMapMode = true;
    this.tStiffness = 1;
    this.rStiffness = 1;
    if (!this.lookingDown) {
      this.setLookDown(true);
      return;
    }
    this.lookDownBack = CAMERA_MAP_DISTANCE;
    this.onMapModeChange?.(true);
  }

  /**
   * Retail "Rotate Camera Left / Right" pressed (CameraManager::OnAction
   * 0x35 / 0x36 with m_fStart → CameraSet::Rotate(left, 1, 1.0, 1)): one
   * tick now — the first one 1 / SceneTool::m_FramesPerSecond long — then
   * one per render frame until released (tickHeldActions).
   */
  startRotate(direction: 'left' | 'right'): void {
    this.heldRotate = direction;
    this.rotateTick(direction === 'left');
  }

  /** CameraSet::StopRotating @ 004573f0: both directions, m_ttLastRotate = 0. */
  stopRotate(): void {
    this.heldRotate = null;
    this.lastRotateTime = 0;
  }

  /** Retail "Rotate Camera Up / Down" pressed (OnAction 0x37 / 0x38 → CameraSet::Raise / Lower(1, 1.0)). */
  startRaiseLower(direction: 'raise' | 'lower'): void {
    this.heldVertical = direction;
    this.raiseLowerTick(direction === 'raise');
  }

  /** CameraSet::StopRaising / StopLowering @ 00457410 / 00457420. */
  stopRaiseLower(): void {
    this.heldVertical = null;
    this.lastRaiseLowerTime = 0;
  }

  /** Release every held camera action (window blur). */
  stopHeldActions(): void {
    this.stopZoom();
    this.stopRotate();
    this.stopRaiseLower();
  }

  /** A Rotate / Raise / Lower key is being held. */
  get isCameraActionHeld(): boolean { return this.heldRotate !== null || this.heldVertical !== null; }

  /**
   * CameraSet::UpdateCamera @ 00458ae0 — once per render frame: a held
   * Rotate ticks Rotate(dir, 1, 1.0, 1), then a held Raise / Lower ticks.
   */
  tickHeldActions(): void {
    if (this.heldRotate !== null) this.rotateTick(this.heldRotate === 'left');
    if (this.heldVertical !== null) this.raiseLowerTick(this.heldVertical === 'raise');
  }

  /** m_ttLast… = Timer::cur_time − 1 / SceneTool::m_FramesPerSecond. */
  private firstTickStart(now = this.clock()): number {
    const fps = this.frameRate.fps;
    return now - (fps > 0 ? 1 / fps : 0);
  }

  /**
   * One keyboard CameraSet::Rotate @ 00458310 tick (param_4 = 1, so the
   * UseMouseTurning branch never applies). Ends the overhead view. In the
   * head: TurnToHeading(heading + CAMERA_TURN_INCREMENT) for left, − for
   * right — heading grows clockwise, so Rotate Camera Left turns the player
   * RIGHT, as retail's in-head mouse-look does. Otherwise viewer_offset
   * turns about the pivot by (elapsed × m_rCameraAdjustmentSpeed) ×
   * CAMERA_ROTATE_RADIANS: left swings the viewer to the player's left,
   * turning the view right (cameraYawOffset +).
   */
  private rotateTick(left: boolean, magnitude = 1, held = true): void {
    const now = this.clock();
    // CameraSet::Rotate seeds m_ttLastRotate = now − 1 / fps when it is 0.
    if (this.lastRotateTime === 0) this.lastRotateTime = this.firstTickStart(now);
    if (!(now - this.lastRotateTime >= F_EPSILON)) return;
    if (!held && CameraController.useMouseTurning) {
      // Use Mouse Turning, a non-keyboard call (param_4 = 0): the player turns
      // instead of the viewer orbiting — in the head too.
      if (this.lookingDown) this.setLookDown(false);
      this.mouseTurnStep(left, magnitude, now);
      this.lastRotateTime = 0;
      return;
    }
    this.applyRotate(left, magnitude, now);
    // A non-held call (param_2 = 0: mouse-look) clears rot_left / rot_right
    // and m_ttLastRotate, so the next key press starts a fresh 1 / fps tick
    // instead of integrating the time since the last mouse-look step.
    if (!held) this.lastRotateTime = 0;
  }

  /**
   * CameraSet::Rotate's Use Mouse Turning branch: f = the mouse-look
   * magnitude (elapsed × m_rCameraAdjustmentSpeed when it is exactly 1.0);
   * |f| < 0.02 stops turning (cmdinterp +0xa4); otherwise the turn motion runs
   * at min(2f, 1.5) — Rotate(right) (param_1 = 0) is TurnLeft 0x6500000e,
   * Rotate(left) is TurnRight 0x6500000d, the same way round as the orbit.
   */
  private mouseTurnStep(left: boolean, magnitude: number, now: number): void {
    const f = magnitude !== 1 ? magnitude : (now - this.lastRotateTime) * this.adjustmentSpeed;
    if (f < MOUSE_TURN_STOP && f > -MOUSE_TURN_STOP) {
      this.setMouseTurn(null);
      return;
    }
    this.setMouseTurn({ left: !left, speed: Math.min(2 * f, MOUSE_TURN_MAX_SPEED) });
  }

  /** A mouse turn starting, stopping or reversing is a movement event (MovePlayer + SendMovementEvent). */
  private setMouseTurn(t: { left: boolean; speed: number } | null): void {
    if ((t === null) !== (this.mouseTurn === null) || (t && this.mouseTurn && t.left !== this.mouseTurn.left)) this.raiseMovementEvent();
    this.mouseTurn = t;
  }

  /** The Use Mouse Turning turn's speed (MovePlayer's speed argument); 1 otherwise. */
  get turnSpeed(): number { return this.mouseTurn?.speed ?? 1; }

  /** A left press over the world runs forward instead of selecting (HandleSelectLeft's return 1). */
  get leftButtonRunsForward(): boolean { return this.mouseTurningLook; }

  /** Use Mouse Turning's mouse-look is on: turn keys sidestep, the left button runs forward. */
  private get mouseTurningLook(): boolean {
    return CameraController.useMouseTurning && this.mouseLookActive;
  }

  private applyRotate(left: boolean, magnitude: number, now: number): void {
    if (this.lookingDown) this.setLookDown(false);
    if (this.inHead) {
      // The in-head branch leaves m_ttLastRotate alone.
      const step = CAMERA_TURN_INCREMENT * Math.PI / 180;
      this.headTurnRemaining = left ? step : -step;
      return;
    }
    // param_3 != 1.0 (a mouse-look magnitude) replaces elapsed × speed.
    const factor = magnitude !== 1 ? magnitude : (now - this.lastRotateTime) * this.adjustmentSpeed;
    const angle = factor * CAMERA_ROTATE_RADIANS;
    this.lastRotateTime = now;
    this.cameraYawOffset += left ? angle : -angle;
  }

  /**
   * One keyboard CameraSet::Raise @ 00457980 / Lower @ 00457cf0 tick.
   * Looking down: lookDownSlide (no time scaling). In the head:
   * inHeadRaiseLower. Otherwise the viewer's pitch about the pivot turns by
   * (elapsed × m_rCameraAdjustmentSpeed × (0.25 with UseMouseTurning)) ×
   * CAMERA_ROTATE_RADIANS — up for Raise, down for Lower — inside the
   * existing over-the-top / ground-distance limits and stiffness rule.
   */
  private raiseLowerTick(raise: boolean, magnitude = 1, held = true): void {
    const now = this.clock();
    // CameraSet::Raise / Lower seed m_ttLastRaiseOrLower = now − 1 / fps when it is 0.
    if (this.lastRaiseLowerTime === 0) this.lastRaiseLowerTime = this.firstTickStart(now);
    if (!(now - this.lastRaiseLowerTime >= F_EPSILON)) return;
    this.applyRaiseLower(raise, magnitude, now);
    // A non-held call (param_1 = 0: mouse-look) clears m_ttLastRaiseOrLower.
    if (!held) this.lastRaiseLowerTime = 0;
  }

  private applyRaiseLower(raise: boolean, magnitude: number, now: number): void {
    if (this.lookingDown) {
      this.lookDownBack = lookDownSlide(this.lookDownBack, raise);
      return;
    }
    if (this.inHead) {
      this.pitch = inHeadRaiseLower(this.pitch, raise);
      this.appliedViewPitch = this.pitch;
      return;
    }
    // param_2 != 1.0 (a mouse-look magnitude) replaces elapsed × speed.
    let k = magnitude !== 1 ? magnitude : (now - this.lastRaiseLowerTime) * this.adjustmentSpeed;
    if (CameraController.useMouseTurning) k *= MOUSE_TURNING_RAISE_SCALE;
    this.lastRaiseLowerTime = now;
    const step = k * CAMERA_ROTATE_RADIANS;
    // orbitElevation = DEFAULT_VIEWER_ELEVATION − pitch: Raise lifts the viewer.
    this.pitch += raise ? -step : step;
    this.updateViewPitch();
  }

  /**
   * A physical key going down, as bind()'s keydown listener delivers it (and
   * as the movement golden tests replay it): translated through the keymap,
   * Autorun toggles the run lock, everything else is pressed. True when the
   * key was consumed (the browser default is prevented).
   */
  handleKeyDown(physical: string, repeat = false, alt = false): boolean {
    // A chord binding first (the retail KeyMap binds Strafe Right / Left to
    // Alt+D / Alt+A as well as C / Z), else the bare key.
    const chord = alt ? this.keyTranslator(`Alt+${physical}`) : null;
    const code = chord && chord !== `Alt+${physical}` ? chord : this.keyTranslator(physical);
    if (code === null) return false;
    // Autorun (the canonical 'NumLock' — Q by default) toggles the run
    // lock: CommandInterpreter::ToggleAutoRun @ 006b3cc0. Retail reads
    // DirectInput key transitions, which carry no OS auto-repeat, so a
    // held key toggles once.
    if (code === 'NumLock') {
      if (!repeat) this.toggleAutoRun();
      return true;
    }
    this.keyTranslations.set(physical, code);
    this.pressKey(code);
    return false;
  }

  /** A physical key coming up: released under the code it was pressed as. */
  handleKeyUp(physical: string): void {
    // COMPAT.mac-cmd-keyup — macOS browsers (Safari, Chrome, Firefox) deliver
    // no keyup for a key released while Cmd is held, so a movement or camera
    // key let go during a Cmd chord stayed pressed (the character kept
    // running) until pressed again. Cmd coming up releases everything held,
    // as a window blur does; a key still down is pressed again by the player.
    if (physical === 'MetaLeft' || physical === 'MetaRight') {
      if (this.keyTranslations.size > 0 || this.keys.size > 0) this.releaseAllKeys();
      this.stopHeldActions();
      return;
    }
    const code = this.keyTranslations.get(physical) ?? this.keyTranslator(physical);
    this.keyTranslations.delete(physical);
    if (code !== null) this.releaseKey(code);
  }

  /**
   * Bind keyboard and mouse events to a DOM element.
   * Call this in browser context only.
   */
  bind(element: HTMLElement): void {
    this.pointerLockTarget = element;
    element.addEventListener('keydown', (e) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const consumed = this.handleKeyDown(e.code, e.repeat, e.altKey);
      // The arrows / Space / Page keys walk and jump; they never also scroll
      // the panel last clicked (retail panels take no keyboard focus).
      // COMPAT.firefox-quick-find — nor does a printable key open Firefox's find bar.
      if (consumed || suppressesBrowserKeyDefault(e, document.activeElement)) e.preventDefault();
    });
    // Always process keyup to avoid stuck keys when focus changes mid-press
    element.addEventListener('keyup', (e) => this.handleKeyUp(e.code));
    // Retail default mouse-look: held MIDDLE button (KeyMap 0x14000002
    // DefaultMap, input map 5: device 1 control 0xe → Toggle Mouselook
    // 0x3d, "Toggles mouselook on/off while depressed"). The right button
    // does NOT mouse-look by default. RECON.keyboard-dialog — the control is
    // whatever Toggle Mouselook is bound to (isMouseLookControl), and any
    // other bound mouse button runs its command over the world.
    element.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no browser autoscroll
      const code = mouseEventToCode(e);
      if (code && this.isMouseLookControl(code)) {
        e.preventDefault();
        this.mouseLookButton = e.button;
        this.setMouseLook(true);
        return;
      }
      if (!this.isWorldMouseTarget(e)) return;
      if (code) {
        // Movement translates the bare control, as keys do (keyTranslator gets e.code).
        const bare = baseOfCode(code);
        const movement = this.keyTranslator(bare);
        if (movement !== null && movement !== bare) {
          this.mouseButtonHeld.set(e.button, { code: movement, movement: true });
          this.pressKey(movement);
          return;
        }
        if (this.mouseControlHandler?.(code, true)) {
          this.mouseButtonHeld.set(e.button, { code, movement: false });
          return;
        }
      }
      if (e.button === 0) this.mouseLeftButton(true);
      else if (e.button === 2) this.mouseRightButton(true);
    });
    element.addEventListener('mouseup', (e) => {
      if (this.mouseLookButton === e.button) {
        this.mouseLookButton = null;
        this.setMouseLook(false);
        return;
      }
      // A release always lands, wherever the pointer is: a held button must
      // never stick (the pointer is locked while mouse-look is on).
      const held = this.mouseButtonHeld.get(e.button);
      if (held) {
        this.mouseButtonHeld.delete(e.button);
        if (held.movement) this.releaseKey(held.code);
        else this.mouseControlHandler?.(held.code, false);
        return;
      }
      if (e.button === 0) this.mouseLeftButton(false);
      else if (e.button === 2) this.mouseRightButton(false);
    });
    element.addEventListener('mousemove', (e) => {
      if (this.mouseLookActive) {
        this.mouseDeltaX += e.movementX;
        this.mouseDeltaY += e.movementY;
      }
    });
    // The browser drops pointer lock on Esc while the look button is still
    // held; the held state would otherwise stay on with a visible cursor.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('pointerlockchange', () => {
        if (!document.pointerLockElement && this.mouseLookActive) {
          this.mouseLookButton = null;
          this.setMouseLook(false);
        }
      });
    }
    // Prevent context menu on right-click
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse-wheel camera zoom (AC-style): wheel down/away zooms out, wheel
    // up/toward zooms in, stopping at CAMERA_MIN_CHAR_DIST. deltaY > 0
    // is scroll-down in browsers = zoom out. Normalize line/page delta modes
    // to ~one notch so trackpads and mice feel consistent.
    element.addEventListener('wheel', (e) => {
      // RECON.keyboard-dialog — a wheel sub-control bound to some other
      // command (Keyboard Config) fires it once per event, over the world
      // only: CInputManager_WIN32::GenerateMouseWheelEvent sends the press
      // and the release back to back.
      // COMPAT.wheel-deltamode: wheelNotches reads deltaMode before deltaY
      // and counts one notch per physical click in every browser (a Firefox
      // 3-line click, a Chrome 100 px or 150 px click, a Safari wheelDelta
      // 120); a touchpad gives fractions.
      const notches = wheelNotches(e);
      if (!this.wheelZoomBound || (notches < 0 ? this.wheelZoom.up : this.wheelZoom.down) === 0) {
        const wheel = wheelEventToCode(e);
        const t = e.target as HTMLElement | null;
        if (!wheel || !this.mouseControlHandler || t?.closest?.('#game-hud, #game-ui-screens')) return;
        // One press + release per click; a touchpad's stream presses once per notch gathered.
        const presses = Math.abs(this.wheelCommandNotches.addNotches(notches));
        for (let i = 0; i < presses; i++) {
          if (!this.mouseControlHandler(wheel, true)) return;
          e.preventDefault();
          this.mouseControlHandler(wheel, false);
        }
        return;
      }
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // CORE.1.b — wheel over HUD/screen UI belongs to that UI (scrolling
      // the inventory grid, chat, lists), not the camera. This listener is
      // bound to document.body, so without this guard its preventDefault
      // killed native panel scrolling everywhere and zoomed the camera
      // instead. Retail only zooms when the pointer is over the 3D world.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('#game-hud, #game-ui-screens')) return;
      // deltaY < 0 is the wheel's up (positive-axis) sub-control.
      const dir = notches < 0 ? this.wheelZoom.up : this.wheelZoom.down;
      if (dir === 0) return; // that sub-control is not bound to a zoom
      e.preventDefault();
      this.zoomBy(Math.abs(notches) * dir);
    }, { passive: false });
  }

  /**
   * The 3D world is under the press (UIElement_SmartBoxWrapper gets it): the
   * canvas, or anything while the pointer is locked. Presses on HUD panels
   * belong to the panel.
   */
  private isWorldMouseTarget(e: MouseEvent): boolean {
    if (typeof document !== 'undefined' && document.pointerLockElement) return true;
    const t = e.target as { tagName?: string } | null;
    return t?.tagName === 'CANVAS';
  }

  /**
   * CommandInterpreter::HandleSelectLeft @ 006b3630 (UIElement_SmartBoxWrapper
   * MouseDown / MouseUp, button 7): records mouseleft_down; with Use Mouse
   * Turning on and mouse-look active it runs forward (MovePlayer 0x45000005)
   * and returns 1 — the press does not select. Returns whether it was consumed.
   */
  mouseLeftButton(down: boolean): boolean {
    // CommandInterpreter::mouseleft_down: the run is a MOUSE command in the SubstateList (MovePlayer(…, mouse 1)):
    // AddCommand replaces the list's previous mouse entry and pushes at the
    // head; the release removes it (RemoveCommand's mouse branch).
    removeFrom(this.substateList, MOUSE_FORWARD);
    if (down) this.substateList.unshift(MOUSE_FORWARD);
    this.raiseMovementEvent();
    return CameraController.useMouseTurning && this.mouseLookActive;
  }

  /**
   * UIElement_SmartBoxWrapper::MouseDown / MouseUp @ 004e5700 / 004e5820,
   * button 8: with Use Mouse Turning on, the right button holds mouse-look
   * (ToggleMouseLook(1) on press, (0) on release) and the release does not
   * examine. Without it the press does nothing here and the release examines
   * (WorldRightClick). Returns whether it was consumed.
   */
  mouseRightButton(down: boolean): boolean {
    if (!CameraController.rightButtonHoldsMouseLook()) return false;
    this.setMouseLook(down);
    return true;
  }

  /**
   * CameraSet::ToggleMouseLook @ 00457490: mouse-look follows the action's
   * press state (on while the middle button / F2 / Numpad-/ is held). The
   * extents reset when it turns on. Retail hides the cursor and restores it
   * where it was (CInputManager_WIN32 mlb_Remember); pointer lock is that.
   */
  setMouseLook(active: boolean): void {
    if (this.mouseLookActive === active) return;
    this.mouseLookActive = active;
    // With Use Mouse Turning, ToggleMouseLook also moves the player
    // (MovePlayer(0xc0000c1, on)): held turn keys become sidesteps and a held
    // left button runs forward while it is on (the getters below); turning it
    // off stops the mouse turn.
    if (!active) this.setMouseTurn(null);
    if (active) {
      this.mouseLookExtentX = 0;
      this.mouseLookExtentY = 0;
      // requestPointerLock returns a promise in current Chrome; it rejects
      // (e.g. right after an Esc exit) and must not surface as unhandled.
      const lock = this.pointerLockTarget?.requestPointerLock?.() as unknown;
      if (lock && typeof (lock as Promise<void>).catch === 'function') (lock as Promise<void>).catch(() => {});
    } else {
      this.mouseDeltaX = 0;
      this.mouseDeltaY = 0;
      if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock?.();
    }
  }

  /** Mouse-look is currently on. */
  get isMouseLookActive(): boolean { return this.mouseLookActive; }

  /** COMPAT.wheel-deltamode — a wheel-bound command's touchpad notches gathered so far. */
  private readonly wheelCommandNotches = new WheelNotchCounter();

  /** The element pointer lock is requested on (set by bind()). */
  private pointerLockTarget: HTMLElement | null = null;

  /**
   * CameraSet::MouseLookHandler @ 00458d80 for one set of deltas (dx right +,
   * dy down +, DirectInput relative axes). Each axis scales by
   * m_MouseLookSensitivity × 0.0667; Invert mouselook axes negates BOTH.
   * An axis acts only after MORE THAN 5 consecutive non-zero calls (a zero
   * on that axis in a non-zero call resets it; an all-zero call is a no-op). X goes through the same Rotate as the camera keys: in 3rd
   * person mouse right = Rotate Camera Right, and in the head the direction
   * flips (mouse right = Rotate(1), turning the player right). Y > 0 (mouse
   * down) = Lower, Y < 0 = Raise. Retail's smoothing amount defaults to 0
   * (m_MouseLookSmoothingAmount, CInputManager ctor), which makes
   * FilterMouseInput the identity.
   */
  private mouseLookHandler(dx: number, dy: number): void {
    // A (0,0) call returns at once unless Use Mouse Turning is on
    // (@00458d80: `if (x == 0 && y == 0) { if (!s_cidm[0x22].field_0x1)
    // goto LAB_00458f73; ... }`) — the extents are NOT reset, so a still
    // mouse (or a frame split into several physics substeps) keeps the dead
    // band where it was. Only a non-zero call with one axis at 0 resets
    // that axis.
    if (dx === 0 && dy === 0) {
      if (!CameraController.useMouseTurning) return;
      // Use Mouse Turning: a still mouse stops the turn (cmdinterp +0xa4),
      // then the zero deltas run through and reset both extents.
      this.setMouseTurn(null);
    }
    const k = this.mouseLookSensitivity * MOUSE_LOOK_SCALE;
    let x = dx * k;
    let y = dy * k;
    if (this.invertMouseLookY) { x = -x; y = -y; }
    if (x === 0) {
      this.mouseLookExtentX = 0;
    } else if (++this.mouseLookExtentX > 5) {
      this.rotateTick(this.inHead ? x > 0 : x < 0, Math.abs(x), false);
    }
    if (y === 0) {
      this.mouseLookExtentY = 0;
    } else if (++this.mouseLookExtentY > 5) {
      this.raiseLowerTick(y < 0, Math.abs(y), false);
    }
  }

  /**
   * Simulate key press (for testing).
   */
  simulateKeyDown(code: string): void {
    this.pressKey(code);
  }

  /**
   * A (canonical) key goes down. A key already held is the OS auto-repeat:
   * retail's DirectInput buffer has no repeats, so it changes nothing.
   * CInputManager::ActivateActionKey @ 00432650: the START of Move Forward
   * (0x29) or Move Backward (0x2a) calls TurnOffRunLock, so either drops
   * autorun (Stop Moving, 0x2b, is stopMoving()). The press then joins the
   * head of its CommandList.
   */
  private pressKey(code: string): void {
    if (this.keys.has(code)) return;
    this.keys.add(code);
    const list = this.listFor(code);
    // HandleKeyboardCommand @ 006b3690: a movement key-down takes control
    // back from the server first (cmdinterp +0x68), then joins its list.
    if (list) this.takeControlFromServer();
    // AddCommand @ 006b39a0 → a SubstateList entry runs ACCmdInterp::
    // HandleNewForwardMovement @ 0058b1f0: AbortAutomaticAttack (again), SetAutoRun off.
    if (code === 'KeyW' || code === 'KeyS') { this.onAbortAutomaticAttack?.(); this.setAutoRun(false); this.forwardStopped = false; this.transientPosture = false; this._rawForwardHoldRun = false; }
    const wasActive = list ? list.length > 0 : false;
    list?.unshift(code);
    if (list) this.raiseMovementEvent();
    if (!wasActive && list === this.turnList) this.turnSince = ++this.motionClock;
    if (!wasActive && list === this.sidestepList) this.sidestepSince = ++this.motionClock;
  }

  /**
   * A (canonical) key comes up: it leaves its CommandList, wherever it was
   * in it. While the server controls the player that is all (NukeCommand);
   * otherwise HandleKeyboardCommand runs TakeControlFromServer first, whose
   * AbortAutomaticAttack still cancels an automatic attack.
   */
  private releaseKey(code: string): void {
    this.keys.delete(code);
    const list = this.listFor(code);
    if (!list) return;
    const controlled = this._controlledByServer;
    if (!controlled) this.takeControlFromServer();
    const wasHead = list[0] === code;
    removeFrom(list, code);
    // A sidestep or turn stopping takes the other back to the substate
    // (StopMotion → re_modify): it counts as the newer of the two.
    if (!list.length && list === this.sidestepList && this.turnList.length) this.turnSince = ++this.motionClock;
    if (!list.length && list === this.turnList && this.sidestepList.length) this.sidestepSince = ++this.motionClock;
    // NukeCommand re-applies a new head (a Stop Moving forward no longer holds).
    if (list === this.substateList && wasHead && list.length && !this.transientPosture) this.forwardStopped = false;
    if (!controlled) this.raiseMovementEvent();
  }

  /** CommandInterpreter::LoseControlToServer @ 006b3170: the server moves us; autorun and a jump charge end. */
  loseControlToServer(): void {
    this._controlledByServer = true;
    this.setAutoRun(false);
    this.onFinishJump?.();
  }

  /**
   * ACCmdInterp::TakeControlFromServer @ 0058b160 → CommandInterpreter::
   * TakeControlFromServer @ 006b32d0: abort an automatic attack, then — only
   * if the server had control — clear the flag and stop the body so the held
   * lists apply afresh.
   */
  takeControlFromServer(): void {
    this.onAbortAutomaticAttack?.();
    // PlayerIsDead @ 006b3d70 (cmdinterp +0x78): the dead stay the server's.
    if (!this._controlledByServer || this.playerIsDead?.()) return;
    this._controlledByServer = false;
    this.onTakeControlFromServer?.();
  }

  /**
   * CommandInterpreter::UseTime @ 006b3bf0, once a frame: while the server
   * has control, its motions are done (`motionsPending` false) and no MoveTo
   * runs, a held key or autorun takes control back. That take-back sends no
   * movement event; with nothing held the server keeps control.
   */
  useTime(motionsPending: boolean, movingTo: boolean): void {
    if (!this._controlledByServer || motionsPending || movingTo) return;
    if (!this.substateList.length && !this.turnList.length && !this.sidestepList.length && !this._autoRun) return;
    this.takeControlFromServer();
    this.silentTakeBack = true;
  }

  /**
   * True once after UseTime's take-back: the held keys apply again, but the
   * server is not told (MovementSync absorbs the change).
   */
  consumeSilentTakeBack(): boolean {
    const v = this.silentTakeBack;
    this.silentTakeBack = false;
    return v;
  }

  /** CommandInterpreter::WhichList @ 006b3950 for the canonical movement codes. */
  private listFor(code: string): string[] | null {
    switch (code) {
      case 'KeyW': case 'KeyS': return this.substateList;
      case 'KeyA': case 'KeyD': return this.turnList;
      case 'KeyZ': case 'KeyC': return this.sidestepList;
      default: return null;
    }
  }

  /**
   * CommandInterpreter::SetAutoRun @ 006b4850: only a CHANGE does anything —
   * it sets auto_run and raises "AutoRun ON" / "AutoRun OFF" (0x1a).
   */
  setAutoRun(on: boolean): void {
    if (on === this._autoRun) return;
    this._autoRun = on;
    // Autorun applies its forward command with HoldKey_Run (ApplyCurrentMovement).
    if (on) this._rawForwardHoldRun = true;
    this.onAutoRunChange?.(on);
  }

  /**
   * RawMotionState::forward_holdkey is Run: set when autorun applies its
   * forward command, cleared when the keyboard applies one (a Move Forward /
   * Backward press, Stop Moving, the autorun toggle going off — each a
   * MovePlayer with no hold key). StopCompletely (a cast, an attack, Escape)
   * puts the forward command to Ready but leaves the hold key: retail's
   * stopped MoveToState after an autorun cast still packs ForwardHoldKey Run
   * (sweep-auto-cast: 0b000000 02000000 49000080 02000000).
   */
  get rawForwardHoldRun(): boolean { return this._rawForwardHoldRun; }
  private _rawForwardHoldRun = false;

  /** CommandInterpreter::ToggleAutoRun @ 006b3cc0: SetAutoRun(auto_run == 0, 1). */
  toggleAutoRun(): void {
    this.setAutoRun(!this._autoRun);
    if (!this._autoRun) this._rawForwardHoldRun = false;
    this.raiseMovementEvent();
  }

  /**
   * Retail "Stop Moving" (ActionMap 0x2b, S by default). CInputManager::
   * ActivateActionKey @ 00432650 calls TurnOffRunLock for actions 0x29 /
   * 0x2a / 0x2b, so autorun drops; then ACCmdInterp::OnAction @ 0058b370
   * case 0x2b runs SetMotion(Ready, true) through HandleKeyboardCommand:
   * TakeControlFromServer, AddCommand (no list for Ready →
   * HandleNewForwardMovement: AbortAutomaticAttack, SetAutoRun off),
   * MovePlayer → DoMotion(Ready) — the forward command stops even with
   * Move Forward still held (forwardStopped), a sit / crouch ends — and a
   * movement event. Sidestep and turn are untouched.
   */
  stopMoving(): void {
    this.transientPosture = false;
    this.takeControlFromServer();
    this.onAbortAutomaticAttack?.();
    this.setAutoRun(false);
    this._rawForwardHoldRun = false;
    if (this.substateList.length) this.forwardStopped = true;
    this.onStopMovingSubstate?.();
    this.raiseMovementEvent();
  }

  /**
   * A posture key (Crouch / Sitting / Sleeping 0x41000012–14, the 0x43…
   * state emotes): ACCmdInterp::OnAction → SetMotion(cmd, true) →
   * HandleKeyboardCommand: TakeControlFromServer, then AddCommand @ 006b39a0
   * — no list, a SubState-class command → HandleNewForwardMovement
   * (AbortAutomaticAttack, autorun off) and transient_state = 1 — and
   * MovePlayer's DoMotion makes it the raw forward command: a held Move
   * Forward stops moving until pressed again, and while transient_state is
   * set its release hands nothing back (NukeCommand returns 0).
   */
  applyPosture(): void {
    this.takeControlFromServer();
    this.onAbortAutomaticAttack?.();
    this.setAutoRun(false);
    if (this.substateList.length) this.forwardStopped = true;
    this.transientPosture = true;
  }
  private transientPosture = false;

  /** Stop Moving's DoMotion(Ready) ends a held posture (Sit / Crouch / Sleep): main.ts → CharacterAnimController. */
  onStopMovingSubstate: (() => void) | null = null;

  /**
   * CommandInterpreter::StopCompletely @ 006b3b50: ClearAllCommands (every
   * CommandList empties — a key still down moves nothing until it is pressed
   * again) and SetAutoRun(0). The keys themselves stay down.
   */
  stopCompletely(): void {
    this.forwardStopped = false;
    this.transientPosture = false;
    this.substateList.length = 0;
    this.turnList.length = 0;
    this.sidestepList.length = 0;
    this.headTurnRemaining = 0;
    this.setAutoRun(false);
  }

  /**
   * Release every held movement key (window blur: the keyups for keys held
   * while focus leaves are never delivered). Auto-run is a lock, not a held
   * key, so it survives.
   */
  releaseAllKeys(): void {
    this.forwardStopped = false;
    this.keys.clear();
    this.keyTranslations.clear();
    this.substateList.length = 0;
    this.turnList.length = 0;
    this.sidestepList.length = 0;
  }

  /**
   * Simulate key release (for testing).
   */
  simulateKeyUp(code: string): void {
    this.releaseKey(code);
  }

  /**
   * Simulate mouse movement (for testing).
   */
  simulateMouseMove(deltaX: number, deltaY: number): void {
    this.mouseDeltaX += deltaX;
    this.mouseDeltaY += deltaY;
  }

  /**
   * Update camera position and rotation based on input state.
   * AC-style controls: A/D = keyboard turning, Z/C = strafing.
   *
   * Movement speeds use ACE MotionInterp formulas so animation and
   * movement stay in sync (both scale by runRate).
   *
   * @param dt Delta time in seconds
   */
  update(dt: number): void {
    // CameraSet::UpdateCamera: a held zoom key ticks Closer / Farther with
    // the time since the last tick.
    if (this.heldZoom !== 0) this.zoomTick(this.heldZoom < 0, dt);

    // Mouse look — CameraSet::MouseLookHandler @ 00458d80 with each non-zero
    // delta. CInputManager_WIN32 calls it with (0, 0) only while mouse-look
    // is on and the mouse has been still for more than 0.2 s — which is what
    // stops a Use Mouse Turning turn.
    if (this.mouseDeltaX !== 0 || this.mouseDeltaY !== 0) {
      this.lastMouseLookMove = this.clock();
      this.mouseLookHandler(this.mouseDeltaX, this.mouseDeltaY);
    } else if (this.mouseLookActive && this.clock() - this.lastMouseLookMove > MOUSE_STILL_SECONDS) {
      this.mouseLookHandler(0, 0);
    }
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.updateViewPitch();

    // Keyboard turning — turns the player (A/D keys)
    let turnRate = BASE_TURN_RATE;
    if (this.isRunning) turnRate *= RUN_TURN_FACTOR;
    // CORE.18 — turning left (toward AC counter-clockwise, e.g. north → west)
    // lowers yaw: forward (−sin yaw, −cos yaw) in (east, north) at yaw = π is
    // north, and π − ε leans west.
    // MOVE.slide-speed-around-sphere — the body moves along the heading it
    // had when the frame began (see the sequence offset below).
    const yawAtFrameStart = this.playerYaw;
    const turnHead = this.mouseTurningLook || this._controlledByServer ? null : this.turnList[0];
    const keyTurnLeft = turnHead === 'KeyA';
    const keyTurnRight = turnHead === 'KeyD';
    if (keyTurnLeft || keyTurnRight || this.mouseTurn) this.headTurnRemaining = 0;
    if (keyTurnLeft) this.playerYaw -= turnRate * dt;
    if (keyTurnRight) this.playerYaw += turnRate * dt;
    if (this.mouseTurn) {
      // MovePlayer(turn, 1, speed, 1, 1): hold key Run (param_5 = 1), so the
      // run turn factor applies at the mouse speed.
      const mouseRate = BASE_TURN_RATE * RUN_TURN_FACTOR * this.mouseTurn.speed;
      this.playerYaw += (this.mouseTurn.left ? -mouseRate : mouseRate) * dt;
    }
    if (this.headTurnRemaining !== 0) {
      // TurnToHeading: turn at the turn motion's rate until the heading is reached.
      const stepYaw = Math.min(Math.abs(this.headTurnRemaining), turnRate * dt) * Math.sign(this.headTurnRemaining);
      this.playerYaw += stepYaw;
      this.headTurnRemaining -= stepYaw;
      if (Math.abs(this.headTurnRemaining) < 1e-9) this.headTurnRemaining = 0;
    }

    // Movement uses player facing direction, not camera direction. A
    // standing long jump's charge records the keys but does not move the
    // body (DoInterpretedMotion @ 00528360 skips WalkForward / RunForward /
    // SideStepRight while standing_longjump is set).
    //
    // BUG.local-movement-ignores-links — retail's UpdatePositionInternal
    // @ 00512c30 advances the player's sequence by the quantum
    // (CPartArray::Update) and moves the body by the offset it returns: the
    // pos-frames of whatever node is playing — the Ready → Run start link's
    // slow first steps, the Run → Ready stop link's coast, a substate change
    // queued behind a playing link — plus the sequence's velocity. With
    // sequenceStep wired that offset is the movement; the averaged cycle
    // velocity (motionVelocity) is only the fallback before the player has
    // a motion table.
    //
    // MOVE.slide-speed-around-sphere — the offset is in the frame the body
    // had when the update began: CSequence::apply_physics @ 00524ab0 adds
    // velocity × quantum to the offset frame's origin before it rotates that
    // frame by omega × quantum, and UpdatePositionInternal's Frame::combine
    // @ 005122e0 turns that origin by m_position's (pre-update) rotation. So
    // a running turn moves along the heading it started the update with,
    // and the turn shows in the next update's step. Moving along the turned
    // heading put a run-turn on a tighter arc than retail's.
    //
    // A standing long jump's charge blocks only new forward / sidestep
    // motions (DoInterpretedMotion @ 00528360; CharacterAnimController plays
    // Ready): the sequence still moves the body, so a stop link that was
    // coasting when Space went down coasts on.
    const seq = this.sequenceStep?.(dt, this.interpretedMotion()) ?? null;
    if (seq) {
      const world = this.localToWorld(seq.x, seq.y, yawAtFrameStart);
      this.camera.position.add(this.scratchMove.set(world.x, 0, world.z));
    } else if (!this.standingLongJump) {
      const { side, forward: fwd } = this.motionVelocity();
      const world = this.localToWorld(side, fwd, yawAtFrameStart);
      this.camera.position.add(this.scratchMove.set(world.x * dt, 0, world.z * dt));
    }

    // Apply rotation via Euler: yaw around Y (total = player + camera offset), pitch around X
    this.camera.rotation.set(this.appliedViewPitch, this.yaw, 0, 'YXZ');
  }

  /**
   * The sequence's root velocity for the interpreted state (set by main.ts
   * from the player's motion table — RemoteMotion.sequenceRootVelocity);
   * null = unknown (no table yet), and stateVelocity stands in.
   */
  rootMotion: ((st: LocalInterpretedMotion) => { x: number; y: number } | null) | null = null;

  /**
   * CPhysicsObj::UpdatePositionInternal @ 00512c30 for the local player:
   * advance its sequence by `dt` (CPartArray::Update — the sequence's
   * velocity comes from the interpreted state `st`) and return the root
   * offset the sequence produced, player-local metres (x + right, y +
   * ahead), already scaled by the object's scale. Set by main.ts once the
   * player's motion table is loaded; null = not wired (motionVelocity moves
   * the body), a null result = no sequence this frame.
   */
  sequenceStep: ((dt: number, st: LocalInterpretedMotion) => { x: number; y: number } | null) | null = null;

  /**
   * The CommandList heads as the motion interpreter holds them
   * (CMotionInterp::adjust_motion @ 00528010 + apply_run_to_command
   * @ 00527be0): forward WalkForward at 1 / RunForward at the run rate,
   * backward WalkForward at −0.65 (× the run rate when running), a sidestep
   * SideStepRight at ±(walk_anim_speed / sidestep_anim_speed) × 0.5 (× the
   * run rate when running, clamped to 3).
   */
  interpretedMotion(): LocalInterpretedMotion {
    const running = this.isRunning;
    const st: LocalInterpretedMotion = { forward: MotionCommand.Ready, forwardSpeed: 1, sidestep: 0, sidestepSpeed: 1, turn: 0, turnSpeed: 1 };
    // standing_longjump: DoInterpretedMotion @ 00528360 takes no WalkForward /
    // RunForward / SideStepRight while it is set — the interpreted state holds Ready.
    if (this.standingLongJump) return st;
    if (this.isMovingForward) {
      const fwdRun = this.isForwardRunning;
      st.forward = fwdRun ? MotionCommand.RunForward : MotionCommand.WalkForward;
      st.forwardSpeed = fwdRun ? this.runRate : 1;
    } else if (this.isMovingBackward) {
      st.forward = MotionCommand.WalkForward;
      st.forwardSpeed = -BACKWARDS_FACTOR * (running ? this.runRate : 1);
    }
    if (this.isStrafingLeft || this.isStrafingRight) {
      let s = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED);
      if (running) s = Math.min(s * this.runRate, MAX_SIDESTEP_ANIM_RATE);
      st.sidestep = MotionCommand.SideStepRight;
      st.sidestepSpeed = this.isStrafingLeft ? -s : s;
    }
    if (this.isTurningLeft || this.isTurningRight) {
      st.turn = MotionCommand.TurnRight;
      st.turnSpeed = (this.isTurningLeft ? -1 : 1) * (running ? RUN_TURN_FACTOR : 1);
    }
    st.turnFirst = this.turnFirst;
    return st;
  }

  /**
   * How far the body moves per second (player-local: side + right, forward
   * + ahead). Retail moves the player by its sequence —
   * CPhysicsObj::UpdatePositionInternal @ 00512c30 takes CPartArray::Update's
   * root offset (the cycle's pos-frames + the motion velocities) every frame;
   * get_state_velocity is only the jump's leave-ground velocity. So a
   * peace-mode walk is the walk cycle's 2.6 m/s (not walk_anim_speed's
   * 3.12), a combat stance walks / strafes at its own cycles' slower pace,
   * and strafing while moving adds the SideStepRight modifier's velocity to
   * the forward motion with no cap (BUG.local-speed-from-state-velocity).
   */
  motionVelocity(): { side: number; forward: number } {
    const v = this.rootMotion?.(this.interpretedMotion());
    if (v) return { side: v.x, forward: v.y };
    return this.stateVelocity();
  }

  /**
   * CMotionInterp::get_state_velocity @ 00527d50 for the CommandList heads,
   * in the player's local frame (m/s): `side` = + right (SideStepRight ×
   * sidestep_anim_speed, left a negative speed), `forward` = + ahead
   * (WalkForward × walk_anim_speed or RunForward × run_anim_speed; Move
   * Backward is WalkForward at −BACKWARDS_FACTOR after adjust_motion). The
   * sum is capped at run_anim_speed × the run rate. Used by update() and as
   * the jump's leave-ground velocity (get_leave_ground_velocity @ 005280c0).
   */
  stateVelocity(): { side: number; forward: number } {
    const running = this.isRunning;
    let forward = 0;
    if (this.isMovingForward) {
      forward = this.isForwardRunning ? RUN_ANIM_SPEED * this.runRate : WALK_ANIM_SPEED;
    } else if (this.isMovingBackward) {
      forward = -WALK_ANIM_SPEED * BACKWARDS_FACTOR * (running ? this.runRate : 1.0);
    }
    let side = 0;
    if (this.isStrafingLeft || this.isStrafingRight) {
      let strafeRate = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED);
      if (running) {
        // FAITHFUL.597 — scale by the character's run rate per ACE
        // MotionInterp.cs:550-560 (speedMod, same scalar as forward run),
        // clamped to MaxSidestepAnimRate.
        strafeRate = Math.min(strafeRate * this.runRate, MAX_SIDESTEP_ANIM_RATE);
      }
      side = SIDESTEP_ANIM_SPEED * strafeRate * (this.isStrafingLeft ? -1 : 1);
    }
    const max = RUN_ANIM_SPEED * this.runRate;
    const len = Math.hypot(side, forward);
    if (len > max) {
      side *= max / len;
      forward *= max / len;
    }
    return { side, forward };
  }

  /**
   * A player-local velocity (side + right, forward + ahead) in the scene's
   * horizontal axes at the current facing: forward is (−sin yaw, −cos yaw),
   * right (CORE.18, the player's right in AC terms) is (−cos yaw, sin yaw).
   * `yaw` defaults to the current facing.
   */
  localToWorld(side: number, forward: number, yaw = this.playerYaw): { x: number; z: number } {
    return {
      x: -Math.sin(yaw) * forward - Math.cos(yaw) * side,
      z: -Math.cos(yaw) * forward + Math.sin(yaw) * side,
    };
  }

  /**
   * CORE.18.b — keep the 3rd-person boom inside what CameraSet::Raise /
   * Lower allow (never over the top of the pivot; never under the pivot
   * plane within CAMERA_MIN_CHAR_GROUNDDIST), then aim where
   * SetTargetForOffset points the camera: at the pivot, or level ahead
   * inside the [−0.5, 0.75] height band. In the head the pitch is the
   * mouse-look pitch directly. CORE.18.b.a.a — the aim is the TARGET frame's;
   * the rendered view eases to it at r_stiffness (RetailCameraRig), and a
   * Raise / Lower step re-applies the z <= −1.8 stiffness rule.
   */
  private updateViewPitch(): void {
    if (this.lookingDown) {
      this.appliedViewPitch = LOOK_DOWN_PITCH;
      return;
    }
    if (this.isFirstPerson) {
      this.appliedViewPitch = this.pitch;
      return;
    }
    const prevElevation = this.lastElevation;
    const maxElevation = Math.PI / 2 - 0.1;
    const minElevation = Math.max(minOrbitElevation(this.currentCameraDistance), -maxElevation);
    const e = Math.max(minElevation, Math.min(maxElevation, this.orbitElevation));
    this.pitch = DEFAULT_VIEWER_ELEVATION - e;
    this.lastElevation = e;
    if (e !== prevElevation) this.applyOffsetStiffness();
    this.appliedViewPitch = viewPitchForOffset(this.currentCameraDistance, e);
  }

  /**
   * SetTargetForOffset chose LOOK_AT_PIVOT for the current 3rd-person offset —
   * the mouse-look orbit included (CORE.18.b.a.a.a: an offset swung ≥ 1 m to
   * the side, or level with / ahead of the pivot, always looks at it).
   */
  get looksAtPivot(): boolean {
    if (this.inHead || this.lookingDown) return false;
    const { back, up } = this.thirdPersonBoom();
    return targetForOffset(back * Math.sin(this.cameraYawOffset), -back * Math.cos(this.cameraYawOffset), up, false).lookAtPivot;
  }

  /** Whether the player is currently pressing any movement/turn keys. */
  get isMoving(): boolean {
    return this.isMovingForward || this.isMovingBackward ||
           this.isTurningLeft || this.isTurningRight ||
           this.isStrafingLeft || this.isStrafingRight;
  }

  /**
   * The SubstateList head that moves the player: the most recent Move
   * Forward / Backward press still held, or the mouse-look left-button run
   * (which counts only while Use Mouse Turning's mouse-look is on).
   */
  private get substateHead(): string | null {
    if (this._controlledByServer || this.forwardStopped) return null;
    for (const entry of this.substateList) {
      if (entry !== MOUSE_FORWARD || this.mouseTurningLook) return entry;
    }
    return null;
  }

  /**
   * The SidestepList head, else — with Use Mouse Turning's mouse-look on —
   * the TurnList head run as a sidestep (MovePlayer's 0xc0000c1 remap /
   * ApplyHoldKeysToCommand: Turn Right / Left → Sidestep Right / Left).
   */
  private get sidestepHead(): 'KeyZ' | 'KeyC' | null {
    if (this._controlledByServer) return null;
    const head = this.sidestepList[0];
    if (head === 'KeyZ' || head === 'KeyC') return head;
    if (!this.mouseTurningLook) return null;
    const turn = this.turnList[0];
    return turn === 'KeyA' ? 'KeyZ' : turn === 'KeyD' ? 'KeyC' : null;
  }

  get isMovingForward(): boolean {
    // Arrow keys (and any rebound key) reach here as the canonical 'KeyW' via
    // CameraController.keyTranslator — see VISUAL.127 / KeybindRegistry.
    // CommandInterpreter::ApplyCurrentMovement @ 006b3430: autorun runs
    // forward whatever the SubstateList holds.
    if (this.autoRun) return true;
    const head = this.substateHead;
    return head === 'KeyW' || head === MOUSE_FORWARD;
  }

  get isMovingBackward(): boolean {
    return !this.autoRun && this.substateHead === 'KeyS';
  }

  get isTurningLeft(): boolean {
    if (this.mouseTurn) return this.mouseTurn.left;
    return (!this._controlledByServer && !this.mouseTurningLook && this.turnList[0] === 'KeyA') || this.headTurnRemaining < 0;
  }

  get isTurningRight(): boolean {
    if (this.mouseTurn) return !this.mouseTurn.left;
    return (!this._controlledByServer && !this.mouseTurningLook && this.turnList[0] === 'KeyD') || this.headTurnRemaining > 0;
  }

  /** The turn became active before the sidestep: it stays the substate, the sidestep a modifier. */
  get turnFirst(): boolean {
    return this.turnSince !== 0 && this.turnSince < this.sidestepSince && this.turnList.length > 0;
  }

  get isStrafingLeft(): boolean {
    return this.sidestepHead === 'KeyZ';
  }

  get isStrafingRight(): boolean {
    return this.sidestepHead === 'KeyC';
  }

  /**
   * Per ACE CharacterOption.RunAsDefaultMovement (default ON) — Shift
   * inverts the default. Auto-run always runs regardless of the toggle.
   * FAITHFUL.373 — Pre-fix this method was hard-coded to AC's default
   * even when the player opted out; the Options checkbox was decorative.
   */
  get isRunning(): boolean {
    const shiftHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    return this.runIsDefault ? !shiftHeld : shiftHeld;
  }

  /**
   * The forward command runs: autorun's forward carries HoldKey_Run itself
   * (ApplyCurrentMovement @ 006b3430: MovePlayer(WalkForward, …, hold_run 1));
   * a keyed forward / backward has no hold key of its own and takes the
   * current one (adjust_motion @ 00528010), as turns and sidesteps always do.
   */
  get isForwardRunning(): boolean {
    return this.autoRun || this.isRunning;
  }

  /**
   * The run toggle alone, without the hold-run key (Shift): auto-run, or
   * the RunAsDefaultMovement option. MovementSync sends a MoveToState when
   * this changes, not when Shift does (CommandInterpreter::SetHoldRun
   * @ 006b3370 sends nothing).
   */
  get runToggle(): boolean {
    return this.autoRun || this.runIsDefault;
  }

  /** Space bar held — jump charging. */
  get isJumpHeld(): boolean {
    return this.keys.has('Space');
  }

  /**
   * Get current position as a plain object.
   */
  get position(): { x: number; y: number; z: number } {
    return {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
  }

  /**
   * Set camera position directly.
   */
  setPosition(x: number, y: number, z: number): void {
    this.camera.position.set(x, y, z);
  }
}
