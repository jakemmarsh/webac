/**
 * The offscreen draw behind the UI's CreatureMode viewports (the chargen
 * appearance / summary views, the barber's gmCG3DView, the examine
 * portrait): the scene CreatureMode lights — m_clrAmbientLight (0.3, 0.3,
 * 0.3) plus ONE DISTANT_LIGHT (UIElement_Viewport::SetLight) — rendered to
 * a target and copied, sRGB-encoded, into a 2D canvas.
 */
import * as THREE from 'three';
import { currentObjectAmbientScale } from '../models/RetailLighting.js';
import { CREATURE_MODE_AMBIENT } from './ChargenAppearanceView.js';
import { copyRenderTargetToImageData, distantLightPosition, type AcVec3 } from './CreatureViewCamera.js';

/**
 * A CreatureMode scene holding `model`: the viewport's ambient 0.3 (the
 * object materials scale the scene ambient by the world's
 * (amb + 0.2·dir) / amb factor, so it is divided back out) and the
 * DISTANT_LIGHT of `intensity` travelling along the AC `direction`.
 */
export function buildCreatureModeScene(model: THREE.Object3D, direction: AcVec3, intensity: number): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = null;
  const ambientScale = currentObjectAmbientScale();
  scene.add(new THREE.AmbientLight(0xffffff, CREATURE_MODE_AMBIENT / (ambientScale > 0 ? ambientScale : 1)));
  const dir = new THREE.DirectionalLight(0xffffff, intensity);
  const lp = distantLightPosition(direction);
  dir.position.set(lp[0], lp[1], lp[2]);
  dir.target.position.set(0, 0, 0);
  scene.add(dir);
  scene.add(dir.target);
  scene.add(model);
  return scene;
}

/** Render `scene` from `camera` offscreen at the canvas size and copy it into the canvas (transparent clear). */
export function renderSceneToCanvas(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement,
): void {
  const w = canvas.width, h = canvas.height;
  const renderTarget = new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat });
  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearAlpha(0);
  renderer.setRenderTarget(renderTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearAlpha(prevAlpha);

  const pixels = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, w, h, pixels);
  renderTarget.dispose();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const imageData = ctx.createImageData(w, h);
  // VISUAL.paperdoll-doll-dark — the target holds linear colour.
  copyRenderTargetToImageData(pixels, w, h, imageData.data);
  ctx.putImageData(imageData, 0, 0);
}
