/**
 * Retail's teleport ("portal space") animation, ported from the decompiled
 * EoL client (reference/client-eol/decomp/acclient-decompiled.annotated.c).
 * Pure: no DOM, no three.js. PortalSpaceRenderer draws what this says, and
 * main.ts / GameUI drive it with the teleport's start and end.
 *
 * gmSmartBoxUI owns the state machine (TeleportAnimState):
 *   TAS_OFF 0 · TAS_WORLD_FADE_OUT 1 · TAS_TUNNEL_FADE_IN 2 · TAS_TUNNEL 3 ·
 *   TAS_TUNNEL_CONTINUE 4 · TAS_TUNNEL_FADE_OUT 5 · TAS_WORLD_FADE_IN 6
 *
 * - A server teleport (SmartBox::teleport_in_progress turning true) calls
 *   BeginTeleportAnimation(TAS_TUNNEL) @ 004d6300: straight into the tunnel,
 *   no world fade. A logoff instead begins TAS_WORLD_FADE_OUT (UseTime
 *   @ 004d6e30), which zooms the world out and fades the tunnel in.
 * - The teleport completing (teleport_in_progress false) calls
 *   EndTeleportAnimation @ 004d65a0: TAS_TUNNEL → TAS_TUNNEL_CONTINUE.
 * - CONTINUE lasts at least TELEPORT_ANIM_MIN_CONTINUE_TIME (2 s). It then
 *   waits for the tunnel animation to be 1.1–1.3 s from its end
 *   (0x78 = 120 frames at TELEPORT_ANIM_FPS 40), or at most
 *   TELEPORT_ANIM_MAX_CONTINUE_TIME (5 s), before TAS_TUNNEL_FADE_OUT.
 * - Every fade lasts TELEPORT_ANIM_FADE_TIME (1 s). A fade does not dim
 *   anything: it moves the view-plane distance (SmartBox::
 *   SetOverrideFovDistance) between the game's own and
 *   TRANSITION_VIEW_PLANE_DISTANCE (0.001), i.e. the field of view zooms
 *   out to nearly 180° and back, eased by UIGlobals::GetAnimLevel.
 * - While the tunnel shows, the camera rolls about its view axis toward a
 *   RandDouble(0, 360)° target over RandDouble(0.6, 1.8) s, eased the same
 *   way. Each new roll segment re-posts "In Portal Space - Please Wait..."
 *   to the spew box (DisplayStringInfo 0x1a).
 */

export enum TeleportAnimState {
  Off = 0,
  WorldFadeOut = 1,
  TunnelFadeIn = 2,
  Tunnel = 3,
  TunnelContinue = 4,
  TunnelFadeOut = 5,
  WorldFadeIn = 6,
}

/** TELEPORT_ANIM_FPS — the tunnel animation's frame rate. */
export const TELEPORT_ANIM_FPS = 40;
/** TELEPORT_ANIM_FADE_TIME (s). */
export const TELEPORT_ANIM_FADE_TIME = 1;
/** TELEPORT_ANIM_MIN_CONTINUE_TIME (s). */
export const TELEPORT_ANIM_MIN_CONTINUE_TIME = 2;
/** TELEPORT_ANIM_MAX_CONTINUE_TIME (s). */
export const TELEPORT_ANIM_MAX_CONTINUE_TIME = 5;
/** TRANSITION_VIEW_PLANE_DISTANCE — the fully zoomed-out view-plane distance. */
export const TRANSITION_VIEW_PLANE_DISTANCE = 0.001;
/** The CONTINUE release reads 0x78 − get_curr_frame_number (the animation's 120 frames). */
export const TELEPORT_ANIM_FRAMES = 0x78;
/** The spew notice each roll segment posts (a literal in UseTime). */
export const PORTAL_SPACE_NOTICE = 'In Portal Space - Please Wait...';

/**
 * UIGlobals::Init @ 004ee470: s_pLevelArray, 100 shorts. Each entry is
 * ftol(sin(i · 3.141592 · (1/99)) · 1024), then the running sum scaled to
 * 0..1024 by integer division: an eased S-curve. The constants are the
 * .rdata doubles at 0x7c3550 / 0x7c3548 / 0x7aac78; ftol truncates, and
 * idiv truncates toward zero.
 */
export const ANIM_LEVELS: readonly number[] = (() => {
  const raw: number[] = [];
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const v = Math.trunc(Math.sin(i * 3.141592 * 0.010101010101010102) * 1024);
    raw.push(v);
    total += v;
  }
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < 100; i++) {
    run += raw[i];
    out.push(Math.trunc((run * 1024) / total));
  }
  return out;
})();

/**
 * UIGlobals::GetAnimLevel @ 004ee540: clamp t to [0, 1] (0x794610 / 0x7928c0),
 * scale by −99.0 (0x7c3558), ftol, and read s_pLevelArray[−that] — the level
 * (0..1024) at index trunc(99·t). Callers scale by 2⁻¹⁰ (0x3f50000000000000).
 */
export function getAnimLevel(t: number): number {
  const c = !(t >= 0) ? 0 : t > 1 ? 1 : t;
  return ANIM_LEVELS[Math.trunc(c * 99)];
}

/** GetAnimLevel as a 0..1 fraction (the callers' × 2⁻¹⁰). */
export function animFraction(t: number): number {
  return getAnimLevel(t) / 1024;
}

/**
 * The field-of-view scale a view-plane distance override gives:
 * Render::SetFOVInternal keeps vdist = ty / tan(fov/2), so at distance v the
 * half-angle's tangent is tan(fov₀/2) · g / v, where g is the game's own
 * distance. Returns the vertical FOV (degrees) for base `fovDeg` at ratio
 * g / v, capped below 180 (three.js cannot project 180°).
 */
export function fovForViewDistanceRatio(fovDeg: number, ratio: number): number {
  const half = Math.atan(Math.tan((fovDeg * Math.PI) / 360) * ratio);
  return Math.min(179, (half * 360) / Math.PI);
}

/** What the renderer and HUD should show at one moment. */
export interface TeleportAnimFrame {
  state: TeleportAnimState;
  /** m_pPortalSpace visible (the tunnel viewport); the SmartBox (world) is hidden while it is. */
  tunnelVisible: boolean;
  /** g / v while a fade overrides the view distance (1 = the game's own), else null. */
  viewDistanceRatio: number | null;
  /** teleportRotationCurAngle (degrees) — the roll about the view axis. */
  rollDeg: number;
  /** True on the frame a new roll segment begins (post the spew notice). */
  postNotice: boolean;
  /** True on the frame the tunnel appears (restart the animation at frame 0). */
  tunnelShown: boolean;
  /** True on the frame the tunnel is torn down (SmartBox::Show; play Sound_UI_ExitPortal). */
  tunnelHidden: boolean;
  /** True on the frame the animation returns to TAS_OFF (SendLoginCompleteNotification). */
  finished: boolean;
}

/**
 * gmSmartBoxUI's teleport animation. `begin` / `end` are the teleport's edges;
 * `update(now, animFrame)` is one UseTime pass (seconds; the tunnel
 * animation's current frame number).
 */
export class TeleportAnimation {
  state = TeleportAnimState.Off;
  private transitionStart = 0;
  private gameVDist = 1;
  private curVDist = 1;
  private rotStart = 0;
  private rotDuration = 0;
  private rotStartAngle = 0;
  private rotEndAngle = 0;
  private rotCurAngle = 0;
  private tunnelShowing = false;

  constructor(private readonly rand: () => number = Math.random) {}

  /** RandDouble(lo, hi). */
  private randDouble(lo: number, hi: number): number {
    return lo + this.rand() * (hi - lo);
  }

  /**
   * BeginTeleportAnimation @ 004d6300. From TAS_OFF the game's own view
   * distance is captured (GetOverrideFovDistance; our ratio base is 1). The
   * roll timer resets to 0, so the first UseTime starts a new segment.
   * (Sound_UI_EnterPortal plays here — the caller's job.)
   */
  begin(state: TeleportAnimState.Tunnel | TeleportAnimState.WorldFadeOut, now: number): void {
    if (this.state === TeleportAnimState.Off) this.gameVDist = 1;
    this.curVDist = this.gameVDist;
    this.rotStart = 0;
    this.rotDuration = 0;
    this.rotStartAngle = 0;
    this.rotEndAngle = 0;
    this.state = state;
    this.transitionStart = now;
  }

  /** EndTeleportAnimation @ 004d65a0: any running animation → TAS_TUNNEL_CONTINUE. */
  end(now: number): void {
    if (this.state === TeleportAnimState.Off) return;
    this.state = TeleportAnimState.TunnelContinue;
    this.transitionStart = now;
    this.curVDist = this.gameVDist; // SetOverrideFovDistance(false, 0)
  }

  /** One gmSmartBoxUI::UseTime pass. */
  update(now: number, animFrame: number): TeleportAnimFrame {
    const out: TeleportAnimFrame = {
      state: this.state, tunnelVisible: this.tunnelShowing, viewDistanceRatio: null,
      rollDeg: this.rotCurAngle, postNotice: false, tunnelShown: false, tunnelHidden: false, finished: false,
    };
    const S = TeleportAnimState;
    if (this.state === S.Off) return out;

    let override: number | null = null;
    const s0 = this.state;
    if (s0 === S.TunnelFadeIn || s0 === S.Tunnel || s0 === S.TunnelContinue || s0 === S.TunnelFadeOut) {
      if (!this.tunnelShowing) {
        this.tunnelShowing = true;
        out.tunnelShown = true;
      }
      // Ghidra's `(d < now) == (d == now)` is true only for d > now.
      if (this.rotDuration + this.rotStart > now) {
        const lvl = getAnimLevel((now - this.rotStart) / this.rotDuration);
        this.rotCurAngle = (this.rotEndAngle - this.rotStartAngle) * lvl * (1 / 1024) + this.rotStartAngle;
      } else {
        this.rotCurAngle = this.rotEndAngle;
        this.rotStart = now;
        this.rotDuration = this.randDouble(0.6, 1.8);
        this.rotStartAngle = this.rotCurAngle;
        this.rotEndAngle = this.randDouble(0, 360);
        out.postNotice = true;
      }
    }
    const fadeT = Math.min(1, (now - this.transitionStart) / TELEPORT_ANIM_FADE_TIME);
    if (this.state === S.WorldFadeOut || this.state === S.TunnelFadeOut) {
      this.curVDist = (TRANSITION_VIEW_PLANE_DISTANCE - this.gameVDist) * getAnimLevel(fadeT) * (1 / 1024) + this.gameVDist;
      override = this.curVDist;
    }
    if (this.state === S.TunnelFadeIn || this.state === S.WorldFadeIn) {
      this.curVDist = (this.gameVDist - TRANSITION_VIEW_PLANE_DISTANCE) * getAnimLevel(fadeT) * (1 / 1024) + TRANSITION_VIEW_PLANE_DISTANCE;
      override = this.curVDist;
    }
    if (this.state === S.TunnelContinue && now - this.transitionStart >= TELEPORT_ANIM_MIN_CONTINUE_TIME) {
      const remaining = (TELEPORT_ANIM_FRAMES - animFrame) / TELEPORT_ANIM_FPS;
      if (now - this.transitionStart >= TELEPORT_ANIM_MAX_CONTINUE_TIME
        || (TELEPORT_ANIM_FADE_TIME + 0.1 < remaining && remaining < TELEPORT_ANIM_FADE_TIME + 0.3)) {
        this.state = S.TunnelFadeOut;
        this.transitionStart = now;
      }
    }
    if (this.state === S.WorldFadeOut && now - this.transitionStart >= TELEPORT_ANIM_FADE_TIME) {
      this.state = S.TunnelFadeIn;
      this.transitionStart = now;
    }
    if (this.state === S.TunnelFadeIn && now - this.transitionStart >= TELEPORT_ANIM_FADE_TIME) {
      this.state = S.Tunnel;
      this.transitionStart = now;
    }
    if (this.state === S.TunnelFadeOut && now - this.transitionStart >= TELEPORT_ANIM_FADE_TIME) {
      // SetOverrideFovDistance(true, teleportCurVDist); hide the tunnel; SmartBox::Show.
      override = this.curVDist;
      this.tunnelShowing = false;
      out.tunnelHidden = true;
      this.state = S.WorldFadeIn;
      this.transitionStart = now;
    }
    if (this.state === S.WorldFadeIn && now - this.transitionStart >= TELEPORT_ANIM_FADE_TIME) {
      this.transitionStart = now - TELEPORT_ANIM_FADE_TIME;
      this.state = S.Off;
      override = null;
      out.finished = true;
    }
    out.state = this.state;
    out.tunnelVisible = this.tunnelShowing;
    out.rollDeg = this.rotCurAngle;
    out.viewDistanceRatio = override === null ? null : this.gameVDist / override;
    return out;
  }
}
