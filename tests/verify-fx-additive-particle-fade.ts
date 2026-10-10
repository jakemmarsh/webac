/**
 * FX.additive-particle-faded-discarded — the particle shader folded the
 * per-particle translucency into the fragment alpha and then DISCARDED any
 * fragment under 0.003. A ONE/ONE surface (Additive without the Alpha bit,
 * D3DPolyRender::SetSurface @ 0059c4d0) ignores alpha in the blend, so
 * retail still adds a fully faded particle's colour; only translucency 1
 * removes it (CPhysicsPart::SetTranslucency @ 0050e670's no-draw bit — the
 * instance writer skips `alpha <= 0`). Drives the real makeParticleMaterial
 * through its onBeforeCompile against three's own Lambert program.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeParticleMaterial } from '../packages/renderer/src/effects/ParticleSystem.js';
import { SurfaceType as T } from '../packages/dat-parser/src/file-types/Surface.js';

function compiledFragment(type: number): string {
  const surf = { map: new THREE.Texture(), additive: (type & T.Additive) !== 0, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 1, type };
  const mat = makeParticleMaterial(surf, new THREE.Color(1, 1, 1), 'object', true, true);
  const lib = THREE.ShaderLib.lambert;
  const shader = {
    vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(lib.uniforms), defines: {}, shaderName: 'MeshLambertMaterial',
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader.fragmentShader;
}

describe('a faded particle is never discarded for its alpha', () => {
  it('ONE/ONE additive: the instance alpha only scales alpha, nothing discards it', () => {
    const frag = compiledFragment(T.Base1Image | T.Additive);
    const i = frag.indexOf('diffuseColor.a *= vAcInstanceAlpha;');
    expect(i).toBeGreaterThan(0);
    const after = frag.slice(i, frag.indexOf('#include <alphatest_fragment>', i));
    expect(after).not.toContain('discard');
  });

  it('the same for an alpha-blended particle (alpha 0 contributes nothing anyway)', () => {
    const frag = compiledFragment(T.Base1Image | T.Alpha);
    const i = frag.indexOf('diffuseColor.a *= vAcInstanceAlpha;');
    expect(frag.slice(i, frag.indexOf('#include <alphatest_fragment>', i))).not.toContain('discard');
  });
});
