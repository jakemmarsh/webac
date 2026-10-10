/**
 * ASSESS: EnvironChange (AdminEnvirons) — server-driven fog tint + ambient
 * atmosphere sounds. Enum values vs ACE EnvironChangeType.cs; fog colours /
 * ranges / radar-blank + the sound mapping vs the retail client's
 * Handle_Admin__Environs (transcribed in @ac/shared EnvironChange).
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  EnvironChangeType, ENVIRON_FOG, ENVIRON_SOUND, isEnvironFog, isEnvironSound, Sound,
} from '../packages/shared/src/index.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';

describe('EnvironChangeType classification', () => {
  it('isEnvironFog covers Clear..BlackFog2 only', () => {
    expect(isEnvironFog(EnvironChangeType.Clear)).toBe(true);
    expect(isEnvironFog(EnvironChangeType.BlackFog2)).toBe(true);
    expect(isEnvironFog(EnvironChangeType.RoarSound)).toBe(false);
    expect(isEnvironFog(EnvironChangeType.Thunder6Sound)).toBe(false);
  });
  it('isEnvironSound covers Roar..Thunder6 only', () => {
    expect(isEnvironSound(EnvironChangeType.RoarSound)).toBe(true);
    expect(isEnvironSound(EnvironChangeType.Thunder6Sound)).toBe(true);
    expect(isEnvironSound(EnvironChangeType.BlackFog2)).toBe(false);
    expect(isEnvironSound(EnvironChangeType.Clear)).toBe(false);
  });
});

describe('ENVIRON_FOG (retail Handle_Admin__Environs values)', () => {
  it('has a fog entry for every fog type except Clear', () => {
    expect(ENVIRON_FOG[EnvironChangeType.Clear]).toBeUndefined();
    for (const t of [EnvironChangeType.RedFog, EnvironChangeType.BlueFog, EnvironChangeType.WhiteFog,
      EnvironChangeType.GreenFog, EnvironChangeType.BlackFog, EnvironChangeType.BlackFog2]) {
      expect(ENVIRON_FOG[t]).toBeDefined();
    }
  });
  it('uses the exact retail colours, ranges, and ambient overrides', () => {
    expect(ENVIRON_FOG[EnvironChangeType.RedFog]).toEqual({ color: 0x960000, near: 0, far: 50, radarBlank: false, ambientColor: 0x960000, ambientLevel: 0.4 });
    expect(ENVIRON_FOG[EnvironChangeType.BlueFog]).toEqual({ color: 0x320096, near: 0, far: 50, radarBlank: false, ambientColor: 0x320096, ambientLevel: 0.3 });
    expect(ENVIRON_FOG[EnvironChangeType.WhiteFog]).toEqual({ color: 0x646464, near: 0, far: 30, radarBlank: false, ambientColor: 0x646464, ambientLevel: 0.4 });
    expect(ENVIRON_FOG[EnvironChangeType.GreenFog]).toEqual({ color: 0x1e6400, near: 0, far: 50, radarBlank: false, ambientColor: 0x1e6400, ambientLevel: 0.3 });
    expect(ENVIRON_FOG[EnvironChangeType.BlackFog]).toEqual({ color: 0x000000, near: 0, far: 40, radarBlank: false, ambientColor: 0x969696, ambientLevel: 0.8 });
  });
  it('only BlackFog2 blanks the radar', () => {
    expect(ENVIRON_FOG[EnvironChangeType.BlackFog2]).toEqual({ color: 0x000000, near: 0, far: 40, radarBlank: true, ambientColor: 0x969696, ambientLevel: 0.8 });
    expect(ENVIRON_FOG[EnvironChangeType.BlackFog]!.radarBlank).toBe(false);
  });
});

describe('ENVIRON_SOUND (retail sound mapping)', () => {
  it('maps the boundary + a sampling of sound types to the right UI sound', () => {
    expect(ENVIRON_SOUND[EnvironChangeType.RoarSound]).toBe(Sound.UI_Roar);
    expect(ENVIRON_SOUND[EnvironChangeType.BellSound]).toBe(Sound.UI_Bell);
    expect(ENVIRON_SOUND[EnvironChangeType.DrumsSound]).toBe(Sound.UI_Drums);
    expect(ENVIRON_SOUND[EnvironChangeType.LostSoulsSound]).toBe(Sound.UI_LostSouls);
    expect(ENVIRON_SOUND[EnvironChangeType.SquealSound]).toBe(Sound.UI_Squeal);
    expect(ENVIRON_SOUND[EnvironChangeType.Thunder1Sound]).toBe(Sound.UI_Thunder1);
    expect(ENVIRON_SOUND[EnvironChangeType.Thunder6Sound]).toBe(Sound.UI_Thunder6);
  });
  it('has no entry for the gap values 0x73/0x74 (unhandled in retail)', () => {
    expect(ENVIRON_SOUND[0x73 as EnvironChangeType]).toBeUndefined();
    expect(ENVIRON_SOUND[0x74 as EnvironChangeType]).toBeUndefined();
  });
});

describe('EnvironChange override lives in the sky ticks (DECOMP.environs-*), not a SceneManager fog swap', () => {
  const frame = { begin: 0, dirBright: 0.5, dirHeading: 90, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.3, ambColor: 0xffffffff, minWorldFog: 100, maxWorldFog: 1500,
    worldFogColor: 0xff808080, worldFog: 1, skyObjReplace: [] };
  const setup = () => {
    const sm = new SceneManager({ fogColor: 0x808080, fogNear: 100, fogFar: 1500 });
    const sky = new SkyboxRenderer({ tickSize: 0.8, lightTickSize: 15, dayGroups: [{ chanceOfOccur: 1,
      dayName: 'S', skyObjects: [], skyTime: [frame, { ...frame, begin: 0.5 }] }] } as never,
      { dayLength: 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);
    const fog = sm.scene.fog as THREE.Fog;
    sky.setFog(fog);
    sky.setSceneBackground(sm.scene.background as THREE.Color);
    return { sm, sky, fog };
  };
  const toOverride = (t: EnvironChangeType) => {
    const f = ENVIRON_FOG[t]!;
    return { fogColor: f.color, fogMin: f.near, fogMax: f.far, ambientColor: f.ambientColor, ambientLevel: f.ambientLevel };
  };

  it('SceneManager has no fog-swap override API any more', () => {
    const sm = new SceneManager({ fogColor: 0x808080 }) as unknown as Record<string, unknown>;
    expect(sm.applyEnvironFog).toBeUndefined();
    expect(sm.clearEnvironFog).toBeUndefined();
  });

  it('RedFog ends on the one fog object + backdrop at the retail colour / range; Clear restores the day fog', () => {
    const { sm, sky, fog } = setup();
    sky.setEnvironOverride(toOverride(EnvironChangeType.RedFog));
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(sm.scene.fog).toBe(fog);
    expect(fog.near).toBe(0);
    expect(fog.far).toBe(50);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('960000');
    expect((sm.scene.background as THREE.Color).getHexString(THREE.SRGBColorSpace)).toBe('960000');
    sky.setEnvironOverride(null);
    sky.update(0.8);
    expect(sm.scene.fog).toBe(fog);
    expect(fog.near).toBe(100);
    expect(fog.far).toBe(1500);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('808080');
  });

  it('a second override with no Clear between restarts the transition from the current fog', () => {
    const { sky, fog } = setup();
    sky.setEnvironOverride(toOverride(EnvironChangeType.RedFog));
    for (let i = 0; i < 40; i++) sky.update(0.8);
    sky.setEnvironOverride(toOverride(EnvironChangeType.BlackFog2));
    expect(sky.environOverrideTransition).toBe(0);
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(fog.far).toBe(40);
    expect(fog.color.getHexString(THREE.SRGBColorSpace)).toBe('000000');
  });
});

// ── ACE enum parity (skipped in CI where reference/ACE isn't cloned) ──
const ACE_ENUM = resolve(__dirname, '../reference/ACE/Source/ACE.Entity/Enum/EnvironChangeType.cs');
describe.skipIf(!aceReferenceExists(ACE_ENUM))('EnvironChangeType matches ACE EnvironChangeType.cs', () => {
  // Guard the read: a skipped describe's callback still runs at collection.
  const src = aceReferenceExists(ACE_ENUM) ? readFileSync(ACE_ENUM, 'utf8') : '';
  it('every ACE enum member has the same value here', () => {
    const re = /(\w+)\s*=\s*0x([0-9a-fA-F]+)/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const val = parseInt(m[2], 16);
      const ours = (EnvironChangeType as unknown as Record<string, number>)[name];
      expect(ours, `EnvironChangeType.${name}`).toBe(val);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(28); // 7 fog + 21 sound members
  });
});
