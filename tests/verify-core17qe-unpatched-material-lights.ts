/**
 * CORE.17.q.e — point lights on the built-in three.js materials that stay
 * outside the RetailLighting patch.
 *
 * (The WaterSurface plane this file also covered is gone — retail has no
 * water plane; BUG.watersurface-plane-shows-through-sea-level-land,
 * tests/verify-water-is-landscape.ts.)
 *
 *  - Any lit built-in material (the spell projectile meshes) takes point
 *    and spot lights with `config_hardware_light`'s attenuation (0, 1, 0) and
 *    D3DLIGHT9.Range: 1/d inside the range, nothing beyond — not three.js's
 *    smooth window that fades to 0 AT `distance`.
 *
 * The patched materials (applyRetailLighting) already carry the hard cut in
 * acPointLight; retailHardwarePointLight is its JS mirror (asserted here too).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyD3DPointAttenuation, d3dLightsParsBegin, retailD3DAttenuation,
  retailHardwarePointLight, retailLightRange,
} from '../packages/renderer/src/models/RetailLighting.js';
import { VIEWER_LIGHT_FALLOFF, VIEWER_LIGHT_INTENSITY } from '../packages/renderer/src/effects/ViewerLight.js';

/** Run a material's onBeforeCompile over the stock shader of its type, as WebGLPrograms does. */
function compile(material: THREE.Material, lib: 'phong' | 'standard'): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib[lib];
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms) } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

/** three.js r15x's physically-correct point attenuation (the smooth window the patch replaces). */
function threeAttenuation(d: number, cutoff: number, decay: number): number {
  let f = 1 / Math.max(Math.pow(d, decay), 0.01);
  if (cutoff > 0) f *= Math.pow(Math.min(Math.max(1 - Math.pow(d / cutoff, 4), 0), 1), 2);
  return f;
}

describe('CORE.17.q.e — the D3D attenuation on unpatched materials', () => {
  it('1/d inside Range, 0 at and beyond it — where three.js had faded the viewer light to ~0.4 of 1/d by 90 % of the range', () => {
    const R = retailLightRange(VIEWER_LIGHT_FALLOFF);
    expect(R).toBe(15);
    expect(retailD3DAttenuation(5, R)).toBeCloseTo(0.2, 12);
    expect(retailD3DAttenuation(14.99, R)).toBeCloseTo(1 / 14.99, 12);
    expect(retailD3DAttenuation(15, R)).toBe(0);
    expect(retailD3DAttenuation(20, R)).toBe(0);
    expect(retailD3DAttenuation(0, R)).toBe(100); // the 0.01 floor
    // three.js at 13.5 m (0.9 R): 1/d × (1 − 0.9^4)^2 ≈ 0.118 of 1/d … the D3D light is at full 1/d right up to the cut
    expect(threeAttenuation(13.5, R, 1) / (1 / 13.5)).toBeLessThan(0.13);
    expect(retailD3DAttenuation(13.5, R) / (1 / 13.5)).toBe(1);
    // the patched-material mirror agrees: a vertex facing the viewer light straight on
    const at = (d: number) => retailHardwarePointLight([0, 0, 0], [0, 0, 1], [0, 0, d], [1, 1, 1], VIEWER_LIGHT_INTENSITY, VIEWER_LIGHT_FALLOFF)[0];
    expect(at(10)).toBeCloseTo(VIEWER_LIGHT_INTENSITY * retailD3DAttenuation(10, R), 12);
    expect(at(15)).toBe(0);
  });

  it('d3dLightsParsBegin swaps both of three.js\'s attenuation calls for acD3DAttenuation and keeps the rest of the chunk', () => {
    const out = d3dLightsParsBegin();
    expect(out).toContain('acD3DAttenuation( lightDistance, pointLight.distance )');
    expect(out).toContain('acD3DAttenuation( lightDistance, spotLight.distance )');
    expect(out).not.toMatch(/getDistanceAttenuation\( lightDistance, (point|spot)Light\.distance/);
    expect(out).toContain('getPointLightInfo');
    expect(() => d3dLightsParsBegin('void main() {}')).toThrow(/anchors/);
  });

  it('applyD3DPointAttenuation patches a MeshStandardMaterial\'s program (fragment + vertex), keeps an earlier onBeforeCompile, keys the program, is idempotent', () => {
    const m = new THREE.MeshStandardMaterial({ emissive: 0xff0000 });
    let earlier = 0;
    m.onBeforeCompile = () => { earlier++; };
    const before = m.customProgramCacheKey();
    expect(applyD3DPointAttenuation(m)).toBe(m);
    applyD3DPointAttenuation(m);
    const sh = compile(m, 'standard');
    expect(earlier).toBe(1);
    expect(sh.fragmentShader).not.toContain('#include <lights_pars_begin>');
    expect(sh.fragmentShader).toContain('float acD3DAttenuation(');
    expect(sh.fragmentShader.match(/acD3DAttenuation\( lightDistance, pointLight\.distance \)/g)?.length).toBe(1);
    expect(m.customProgramCacheKey()).not.toBe(before);
    expect(m.customProgramCacheKey()).toContain('ac-d3d-atten');
  });
});
