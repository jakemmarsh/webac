/**
 * Decomp-diff sweep 2026-09-30, scene group (docs/decomp-diff-sweep-2026-09-30.md):
 *
 *  S2 DECOMP.environs-ambient-additive — an EnvironChange override REPLACES
 *     the landscape ambient (LScape::UseTime @ 00505880 → set_landscape_lighting
 *     @ 005054d0), including the level fed to setRetailLightLevels; there is
 *     no second ambient light.
 *  S3 DECOMP.environs-fog-snap — the override blends in, m_override_transition
 *     +0.04 per tick for fog and ambient; Clear is instant.
 *  S4 DECOMP.always-daylight-scope — Always Daylight (LScape::SetDay) pins only
 *     the lighting to phase 0.5; clock, fog and sky keep the real time.
 *  S5 DECOMP.camera-far-plane — the world camera's far plane is Render::zfar 4000.
 *  S6 DECOMP.lighting-tick-cadence — fog every sky_info.tick_size, light every
 *     light_tick_size, sky objects per frame; SetDay resets both timers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import {
  SkyboxRenderer, ENVIRON_OVERRIDE_TRANSITION_STEP, type EnvironOverride,
} from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { SceneManager, RETAIL_ZFAR, RETAIL_ZNEAR } from '../packages/renderer/src/scene/SceneManager.js';
import { currentObjectAmbientScale, LSCAPE_LIGHT_MINIMUM } from '../packages/renderer/src/models/RetailLighting.js';
import { ENVIRON_FOG, EnvironChangeType } from '../packages/shared/src/index.js';

// Real Dereth "Sunny" midnight/noon keyframes (as in verify-core17e-retail-lighting).
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

/** EoL DAT cadence (RegionDesc 0x13000000 sky_info: tick 0.8 s, light 15 s). The
 *  default day is so long the phase holds still unless a test asks otherwise. */
function makeSky(opts: { tick?: number; light?: number; dayLength?: number; frames?: unknown[] } = {}) {
  const desc = {
    tickSize: opts.tick ?? 0.8, lightTickSize: opts.light ?? 15,
    dayGroups: [{ chanceOfOccur: 5, dayName: 'Sunny', skyObjects: [], skyTime: opts.frames ?? [NIGHT, NOON, NIGHT_END] }],
  } as never;
  const sky = new SkyboxRenderer(desc, { dayLength: opts.dayLength ?? 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);
  const fog = new THREE.Fog(0x000000, 1, 2);
  const bg = new THREE.Color(0, 0, 0);
  sky.setFog(fog);
  sky.setSceneBackground(bg);
  return { sky, fog, bg };
}

const RED = ENVIRON_FOG[EnvironChangeType.RedFog]!;
const RED_OVERRIDE: EnvironOverride = {
  fogColor: RED.color, fogMin: RED.near, fogMax: RED.far,
  ambientColor: RED.ambientColor, ambientLevel: RED.ambientLevel,
};

const rawBytes = (c: THREE.Color): [number, number, number] =>
  [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
const srgbBytes = (c: THREE.Color): [number, number, number] => {
  const s = c.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
};

describe('S6 DECOMP.lighting-tick-cadence — LScape::UseTime ticks', () => {
  it('the light is re-lit only every light_tick_size seconds, not every frame', () => {
    const { sky } = makeSky({ dayLength: 100 }); // fast day so the curve moves visibly
    sky.syncGameClock(0);
    sky.update(0.016); // first frame: both timers are 0 → fog + light tick
    const lit0 = sky.ambient.intensity;
    for (let i = 0; i < 60; i++) sky.update(0.1); // 6 s later: the clock moved, no light tick yet
    expect(sky.currentTimeOfDay).toBeGreaterThan(0.05);
    expect(sky.ambient.intensity).toBe(lit0);
    for (let i = 0; i < 110; i++) sky.update(0.1); // 17 s: past next_light_tick → a light tick
    expect(sky.ambient.intensity).not.toBe(lit0);
  });

  it('the fog updates every tick_size (0.8 s), in between it holds', () => {
    const { sky, fog } = makeSky({ dayLength: 100 });
    sky.syncGameClock(0);
    sky.update(0.016);
    const far0 = fog.far;
    sky.update(0.5); // 0.516 s: before the next fog tick
    expect(fog.far).toBe(far0);
    sky.update(0.4); // 0.916 s ≥ 0.816 → fog tick
    expect(fog.far).not.toBe(far0);
  });

  it('SetDay (setForceDaylight / resetTickTimers) re-arms both timers: the next frame re-lights', () => {
    const { sky } = makeSky({ dayLength: 100 });
    sky.syncGameClock(0);
    sky.update(0.016);
    const lit0 = sky.ambient.intensity;
    for (let i = 0; i < 30; i++) sky.update(0.1);
    expect(sky.ambient.intensity).toBe(lit0);
    sky.setForceDaylight(false); // LScape::SetDay(0) still resets the timers
    sky.update(0.016);
    expect(sky.ambient.intensity).not.toBe(lit0);
  });

  it('EoL DAT cadence is the one the sky reads', () => {
    // Pins the fixture to the DAT; the DAT-backed describe below checks the file.
    const { sky } = makeSky();
    expect((sky as unknown as { skyDesc: { tickSize: number; lightTickSize: number } }).skyDesc.tickSize).toBeCloseTo(0.8, 6);
  });
});

describe('S2 DECOMP.environs-ambient-additive — the override REPLACES the ambient', () => {
  it('at full transition the one ambient light is the override colour/level and the object scale uses it', () => {
    const { sky } = makeSky();
    sky.updateTimeOfDay(0.5);
    sky.setEnvironOverride(RED_OVERRIDE);
    // run the transition to completion (25 fog ticks)
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(sky.environOverrideTransition).toBeGreaterThanOrEqual(1);
    sky.resetTickTimers();
    sky.update(0.016); // a light tick at full transition
    expect(sky.ambient.intensity).toBeCloseTo(0.4, 6);
    expect(rawBytes(sky.ambient.color)).toEqual([0x96, 0x00, 0x00]);
    // SetWorldAmbientLight(level + 0.2·|sun|): the level is the override's 0.4, not day 0.35 (+0.4)
    const dir = sky.directionalLight.intensity;
    expect(currentObjectAmbientScale()).toBeCloseTo((0.4 + 0.2 * dir) / 0.4, 5);
  });

  it('SceneManager owns no ambient light at all (no second, additive ambient)', () => {
    const sm = new SceneManager({ fogColor: 0x808080 });
    expect(sm.scene.children.filter((c) => c instanceof THREE.AmbientLight)).toHaveLength(0);
  });

  it('Clear returns to the day ambient on the next light tick, with no blend back', () => {
    const { sky } = makeSky();
    sky.updateTimeOfDay(0.5);
    sky.setEnvironOverride(RED_OVERRIDE);
    for (let i = 0; i < 40; i++) sky.update(0.8);
    sky.setEnvironOverride(null);
    sky.resetTickTimers();
    sky.update(0.016);
    expect(sky.environOverrideState).toBeNull();
    expect(rawBytes(sky.ambient.color)).toEqual([0xe6, 0xe6, 0xff]);
  });
});

describe('S3 DECOMP.environs-fog-snap — the override blends in at +0.04 per tick', () => {
  it('the first tick after the override is still the day fog (transition 0), then it steps toward the override', () => {
    const { sky, fog } = makeSky();
    sky.freezeTimeOfDay(null);
    sky.updateTimeOfDay(0.5);
    sky.update(0.016); // arm the timers
    const dayFar = 2400;
    sky.setEnvironOverride(RED_OVERRIDE);
    expect(sky.environOverrideTransition).toBe(0);
    sky.update(0.8); // fog tick at transition 0 → still day fog
    expect(fog.far).toBeCloseTo(dayFar, 3);
    expect(sky.environOverrideTransition).toBeCloseTo(ENVIRON_OVERRIDE_TRANSITION_STEP, 6);
    sky.update(0.8); // transition 0.04
    expect(fog.far).toBeCloseTo(dayFar - (dayFar - 50) * ENVIRON_OVERRIDE_TRANSITION_STEP, 2);
    expect(fog.far).toBeGreaterThan(2000); // NOT snapped to 50
  });

  it('reaches the override fog exactly after the transition completes (~20 s of 0.8 s fog ticks)', () => {
    const { sky, fog, bg } = makeSky();
    sky.updateTimeOfDay(0.5);
    sky.update(0.016);
    sky.setEnvironOverride(RED_OVERRIDE);
    let seconds = 0;
    while (fog.far !== 50 && seconds < 60) { sky.update(0.8); seconds += 0.8; }
    expect(fog.far).toBe(50);
    expect(fog.near).toBe(0);
    expect(seconds).toBeGreaterThan(15);
    expect(seconds).toBeLessThan(25);
    expect(srgbBytes(fog.color)).toEqual([0x96, 0x00, 0x00]);
    expect(srgbBytes(bg)).toEqual([0x96, 0x00, 0x00]);
  });

  it('Clear is instant: the next fog tick is the day fog', () => {
    const { sky, fog } = makeSky();
    sky.updateTimeOfDay(0.5);
    sky.update(0.016);
    sky.setEnvironOverride(RED_OVERRIDE);
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(fog.far).toBe(50);
    sky.setEnvironOverride(null);
    sky.update(0.8);
    expect(fog.far).toBeCloseTo(2400, 0);
    expect(srgbBytes(fog.color)).toEqual([0xc3, 0xc8, 0xdc]);
  });

  it('with distance fog disabled (m_fFogEnabled off) the fog branch is skipped entirely', () => {
    const { sky, fog } = makeSky();
    sky.setFogEnabled(false);
    sky.setEnvironOverride(RED_OVERRIDE);
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(fog.far).toBe(2); // untouched
  });
});

describe('S4 DECOMP.always-daylight-scope — only the lighting is pinned to phase 0.5', () => {
  it('at midnight: the sun + ambient are noon, the fog and the clock stay midnight', () => {
    const { sky, fog } = makeSky();
    sky.syncGameClock(0); // phase 0 (zeroTimeOfYear 0): midnight
    sky.setForceDaylight(true);
    sky.update(0.016);
    expect(sky.currentTimeOfDay).toBeLessThan(0.01); // clock not clamped
    expect(sky.directionalLight.intensity).toBeCloseTo(0.8, 6); // noon sun
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 6); // noon ambient
    expect(fog.far).toBeCloseTo(400, 0); // midnight fog
    expect(srgbBytes(fog.color)).toEqual([0x17, 0x17, 0x28]);
  });

  it('the clock keeps advancing while forced', () => {
    const { sky } = makeSky({ dayLength: 100 });
    sky.syncGameClock(0);
    sky.setForceDaylight(true);
    for (let i = 0; i < 25; i++) sky.update(1);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.25, 6);
  });

  it('it replaces an environs override ambient too (set_landscape_lighting reads GetLighting(0.5))', () => {
    const { sky } = makeSky();
    sky.updateTimeOfDay(0.0);
    sky.setEnvironOverride(RED_OVERRIDE);
    for (let i = 0; i < 40; i++) sky.update(0.8);
    sky.setForceDaylight(true);
    sky.update(0.016);
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 6);
    expect(rawBytes(sky.ambient.color)).toEqual([0xe6, 0xe6, 0xff]);
  });

  it('turning it off re-lights from the real clock on the next frame', () => {
    const { sky } = makeSky();
    sky.syncGameClock(0);
    sky.setForceDaylight(true);
    sky.update(0.016);
    sky.setForceDaylight(false);
    sky.update(0.016);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 3);
    expect(sky.ambient.intensity).toBeCloseTo(Math.max(0.4, LSCAPE_LIGHT_MINIMUM), 3);
  });
});

describe('S5 DECOMP.camera-far-plane — Render::zfar 4000', () => {
  it('the world camera projects with znear 0.1 / zfar 4000', () => {
    const sm = new SceneManager();
    expect(RETAIL_ZFAR).toBe(4000);
    expect(RETAIL_ZNEAR).toBe(0.1);
    expect(sm.camera.far).toBe(4000);
    expect(sm.camera.near).toBe(0.1);
  });

  it('the largest EoL sky dome (~10087 m) still fits inside the far plane once scaled', () => {
    const { sky } = makeSky();
    const renderer = { createMesh: () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())); return g; } };
    const desc = {
      tickSize: 0.8, lightTickSize: 15,
      dayGroups: [{ chanceOfOccur: 5, dayName: 'Sunny', skyTime: [NIGHT, NOON, NIGHT_END], skyObjects: [{
        beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0, texVelocityX: 0.01, texVelocityY: 0,
        defaultGFXObjectId: 0x01004c42, defaultPESObjectId: 0, properties: 0,
      }] }],
    } as never;
    const s2 = new SkyboxRenderer(desc, null);
    s2.initSkyObjects(renderer as never);
    const mesh = s2.skyObjectsGroup!.children[0].children[0];
    expect(10087 * mesh.scale.x).toBeLessThan(RETAIL_ZFAR);
    // GameSky::Draw draws the sky at zfar × 4: our single frustum holds it at ¼ scale.
    expect(mesh.scale.x).toBeCloseTo(1 / 4, 6);
    expect(sky).toBeTruthy();
  });
});

const PORTAL = 'dat/client_portal.dat';
describe.skipIf(!fs.existsSync(PORTAL))('EoL portal.dat sky_info tick sizes', () => {
  let tick = 0;
  let light = 0;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const db = new DatDatabase(new Uint8Array(fs.readFileSync(PORTAL)).buffer);
    const r = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
    tick = r.skyInfo!.tickSize;
    light = r.skyInfo!.lightTickSize;
  });
  it('tick_size 0.8 s, light_tick_size 15 s', () => {
    expect(tick).toBeCloseTo(0.8, 6);
    expect(light).toBe(15);
  });
});
