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
import * as THREE from 'three';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const SK = readFileSync(resolve(REPO, 'packages/renderer/src/effects/SkyboxRenderer.ts'), 'utf8');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

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
  it('onCharacterOptionToggle handles option 0x05 via skybox.setForceDaylight(value)', () => {
    expect(MAIN).toMatch(/option === 0x05[\s\S]+?skybox\.setForceDaylight\(value\)/);
  });

  it('startup-apply syncs persisted alwaysDaylight', () => {
    expect(MAIN).toMatch(/skybox\.setForceDaylight\(gameUI\.optionsSettings\.alwaysDaylight === true\)/);
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
