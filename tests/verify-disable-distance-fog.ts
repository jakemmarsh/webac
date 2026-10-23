/**
 * FAITHFUL.490 — DisableDistanceFog CharacterOption (0x30) wired
 *  client-side via SceneManager.setFogEnabled().
 *
 *  Per ACE `CharacterOption.cs:159-160` DisableDistanceFog = 0x30
 *  (CharacterOptions2.DisableDistanceFog). ACE persists the bit but
 *  does no server-side fog filtering — the visual effect is purely
 *  client-side.
 *
 *  Implementation:
 *  - SceneManager keeps a `savedFog: THREE.Fog | null` field
 *    (assigned in the constructor when fog is set up).
 *  - `setFogEnabled(enabled)`: when `false`, saves `scene.fog` and
 *    nulls it; when `true`, restores `scene.fog` from `savedFog`.
 *  - Live fog-color/range updates in main.ts (dungeon enter at
 *    line ~2659, surface enter at ~4040, etc.) all null-check
 *    `scene.fog`, so they harmlessly skip while disabled.
 *  - GameUI optionsSettings + OPTIONS_TO_CHARACTER_OPTION + Options
 *    panel row wired the same way as FAITHFUL.440/484.
 *  - main.ts's onCharacterOptionToggle calls setFogEnabled(!value)
 *    on option 0x30 (inverted: disable=true → enabled=false).
 *  - Startup-apply (FAITHFUL.438 pattern) syncs persisted bit.
 */
import { describe, it, expect } from 'vitest';
import { CHARACTER_SETTINGS_PAGE, characterSettingsRowForKey } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import { readFileSync } from 'node:fs';
import { applyLocalOptionEffects, applyToggledOptionEffect, type LocalOptionSinks } from '../packages/renderer/src/ui/LocalOptionEffects.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';

const REPO = resolve(__dirname, '..');
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

// CORE.18.b.a.a.a.a.a converted this block from source-text pins to
// behavior: it drives the real SceneManager.
describe('FAITHFUL.490 — SceneManager.setFogEnabled', () => {
  const make = () => new SceneManager({ fogColor: 0x8899aa, fogNear: 100, fogFar: 1500 });

  it('the constructor installs the distance fog', () => {
    const sm = make();
    const fog = sm.scene.fog as THREE.Fog;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect([fog.color.getHex(), fog.near, fog.far]).toEqual([0x8899aa, 100, 1500]);
  });

  it('setFogEnabled(false) nulls scene.fog; setFogEnabled(true) restores the same instance', () => {
    const sm = make();
    const fog = sm.scene.fog;
    sm.setFogEnabled(false);
    expect(sm.scene.fog).toBeNull();
    sm.setFogEnabled(false);
    expect(sm.scene.fog).toBeNull();
    sm.setFogEnabled(true);
    expect(sm.scene.fog).toBe(fog);
    sm.setFogEnabled(true);
    expect(sm.scene.fog).toBe(fog);
  });

  it('a live fog update made while enabled is what comes back after a disable / enable', () => {
    const sm = make();
    (sm.scene.fog as THREE.Fog).far = 400; // e.g. main.ts's dungeon-enter range update
    sm.setFogEnabled(false);
    sm.setFogEnabled(true);
    expect((sm.scene.fog as THREE.Fog).far).toBe(400);
  });

  it('an EnvironChange override draws no fog while distance fog is disabled (LScape::UseTime skips its fog branch)', () => {
    const sm = make();
    const fog = sm.scene.fog as THREE.Fog;
    const frame = { begin: 0, dirBright: 0.5, dirHeading: 90, dirPitch: 45, dirColor: 0xffffffff,
      ambBright: 0.3, ambColor: 0xffffffff, minWorldFog: 100, maxWorldFog: 1500,
      worldFogColor: 0xff8899aa, worldFog: 1, skyObjReplace: [] };
    const sky = new SkyboxRenderer({ tickSize: 0.8, lightTickSize: 15, dayGroups: [{ chanceOfOccur: 1,
      dayName: 'S', skyObjects: [], skyTime: [frame, { ...frame, begin: 0.5 }] }] } as never,
      { dayLength: 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);
    sky.setFog(fog);
    sm.setFogEnabled(false);
    sky.setFogEnabled(false);
    sky.setEnvironOverride({ fogColor: 0xff0000, fogMin: 1, fogMax: 50, ambientColor: 0xff0000, ambientLevel: 0.4 });
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(sm.scene.fog).toBeNull();
    expect(fog.far).toBe(1500); // the fog branch never ran
    sm.setFogEnabled(true);
    sky.setFogEnabled(true);
    expect(sm.scene.fog).toBe(fog);
  });
});

describe('FAITHFUL.490 — GameUI options wiring', () => {
  it('disableDistanceFog defaults to false', () => {
    const defaultsBlock = UI.match(/DEFAULTS: Record<[^>]+> = \{[\s\S]+?\};/)?.[0] ?? '';
    expect(defaultsBlock).toMatch(/disableDistanceFog:\s*false/);
  });

  it('OPTIONS_TO_CHARACTER_OPTION maps disableDistanceFog to 0x30', () => {
    const mapBlock = UI.match(/OPTIONS_TO_CHARACTER_OPTION:\s*Record<string, number>\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
    expect(mapBlock).toMatch(/disableDistanceFog:\s*0x30/);
  });

  // BUG.character-tab-not-retail — the Character tab renders
  // CHARACTER_SETTINGS_PAGE row by row (verify-core17hc pins the rendered
  // order), so the row lives in the page model under User Interface Display.
  it('the Character page has a Disable Distance Fog row under User Interface Display', () => {
    const section = CHARACTER_SETTINGS_PAGE.find((sec) => sec.rows.some((r) => r.ourKey === 'disableDistanceFog'));
    expect(section?.header.label).toBe('User Interface Display');
    expect(characterSettingsRowForKey('disableDistanceFog')?.label).toBe('Disable Distance Fog');
  });
});

describe('FAITHFUL.490 — main.ts live + startup wiring', () => {
  it('a live toggle of option 0x30 sets fog enabled = !value (1999 pins it off)', () => {
    for (const era of ['eor', 'classic-dereth']) {
      expect(toggledFor(era, 0x30, true).fogEnabled, era).toBe(false);
      expect(toggledFor(era, 0x30, false).fogEnabled, era).toBe(true);
    }
    expect(toggledFor('ac1999-retail', 0x30, true).fogEnabled).toBe(true);
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
describe('FAITHFUL.490 — main.ts startup wiring', () => {

  it('startup-apply syncs persisted disableDistanceFog (end of retail and Dark Majesty; 1999 pins it off)', () => {
    for (const era of ['eor', 'classic-dereth']) {
      expect(appliedFor(era, { disableDistanceFog: true }).fogEnabled, era).toBe(false);
      expect(appliedFor(era, {}).fogEnabled, era).toBe(true);
    }
    expect(appliedFor('ac1999-retail', { disableDistanceFog: true }).fogEnabled).toBe(true);
  });
});

describe('FAITHFUL.490 citations', () => {
  it('GameUI cites FAITHFUL.490', () => {
    expect(UI).toMatch(/FAITHFUL\.490/);
  });
  it('main.ts cites FAITHFUL.490', () => {
    expect(MAIN).toMatch(/FAITHFUL\.490/);
  });
});
