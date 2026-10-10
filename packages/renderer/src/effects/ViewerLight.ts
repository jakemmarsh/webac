/**
 * ViewerLight — the retail "player light" (CORE.17.q).
 *
 * The EoL client attaches one white point light to the player every frame
 * and feeds it into the world's dynamic light list, indoors and out
 * (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - `SmartBox::SmartBox` @ ~87494: `viewer_light.type = 0` (point),
 *    `RGBColor::SetColor32(&viewer_light.color, 0xffffffff)`, `cone_angle 360`,
 *    intensity/falloff from the GlobalRegistry floats
 *    `SmartBox.ViewerLightIntensity` ("The intensity of the player light")
 *    and `SmartBox.ViewerLightFalloff` ("The falloff distance of the player
 *    light").
 *  - static initializer `$E260` @ 006e9a70:
 *    `s_fViewerLightIntensity = DEFAULT_GAME_BRIGHTNESS * BASE_GAMMA_MULTIPLIER`
 *    = 0.5f (.rdata @ 0x79b5e4) × 4.5f (.rdata @ 0x79b5e0) = 2.25.
 *    `s_fViewerLightFalloff` is initialised data (.data @ 0x818610) = 10.0f.
 *  - `SmartBox::set_viewer` @ 00452c40: offset (0, 0, 2.0) above the player's
 *    origin when a player exists (0x40000000 = 2.0f), (0, 0, 0) off the bare
 *    viewer otherwise; `Render::add_dynamic_light(&viewer_light, cell, frame)`.
 *  - `PrimD3DRender::config_hardware_light` @ 0059ad30: `Diffuse = color ×
 *    intensity`, `Range = falloff × rangeAdjust` (1.5), attenuation 1/d.
 *
 * It enters the dynamic light LIST everywhere the player goes, but it only
 * reaches the device when the viewer is inside a cell (CORE.17.h.g.c.c.b):
 * `SmartBox::RenderNormalMode` @ 00453aa0 draws an outdoor viewer
 * (`objcell_id & 0xffff < 0x100`) under `Render::useSunlightSet(1)` — the
 * sun as the ONLY active hardware light (`add_active_light(-1, 0)`) — and
 * both reads of `Render::useSunlight` (`RenderDeviceD3D::DrawMeshInternal`
 * @ 0059f360, `D3DPolyRender::SetSurface` @ 0059c4d0) gate the per-object
 * `minimize_object_lighting` pick on `useSunlight == 0`, which only the
 * draw-cell path (`PView::DrawCells` @ 005a4840, interior / SeenOutside
 * viewer cells) sets. So outdoors nothing — the player light included — is
 * point-lit; inside any cell the light is active. `viewerLightActive` is
 * that test. Like every point light it never reaches the landscape
 * (per-vertex sun + ambient only; see RetailLighting `AC_LANDSCAPE`). It
 * replaces the invented camera torch (0xffcc88, 1.5, 40 — main.ts
 * pre-CORE.17.q).
 */
import * as THREE from 'three';
import { retailLightRange } from '../models/RetailLighting.js';

/** `DEFAULT_GAME_BRIGHTNESS` (acclient.exe .rdata @ 0x79b5e4). */
export const VIEWER_LIGHT_DEFAULT_GAME_BRIGHTNESS = 0.5;
/** `BASE_GAMMA_MULTIPLIER` (acclient.exe .rdata @ 0x79b5e0). */
export const VIEWER_LIGHT_BASE_GAMMA_MULTIPLIER = 4.5;
/** `SmartBox::s_fViewerLightIntensity` default = 0.5 × 4.5. */
export const VIEWER_LIGHT_INTENSITY = VIEWER_LIGHT_DEFAULT_GAME_BRIGHTNESS * VIEWER_LIGHT_BASE_GAMMA_MULTIPLIER;
/** `SmartBox::s_fViewerLightFalloff` default (acclient.exe .data @ 0x818610). */
export const VIEWER_LIGHT_FALLOFF = 10.0;
/** `viewer_light.color` = 0xffffffff. */
export const VIEWER_LIGHT_COLOR = 0xffffff;
/** `SmartBox::set_viewer` — light sits this far above the player origin (AC z-up). */
export const VIEWER_LIGHT_PLAYER_OFFSET_Z = 2.0;

export function createViewerLight(): THREE.PointLight {
  const light = new THREE.PointLight(
    VIEWER_LIGHT_COLOR,
    VIEWER_LIGHT_INTENSITY,
    retailLightRange(VIEWER_LIGHT_FALLOFF),
    1, // D3D attenuation (0, 1, 0) = 1/d
  );
  light.name = 'viewer-light';
  light.userData.viewerLight = true; // not a DAT light — outside DatLightBudget
  return light;
}

/**
 * `SmartBox::RenderNormalMode`'s viewer test: a cell id whose low word is
 * below 0x100 is outdoors (`useSunlightSet(1)`, sun only); anything else is
 * an env cell drawn with the pool lights active. 0 (no cell) is outdoors.
 */
export function viewerLightActive(viewerCellId: number): boolean {
  return (viewerCellId & 0xffff) >= 0x100;
}

/**
 * Per frame: park the light at the player's origin + 2 m up (three.js Y =
 * AC Z), or on the bare viewer with no offset when there is no player yet.
 */
export function updateViewerLight(
  light: THREE.PointLight,
  playerPos: THREE.Vector3 | null,
  viewerPos: THREE.Vector3,
): void {
  if (playerPos) {
    light.position.set(playerPos.x, playerPos.y + VIEWER_LIGHT_PLAYER_OFFSET_Z, playerPos.z);
  } else {
    light.position.copy(viewerPos);
  }
}
