/**
 * BUG.ac1999-bilinear-no-mips + BUG.ac1999-grey-lighting — the 1999 client's D3D6 hardware path,
 * as era rules (EraWorldRules.textureSampling / lightColour), end of retail and Dark Majesty
 * pinned unchanged.
 *
 * Samplers: Render_SetupD3DDevice @ 0x43d2a0 sets stage 0 MINFILTER / MAGFILTER = LINEAR and never
 * MIPFILTER; ImgTex_InitOther @ 0x42a34f creates every D3D texture with one level (DDSD 0x1007, no
 * MIPMAP caps). The 1999 Options page (PerformancePanel @ 0x594e00) has no filtering choice.
 *
 * Lighting: a 1999 vertex carries one intensity (vertex + 0x44: sun 0x5832b0, directional 0x5832f0,
 * point 0x583330, no colour read); the landscape is the scalar arm of 0x47d8a0 (its coloured arm
 * needs render modes 5-8, which WinMain never passes); the pre-lit draw 0x5836e0 writes I·255 into
 * R, G and B of a textured polygon. So the sun, the ambient and every DAT light are white at their
 * own level on a 1999 world.
 *
 * Drives the shipped TextureSamplerPrefs, SkyboxRenderer and ObjectLights.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { textureFilteringOption } from '../packages/renderer/src/era/EraWorldRules.js';
import {
  TextureSamplerPrefs, TEXTURE_FILTERING, SHARP_MIP_LOD_BIAS, fixedSamplerFilters, samplerFilters,
  type TextureFilteringMode,
} from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { eraLightColor, lightColourRule } from '../packages/renderer/src/models/RetailLighting.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { initObjectLights } from '../packages/renderer/src/effects/ObjectLights.js';
import type { LightInfo } from '../packages/dat-parser/src/file-types/SetupModel.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const DM = eraClientRules(eraProfile('classic-dereth'));

/** A world texture as TextureManager.getTexture makes it (trilinear, mipmapped). */
function worldTexture(size = 64): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

/** A landscape alpha map as TerrainRenderer makes it (a bare DataTexture: generateMipmaps off). */
function alphaMap(size = 64): THREE.DataTexture {
  return new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
}

describe('the era rules', () => {
  it('1999 fixes bilinear without mips and white lights; end of retail and Dark Majesty keep the prefs and colour', () => {
    expect(R1999.world.textureSampling).toBe('bilinearNoMips');
    expect(R1999.world.lightColour).toBe('intensityOnly');
    expect(textureFilteringOption(R1999.world)).toBe(false);
    for (const r of [EOR, DM]) {
      expect(r.world.textureSampling).toBe('prefs');
      expect(r.world.lightColour).toBe('rgb');
      expect(textureFilteringOption(r.world)).toBe(true);
    }
  });
});

describe('TextureSamplerPrefs: the era sampling rule', () => {
  it('prefs (end of retail / Dark Majesty): every filtering choice is unchanged and mips stay on', () => {
    const bias = { value: 0 };
    const p = new TextureSamplerPrefs(bias);
    p.setMaxAnisotropy(16);
    expect(p.samplingRule).toBe('prefs');
    expect(p.setSamplingRule('prefs')).toBe(false);
    const env = p.register(worldTexture(), 'environment');
    const land = p.register(worldTexture(512), 'landscape', undefined, { landscape: { uvCells: 8, baseTexSize: 1024 } });
    const alpha = p.register(alphaMap(), 'landscapeAlpha');
    for (const mode of [0, 1, 2, 3] as TextureFilteringMode[]) {
      p.set({ textureFiltering: mode });
      const f = samplerFilters(mode, 16);
      for (const t of [env, land, alpha]) {
        expect(t.minFilter).toBe(f.minFilter);
        expect(t.magFilter).toBe(f.magFilter);
        expect(t.anisotropy).toBe(f.anisotropy);
      }
      // The mip setting each creator gave stays: nothing in these eras gains or loses a chain.
      expect(env.generateMipmaps).toBe(true);
      expect(land.generateMipmaps).toBe(true);
      expect(alpha.generateMipmaps).toBe(false);
      expect(bias.value).toBe(mode === TEXTURE_FILTERING.SHARP ? SHARP_MIP_LOD_BIAS : 0);
    }
    // The retail default (Trilinear) is LinearMipmapLinear.
    p.set({ textureFiltering: TEXTURE_FILTERING.TRILINEAR });
    expect(env.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });

  it('bilinearNoMips (1999): bilinear min + mag, no mip chain, anisotropy 1, no LOD bias, whatever was stored', () => {
    const bias = { value: 0 };
    const p = new TextureSamplerPrefs(bias);
    p.setMaxAnisotropy(16);
    p.set({ textureFiltering: TEXTURE_FILTERING.SHARP }); // a value an end-of-retail session stored
    const before = p.register(worldTexture(), 'environment');
    expect(bias.value).toBe(SHARP_MIP_LOD_BIAS);
    expect(p.setSamplingRule('bilinearNoMips')).toBe(true);
    expect(p.samplingRule).toBe('bilinearNoMips');
    expect(bias.value).toBe(0);
    // Registered before the rule: re-applied. Registered after: built that way.
    const env = p.register(worldTexture(), 'environment');
    const land = p.register(worldTexture(512), 'landscape', undefined, { landscape: { uvCells: 8, baseTexSize: 1024 } });
    const alpha = p.register(alphaMap(), 'landscapeAlpha');
    const check = (t: THREE.Texture) => {
      expect(t.minFilter).toBe(THREE.LinearFilter);
      expect(t.magFilter).toBe(THREE.LinearFilter);
      expect(t.anisotropy).toBe(1);
      expect(t.generateMipmaps).toBe(false);
    };
    for (const t of [before, env, land, alpha]) check(t);
    // A clone (TerrainRenderer.cellLayoutClone / coarseClone) copies the mip flag and is registered too.
    const clone = env.clone();
    clone.generateMipmaps = true;
    p.register(clone, 'environment');
    check(clone);
    // The Config choice no longer reaches the samplers, and the stored value is kept.
    for (const mode of [0, 1, 2, 3] as TextureFilteringMode[]) {
      p.set({ textureFiltering: mode });
      for (const t of [env, land, alpha]) check(t);
      expect(bias.value).toBe(0);
      expect(p.textureFiltering).toBe(mode);
    }
    p.set({ textureFiltering: TEXTURE_FILTERING.ANISOTROPIC });
    p.setMaxAnisotropy(8);
    check(env);
    // The detail levels still apply (1999 had its own texture-resolution choices).
    p.set({ environmentTextureDetail: 3 });
    expect((env.image as { width: number }).width).toBeLessThan(64);
    expect(fixedSamplerFilters('prefs')).toBeNull();
  });
});

const sky = (dirColor: number, ambColor: number): SkyboxRenderer => {
  const frame = { begin: 0, dirBright: 0.8, dirHeading: 90, dirPitch: 45, dirColor,
    ambBright: 0.4, ambColor, minWorldFog: 0, maxWorldFog: 1000, worldFogColor: 0xff808080, worldFog: 0, skyObjReplace: [] };
  const s = new SkyboxRenderer({ tickSize: 0.8, lightTickSize: 15, dayGroups: [{ chanceOfOccur: 1,
    dayName: 'S', skyObjects: [], skyTime: [frame, { ...frame, begin: 0.5 }] }] } as never,
    { dayLength: 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);
  s.update(0.8);
  return s;
};
const lights = (s: SkyboxRenderer) => s as unknown as { sunLight: THREE.DirectionalLight; ambientLight: THREE.AmbientLight };

function light(over: Partial<LightInfo> = {}): LightInfo {
  return {
    viewerSpaceLocation: { origin: { x: 0.5, y: 1, z: 2 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    color: 0xffc89664, intensity: 3, falloff: 8, coneAngle: 0, ...over,
  } as LightInfo;
}

describe('light colour: white at its own level on 1999, the DAT colour elsewhere', () => {
  afterEach(() => { lightColourRule.value = 'rgb'; });

  it('eraLightColor: the raw bytes under rgb, white under intensityOnly', () => {
    expect(eraLightColor(0xffc89664, 'rgb').toArray()).toEqual([0xc8 / 255, 0x96 / 255, 0x64 / 255]);
    expect(eraLightColor(0xffc89664, 'intensityOnly').toArray()).toEqual([1, 1, 1]);
  });

  it('the sun and ambient: the 1999 region\'s 0xDCDCDC (and a tinted day) draw white at the DAT level on 1999 only', () => {
    for (const [dir, amb] of [[0xffdcdcdc, 0xffdcdcdc], [0xffffc080, 0xffc864ff]]) {
      lightColourRule.value = R1999.world.lightColour;
      const a = lights(sky(dir, amb));
      expect(a.sunLight.color.toArray()).toEqual([1, 1, 1]);
      expect(a.ambientLight.color.toArray()).toEqual([1, 1, 1]);
      expect(a.sunLight.intensity).toBeCloseTo(0.8, 6);
      expect(a.ambientLight.intensity).toBeCloseTo(0.4, 6);
      for (const r of [EOR, DM]) {
        lightColourRule.value = r.world.lightColour;
        const b = lights(sky(dir, amb));
        expect(b.sunLight.color.toArray()).toEqual(eraLightColor(dir, 'rgb').toArray());
        expect(b.ambientLight.color.toArray()).toEqual(eraLightColor(amb, 'rgb').toArray());
        expect(b.sunLight.intensity).toBeCloseTo(0.8, 6);
        expect(b.ambientLight.intensity).toBeCloseTo(0.4, 6);
      }
    }
  });

  it('object lights: a torch is white at its intensity on 1999, its colour elsewhere', () => {
    lightColourRule.value = R1999.world.lightColour;
    const [w] = initObjectLights(new THREE.Group(), [light()], false, null);
    expect(w.color.toArray()).toEqual([1, 1, 1]);
    expect(w.intensity).toBe(3);
    for (const r of [EOR, DM]) {
      lightColourRule.value = r.world.lightColour;
      const [c] = initObjectLights(new THREE.Group(), [light()], true, null);
      expect(c.color.r).toBeCloseTo(0xc8 / 255, 6);
      expect(c.color.g).toBeCloseTo(0x96 / 255, 6);
      expect(c.color.b).toBeCloseTo(0x64 / 255, 6);
      expect(c.intensity).toBe(3);
    }
  });
});
