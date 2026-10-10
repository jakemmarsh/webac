/**
 * CORE.17.k.b.b.a.e — the chargen appearance page's 3D view (0x100003bb):
 * gmCGAppearancePage's camera / heading / zoom / rotation machine and the
 * gmCG3DView lighting, as the decompiled EoL client runs them
 * (reference/client-eol — docs/retail-client-symbols.md, CORE.17.k.b.b.a.e).
 *
 * Ground truth:
 *  - `gmCGAppearancePage::InitializePage @ 0047fdd0`: binds 0x10000325 zoom
 *    in / 0x10000326 zoom out / 0x10000323 rotate clockwise / 0x10000324
 *    rotate counter-clockwise (GetChildRecursive — they live in the
 *    0x2100004c template root 0x10000322 the page's 0x100003bc instantiates),
 *    the viewport 0x100003bb (type 13 → gmCG3DView); m_fCurHeading = 180 →
 *    SetPlayerHeading(180); direction (0, 0, 0); the FACE camera per
 *    heritage (below) as both m_vectTargPosition and m_vectCurPosition;
 *    m_bZoomedIn = false.
 *  - `Update @ 0047e8f0`: on every (re)entry / gender change the camera is
 *    put back on the face position (all three heritage branches), then
 *    StartAnimation while !m_bZoomedIn, StopAnimation otherwise.
 *  - `ZoomIn @ 0047cf00`: !m_bZoomedIn → start = current, target = the
 *    face camera, m_dAnimDuration = −0.1 (the restart sentinel), zoom-in
 *    button state 6 / zoom-out state 1, StopAnimation, m_bZoomedIn = true;
 *    already zoomed → zoom-in state 6 only. `ZoomOut @ 0047d050` mirrors it
 *    with the full-body camera (gmCGSummaryPage's), StartAnimation.
 *  - `DoZoomAnimation @ 0047c960` (global message 3 = the UI tick while
 *    m_bShouldZoomAnimate): a negative duration → 0.6 s from now; a linear
 *    lerp of position AND direction from start to target, done at t ≥ 0.6.
 *  - `Rotate @ 0047cb50`: rotating in the same direction → stop; else the
 *    OTHER rotate button goes to state 1, m_dLastRotateTime = −1, rotating.
 *    `DoRotation @ 0047ca80` per tick: heading ± (dt / m_dRotationPerSec) ·
 *    360 (clockwise adds), one wrap into [0, 360]; m_dRotationPerSec = 3.0
 *    (ctor @ 0047ccc0: 0x4008000000000000) — a full turn every 3 s.
 *  - `UIElement_Button::MouseUp @ 004720e0`: a p11 (toggle) button flips
 *    its p14 on release; `UpdateState_ @ 00471cf0`: state = (p14 ? 6 : 1)
 *    + 1 while the mouse is over it (p19), + 2 while pressed; `SetState @
 *    00471da0`: 6 sets p14, 1 clears it. The template gives media for
 *    states 1 / 2 / 6 / 7 only (a pressed 3 / 8 has no StateDesc, so the
 *    hover face stays up while the mouse is down).
 *  - `gmCG3DView::Update @ 004ee9d0`: `UIElement_Viewport::SetLight(
 *    DISTANT_LIGHT, 2.0, (0.3, 1.9, 0.65))` — `LIGHTINFO::SetDirection @
 *    00452700` normalises it into the light frame's heading and
 *    `PrimD3DRender::config_hardware_light @ 0059ad30` hands it to D3D as
 *    the DIRECTIONAL light's Direction (the way the light travels; AC
 *    (x, y, z) → D3D (x, z, y)), Diffuse = white × 2.0. `CreatureMode`'s
 *    ctor @ 00454390: m_clrAmbientLight (0.3, 0.3, 0.3), m_fFOVRadians π/4
 *    (a vertical FOV: `Render::SetFOVInternal` derives vdst from the half
 *    height); the chargen views never call UseSmartboxFOV.
 *  - Camera positions (AC axes: x right, y forward, z up; the camera looks
 *    along +y with direction (0, 0, 0), the model at the origin faces −y at
 *    heading 180): face = (0, −0.55, 1.65), Aun Tumerok (7) (0, −0.85, 1.65),
 *    Olthoi (12) (0, −1.85, 1.85), Olthoi Acid (13) (0, −3.05, 2.75); full
 *    body = (0, −2.5, 0.95) / (0, −3.8, 1.15) / (0, −5.7, 1.65) — the same
 *    per-heritage table gmCGSummaryPage::Update uses.
 *
 * Nothing here touches the DOM or three.js: GameUI maps the AC vectors
 * onto its scene (`acToThree`) and drives the machine from its own ticks.
 */
import { summaryViewCamera } from './ChargenSummary.js';
import type { AcVec3 } from './CreatureViewCamera.js';

// CORE.18.f — the view's AC → three mapping, heading → yaw, FOV and light
// placement are the shared CreatureMode convention (CreatureViewCamera.ts):
// the world's (x, z, y) reflection drawn through a mirrored camera.
export type { AcVec3 } from './CreatureViewCamera.js';
export {
  CREATURE_MODE_FOV_RADIANS, CREATURE_MODE_FOV_DEGREES, acToThree, headingToModelYaw, distantLightPosition,
} from './CreatureViewCamera.js';

/** The appearance page layout and its viewport / button-group elements. */
export const APPEARANCE_LAYOUT = 0x21000049;
export const APPEARANCE_VIEWPORT_ELEMENT = 0x100003bb;
export const APPEARANCE_PAGE_ROOT = 0x100003a6;
/** The chargen pages sit 55 px below the layout origin (the 0x21000045 tab strip): layout y − 55 = content y. */
export const CHARGEN_PAGE_Y_OFFSET = 55;
/** The page's instance of the template root — (560, 467) 182x97 in layout coordinates (page y offset 55 → content (560, 412)). */
export const APPEARANCE_VIEW_GROUP_ELEMENT = 0x100003bc;
export const APPEARANCE_VIEW_GROUP_RECT = { x: 560, y: 467, width: 182, height: 97 } as const;
/** The chargen template layout and the root holding the four buttons. */
export const CHARGEN_TEMPLATE_LAYOUT = 0x2100004c;
export const APPEARANCE_VIEW_TEMPLATE_ROOT = 0x10000322;

export type ViewButtonKey = 'rotateClockwise' | 'rotateCounterClockwise' | 'zoomIn' | 'zoomOut';

export interface ViewButtonSpec {
  readonly elementId: number;
  /** Offset inside the 182x97 group. */
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  /** State media (0x06 textures): 1 normal, 2 hover, 6 lit (p14), 7 lit + hover. */
  readonly media: Readonly<Record<1 | 2 | 6 | 7, number>>;
  /** p73 tooltip string id (table 0x23000002). */
  readonly tooltipStringId: number;
}

/** 0x2100004c:0x10000322's children, in the page's binding order. */
export const APPEARANCE_VIEW_BUTTONS: Readonly<Record<ViewButtonKey, ViewButtonSpec>> = {
  rotateClockwise: {
    elementId: 0x10000323, x: 0, y: 0, width: 60, height: 54,
    media: { 1: 0x06004d51, 2: 0x06004d52, 6: 0x06005da7, 7: 0x06005da7 }, tooltipStringId: 114607413,
  },
  rotateCounterClockwise: {
    elementId: 0x10000324, x: 122, y: 0, width: 60, height: 54,
    media: { 1: 0x06004d53, 2: 0x06004d54, 6: 0x06005da8, 7: 0x06005da8 }, tooltipStringId: 90764629,
  },
  zoomIn: {
    elementId: 0x10000325, x: 53, y: 18, width: 81, height: 38,
    media: { 1: 0x06004d55, 2: 0x06005da3, 6: 0x06004d56, 7: 0x06004d56 }, tooltipStringId: 5889070,
  },
  zoomOut: {
    elementId: 0x10000326, x: 53, y: 55, width: 81, height: 43,
    media: { 1: 0x06004d57, 2: 0x06005da4, 6: 0x06004d58, 7: 0x06004d58 }, tooltipStringId: 94231492,
  },
};

/** Every state media the four buttons can show (preload list). */
export const APPEARANCE_VIEW_BUTTON_MEDIA: readonly number[] = Array.from(new Set(
  (Object.values(APPEARANCE_VIEW_BUTTONS) as ViewButtonSpec[]).flatMap((b) => Object.values(b.media)),
));

/** `CreatureMode::m_clrAmbientLight` = (0.3, 0.3, 0.3). */
export const CREATURE_MODE_AMBIENT = 0.3;
/** `UIElement_Viewport::SetLight(DISTANT_LIGHT, 2.0, (0.3, 1.9, 0.65))` — the direction the light travels, AC axes. */
export const CHARGEN_VIEW_LIGHT_INTENSITY = 2.0;
export const CHARGEN_VIEW_LIGHT_DIRECTION: AcVec3 = [0.3, 1.9, 0.65];

/** `InitializePage`: m_fCurHeading = 180 — the model faces the camera. */
export const APPEARANCE_INITIAL_HEADING = 180;
/** `m_dRotationPerSec` = 3.0: seconds per full turn (DoRotation: dt / 3 · 360°). */
export const APPEARANCE_ROTATION_PERIOD_SECONDS = 3.0;
/** `DoZoomAnimation`: the duration it sets when the sentinel is negative. */
export const APPEARANCE_ZOOM_SECONDS = 0.6;
/** `ZoomIn` / `ZoomOut` set m_dAnimDuration to this so the next tick restarts the lerp. */
export const APPEARANCE_ZOOM_RESTART_SENTINEL = -0.1;

/** The face camera (`InitializePage` / `Update` / `ZoomIn`). */
export function appearanceZoomedInCamera(heritage: number): AcVec3 {
  if (heritage === 12) return [0, -1.85, 1.85];
  if (heritage === 13) return [0, -3.05, 2.75];
  if (heritage === 7) return [0, -0.85, 1.65];
  return [0, -0.55, 1.65];
}

/** The full-body camera (`ZoomOut`) — gmCGSummaryPage::Update's table. */
export function appearanceZoomedOutCamera(heritage: number): AcVec3 {
  const cam = summaryViewCamera(heritage);
  return [0, cam.y, cam.z];
}

/** `UIElement_Button::UpdateState_`: (p14 ? 6 : 1) + 1 while hovered (p19). */
export function viewButtonStateId(lit: boolean, hover: boolean): 1 | 2 | 6 | 7 {
  return lit ? (hover ? 7 : 6) : (hover ? 2 : 1);
}

export type RotateDirection = 'clockwise' | 'counterClockwise';

export interface ViewButtonsLit {
  rotateClockwise: boolean;
  rotateCounterClockwise: boolean;
  zoomIn: boolean;
  zoomOut: boolean;
}

/**
 * gmCGAppearancePage's view state. Times are seconds (Timer::cur_time);
 * `tick` is the global message 3 handler (`ListenToGlobalMessage @
 * 0047ced0`: DoZoomAnimation while m_bShouldZoomAnimate, DoRotation while
 * m_bRotating).
 */
export class AppearanceViewController {
  /** m_fCurHeading (degrees). */
  heading = APPEARANCE_INITIAL_HEADING;
  /** m_bRotating / m_eRotateDir / m_dLastRotateTime. */
  rotating = false;
  rotateDirection: RotateDirection | null = null;
  private lastRotateTime = -1;
  /** m_bZoomedIn. */
  zoomedIn = false;
  /** m_bShouldZoomAnimate / m_dAnimDuration / m_dAnimStartTime. */
  animating = false;
  private animDuration = 0;
  private animStartTime = 0;
  /** m_vectStartPosition / m_vectTargPosition / m_vectCurPosition (AC axes). */
  private startPosition: AcVec3 = [0, 0, 0];
  targetPosition: AcVec3 = [0, 0, 0];
  currentPosition: AcVec3 = [0, 0, 0];
  /** m_vectStart/Targ/CurDirection — always (0, 0, 0) on this page, lerped all the same. */
  private startDirection: AcVec3 = [0, 0, 0];
  targetDirection: AcVec3 = [0, 0, 0];
  currentDirection: AcVec3 = [0, 0, 0];
  /** The four buttons' p14 (state 6 when set). */
  readonly lit: ViewButtonsLit = { rotateClockwise: false, rotateCounterClockwise: false, zoomIn: false, zoomOut: false };
  /** gmCG3DView StartAnimation (true) / StopAnimation (false) — the idle animation the view plays. */
  idleAnimation = false;
  /**
   * CORE.17.k.b.b.a.e.a — bumped on every Start / StopAnimation call the
   * page makes (Update, ZoomIn, ZoomOut): each one clears the object's
   * sequence and restarts the animation from frame 0, so the view's
   * animator restarts when this changes and keeps its clock otherwise
   * (gmCG3DView::Update alone — a colour / style change — leaves the
   * running sequence alone).
   */
  animationEpoch = 0;

  /** `InitializePage`: heading 180, the face camera, not zoomed in; then `Update`. */
  initializePage(heritage: number): void {
    this.heading = APPEARANCE_INITIAL_HEADING;
    this.rotating = false;
    this.rotateDirection = null;
    this.lastRotateTime = -1;
    this.animating = false;
    this.animDuration = 0;
    this.currentDirection = [0, 0, 0];
    this.targetDirection = [0, 0, 0];
    this.zoomedIn = false;
    this.lit.rotateClockwise = false; this.lit.rotateCounterClockwise = false;
    this.lit.zoomIn = false; this.lit.zoomOut = false;
    this.update(heritage);
  }

  /** `Update`: the camera back on the face; the idle animation follows m_bZoomedIn. */
  update(heritage: number): void {
    const cam = appearanceZoomedInCamera(heritage);
    this.targetPosition = cam;
    this.currentPosition = cam;
    this.idleAnimation = !this.zoomedIn;
    this.animationEpoch++;
  }

  /** A release on 0x10000323 (message 1): the toggle flip, then `Rotate(ECG_ROTATE_CLOCKWISE)`. */
  clickRotateClockwise(): void {
    this.lit.rotateClockwise = !this.lit.rotateClockwise;
    this.rotate('clockwise');
  }

  /** A release on 0x10000324: the toggle flip, then `Rotate(ECG_ROTATE_COUNTERCLOCKWISE)`. */
  clickRotateCounterClockwise(): void {
    this.lit.rotateCounterClockwise = !this.lit.rotateCounterClockwise;
    this.rotate('counterClockwise');
  }

  /** `Rotate @ 0047cb50`. */
  rotate(direction: RotateDirection): void {
    if (this.rotating && direction === this.rotateDirection) {
      this.rotating = false;
      return;
    }
    if (direction === 'clockwise') this.lit.rotateCounterClockwise = false;
    else this.lit.rotateClockwise = false;
    this.rotateDirection = direction;
    this.lastRotateTime = -1;
    this.rotating = true;
  }

  /** A release on 0x10000325: the toggle flip, then `ZoomIn`. */
  clickZoomIn(heritage: number): void {
    this.lit.zoomIn = !this.lit.zoomIn;
    this.zoomIn(heritage);
  }

  /** A release on 0x10000326: the toggle flip, then `ZoomOut`. */
  clickZoomOut(heritage: number): void {
    this.lit.zoomOut = !this.lit.zoomOut;
    this.zoomOut(heritage);
  }

  /** `ZoomIn @ 0047cf00`. */
  zoomIn(heritage: number): void {
    if (!this.zoomedIn) {
      this.beginZoom(appearanceZoomedInCamera(heritage));
      this.lit.zoomIn = true;
      this.lit.zoomOut = false;
      this.idleAnimation = false;
      this.animationEpoch++;
      this.zoomedIn = true;
      return;
    }
    this.lit.zoomIn = true;
  }

  /** `ZoomOut @ 0047d050`. */
  zoomOut(heritage: number): void {
    if (this.zoomedIn) {
      this.beginZoom(appearanceZoomedOutCamera(heritage));
      this.lit.zoomIn = false;
      this.lit.zoomOut = true;
      this.idleAnimation = true;
      this.animationEpoch++;
      this.zoomedIn = false;
      return;
    }
    this.lit.zoomOut = true;
  }

  private beginZoom(target: AcVec3): void {
    this.startDirection = this.currentDirection;
    this.startPosition = this.currentPosition;
    this.targetPosition = target;
    this.targetDirection = [0, 0, 0];
    this.animating = true;
    this.animDuration = APPEARANCE_ZOOM_RESTART_SENTINEL;
  }

  /** Something still moves: keep ticking. */
  get active(): boolean {
    return this.animating || this.rotating;
  }

  /**
   * `ListenToGlobalMessage(3)`: DoZoomAnimation then DoRotation. Returns
   * true when the camera or the heading changed.
   */
  tick(nowSeconds: number): boolean {
    let changed = false;
    if (this.animating) {
      this.doZoomAnimation(nowSeconds);
      changed = true;
    }
    if (this.rotating) {
      changed = this.doRotation(nowSeconds) || changed;
    }
    return changed;
  }

  /** `DoZoomAnimation @ 0047c960`. */
  private doZoomAnimation(now: number): void {
    if (this.animDuration < 0) {
      this.animDuration = APPEARANCE_ZOOM_SECONDS;
      this.animStartTime = now;
    }
    let elapsed = now - this.animStartTime;
    if (elapsed >= this.animDuration) {
      this.animating = false;
      elapsed = this.animDuration;
    }
    const f = elapsed / this.animDuration;
    const lerp = (a: AcVec3, b: AcVec3): AcVec3 => [
      (b[0] - a[0]) * f + a[0], (b[1] - a[1]) * f + a[1], (b[2] - a[2]) * f + a[2],
    ];
    this.currentPosition = lerp(this.startPosition, this.targetPosition);
    this.currentDirection = lerp(this.startDirection, this.targetDirection);
  }

  /** `DoRotation @ 0047ca80`. */
  private doRotation(now: number): boolean {
    if (this.lastRotateTime < 0) this.lastRotateTime = now;
    const step = ((now - this.lastRotateTime) / APPEARANCE_ROTATION_PERIOD_SECONDS) * 360;
    const before = this.heading;
    this.heading = this.rotateDirection === 'clockwise' ? this.heading + step : this.heading - step;
    if (this.heading < 0) this.heading += 360;
    if (this.heading > 360) this.heading -= 360;
    this.lastRotateTime = now;
    return this.heading !== before;
  }
}
