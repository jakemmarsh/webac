/**
 * RENDER.translucent-writes-depth — every surface material follows
 * D3DPolyRender::SetSurface @ 0059c4d0's blend / alpha-test / depth-write
 * table (decomp :399029). The bug: only Additive surfaces turned depth writes
 * off, so a Translucent surface — including the translucency-1.0 "blocker"
 * surfaces 0x08000034 / 0x080006C1 — drew nothing yet still wrote depth and
 * hid whatever lay behind it, and Alpha surfaces wrote depth over the scene.
 *
 * Also pinned here: SetSurface's alpha-test refs (s_256AlphaTestRef 100 for
 * palettized textures, s_ddsAlphaTestRef 200 otherwise — globals.tsv), the
 * ONE/ONE factor of an Additive surface without the Alpha bit, and the part
 * fade (CMaterial has_alpha) turning depth writes and the alpha test off.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import {
  MaterialFactory, surfaceDrawState, surfaceBlendsAdditive, alphaTestRefFor, D3DBlend,
} from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { Surface, SurfaceType as T } from '../packages/dat-parser/src/file-types/Surface.js';
import { setObjectTranslucency } from '../packages/renderer/src/models/ObjectTranslucency.js';
import {
  surfaceDelayList, surfaceMaterialState, prepareSurfaceMesh, CLIP_LIST_RENDER_ORDER,
} from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureSamplerPrefs, markPalettedImage, VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL } from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { makeParticleMaterial } from '../packages/renderer/src/effects/ParticleSystem.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

function factoryWith(surface: Surface, paletted: boolean): MaterialFactory {
  const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  tex.userData.acPaletted = paletted;
  const textures = { getTexture: () => tex, getTextureWithPalette: () => tex } as unknown as TextureManager;
  const factory = new MaterialFactory({ getFileData: () => null } as unknown as DatDatabase, textures);
  // @ts-expect-error reach the private DAT read
  factory.loadSurface = () => surface;
  return factory;
}

function material(type: number, translucency = 0, paletted = true): THREE.Material {
  const s = new Surface();
  s.type = type;
  s.origTextureId = 0x05000001;
  s.translucency = translucency;
  s.diffuse = 1;
  return factoryWith(s, paletted).getMaterial(0x08000001);
}

const REF_256 = 100 / 255;
const REF_DDS = 200 / 255;

describe('SetSurface decision table → three.js material state', () => {
  // [name, type, transparent, alphaTest, depthWrite, blending]
  const rows: [string, number, boolean, number, boolean, THREE.Blending][] = [
    ['opaque image', T.Base1Image, false, 0, true, THREE.NormalBlending],
    ['clip-map: alpha test + ONE/INVSRCALPHA + depth write, after the opaque pass', T.Base1ClipMap, true, REF_256, true, THREE.CustomBlending],
    ['Alpha: blend, no alpha test, no depth write', T.Base1Image | T.Alpha, true, 0, false, THREE.NormalBlending],
    ['ClipMap + Alpha: alpha test + blend, depth write', T.Base1ClipMap | T.Alpha, true, REF_256, true, THREE.NormalBlending],
    ['Translucent: blend, no depth write', T.Base1Image | T.Translucent, true, 0, false, THREE.NormalBlending],
    ['ClipMap + Translucent: Translucent wins', T.Base1ClipMap | T.Translucent, true, 0, false, THREE.NormalBlending],
    ['Additive + Alpha: SRCALPHA/ONE, no depth write', T.Base1Image | T.Additive | T.Alpha, true, 0, false, THREE.AdditiveBlending],
    ['Additive alone: ONE/ONE, no depth write', T.Base1Image | T.Additive, true, 0, false, THREE.CustomBlending],
    ['ClipMap + Additive: alpha test keeps depth write', T.Base1ClipMap | T.Additive, true, REF_256, true, THREE.CustomBlending],
    ['ClipMap + Translucent + Additive: SRCALPHA/INVSRCALPHA, no depth write', T.Base1ClipMap | T.Translucent | T.Additive, true, 0, false, THREE.NormalBlending],
  ];
  for (const [name, type, transparent, alphaTest, depthWrite, blending] of rows) {
    it(name, () => {
      const m = material(type, (type & T.Translucent) ? 0.5 : 0);
      expect(m.transparent).toBe(transparent);
      expect(m.alphaTest).toBeCloseTo(alphaTest, 6);
      expect(m.depthWrite).toBe(depthWrite);
      expect(m.blending).toBe(blending);
    });
  }

  it('Additive ONE/ONE and InvAlpha INVSRCALPHA/SRCALPHA use the exact D3D factors', () => {
    const add = material(T.Base1Image | T.Additive);
    expect([add.blendSrc, add.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    const inv = material(T.Base1Image | T.InvAlpha);
    expect([inv.blendSrc, inv.blendDst]).toEqual([THREE.OneMinusSrcAlphaFactor, THREE.SrcAlphaFactor]);
    expect(inv.depthWrite).toBe(false);
  });

  it('a Translucent surface with translucency 0 still blends and writes no depth (curr_alpha = 255)', () => {
    const m = material(T.Base1Image | T.Translucent, 0);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(1);
    expect(m.depthWrite).toBe(false);
  });

  it('the alpha-test ref follows the texture: 100 palettized, 200 otherwise', () => {
    expect(material(T.Base1ClipMap, 0, true).alphaTest).toBeCloseTo(REF_256, 6);
    expect(material(T.Base1ClipMap, 0, false).alphaTest).toBeCloseTo(REF_DDS, 6);
    expect(alphaTestRefFor(null)).toBeCloseTo(REF_DDS, 6);
  });

  it('surfaceDrawState is the decomp table (pure)', () => {
    expect(surfaceDrawState(T.Base1Solid)).toEqual({ blend: false, src: D3DBlend.One, dst: D3DBlend.Zero, alphaTest: false, depthWrite: true, fog: true });
    expect(surfaceDrawState(T.Base1ClipMap)).toMatchObject({ blend: true, src: D3DBlend.One, dst: D3DBlend.InvSrcAlpha, alphaTest: true, depthWrite: true });
    expect(surfaceDrawState(T.Additive).fog).toBe(false);
    // the Cloudy cloud dome 0x08000023 (type 0x10114) is not additive; rain 0x10112 is
    expect(surfaceBlendsAdditive(0x10114)).toBe(false);
    expect(surfaceBlendsAdditive(0x10112)).toBe(true);
  });
});

describe('SetSurface depth state, delayed lists and the bound-texture ref', () => {
  it('every surface material tests depth LESS (zfuncVal = 2) in one pass', () => {
    for (const type of [T.Base1Image, T.Base1ClipMap, T.Base1Image | T.Alpha, T.Base1Image | T.Additive]) {
      const m = material(type);
      expect(m.depthFunc).toBe(THREE.LessDepth);
      expect(m.forceSinglePass).toBe(true);
    }
  });

  it('ConstructMesh\'s delay tags: Alpha/InvAlpha/Additive → alpha list, else ClipMap → clip list, else Translucent → alpha list', () => {
    expect(surfaceDelayList(T.Base1Image)).toBe('none');
    expect(surfaceDelayList(T.Base1ClipMap)).toBe('clip');
    expect(surfaceDelayList(T.Base1ClipMap | T.Translucent)).toBe('clip');
    expect(surfaceDelayList(T.Base1ClipMap | T.Alpha)).toBe('alpha');
    expect(surfaceDelayList(T.Base1ClipMap | T.Additive)).toBe('alpha');
    expect(surfaceDelayList(T.Base1Image | T.Translucent)).toBe('alpha');
  });

  it('clip-list meshes draw in the clip band, before the alpha list (FlushAlphaList: clip, then alpha)', () => {
    const mesh = (type: number) => { const m = new THREE.Mesh(new THREE.BufferGeometry(), material(type, (type & T.Translucent) ? 0.5 : 0)); prepareSurfaceMesh(m); return m; };
    expect(mesh(T.Base1ClipMap).renderOrder).toBe(CLIP_LIST_RENDER_ORDER);
    expect(mesh(T.Base1ClipMap | T.Translucent).renderOrder).toBe(CLIP_LIST_RENDER_ORDER);
    expect(mesh(T.Base1ClipMap | T.Alpha).renderOrder).toBe(0);
    expect(mesh(T.Base1Image | T.Additive).renderOrder).toBe(0);
    expect(CLIP_LIST_RENDER_ORDER).toBeLessThan(0);
  });

  it('a material with alpha (fade) keeps an already-blending surface\'s factors and drops depth writes', () => {
    expect(surfaceMaterialState(T.Base1Image | T.Additive, 0, null, true)).toMatchObject({ blending: THREE.CustomBlending, depthWrite: false, alphaTest: 0 });
    expect(surfaceMaterialState(T.Base1ClipMap, 0, new THREE.Texture(), true)).toMatchObject({ blending: THREE.NormalBlending, depthWrite: false, alphaTest: 0, clipList: false });
  });

  it('the alpha-test ref follows the texture bound at draw time', () => {
    const m = material(T.Base1ClipMap, 0, true) as THREE.MeshLambertMaterial;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    const draw = (mat: THREE.Material) => mat.onBeforeRender(null as never, null as never, null as never, mesh.geometry, mesh, null as never);
    expect(m.alphaTest).toBeCloseTo(REF_256, 6);
    m.map!.userData.acPaletted = false; // Very High bound the DXT highres level
    draw(m);
    expect(m.alphaTest).toBeCloseTo(REF_DDS, 6);
    m.alphaTest = 0; // a faded part: left alone
    draw(m);
    expect(m.alphaTest).toBe(0);
  });

  it('copies made outside the mesh factories sync too (examine / paperdoll / held-item clones)', () => {
    const m = material(T.Base1ClipMap, 0, true) as THREE.MeshLambertMaterial;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    const copy = mesh.clone();
    copy.material = m.clone(); // authoredMaterialCopy / copyForMutation shape
    const cm = copy.material as THREE.MeshLambertMaterial;
    expect(cm.alphaTest).toBeCloseTo(REF_256, 6);
    m.map!.userData.acPaletted = false;
    cm.onBeforeRender(null as never, null as never, null as never, copy.geometry, copy, null as never);
    expect(cm.alphaTest).toBeCloseTo(REF_DDS, 6);
    // and an untagged material is never touched
    const plain = new THREE.MeshBasicMaterial({ alphaTest: 0.3, map: m.map });
    plain.onBeforeRender(null as never, null as never, null as never, copy.geometry, copy, null as never);
    expect(plain.alphaTest).toBe(0.3);
  });

  it('TextureSamplerPrefs re-tags a texture with the palette of the image it binds', () => {
    const prefs = new TextureSamplerPrefs();
    const portal = markPalettedImage({ data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 });
    const dxt = { data: new Uint8Array(32 * 32 * 4), width: 32, height: 32 };
    const tex = new THREE.DataTexture(portal.data, 16, 16);
    prefs.register(tex, 'environment', portal, { hiRes: () => dxt });
    expect(tex.userData.acPaletted).toBe(true);
    prefs.set({ environmentTextureDetail: VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL });
    prefs.setHighResMounted(true);
    expect(prefs.isAtHighRes(tex)).toBe(true);
    expect(tex.userData.acPaletted).toBe(false);
    prefs.setHighResMounted(false);
    expect(tex.userData.acPaletted).toBe(true);
  });
});

describe('particles take SetSurface\'s state for their surface', () => {
  const surf = (type: number, map: THREE.Texture | null = new THREE.Texture()) => {
    if (map) map.userData.acPaletted = true;
    return { map, additive: (type & T.Additive) !== 0, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 1, type };
  };
  it('a non-fading clip-map particle alpha-tests at the ref and writes depth', () => {
    const m = makeParticleMaterial(surf(T.Base1ClipMap), new THREE.Color(1, 1, 1), 'object', true, false);
    expect(m.alphaTest).toBeCloseTo(REF_256, 6);
    expect(m.depthWrite).toBe(true);
    expect(m.depthFunc).toBe(THREE.LessDepth);
  });
  it('a fading particle (material alpha) drops the alpha test and depth writes', () => {
    const m = makeParticleMaterial(surf(T.Base1ClipMap), new THREE.Color(1, 1, 1), 'object', true, true);
    expect(m.alphaTest).toBe(0);
    expect(m.depthWrite).toBe(false);
    expect(m.blending).toBe(THREE.NormalBlending);
  });
  it('an additive particle without the Alpha bit blends ONE/ONE; with it SRCALPHA/ONE', () => {
    const one = makeParticleMaterial(surf(T.Base1Image | T.Additive), new THREE.Color(1, 1, 1), 'object', true, false);
    expect([one.blending, one.blendSrc, one.blendDst]).toEqual([THREE.CustomBlending, THREE.OneFactor, THREE.OneFactor]);
    const src = makeParticleMaterial(surf(T.Base1Image | T.Additive | T.Alpha), new THREE.Color(1, 1, 1), 'object', true, false);
    expect(src.blending).toBe(THREE.AdditiveBlending);
    expect(src.depthWrite).toBe(false);
  });
});

describe('a part fade (CMaterial has_alpha) stops depth writes and the alpha test', () => {
  it('fades a clip-map part with blend on, depth write and alpha test off, and restores it', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material(T.Base1ClipMap));
    const part = new THREE.Group(); part.name = 'part_0'; part.add(mesh);
    const root = new THREE.Group(); root.add(part);
    setObjectTranslucency(root, 0.5);
    const faded = mesh.material as THREE.Material;
    expect(faded.transparent).toBe(true);
    expect(faded.depthWrite).toBe(false);
    expect(faded.alphaTest).toBe(0);
    expect(faded.opacity).toBeCloseTo(0.5, 6);
    setObjectTranslucency(root, 0);
    const back = mesh.material as THREE.Material;
    expect(back.transparent).toBe(true); // the clip list's own blend
    expect(back.blending).toBe(THREE.CustomBlending);
    expect(back.depthWrite).toBe(true);
    expect(back.alphaTest).toBeCloseTo(REF_256, 6);
    expect(back.opacity).toBe(1);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('real surfaces (DAT)', () => {
  let factory: MaterialFactory;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    factory = new MaterialFactory(portal, new TextureManager(portal));
  });

  it('the translucency-1.0 blockers 0x08000034 / 0x080006C1 draw nothing and write no depth', () => {
    for (const id of [0x08000034, 0x080006c1]) {
      expect(factory.getSurface(id)?.type).toBe(T.Base1Solid | T.Translucent);
      const m = factory.getMaterial(id);
      expect(m.opacity).toBe(0);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
    }
  });

  it('the half-translucent clip-map window 0x08000155 blends without alpha test or depth write', () => {
    const s = factory.getSurface(0x08000155)!;
    expect(s.type & 0xff).toBe(T.Base1ClipMap | T.Translucent);
    const m = factory.getMaterial(0x08000155);
    expect(m.opacity).toBeCloseTo(0.5, 6);
    expect(m.transparent).toBe(true);
    expect(m.alphaTest).toBe(0);
    expect(m.depthWrite).toBe(false);
  });
});
