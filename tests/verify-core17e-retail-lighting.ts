/**
 * CORE.17.e — "Night barely dims the terrain while the sky goes fully black".
 *
 * Behavioral coverage of the retail world-lighting model (see
 * packages/renderer/src/models/RetailLighting.ts for the decompile anchors):
 *  - the retail per-vertex equation itself (clamp01 Σ, gamma-space modulate);
 *  - the MeshLambertMaterial shader patch (no 1/PI BRDF, ambient scale, sRGB
 *    multiply) driven through the REAL three.js (r186) Lambert shader source;
 *  - SkyboxRenderer publishing the RegionDesc curve verbatim (with the
 *    LSCAPE_LIGHT_MINIMUM floor), the object ambient factor, and fog/background
 *    bytes stored so they DISPLAY as the DAT bytes;
 *  - SceneManager carrying no undriven world light (the sealed-interior
 *    placeholder toggle was removed by CORE.17.q — see
 *    verify-core17q-interior-lighting.ts);
 *  - MaterialFactory / TerrainRenderer / EnvCell clone paths all shipping the
 *    patch.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyRetailLighting,
  isRetailLit,
  patchLambertFragment,
  patchLambertVertex,
  retailLightSum,
  retailShade,
  retailObjectAmbientScale,
  setRetailLightLevels,
  currentObjectAmbientScale,
  linearToSrgb,
  srgbToLinear,
  LSCAPE_LIGHT_MINIMUM,
  RETAIL_LIGHTING_CACHE_KEY,
} from '../packages/renderer/src/models/RetailLighting.js';
import { SAMPLER_BIAS_CACHE_KEY } from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';

// The real Dereth "Sunny" keyframes (tools/dump-region-lighting.ts, portal.dat
// 0x13000000): midnight vs noon.
const NIGHT = {
  begin: 0.0, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xffdcdcdc,
  ambBright: 0.40, ambColor: 0xffc864ff, minWorldFog: 0, maxWorldFog: 400,
  worldFogColor: 0xff171728, worldFog: 1, skyObjReplace: [],
};
const NOON = {
  begin: 0.5, dirBright: 0.80, dirHeading: 90, dirPitch: 90, dirColor: 0xfffad797,
  ambBright: 0.35, ambColor: 0xffe6e6ff, minWorldFog: 150, maxWorldFog: 2400,
  worldFogColor: 0xffc3c8dc, worldFog: 1, skyObjReplace: [],
};
const NIGHT_END = { ...NIGHT, begin: 0.999 };

function makeSky(frames = [NIGHT, NOON, NIGHT_END]): SkyboxRenderer {
  const desc = {
    tickSize: 0.8, lightTickSize: 15,
    dayGroups: [{ chanceOfOccur: 5, dayName: 'Sunny', skyObjects: [], skyTime: frames }],
  } as any;
  // a day so long the phase holds still across the update() ticks above
  return new SkyboxRenderer(desc, { dayLength: 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as any);
}

const bytes = (c: THREE.Color): [number, number, number] => {
  const s = c.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
};

describe('CORE.17.e — retail lighting equation (CLandBlockStruct::calc_lighting)', () => {
  const up: [number, number, number] = [0, 1, 0];

  it('night flat ground is ambient-dominated, purple-blue, ~30% of full', () => {
    // sunlight = dir_bright · (sin h cos p, sin p, cos h cos p) with pitch 0.9°
    const p = (0.9 * Math.PI) / 180;
    const sun: [number, number, number] = [0.25 * Math.cos(p), 0.25 * Math.sin(p), 0];
    const L = retailLightSum(up, sun, [220 / 255, 220 / 255, 220 / 255], [200 / 255, 100 / 255, 1], 0.4);
    expect(L[0]).toBeCloseTo(0.4 * 200 / 255 + 0.25 * Math.sin(p) * 220 / 255, 3);
    expect(L[1]).toBeLessThan(0.2);   // ~0.16
    expect(L[2]).toBeGreaterThan(0.39); // ~0.40
    expect(L[2]).toBeGreaterThan(L[0]); // cool cast: B > R > G
    expect(L[0]).toBeGreaterThan(L[1]);
  });

  it('noon flat ground saturates: sun + ambient clamp to 1 per channel', () => {
    const sun: [number, number, number] = [0, 0.8, 0];
    const L = retailLightSum(up, sun, [250 / 255, 215 / 255, 151 / 255], [230 / 255, 230 / 255, 1], 0.35);
    expect(L[0]).toBe(1);               // 0.78 + 0.32 → clamped
    expect(L[1]).toBeCloseTo(0.99, 2);
    expect(L[2]).toBeCloseTo(0.82, 2);
  });

  it('night terrain retains roughly a quarter of noon luminance (the CORE.17.e premise)', () => {
    const p = (0.9 * Math.PI) / 180;
    const night = retailLightSum(up, [0.25 * Math.cos(p), 0.25 * Math.sin(p), 0], [220 / 255, 220 / 255, 220 / 255], [200 / 255, 100 / 255, 1], 0.4);
    const noon = retailLightSum(up, [0, 0.8, 0], [250 / 255, 215 / 255, 151 / 255], [230 / 255, 230 / 255, 1], 0.35);
    const grass: [number, number, number] = [90 / 255, 110 / 255, 50 / 255];
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const ratio = lum(retailShade(grass, night)) / lum(retailShade(grass, noon));
    expect(ratio).toBeLessThan(0.35);
    expect(ratio).toBeGreaterThan(0.15);
  });

  it('back-facing sun contributes nothing (max(0, N·L))', () => {
    const L = retailLightSum([0, -1, 0], [0, 0.8, 0], [1, 1, 1], [0, 0, 0], 0);
    expect(L).toEqual([0, 0, 0]);
  });

  it('object ambient = level + 0.2·dir_bright (SmartBox::SetWorldAmbientLight)', () => {
    expect(retailObjectAmbientScale(0.8, 0.35)).toBeCloseTo((0.35 + 0.16) / 0.35, 6);
    expect(retailObjectAmbientScale(0.25, 0.4)).toBeCloseTo((0.4 + 0.05) / 0.4, 6);
    expect(retailObjectAmbientScale(0.8, 0)).toBe(1);
  });

  it('sRGB helpers round-trip', () => {
    for (const v of [0, 0.01, 0.11, 0.4, 0.66, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
    // the whole point: a 0.40 light in gamma space is NOT 0.66
    expect(linearToSrgb(0.4)).toBeGreaterThan(0.66);
  });
});

describe('CORE.17.e — MeshLambertMaterial shader patch', () => {
  const src = THREE.ShaderLib.lambert.fragmentShader;

  it('rewrites the real three.js Lambert shaders: no 1/PI BRDF, gamma-space modulate, ambient scale (CORE.17.q.a: the sum is per vertex)', () => {
    const out = patchLambertFragment(src);
    const vert = patchLambertVertex(THREE.ShaderLib.lambert.vertexShader);
    // the per-fragment three.js light machinery is gone from the fragment stage …
    expect(out).not.toContain('BRDF_Lambert( material.diffuseColor )');
    expect(out).not.toContain('#include <lights_fragment_begin>');
    expect(out).not.toContain('#include <lights_pars_begin>');
    expect(out).toContain('varying vec3 vAcLight;');
    // … and the retail sum lives in the vertex stage: ambient × scale + Σ sun·max(0,N·L) + point lights, clamped
    expect(vert).toContain('uniform float acAmbientScale;');
    expect(vert).toContain('vec3 acSum = ambientLightColor * acAmbientScale;');
    // VISUAL.night-sky-vs-retail — AC_SUN_DIFFUSE is 1.0 except for sky materials (their D3D Diffuse).
    expect(vert).toContain('acSum += AC_SUN_DIFFUSE * directionalLights[ i ].color * saturate( dot( acN, directionalLights[ i ].direction ) );');
    expect(vert).toContain('#define AC_SUN_DIFFUSE 1.0');
    expect(vert).toContain('vAcLight = clamp( acSum, 0.0, 1.0 );');
    expect(vert).not.toContain('BRDF_Lambert');
    // CORE.17.k.b.b.a.g.b — the emissive term (D3DMATERIAL9.Emissive) is part
    // of the clamped vertex colour that modulates the texel, not a post-add.
    expect(out).toContain('vec3 acLight = clamp( AC_VERTEX_LIGHT + totalEmissiveRadiance, 0.0, 1.0 );');
    expect(out).toContain('sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) )');
    expect(out).toContain('vec3 outgoingLight = acSRGBToLinear( acTexel * acLight );');
    expect(out).not.toContain('acLight ) + totalEmissiveRadiance;');
    // the stock line is gone, the rest of the pipeline (output encode, fog) stays
    expect(out).not.toContain('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;');
    expect(out).toContain('#include <colorspace_fragment>');
    expect(out).toContain('#include <fog_fragment>');
  });

  it('refuses a non-Lambert shader instead of silently passing it through', () => {
    expect(() => patchLambertFragment(THREE.ShaderLib.basic.fragmentShader)).toThrow(/anchor/);
    expect(() => patchLambertVertex(THREE.ShaderLib.basic.vertexShader)).toThrow(/anchors/);
  });

  it('applyRetailLighting installs onBeforeCompile + cache key, idempotently, Lambert only', () => {
    const mat = new THREE.MeshLambertMaterial();
    expect(isRetailLit(mat)).toBe(false);
    const same = applyRetailLighting(mat, 'object');
    expect(same).toBe(mat);
    expect(isRetailLit(mat)).toBe(true);
    expect(mat.customProgramCacheKey()).toBe(`${RETAIL_LIGHTING_CACHE_KEY}:object|${SAMPLER_BIAS_CACHE_KEY}`); // CORE.17.h.g.c — the sampler-bias suffix rides along
    const before = mat.onBeforeCompile;
    applyRetailLighting(mat, 'landscape'); // no-op on an already patched instance
    expect(mat.onBeforeCompile).toBe(before);

    const basic = new THREE.MeshBasicMaterial();
    applyRetailLighting(basic, 'object');
    expect(isRetailLit(basic)).toBe(false);
  });

  it('object materials share the live ambient scale; landscape stays at 1', () => {
    const obj = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    const compile = (m: THREE.Material) => {
      const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: src };
      m.onBeforeCompile(shader as any, null as any);
      return shader;
    };
    setRetailLightLevels(0.8, 0.35);
    const so = compile(obj);
    const sl = compile(land);
    expect(so.uniforms.acAmbientScale.value).toBeCloseTo((0.35 + 0.16) / 0.35, 6);
    expect(sl.uniforms.acAmbientScale.value).toBe(1);
    // a later light tick reaches the already-compiled uniform object
    setRetailLightLevels(0.25, 0.4);
    expect(so.uniforms.acAmbientScale.value).toBeCloseTo(1.125, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo(1.125, 6);
    expect(so.fragmentShader).toContain('acSRGBToLinear( acTexel * acLight )');
  });

  it('a clone() loses the patch (three.js drops onBeforeCompile) and can be re-patched', () => {
    const mat = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const copy = mat.clone();
    expect(isRetailLit(copy)).toBe(false);
    applyRetailLighting(copy, 'object');
    expect(isRetailLit(copy)).toBe(true);
    expect(copy.customProgramCacheKey()).toBe(`${RETAIL_LIGHTING_CACHE_KEY}:object|${SAMPLER_BIAS_CACHE_KEY}`); // CORE.17.h.g.c — the sampler-bias suffix rides along
  });
});

describe('CORE.17.e — SkyboxRenderer publishes the RegionDesc curve verbatim', () => {
  it('midnight: sun 0.25 #dcdcdc, ambient 0.40 #c864ff, object scale 1.125', () => {
    const sky = makeSky();
    sky.updateTimeOfDay(0.0);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 6);
    expect(sky.ambient.intensity).toBeCloseTo(0.40, 6);
    // light colours are raw bytes/255 (gamma-space factors for the patch)
    expect(sky.ambient.color.r).toBeCloseTo(200 / 255, 6);
    expect(sky.ambient.color.g).toBeCloseTo(100 / 255, 6);
    expect(sky.ambient.color.b).toBeCloseTo(1, 6);
    expect(sky.directionalLight.color.r).toBeCloseTo(220 / 255, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo(1.125, 6);
  });

  it('noon: sun 0.8 #fad797, ambient 0.35 #e6e6ff, object scale 1.457', () => {
    const sky = makeSky();
    sky.updateTimeOfDay(0.5);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.8, 6);
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 6);
    expect(sky.ambient.color.b).toBeCloseTo(1, 6);
    expect(sky.directionalLight.color.g).toBeCloseTo(215 / 255, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo((0.35 + 0.16) / 0.35, 6);
  });

  it('the sun goes to the horizon at night (pitch 0.9°) and overhead at noon', () => {
    const sky = makeSky();
    sky.updateTimeOfDay(0.0);
    const n = sky.directionalLight.position.clone().normalize();
    expect(n.y).toBeCloseTo(Math.sin((0.9 * Math.PI) / 180), 4);
    sky.updateTimeOfDay(0.5);
    expect(sky.directionalLight.position.clone().normalize().y).toBeCloseTo(1, 4);
  });

  it('ambient level is floored at LScape::min_ambient (0.2)', () => {
    const dim = { ...NIGHT, ambBright: 0.05 };
    const sky = makeSky([dim, { ...NOON, ambBright: 0.05 }, { ...dim, begin: 0.999 }]);
    sky.updateTimeOfDay(0.0);
    expect(sky.ambient.intensity).toBeCloseTo(LSCAPE_LIGHT_MINIMUM, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo((0.2 + 0.05) / 0.2, 6);
  });

  it('fog + background DISPLAY as the DAT bytes: #171728 at night, 0..400; #c3c8dc by day', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    const bg = new THREE.Color(0x000000);
    sky.setFog(fog);
    sky.setSceneBackground(bg);

    sky.updateTimeOfDay(0.0);
    expect(bytes(fog.color)).toEqual([0x17, 0x17, 0x28]);
    expect(bytes(bg)).toEqual([0x17, 0x17, 0x28]);
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(400);
    // stored linear — copying the raw bytes in as linear displayed as ~#545470
    expect(fog.color.r).toBeLessThan(0.02);

    sky.updateTimeOfDay(0.5);
    expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
    expect(fog.near).toBe(150);
    expect(fog.far).toBe(2400);
  });
});

describe('CORE.17.e / CORE.17.q — SceneManager carries no undriven world light', () => {
  const lights = (sm: SceneManager) => ({
    ambient: sm.scene.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight,
    directionals: sm.scene.children.filter((c) => c instanceof THREE.DirectionalLight),
    points: sm.scene.children.filter((c) => c instanceof THREE.PointLight),
  });

  it('by default: NO ambient/fill/directional/point light of its own (indoors or out)', () => {
    const { ambient, directionals, points } = lights(new SceneManager());
    // DECOMP.environs-ambient-additive — not even an EnvironChange holder.
    expect(ambient).toBeUndefined();
    // CORE.17.q — the sealed-interior white fill + 0.25 ambient placeholder
    // is gone: interiors get the sky-curve ambient, DAT lights, viewer light.
    expect(directionals).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect((new SceneManager() as unknown as Record<string, unknown>).setSealedInteriorLighting).toBeUndefined();
  });

  it('an EnvironChange override lands on the ONE sky ambient (replacing the day level), Clear restores the day', () => {
    const sky = makeSky();
    sky.updateTimeOfDay(0.5);
    sky.setEnvironOverride({ fogColor: 0x960000, fogMin: 0, fogMax: 50, ambientColor: 0x960000, ambientLevel: 0.4 });
    for (let i = 0; i < 60; i++) sky.update(0.8);
    sky.resetTickTimers();
    sky.update(0.01);
    expect(sky.ambient.intensity).toBeCloseTo(0.4, 6);
    sky.setEnvironOverride(null);
    sky.resetTickTimers();
    sky.update(0.01);
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 2);
  });
});

describe('CORE.17.e — world material producers ship the patch', () => {
  it('MaterialFactory Lambert materials are retail-lit (object kind)', () => {
    const portalDb = { getFileData: () => null } as any; // surface missing → Lambert fallback
    const mf = new MaterialFactory(portalDb, {} as any);
    const mat = mf.getMaterial(0x08000001);
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(isRetailLit(mat)).toBe(true);
    // override path (unique instance) too
    const uniq = mf.getMaterial(0x08000001, undefined, new Map(), undefined);
    expect(uniq).not.toBe(mat);
    expect(isRetailLit(uniq)).toBe(true);
  });

  it('TerrainRenderer default material is retail-lit (landscape kind)', () => {
    const tr = new TerrainRenderer(new THREE.Scene(), {} as any);
    expect(isRetailLit((tr as any).material)).toBe(true);
  });
});
