/**
 * CORE.17.q.a — the retail world light equation is evaluated PER VERTEX
 * (D3D fixed-function Gouraud), with a hard Range cutoff, and env cells burn
 * their static DAT lights in through `calc_point_light` @ 0059c8b0.
 *
 * Ground truth (decompiled EoL client, reference/client-eol):
 *  - `PrimD3DRender::config_hardware_light` @ 0059ad30: Diffuse = colour ×
 *    intensity, Range = falloff × rangeAdjust (1.5), Attenuation (0, 1, 0).
 *  - `D3DPolyRender::SetStaticLightingVertexColors` @ 0059cfe0 →
 *    `calc_point_light` @ 0059c8b0: range = falloff × static_light_factor
 *    (.data 0x820e24 = 1.3), wrap = (N·D/d + 2·LIGHT_POINT_RANGE − 1) /
 *    (2·LIGHT_POINT_RANGE) with LIGHT_POINT_RANGE (.rdata 0x7e5430) = 0.75,
 *    f = (1 − d/range) · intensity · wrap · (d > 1 ? 1/d² : 1), per channel
 *    min(colour, f·colour), the sum clamped to [0,1] into the vertex diffuse
 *    and fed as the D3D emissive source (`RenderMeshSubset` @ 0059ca10).
 *  - `D3DPolyRender::SetSurface` (decomp :399056): stage 0 is TEXOP_MODULATE
 *    (texture × diffuse) — no MODULATE2X headroom; the vertex colour caps at 1.
 *
 * Behavioural: the JS mirrors of both per-vertex terms, the shader patch over
 * the real three.js (r186) Lambert shaders (both stages), the light-class channel, and
 * the kinds' program keys.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  RETAIL_STATIC_LIGHT_FACTOR,
  RETAIL_LIGHT_POINT_RANGE,
  RETAIL_LIGHT_RANGE_ADJUST,
  RETAIL_STATIC_RANGE_SCALE,
  retailStaticLightDecay,
  isRetailStaticLightDecay,
  retailHardwarePointLight,
  retailStaticPointLight,
  retailLightRange,
  patchLambertVertex,
  patchLambertFragment,
  applyRetailLighting,
  retailLightingCacheKey,
  RETAIL_LIGHT_LINE,
  LIGHT_VARYING,
  ENVCELL_DEFINE,
  LANDSCAPE_DEFINE,
  setRetailLightLevels,
  GLSL_POINT_GUARD,
  GLSL_SUN_GUARD,
} from '../packages/renderer/src/models/RetailLighting.js';
import { RETAIL_OUTGOING_LINE, detailTexturing } from '../packages/renderer/src/models/DetailTexturing.js';
import { SAMPLER_BIAS_CACHE_KEY } from '../packages/renderer/src/models/TextureSamplerPrefs.js';

const TORCH: [number, number, number] = [0xc8 / 255, 0x96 / 255, 0x64 / 255]; // Training Academy torch _RGB ffc89664
const UP: [number, number, number] = [0, 0, 1];

describe('CORE.17.q.a — the constants from acclient.exe', () => {
  it('static_light_factor 1.3 (.data 0x820e24), LIGHT_POINT_RANGE 0.75 (.rdata 0x7e5430), rangeAdjust 1.5', () => {
    expect(RETAIL_STATIC_LIGHT_FACTOR).toBeCloseTo(1.3, 6);
    expect(RETAIL_LIGHT_POINT_RANGE).toBe(0.75);
    expect(RETAIL_LIGHT_RANGE_ADJUST).toBe(1.5);
    // the env-cell static range as a fraction of the three.js distance (= the hardware Range)
    expect(RETAIL_STATIC_RANGE_SCALE).toBeCloseTo(1.3 / 1.5, 6);
    expect(retailLightRange(4.5) * RETAIL_STATIC_RANGE_SCALE).toBeCloseTo(4.5 * 1.3, 6);
  });

  it('the light-class channel: a static DAT light carries decay = −intensity; hardware lights stay ≥ 0', () => {
    expect(retailStaticLightDecay(100)).toBe(-100);
    expect(retailStaticLightDecay(-100)).toBe(-100);
    expect(isRetailStaticLightDecay(-100)).toBe(true);
    expect(isRetailStaticLightDecay(1)).toBe(false); // the viewer light
    expect(isRetailStaticLightDecay(2)).toBe(false); // three.js default (effect lights)
    expect(isRetailStaticLightDecay(0)).toBe(false);
  });
});

describe('CORE.17.q.a — the D3D hardware point light at a vertex (objects; dynamic lights on cells)', () => {
  it('Diffuse × max(0, N·L) / d inside Range, nothing at or beyond it (a hard cutoff, no smooth window)', () => {
    const falloff = 4.5; // Range 6.75
    // 3 m straight above a floor vertex facing up: intensity 100 / 3 → saturates later in the clamp
    expect(retailHardwarePointLight([0, 0, 0], UP, [0, 0, 3], TORCH, 100, falloff)[0]).toBeCloseTo(TORCH[0] * 100 / 3, 6);
    // just inside the range still lit at 1/d
    const inside = retailHardwarePointLight([0, 0, 0], UP, [0, 0, 6.74], TORCH, 100, falloff);
    expect(inside[1]).toBeCloseTo(TORCH[1] * 100 / 6.74, 6);
    // at / beyond the range: zero (three.js's pow2(1 − (d/R)^4) window would have faded it smoothly)
    expect(retailHardwarePointLight([0, 0, 0], UP, [0, 0, 6.75], TORCH, 100, falloff)).toEqual([0, 0, 0]);
    expect(retailHardwarePointLight([0, 0, 0], UP, [0, 0, 20], TORCH, 100, falloff)).toEqual([0, 0, 0]);
    // facing away: max(0, N·L) = 0, no wrap on the hardware path
    expect(retailHardwarePointLight([0, 0, 0], [0, 0, -1], [0, 0, 3], TORCH, 100, falloff)).toEqual([0, 0, 0]);
    // 60° off: cos = 0.5
    const off = retailHardwarePointLight([0, 0, 0], UP, [3 * Math.sin(Math.PI / 3), 0, 3 * Math.cos(Math.PI / 3)], TORCH, 100, falloff);
    expect(off[2]).toBeCloseTo(TORCH[2] * 100 * 0.5 / 3, 6);
  });
});

describe('CORE.17.q.a — calc_point_light @ 0059c8b0 (static DAT lights burned into env-cell vertices)', () => {
  const falloff = 4.5; // static range 5.85, hardware Range 6.75
  it('saturates at the raw colour near the torch, ramps to zero at falloff × 1.3 — shorter than the hardware Range', () => {
    // 2 m below the torch, floor facing up: f = (1 − 2/5.85) · 100 · 1 / 4 ≈ 16 → capped at the colour
    expect(retailStaticPointLight([0, 0, 0], UP, [0, 0, 2], TORCH, 100, falloff)).toEqual(TORCH);
    // 5 m: f = (1 − 5/5.85) · 100 · 1 / 25 = 0.581 → a soft edge below the colour
    const edge = retailStaticPointLight([0, 0, 0], UP, [0, 0, 5], TORCH, 100, falloff);
    const f = (1 - 5 / 5.85) * 100 / 25;
    expect(f).toBeLessThan(1);
    expect(edge[0]).toBeCloseTo(TORCH[0] * f, 6);
    expect(edge[1]).toBeCloseTo(TORCH[1] * f, 6);
    expect(edge[2]).toBeCloseTo(TORCH[2] * f, 6);
    // the linear window reaches zero exactly at the static range (5.85), inside the hardware Range (6.75)
    expect(retailStaticPointLight([0, 0, 0], UP, [0, 0, 5.85], TORCH, 100, falloff)[0]).toBeLessThan(1e-9); // (1 − d/range) → 0 within float rounding
    expect(retailStaticPointLight([0, 0, 0], UP, [0, 0, 6.5], TORCH, 100, falloff)).toEqual([0, 0, 0]);
    expect(retailHardwarePointLight([0, 0, 0], UP, [0, 0, 6.5], TORCH, 100, falloff)[0]).toBeGreaterThan(0);
    // monotone: the pool fades outward
    let prev = Infinity;
    for (const d of [3, 4, 4.5, 5, 5.5, 5.8]) {
      const v = retailStaticPointLight([0, 0, 0], UP, [0, 0, d], TORCH, 100, falloff)[0];
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it('the N·L is WRAPPED: (cos θ + 0.5) / 1.5 — a wall facing 90° away still takes a third, 120° or more nothing', () => {
    const I = 1, fo = 100; // range 130 m: no window / 1/d² to speak of at d = 1
    const face = retailStaticPointLight([0, 0, 0], UP, [0, 0, 1], TORCH, I, fo);
    const side = retailStaticPointLight([0, 0, 0], UP, [1, 0, 0], TORCH, I, fo);
    const back120 = retailStaticPointLight([0, 0, 0], UP, [Math.sin(2 * Math.PI / 3), 0, Math.cos(2 * Math.PI / 3)], TORCH, I, fo);
    const away = retailStaticPointLight([0, 0, 0], UP, [0, 0, -1], TORCH, I, fo);
    const w = 1 - 1 / 130;
    expect(face[0]).toBeCloseTo(TORCH[0] * w * 1.0, 5);        // cos 1 → wrap 1
    expect(side[0]).toBeCloseTo(TORCH[0] * w * (0.5 / 1.5), 5); // cos 0 → wrap 1/3
    expect(back120[0]).toBeCloseTo(0, 5);                        // cos −0.5 → wrap 0
    expect(away).toEqual([0, 0, 0]);                             // cos −1 → negative → skipped
  });

  it('inside one metre the 1/d² term is not applied (denominator d, not d³)', () => {
    const I = 2, fo = 100;
    const half = retailStaticPointLight([0, 0, 0], UP, [0, 0, 0.5], TORCH, I, fo);
    // f = (1 − 0.5/130) · 2 · 1 → capped at the colour (2 > 1)
    expect(half).toEqual(TORCH);
    const halfDim = retailStaticPointLight([0, 0, 0], UP, [0, 0, 0.5], TORCH, 0.25, fo);
    expect(halfDim[0]).toBeCloseTo(TORCH[0] * 0.25 * (1 - 0.5 / 130), 6); // no 4× from 1/0.25
  });

  it('caps per channel at the raw colour (min(colour, f·colour)), never above it', () => {
    const v = retailStaticPointLight([0, 0, 0], UP, [0, 0, 1.5], TORCH, 100, falloff);
    expect(v[0]).toBeLessThanOrEqual(TORCH[0]);
    expect(v[1]).toBeLessThanOrEqual(TORCH[1]);
    expect(v[2]).toBeLessThanOrEqual(TORCH[2]);
    expect(v).toEqual(TORCH);
  });
});

describe('CORE.17.q.a — the Gouraud shader patch over the real three.js Lambert shaders', () => {
  const vsrc = THREE.ShaderLib.lambert.vertexShader;
  const fsrc = THREE.ShaderLib.lambert.fragmentShader;
  // three.js WebGLProgram unrollLoopPattern (unchanged r160 → r186) — the vertex loops must match it.
  const UNROLL = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;

  it('the vertex stage declares three.js\'s light uniforms by name, sums them after project_vertex, and writes the clamped varying', () => {
    const v = patchLambertVertex(vsrc, 'object');
    expect(v).toContain('uniform vec3 ambientLightColor;');
    expect(v).toContain('uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];');
    expect(v).toContain('uniform PointLight pointLights[ NUM_POINT_LIGHTS ];');
    expect(v).toContain(`varying vec3 ${LIGHT_VARYING};`);
    // declared after <common> (saturate), summed after <project_vertex> (mvPosition + transformedNormal)
    expect(v.indexOf('#include <common>')).toBeLessThan(v.indexOf('uniform vec3 ambientLightColor;'));
    expect(v.indexOf('#include <project_vertex>')).toBeLessThan(v.indexOf('vec3 acN = normalize( transformedNormal );'));
    expect(v.indexOf('vec3 acN = normalize( transformedNormal );')).toBeLessThan(v.indexOf('#include <fog_vertex>'));
    expect(v).toContain('acSum += acPointLight( pointLights[ i ], mvPosition.xyz, acN );');
    expect(v).toContain(`${LIGHT_VARYING} = clamp( acSum, 0.0, 1.0 );`);
    // the hard cutoff and the D3D 1/d term
    expect(v).toContain('if ( d >= light.distance ) return vec3( 0.0 );');
    expect(v).toContain('return light.color * saturate( dot( n, lv ) / d ) / d;');
    // both loops in the shape WebGLProgram unrolls (NUM_* replaced by replaceLightNums first)
    const numbered = v.replace(/NUM_DIR_LIGHTS/g, '1').replace(/NUM_POINT_LIGHTS/g, '3');
    const loops = [...numbered.matchAll(UNROLL)];
    expect(loops.length).toBe(2);
    expect(loops[0][2]).toBe('1');
    expect(loops[1][2]).toBe('3');
  });

  it('envcell materials carry the calc_point_light branch for tagged static lights; object materials use the hardware term for every light', () => {
    const cell = patchLambertVertex(vsrc, 'envcell');
    const obj = patchLambertVertex(vsrc, 'object');
    expect(cell.startsWith(`#define ${ENVCELL_DEFINE}\n`)).toBe(true);
    expect(cell).toContain(`#ifdef ${ENVCELL_DEFINE}`);
    expect(cell).toContain('if ( light.decay < 0.0 ) {');
    expect(cell).toContain('float intensity = - light.decay;');
    expect(cell).toContain(`float range = light.distance * ${RETAIL_STATIC_RANGE_SCALE};`);
    expect(cell).toContain('float wrap = ( dot( n, lv ) / d + 0.5 ) / 1.5;');
    expect(cell).toContain('float f = ( 1.0 - d / range ) * intensity * wrap / ( d > 1.0 ? d * d : 1.0 );');
    expect(cell).toContain('return ( light.color / intensity ) * min( f, 1.0 );');
    // the object kind has the same GLSL text minus the define, so the branch compiles out
    expect(obj).not.toContain(`#define ${ENVCELL_DEFINE}`);
    expect(obj).toBe(cell.replace(`#define ${ENVCELL_DEFINE}\n`, ''));
  });

  it('landscape materials keep sun + ambient only (calc_lighting): the point loop is compiled out', () => {
    const land = patchLambertVertex(vsrc, 'landscape');
    expect(land.startsWith(`#define ${LANDSCAPE_DEFINE}\n`)).toBe(true);
    expect(land).toContain(GLSL_POINT_GUARD);
    expect(land).toContain(GLSL_SUN_GUARD);
    expect(land).not.toMatch(/#define AC_(ENVCELL|CELLOBJECT)/);
  });

  it('the fragment stage drops the per-fragment light loops and multiplies the texel by the varying (+ emissive, clamped)', () => {
    const f = patchLambertFragment(fsrc, 'envcell');
    for (const inc of ['#include <lights_pars_begin>', '#include <lights_lambert_fragment>', '#include <lights_fragment_begin>', '#include <lights_fragment_maps>', '#include <lights_fragment_end>']) {
      expect(f).not.toContain(inc);
    }
    expect(f).toContain(`varying vec3 ${LIGHT_VARYING};`);
    expect(f).toContain(RETAIL_LIGHT_LINE);
    expect(RETAIL_LIGHT_LINE).toBe('vec3 acLight = clamp( AC_VERTEX_LIGHT + totalEmissiveRadiance, 0.0, 1.0 );');
    expect(f).toContain(`#define AC_VERTEX_LIGHT ${LIGHT_VARYING}`); // single-sided: the one varying (RENDER.sidestype1-backface-lighting)
    expect(f).toContain(RETAIL_OUTGOING_LINE);
    expect(f).not.toContain('vec3 outgoingLight = reflectedLight.directDiffuse');
    // what stays: vViewPosition (normal_fragment_begin), fog, output encode
    expect(f).toContain('#include <lights_lambert_pars_fragment>');
    expect(f).toContain('#include <fog_fragment>');
    expect(f).toContain('#include <colorspace_fragment>');
    expect(f).not.toContain('uniform float acAmbientScale;'); // moved to the vertex stage
  });

  it('applyRetailLighting patches BOTH stages and keys the program per kind; the ambient scale reaches the vertex uniform', () => {
    const kinds = ['landscape', 'object', 'envcell'] as const;
    const keys = new Set<string>();
    for (const kind of kinds) {
      const mat = applyRetailLighting(new THREE.MeshLambertMaterial(), kind);
      const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: vsrc, fragmentShader: fsrc };
      (mat.onBeforeCompile as any)(shader, {});
      expect(shader.vertexShader).toContain(`${LIGHT_VARYING} = clamp( acSum, 0.0, 1.0 );`);
      expect(shader.fragmentShader).toContain(RETAIL_LIGHT_LINE);
      expect(shader.uniforms.acAmbientScale).toBeDefined();
      expect(mat.customProgramCacheKey()).toBe(`${retailLightingCacheKey(kind)}|${SAMPLER_BIAS_CACHE_KEY}`);
      keys.add(mat.customProgramCacheKey());
    }
    expect(keys.size).toBe(3);
    // the object factor applies to objects AND cells (SetWorldAmbientLight's calc_object_light); landscape stays at 1
    setRetailLightLevels(0.8, 0.35);
    const cell = applyRetailLighting(new THREE.MeshLambertMaterial(), 'envcell');
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    const sc = { uniforms: {} as Record<string, { value: number }>, vertexShader: vsrc, fragmentShader: fsrc };
    const sl = { uniforms: {} as Record<string, { value: number }>, vertexShader: vsrc, fragmentShader: fsrc };
    (cell.onBeforeCompile as any)(sc, {});
    (land.onBeforeCompile as any)(sl, {});
    expect(sc.uniforms.acAmbientScale.value).toBeCloseTo((0.35 + 0.16) / 0.35, 6);
    expect(sl.uniforms.acAmbientScale.value).toBe(1);
  });

  it('the environment detail variant is the envcell kind (DrawEnvCell burns static lights; DrawBuilding does not)', () => {
    const base = new THREE.MeshLambertMaterial();
    const env = detailTexturing.variantOf(base, 'environment');
    const bld = detailTexturing.variantOf(new THREE.MeshLambertMaterial(), 'building');
    expect(env.customProgramCacheKey()).toContain(retailLightingCacheKey('envcell'));
    expect(bld.customProgramCacheKey()).toContain(retailLightingCacheKey('object'));
  });
});
