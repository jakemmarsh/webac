/**
 * FAITHFUL.440 / CORE.9 — DisableMostWeatherEffects option actually
 * disables the weather sky objects.
 *
 *  In retail this is a CLIENT-rendered option: it drives
 *  LScape::weather_enabled (SmartBox::EnableWeather), which gates every
 *  properties&0x4 weather sky object (the Rainy day groups' rain domes)
 *  in GameSky::Draw / GameSky::MakeObject. ACE persists the bit but
 *  expects the client to act on it.
 *
 *  CORE.9 replaced the old hand-rolled WeatherEffect point cloud with
 *  the DAT weather sky objects; the gate lives on SkyboxRenderer
 *  (setWeatherEnabled — behavioral coverage in verify-weather-daygroups.ts).
 *  main.ts routes both halves through ui/LocalOptionEffects.ts
 *  (SWEEP1999.character), driven here for real:
 *    1. the live toggle (onCharacterOptionToggle → applyToggledOptionEffect)
 *       sends option 0x04 to setWeatherEnabled(!value);
 *    2. the startup / restore apply (applyLocalOptionEffects) sets it from
 *       the stored value, so the preference takes effect on launch.
 *  A 1999 world pins the option off (its client had no such option), so
 *  weather always shows there.
 *
 *  setWeatherEnabled is inverted because the option name is "disable"
 *  but the renderer flag is "enabled".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyLocalOptionEffects, applyToggledOptionEffect, type LocalOptionSinks } from '../packages/renderer/src/ui/LocalOptionEffects.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

function sinks(out: { weather?: boolean }): LocalOptionSinks {
  return {
    setWeatherEnabled: (v) => { out.weather = v; }, setFogEnabled: () => {}, setForceDaylight: () => {},
    setUseMouseTurning: () => {}, setRightClickMouseLook: () => {},
  };
}

describe('FAITHFUL.440 — live toggle', () => {
  for (const era of ['eor', 'classic-dereth']) {
    it(`${era}: option 0x04 sets skybox weather enabled = !value`, () => {
      const pins = eraClientRules(eraProfile(era)).optionPins;
      const out: { weather?: boolean } = {};
      expect(applyToggledOptionEffect(0x04, true, pins, sinks(out))).toBe(true);
      expect(out.weather).toBe(false);
      applyToggledOptionEffect(0x04, false, pins, sinks(out));
      expect(out.weather).toBe(true);
    });
  }

  it('1999: the option is pinned off, so weather stays on', () => {
    const out: { weather?: boolean } = {};
    applyToggledOptionEffect(0x04, true, eraClientRules(eraProfile('ac1999-retail')).optionPins, sinks(out));
    expect(out.weather).toBe(true);
  });

  it('an option without a local effect does nothing here', () => {
    const out: { weather?: boolean } = {};
    expect(applyToggledOptionEffect(0x0a, true, {}, sinks(out))).toBe(false);
    expect(out.weather).toBeUndefined();
  });
});

describe('FAITHFUL.440 — startup apply', () => {
  it('applies the stored disableWeather', () => {
    const out: { weather?: boolean } = {};
    applyLocalOptionEffects((k) => k === 'disableWeather', sinks(out));
    expect(out.weather).toBe(false);
    applyLocalOptionEffects(() => false, sinks(out));
    expect(out.weather).toBe(true);
  });

  it('startup apply runs AFTER gameUI construction', () => {
    const gameUiIdx = MAIN.indexOf('const gameUI = new GameUI(');
    const applyIdx = MAIN.indexOf('applyLocalOptionEffects((k) => gameUI.optionOn(k), localOptionSinks)');
    expect(gameUiIdx).toBeGreaterThan(0);
    expect(applyIdx).toBeGreaterThan(gameUiIdx);
  });
});

describe('FAITHFUL.440 citation', () => {
  it('main.ts cites FAITHFUL.440', () => {
    expect(MAIN).toMatch(/FAITHFUL\.440/);
  });
});
