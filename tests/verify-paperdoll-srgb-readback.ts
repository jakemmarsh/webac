/**
 * VISUAL.paperdoll-doll-dark — the UI's offscreen 3D views (inventory
 * paperdoll, chargen preview, examine portrait) read their render target
 * back as LINEAR colour: three (r160 through r186) applies the renderer's sRGB output
 * encode only to the default framebuffer, never to a non-XR
 * WebGLRenderTarget (WebGLPrograms: outputColorSpace is Linear whenever a
 * target is bound). copyRenderTargetToImageData must encode like the
 * screen does, or the doll draws ~4× too dark (live, real GPU: the lit
 * paperdoll averaged RGB ≈ (5, 5, 3) while the same clothing in the world
 * read ≈ 37).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js';
import { copyRenderTargetToImageData } from '../packages/renderer/src/ui/CreatureViewCamera.js';

const srgb = (lin: number) => {
  const c = lin / 255;
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

describe('VISUAL.paperdoll-doll-dark — offscreen viewport readback', () => {
  it('encodes RGB linear → sRGB (the screen framebuffer transfer) and leaves alpha alone', () => {
    const px = new Uint8Array([5, 5, 3, 255]);
    const out = new Uint8ClampedArray(4);
    copyRenderTargetToImageData(px, 1, 1, out);
    expect([...out]).toEqual([srgb(5), srgb(5), srgb(3), 255]);
    // The measured near-black doll becomes the world's dark green range.
    expect(out[0]).toBeGreaterThan(30);
    for (const [lin, want] of [[0, 0], [255, 255], [128, srgb(128)]] as const) {
      copyRenderTargetToImageData(new Uint8Array([lin, lin, lin, 77]), 1, 1, out);
      expect(out[0]).toBe(want);
      expect(out[3]).toBe(77);
    }
  });

  // The premise, driven through three's REAL program-parameter builder (the
  // deep src module the renderer bundles): with the canvas bound the program
  // encodes to renderer.outputColorSpace, with a plain (non-XR) render target
  // bound it writes the working colour space — linear sRGB — so the manual
  // encode above is the only one (r160 through r186: WebGLPrograms.getParameters
  // `outputColorSpace`). If a three upgrade starts encoding into offscreen
  // targets this fails, and the readback would double-encode.
  it('three writes LINEAR into a non-XR render target and sRGB only to the canvas', () => {
    const lights = {
      directional: [], directionalShadowMap: [], hemi: [], numLightProbes: 0, numSpotLightShadowsWithMaps: 0,
      point: [], pointShadowMap: [], rectArea: [], spot: [], spotLightMap: [], spotShadowMap: [], sun: [], sunShadowMap: [],
    };
    let target: THREE.WebGLRenderTarget | null = null;
    const renderer = {
      getRenderTarget: () => target,
      info: { programs: [] },
      outputColorSpace: THREE.SRGBColorSpace,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
      state: { buffers: { depth: { getReversed: () => false } } },
      toneMapping: THREE.NoToneMapping,
    };
    const programs = new WebGLPrograms(
      renderer as unknown as THREE.WebGLRenderer,
      { get: () => null } as unknown as ConstructorParameters<typeof WebGLPrograms>[1],
      { has: () => false, clipCullDistance: false, multiDraw: false } as unknown as ConstructorParameters<typeof WebGLPrograms>[2],
      { getMaxPrecision: (p: string) => p, logarithmicDepthBuffer: false, precision: 'highp' } as unknown as ConstructorParameters<typeof WebGLPrograms>[3],
      {} as ConstructorParameters<typeof WebGLPrograms>[4],
      { numPlanes: 0, numIntersection: 0 } as unknown as ConstructorParameters<typeof WebGLPrograms>[5],
    );
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    const params = () => programs.getParameters(
      mesh.material, lights as unknown as Parameters<typeof programs.getParameters>[1], [], new THREE.Scene(), mesh, [],
    );
    expect(params().outputColorSpace).toBe(THREE.SRGBColorSpace);
    target = new THREE.WebGLRenderTarget(4, 4);
    expect(params().outputColorSpace).toBe(THREE.LinearSRGBColorSpace);
  });

  it('flips WebGL bottom-up rows into top-down canvas rows', () => {
    // 1×2: bottom row (first in the buffer) red, top row blue.
    const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const out = new Uint8ClampedArray(8);
    copyRenderTargetToImageData(px, 1, 2, out);
    expect([...out]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });
});
