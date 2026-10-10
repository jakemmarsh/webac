/**
 * VISUAL.sylsfear-canopy-bright-cards — the sun before any landscape loads.
 *
 * Retail (decompiled acclient ac1_sep13, reference/client-eol):
 *  - `PrimD3DRender::InitializeLights` @ 0059abf0 (device init) writes
 *    `Render::world_lights.sunlight` = (0, 0, 0xbf800000 = −1) and
 *    `sunlight_color` = (1, 1, 1); `LScape::sunlight` / `sunlight_color` are
 *    bss (globals.tsv), so zero.
 *  - Only `LScape::set_landscape_lighting` @ 005054d0 (the LScape::UseTime
 *    light tick, gated by `loaded_cell_id != 0`) and the outdoor /
 *    seen_outside arm of `CellManager::ChangePosition` @ 004559b0 write
 *    `world_lights.sunlight` afterwards. A sealed cell releases the landscape
 *    and never loads it.
 *  - `UpdateLightsInternal` builds the D3D sun as Diffuse = colour · |sunlight|
 *    and Direction = −sunlight, so a login straight into a dungeon lights the
 *    delayed leaf / glass batches (FlushAlphaList under useSunlightSet(1))
 *    with a white 1.0 sun from straight below, not the pre-world clock's.
 *
 * Behavioral: drives the real SkyboxRenderer.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  SkyboxRenderer,
  RETAIL_INITIAL_SUNLIGHT,
  RETAIL_INITIAL_SUNLIGHT_BRIGHTNESS,
  RETAIL_DEFAULT_DEVICE_FOG,
} from '../packages/renderer/src/effects/SkyboxRenderer.js';

// The real Dereth "Sunny" keyframes (tools/dump-region-lighting.ts), as in
// verify-core17q-interior-lighting.ts.
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
  const sky = new SkyboxRenderer(desc, null);
  // the pre-world ticks main.ts runs (the 0.35 fallback, then the server clock)
  sky.updateTimeOfDay(0.35);
  sky.updateTimeOfDay(0.5);
  return sky;
}

const sunDir = (sky: SkyboxRenderer): number[] =>
  sky.directionalLight.position.clone().normalize().toArray().map((v) => Math.round(v * 1e6) / 1e6 + 0);

describe('VISUAL.sylsfear-canopy-bright-cards — the InitializeLights sun', () => {
  it('is (0, 0, −1) white with brightness |sunlight| = 1', () => {
    expect(RETAIL_INITIAL_SUNLIGHT).toEqual({ x: 0, y: 0, z: -1 });
    expect(RETAIL_INITIAL_SUNLIGHT_BRIGHTNESS).toBe(1);
  });

  it('a login straight into a sealed cell lights with it, not with the pre-world clock', () => {
    const sky = makeSky();
    expect(sky.directionalLight.intensity).toBeCloseTo(0.80, 6); // the noon tick ran pre-world
    sky.setSealedInterior(true);
    expect(sky.directionalLight.visible).toBe(true);
    expect(sky.directionalLight.intensity).toBe(1);
    expect(sky.directionalLight.color.getHex()).toBe(0xffffff);
    // toward the light: AC −z is our −y (straight below)
    expect(sunDir(sky)).toEqual([0, -1, 0]);
    // the dungeon ambient is unchanged by it
    expect(sky.ambient.intensity).toBeCloseTo(0.2, 6);
  });

  it('holds through a day of clock ticks while sealed (the light tick idles)', () => {
    const sky = makeSky();
    sky.setSealedInterior(true);
    for (let t = 0; t < 1; t += 0.05) {
      sky.updateTimeOfDay(t);
      sky.update(30);
    }
    expect(sky.directionalLight.intensity).toBe(1);
    expect(sunDir(sky)).toEqual([0, -1, 0]);
  });

  it('a dungeon entered after an outdoor arrival keeps the frozen outdoor sun', () => {
    const sky = makeSky();
    sky.noteLandscapeLoaded();
    sky.setSealedInterior(true);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.80, 6);
    expect(sky.directionalLight.color.getHex()).not.toBe(0xffffff);
    expect(sunDir(sky)[1]).toBeCloseTo(1, 6); // noon pitch 90: overhead
  });

  it('leaving to the outdoors re-lights from the clock; a later dungeon freezes that sun', () => {
    const sky = makeSky();
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.0);
    sky.setSealedInterior(false);
    sky.noteLandscapeLoaded();
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 6); // midnight keyframe
    sky.setSealedInterior(true);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 6);
  });

  it('a logout from a dungeon and a login into another one keeps the initial sun (nothing loaded the landscape)', () => {
    const sky = makeSky();
    sky.setSealedInterior(true);
    sky.setSealedInterior(false); // logout: main.ts leaves sealed mode at char select
    sky.updateTimeOfDay(0.5);
    sky.setSealedInterior(true);
    expect(sky.directionalLight.intensity).toBe(1);
    expect(sunDir(sky)).toEqual([0, -1, 0]);
  });
});

/**
 * VISUAL.sylsfear-canopy-bright-cards.a — the fog before any landscape loads.
 * `RenderDeviceD3D::SetDefaultDeviceStates` @ 0059ffe0 sets
 * SetFFFogProperties(RGBAColor_White, 0, 1000); only the LScape::UseTime fog
 * tick (loaded_cell_id != 0) sets it again, and `RenderDeviceD3D::SetupState`
 * @ 005a0c70 enables fog for every mesh draw (WantFFDistanceFog = true).
 */
function makeFoggedSky(): { sky: SkyboxRenderer; fog: THREE.Fog } {
  const sky = makeSky();
  const fog = new THREE.Fog(0x000000, 1, 2);
  sky.setFog(fog);
  sky.updateTimeOfDay(0.5); // the server-clock tick: noon fog 150..2400
  return { sky, fog };
}

describe('VISUAL.sylsfear-canopy-bright-cards.a — the SetDefaultDeviceStates fog', () => {
  it('is white, 0 to 1000', () => {
    expect(RETAIL_DEFAULT_DEVICE_FOG).toEqual({ color: 0xffffffff, near: 0, far: 1000 });
  });

  it('a login straight into a sealed cell fogs with it, not with the pre-world clock', () => {
    const { sky, fog } = makeFoggedSky();
    expect(fog.near).toBeCloseTo(150, 4);
    expect(fog.far).toBeCloseTo(2400, 4);
    sky.setSealedInterior(true);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(1000);
  });

  it('holds through clock ticks while sealed (the fog tick idles)', () => {
    const { sky, fog } = makeFoggedSky();
    sky.setSealedInterior(true);
    for (let t = 0; t < 1; t += 0.05) {
      sky.updateTimeOfDay(t);
      sky.update(30);
    }
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(1000);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
  });

  it('a dungeon entered after an outdoor arrival keeps the frozen outdoor fog', () => {
    const { sky, fog } = makeFoggedSky();
    sky.noteLandscapeLoaded();
    sky.setSealedInterior(true);
    expect(fog.near).toBeCloseTo(150, 4);
    expect(fog.far).toBeCloseTo(2400, 4);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('c3c8dc');
  });

  it('leaving to the outdoors fogs from the clock again', () => {
    const { sky, fog } = makeFoggedSky();
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.0);
    sky.setSealedInterior(false);
    expect(fog.near).toBeCloseTo(0, 4);
    expect(fog.far).toBeCloseTo(400, 4); // midnight keyframe
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('171728');
  });
});
