/**
 * FAITHFUL.372 — Options panel toggles round-trip server-side ACE
 *  CharacterOption flags via SetSingleCharacterOption.
 *
 * Pre-fix toggling Accept Corpse Looting / Show Helm / Show Cloak /
 * Auto Target / Show 3D Tooltips / Run As Default / Disable Weather /
 * Vivify Colors / Repeat Attacks in the Options panel only updated the
 * local optionsSettings dict. ACE persists these as CharacterOptions1/2
 * in the player DB (read on login per Player_Properties.cs), so the
 * setting must reach the server to survive a session restart.
 *
 * Mapping anchored at:
 *   reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs
 *
 * Closes the gap noted at main.ts:2994 in the /consent on/off help hint.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('GameUICallbacks has onCharacterOptionToggle (FAITHFUL.372)', () => {
  it('callback declared in GameUICallbacks interface', () => {
    expect(UI).toMatch(/onCharacterOptionToggle\?:\s*\(option: number, value: boolean\)\s*=>\s*void/);
  });
});

describe('OPTIONS_TO_CHARACTER_OPTION map covers server-side options', () => {
  // Codes pulled from ACE CharacterOption.cs.
  const REQUIRED_MAPPINGS: Array<[string, string]> = [
    ['showHelm', '0x2F'],            // ShowYourHelmOrHeadGear
    ['showCloak', '0x32'],           // ShowYourCloak
    ['acceptCorpseLooting', '0x10'], // AcceptCorpseLootingPermissions
    ['autoTarget', '0x0D'],          // AutoTarget
    ['showTooltips', '0x08'],        // Display3dTooltips
    ['runAsDefault', '0x0A'],        // RunAsDefaultMovement
    ['disableWeather', '0x04'],      // DisableMostWeatherEffects
    // FAITHFUL.441 — vivifyColors (VividTargetingIndicator 0x0E)
    // dropped: no client target reticle to brighten, so the round-
    // trip persisted server-state nobody could observe.
    ['repeatAttacks', '0x00'],       // AutoRepeatAttacks
  ];

  // Extract the map literal from the file.
  const mapBlock = UI.match(/OPTIONS_TO_CHARACTER_OPTION:\s*Record<string, number>\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';

  it.each(REQUIRED_MAPPINGS)('maps %s → %s', (key, hex) => {
    const line = new RegExp(`${key}:\\s*${hex}\\b`);
    expect(mapBlock).toMatch(line);
  });
});

describe('addToggleRow fires the callback for mapped keys', () => {
  const block = UI.match(/private addToggleRow[\s\S]+?container\.appendChild\(row\);\s*\}/)?.[0] ?? '';
  // Strip comments so prose mentions don't satisfy structural assertions.
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('looks up the optionCode via the static map', () => {
    expect(code).toMatch(/GameUI\.OPTIONS_TO_CHARACTER_OPTION\[key\]/);
  });

  it('invokes onCharacterOptionToggle when mapping exists', () => {
    expect(code).toMatch(/onCharacterOptionToggle\(optionCode,\s*!!this\.optionsSettings\[key\]\)/);
  });

  it('guards against undefined mapping (no fallback ship)', () => {
    expect(code).toMatch(/optionCode !== undefined/);
  });
});

describe('main.ts wires the callback to gameActions.setCharacterOption (sender behavioural in verify-game-actions.ts)', () => {
  it('onCharacterOptionToggle callback present in GameUI construction', () => {
    expect(MAIN).toMatch(/onCharacterOptionToggle:\s*\(option: number, value: boolean\)/);
  });

  it('forwards to gameActions.setCharacterOption(option, value)', () => {
    const block = MAIN.match(/onCharacterOptionToggle:[\s\S]+?\},/)?.[0] ?? '';
    expect(block).toMatch(/gameActions\.setCharacterOption\(option, value\)/);
  });

  it('cites FAITHFUL.372 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.372/);
  });
});
