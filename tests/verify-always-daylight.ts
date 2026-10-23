/**
 * FAITHFUL.492 — AlwaysDaylightOutdoors CharacterOption (0x05 /
 *  CharacterOptions2.PersistentAtDay) wired client-side.
 *
 *  Per ACE `CharacterOption.cs:30-31`. Retail's toggle (LScape::SetDay
 *  → set_landscape_lighting @ 005054d0) lights the landscape as at
 *  phase 0.5 regardless of the in-game clock, keeping outdoor lighting
 *  permanently bright. ACE persists the bit; the rendering is purely
 *  client-side.
 *
 *  Implementation:
 *  - SkyboxRenderer.setForceDaylight(forced) = LScape::SetDay: the light
 *    tick reads GetLighting(0.5); the clock, fog and sky keep the real
 *    time (DECOMP.always-daylight-scope).
 *  - GameUI optionsSettings + OPTIONS_TO_CHARACTER_OPTION (0x05).
 *  - "Always Daylight" toggle row in Display tab.
 *  - main.ts onCharacterOptionToggle calls setForceDaylight(value).
 *  - Startup-apply syncs persisted state.
 */
import { describe, it, expect } from 'vitest';
import { CHARACTER_SETTINGS_PAGE, characterSettingsRowForKey } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import { readFileSync } from 'node:fs';
import { applyLocalOptionEffects, applyToggledOptionEffect, type LocalOptionSinks } from '../packages/renderer/src/ui/LocalOptionEffects.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import * as THREE from 'three';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const SK = readFileSync(resolve(REPO, 'packages/renderer/src/effects/SkyboxRenderer.ts'), 'utf8');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

/** The startup / restore apply (main.ts → ui/LocalOptionEffects.ts) with GameUI.optionOn's rule: the era's pin, else the stored value. */
function appliedFor(eraId: string, stored: Record<string, boolean>): Record<string, boolean> {
  const pins = eraClientRules(eraProfile(eraId)).optionPins;
  const out: Record<string, boolean> = {};
  const sinks: LocalOptionSinks = {
    setWeatherEnabled: (v) => { out.weatherEnabled = v; }, setFogEnabled: (v) => { out.fogEnabled = v; },
    setForceDaylight: (v) => { out.forceDaylight = v; }, setUseMouseTurning: (v) => { out.useMouseTurning = v; },
    setRightClickMouseLook: (v) => { out.rightClickMouseLook = v; },
  };
  applyLocalOptionEffects((k) => (pins[k] !== undefined ? pins[k] : !!stored[k]), sinks);
  return out;
}

describe('FAITHFUL.492 / DECOMP.always-daylight-scope — SkyboxRenderer.setForceDaylight', () => {
  const NIGHT = { begin: 0, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xffdcdcdc,
    ambBright: 0.40, ambColor: 0xffc864ff, minWorldFog: 0, maxWorldFog: 400,
    worldFogColor: 0xff171728, worldFog: 1, skyObjReplace: [] };
  const NOON = { ...NIGHT, begin: 0.5, dirBright: 0.8, dirPitch: 90, ambBright: 0.35, maxWorldFog: 2400 };
  const newSky = () => new SkyboxRenderer({ tickSize: 0.8, lightTickSize: 15, dayGroups: [{ chanceOfOccur: 1,
    dayName: 'S', skyObjects: [], skyTime: [NIGHT, NOON, { ...NIGHT, begin: 0.999 }] }] } as never,
    { dayLength: 1000, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);

  it('defaults off', () => {
    expect(newSky().isForceDaylight).toBe(false);
  });

  it('pins the sun + ambient to phase 0.5 on the next frame (LScape::SetDay resets the tick timers)', () => {
    const sky = newSky();
    const fog = new THREE.Fog(0, 1, 2);
    sky.setFog(fog);
    sky.syncGameClock(0); // midnight
    sky.update(0.01);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.25, 3);
    sky.setForceDaylight(true);
    sky.update(0.01);
    expect(sky.directionalLight.intensity).toBeCloseTo(0.8, 3);
    expect(sky.ambient.intensity).toBeCloseTo(0.35, 3);
    // …but the clock and the fog keep the real (midnight) time
    expect(sky.currentTimeOfDay).toBeLessThan(0.01);
    expect(fog.far).toBeCloseTo(400, 0);
  });

  it('the clock keeps advancing while forced (retail never clamps present_time_of_day)', () => {
    const sky = newSky();
    sky.syncGameClock(0);
    sky.setForceDaylight(true);
    sky.update(250);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.25, 6);
  });
});

describe('FAITHFUL.492 — GameUI options wiring', () => {
  it('alwaysDaylight defaults to false', () => {
    const defaultsBlock = UI.match(/DEFAULTS: Record<[^>]+> = \{[\s\S]+?\};/)?.[0] ?? '';
    expect(defaultsBlock).toMatch(/alwaysDaylight:\s*false/);
  });

  it('OPTIONS_TO_CHARACTER_OPTION maps alwaysDaylight to 0x05', () => {
    const mapBlock = UI.match(/OPTIONS_TO_CHARACTER_OPTION:\s*Record<string, number>\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
    expect(mapBlock).toMatch(/alwaysDaylight:\s*0x05/);
  });

  // BUG.character-tab-not-retail — the Character tab renders
  // CHARACTER_SETTINGS_PAGE row by row (verify-core17hc pins the rendered
  // order), so the row lives in the page model under User Interface Display.
  it('the Character page has a Always Daylight Outdoors row under User Interface Display', () => {
    const section = CHARACTER_SETTINGS_PAGE.find((sec) => sec.rows.some((r) => r.ourKey === 'alwaysDaylight'));
    expect(section?.header.label).toBe('User Interface Display');
    expect(characterSettingsRowForKey('alwaysDaylight')?.label).toBe('Always Daylight Outdoors');
  });
});

describe('FAITHFUL.492 — main.ts live + startup wiring', () => {
  it('a live toggle of option 0x05 sets skybox daylight = value (1999 pins it off)', () => {
    for (const era of ['eor', 'classic-dereth']) {
      expect(toggledFor(era, 0x05, true).forceDaylight, era).toBe(true);
      expect(toggledFor(era, 0x05, false).forceDaylight, era).toBe(false);
    }
    expect(toggledFor('ac1999-retail', 0x05, true).forceDaylight).toBe(false);
  });
});

function toggledFor(eraId: string, option: number, value: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  applyToggledOptionEffect(option, value, eraClientRules(eraProfile(eraId)).optionPins, {
    setWeatherEnabled: (v) => { out.weatherEnabled = v; }, setFogEnabled: (v) => { out.fogEnabled = v; },
    setForceDaylight: (v) => { out.forceDaylight = v; }, setUseMouseTurning: (v) => { out.useMouseTurning = v; },
    setRightClickMouseLook: (v) => { out.rightClickMouseLook = v; },
  });
  return out;
}
describe('FAITHFUL.492 — main.ts startup wiring', () => {

  it('startup-apply syncs persisted alwaysDaylight (end of retail and Dark Majesty; 1999 pins it off)', () => {
    for (const era of ['eor', 'classic-dereth']) {
      expect(appliedFor(era, { alwaysDaylight: true }).forceDaylight, era).toBe(true);
      expect(appliedFor(era, {}).forceDaylight, era).toBe(false);
    }
    // SWEEP1999.character — the 1999 client had no Always Daylight: a stored value never carries over.
    expect(appliedFor('ac1999-retail', { alwaysDaylight: true }).forceDaylight).toBe(false);
  });
});

describe('FAITHFUL.492 citations', () => {
  it('SkyboxRenderer cites FAITHFUL.492', () => {
    expect(SK).toMatch(/FAITHFUL\.492/);
  });
  it('GameUI cites FAITHFUL.492', () => {
    expect(UI).toMatch(/FAITHFUL\.492/);
  });
  it('main.ts cites FAITHFUL.492', () => {
    expect(MAIN).toMatch(/FAITHFUL\.492/);
  });
});
