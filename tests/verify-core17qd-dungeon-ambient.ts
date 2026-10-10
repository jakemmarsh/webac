/**
 * CORE.17.q.d — the sealed-dungeon ambient is a CONSTANT, and the light tick
 * idles underground.
 *
 * Retail (decompiled acclient ac1_sep13 + acclient.exe, reference/client-eol):
 *  - `CellManager::ChangePosition` @ 004559b0 runs its lighting arms on a
 *    CELL CHANGE only (early `goto` while load_pos.objcell_id is unchanged):
 *    outdoors / `curr_cell->seen_outside` → `LScape::sunlight` into
 *    `Render::world_lights` + `SmartBox::SetWorldAmbientLight(
 *    LScape::calc_object_light(), LScape::ambient_color)`; a SEALED cell →
 *    `LScape::release_all` (loaded_cell_id = 0, GameSky::SetInactive) then
 *    `SetWorldAmbientLight(DUNGEON_LIGHT_MINIMUM, 0xffffffff)` — bytes at
 *    0x455aeb `mov edx,[0x79b7fc]; push -1; push edx; call 0x4530a0`, the
 *    float at .rdata 0x79b7fc = 0.2f.
 *  - `SmartBox::SetWorldAmbientLight` @ 004530a0:
 *    `Render::world_lights.ambient_color = RGBColor(colour) · level`.
 *  - `LScape::UseTime` @ 00505880 — the only caller of
 *    `set_landscape_lighting` @ 005054d0 (→ SetWorldAmbientLight with the
 *    calc_object_light level) and of `SetFFFogProperties` — is gated by
 *    `if (this->loaded_cell_id != 0)`; only `LScape::update_loadpoint`
 *    (`CellManager::UpdateLoadPoint` @ 00455710: an outdoor objcell only,
 *    or ChangePosition's seen_outside arm via get_outside_cell_id) sets it.
 *    So the sun / ambient / fog freeze at the last outdoor tick while sealed.
 *  - `keep_lscape_loaded` is written once (0, the CellManager ctor) — the
 *    release always happens.
 *
 * Behavioral: drives the real SkyboxRenderer and the RetailLighting uniforms.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import {
  DUNGEON_LIGHT_MINIMUM,
  DUNGEON_AMBIENT_COLOR,
  LSCAPE_LIGHT_MINIMUM,
  currentObjectAmbientScale,
  retailObjectAmbientScale,
} from '../packages/renderer/src/models/RetailLighting.js';

// The real Dereth "Sunny" keyframes (tools/dump-region-lighting.ts, portal.dat
// 0x13000000): midnight vs noon — the verify-core17q fixture.
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

/** The scene ambient × the object scale = what an env cell / object material sums. */
const objectAmbient = (sky: SkyboxRenderer): [number, number, number] => {
  const k = sky.ambient.intensity * currentObjectAmbientScale();
  return [sky.ambient.color.r * k, sky.ambient.color.g * k, sky.ambient.color.b * k];
};

describe('CORE.17.q.d — DUNGEON_LIGHT_MINIMUM', () => {
  it('is 0.2 white (.rdata 0x79b7fc; the same value as LSCAPE_LIGHT_MINIMUM, a different global)', () => {
    expect(DUNGEON_LIGHT_MINIMUM).toBe(0.2);
    expect(DUNGEON_LIGHT_MINIMUM).toBe(LSCAPE_LIGHT_MINIMUM);
    expect(DUNGEON_AMBIENT_COLOR >>> 0).toBe(0xffffffff);
  });
});

describe('CORE.17.q.d — a sealed cell lights at the constant, at every hour', () => {
  it('noon entry: ambient becomes white 0.2 and the object scale is exactly 1', () => {
    const sky = makeSky();
    sky.updateTimeOfDay(0.5);
    // outdoors at noon: the landscape ambient is the sky's, objects add 0.2·|sun|
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo(retailObjectAmbientScale(0.80, 0.35), 6);
    sky.setSealedInterior(true);
    expect(sky.ambient.intensity).toBeCloseTo(DUNGEON_LIGHT_MINIMUM, 6);
    expect(sky.ambient.color.r).toBeCloseTo(1, 6);
    expect(sky.ambient.color.g).toBeCloseTo(1, 6);
    expect(sky.ambient.color.b).toBeCloseTo(1, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo(1, 6);
    const [r, g, b] = objectAmbient(sky);
    expect(r).toBeCloseTo(0.2, 6);
    expect(g).toBeCloseTo(0.2, 6);
    expect(b).toBeCloseTo(0.2, 6);
  });

  it('midnight entry gives the identical ambient (no magenta night cast underground)', () => {
    const noon = makeSky();
    noon.updateTimeOfDay(0.5);
    noon.setSealedInterior(true);
    const atNoon = objectAmbient(noon);

    const night = makeSky();
    night.updateTimeOfDay(0.0);
    expect(night.ambient.color.g).toBeCloseTo(100 / 255, 6); // the sky's c864ff outdoors
    night.setSealedInterior(true);
    expect(objectAmbient(night)).toEqual(atNoon);
    expect(night.ambient.color.g).toBeCloseTo(1, 6);
  });

  it('the light tick idles while sealed: a whole day of clock ticks changes nothing', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    sky.setFog(fog);
    sky.updateTimeOfDay(0.5);
    sky.noteLandscapeLoaded(); // entered from outdoors (a direct sealed login fogs with SetDefaultDeviceStates', verify-initial-sunlight.ts)
    sky.setSealedInterior(true);
    const sunBefore = sky.directionalLight.intensity;
    const sunColorBefore = sky.directionalLight.color.getHex();
    for (let i = 0; i <= 24; i++) {
      sky.update(sky.DAY_DURATION / 7); // 25 × a seventh of a day of game clock (solo-mode free run)
      expect(sky.ambient.intensity).toBeCloseTo(DUNGEON_LIGHT_MINIMUM, 6);
      expect(sky.ambient.color.getHex()).toBe(0xffffff);
      expect(currentObjectAmbientScale()).toBeCloseTo(1, 6);
      expect(sky.directionalLight.intensity).toBe(sunBefore);
      expect(sky.directionalLight.color.getHex()).toBe(sunColorBefore);
      expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
      expect(fog.near).toBe(150);
      expect(fog.far).toBe(2400);
    }
    // the clock itself kept running (GameTime::UseTime is not gated)
    expect(sky.currentTimeOfDay).not.toBeCloseTo(0.5, 3);
  });

  it('a diagnostic time freeze (the capture harness) does not reach a sealed cell either', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    sky.setFog(fog);
    sky.updateTimeOfDay(0.5);
    sky.noteLandscapeLoaded(); // entered from outdoors (a direct sealed login fogs with SetDefaultDeviceStates', verify-initial-sunlight.ts)
    sky.setSealedInterior(true);
    sky.freezeTimeOfDay(0.0);
    sky.update(1);
    expect(sky.isTimeOfDayFrozen).toBe(true);
    expect(sky.currentTimeOfDay).toBe(0);
    expect(sky.ambient.intensity).toBeCloseTo(DUNGEON_LIGHT_MINIMUM, 6);
    expect(sky.ambient.color.getHex()).toBe(0xffffff);
    expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
  });

  it('the fog freezes at the ENTRY tick: a midnight entry keeps the night fog through a noon clock', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    sky.setFog(fog);
    sky.updateTimeOfDay(0.0);
    sky.noteLandscapeLoaded(); // entered from outdoors (a direct sealed login fogs with SetDefaultDeviceStates', verify-initial-sunlight.ts)
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.5);
    expect(bytes(fog.color)).toEqual([0x17, 0x17, 0x28]);
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(400);
    // …but the ambient is still the constant, not the night sky's
    expect(sky.ambient.color.getHex()).toBe(0xffffff);
    expect(sky.ambient.intensity).toBeCloseTo(DUNGEON_LIGHT_MINIMUM, 6);
  });

  it('leaving re-lights from the running clock on the spot, sun back, object scale back', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    sky.setFog(fog);
    sky.updateTimeOfDay(0.5);
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.0); // the clock reached midnight underground
    sky.setSealedInterior(false);
    expect(sky.directionalLight.visible).toBe(true);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 6);
    expect(sky.ambient.intensity).toBeCloseTo(0.40, 6);
    expect(sky.ambient.color.g).toBeCloseTo(100 / 255, 6);
    expect(currentObjectAmbientScale()).toBeCloseTo(retailObjectAmbientScale(0.25, 0.40), 6);
    expect(bytes(fog.color)).toEqual([0x17, 0x17, 0x28]);
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(400);
  });

  it('setting sealed twice is idempotent and does not re-tick', () => {
    const sky = makeSky();
    const fog = new THREE.Fog(0x000000, 1, 2);
    sky.setFog(fog);
    sky.updateTimeOfDay(0.5);
    sky.noteLandscapeLoaded(); // entered from outdoors (a direct sealed login fogs with SetDefaultDeviceStates', verify-initial-sunlight.ts)
    sky.setSealedInterior(true);
    sky.updateTimeOfDay(0.0);
    sky.setSealedInterior(true);
    expect(bytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
    expect(sky.ambient.intensity).toBeCloseTo(DUNGEON_LIGHT_MINIMUM, 6);
  });
});
