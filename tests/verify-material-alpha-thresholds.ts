/**
 * FAITHFUL.215 → RENDER.translucent-writes-depth — per-surface-kind alpha
 * tests, now exactly D3DPolyRender::SetSurface @ 0059c4d0's:
 *
 *   - Base1ClipMap → alpha test at s_ddsAlphaTestRef (200) for a texture
 *     with no palette (this stub's), s_256AlphaTestRef (100) for a
 *     palettized one (verify-render-surface-draw-state.ts covers both).
 *   - Alpha without ClipMap → NO alpha test (blend SRCALPHA/INVSRCALPHA).
 *   - ClipMap | Alpha → alpha test + blend.
 *   - ClipMap | Translucent → Translucent wins: blend, no alpha test.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { Surface, SurfaceType } from '@ac/dat-parser/file-types/Surface.js';

function makeFactory(): MaterialFactory {
  const fakeTexture = {
    image: { width: 1, height: 1 }, needsUpdate: true,
  } as unknown as THREE.DataTexture;
  const stubTextureManager = {
    getTexture: () => fakeTexture,
    getTextureWithPalette: () => fakeTexture,
  } as unknown as ConstructorParameters<typeof MaterialFactory>[1];
  const stubPortalDb = {
    getFileData: (_id: number) => null,
  } as unknown as ConstructorParameters<typeof MaterialFactory>[0];
  return new MaterialFactory(stubPortalDb, stubTextureManager);
}

function materialForFlags(flags: number): THREE.Material {
  const factory = makeFactory();
  const synthSurface = new Surface();
  synthSurface.type = flags;
  synthSurface.origTextureId = 0x05000001;
  synthSurface.translucency = 0;
  synthSurface.luminosity = 0;
  synthSurface.diffuse = 1;
  // @ts-expect-error reach private loadSurface
  factory.loadSurface = () => synthSurface;
  return factory.getMaterial(0xdeadbeef);
}

const DDS_REF = 200 / 255;

describe('FAITHFUL.215 — per-surface-kind alpha-test thresholds', () => {
  it('Base1ClipMap surfaces alpha-test at the SetSurface ref, blend ONE/INVSRCALPHA and write depth (the clip list, after opaque)', () => {
    const mat = materialForFlags(SurfaceType.Base1ClipMap) as THREE.MeshLambertMaterial;
    expect(mat.alphaTest).toBeCloseTo(DDS_REF, 6);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(true);
    expect([mat.blendSrc, mat.blendDst]).toEqual([THREE.OneFactor, THREE.OneMinusSrcAlphaFactor]);
  });

  it('a clip-map that is also Translucent blends with the alpha test off', () => {
    const mat = materialForFlags(SurfaceType.Base1ClipMap | SurfaceType.Translucent) as THREE.MeshLambertMaterial;
    expect(mat.alphaTest).toBe(0);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
  });

  it('Alpha-flag (non-ClipMap) surfaces blend with no alpha test', () => {
    const mat = materialForFlags(SurfaceType.Base1Image | SurfaceType.Alpha) as THREE.MeshLambertMaterial;
    expect(mat.alphaTest).toBe(0);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
  });

  it('ClipMap | Alpha → alpha test and blend, depth write on', () => {
    const mat = materialForFlags(SurfaceType.Base1ClipMap | SurfaceType.Alpha) as THREE.MeshLambertMaterial;
    expect(mat.alphaTest).toBeCloseTo(DDS_REF, 6);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(true);
  });

  it('Base1Image without alpha-test flags → alphaTest = 0 (no test)', () => {
    const mat = materialForFlags(SurfaceType.Base1Image) as THREE.MeshLambertMaterial;
    expect(mat.alphaTest).toBe(0);
    expect(mat.transparent).toBe(false);
  });

  it('Additive surfaces produce a MeshBasicMaterial (luminous branch), ONE/ONE without the Alpha bit', () => {
    const mat = materialForFlags(SurfaceType.Base1Image | SurfaceType.Additive);
    expect(mat.type).toBe('MeshBasicMaterial');
    expect(mat.transparent).toBe(true);
    expect((mat as THREE.MeshBasicMaterial).blending).toBe(THREE.CustomBlending);
    expect([mat.blendSrc, mat.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    const withAlpha = materialForFlags(SurfaceType.Base1Image | SurfaceType.Additive | SurfaceType.Alpha);
    expect((withAlpha as THREE.MeshBasicMaterial).blending).toBe(THREE.AdditiveBlending);
  });
});
