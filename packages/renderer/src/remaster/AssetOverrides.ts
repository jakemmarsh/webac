/**
 * REMASTER asset overrides (opt-in, RemasterMode `assets`): draw a high-detail
 * replacement in place of a DAT GfxObj, keyed by its DAT id.
 *
 * This is the remodeling path (docs/remaster.md): the game still builds the
 * DAT part, positions and animates it exactly as before (the replacement is a
 * child of the same part, in the GfxObj's own coordinates), and picking and
 * collision keep using the DAT triangles: the DAT meshes stay in the scene
 * graph, hidden, still answering raycasts, while the replacement never does.
 * Replacement materials take the remaster's DAT lighting (sun, ambient, point
 * lights, fog) through `applyRemasterPbr`.
 */
import * as THREE from 'three';
import { remaster } from './RemasterMode.js';
import { patchRemasterPbrFragment, REMASTER_LIGHTING_CACHE_KEY } from './RemasterLighting.js';
import { objectAmbientScaleUniform } from '../models/RetailLighting.js';
import { averageTextureColor } from './GrassField.js';

/** What a replacement may read from the DAT part it replaces. */
export interface AssetContext {
  /** Average linear colour of a DAT Surface's texture on this part (null if the part has none). */
  surfaceColor(surfaceId: number): THREE.Color | null;
  /** The DAT texture a Surface draws with on this part (null if the part has none). */
  surfaceTexture(surfaceId: number): THREE.Texture | null;
  /** The part's DAT meshes (hidden behind the replacement; still the raycast targets). */
  datMeshes: THREE.Mesh[];
}

/** Builds a replacement for one DAT GfxObj, in that GfxObj's three.js-space coordinates. */
export type AssetFactory = (ctx: AssetContext) => THREE.Object3D;

const registry = new Map<number, AssetFactory>();

export function registerAssetOverride(gfxObjId: number, factory: AssetFactory): void {
  registry.set(gfxObjId >>> 0, factory);
}

export function hasAssetOverride(gfxObjId: number): boolean {
  return registry.has(gfxObjId >>> 0);
}

/** userData flag on a replacement subtree (the shadow sweep leaves its own flags alone). */
export const REMASTER_ASSET_KEY = 'remasterAsset';
/** userData flag on a DAT mesh hidden behind a replacement. */
export const REMASTER_REPLACED_KEY = 'remasterReplaced';

const noRaycast = (): void => {};

/**
 * Under REMASTER `assets`, give a freshly built DAT GfxObj group its
 * replacement: hide the DAT meshes (they keep answering raycasts) and add the
 * replacement subtree. Returns true when a replacement was attached.
 */
export function applyAssetOverride(group: THREE.Group, gfxObjId: number): boolean {
  if (!remaster()?.assets) return false;
  const factory = registry.get(gfxObjId >>> 0);
  if (!factory) return false;
  const ctx = datPartContext(group);
  const replacement = factory(ctx);
  for (const child of ctx.datMeshes) {
    child.visible = false;
    child.userData[REMASTER_REPLACED_KEY] = true;
  }
  replacement.userData[REMASTER_ASSET_KEY] = true;
  replacement.traverse((o) => { o.raycast = noRaycast; o.userData[REMASTER_ASSET_KEY] = true; });
  group.add(replacement);
  return true;
}

/** Colours read off the DAT meshes of a part (their textures, averaged). */
export function datPartContext(group: THREE.Object3D): AssetContext {
  return {
    datMeshes: group.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh),
    surfaceColor(surfaceId: number): THREE.Color | null {
      let found: THREE.Color | null = null;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (found || !m.isMesh || (m.userData.surfaceId >>> 0) !== (surfaceId >>> 0)) return;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshLambertMaterial;
        const data = (mat.map as THREE.DataTexture | null)?.image?.data as ArrayLike<number> | undefined;
        if (data && data.length >= 4) found = averageTextureColor(data);
      });
      return found;
    },
    surfaceTexture(surfaceId: number): THREE.Texture | null {
      let found: THREE.Texture | null = null;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (found || !m.isMesh || (m.userData.surfaceId >>> 0) !== (surfaceId >>> 0)) return;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshLambertMaterial;
        found = mat.map ?? null;
      });
      return found;
    },
  };
}

let envMap: THREE.Texture | null = null;

/** The remaster's image-based light for replacement materials (built once from the renderer). */
export function getRemasterEnvMap(): THREE.Texture | null {
  return envMap;
}

/**
 * A soft sky / horizon / ground environment for PBR reflections, from the
 * same colours the world is drawn with at the time it is built: the scene's
 * fog colour as horizon, the sky above it, the ground below it darker.
 */
export function buildRemasterEnvMap(renderer: THREE.WebGLRenderer, horizon: THREE.Color): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const sky = horizon.clone().multiplyScalar(0.8);
  const ground = horizon.clone().multiplyScalar(0.25);
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const col: number[] = [];
  const p = geo.getAttribute('position');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 10;
    if (y > 0) c.copy(horizon).lerp(sky, Math.min(1, y * 1.6)); else c.copy(horizon).lerp(ground, Math.min(1, -y * 3));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  envMap = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  geo.dispose();
  return envMap;
}

/**
 * Light a Standard / Physical material with the remaster's DAT lights (so a
 * replacement sits in the same light as the world around it).
 */
export function applyRemasterPbr<T extends THREE.MeshStandardMaterial>(material: T): T {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.acAmbientScale = objectAmbientScaleUniform();
    shader.fragmentShader = patchRemasterPbrFragment(shader.fragmentShader);
  };
  const key = `${REMASTER_LIGHTING_CACHE_KEY}:pbr`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}
