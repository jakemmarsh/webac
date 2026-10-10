/**
 * SelectionLighting — the retail 3D-view selection feedback (CORE.17.k.b.b.a.g.b).
 *
 * Retail draws NO text in the 3D view for the selected object: its name lives
 * in the toolbar's selected-item field (0x21000016:0x1000019f) and the object
 * itself is lit up. Ground truth (decompiled EoL client, build ac1_sep13):
 *
 *  - `UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0`:
 *    when the found object differs from the lit one, the lit one gets
 *    `CPhysicsObj::RestoreLighting` and the wrapper forgets it. A find whose
 *    `m_SearchReason` is above `sr_MouseOver` (a click-select, an examine
 *    mouse-up, a double-click use, a drop, a drag, a targeted use) then
 *    `SetLighting(LIGHT_HIGH_MIN, LIGHT_HIGH_MAX)` on the object at once,
 *    `m_cFlipCount = 1`, `m_timeNextFlip = Timer::cur_time + SELECTION_FLIP_TIME`,
 *    and — unless the reason is `sr_Drop` or `sr_TargetedUse` —
 *    `ACCWeenieObject::SetSelectedObject(id, 0)`.
 *  - `UIElement_SmartBoxWrapper::Global_Loop @ 004e5620`: once
 *    `m_timeNextFlip <= Timer::cur_time`, `++m_cFlipCount`; below 5 the timer is
 *    re-armed and the mode is `(count & 1) ? LM_HIGH_LIGHTING : LM_LOW_LIGHTING`;
 *    at 5 the count resets and the mode is `LM_RESTORE_LIGHTING`.
 *    `ApplyLighting @ 004e5320` maps the mode onto `CPhysicsObj::SetLighting` /
 *    `RestoreLighting` — so a select is HIGH → LOW → HIGH → LOW → restore, one
 *    SELECTION_FLIP_TIME per step.
 *  - `CPhysicsPart::SetLighting @ 0050e400`: a non-default pair copies the
 *    part's material (`CopyMaterial`) and writes `CMaterial::SetLuminositySimple`
 *    (D3DMATERIAL9.Emissive = grey) + `SetDiffuseSimple` (Diffuse = grey);
 *    `RestoreLighting @ 0050e4a0` drops the copy. In the fixed-function
 *    pipeline the emissive term is part of the vertex colour that is clamped
 *    and then MODULATEs the texel — a luminosity of 0.99 renders the object at
 *    its raw texel brightness ("fullbright"), not washed out white.
 *  - The constants live in acclient.exe .rdata (`ApplyLighting`'s `mov` operands,
 *    `Global_Loop`'s `fadd` operand): LIGHT_LOW_MIN @ 0x7bfe78 = 0.0,
 *    LIGHT_LOW_MAX @ 0x7bfe7c = 0.35, LIGHT_HIGH_MIN @ 0x7bfe80 = 0.99,
 *    LIGHT_HIGH_MAX @ 0x7bfe84 = 1.0 (floats; MIN = luminosity, MAX = diffuse,
 *    the argument order of `SetLighting(float luminosity, float diffuse)`),
 *    SELECTION_FLIP_TIME @ 0x7bfe88 = 0.2 (double, seconds).
 *
 * The same constants drive `gmPaperDollUI::UpdatePartSelectionLighting @
 * 004a4360` (the paperdoll's part blink) — not ported here.
 */

import * as THREE from 'three';
import { partMeshes } from '../models/ObjectTranslucency.js';
import { applyRetailLighting, retailLightingKindOf, setMaterialLuminosity, srgbToLinear } from '../models/RetailLighting.js';

/** `SearchReason` (acclient.pdb): why the SmartBox looked for an object. */
export const enum SearchReason {
  None = 0,
  MouseOver = 1,
  Select = 2,
  Examine = 3,
  Use = 4,
  Drop = 5,
  Drag = 6,
  TargetedUse = 7,
}

/** `LightingMode` (acclient.pdb) as `ApplyLighting` switches on it. */
export type LightingMode = 'restore' | 'low' | 'high';

/** One `CPhysicsObj::SetLighting(luminosity, diffuse)` pair. */
export interface LightingLevels {
  /** D3DMATERIAL9.Emissive grey (`CMaterial::SetLuminositySimple`). */
  luminosity: number;
  /** D3DMATERIAL9.Diffuse grey (`CMaterial::SetDiffuseSimple`). */
  diffuse: number;
}

/** LIGHT_LOW_MIN / LIGHT_LOW_MAX — acclient.exe .rdata 0x7bfe78 / 0x7bfe7c. */
export const LIGHT_LOW: LightingLevels = { luminosity: 0.0, diffuse: 0.35 };
/** LIGHT_HIGH_MIN / LIGHT_HIGH_MAX — acclient.exe .rdata 0x7bfe80 / 0x7bfe84. */
export const LIGHT_HIGH: LightingLevels = { luminosity: 0.99, diffuse: 1.0 };
/** SELECTION_FLIP_TIME — acclient.exe .rdata 0x7bfe88 (double), seconds. */
export const SELECTION_FLIP_TIME = 0.2;
/** `Global_Loop`: the count at which the blink ends (`uVar1 < 5` re-arms). */
export const SELECTION_FLIP_END_COUNT = 5;

/** The levels a mode applies (`ApplyLighting @ 004e5320`); null = restore. */
export function lightingLevelsForMode(mode: LightingMode): LightingLevels | null {
  if (mode === 'high') return LIGHT_HIGH;
  if (mode === 'low') return LIGHT_LOW;
  return null;
}

/** `RecvNotice_SmartBoxObjectFound`'s `1 < m_SearchReason` gate. */
export function searchReasonLights(reason: SearchReason): boolean {
  return reason > SearchReason.MouseOver;
}

/** `RecvNotice_SmartBoxObjectFound`: reasons that do NOT `SetSelectedObject`. */
export function searchReasonSelects(reason: SearchReason): boolean {
  return searchReasonLights(reason) && reason !== SearchReason.Drop && reason !== SearchReason.TargetedUse;
}

export interface SelectionFlipStep {
  /** The new `m_cFlipCount` (0 once the blink has ended). */
  flipCount: number;
  /** The `LightingMode` handed to `ApplyLighting`. */
  mode: LightingMode;
  /** Whether `m_timeNextFlip` is re-armed for another SELECTION_FLIP_TIME. */
  rearm: boolean;
}

/**
 * One due tick of `Global_Loop @ 004e5620` for a non-zero `m_cFlipCount`:
 * `++count`; `< 5` → re-arm, odd = HIGH / even = LOW; else count 0, restore.
 */
export function selectionFlipStep(flipCount: number): SelectionFlipStep {
  const next = flipCount + 1;
  if (next < SELECTION_FLIP_END_COUNT) {
    return { flipCount: next, mode: (next & 1) !== 0 ? 'high' : 'low', rearm: true };
  }
  return { flipCount: 0, mode: 'restore', rearm: false };
}

/** Where the modes land — `UIElement_SmartBoxWrapper::ApplyLighting`'s target. */
export interface SelectionLightingSink {
  applyLighting(guid: number, mode: LightingMode): void;
}

/**
 * The wrapper's three fields (`m_iidSelectedObject`, `m_cFlipCount`,
 * `m_timeNextFlip`) and the two entry points that touch them. Times are
 * seconds (Timer::cur_time).
 */
export class SelectionLighting {
  /** `m_iidSelectedObject` — the object currently carrying a lighting override. */
  litGuid = 0;
  /** `m_cFlipCount` — 0 = idle. */
  flipCount = 0;
  /** `m_timeNextFlip` (seconds). */
  timeNextFlip = 0;

  constructor(private readonly sink: SelectionLightingSink) {}

  /**
   * `RecvNotice_SmartBoxObjectFound(id)` with the wrapper's `m_SearchReason`.
   * Returns true when the retail path calls `SetSelectedObject(id, 0)` — the
   * caller owns the selection bookkeeping (toolbar field, queries).
   */
  objectFound(guid: number, reason: SearchReason, now: number): boolean {
    if (this.litGuid !== guid && this.litGuid !== 0) {
      this.sink.applyLighting(this.litGuid, 'restore');
      this.litGuid = 0;
    }
    if (guid === 0) return false;
    if (!searchReasonLights(reason)) return false;
    this.sink.applyLighting(guid, 'high');
    this.litGuid = guid;
    this.flipCount = 1;
    this.timeNextFlip = now + SELECTION_FLIP_TIME;
    return searchReasonSelects(reason);
  }

  /** `Global_Loop`'s flip bookkeeping — call once per frame. */
  loop(now: number): void {
    if (this.flipCount === 0 || this.timeNextFlip > now) return;
    const step = selectionFlipStep(this.flipCount);
    this.flipCount = step.flipCount;
    if (step.rearm) this.timeNextFlip = now + SELECTION_FLIP_TIME;
    this.sink.applyLighting(this.litGuid, step.mode);
  }

  /** The lit object left the world (ObjectDelete / teardown): forget it. */
  forget(guid: number): void {
    if (this.litGuid !== guid) return;
    this.litGuid = 0;
  }

  /** Restore whatever is lit and go idle. */
  clear(): void {
    if (this.litGuid !== 0) this.sink.applyLighting(this.litGuid, 'restore');
    this.litGuid = 0;
    this.flipCount = 0;
    this.timeNextFlip = 0;
  }
}

// ── CPhysicsPart::SetLighting / RestoreLighting on a three.js object tree ────

/** A part's material before `CopyMaterial` — keyed by the mesh that carries the copy. */
export type LightingCopies = Map<THREE.Mesh, THREE.Material | THREE.Material[]>;

/** A material that carries D3DMATERIAL9.Emissive + Diffuse (the lit Lambert kind). */
function isLitMaterial(m: THREE.Material): m is THREE.MeshLambertMaterial {
  return (m as THREE.MeshLambertMaterial).emissive instanceof THREE.Color
    && (m as THREE.MeshLambertMaterial).color instanceof THREE.Color;
}

/**
 * `CPhysicsPart::CopyMaterial @ 0050d630` — the part gets its own CMaterial so
 * the override never bleeds into the other objects sharing the GfxObj's
 * material (MaterialFactory caches one instance per surface). A clone drops
 * `onBeforeCompile`, so the retail shading is re-applied to it.
 */
export function copyLitMaterial(m: THREE.Material): THREE.Material {
  // CORE.17.q.b — the copy stays in the pass its part is drawn in (a
  // creature inside a cell keeps the no-sun `cellobject` set while selected).
  return applyRetailLighting(m.clone(), retailLightingKindOf(m) ?? 'object');
}

/**
 * `CMaterial::SetLuminositySimple @ 00539720` + `SetDiffuseSimple @ 00539750`:
 * Emissive = grey(luminosity), Diffuse = grey(diffuse). Unlit materials
 * (Luminous / Additive surfaces draw with MeshBasicMaterial) carry neither
 * term and are left alone. Returns whether the material took the levels.
 *
 * Both are D3D vertex-colour terms, i.e. gamma-space multipliers of the
 * texel. The retail-lit shader adds `emissive` to the light sum raw (the
 * sum IS the vertex colour), so the luminosity goes in as-is; `color`
 * however multiplies the linear texel before the shader re-encodes it to
 * sRGB, so a gamma-space Diffuse of d is stored as its linear value
 * (OETF(color · texel) = OETF(color) · OETF(texel) → OETF(color) = d).
 * A surface with its own luminosity keeps it (setMaterialLuminosity:
 * RenderMeshSubset draws it over the part's material).
 */
export function applyLightingLevels(m: THREE.Material, levels: LightingLevels): boolean {
  if (!isLitMaterial(m)) return false;
  setMaterialLuminosity(m, levels.luminosity);
  m.color.setScalar(srgbToLinear(levels.diffuse));
  return true;
}

/**
 * `CPartArray::SetLightingInternal @ 00518490` over the object's meshes: copy
 * each part's material once (the original is remembered in `copies`), then
 * write the levels. Returns the number of materials that took them. The
 * object's OWN parts only: an item it holds is its own CPhysicsObj and keeps
 * its lighting (selecting a player does not light their sword), so held
 * copies under `root` are skipped (partMeshes).
 */
export function setObjectLighting(root: THREE.Object3D, levels: LightingLevels, copies: LightingCopies): number {
  let applied = 0;
  for (const child of partMeshes(root)) {
    if (!child.material) continue;
    if (!copies.has(child)) {
      const original = child.material as THREE.Material | THREE.Material[];
      copies.set(child, original);
      child.material = Array.isArray(original) ? original.map(copyLitMaterial) : copyLitMaterial(original);
    }
    const mats: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) if (applyLightingLevels(m, levels)) applied++;
  }
  return applied;
}

/**
 * `CPartArray::RestoreLightingInternal @ 00518510` → `CPhysicsPart::RestoreLighting
 * @ 0050e4a0`: release the copies and point every part back at the GfxObj's
 * own material (a rebuilt appearance drops its map instead — the copies
 * died with the old parts).
 */
export function restoreObjectLighting(copies: LightingCopies): void {
  for (const [mesh, original] of copies) {
    const current = mesh.material as THREE.Material | THREE.Material[];
    if (current !== original) {
      if (Array.isArray(current)) current.forEach((m) => m.dispose());
      else current.dispose();
      mesh.material = original;
    }
  }
  copies.clear();
}

/**
 * SWEEP1006B.player-input.player-own-body-can-t — ApplyLighting on the
 * local player's model. The player is no ServerObject (the local model
 * stands in for it), but retail's find lights it like any found object
 * (RecvNotice_SmartBoxObjectFound → CPhysicsObj::SetLighting on the player).
 */
export function applyPlayerModelLighting(root: THREE.Object3D | null | undefined, mode: LightingMode, copies: LightingCopies): void {
  const levels = lightingLevelsForMode(mode);
  if (levels && root) setObjectLighting(root, levels, copies);
  else restoreObjectLighting(copies);
}
