/**
 * REMASTER remodel: the lifestone (Setup 0x020002EE — weenie 509 `lifestone`),
 * modernised as the SAME model (Jake: "we'd want to more exactly copy shapes
 * … the exact same model modernized / improved").
 *
 * The DAT lifestone is three claw legs (GfxObj 0x01000D00 / D02 / D06, one
 * shape: 13 vertices, 20 polygons each) and a crystal (0x01000CFA: 31
 * vertices, 58 polygons). Both keep their DAT triangles exactly
 * (remasterFromDat): bevelled hard edges in the shading, the DAT textures
 * upscaled with derived relief and roughness, the legs' blue-steel paint as
 * polished metal, and the crystal's own swirl texture as a glossy, glowing
 * crystal.
 */
import * as THREE from 'three';
import { applyRemasterPbr, registerAssetOverride, getRemasterEnvMap, type AssetContext } from '../AssetOverrides.js';
import { applyBevel, remasterFromDat } from './FromDat.js';

export const LIFESTONE_LEG_IDS = [0x01000d00, 0x01000d02, 0x01000d06] as const;
export const LIFESTONE_CRYSTAL_ID = 0x01000cfa;

const crystalTime = { value: 0 };
const start = typeof performance !== 'undefined' ? performance.now() : 0;

/** The crystal: its own DAT texture, glossy (clear coat, sharp reflections) and glowing from within. */
function crystalMaterial(dat: THREE.Material, up: THREE.Texture | null): THREE.Material {
  const m = applyBevel(applyRemasterPbr(new THREE.MeshPhysicalMaterial({
    map: up, emissiveMap: up, emissive: new THREE.Color().setScalar(1), emissiveIntensity: 0.55,
    roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 1,
    envMap: getRemasterEnvMap(), envMapIntensity: 1.1,
    side: (dat as THREE.MeshLambertMaterial).side,
  })));
  // A slow breathing glow.
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.acTime = crystalTime;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float acTime;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= 0.85 + 0.25 * sin( acTime * 1.4 );');
  };
  m.customProgramCacheKey = () => `${prevKey}|acCrystalPulse`;
  return m;
}

export function buildLeg(ctx: AssetContext): THREE.Object3D {
  const g = remasterFromDat(ctx.datMeshes, { metalFromBlue: true });
  g.name = 'remaster_lifestone_leg';
  return g;
}

export function buildCrystal(ctx: AssetContext): THREE.Object3D {
  const g = remasterFromDat(ctx.datMeshes, { material: crystalMaterial });
  g.name = 'remaster_lifestone_crystal';
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
  const first = g.children[0];
  if (first) first.onBeforeRender = () => { crystalTime.value = (performance.now() - start) / 1000; };
  return g;
}

/** Register the lifestone replacement (RemasterMode `assets`). */
export function registerLifestone(): void {
  for (const id of LIFESTONE_LEG_IDS) registerAssetOverride(id, buildLeg);
  registerAssetOverride(LIFESTONE_CRYSTAL_ID, buildCrystal);
}
