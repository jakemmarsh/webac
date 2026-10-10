/**
 * CORE.18.f — the one camera + heading convention for the UI's own 3D views
 * (UIElement_Viewport / CreatureMode): the inventory paperdoll 0x100001d5,
 * the chargen appearance / summary views (gmCG3DView) and the examine
 * portrait (BasicCreatureExamineUI).
 *
 * Every model is built exactly as the world builds it — AC (x, y, z) →
 * three (x, z, y), a reflection (SetupModelRenderer / GfxObjMesh). CORE.18
 * gave the WORLD camera the one compensating clip-space x mirror
 * (WorldMirror.mirrorCameraX); these views used plain cameras, so a figure's
 * right hand drew on the wrong side. Rather than hand-tuned per-view
 * arrangements, each view now places its retail CreatureMode scene through
 * the SAME reflection and draws it through a mirrored camera — which is
 * exactly retail's image:
 *
 *  - the retail camera position (AC metres, z up) maps with `acToThree`;
 *  - every retail view sets direction (0, 0, 0) (CreatureMode::
 *    SetCameraDirection @ 00453730: euler_set_rotate(0,0,0) — look along the
 *    frame's +y, level), i.e. three +z;
 *  - the figure's heading goes through Frame::set_heading @ 00535e40
 *    (forward = (sin h, cos h, 0), h in degrees: 0 north, 90 east); the
 *    model faces three +z (AC +y) at rotation.y 0, so rotation.y = h in
 *    radians (verification/core17kbbac/yaw-probe: rotation 0 shows the face
 *    to a camera on +z, π/2 turns it to +x);
 *  - CreatureMode's FOV is m_fFOVRadians = π/4, vertical (CreatureMode ctor
 *    @ 00454390, Render::SetFOVInternal @ 0054b340 derives vdst from the
 *    viewport height).
 *
 * The shared renderer's culling hook (installMirrorAwareCulling) already
 * inverts the front face for any camera flagged by mirrorCameraX, render
 * targets included.
 */

import * as THREE from 'three';
import { mirrorCameraX } from '../scene/WorldMirror.js';

/** An AC-frame vector (x east/right, y north/forward, z up). */
export type AcVec3 = readonly [number, number, number];

/** CreatureMode::m_fFOVRadians — π/4, vertical. */
export const CREATURE_MODE_FOV_RADIANS = 0.7853982;
export const CREATURE_MODE_FOV_DEGREES = 45;

/** Render::SetFOVRad @ 0054b2d0 — znear = 0.1. */
export const CREATURE_MODE_NEAR = 0.1;

/** AC (x, y, z) → three (x, z, y) — the world's own mapping (SetupModelRenderer). */
export function acToThree(v: AcVec3): [number, number, number] {
  return [v[0], v[2], v[1]];
}

/**
 * AC heading (degrees, Frame::set_heading: 0 = +y, 90 = +x, clockwise seen
 * from above) → the model's three.js rotation.y. Heading 180 (facing a
 * camera due south, the retail views' arrangement) is π.
 */
export function headingToModelYaw(headingDegrees: number): number {
  return (headingDegrees * Math.PI) / 180;
}

/**
 * Point a camera at retail's CreatureMode frame: at AC `position`, looking
 * along AC +y (direction (0, 0, 0)), level, through the CORE.18 mirror.
 * Works on a fresh or a cached camera (idempotent mirror).
 */
export function placeCreatureModeCamera(
  camera: THREE.PerspectiveCamera, position: AcVec3, fovDegrees: number, aspect: number,
): THREE.PerspectiveCamera {
  mirrorCameraX(camera);
  const [x, y, z] = acToThree(position);
  camera.fov = fovDegrees;
  camera.aspect = aspect;
  camera.up.set(0, 1, 0);
  camera.position.set(x, y, z);
  camera.lookAt(x, y, z + 1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** A new mirrored CreatureMode camera at AC `position` for a `width`x`height` viewport. */
export function buildCreatureModeCamera(
  position: AcVec3, width: number, height: number,
  fovDegrees = CREATURE_MODE_FOV_DEGREES, far = 100,
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fovDegrees, width / height, CREATURE_MODE_NEAR, far);
  return placeCreatureModeCamera(camera, position, fovDegrees, width / height);
}

/**
 * Where a three.js DirectionalLight (which shines from its position toward
 * its target at the origin) must sit to travel along the AC direction:
 * the negated, normalised three.js vector.
 */
export function distantLightPosition(direction: AcVec3): [number, number, number] {
  const [x, y, z] = acToThree(direction);
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  return [-x * inv, -y * inv, -z * inv];
}

/** BasicCreatureExamineUI::Init @ 004ab9c0 — CPhysicsObj::set_heading(191.3679). */
export const EXAMINE_HEADING_DEG = 191.3679;
/** BasicCreatureExamineUI::Init — SetLight(DISTANT_LIGHT, 2.0, (0.3, 1.9, 0.65)). */
export const EXAMINE_LIGHT_INTENSITY = 2.0;
export const EXAMINE_LIGHT_DIRECTION: AcVec3 = [0.3, 1.9, 0.65];
/** 0x3f9a827a — 1 / (2·tan(π/8)): the distance that fits a height into CreatureMode's vertical FOV. */
export const EXAMINE_FIT_FACTOR = 1.2071068;

/**
 * BasicCreatureExamineUI::Init's camera: from the headed clone's bounding
 * box (AC min/max), fit the box's height — or its width scaled to the
 * viewport's aspect when that is the larger — into the vertical FOV, and
 * stand that far back from the box's front face (centre.y − depth/2), at
 * the box centre, looking +y.
 */
export function examineCameraPosition(
  min: AcVec3, max: AcVec3, width: number, height: number,
): [number, number, number] {
  const sx = max[0] - min[0];
  const sy = max[1] - min[1];
  let sz = max[2] - min[2];
  const aspect = height / width;
  if (sz / sx < aspect) sz = sx * aspect;
  const fit = sz * EXAMINE_FIT_FACTOR;
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  return [cx, cy - (fit + sy * 0.5), cz];
}

/** A three.js Box3 of the (x,z,y)-built scene back in AC axes. */
export function threeBoxToAc(box: THREE.Box3): { min: AcVec3; max: AcVec3 } {
  return {
    min: [box.min.x, box.min.z, box.min.y],
    max: [box.max.x, box.max.z, box.max.y],
  };
}

/**
 * VISUAL.paperdoll-doll-dark — linear byte → sRGB byte, for reading a UI
 * viewport's offscreen render back into a 2D canvas. The world draws to the
 * canvas with renderer.outputColorSpace = sRGB, but three (r160 through r186)
 * never applies that encode to a (non-XR) WebGLRenderTarget: WebGLPrograms
 * takes the working colour space (LinearSRGBColorSpace) as the output
 * whenever a render target is bound (tests/verify-paperdoll-srgb-readback.ts
 * drives the real getParameters to pin it).
 * So readRenderTargetPixels returns LINEAR values. Copied straight into a
 * canvas, they drew the paperdoll ~4× too dark (dark-green clothing read
 * near-black: live RGB ≈ (5, 5, 3) vs the world's ≈ 37).
 */
const LINEAR_TO_SRGB_BYTE: Uint8Array = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    lut[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
  }
  return lut;
})();

/**
 * Copy a `readRenderTargetPixels` buffer (bottom-up rows, linear RGB) into
 * top-down canvas ImageData, encoding RGB to sRGB as the on-screen
 * framebuffer would. Alpha is coverage and passes through unchanged.
 */
export function copyRenderTargetToImageData(pixels: Uint8Array, width: number, height: number, out: Uint8ClampedArray): void {
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    const dst = y * row;
    for (let i = 0; i < row; i += 4) {
      out[dst + i] = LINEAR_TO_SRGB_BYTE[pixels[src + i]];
      out[dst + i + 1] = LINEAR_TO_SRGB_BYTE[pixels[src + i + 1]];
      out[dst + i + 2] = LINEAR_TO_SRGB_BYTE[pixels[src + i + 2]];
      out[dst + i + 3] = pixels[src + i + 3];
    }
  }
}
