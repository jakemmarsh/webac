/**
 * VividTargetIndicator — retail's selection triangles: four small corner
 * wedges framing the selected object in the 3D view, or one edge arrow
 * pointing at it when it is off screen.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.annotated.c):
 *   VividTargetIndicator::VividTargetIndicator @ 004f6ae0 — the 12 source
 *     images: DBObj::GetByEnum(1..12, 0x10000009, 0xc). master[0x10000009] =
 *     DidMapper 0x2500000d: 1 Onscreen_NW 0x06004c40, 2 _NE, 3 _SW, 4 _SE,
 *     5 Offscreen_NW, 6 _N, 7 _NE, 8 _W, 9 _E, 10 _SW, 11 _S, 12 _SE (…4b).
 *   VividTargetIndicator::Initialized @ 004f6c60 — gmSmartBoxUI (layout
 *     0x2100000f) children: on-screen group 0x10000038 (corners 0x10000039 NW,
 *     0x1000003a NE, 0x1000003b SW, 0x1000003c SE — 12x12, anchored to the
 *     group's corners) and the off-screen arrow 0x10000045 (24x24).
 *   VividTargetIndicator::SetSelected @ 004f5ce0 — the player itself, objects
 *     the player owns and objects inside a container show nothing; the colour
 *     is gmRadarUI::GetBlipColor of the selection.
 *   VividTargetIndicator::CopyImage @ 004f5dd0 — s_BlitMethod (.data 0x81c630
 *     = 4): BlitAndColor(Blit_Normal, Blit_Colorize, colour).
 *   VividTargetIndicator::OnDraw @ 004f62b0 — the placement below (objdump
 *     4f69b7–4f6ab5 for the on-screen clamps the decompiler dropped).
 *   SmartBox::GetObjectBoundingBox @ 00452e20 — the selection sphere
 *     (CPartArray::GetSelectionSphere @ 00518b80: setup sphere × part scale)
 *     through Render::GetViewerBBox @ 0054b400 (centre ∓ right·r ± up·r at
 *     the centre's depth) → on-screen rect, else the off-screen angle
 *     (objdump 452fdc–453045: fmod(450 − atan2(z, x)·57.29578, 360), with
 *     atan2(0, x) when the object is at or behind the viewer, y ≤ 0).
 *   The player option VividTargetingIndicator (0x0E) gates the display.
 */

import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/** DBObj::GetByEnum's master enum for the twelve indicator images. */
export const VTI_MASTER_ENUM = 0x10000009;

/**
 * The twelve image DIDs (index = EnumMapper row, [0] unused), through the DAT
 * header's master map → master[0x10000009]. Null when either map is missing.
 */
export function loadVtiImageDids(
  db: { getFileData(id: number): ArrayBuffer | null | undefined },
  masterMapId: number,
): number[] | null {
  const read = (id: number | undefined) => {
    if (!id) return null;
    try {
      const data = db.getFileData(id);
      return data ? readDidMapper(new DatReader(data)) : null;
    } catch {
      return null;
    }
  };
  const map = read(read(masterMapId)?.client.enumToId.get(VTI_MASTER_ENUM));
  if (!map) return null;
  const dids: number[] = [0];
  for (let row = 1; row <= 12; row++) dids.push(map.client.enumToId.get(row) ?? 0);
  return dids;
}

/** The EnumMapper rows (DidMapper 0x2500000d). */
export const VtiImage = {
  OnscreenNW: 1, OnscreenNE: 2, OnscreenSW: 3, OnscreenSE: 4,
  OffscreenNW: 5, OffscreenN: 6, OffscreenNE: 7, OffscreenW: 8,
  OffscreenE: 9, OffscreenSW: 10, OffscreenS: 11, OffscreenSE: 12,
} as const;

/** `min_dist` (.data, = 8): the gap kept to every viewport edge. */
export const VTI_MIN_DIST = 8;

/** Layout 0x2100000f: the 12x12 corner elements 0x10000039..0x1000003c. */
export const VTI_CORNER_SIZE = 12;
/** Layout 0x2100000f: the 24x24 off-screen element 0x10000045. */
export const VTI_OFFSCREEN_SIZE = 24;

export interface ScreenRect { left: number; top: number; right: number; bottom: number }
export interface Placement { x: number; y: number; w: number; h: number }

/**
 * OnDraw's ObjectOnscreen branch: the group 0x10000038 spans the rect grown
 * by one corner on every side, kept `min_dist` inside the viewport.
 */
export function onScreenPlacement(
  rect: ScreenRect, vw: number, vh: number,
  cw: number = VTI_CORNER_SIZE, ch: number = VTI_CORNER_SIZE,
): Placement {
  const maxRight = vw - cw - VTI_MIN_DIST;
  const maxBottom = vh - ch - VTI_MIN_DIST;
  let x0 = rect.left - cw;
  let y0 = rect.top - ch;
  let right = rect.right;
  let bottom = rect.bottom;
  if (x0 > right) x0 = right - 1;
  if (y0 > bottom) y0 = bottom - 1;
  if (x0 < VTI_MIN_DIST) x0 = VTI_MIN_DIST;
  if (y0 < VTI_MIN_DIST) y0 = VTI_MIN_DIST;
  if (right < cw + VTI_MIN_DIST) right = cw + VTI_MIN_DIST;
  if (bottom < ch + VTI_MIN_DIST) bottom = ch + VTI_MIN_DIST;
  if (x0 > maxRight - cw) x0 = maxRight - cw;
  if (y0 > maxBottom - ch) y0 = maxBottom - ch;
  if (right > maxRight) right = maxRight;
  if (bottom > maxBottom) bottom = maxBottom;
  return { x: x0, y: y0, w: right - x0 + cw, h: bottom - y0 + ch };
}

/**
 * GetObjectBoundingBox's off-screen heading, in degrees clockwise from
 * screen-up, from the selection centre in viewer space (x right, y forward,
 * z up). A vector too small to normalise reads 0.
 */
export function offscreenAngleDeg(x: number, y: number, z: number): number {
  const len = Math.hypot(x, y, z);
  if (len < 0.0002) return 0;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;
  const rad = ny <= 0 ? Math.atan2(0, nx) : Math.atan2(nz, nx);
  const deg = 450 - rad * 57.29577951308232;
  return ((deg % 360) + 360) % 360;
}

/** OnDraw's angle bands → the off-screen image row (0 when none applies). */
export function offscreenImageForAngle(deg: number): number {
  if (deg >= 338 || deg < 23) return VtiImage.OffscreenN;
  if (deg < 68) return VtiImage.OffscreenNE;
  if (deg < 113) return VtiImage.OffscreenE;
  if (deg < 158) return VtiImage.OffscreenSE;
  if (deg < 203) return VtiImage.OffscreenS;
  if (deg < 248) return VtiImage.OffscreenSW;
  if (deg < 293) return VtiImage.OffscreenW;
  return VtiImage.OffscreenNW;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const RAD = 0.017453292;

/**
 * OnDraw's ObjectOffscreen placement: the arrow rides the viewport edge the
 * heading crosses (45° octants, tan-projected from the centre), clamped
 * `min_dist` inside. Returns the element's top-left.
 */
export function offscreenPosition(deg: number, vw: number, vh: number, w: number, h: number): { x: number; y: number } {
  const m = VTI_MIN_DIST;
  let x: number;
  let y: number;
  if (!(deg > 45)) {
    x = vw * 0.5 + vh * 0.5 * Math.tan(RAD * deg) - w * 0.5;
    y = m;
  } else if (deg <= 90) {
    x = vw - m - w;
    y = vh * 0.5 - vw * 0.5 * Math.tan((90 - deg) * RAD) - h * 0.5;
  } else if (deg <= 135) {
    x = vw - m - w;
    y = vh * 0.5 + vw * 0.5 * Math.tan((deg - 90) * RAD) - h * 0.5;
  } else if (deg <= 180) {
    x = vw * 0.5 + vh * 0.5 * Math.tan((180 - deg) * RAD) - w * 0.5;
    y = vh - m - h;
  } else if (deg <= 225) {
    x = vw * 0.5 - vh * 0.5 * Math.tan((deg - 180) * RAD) - w * 0.5;
    y = vh - m - h;
  } else if (deg <= 270) {
    x = m;
    y = vh * 0.5 + vw * 0.5 * Math.tan((270 - deg) * RAD) - h * 0.5;
  } else if (deg <= 315) {
    x = m;
    y = vh * 0.5 - vw * 0.5 * Math.tan((deg - 270) * RAD) - h * 0.5;
  } else {
    x = vw * 0.5 - vh * 0.5 * Math.tan((360 - deg) * RAD) - w * 0.5;
    y = m;
  }
  return {
    x: Math.trunc(clamp(x, m, vw - m - w)),
    y: Math.trunc(clamp(y, m, vh - m - h)),
  };
}

export interface RgbaImage { width: number; height: number; data: Uint8Array }
export interface Rgba01 { r: number; g: number; b: number; a: number }

/**
 * BlitOp_Colorize (ColoringLoopNoScale @ 006653a0, full-strength branch):
 * each pixel keeps its own value (max channel) and alpha, and takes the
 * colour's hue and saturation.
 */
export function colorizeRGBA(img: RgbaImage, color: Rgba01): RgbaImage {
  const cr = Math.round(color.r * 255);
  const cg = Math.round(color.g * 255);
  const cb = Math.round(color.b * 255);
  const cmax = Math.max(cr, cg, cb);
  const cmin = Math.min(cr, cg, cb);
  const sat = cmax === 0 ? 0 : (cmax - cmin) / cmax;
  let hue = 0; // sextants, [0, 6)
  if (cmax !== cmin) {
    const d = cmax - cmin;
    if (cmax === cr) hue = ((cg - cb) / d + 6) % 6;
    else if (cmax === cg) hue = (cb - cr) / d + 2;
    else hue = (cr - cg) / d + 4;
  }
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
    const sector = Math.floor(hue);
    const f = hue - sector;
    const p = v * (1 - sat);
    const q = v * (1 - sat * f);
    const t = v * (1 - sat * (1 - f));
    let r: number, g: number, b: number;
    switch (sector) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    out[i] = Math.round(r);
    out[i + 1] = Math.round(g);
    out[i + 2] = Math.round(b);
    out[i + 3] = img.data[i + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

/** SetSelected's filter: the player, owned objects and contained objects show nothing. */
export function vtiShowsSelection(guid: number, playerGuid: number, ownedByPlayer: boolean, inContainer: boolean): boolean {
  return guid !== 0 && guid !== playerGuid && !ownedByPlayer && !inContainer;
}

/** What one frame of OnDraw decided. */
export type VtiFrame =
  | { kind: 'hidden' }
  | { kind: 'onscreen'; placement: Placement }
  | { kind: 'offscreen'; image: number; x: number; y: number };

/** OnDraw: the bounding-box status → which element shows where. */
export function vtiFrame(
  status: { kind: 'onscreen'; rect: ScreenRect } | { kind: 'offscreen'; angleDeg: number } | { kind: 'none' },
  vw: number, vh: number,
): VtiFrame {
  if (status.kind === 'onscreen') return { kind: 'onscreen', placement: onScreenPlacement(status.rect, vw, vh) };
  if (status.kind === 'offscreen') {
    const p = offscreenPosition(status.angleDeg, vw, vh, VTI_OFFSCREEN_SIZE, VTI_OFFSCREEN_SIZE);
    return { kind: 'offscreen', image: offscreenImageForAngle(status.angleDeg), x: p.x, y: p.y };
  }
  return { kind: 'hidden' };
}

/** Minimal camera surface for the bounding-box math (three.js camera-compatible). */
export interface VtiVec3 { x: number; y: number; z: number }
export interface VtiCamera {
  /** World position of the eye. */
  position: VtiVec3;
  /** Unit world vectors: screen right, screen up, view forward. */
  right: VtiVec3; up: VtiVec3; forward: VtiVec3;
  /** World point → normalised device coords ([-1, 1], y up); null behind the eye. */
  project(p: VtiVec3): { x: number; y: number } | null;
  /** Render::viewconeCheck: does the sphere touch the view frustum? */
  sphereVisible(center: VtiVec3, radius: number): boolean;
}

/**
 * SmartBox::GetObjectBoundingBox for a world-space selection sphere: the
 * on-screen rect (viewport px) of GetViewerBBox's two corners, or the
 * off-screen heading.
 */
export function objectBoundingStatus(
  center: VtiVec3, radius: number, cam: VtiCamera, vw: number, vh: number,
): { kind: 'onscreen'; rect: ScreenRect } | { kind: 'offscreen'; angleDeg: number } {
  if (cam.sphereVisible(center, radius)) {
    const { right: R, up: U } = cam;
    const p1 = { x: center.x - R.x * radius + U.x * radius, y: center.y - R.y * radius + U.y * radius, z: center.z - R.z * radius + U.z * radius };
    const p2 = { x: center.x + R.x * radius - U.x * radius, y: center.y + R.y * radius - U.y * radius, z: center.z + R.z * radius - U.z * radius };
    const a = cam.project(p1);
    const b = cam.project(p2);
    if (a && b) {
      // Retail's corners land top-left / bottom-right; min/max keeps that when
      // the projection flips an axis (our world's east-west mirror, CORE.18).
      const ax = (a.x + 1) * 0.5 * vw;
      const bx = (b.x + 1) * 0.5 * vw;
      const ay = (1 - a.y) * 0.5 * vh;
      const by = (1 - b.y) * 0.5 * vh;
      return {
        kind: 'onscreen',
        rect: {
          left: Math.trunc(Math.min(ax, bx)), top: Math.trunc(Math.min(ay, by)),
          right: Math.trunc(Math.max(ax, bx)), bottom: Math.trunc(Math.max(ay, by)),
        },
      };
    }
  }
  const d = { x: center.x - cam.position.x, y: center.y - cam.position.y, z: center.z - cam.position.z };
  const dot = (v: VtiVec3) => d.x * v.x + d.y * v.y + d.z * v.z;
  return { kind: 'offscreen', angleDeg: offscreenAngleDeg(dot(cam.right), dot(cam.forward), dot(cam.up)) };
}

/** Anything that turns image pixels into a CSS url. */
export type ImageUrlFn = (img: RgbaImage) => string | null;

/**
 * The DOM side: the on-screen group with its four corners and the off-screen
 * arrow, each a background image of the colourised DAT surface.
 */
export class VividTargetIndicatorView {
  readonly onScreen: HTMLDivElement;
  readonly corners: HTMLDivElement[];
  readonly offScreen: HTMLDivElement;
  private colorKey = '';
  private offImage = 0;
  private offColorKey = '';

  constructor(
    parent: HTMLElement,
    zIndex: string,
    private readonly source: (row: number) => RgbaImage | null,
    private readonly toUrl: ImageUrlFn,
  ) {
    const doc = parent.ownerDocument;
    const layer = (el: HTMLDivElement) => Object.assign(el.style, {
      position: 'fixed', left: '0', top: '0', display: 'none', pointerEvents: 'none', zIndex,
    });
    this.onScreen = doc.createElement('div');
    this.onScreen.id = 'vivid-target-indicator';
    layer(this.onScreen);
    const anchors: Array<Partial<CSSStyleDeclaration>> = [
      { left: '0', top: '0' }, { right: '0', top: '0' }, { left: '0', bottom: '0' }, { right: '0', bottom: '0' },
    ];
    this.corners = anchors.map((a) => {
      const c = doc.createElement('div');
      Object.assign(c.style, { position: 'absolute', width: `${VTI_CORNER_SIZE}px`, height: `${VTI_CORNER_SIZE}px`, ...a });
      this.onScreen.appendChild(c);
      return c;
    });
    this.offScreen = doc.createElement('div');
    this.offScreen.id = 'vivid-target-indicator-offscreen';
    layer(this.offScreen);
    Object.assign(this.offScreen.style, { width: `${VTI_OFFSCREEN_SIZE}px`, height: `${VTI_OFFSCREEN_SIZE}px` });
    parent.appendChild(this.onScreen);
    parent.appendChild(this.offScreen);
  }

  private imageUrl(row: number, color: Rgba01): string | null {
    const img = this.source(row);
    return img ? this.toUrl(colorizeRGBA(img, color)) : null;
  }

  /** Apply one frame's decision in `color` (the selection's blip colour). */
  update(frame: VtiFrame, color: Rgba01): void {
    const key = `${color.r},${color.g},${color.b},${color.a}`;
    if (frame.kind === 'onscreen') {
      if (key !== this.colorKey) {
        // The key is recorded only once every corner painted: a corner whose
        // streamed texture (or palette) was not resident yet is retried on
        // later frames.
        const missEpoch = datMissEpoch();
        let painted = true;
        this.corners.forEach((c, i) => {
          const url = this.imageUrl(VtiImage.OnscreenNW + i, color);
          c.style.backgroundImage = url ? `url(${url})` : '';
          if (!url) painted = false;
        });
        this.colorKey = painted && noDatMissSince(missEpoch) ? key : '';
      }
      const p = frame.placement;
      Object.assign(this.onScreen.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px`, display: 'block' });
      this.offScreen.style.display = 'none';
      return;
    }
    this.onScreen.style.display = 'none';
    if (frame.kind === 'offscreen') {
      if (frame.image !== this.offImage || key !== this.offColorKey) {
        const missEpoch = datMissEpoch();
        const url = this.imageUrl(frame.image, color);
        this.offScreen.style.backgroundImage = url ? `url(${url})` : '';
        const painted = url !== null && noDatMissSince(missEpoch);
        this.offImage = painted ? frame.image : 0;
        this.offColorKey = painted ? key : '';
      }
      Object.assign(this.offScreen.style, { left: `${frame.x}px`, top: `${frame.y}px`, display: 'block' });
      return;
    }
    this.offScreen.style.display = 'none';
  }
}
