import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { GfxObjDegradeInfo, type GfxObjLOD } from '@ac/dat-parser/file-types/GfxObjDegradeInfo.js';
import { LruMap } from '../utils/LruMap.js';
import { inheritPartState } from './PartMaterialState.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * CORE.17.h.g.c.c — retail's per-part LOD ("degrade") system.
 *
 * Every CPhysicsPart in the retail client draws `gfxobj[deg_level]`, an
 * array of GfxObjs built by CPhysicsPart::LoadGfxObjArray @ 0050dcf0 from
 * the part GfxObj's DIDDegrade (0x11 GfxObjDegradeInfo): one GfxObj per
 * level, INVALID_DID (0) meaning "draw nothing". The level is chosen by
 * GfxObjDegradeInfo::get_degrade @ 0051e4b0 from the viewer distance
 * (CPhysicsPart::UpdateViewerDistance @ 0050e030: |viewer − (part pos +
 * scale·sort_center)| / gfxobj_scale.z), Render::s_rDegradeDistance
 * (Config "Degrade Distance"), and a bias — Render::deg_mul when
 * Render::auto_update_deg_mul ("Adaptive Degrade") is on, else
 * Render::s_rUserSuppliedDegradeBias ("Adaptive Degrade Bias"). The
 * player's own parts are never degraded (physobj id == player_iid → level
 * 0, mode 1). A level's degrade_mode re-orients the drawn frame toward the
 * viewer (CPhysicsPart::calc_draw_frame @ 0050dfa0): 2 = Frame::
 * set_vector_heading (full billboard), 3/4/5 = Frame::rotate_around_axis_
 * to_vector around the part's local x/y/z.
 *
 * EoL portal.dat census (tools scratch, 2026-09-12): 4,131 DegradeInfos
 * referenced by 4,131 GfxObjs and 3,802 of 5,935 Setups; every chain ends
 * in an INVALID level (the object vanishes past its last real level); every
 * LOD GfxObj lists the identical surface array as its level 0 (retail draws
 * every level through the level-0 surfaces — CPhysicsPart::SetGfxObjArray
 * @ 0050e2e0 keeps `surfaces = gfxobj[0]->m_rgSurfaces`); modes 1: 13,501,
 * 2: 259, 4: 11, 5: 573 entries.
 *
 * See docs/retail-client-symbols.md (CORE.17.h.g.c.c) for the decomp
 * anchors, including the Render::CalcDegLevel @ 0054caf0 controller and the
 * min/ideal/max framerate constants recovered from acclient.exe.
 */

/** DIDs read as `IDClass::INVALID_DID` — a level with no GfxObj draws nothing. */
export const INVALID_DID = 0;

/**
 * CORE.17.h.g.c.c.c — RenderDeviceD3D::UpdateObjCell @ 005a0690: a cell's
 * `GetViewerDistance(&dir)` above MAX_CELL_2D_DEGRADE_DISTANCE (.rdata
 * 0x7e5788 = 50.0) hands that ONE distance (and heading) to every object in
 * the cell — CPhysicsObj::UpdateViewerDistance(dist, dir) → every part
 * evaluates get_degrade(dist / gfxobj_scale.z). CLandCell::GetViewerDistance
 * @ 00533140 is the viewer's HORIZONTAL distance to the land cell's
 * position (its centre — CLandBlockStruct::ConstructPolygons places cells at
 * (2i+1)·12 m; the z component is zeroed before the sqrt), so outdoors
 * beyond 50 m the height difference and the object's place inside its 24 m
 * cell drop out of the LOD pick. CObjCell::GetViewerDistance @ 0052b3e0
 * (env cells) returns 0: interiors always take the per-object path.
 */
export const MAX_CELL_2D_DEGRADE_DISTANCE = 50;
/** LandDefs square_length — the outdoor cell edge (m). */
export const LAND_CELL_SIZE = 24;

const _cell = new THREE.Vector3();

/** The centre of the land cell containing three.js world (x, z) → out.x / out.z; out.y = 0. */
export function landCellCenter(x: number, z: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  return out.set(
    (Math.floor(x / LAND_CELL_SIZE) + 0.5) * LAND_CELL_SIZE,
    0,
    (Math.floor(z / LAND_CELL_SIZE) + 0.5) * LAND_CELL_SIZE,
  );
}

/**
 * CLandCell::GetViewerDistance for the cell containing `pos`: the 2-D
 * (horizontal) distance from the viewer to that cell's centre; returns it
 * and leaves the centre (at the viewer's height, i.e. the pitch-free
 * heading source) in `outCenter`.
 */
export function landCellViewerDistance(pos: THREE.Vector3, viewer: THREE.Vector3, outCenter: THREE.Vector3 = _cell): number {
  landCellCenter(pos.x, pos.z, outCenter);
  outCenter.y = viewer.y;
  const dx = outCenter.x - viewer.x, dz = outCenter.z - viewer.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** GfxObjInfo.degrade_mode values consumed by CPhysicsPart::calc_draw_frame. */
export enum DegradeMode {
  /** Draw the part in its own frame. */
  Normal = 1,
  /** Frame::set_vector_heading(viewer_heading): AC local +Y along viewer → part (the viewer sees local −Y). */
  Billboard = 2,
  /** Frame::rotate_around_axis_to_vector(0, …): spin about local X. */
  AroundX = 3,
  /** … about local Y (AC). */
  AroundY = 4,
  /** … about local Z (AC up) — the cylindrical billboard. */
  AroundZ = 5,
}

/** Config-tab preferences that feed the level selection. */
export interface DegradePrefs {
  /** Render.DegradeDistance (0..100, default 50): closer parts stay at level 0. */
  degradeDistance: number;
  /** Render.GraphicsPerformance / s_rUserSuppliedDegradeBias (−1..1, default 0). */
  adaptiveDegradeBias: number;
  /** Render.AutomaticDegrades / auto_update_deg_mul (on in a fresh client). */
  adaptiveDegrade: boolean;
}

/**
 * The values a fresh retail client runs with: the static initialisers of the
 * preference variables, which UserPreferences::RegisterPreference binds and
 * leaves alone when UserPreferences.ini has no key — s_rDegradeDistance
 * `.data 0x81ec58` = 50, s_rUserSuppliedDegradeBias (.bss) = 0 and
 * VISUAL.town-scenery-gaps: auto_update_deg_mul `.data 0x81ec68` = TRUE.
 * gmConfigUI::InitOptions' SetDefaultValue(0) for Render_AutomaticDegrades
 * only sets UIOption_Checkbox::m_default, which RestoreDefaultValue (the
 * Defaults button) reads; it never writes the variable. So retail ships with
 * Automatic Degrades on, and CalcDegLevel drives deg_mul to 1 on any machine
 * above 25 fps: distant buildings, trees and rocks keep their detailed levels.
 */
export const RETAIL_DEGRADE_PREFS: Readonly<DegradePrefs> = Object.freeze({
  degradeDistance: 50,
  adaptiveDegradeBias: 0,
  adaptiveDegrade: true,
});

/**
 * GfxObjDegradeInfo::get_degrade @ 0051e4b0.
 *
 * ```
 * if degrades_disabled → 0
 * if force_level != −1 → min(force_level, n−1)
 * d = max(|dist| − s_rDegradeDistance, 0)
 * bias = auto ? deg_mul : s_rUserSuppliedDegradeBias
 * bias ≥ 0: first i with d < ideal_i + (max_i − ideal_i)·bias
 * bias < 0: first i with d < ideal_i + (ideal_i − min_i)·bias
 * else n−1
 * ```
 * So bias interpolates every threshold min → ideal → max (−1 → 0 → 1):
 * positive bias keeps detail longer, and the Degrade Distance SHIFTS every
 * threshold out by its value (CORE.17.h.g.c.c.c). Ghidra's C for the
 * distance reads like a gate (`|dist| − DD ≥ 0 ? dist : 0`), but the x87
 * sequence at 0051e523 is `fld dist; fabs; fsub [s_rDegradeDistance]; fst
 * [esp+8]; fcomp 0.0` — the SUBTRACTED value is stored back into the slot
 * the loop compares, so a tree with ideal 25 / 50 / 100 m stays full to
 * 75 m at the default 50 and the slider at 100 keeps it full to 125 m.
 */
export function selectDegradeLevel(
  degrades: readonly GfxObjLOD[],
  distance: number,
  degradeDistance: number,
  bias: number,
  forceLevel: number = -1,
  disabled: boolean = false,
): number {
  const n = degrades.length;
  if (n === 0) return 0;
  if (disabled) return 0;
  if (forceLevel !== -1) return forceLevel < n ? Math.max(0, forceLevel) : n - 1;
  const shifted = Math.abs(distance) - degradeDistance;
  const d = shifted >= 0 ? shifted : 0;
  if (bias >= 0) {
    for (let i = 0; i < n; i++) {
      const l = degrades[i];
      if (d < l.idealDist - (l.idealDist - l.maxDist) * bias) return i;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const l = degrades[i];
      if (d < (l.idealDist - l.minDist) * bias + l.idealDist) return i;
    }
  }
  return n - 1;
}

/**
 * CORE.17.h.g.c.c.a — what Render::SetDegradeLevelInternal @ 0054c3c0
 * derives from deg_mul besides storing it (x87 operands recovered from
 * acclient.exe .rdata; Ghidra folds the arithmetic into `_ftol2` calls):
 *
 * ```
 * p ≥ 0: object   = 25 + (50 − 25)·p   particle = 16 + (25 − 16)·p
 *        static   = int(40 + 20·p)     dynamic  = int(7 + 3·p)
 * p < 0: object   = 25 + (25 − 8)·p    particle = 16 + (16 − 8)·p
 *        static   = int(40 + 20·p)     dynamic  = int(7 + 2·p)
 * object_distance_2dsq = object², particle_distance_2dsq = particle²
 * ```
 * (constants at 0x7ca944/48/4c = 8/25/50, 0x7ca950/54/58 = 8/16/25,
 * 0x7caa00 = 40, 0x7ca9f8 = −20, 0x79b6d0 = 20, 0x7ca9fc = 7, 0x7ca9f4 =
 * −3). `_ftol2` truncates toward zero.
 */
export interface DegradeLevelDerived {
  /** Render::object_distance (m, 2-D): CPhysicsObj::UpdateViewerDistance @
   *  00510b30 switches from per-part sort-center distances (inside) to one
   *  object-origin distance for every part (outside). */
  objectSortDistance: number;
  /** Render::particle_distance (m, 2-D): the same switch for particle objects (state & 0x1000). */
  particleSortDistance: number;
  /** Render::max_static_lights — Render::add_static_light @ 0054d3e0's insert_light cap. */
  maxStaticLights: number;
  /** Render::max_dynamic_lights — Render::add_dynamic_light @ 0054d420's cap. */
  maxDynamicLights: number;
}

export function degradeLevelDerived(degMul: number): DegradeLevelDerived {
  const p = Math.max(-1, Math.min(1, degMul));
  if (p >= 0) {
    return {
      objectSortDistance: 25 + (50 - 25) * p,
      particleSortDistance: 16 + (25 - 16) * p,
      maxStaticLights: Math.trunc(40 + 20 * p),
      maxDynamicLights: Math.trunc(7 + 3 * p),
    };
  }
  return {
    objectSortDistance: 25 + (25 - 8) * p,
    particleSortDistance: 16 + (16 - 8) * p,
    maxStaticLights: Math.trunc(40 + 20 * p),
    maxDynamicLights: Math.trunc(7 + 2 * p),
  };
}

/**
 * The static initialisers `$E235 @ 007060c0` / `$E237 @ 007060d0` store
 * IDEAL_OBJECT_SORT_DISTANCE = 25.0 and IDEAL_PARTICLE_SORT_DISTANCE = 16.0
 * (0x7ca948 / 0x7ca954 — the same 25 / 16 the p = 0 formulas produce) into
 * the *_2dsq globals UNSQUARED, and SetDegradeLevelInternal is only ever
 * called from CalcDegLevel's auto path. So a client that never turns
 * Adaptive Degrade on compares the 2-D distance² against 25 and 16 — a
 * 5 m / 4 m switch — and the first adaptive update rewrites them to the
 * squared 25 + 25·p / 16 + 9·p. Modelled as-is (retail behaviour, not a
 * choice of ours). The light caps start at 40 / 7 (.data 0x81ec94/98).
 */
export const STARTUP_OBJECT_DISTANCE_2DSQ = 25.0;
export const STARTUP_PARTICLE_DISTANCE_2DSQ = 16.0;

/**
 * Render::CalcDegLevel @ 0054caf0 — the "Adaptive Degrade" controller.
 *
 * Runs every frame. Five fuzzy membership weights over the measured frame
 * rate (SceneTool::m_FramesPerSecond) around Render::min_framerate = 8,
 * ideal_framerate = 10, max_framerate = 20 (the .data initialisers at
 * 0x0081ec60 / 0x0081ec64 / 0x0081ec5c, read from acclient.exe) push
 * deg_mul by a weighted step (−0.15 · very-low, −0.02 · low, 0 · ideal,
 * +0.01 · high, +0.10 · very-high), clamped to [−1, 1]. A 30-entry history
 * (degmulhist) gives hysteresis: a candidate within 0.01 of any recent
 * value is dropped. When auto mode is off the history just tracks the
 * current deg_mul.
 *
 * Every accepted candidate goes through Render::SetDegradeLevelInternal @
 * 0054c3c0, which also derives max static / dynamic light counts and the
 * object / particle sort-distance cut-offs (`degradeLevelDerived`); those
 * live here as `derived` / `objectDistance2dSq` / `particleDistance2dSq`.
 */
export class DegMulController {
  static readonly MIN_FRAMERATE = 8;
  static readonly IDEAL_FRAMERATE = 10;
  static readonly MAX_FRAMERATE = 20;
  static readonly HISTORY = 30;
  static readonly HYSTERESIS = 0.01;

  private history = new Float32Array(DegMulController.HISTORY);
  private _degMul = 0;
  private _derived: DegradeLevelDerived = degradeLevelDerived(0);
  private _objectDistance2dSq = STARTUP_OBJECT_DISTANCE_2DSQ;
  private _particleDistance2dSq = STARTUP_PARTICLE_DISTANCE_2DSQ;

  /**
   * VISUAL.town-scenery-gaps — harness-only: the deg_mul the controller holds
   * instead of following the frame rate (null = retail CalcDegLevel). A
   * SwiftShader capture runs at ~2 fps, where the faithful controller sinks
   * to −1 (every distant object at its lowest level) and the frame depends
   * on the moment it was taken; pinned to 1 it shows what a real GPU settles
   * to. Set only by main.ts's debug-gated harnessDegMulPin.
   */
  private _pinned: number | null = null;
  private _pinApplied = false;

  /** Render::deg_mul — the bias used while Adaptive Degrade is on. */
  get degMul(): number { return this._degMul; }

  get pinned(): number | null { return this._pinned; }

  /** Hold deg_mul at `value` while Adaptive Degrade is on (null releases it). */
  pin(value: number | null): void {
    this._pinned = value === null ? null : Math.max(-1, Math.min(1, value));
    this._pinApplied = false;
  }

  /** The light caps + sort distances SetDegradeLevelInternal last derived
   *  (the startup values until the first adaptive update). */
  get derived(): Readonly<DegradeLevelDerived> { return this._derived; }

  /** Render::object_distance_2dsq — compared against the 2-D viewer distance². */
  get objectDistance2dSq(): number { return this._objectDistance2dSq; }

  /** Render::particle_distance_2dsq. */
  get particleDistance2dSq(): number { return this._particleDistance2dSq; }

  /** Render::SetDegradeLevelInternal(v): store deg_mul and re-derive the caps / cut-offs. */
  set(value: number): void {
    // deg_mul is a float (.bss 0x86630c): stored at float32 precision, so the
    // +0.1 climb lands on 1.0000001 and clamps to exactly 1, as retail's does
    // (in doubles ten steps stop at 0.9999999999999999 and the 1.0 candidate
    // is then within the hysteresis of it — max_static_lights 59, not 60).
    this._degMul = Math.fround(Math.max(-1, Math.min(1, value)));
    this._derived = degradeLevelDerived(this._degMul);
    this._objectDistance2dSq = this._derived.objectSortDistance * this._derived.objectSortDistance;
    this._particleDistance2dSq = this._derived.particleSortDistance * this._derived.particleSortDistance;
  }

  /** One CalcDegLevel pass; returns the (possibly updated) deg_mul. */
  tick(framesPerSecond: number, autoUpdate: boolean): number {
    const h = this.history;
    h.copyWithin(0, 1);
    if (!autoUpdate) { h[h.length - 1] = this._degMul; return this._degMul; }
    if (this._pinned !== null) {
      if (!this._pinApplied) { this.set(this._pinned); this._pinApplied = true; }
      h[h.length - 1] = this._degMul;
      return this._degMul;
    }

    const min = DegMulController.MIN_FRAMERATE;
    const ideal = DegMulController.IDEAL_FRAMERATE;
    const max = DegMulController.MAX_FRAMERATE;
    const fps = framesPerSecond;
    const lo = min * 0.75;
    const a = min * 0.25 + ideal * 0.75;
    const b = min * 0.5 + ideal * 0.5;
    const c = max * 0.5 + ideal * 0.5;
    const e = max * 0.25 + ideal * 0.75;
    const hi = max * 1.25;
    const clamp0 = (x: number) => (x < 0 ? 0 : x);
    const wVeryLow = fps < lo ? 1 : clamp0(1 - Math.abs(fps - lo) / (b - lo));
    const f2 = fps + fps;
    const wLow = clamp0(1 - Math.abs(f2 - (a + min)) / (a - min));
    const wIdeal = clamp0(1 - Math.abs(f2 - (c + b)) / (c - b));
    const wHigh = clamp0(1 - Math.abs(f2 - (max + e)) / (max - e));
    const wVeryHigh = fps > hi ? 1 : clamp0(1 - Math.abs(fps - hi) / (hi - c));
    const sum = wVeryHigh + wHigh + wIdeal + wLow + wVeryLow;
    if (sum > 0) {
      let next = Math.fround(Math.fround((0.1 * wVeryHigh + 0.01 * wHigh + 0 * wIdeal + (-0.15 * wVeryLow - 0.02 * wLow)) / sum) + this._degMul);
      if (next > 1) next = 1; else if (next < -1) next = -1;
      let recent = false;
      for (let i = 0; i < h.length; i++) {
        if (Math.abs(h[i] - next) < DegMulController.HYSTERESIS) { recent = true; break; }
      }
      if (!recent) this.set(next);
    }
    h[h.length - 1] = this._degMul;
    return this._degMul;
  }
}

/** Per-GfxObj degrade chain: the DAT levels and their GfxObj IDs (0 = INVALID). */
export interface DegradeChain {
  /** The 0x11 file id (= the owning GfxObj's DIDDegrade). */
  infoId: number;
  degrades: GfxObjLOD[];
  /** degrades[i].gfxObjId, INVALID_DID for "draw nothing". */
  levelIds: number[];
  /** Level-0 GfxObj sort center in three.js part-local space (AC x,z,y → x,y,z). */
  sortCenter: THREE.Vector3;
}

/** Structural slice of a portal DAT this module needs (keeps tests DAT-free). */
export interface DegradeDatSource {
  getFileData(fileId: number): ArrayBuffer | null;
}

/** Whether the level's degrade_mode re-orients the part toward the viewer. */
export function isBillboardMode(mode: number): boolean {
  return mode === DegradeMode.Billboard || mode === DegradeMode.AroundX
    || mode === DegradeMode.AroundY || mode === DegradeMode.AroundZ;
}

const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
// AC local axis (x, y, z) → three.js local axis column (x, z, y); the third
// column follows the right-handed cyclic order axis → target → third that
// Frame::rotate_around_axis_to_vector's `local_c = {2, 0, 1}` table encodes
// (AC: x→z→y, y→x→z, z→y→x) after the Y/Z swap.
const AXIS_SLOTS: Record<number, [number, number, number]> = {
  [DegradeMode.AroundX]: [0, 1, 2], // AC x = three X; target AC z = three Y; third = Z
  [DegradeMode.AroundY]: [2, 0, 1], // AC y = three Z; target AC x = three X; third = Y
  [DegradeMode.AroundZ]: [1, 2, 0], // AC z = three Y; target AC y = three Z; third = X
};

/**
 * CPhysicsPart::calc_draw_frame @ 0050dfa0 in three.js space: given the
 * part's world rotation, its world position and the viewer position, return
 * the world rotation the level is drawn with. Mode 1 (or a degenerate
 * viewer direction) returns the input rotation unchanged.
 *
 * `viewer_heading` is the direction FROM the viewer TO the part:
 * CPhysicsPart::UpdateViewerDistance @ 0050e030 takes it from
 * `Position::get_offset(&Render::viewer_pos, …, &this->pos, sort_center)`
 * @ 0050d920, which returns (part point + block offset) − viewer origin
 * (and CPhysicsObj::UpdateViewerDistance @ 00510b30 the same for the
 * object origin). So the drawn frame's heading axis points AWAY from the
 * viewer and the viewer sees the GfxObj from its −Y side — the side the
 * DAT's quads are textured for (e.g. the particle quad 0x010016C8: u grows
 * with +x, v with −z, unmirrored only when seen from −y).
 * (VISUAL.particles-oriented-quads: this used to point the axis AT the
 * viewer — a 180° yaw that mirrored every billboard's texture.)
 *
 * - Billboard (2): Frame::set_vector_heading — AC local +Y (three local +Z)
 *   along the viewer heading, pitch included, roll 0 (euler_set_rotate(
 *   pitch, 0, yaw)): the quad's local X stays horizontal.
 * - AroundX/Y/Z (3/4/5): the heading projected onto the plane ⊥ the chosen
 *   local axis becomes the next local axis; the axis itself is kept, the
 *   third is their cross product. A viewer straight along the axis
 *   (normalize_check_small) leaves the frame alone.
 */
export function billboardRotation(
  mode: number,
  worldRotation: THREE.Quaternion,
  worldPosition: THREE.Vector3,
  viewerPosition: THREE.Vector3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  _d.subVectors(worldPosition, viewerPosition);
  if (_d.lengthSq() < 1e-12) return out.copy(worldRotation);
  _d.normalize();
  if (mode === DegradeMode.Billboard) {
    _x.crossVectors(UP, _d);
    if (_x.lengthSq() < 1e-12) return out.copy(worldRotation);
    _x.normalize();
    _y.crossVectors(_d, _x);
    _m.makeBasis(_x, _y, _d);
    return out.setFromRotationMatrix(_m);
  }
  const slots = AXIS_SLOTS[mode];
  if (!slots) return out.copy(worldRotation);
  const [axisSlot, targetSlot, thirdSlot] = slots;
  _a.set(axisSlot === 0 ? 1 : 0, axisSlot === 1 ? 1 : 0, axisSlot === 2 ? 1 : 0).applyQuaternion(worldRotation);
  const dot = _a.dot(_d);
  _x.copy(_d).addScaledVector(_a, -dot);
  if (_x.lengthSq() < 1e-10) return out.copy(worldRotation);
  _x.normalize();
  _y.crossVectors(_a, _x);
  const cols: THREE.Vector3[] = [];
  cols[axisSlot] = _a; cols[targetSlot] = _x; cols[thirdSlot] = _y;
  _m.makeBasis(cols[0], cols[1], cols[2]);
  return out.setFromRotationMatrix(_m);
}

interface PartEntry {
  part: THREE.Object3D;
  /** The CPhysicsObj the part belongs to (its origin drives the far-branch
   *  distance); null = resolve as the part's parent at update time. */
  object: THREE.Object3D | null;
  chain: DegradeChain;
  build: (gfxObjId: number) => THREE.Object3D | null;
  /** Level → holder group (undefined = not built yet, null = INVALID / failed). */
  holders: (THREE.Object3D | null | undefined)[];
  /** Level-0 meshes as created (direct children of the part) — the GfxObj
   *  the part was built from. Drawn at level 0 only when `level0IsBase`. */
  base: THREE.Object3D[];
  /** CORE.17.h.g.c.c.c — degrades[0].gfxobj_id == the part's own GfxObj.
   *  LoadGfxObjArray loads degrades[i].gfxobj_id for EVERY level, so when
   *  the chain names another GfxObj (229 EoL chains) or INVALID at level 0,
   *  the base meshes are never drawn. */
  level0IsBase: boolean;
  level: number;
}

/** Which position the viewer distance / heading was measured from. */
type DistanceSource = 'part' | 'object' | 'cell';

const _cc = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _op = new THREE.Vector3();
/** updateParts ancestor-walk bits (per-parent memo). */
const ANC_IN_SCENE = 1;
const ANC_EXCLUDED = 2;
const ANC_LAND_CELL = 4;

/**
 * CPhysicsObj::UpdateViewerDistance @ 00510b30: with the viewer's 2-D
 * (horizontal — three.js x/z) distance² to the OBJECT origin below
 * Render::object_distance_2dsq every part measures its own sort-center
 * distance (CPhysicsPart::UpdateViewerDistance @ 0050e030); at or beyond
 * it every part takes the object-origin distance and heading
 * (CPartArray::UpdateViewerDistance(dist, dir) @ 00518290 →
 * CPhysicsPart::UpdateViewerDistance(this, dist, dir) @ 0050e1a0).
 */
export function usesObjectDistance(objectPos: THREE.Vector3, viewerPos: THREE.Vector3, objectDistance2dSq: number): boolean {
  const dx = objectPos.x - viewerPos.x;
  const dz = objectPos.z - viewerPos.z;
  return dx * dx + dz * dz >= objectDistance2dSq;
}

/**
 * The degrade system: loads chains, owns the preferences + controller, and
 * drives the per-object `part_N` groups SetupModelRenderer registers.
 * (Instanced scenery/statics/buildings run the same selection inside
 * SceneryInstancePool.updateLod, sharing `prefs`/`bias`/`chainFor`.)
 */
export class DegradeLod {
  /** Mark an object (e.g. the player's own model) so its parts never degrade. */
  static readonly NO_DEGRADE_KEY = 'acNoDegrade';
  /** Mark an object as living in a LAND cell (outdoors): beyond
   *  MAX_CELL_2D_DEGRADE_DISTANCE its parts measure the cell centre's 2-D
   *  viewer distance (RenderDeviceD3D::UpdateObjCell). Unset = an env-cell
   *  object, always the per-object distance. */
  static readonly LAND_CELL_KEY = 'acLandCell';

  readonly controller = new DegMulController();
  private _prefs: DegradePrefs = { ...RETAIL_DEGRADE_PREFS };
  /** Render::force_level (−1 = off) — debug aid mirrored from retail. */
  forceLevel = -1;
  /** SmartBox::DisableDegrades / degrades_disabled. */
  disabled = false;

  private chains = new LruMap<number, DegradeChain | null>(4096);
  private parts = new Set<PartEntry>();
  private fpsEma = 0;

  constructor(private readonly portal: DegradeDatSource | null) {}

  get prefs(): Readonly<DegradePrefs> { return this._prefs; }

  /** Update any subset of the preferences; returns whether one changed. */
  setPrefs(p: Partial<Record<keyof DegradePrefs, unknown>>): boolean {
    let changed = false;
    if (typeof p.degradeDistance === 'number' && isFinite(p.degradeDistance)) {
      const v = Math.max(0, Math.min(100, p.degradeDistance));
      if (v !== this._prefs.degradeDistance) { this._prefs.degradeDistance = v; changed = true; }
    }
    if (typeof p.adaptiveDegradeBias === 'number' && isFinite(p.adaptiveDegradeBias)) {
      const v = Math.max(-1, Math.min(1, p.adaptiveDegradeBias));
      if (v !== this._prefs.adaptiveDegradeBias) { this._prefs.adaptiveDegradeBias = v; changed = true; }
    }
    if (typeof p.adaptiveDegrade === 'boolean' && p.adaptiveDegrade !== this._prefs.adaptiveDegrade) {
      this._prefs.adaptiveDegrade = p.adaptiveDegrade; changed = true;
    }
    return changed;
  }

  /** The bias get_degrade sees: deg_mul under Adaptive Degrade, else the slider. */
  get bias(): number {
    return this._prefs.adaptiveDegrade ? this.controller.degMul : this._prefs.adaptiveDegradeBias;
  }

  /** Per-frame: feed the controller the smoothed frame rate. */
  tick(dt: number): void {
    if (dt > 0 && isFinite(dt)) {
      const fps = 1 / dt;
      this.fpsEma = this.fpsEma === 0 ? fps : this.fpsEma + (fps - this.fpsEma) * Math.min(1, dt * 2);
    }
    this.controller.tick(this.fpsEma, this._prefs.adaptiveDegrade);
  }

  /** Smoothed frame rate the controller last saw. */
  get framesPerSecond(): number { return this.fpsEma; }

  /** Select a level for one part at `distance` (already divided by scale z). */
  levelFor(chain: DegradeChain, distance: number): number {
    return selectDegradeLevel(chain.degrades, distance, this._prefs.degradeDistance, this.bias, this.forceLevel, this.disabled);
  }

  /** Render::object_distance_2dsq as the controller currently holds it. */
  get objectDistance2dSq(): number { return this.controller.objectDistance2dSq; }

  /**
   * CPhysicsPart::LoadGfxObjArray: the chain for a part GfxObj, or null when
   * it carries no DIDDegrade / the 0x11 file is missing. Cached per GfxObj.
   */
  chainFor(gfxObjId: number): DegradeChain | null {
    const cached = this.chains.get(gfxObjId);
    if (cached !== undefined) return cached;
    const missEpoch = datMissEpoch();
    let chain: DegradeChain | null = null;
    if (this.portal) {
      try {
        const data = this.portal.getFileData(gfxObjId);
        if (data) {
          const gfx = new GfxObj(new DatReader(data));
          if (gfx.didDegrade) {
            const info = this.portal.getFileData(gfx.didDegrade);
            if (info) {
              const parsed = GfxObjDegradeInfo.read(new DatReader(info));
              if (parsed.degrades.length > 0) {
                chain = {
                  infoId: gfx.didDegrade,
                  degrades: parsed.degrades,
                  levelIds: parsed.degrades.map(l => (l.gfxObjId === 0xffffffff ? INVALID_DID : l.gfxObjId)),
                  sortCenter: new THREE.Vector3(gfx.sortCenter.x, gfx.sortCenter.z, gfx.sortCenter.y),
                };
              }
            }
          }
        }
      } catch {
        chain = null;
      }
    }
    // RELEASE.streaming-regression-gate — a GfxObj / DegradeInfo that missed: retried next time.
    if (noDatMissSince(missEpoch)) this.chains.set(gfxObjId, chain);
    return chain;
  }

  /** Test/debug: seed a chain without a DAT. */
  setChain(gfxObjId: number, chain: DegradeChain | null): void {
    this.chains.set(gfxObjId, chain);
  }

  /**
   * Register a `part_N` group (its level-0 meshes are its current children).
   * `build(levelGfxObjId)` creates that level's meshes with the same
   * overrides/palette as the base — the level GfxObj lists the identical
   * surfaces, so the materials match retail's shared surface array.
   */
  attachPart(
    part: THREE.Object3D,
    gfxObjId: number,
    build: (gfxObjId: number) => THREE.Object3D | null,
    object: THREE.Object3D | null = null,
  ): boolean {
    const chain = this.chainFor(gfxObjId);
    if (!chain) return false;
    const entry: PartEntry = {
      part, object, chain, build,
      holders: [],
      base: [...part.children],
      level0IsBase: chain.levelIds[0] === gfxObjId,
      level: 0,
    };
    part.userData.acDegrade = { infoId: chain.infoId, levels: chain.levelIds.length, level: 0 };
    this.parts.add(entry);
    if (!entry.level0IsBase) {
      // The part draws gfxobj[0] = degrades[0].gfxobj_id from its first
      // frame: swap the base meshes for that GfxObj now (INVALID → nothing).
      for (const m of entry.base) m.visible = false;
      const h0 = this.holderFor(entry, 0);
      if (h0) h0.visible = true;
    }
    return true;
  }

  /** updateParts' per-call ancestor memo (parent → ANC_* bits). */
  private readonly ancestorMemo = new Map<THREE.Object3D, number>();

  /** Registered part count (pruned lazily as objects leave the scene). */
  get partCount(): number { return this.parts.size; }

  /**
   * Per-frame: CPhysicsPart::UpdateViewerDistance for every registered part.
   *
   * `worldScene` — the scene `viewerPos` belongs to. A part in another
   * scene (the chargen appearance / summary views, the barber, the examine
   * portrait, portal space: CreatureMode viewports with their own camera a
   * few metres away) is drawn at level 0, never degraded by the WORLD
   * camera's distance. BUG.chargen-preview-after-sweep: after a world
   * session the camera stayed where the player had been, hundreds of metres
   * from those views' origin, so every body part with a DIDDegrade went to
   * its last (INVALID) level and the next chargen showed only the head.
   * Without `worldScene` every scene counts (the old behaviour).
   */
  updateParts(viewerPos: THREE.Vector3, worldScene?: THREE.Object3D | null): void {
    // REND.per-frame-allocations — the ancestor walk below is memoized per
    // PARENT for this call only: a setup's parts share one parent, so the
    // chain is walked once per object instead of once per part. Rebuilt
    // every call, so reparenting / scene.remove / flag changes between
    // frames are always seen.
    const memo = this.ancestorMemo;
    memo.clear();
    for (const entry of this.parts) {
      const part = entry.part;
      // Prune parts whose object left the scene; honour the no-degrade mark
      // (the player's own model) anywhere up the chain (the part itself
      // excluded, as before — only its LAND_CELL_KEY is read).
      const parent = part.parent;
      let bits = 0;
      if (parent) {
        const known = memo.get(parent);
        if (known !== undefined) {
          bits = known;
        } else {
          let root: THREE.Object3D = parent;
          while (true) {
            if (root.userData[DegradeLod.NO_DEGRADE_KEY]) bits |= ANC_EXCLUDED;
            if (root.userData[DegradeLod.LAND_CELL_KEY]) bits |= ANC_LAND_CELL;
            if (!root.parent) break;
            root = root.parent;
          }
          if ((root as THREE.Scene).isScene) {
            bits |= ANC_IN_SCENE;
            // Another scene's viewport: its own camera, so level 0 here.
            if (worldScene && root !== worldScene) bits |= ANC_EXCLUDED;
          }
          memo.set(parent, bits);
        }
      }
      const excluded = (bits & ANC_EXCLUDED) !== 0;
      const landCell = !!part.userData[DegradeLod.LAND_CELL_KEY] || (bits & ANC_LAND_CELL) !== 0;
      // Detached (scene.remove / disposed): retire the entry — an object that
      // is re-added gets rebuilt through SetupModelRenderer and re-registers.
      // (A parentless part is its own root, never a Scene.)
      if ((bits & ANC_IN_SCENE) === 0) { this.parts.delete(entry); continue; }
      let level = 0;
      let from: DistanceSource = 'part';
      if (!excluded) {
        part.matrixWorld.decompose(_wp, _wq, _ws);
        const scaleZ = _ws.y > 1e-6 ? _ws.y : 1;
        this.objectPosition(entry, _op);
        let dist: number;
        // CORE.17.h.g.c.c.c — RenderDeviceD3D::UpdateObjCell: a land cell
        // beyond MAX_CELL_2D_DEGRADE_DISTANCE hands its own 2-D distance to
        // every object in it.
        const cellDist = landCell ? landCellViewerDistance(_op, viewerPos, _cc) : 0;
        if (landCell && cellDist > MAX_CELL_2D_DEGRADE_DISTANCE) {
          from = 'cell';
          dist = cellDist / scaleZ;
        } else if (usesObjectDistance(_op, viewerPos, this.objectDistance2dSq)) {
          from = 'object';
          dist = _op.distanceTo(viewerPos) / scaleZ;
        } else {
          _d.copy(entry.chain.sortCenter).applyMatrix4(part.matrixWorld);
          dist = _d.distanceTo(viewerPos) / scaleZ;
        }
        level = this.levelFor(entry.chain, dist);
      }
      if (level !== entry.level) this.applyLevel(entry, level);
      const mode = entry.chain.degrades[entry.level]?.degradeMode ?? DegradeMode.Normal;
      if (!excluded && isBillboardMode(mode)) this.orientHolder(entry, viewerPos, from);
    }
  }

  /** World position of the part's CPhysicsObj (the setup group / the bare GfxObj group). */
  private objectPosition(entry: PartEntry, out: THREE.Vector3): THREE.Vector3 {
    const obj = entry.object ?? entry.part.parent ?? entry.part;
    const e = obj.matrixWorld.elements;
    return out.set(e[12], e[13], e[14]);
  }

  private holderFor(entry: PartEntry, level: number): THREE.Object3D | null {
    const existing = entry.holders[level];
    if (existing !== undefined) return existing;
    let holder: THREE.Object3D | null = null;
    if (level === 0 && entry.level0IsBase) {
      // Level 0 draws the base meshes; wrap them only when a billboard mode
      // needs an orientable frame of their own.
      holder = new THREE.Group();
      holder.name = 'lod_0';
      for (const m of entry.base) holder.add(m);
      entry.part.add(holder);
    } else {
      const id = entry.chain.levelIds[level];
      if (id !== INVALID_DID) {
        const built = entry.build(id);
        if (built) {
          holder = built;
          holder.name = `lod_${level}`;
          holder.position.set(0, 0, 0);
          holder.quaternion.identity();
          holder.scale.set(1, 1, 1);
          entry.part.add(holder);
          // RENDER.lazy-lod-misses-state — every level shares the part's
          // surface array and CMaterial in retail (SetGfxObjArray @
          // 0050e2e0): the new level starts in the object's light set and
          // with the part's translucency / luminosity / diffuse.
          inheritPartState(entry.part, holder, entry.base);
        }
      }
    }
    entry.holders[level] = holder;
    return holder;
  }

  private applyLevel(entry: PartEntry, level: number): void {
    // Hide the previous level.
    if (entry.level === 0) {
      const h0 = entry.holders[0];
      if (h0) h0.visible = false; else for (const m of entry.base) m.visible = false;
    } else {
      const h = entry.holders[entry.level];
      if (h) h.visible = false;
    }
    entry.level = level;
    (entry.part.userData.acDegrade as { level: number }).level = level;
    if (level === 0) {
      const mode = entry.chain.degrades[0]?.degradeMode ?? DegradeMode.Normal;
      if (!entry.level0IsBase || isBillboardMode(mode)) {
        const h0 = this.holderFor(entry, 0);
        if (h0) h0.visible = true;
      } else {
        const h0 = entry.holders[0];
        if (h0) h0.visible = true; else for (const m of entry.base) m.visible = true;
      }
      return;
    }
    const h = this.holderFor(entry, level);
    if (h) h.visible = true;
  }

  /** viewer_heading is measured from the sort center inside the object sort
   *  distance, from the object origin beyond it (the far branch hands
   *  every part the object-level direction), and from the land cell's
   *  centre — a horizontal heading — beyond MAX_CELL_2D_DEGRADE_DISTANCE. */
  private orientHolder(entry: PartEntry, viewerPos: THREE.Vector3, from: DistanceSource): void {
    const holder = this.holderFor(entry, entry.level);
    if (!holder) return;
    const mode = entry.chain.degrades[entry.level].degradeMode;
    entry.part.matrixWorld.decompose(_wp, _wq, _ws);
    if (from === 'cell') { this.objectPosition(entry, _op); landCellViewerDistance(_op, viewerPos, _d); }
    else if (from === 'object') this.objectPosition(entry, _d);
    else _d.copy(entry.chain.sortCenter).applyMatrix4(entry.part.matrixWorld);
    billboardRotation(mode, _wq, _d, viewerPos, _bq);
    // holder local = inverse(part world rotation) × billboard world rotation
    _inv.copy(_wq).invert();
    holder.quaternion.copy(_inv.multiply(_bq));
  }

  /** Force every registered part back to level 0 (e.g. when disabling). */
  resetParts(): void {
    for (const entry of this.parts) if (entry.level !== 0) this.applyLevel(entry, 0);
  }

  /** Debug census: registered parts by current level. */
  levelCensus(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const e of this.parts) out[e.level] = (out[e.level] ?? 0) + 1;
    return out;
  }
}
