/**
 * CORE.17.m — retail paperdoll (inventory 3D figure) framing, recovered
 * from the decompiled EoL client. The paperdoll is UIElement_Viewport
 * 0x100001d5 (layout 0x21000024, 224x214, element class 0xd) hosting a
 * CreatureMode scene with a clone of the player's CPhysicsObj at the
 * origin; the camera is fixed per heritage — retail never fits a bounding
 * box, it just places the camera where the figure fills the frame.
 *
 * Ground truth (reference/client-eol/decomp/acclient-decompiled.c):
 * - gmPaperDollUI::PostInit @ 004a5360: UIElement_Viewport::SetCamera(
 *   position (0.12, -2.4, 0.88), direction (0,0,0)) — literals from the
 *   disassembly at 004a5a39..004a5a61 (0x3df5c28f / 0xc019999a / 0x3f6147ae);
 *   then SetLight(DISTANT_LIGHT, 2.0, dir) and CreatureMode::UseSharpMode.
 * - gmPaperDollUI::UpdateForRace @ 004a3ed0 overrides the camera for the
 *   non-human heritages: 6 Gearknight / 7 Tumerok → (0.12, -3.0, 0.88);
 *   8 Lugian → (0.12, -3.4, 1.0); 9 Empyrean, 12 Olthoi, 13 OlthoiAcid →
 *   (0.12, -3.4, 0.88). Every other heritage keeps the PostInit default.
 * - CreatureMode::SetCameraDirection @ 00453730: euler_set_rotate(0,0,0)
 *   then rotate(dir) — a zero vector is the identity, so the camera looks
 *   straight along its frame's forward axis (+y in AC's z-up frame) with
 *   no pitch. CreatureMode::CreatureMode @ 00454390: m_fFOVRadians =
 *   0.7853982 (45°), ambient 0.3; m_bUseSmartboxFOV false, so
 *   CreatureMode::Render @ 004529d0 feeds that constant to Render::SetFOVRad,
 *   and Render::SetFOVInternal @ 0054b340 derives the view distance from
 *   the viewport HEIGHT (vdst = ty / tan(fov/2)) — the FOV is vertical.
 * - gmPaperDollUI::RedressCreature @ 004a3bc0: the figure is a
 *   CPhysicsObj::makeObject clone at the origin with set_heading(191.3679)
 *   — facing the camera, turned 11.37° past square-on.
 *
 * CORE.18.f — AC's frame is z-up (x east, y north); the renderer builds
 * models with AC (x, y, z) → three.js (x, z, y), a reflection the world
 * camera undoes with WorldMirror.mirrorCameraX. The paperdoll scene is the
 * retail one put through that same mapping — camera at three (0.12, 0.88,
 * −2.4) looking +z, the figure turned by Frame::set_heading(191.3679) — and
 * drawn by a mirrored camera (CreatureViewCamera.ts), which is exactly the
 * retail image: the figure faces the camera, turned toward screen-left,
 * its right hand / wielded weapon on screen-LEFT, and it stands left of
 * centre (the camera is 0.12 m to its right).
 *
 * (The earlier +z arrangement — camera at three z=+2.4 looking −z with
 * the figure at rotation.y π+11.37° — showed the figure's BACK: the model
 * faces three +z at rotation 0, verification/core17kbbac/yaw-probe.)
 */

import * as THREE from 'three';
import { acToThree, buildCreatureModeCamera, headingToModelYaw } from './CreatureViewCamera.js';

/** AC-frame camera position (metres, z-up) per HeritageGroup id. */
export interface PaperdollCameraAC {
  x: number;
  y: number;
  z: number;
}

/** gmPaperDollUI::PostInit default — every heritage not in the override table. */
export const PAPERDOLL_CAMERA_DEFAULT: Readonly<PaperdollCameraAC> = Object.freeze({ x: 0.12, y: -2.4, z: 0.88 });

/** gmPaperDollUI::UpdateForRace @ 004a3ed0 per-heritage overrides. */
export const PAPERDOLL_CAMERA_BY_HERITAGE: ReadonlyMap<number, Readonly<PaperdollCameraAC>> = new Map<number, Readonly<PaperdollCameraAC>>([
  [6, Object.freeze({ x: 0.12, y: -3.0, z: 0.88 })],  // Gearknight
  [7, Object.freeze({ x: 0.12, y: -3.0, z: 0.88 })],  // Tumerok
  [8, Object.freeze({ x: 0.12, y: -3.4, z: 1.0 })],   // Lugian
  [9, Object.freeze({ x: 0.12, y: -3.4, z: 0.88 })],  // Empyrean
  [12, Object.freeze({ x: 0.12, y: -3.4, z: 0.88 })], // Olthoi
  [13, Object.freeze({ x: 0.12, y: -3.4, z: 0.88 })], // OlthoiAcid
]);

/** CreatureMode::CreatureMode @ 00454390 — m_fFOVRadians (vertical, 45°). */
export const PAPERDOLL_FOV_RAD = 0.7853982;

/** CreatureMode::CreatureMode — m_clrAmbientLight (0.3, 0.3, 0.3). */
export const PAPERDOLL_AMBIENT = 0.3;

/** gmPaperDollUI::PostInit — SetLight(DISTANT_LIGHT, 2.0, …). */
export const PAPERDOLL_DISTANT_LIGHT = 2.0;

/**
 * gmPaperDollUI::PostInit — the SetLight direction (AC axes, the way the
 * light travels): (0.3, 1.9, 0.65), stored at 004a5a80..004a5a90
 * (0x3e99999a / 0x3ff33333 / 0x3f266666) over the camera vector Ghidra
 * shows as the same stack slot. The same vector gmCG3DView and
 * BasicCreatureExamineUI use: from the camera side into the figure's front.
 */
export const PAPERDOLL_LIGHT_DIRECTION: readonly [number, number, number] = [0.3, 1.9, 0.65];

/** gmPaperDollUI::RedressCreature @ 004a3bc0 — CPhysicsObj::set_heading(191.3679). */
export const PAPERDOLL_HEADING_DEG = 191.3679;

/** Render::SetFOVRad @ 0054b2d0 — znear = 0.1. */
export const PAPERDOLL_NEAR = 0.1;

/** Resolve the AC-frame camera position for a heritage (0 / unknown → default). */
export function resolvePaperdollCamera(heritage: number): Readonly<PaperdollCameraAC> {
  return PAPERDOLL_CAMERA_BY_HERITAGE.get(heritage) ?? PAPERDOLL_CAMERA_DEFAULT;
}

/**
 * Build the paperdoll camera for a viewport of `width`x`height` CSS px:
 * retail's CreatureMode frame at the heritage's AC position, looking along
 * AC +y with no pitch (direction (0,0,0)), 45° vertical FOV, placed through
 * the world's (x, z, y) mapping and carrying the CORE.18 mirror. The figure
 * stands at the origin with its feet on y=0.
 */
export function buildPaperdollCamera(heritage: number, width: number, height: number): THREE.PerspectiveCamera {
  const ac = resolvePaperdollCamera(heritage);
  return buildCreatureModeCamera([ac.x, ac.y, ac.z], width, height,
    THREE.MathUtils.radToDeg(PAPERDOLL_FOV_RAD), 100);
}

/** The paperdoll camera's position in the three.js scene (the world's (x, z, y) mapping). */
export function paperdollCameraThreePosition(heritage: number): [number, number, number] {
  const ac = resolvePaperdollCamera(heritage);
  return acToThree([ac.x, ac.y, ac.z]);
}

/**
 * Figure yaw: Frame::set_heading(191.3679) @ 00535e40 faces
 * (sin h, cos h) — 180 is square-on to the camera due south, plus an
 * 11.3679° turn toward AC −x (west, screen-left). The model faces three +z
 * (AC +y) at rotation 0, so the yaw is the heading in radians.
 */
export function paperdollFigureRotationY(): number {
  return headingToModelYaw(PAPERDOLL_HEADING_DEG);
}

/**
 * Vertical extent (metres, at the figure's plane) the camera shows —
 * useful for tests: with the default camera a 1.85 m figure standing at
 * the origin fits with a few px of headroom, exactly the retail look.
 */
export function paperdollVisibleYRange(heritage: number): { bottom: number; top: number } {
  const ac = resolvePaperdollCamera(heritage);
  const half = Math.abs(ac.y) * Math.tan(PAPERDOLL_FOV_RAD / 2);
  return { bottom: ac.z - half, top: ac.z + half };
}

/**
 * Project a scene point through the paperdoll camera into CSS px of the
 * viewport (origin top-left). Exposed for tests + probes.
 */
export function projectPaperdollPoint(
  camera: THREE.PerspectiveCamera, point: THREE.Vector3, width: number, height: number,
): { x: number; y: number } {
  const p = point.clone().project(camera);
  return { x: (p.x + 1) / 2 * width, y: (1 - p.y) / 2 * height };
}
