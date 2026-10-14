/**
 * REMASTER render pipeline (opt-in, RemasterMode.ts): sun shadows around the
 * camera, then a post stack — ambient occlusion (GTAO), bloom on the bright
 * and emissive, filmic tone mapping — drawn into a multisampled HDR target.
 *
 * The sun is SkyboxRenderer's DirectionalLight, still driven by the DAT
 * RegionDesc sky curve. SkyboxRenderer writes its direction as
 * `position = dir · 200` (target at the origin); each frame this pipeline
 * reads that direction and re-centres light and target on the area in front
 * of the camera so the shadow map covers what the player sees.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { RemasterSettings } from './RemasterMode.js';
import { retailLightingKindOf } from '../models/RetailLighting.js';
import { remasterCastsShadow, remasterReceivesShadow } from './RemasterLighting.js';
import { buildRemasterEnvMap, REMASTER_ASSET_KEY } from './AssetOverrides.js';

/** Half-width of the sun's shadow box (metres) and its map size. */
export const SHADOW_HALF_EXTENT = 48;
export const SHADOW_MAP_SIZE = 2048;
/** How far ahead of the camera the shadow box is centred (metres). */
export const SHADOW_LOOKAHEAD = 22;
/** Frames between sweeps that tag new meshes as shadow casters / receivers. */
export const SHADOW_SWEEP_FRAMES = 15;

export const BLOOM = { strength: 0.32, radius: 0.45, threshold: 0.88 };
export const TONE_EXPOSURE = 1.35;

/** Tag every world mesh by its lighting kind (pure; exported for tests). */
export function applyShadowFlags(root: THREE.Object3D, shadows: boolean): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // Grass and replacement assets set their own shadow roles.
    if (!mesh.isMesh || !mesh.material || mesh.userData.remasterGrass || mesh.userData[REMASTER_ASSET_KEY]) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const kind = retailLightingKindOf(mat);
    // Particles (glows, smoke, sparks) never cast; a fully opaque part does even when it can fade.
    mesh.castShadow = shadows && remasterCastsShadow(kind) && !mat.userData?.particleSurface
      && (!mat.transparent || (mat.opacity >= 0.99 && mat.blending === THREE.NormalBlending));
    mesh.receiveShadow = shadows && remasterReceivesShadow(kind);
  });
}

export class RemasterPipeline {
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass | null = null;
  private readonly bloom: UnrealBloomPass | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly lastSunPos = new THREE.Vector3(NaN, NaN, NaN);
  private frame = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly settings: RemasterSettings,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      stencilBuffer: true, // building portal punches (PortalPunch.ts)
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (settings.ao) {
      this.gtao = new GTAOPass(scene, camera, size.x, size.y);
      this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 16 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      this.gtao.blendIntensity = 0.9;
      this.composer.addPass(this.gtao);
    }
    if (settings.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      this.composer.addPass(this.bloom);
    }
    renderer.toneMapping = settings.tonemap ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = TONE_EXPOSURE;
    this.composer.addPass(new OutputPass());

    if (settings.assets) buildRemasterEnvMap(renderer, renderer.getClearColor(new THREE.Color()));
    renderer.shadowMap.enabled = settings.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  private findSun(): THREE.DirectionalLight | null {
    if (this.sun && this.sun.parent) return this.sun;
    this.sun = null;
    this.scene.traverse((o) => { if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight) this.sun = o as THREE.DirectionalLight; });
    const sun = this.sun as THREE.DirectionalLight | null;
    if (sun) {
      sun.castShadow = this.settings.shadows;
      const cam = sun.shadow.camera;
      cam.left = -SHADOW_HALF_EXTENT; cam.right = SHADOW_HALF_EXTENT;
      cam.top = SHADOW_HALF_EXTENT; cam.bottom = -SHADOW_HALF_EXTENT;
      cam.near = 1; cam.far = 600;
      cam.updateProjectionMatrix();
      sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.05;
      sun.shadow.radius = 2;
      if (!sun.target.parent) this.scene.add(sun.target);
    }
    return sun;
  }

  /** Follow the camera with the sun's shadow box, keeping the DAT sun direction. */
  private placeSun(): void {
    const sun = this.findSun();
    if (!sun || !this.settings.shadows) return;
    // SkyboxRenderer rewrote the light since our last frame: take its direction.
    if (!sun.position.equals(this.lastSunPos)) this.sunDir.copy(sun.position).normalize();
    const center = this.camera.getWorldPosition(new THREE.Vector3());
    const fwd = this.camera.getWorldDirection(this.tmp);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) center.addScaledVector(fwd.normalize(), SHADOW_LOOKAHEAD);
    // Snap to the shadow texel grid so the map doesn't shimmer as the camera moves.
    const texel = (2 * SHADOW_HALF_EXTENT) / SHADOW_MAP_SIZE;
    center.set(Math.round(center.x / texel) * texel, Math.round(center.y / texel) * texel, Math.round(center.z / texel) * texel);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    sun.position.copy(center).addScaledVector(this.sunDir, 300);
    this.lastSunPos.copy(sun.position);
    // Below the horizon the sun only lights through ambient: no shadows then.
    sun.castShadow = this.sunDir.y > 0.05;
  }

  render(): void {
    if (this.frame++ % SHADOW_SWEEP_FRAMES === 0) applyShadowFlags(this.scene, this.settings.shadows);
    this.placeSun();
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.gtao?.dispose();
    this.bloom?.dispose();
  }
}
