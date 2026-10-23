/**
 * CORE.17.d — retail radar blip geometry, shape selection and brightness,
 * transcribed from the decompiled EoL client (reference/client-eol/decomp/
 * acclient-decompiled.c, build ac1_sep13):
 *
 *   gmRadarUI::DrawPoint            @ 004d7c30  single pixel
 *   gmRadarUI::DrawEdges            @ 004d7c70  (x,y-1) (x,y+1) (x-1,y) (x+1,y)
 *   gmRadarUI::DrawCorners          @ 004d7d20  (x+1,y+1) (x-1,y-1) (x-1,y+1) (x+1,y-1)
 *   gmRadarUI::DrawCross            @ 004d7de0  point + edges          — Default (Plus)
 *   gmRadarUI::DrawX                @ 004d7e30  point + corners        — Threat (X)
 *   gmRadarUI::DrawHollow           @ 004d8430  edges + corners        — AllegianceMember (Box)
 *   gmRadarUI::DrawXBox             @ 004d8470  hollow + (x±2,y±2)     — ThreatAllegiance (XBox)
 *   gmRadarUI::DrawTriangle         @ 004d7e80  (x,y) + row y+1        — FellowshipLeader
 *   gmRadarUI::DrawInvertedTriangle @ 004d7f30  (x,y) + row y-1        — Fellowship
 *   gmRadarUI::DrawSelected         @ 004d7fe0  7x7 open-cornered box around the blip
 *   gmRadarUI::DrawBlip             @ 004d8a30  color = blip color * brightness; shape switch;
 *                                               DrawSelected when the object is selectedID
 *   gmRadarUI::DrawObjects          @ 004d9380  brightness 1.0 when |dz| < 5.0 else 0.65;
 *                                               objects within (range-1)^2; screen position
 *                                               truncated (_ftol2) and bounded to center±radius
 *   gmRadarUI::DrawChildren         @ 004d9720  player marker: center pixel + edges + (cx±2,cy)
 *                                               + (cx,cy±2) in RGBAColor_RadarBrightGreen
 *   gmRadarUI::GetBlipShape         @ 004d7b60  fellowship (leader → Triangle, else Inverted)
 *                                               → allegiance member (Box) → mutual PK / mutual
 *                                               PKLite (X) → Default (Plus)
 *   ACCWeenieObject::IsAllegianceMember @ 0058c630  obj.monarch != 0 && obj.monarch == player.monarch
 *
 * Every blip is a handful of single pixels on the disc surface — retail
 * never draws filled circles. The enum values follow acclient.pdb
 * (Undef_/Box_/X_/Plus_/Triangle_/InvertedTriangle_/XBox_RadarBlipShape);
 * gmRadarUI's decompiled switch names the same values Circle/
 * AllegianceMember/Threat/Default/FellowshipLeader/Fellowship/
 * ThreatAllegiance (Ghidra: "some values do not have unique names").
 * Circle == Undef → DrawPoint is unreachable: gmRadarUI::AddObject @ 004d9a00
 * refuses any object whose GetBlipShape is Undef.
 */

import { ObjectDescriptionFlag, ItemType, RadarBehavior } from '@ac/shared';
import { yawToCompassDegrees } from '../scene/AcHeading.js';

/**
 * BUG.radar-monsters-missing — retail blip colors. acclient.pdb statics
 * (symbols/globals.tsv), RGBAColor floats r/g/b/a:
 *   RGBAColor_RadarBlue        {0.25, 0.66, 1,    1}   @ 0x8190e8
 *   RGBAColor_RadarGold        {1,    0.67, 0,    1}   @ 0x8190f8  (= Creature)
 *   RGBAColor_RadarWhite       {1,    1,    1,    1}   @ 0x819118  (= Default)
 *   RGBAColor_RadarPurple      {0.75, 0.39, 1,    1}   @ 0x819138  (= Portal)
 *   RGBAColor_RadarRed         {1,    0.25, 0.39, 1}   @ 0x819128  (= PlayerKiller)
 *   RGBAColor_RadarPink        {1,    0.66, 0.75, 1}   @ 0x819148  (= PKLite)
 *   RGBAColor_RadarGreen       {0,    0.5,  0.25, 1}   @ 0x819158
 *   RGBAColor_RadarYellow      {1,    1,    0.5,  1}   @ 0x819108  (= Vendor/NPC)
 *   RGBAColor_RadarCyan        {0,    1,    1,    1}   @ 0x819168  (= Admin)
 *   RGBAColor_RadarBrightGreen {0,    1,    0,    1}   @ 0x819178  (= Fellowship[Leader])
 * The aliases (Creature/Default/Portal/...) are dyninit copies of these.
 */
export interface RadarRGBA { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
export const RADAR_RGBA = {
  Blue:        { r: 0.25, g: 0.66, b: 1, a: 1 },
  Gold:        { r: 1, g: 0.67, b: 0, a: 1 },
  White:       { r: 1, g: 1, b: 1, a: 1 },
  Purple:      { r: 0.75, g: 0.39, b: 1, a: 1 },
  Red:         { r: 1, g: 0.25, b: 0.39, a: 1 },
  Pink:        { r: 1, g: 0.66, b: 0.75, a: 1 },
  Green:       { r: 0, g: 0.5, b: 0.25, a: 1 },
  Yellow:      { r: 1, g: 1, b: 0.5, a: 1 },
  Cyan:        { r: 0, g: 1, b: 1, a: 1 },
  BrightGreen: { r: 0, g: 1, b: 0, a: 1 },
} as const satisfies Record<string, RadarRGBA>;
export const RADAR_RGBA_DEFAULT = RADAR_RGBA.White;
export const RADAR_RGBA_CREATURE = RADAR_RGBA.Gold;

/**
 * RGBAColor::GetColor32 @ 00423d00 — each channel ×255.0f then _ftol2
 * (truncation), computed in single precision like the x87 path.
 */
export function radarRgbaToCss(c: RadarRGBA): string {
  const ch = (v: number) => Math.trunc(Math.fround(Math.fround(v) * 255)).toString(16).padStart(2, '0');
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/**
 * gmRadarUI::DrawChildren @ 004d9720 paints the player's own marker in
 * RGBAColor_RadarBrightGreen.
 */
export const RADAR_PLAYER_MARKER_CSS = radarRgbaToCss(RADAR_RGBA.BrightGreen);

/** The PublicWeenieDesc blip-color switch (`_blipColor`, 1..10) of GetBlipColor. */
const BLIP_COLOR_TABLE: readonly RadarRGBA[] = [
  RADAR_RGBA_DEFAULT, // 0 — never indexed (0 falls through to the type rules)
  RADAR_RGBA.Blue, RADAR_RGBA.Gold, RADAR_RGBA.White, RADAR_RGBA.Purple, RADAR_RGBA.Red,
  RADAR_RGBA.Pink, RADAR_RGBA.Green, RADAR_RGBA.Yellow, RADAR_RGBA.Cyan,
  RADAR_RGBA.BrightGreen, // case 10 (decimal) — ACE's RadarColor.BrightGreen = 0x10 hits `default`
];

export interface BlipColorInputs {
  /** PublicWeenieDesc._blipColor (WeenieHeaderFlag.RadarBlipColor; 0 when not sent). */
  blipColor: number;
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag). */
  objectDescFlags: number;
  /** ITEM_TYPE (ACCWeenieObject::InqType, vtable +0x18). */
  itemType: number;
  /** ClientFellowshipSystem::IsFellow / IsFellowshipLeader. */
  isFellow: boolean;
  isFellowshipLeader: boolean;
}

/**
 * gmRadarUI::GetBlipColor(ACCWeenieObject*) @ 004d76f0, branch for branch.
 * ACCWeenieObject vtable (acclient.exe .rdata, file offset 0x3e3ea0):
 * +0x10 IsPlayer (bitfield 0x8), +0x20 IsPK (bitfield 0x20), +0x24 IsPKLite
 * (bitfield 0x2000000), +0x2c IsCreature (InqType() & 0x10).
 *
 *   UI-hidden (bitfield 0x80)            → Default
 *   _blipColor != 0                      → that table color (unknown → Default)
 *   Portal bit (0x40000)                 → Portal (purple)
 *   Vendor bit (0x200)                   → Vendor (yellow)
 *   Attackable (0x10) && creature && !player → Creature (gold/orange) — monsters
 *   non-player                           → Default (white)
 *   player: Admin && !HiddenAdmin → Admin; else PK → PlayerKiller; else
 *     PKLite → PKLite; else bitfield 0x200000 → Creature; else Default;
 *     then fellowship leader / fellow → BrightGreen.
 */
export function selectBlipColor(i: BlipColorInputs): RadarRGBA {
  const f = i.objectDescFlags >>> 0;
  if (f & ObjectDescriptionFlag.UiHidden) return RADAR_RGBA_DEFAULT;
  if (i.blipColor !== 0) return BLIP_COLOR_TABLE[i.blipColor] ?? RADAR_RGBA_DEFAULT;
  if (f & ObjectDescriptionFlag.Portal) return RADAR_RGBA.Purple;
  if (f & ObjectDescriptionFlag.Vendor) return RADAR_RGBA.Yellow;
  const isPlayer = (f & ObjectDescriptionFlag.Player) !== 0;
  const isCreature = (i.itemType & ItemType.Creature) !== 0;
  if ((f & ObjectDescriptionFlag.Attackable) && isCreature && !isPlayer) return RADAR_RGBA_CREATURE;
  if (!isPlayer) return RADAR_RGBA_DEFAULT;
  let c: RadarRGBA;
  if ((f & ObjectDescriptionFlag.Admin) && !(f & ObjectDescriptionFlag.HiddenAdmin)) c = RADAR_RGBA.Cyan;
  else if (f & ObjectDescriptionFlag.PlayerKiller) c = RADAR_RGBA.Red;
  else if (f & ObjectDescriptionFlag.PkLiteStatus) c = RADAR_RGBA.Pink;
  else if (f & ObjectDescriptionFlag.FreePkStatus) c = RADAR_RGBA_CREATURE;
  else c = RADAR_RGBA_DEFAULT;
  if (i.isFellowshipLeader || i.isFellow) c = RADAR_RGBA.BrightGreen;
  return c;
}

/**
 * gmRadarUI::AddObject @ 004d9a00 eligibility (range is DrawObjects'):
 * not UI-hidden (bitfield 0x80), and ACCWeenieObject::InqShowableOnRadar
 * @ 0058c250 — `_radar_enum` is ShowMovement(2), ShowAttacking(3) or
 * ShowAlways(4). Undefined (0, the PublicWeenieDesc default when the
 * server omits WeenieHeaderFlag.RadarBehavior) and ShowNever (1) get no
 * blip. The blip COLOR never gates a blip: a 0 `_blipColor` falls through
 * to GetBlipColor's type rules (a monster → Creature gold).
 */
export function showableOnRadar(radarBehavior: number, uiHidden: boolean): boolean {
  if (uiHidden) return false;
  return radarBehavior === RadarBehavior.ShowMovement
    || radarBehavior === RadarBehavior.ShowAttacking
    || radarBehavior === RadarBehavior.ShowAlways;
}

/**
 * BUG.webac11-radar-1999 (webac#11) — the 1999 client.exe's
 * ACCWeenieObject_InqShowableOnRadar(Vector3 *offset) @ 0x4e2f20 (read from
 * dat-sets/ac1999-retail/client.exe; the end-of-retail one ignores its
 * argument and shows 2, 3 and 4 alike). `offset` is the object's offset from
 * the player (RadarUI_Update @ 0x527fc0 builds it @ 0x5284e0 and calls this
 * @ 0x528506, after the bitfield-0x80 UI-hidden skip @ 0x52849c):
 *
 *   no physics object (+0x88)                → no
 *   _radar_enum (pwd+0x78) == ShowNever (1)  → no
 *   _radar_enum == ShowAlways (4)            → yes
 *   selected (+0x68) && IsCreature (vtbl +0x20 = InqType() & 0x10) → yes
 *   ShowAttacking (3): |offset| < reveal distance → yes; no interpreted
 *     motion state → yes; current_style a combat stance → yes; else no
 *   ShowMovement (2): |offset| < reveal distance → yes; get_velocity
 *     (CPhysicsObj +0x14c @ 0x4387a0) not Vector3::is_zero @ 0x4349c0
 *     (every |axis| < F_EPSILON 0.0002 @ 0x5f7c60) → yes; no interpreted
 *     state → yes; its actions list non-empty (+0x20, 0x4e4210) → yes;
 *     turn_command (+0x18) != 0 → yes; combat stance → yes; else no
 *   Undefined (0) / anything else            → no
 *
 * The reveal distance is PublicWeenieDesc +0x7c (header bit 0x1000000, a
 * float), which PublicWeenieDesc_Reset @ 0x5d7bf0 sets to 10.0f (@ 0x617b10)
 * and the AC1999 server never sends (kb publicweeniedesc-packing: "Never
 * populated"). The interpreted state is the movement manager's
 * CMotionInterp +0x44 (0x43b860 → 0x482d20).
 */
export const RADAR_REVEAL_DISTANCE_1999 = 10;
/** F_EPSILON @ 0x5f7c60 (0.0002f), Vector3::is_zero's per-axis bound. */
export const RADAR_STILL_EPSILON_1999 = 0.0002;

/**
 * 0x4e3160 — the motion styles that count as "in combat": HandCombat 0x3c,
 * SwordCombat 0x3e, BowCombat 0x3f, SwordShield 0x40, Crossbow 0x41,
 * Unused 0x42, Sling 0x43, 2HSword 0x44, 2HStaff 0x45, DualWield 0x46,
 * ThrownWeapon 0x47, Magic 0x49 (all | 0x80000000). NonCombat 0x3d and
 * Graze 0x48 are not.
 */
const COMBAT_STYLES_1999: ReadonlySet<number> = new Set([
  0x8000003c, 0x8000003e, 0x8000003f, 0x80000040, 0x80000041, 0x80000043,
  0x80000044, 0x80000045, 0x80000046, 0x80000047, 0x80000049, 0x80000042,
]);
export function isCombatStyle1999(style: number): boolean {
  return COMBAT_STYLES_1999.has(style >>> 0);
}

/** What the 1999 InqShowableOnRadar reads of one object. */
export interface RadarShowFacts1999 {
  radarBehavior: number;
  uiHidden: boolean;
  /** |offset| from the player's position, metres (3D). */
  distance: number;
  /** ACCWeenieObject +0x68 `selected` (it is selectedID). */
  selected: boolean;
  /** InqType() & 0x10. */
  isCreature: boolean;
  /** CPhysicsObj::get_velocity is not zero. */
  moving: boolean;
  /** The interpreted motion state, or null when the object has none (→ shown). */
  motion: { style: number; turning: boolean; actionsPending: boolean } | null;
  /** PublicWeenieDesc +0x7c; RADAR_REVEAL_DISTANCE_1999 when not sent. */
  revealDistance?: number;
}

/** ACCWeenieObject_InqShowableOnRadar @ 0x4e2f20 (plus RadarUI_Update's UI-hidden skip). */
export function inqShowableOnRadar1999(f: RadarShowFacts1999): boolean {
  if (f.uiHidden) return false;
  const re = f.radarBehavior;
  if (re === RadarBehavior.ShowNever) return false;
  if (re === RadarBehavior.ShowAlways) return true;
  if (f.selected && f.isCreature) return true;
  if (re !== RadarBehavior.ShowAttacking && re !== RadarBehavior.ShowMovement) return false;
  if (f.distance < (f.revealDistance ?? RADAR_REVEAL_DISTANCE_1999)) return true;
  if (re === RadarBehavior.ShowMovement && f.moving) return true;
  const m = f.motion;
  if (!m) return true;
  if (re === RadarBehavior.ShowMovement && (m.actionsPending || m.turning)) return true;
  return isCombatStyle1999(m.style);
}

/** The object fields RadarVisibility reads. */
export interface RadarVisibilityObject {
  guid: number;
  worldX: number; worldY: number; worldZ: number;
  radarBehavior: number;
  uiHidden?: boolean;
  itemType?: number;
  /** The interpreted state's turn command (world/RemoteMotion InterpretedMotion.turn). */
  motionState?: { turn: number };
}

/** The motion interpreter facts of one object (MotionManager), or undefined when it has none. */
export interface RadarMotionSource {
  readonly currentStyleId: number;
  readonly motionsPending: boolean;
}

/**
 * Which InqShowableOnRadar the era's client runs: end of retail's
 * (showableOnRadar) or the 1999 client's (inqShowableOnRadar1999). One
 * instance serves the radar feed and the Closest Compass Item key, which
 * share the predicate in both clients (1999 PanelUI_SelectNext case 2,
 * end-of-retail CPlayerSystem::SelectNext).
 *
 * get_velocity is the physics object's cached velocity, the displacement of
 * its last update: beginFrame samples each object's position once per frame,
 * and reads between frames (a select key) see the last frame's answer.
 */
export class RadarVisibility<T extends RadarVisibilityObject> {
  rule: 'eor' | 'ac1999' = 'eor';
  private frame = 0;
  private nowSec = 0;
  private dtSec = 0;
  private readonly samples = new Map<number, { x: number; y: number; z: number; frame: number; moving: boolean }>();
  private readonly facts: RadarShowFacts1999 = {
    radarBehavior: 0, uiHidden: false, distance: 0, selected: false, isCreature: false, moving: false, motion: null,
  };
  private readonly motionFacts = { style: 0, turning: false, actionsPending: false };

  constructor(private readonly motionOf: (guid: number) => RadarMotionSource | undefined) {}

  /** Once per rendered frame, before the radar feed is built. */
  beginFrame(nowSec: number): void {
    this.dtSec = this.frame === 0 ? 0 : Math.max(0, nowSec - this.nowSec);
    this.nowSec = nowSec;
    this.frame++;
    // Forget objects not sampled for a while (gone, or out of every frame's walk).
    if ((this.frame & 0xff) === 0) {
      for (const [guid, s] of this.samples) if (this.frame - s.frame > 0x100) this.samples.delete(guid);
    }
  }

  /** CPhysicsObj::get_velocity is not zero — sampled at most once per frame. */
  private moving(obj: T): boolean {
    let s = this.samples.get(obj.guid);
    if (!s) {
      s = { x: obj.worldX, y: obj.worldY, z: obj.worldZ, frame: this.frame, moving: false };
      this.samples.set(obj.guid, s);
      return false;
    }
    if (s.frame !== this.frame) {
      if (this.dtSec > 0) {
        const bound = RADAR_STILL_EPSILON_1999 * this.dtSec;
        s.moving = Math.abs(obj.worldX - s.x) >= bound || Math.abs(obj.worldY - s.y) >= bound || Math.abs(obj.worldZ - s.z) >= bound;
      }
      s.x = obj.worldX; s.y = obj.worldY; s.z = obj.worldZ; s.frame = this.frame;
    }
    return s.moving;
  }

  /**
   * Whether `obj` gets a radar blip / counts for Closest Compass Item.
   * `dx`, `dy`, `dz` are its offset from the player's position (metres).
   */
  showable(obj: T, dx: number, dy: number, dz: number, selectedGuid: number): boolean {
    if (this.rule === 'eor') return showableOnRadar(obj.radarBehavior, !!obj.uiHidden);
    const f = this.facts;
    f.radarBehavior = obj.radarBehavior;
    f.uiHidden = !!obj.uiHidden;
    f.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    f.selected = selectedGuid !== 0 && selectedGuid === obj.guid;
    f.isCreature = ((obj.itemType ?? 0) & ItemType.Creature) !== 0;
    f.moving = obj.radarBehavior === RadarBehavior.ShowMovement ? this.moving(obj) : false;
    const mm = this.motionOf(obj.guid);
    if (mm) {
      const m = this.motionFacts;
      m.style = mm.currentStyleId;
      m.turning = (obj.motionState?.turn ?? 0) !== 0;
      m.actionsPending = mm.motionsPending;
      f.motion = m;
    } else {
      f.motion = null;
    }
    return inqShowableOnRadar1999(f);
  }
}

export enum RadarBlipShape {
  Undef = 0,
  AllegianceMember = 1,
  Threat = 2,
  Default = 3,
  FellowshipLeader = 4,
  Fellowship = 5,
  ThreatAllegiance = 6,
}

/** One painted pixel (surface x, y — y grows downward like the UI surface). */
export type BlipPixel = readonly [number, number];

/** gmRadarUI::DrawEdges @ 004d7c70 */
export function edgePixels(x: number, y: number): BlipPixel[] {
  return [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]];
}

/** gmRadarUI::DrawCorners @ 004d7d20 */
export function cornerPixels(x: number, y: number): BlipPixel[] {
  return [[x + 1, y + 1], [x - 1, y - 1], [x - 1, y + 1], [x + 1, y - 1]];
}

/** gmRadarUI::DrawBlip @ 004d8a30 shape switch → the pixels each painter fills. */
export function blipPixels(shape: RadarBlipShape, x: number, y: number): BlipPixel[] {
  switch (shape) {
    case RadarBlipShape.Default:          // DrawCross: point + edges
      return [[x, y], ...edgePixels(x, y)];
    case RadarBlipShape.Threat:           // DrawX: point + corners
      return [[x, y], ...cornerPixels(x, y)];
    case RadarBlipShape.AllegianceMember: // DrawHollow: edges + corners
      return [...edgePixels(x, y), ...cornerPixels(x, y)];
    case RadarBlipShape.ThreatAllegiance: // DrawXBox: hollow + the four (±2,±2) pixels
      return [
        ...edgePixels(x, y), ...cornerPixels(x, y),
        [x - 2, y - 2], [x + 2, y - 2], [x - 2, y + 2], [x + 2, y + 2],
      ];
    case RadarBlipShape.FellowshipLeader: // DrawTriangle: apex + the row below
      return [[x, y], [x - 1, y + 1], [x, y + 1], [x + 1, y + 1]];
    case RadarBlipShape.Fellowship:       // DrawInvertedTriangle: apex + the row above
      return [[x, y], [x - 1, y - 1], [x, y - 1], [x + 1, y - 1]];
    default:                              // Undef/Circle — never reaches the surface
      return [];
  }
}

/**
 * gmRadarUI::DrawSelected @ 004d7fe0 — four 5-pixel runs at ±3, forming a
 * 7x7 box whose corners are open.
 */
export function selectedPixels(x: number, y: number): BlipPixel[] {
  const out: BlipPixel[] = [];
  for (let i = -2; i <= 2; i++) {
    out.push([x + i, y + 3]);   // FillArea(x-2, y+3, x+2, y+3)
    out.push([x + 3, y + i]);   // FillArea(x+3, y-2, x+3, y+2)
    out.push([x + i, y - 3]);   // FillArea(x-2, y-3, x+2, y-3)
    out.push([x - 3, y + i]);   // FillArea(x-3, y-2, x-3, y+2)
  }
  return out;
}

/**
 * gmRadarUI::DrawChildren @ 004d9720 — the player's own marker at the dial
 * center: center pixel, DrawEdges, then (cx-2,cy) (cx+2,cy) (cx,cy-2)
 * (cx,cy+2). A 5-wide plus of nine pixels in RGBAColor_RadarBrightGreen.
 */
export function playerMarkerPixels(cx: number, cy: number): BlipPixel[] {
  return [
    [cx, cy], ...edgePixels(cx, cy),
    [cx - 2, cy], [cx + 2, cy], [cx, cy - 2], [cx, cy + 2],
  ];
}

/** gmRadarUI::DrawObjects @ 004d9380: `ABS(dz) < 5.0 ? 1.0 : 0.65`. */
export const RADAR_BLIP_DIM_HEIGHT = 5.0;
export const RADAR_BLIP_DIM_FACTOR = 0.65;
export function blipBrightness(dz: number): number {
  return Math.abs(dz) < RADAR_BLIP_DIM_HEIGHT ? 1.0 : RADAR_BLIP_DIM_FACTOR;
}

/**
 * gmRadarUI::DrawBlip @ 004d8a30 — `local.r = color.r * brightness` (g, b
 * likewise; alpha untouched). Applied to a '#rrggbb' CSS color.
 */
export function scaleBlipColor(hex: string, brightness: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || brightness >= 1) return hex;
  const v = parseInt(m[1], 16);
  const ch = (shift: number) => Math.round(((v >> shift) & 0xff) * brightness).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** gmRadarUI::DrawObjects: an object is considered when dx²+dy² < (range-1)². */
export function blipInRange(dx: number, dz: number, range: number): boolean {
  const r = range - 1;
  return dx * dx + dz * dz < r * r;
}

export interface BlipShapeInputs {
  /** ClientFellowshipSystem::IsFellow(obj) */
  isFellow: boolean;
  /** ClientFellowshipSystem::IsFellowshipLeader(obj) */
  isFellowshipLeader: boolean;
  /** ACCWeenieObject::IsAllegianceMember(obj, player) — see allegianceMember(). */
  isAllegianceMember: boolean;
  /** ACCWeenieObject vtable +0x20 (IsPK) on the object / the player. */
  objIsPK: boolean;
  playerIsPK: boolean;
  /** ACCWeenieObject vtable +0x24 (IsPKLite) on the object / the player. */
  objIsPKLite: boolean;
  playerIsPKLite: boolean;
}

/** gmRadarUI::GetBlipShape @ 004d7b60 — evaluation order preserved. */
export function selectBlipShape(i: BlipShapeInputs): RadarBlipShape {
  if (i.isFellow) {
    return i.isFellowshipLeader ? RadarBlipShape.FellowshipLeader : RadarBlipShape.Fellowship;
  }
  if (i.isAllegianceMember) return RadarBlipShape.AllegianceMember;
  if (i.objIsPK && i.playerIsPK) return RadarBlipShape.Threat;
  if (i.objIsPKLite && i.playerIsPKLite) return RadarBlipShape.Threat;
  return RadarBlipShape.Default;
}

/** ACCWeenieObject::IsAllegianceMember @ 0058c630 */
export function allegianceMember(objMonarch: number | undefined, playerMonarch: number | undefined): boolean {
  return !!objMonarch && objMonarch === playerMonarch;
}

/** ACE PlayerKillerStatus bits (Enum/PlayerKillerStatus.cs): PK = 0x04, PKLite = 0x40. */
export const PK_STATUS_PK = 0x04;
export const PK_STATUS_PKLITE = 0x40;
export function isPK(status: number | undefined): boolean { return ((status ?? 0) & PK_STATUS_PK) !== 0; }
export function isPKLite(status: number | undefined): boolean { return ((status ?? 0) & PK_STATUS_PKLITE) !== 0; }

/**
 * CORE.18.a — radar offset of an object from the player, from renderer world
 * coordinates (worldX = AC east, worldZ = AC north). blipScreenPosition takes
 * dz in metres SOUTH (screen-down at heading 0); passing the north delta put
 * a northern object below the player marker while facing north.
 */
export function radarOffsetFromWorld(
  objWorldX: number, objWorldZ: number, playerWorldX: number, playerWorldZ: number,
): { dx: number; dz: number } {
  return { dx: objWorldX - playerWorldX, dz: playerWorldZ - objWorldZ };
}

/**
 * gmRadarUI::DrawObjects @ 004d9380 — world offset (dx east, dz south, in
 * metres) → disc pixel. The offset is rotated into the player's frame
 * (SmartBox::convert_to_player_space @ 00452da0 — the player physics
 * object's heading, never the camera's orbit; see radarHeadingRadians), scaled by
 * m_nRadarRadius / m_fRadarRange, truncated like _ftol2, then bounded to
 * the square center±radius. Returns null when the blip falls outside.
 */
export function blipScreenPosition(
  dx: number, dz: number, headingDegrees: number,
  range: number, radius: number, cx: number, cy: number,
): { x: number; y: number } | null {
  const heading = headingDegrees * Math.PI / 180;
  const cosH = Math.cos(-heading);
  const sinH = Math.sin(-heading);
  const rx = dx * cosH - dz * sinH;
  const rz = dx * sinH + dz * cosH;
  const x = Math.trunc(cx + (rx / range) * radius);
  const y = Math.trunc(cy + (rz / range) * radius);
  if (x < cx - radius || x > cx + radius || y < cy - radius || y > cy + radius) return null;
  return { x, y };
}

/**
 * The heading the radar dial follows, in compass radians (0 = north,
 * clockwise) — the character's own facing, NOT the camera's.
 * gmRadarUI::UpdateCompassTokens @ 004d9060 reads
 * CPhysicsObj::get_heading(smartbox->player) and DrawObjects places blips via
 * SmartBox::convert_to_player_space (the player's m_position frame); neither
 * reads the camera, so orbiting the third-person camera (Rotate Camera /
 * middle-mouse look without Use Mouse Turning) leaves the dial still
 * (SWEEP1006B.hud-status.radar-dial-blips-rotate-camera).
 */
export function radarHeadingRadians(camera: { readonly playerYaw: number }): number {
  return yawToCompassDegrees(camera.playerYaw || 0) * Math.PI / 180;
}

/** gmRadarUI::DrawObjects — mouse within sqrt(0x25) px of a blip → that object's name tooltip. */
export const RADAR_BLIP_HOVER_DIST_SQ = 0x25;
export function nearestBlipUnderMouse<T extends { x: number; y: number }>(
  blips: readonly T[], mx: number, my: number,
): T | null {
  let best: T | null = null;
  let bestD = RADAR_BLIP_HOVER_DIST_SQ;
  for (const b of blips) {
    const ddx = mx - b.x;
    const ddy = my - b.y;
    const d = ddx * ddx + ddy * ddy;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/**
 * CORE.retail-radar-click-select — gmRadarUI::ListenToElementMessage
 * @ 004d75b0: a click (UI message 0x19, any mouse button) on the radar while
 * m_iidObjectUnderMouse is set (DrawObjects' blip hit-test) calls
 * ACCWeenieObject::SetSelectedObject on that object. `pick` maps disc pixels
 * (the canvas is `discSize` px square before HUD scaling) to the guid under
 * the mouse, 0 for none.
 */
export function bindRadarClickSelect(
  canvas: HTMLElement, discSize: number,
  pick: (mx: number, my: number) => number,
  onSelect: (guid: number) => void,
): void {
  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? discSize / r.width : 1;
    const sy = r.height > 0 ? discSize / r.height : 1;
    const guid = pick((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
    if (guid !== 0) onSelect(guid);
  });
  // A right-click selects too; the browser menu would cover the radar.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** ACE Player.cs:78 — `CurrentRadarRange => Location.Indoors ? 25.0f : 75.0f` (MaxRadarRange_*). */
export const RADAR_RANGE_INDOORS = 25;
export const RADAR_RANGE_OUTDOORS = 75;
export function radarRangeFor(indoors: boolean): number {
  return indoors ? RADAR_RANGE_INDOORS : RADAR_RANGE_OUTDOORS;
}

/**
 * FAITHFUL.526 — ACE LandblockId.cs:71 defines Indoors as
 * `(Raw & 0xFFFF) >= 0x100`: ANY interior cell, dungeons AND surface-
 * building EnvCells (a Holtburg hut); retail's SmartBox::is_player_outside
 * @ 00451e80 is the same test on the player's cell. VISUAL.radar-coord-
 * plate-missing-pit — ours reads the player's actual cell (`surfaceCellId`,
 * the BSP-contained surface interior cell, 0 outdoors), not the building's
 * XZ footprint: the Xarabydun pit's footprint covers its rim, so standing
 * on the rim (outdoor cell 0x934B0021) read as indoors — no coordinates and
 * a 25 m radar where retail shows both.
 */
export function radarIsIndoors(playerInDungeon: boolean, surfaceCellId: number): boolean {
  return playerInDungeon || (surfaceCellId & 0xffff) >= 0x100;
}

/** One radar blip as the HUD consumes it (HUDState.radarDots). */
export interface RadarDot {
  dx: number; dz: number; dy: number;
  color: string; guid: number; shape: RadarBlipShape; name: string;
}

/** The server-object fields the radar populate reads. */
export interface RadarFeedObject {
  guid: number;
  worldX: number; worldY: number; worldZ: number;
  radarColor: number;
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag) — GetBlipColor's type rules. */
  objectDescFlags?: number;
  /** ITEM_TYPE — GetBlipColor's IsCreature test. */
  itemType?: number;
  monarchGuid?: number;
  playerKillerStatus?: number;
  name: string;
}

/** Per-frame inputs to RadarDotFeed.build — a caller keeps one and mutates it. */
export interface RadarFeedContext<T extends RadarFeedObject> {
  playerWorldX: number; playerWorldZ: number; playerFeetY: number;
  /** m_fRadarRange: 25 m indoors, 75 m outdoors (ACE Player.cs MaxRadarRange_*). */
  range: number;
  fellows: readonly { guid: number }[] | null;
  fellowshipLeaderGuid: number;
  playerMonarchGuid: number | undefined;
  playerPKStatus: number | undefined;
  /**
   * gmRadarUI::AddObject culling (InqShowableOnRadar: RadarVisibility.showable).
   * dx east, dy up (from the player's feet), dz south — the object's offset in metres.
   */
  eligible: (obj: T, dx: number, dy: number, dz: number) => boolean;
}

/**
 * REND.per-frame-allocations — builds the radar blip list every frame
 * without per-frame garbage: the dot array, the dot records, the fellow-GUID
 * set and the GetBlipShape inputs are reused across frames. Semantics are
 * gmRadarUI::DrawObjects @ 004d9380's: radarOffsetFromWorld's offset, the
 * (range-1)² blipInRange filter, selectBlipShape and selectBlipColor
 * (GetBlipColor @ 004d76f0) per object. The
 * returned array (and its records) is overwritten by the next build — the
 * HUD consumes it the same frame.
 */
export class RadarDotFeed<T extends RadarFeedObject> {
  private readonly dots: RadarDot[] = [];
  private readonly pool: RadarDot[] = [];
  private readonly fellowGuids = new Set<number>();
  private readonly shapeInputs: BlipShapeInputs = {
    isFellow: false, isFellowshipLeader: false, isAllegianceMember: false,
    objIsPK: false, playerIsPK: false, objIsPKLite: false, playerIsPKLite: false,
  };
  private readonly colorInputs: BlipColorInputs = {
    blipColor: 0, objectDescFlags: 0, itemType: 0, isFellow: false, isFellowshipLeader: false,
  };
  /** RadarRGBA → CSS, memoized (the palette is ten fixed colors). */
  private readonly cssOf = new Map<RadarRGBA, string>();

  build(objects: Iterable<T>, ctx: RadarFeedContext<T>): RadarDot[] {
    const dots = this.dots;
    dots.length = 0;
    // The fellowship roster is at most 9 — refilled each frame so an
    // in-place roster edit is never missed.
    const fellowGuids = this.fellowGuids;
    fellowGuids.clear();
    if (ctx.fellows) for (const f of ctx.fellows) fellowGuids.add(f.guid);
    const si = this.shapeInputs;
    si.playerIsPK = isPK(ctx.playerPKStatus);
    si.playerIsPKLite = isPKLite(ctx.playerPKStatus);
    let n = 0;
    for (const obj of objects) {
      // radarOffsetFromWorld, inlined (dz is metres SOUTH).
      const dx = obj.worldX - ctx.playerWorldX;
      const dz = ctx.playerWorldZ - obj.worldZ;
      const dy = obj.worldY - ctx.playerFeetY;
      if (!ctx.eligible(obj, dx, dy, dz)) continue;
      if (!blipInRange(dx, dz, ctx.range)) continue;
      si.isFellow = fellowGuids.has(obj.guid);
      si.isFellowshipLeader = obj.guid === ctx.fellowshipLeaderGuid;
      si.isAllegianceMember = allegianceMember(obj.monarchGuid, ctx.playerMonarchGuid);
      si.objIsPK = isPK(obj.playerKillerStatus);
      si.objIsPKLite = isPKLite(obj.playerKillerStatus);
      let d = this.pool[n];
      if (!d) {
        d = { dx: 0, dz: 0, dy: 0, color: '', guid: 0, shape: RadarBlipShape.Default, name: '' };
        this.pool[n] = d;
      }
      n++;
      d.dx = dx; d.dz = dz; d.dy = dy;
      const ci = this.colorInputs;
      ci.blipColor = obj.radarColor;
      ci.objectDescFlags = obj.objectDescFlags ?? 0;
      ci.itemType = obj.itemType ?? 0;
      ci.isFellow = si.isFellow;
      ci.isFellowshipLeader = si.isFellowshipLeader;
      const rgba = selectBlipColor(ci);
      let css = this.cssOf.get(rgba);
      if (css === undefined) { css = radarRgbaToCss(rgba); this.cssOf.set(rgba, css); }
      d.color = css; d.guid = obj.guid;
      d.shape = selectBlipShape(si); d.name = obj.name;
      dots.push(d);
    }
    return dots;
  }
}
