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
 *  the DAT weather sky objects; the gate now lives on SkyboxRenderer
 *  (setWeatherEnabled — behavioral coverage in
 *  verify-weather-daygroups.ts). This file pins the main.ts WIRING:
 *    1. onCharacterOptionToggle — live toggle on user click routes
 *       option 0x04 to skybox.setWeatherEnabled(!value).
 *    2. Startup apply (after GameUI construction) — mirrors the
 *       FAITHFUL.438 pattern so the persisted preference takes effect
 *       on launch instead of after first toggle.
 *
 *  setWeatherEnabled is inverted because the option name is "disable"
 *  but the renderer flag is "enabled".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.440 — live toggle wiring', () => {
  it('onCharacterOptionToggle routes option 0x04 to skybox.setWeatherEnabled', () => {
    const block = MAIN.match(/onCharacterOptionToggle:[\s\S]+?\n {4}\},/)?.[0] ?? '';
    expect(block).toMatch(/option === 0x04/);
    expect(block).toMatch(/skybox\.setWeatherEnabled\(!value\)/);
  });
});

describe('FAITHFUL.440 — startup apply', () => {
  it('applies disableWeather from gameUI.optionsSettings on startup', () => {
    expect(MAIN).toMatch(
      /skybox\.setWeatherEnabled\(gameUI\.optionsSettings\.disableWeather !== true\)/,
    );
  });

  it('startup apply runs AFTER gameUI construction', () => {
    const gameUiIdx = MAIN.indexOf('const gameUI = new GameUI(');
    const applyIdx = MAIN.indexOf(
      'skybox.setWeatherEnabled(gameUI.optionsSettings.disableWeather',
    );
    expect(gameUiIdx).toBeGreaterThan(0);
    expect(applyIdx).toBeGreaterThan(gameUiIdx);
  });
});

describe('FAITHFUL.440 citation', () => {
  it('main.ts cites FAITHFUL.440', () => {
    expect(MAIN).toMatch(/FAITHFUL\.440/);
  });
});
