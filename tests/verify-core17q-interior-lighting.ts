/**
 * CORE.17.q — sealed-interior lighting is retail-driven, not a placeholder.
 *
 * Retail (decompiled acclient ac1_sep13, reference/client-eol):
 *  - `LScape::UseTime` @ 00505880 ticks `set_landscape_lighting` →
 *    `SmartBox::SetWorldAmbientLight` @ 004530a0 and the D3D fog state from
 *    `SkyDesc::GetWorldFog` while the landscape is loaded. CORE.17.q.d: a
 *    SEALED cell releases the landscape (`CellManager::ChangePosition` @
 *    004559b0 → `LScape::release_all`, `loaded_cell_id = 0`) so that tick
 *    idles, and the same ChangePosition arm sets the constant
 *    `SetWorldAmbientLight(DUNGEON_LIGHT_MINIMUM 0.2, white)`; the sky
 *    values freeze at the last outdoor tick (verify-core17qd-dungeon-ambient).
 *  - `SmartBox::RenderNormalMode` @ 00453aa0: an interior viewer cell skips
 *    `LScape::draw` (sky/landscape) and `PView::DrawCells` @ 005a4840 renders
 *    cells under `Render::useSunlightSet(0)` after clearing to
 *    `RGBAColor_Black` — no sun, black backdrop.
 *  - `SmartBox::set_viewer` @ 00452c40 adds `viewer_light` (white, intensity
 *    DEFAULT_GAME_BRIGHTNESS × BASE_GAMMA_MULTIPLIER = 0.5 × 4.5, falloff 10,
 *    2 m above the player) as a dynamic light every frame, indoors and out.
 *  - `PrimD3DRender::config_hardware_light` @ 0059ad30: Range = falloff ×
 *    rangeAdjust (1.5, .data @ 0x820cc4), Diffuse = color × intensity,
 *    attenuation (0,1,0) = 1/d.
 *  - Landscape is lit per vertex (`CLandBlockStruct::calc_lighting`) by the
 *    sun + ambient only; point lights reach objects (`minimize_object_lighting`).
 *
 * Behavioral: drives the real SkyboxRenderer, ViewerLight and the shader patch.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import {
  createViewerLight,
  updateViewerLight,
  VIEWER_LIGHT_INTENSITY,
  VIEWER_LIGHT_FALLOFF,
  VIEWER_LIGHT_COLOR,
  VIEWER_LIGHT_PLAYER_OFFSET_Z,
  VIEWER_LIGHT_DEFAULT_GAME_BRIGHTNESS,
  VIEWER_LIGHT_BASE_GAMMA_MULTIPLIER,
} from '../packages/renderer/src/effects/ViewerLight.js';
import {
  applyRetailLighting,
  patchLambertFragment,
  patchLambertVertex,
  retailLightRange,
  rawByteColor,
  retailLightingCacheKey,
  RETAIL_LIGHT_RANGE_ADJUST,
  RETAIL_AMBIENT_BOOST,
  LANDSCAPE_DEFINE,
  GLSL_POINT_GUARD, GLSL_SUN_GUARD,
} from '../packages/renderer/src/models/RetailLighting.js';
import { SAMPLER_BIAS_CACHE_KEY } from '../packages/renderer/src/models/TextureSamplerPrefs.js';

// The real Dereth "Sunny" keyframes (tools/dump-region-lighting.ts, portal.dat
// 0x13000000): midnight vs noon — same fixture as verify-core17e.
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

function makeSky(): SkyboxRenderer {
  const desc = {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{ chanceOfOccur: 5, dayName: 'Sunny', skyObjects: [], skyTime: [NIGHT, NOON, NIGHT_END] }],
  } as any;
  return new SkyboxRenderer(desc, null);
}

const bytes = (c: THREE.Color): [number, number, number] => {
  const s = c.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
};

describe('CORE.17.q — SkyboxRenderer sealed-interior mode', () => {
  it('hides the dome, keeps the frozen sun on (FlushAlphaList draws delayed batches under useSunlightSet(1)), blackens the backdrop, sets the dungeon ambient, freezes the fog at entry', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    const bg = new THREE.Color(0x123456);
    sky.setFog(fog);
    sky.setSceneBackground(bg);
    sky.updateTimeOfDay(0.5);
    expect(sky.isSealedInterior).toBe(false);
    expect(bytes(bg)).toEqual([0xc3, 0xc8, 0xdc]);

    sky.setSealedInterior(true);
    expect(sky.isSealedInterior).toBe(true);
    expect(sky.skyObject.visible).toBe(false);
    // VISUAL.sylsfear-tree-foliage — the sun stays active for the clip/alpha
    // batches FlushAlphaList draws after DrawCells restores useSunlightSet(1);
    // the env-cell and cell-object kinds compile its loop out.
    expect(sky.directionalLight.visible).toBe(true);
    // PView::DrawCells clears to RGBAColor_Black
    expect(bytes(bg)).toEqual([0, 0, 0]);
    // CORE.17.q.d — the sealed arm of CellManager::ChangePosition:
    // SetWorldAmbientLight(DUNGEON_LIGHT_MINIMUM, 0xffffffff), not the sky curve
    expect(sky.ambient.intensity).toBeCloseTo(0.2, 6);
    expect(sky.ambient.color.r).toBeCloseTo(1, 6);
    expect(sky.ambient.color.g).toBeCloseTo(1, 6);
    expect(sky.ambient.color.b).toBeCloseTo(1, 6);
    // the D3D fog state is the sky's LAST OUTDOOR tick (LScape::UseTime idles
    // with the landscape released) — no invented 0x111111 5..60 dungeon fog
    expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
    expect(fog.near).toBe(150);
    expect(fog.far).toBe(2400);
  });

  it('the clock keeps running while sealed but the light/fog tick idles: midnight changes nothing, backdrop stays black', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    const bg = new THREE.Color();
    sky.setFog(fog);
    sky.setSceneBackground(bg);
    sky.updateTimeOfDay(0.5);
    // outdoors first: the landscape was loaded, so the sun freezes at its
    // last tick (a login straight into the dungeon: verify-initial-sunlight)
    sky.noteLandscapeLoaded();
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.0);
    expect(sky.currentTimeOfDay).toBe(0.0);
    expect(sky.ambient.intensity).toBeCloseTo(0.2, 6);
    expect(sky.ambient.color.g).toBeCloseTo(1, 6);
    expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
    expect(fog.near).toBe(150);
    expect(fog.far).toBe(2400);
    expect(bytes(bg)).toEqual([0, 0, 0]);
    // the sun stays frozen at its entry value; leaving re-ticks from the clock
    expect(sky.directionalLight.visible).toBe(true);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.80, 6);
    sky.setSealedInterior(false);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 6);
    expect(sky.ambient.intensity).toBeCloseTo(0.40, 6);
    expect(bytes(fog.color)).toEqual([0x17, 0x17, 0x28]);
  });

  it('leaving the interior restores the dome, sun and fog-colour backdrop', () => {
    const sky = makeSky();
    const bg = new THREE.Color();
    sky.setSceneBackground(bg);
    sky.updateTimeOfDay(0.5);
    sky.setSealedInterior(true);
    sky.setSealedInterior(false);
    expect(sky.skyObject.visible).toBe(true);
    expect(sky.directionalLight.visible).toBe(true);
    expect(bytes(bg)).toEqual([0xc3, 0xc8, 0xdc]);
    // a freshly linked backdrop is published immediately, not on the next tick
    const fresh = new THREE.Color(0x00ff00);
    sky.setSceneBackground(fresh);
    expect(bytes(fresh)).toEqual([0xc3, 0xc8, 0xdc]);
  });
});

describe('CORE.17.q — the retail viewer light (SmartBox::viewer_light)', () => {
  it('is white, 0.5 × 4.5 = 2.25 intensity, 10 m falloff × 1.5 range, 1/d attenuation', () => {
    expect(VIEWER_LIGHT_DEFAULT_GAME_BRIGHTNESS).toBe(0.5);
    expect(VIEWER_LIGHT_BASE_GAMMA_MULTIPLIER).toBe(4.5);
    expect(VIEWER_LIGHT_INTENSITY).toBe(2.25);
    expect(VIEWER_LIGHT_FALLOFF).toBe(10);
    expect(VIEWER_LIGHT_COLOR).toBe(0xffffff);
    const light = createViewerLight();
    expect(light).toBeInstanceOf(THREE.PointLight);
    expect(light.color.getHex()).toBe(0xffffff);
    expect(light.intensity).toBe(2.25);
    expect(light.distance).toBe(15);
    expect(light.decay).toBe(1);
    expect(light.visible).toBe(true);
    // not a DAT light: DatLightBudget must never toggle it
    expect(light.userData.datLight).toBeUndefined();
    expect(light.userData.viewerLight).toBe(true);
  });

  it('rides 2 m above the player origin, or on the bare viewer with no offset', () => {
    const light = createViewerLight();
    const viewer = new THREE.Vector3(1, 2, 3);
    updateViewerLight(light, new THREE.Vector3(10, 20, 30), viewer);
    expect(light.position.toArray()).toEqual([10, 20 + VIEWER_LIGHT_PLAYER_OFFSET_Z, 30]);
    expect(VIEWER_LIGHT_PLAYER_OFFSET_Z).toBe(2);
    updateViewerLight(light, null, viewer);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
  });
});

describe('CORE.17.q — point-light range + landscape immunity in the shader patch', () => {
  const src = THREE.ShaderLib.lambert.fragmentShader;

  it('retailLightRange = falloff × rangeAdjust (1.5); ambientBoostFactor is unity', () => {
    expect(RETAIL_LIGHT_RANGE_ADJUST).toBe(1.5);
    expect(retailLightRange(10)).toBe(15);
    expect(retailLightRange(4.5)).toBeCloseTo(6.75, 6);
    expect(RETAIL_AMBIENT_BOOST).toBe(1);
  });

  it('DAT light colour bytes are the working values (no sRGB decode), like the sky lights', () => {
    // Training Academy torch 0x2000838: _RGB ffc89664
    const c = rawByteColor(0xffc89664);
    expect(c.r).toBeCloseTo(0xc8 / 255, 6);
    expect(c.g).toBeCloseTo(0x96 / 255, 6);
    expect(c.b).toBeCloseTo(0x64 / 255, 6);
    expect(c.getHex(THREE.LinearSRGBColorSpace)).toBe(0xc89664);
    // the decode path would have darkened it to (0.58, 0.31, 0.13)
    expect(new THREE.Color(0xc89664).r).toBeLessThan(0.6);
  });

  it('landscape and object materials compile out the point-light loop (CORE.17.q.a: in the vertex stage; CORE.17.q.b: the landscape pass is sun-only)', () => {
    const vsrc = THREE.ShaderLib.lambert.vertexShader;
    const land = patchLambertVertex(vsrc, 'landscape');
    const obj = patchLambertVertex(vsrc, 'object');
    const dflt = patchLambertVertex(vsrc);
    expect(land.startsWith(`#define ${LANDSCAPE_DEFINE}\n`)).toBe(true);
    expect(land).toContain(GLSL_POINT_GUARD);
    expect(obj).not.toContain(`#define ${LANDSCAPE_DEFINE}`);
    expect(obj).toContain(GLSL_POINT_GUARD);
    expect(dflt).toBe(obj);
    // the sun (directional) loop is present for both — neither carries a cell define
    expect(land).toContain(GLSL_SUN_GUARD);
    expect(obj).toContain(GLSL_SUN_GUARD);
    expect(land).not.toMatch(/#define AC_(ENVCELL|CELLOBJECT)/);
    expect(obj).not.toMatch(/#define AC_(ENVCELL|CELLOBJECT)/);
    // the fragment stage carries the kind define too (its program differs by kind)
    expect(patchLambertFragment(src, 'landscape').startsWith(`#define ${LANDSCAPE_DEFINE}\n`)).toBe(true);
    expect(patchLambertFragment(src, 'object')).not.toContain(`#define ${LANDSCAPE_DEFINE}`);
  });

  it('the two kinds get distinct program cache keys (their GLSL differs now)', () => {
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    const obj = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    // CORE.17.h.g.c — every world material's key also carries the sampler-bias patch.
    expect(land.customProgramCacheKey()).toBe(`${retailLightingCacheKey('landscape')}|${SAMPLER_BIAS_CACHE_KEY}`);
    expect(obj.customProgramCacheKey()).toBe(`${retailLightingCacheKey('object')}|${SAMPLER_BIAS_CACHE_KEY}`);
    expect(land.customProgramCacheKey()).not.toBe(obj.customProgramCacheKey());
    const compile = (m: THREE.Material) => {
      const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: src };
      m.onBeforeCompile(shader as any, null as any);
      return shader.fragmentShader;
    };
    expect(compile(land)).toContain(`#define ${LANDSCAPE_DEFINE}`);
    expect(compile(obj)).not.toContain(`#define ${LANDSCAPE_DEFINE}`);
  });
});
