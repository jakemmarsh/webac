/**
 * SWEEP1006B.scene-audio.after-sky-rain-domes-storm
 *
 * GameSky::Draw @ 00506ff0 (decomp :253364-253391): `if (is_player_outside ||
 * param_1 == 0)` — the after-sky pass (param_1 = 1, the whole after_sky_cell:
 * every props&0x1 sky object, its parts and its script emitters) draws only
 * while the PLAYER's cell is outdoors, and only while LScape::weather_enabled
 * (LScape::draw @ 00506330 :252777). The before-sky pass (props&0x1 clear)
 * still draws from a SeenOutside interior. The after-sky objects stay alive:
 * only the draw is skipped, so their scripts keep running.
 *
 * Drives the shipped SkyboxRenderer with a Rainy-like group: an after-sky
 * rain dome GfxObj (0x1004c44, props 0x5), a before-sky cloud (props 0), an
 * after-sky storm Setup (0x2000ba6, props 0xd) and a before-sky Setup.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer, type SkySetupScriptEngine } from '../packages/renderer/src/effects/SkyboxRenderer.js';

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}
function skyObject(id: number, properties: number) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0, texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: id, defaultPESObjectId: 0, properties,
  };
}
function rainySky() {
  const sky = new SkyboxRenderer({
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Rainy',
      skyObjects: [
        skyObject(0x01004c44, 0x5), // after-sky rain dome (weather)
        skyObject(0x01004c36, 0x0), // before-sky cloud
        skyObject(0x01004c50, 0x1), // after-sky, not weather
        skyObject(0x02000ba6, 0xd), // after-sky storm Setup
        skyObject(0x02000714, 0x0), // before-sky Setup
      ],
      skyTime: [timeEntry(0), timeEntry(0.5)],
    }],
  } as never);
  sky.initSkyObjects({
    createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
      return g;
    },
  } as never);
  const events: string[] = [];
  const engine: SkySetupScriptEngine = {
    start: (a) => events.push(`start:${a.name}`),
    stop: (a) => events.push(`stop:${a.name}`),
  };
  sky.setSetupScriptEngine(engine);
  sky.updateTimeOfDay(0.3);
  const byName = (prefix: string) => sky.skyObjectsGroup!.children.find((c) => c.name.startsWith(prefix))!;
  return {
    sky, events,
    rainDome: byName('sky_obj_0_'),
    cloud: byName('sky_obj_1_'),
    afterPlain: byName('sky_obj_2_'),
    stormSetup: byName('sky_setup_3_'),
    beforeSetup: byName('sky_setup_4_'),
  };
}

describe('after-sky pass is skipped while the player is in an interior cell', () => {
  it('outdoors: both passes draw', () => {
    const s = rainySky();
    expect(s.sky.isPlayerOutside).toBe(true);
    for (const o of [s.rainDome, s.cloud, s.afterPlain, s.stormSetup, s.beforeSetup]) expect(o.visible).toBe(true);
  });

  it('inside a SeenOutside building: props&0x1 objects and after-world Setups hide at once; the before-sky pass stays', () => {
    const s = rainySky();
    s.sky.setPlayerOutside(false);
    expect(s.rainDome.visible).toBe(false);
    expect(s.afterPlain.visible).toBe(false);
    expect(s.stormSetup.visible).toBe(false);
    expect(s.cloud.visible).toBe(true);
    expect(s.beforeSetup.visible).toBe(true);
    // the time tick keeps them hidden
    s.sky.updateTimeOfDay(0.31);
    expect(s.rainDome.visible).toBe(false);
    expect(s.stormSetup.visible).toBe(false);
  });

  it('the after-sky scripts keep running indoors (only the draw is skipped)', () => {
    const s = rainySky();
    const before = s.events.slice();
    s.sky.setPlayerOutside(false);
    s.sky.updateTimeOfDay(0.32);
    expect(s.events).toEqual(before);
    expect(s.events.some((e) => e.startsWith('start:sky_setup_3_'))).toBe(true);
  });

  it('stepping back outside redraws the after-sky pass', () => {
    const s = rainySky();
    s.sky.setPlayerOutside(false);
    s.sky.setPlayerOutside(true);
    expect(s.rainDome.visible).toBe(true);
    expect(s.afterPlain.visible).toBe(true);
    expect(s.stormSetup.visible).toBe(true);
  });

  it('weather disabled: the whole after-sky pass is skipped, props&0x4 or not (LScape::draw gate)', () => {
    const s = rainySky();
    s.sky.setWeatherEnabled(false);
    expect(s.rainDome.visible).toBe(false);
    expect(s.afterPlain.visible).toBe(false);
    expect(s.cloud.visible).toBe(true);
    s.sky.setWeatherEnabled(true);
    expect(s.afterPlain.visible).toBe(true);
  });

  it('stepping back outside keeps the weather-disabled hide', () => {
    const s = rainySky();
    s.sky.setPlayerOutside(false);
    s.sky.setWeatherEnabled(false);
    s.sky.setPlayerOutside(true);
    expect(s.rainDome.visible).toBe(false); // weather still off
  });
});
