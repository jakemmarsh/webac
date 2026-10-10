/**
 * FAITHFUL.495 — UseMouseTurning CharacterOption (0x31) enables
 *  free-look camera turning without right-click drag.
 *
 *  Per ACE `CharacterOption.cs:162-163` UseMouseTurning = 0x31 (
 *  CharacterOptions2.UseMouseTurning). Default OFF. With it on the
 *  right button holds mouse-look and mouse X turns the player
 *  (CORE.18.b.a.a.a.a.a.b — behavior in verify-use-mouse-turning-mode.ts).
 *
 *  Implementation:
 *  - CameraController static `useMouseTurning` flag + isMouseTurning
 *    Enabled() / setUseMouseTurning() accessors.
 *  - GameUI optionsSettings.useMouseTurning + OPTIONS_TO_CHARACTER_
 *    OPTION map (0x31) + "Use Mouse Turning" toggle row in Gameplay
 *    tab's Movement section.
 *  - main.ts onCharacterOptionToggle wires option=0x31 to
 *    CameraController.setUseMouseTurning(value).
 *  - Startup-apply (FAITHFUL.438 pattern) syncs the persisted bit.
 */
import { describe, it, expect } from 'vitest';
import { characterSettingsRowForKey } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const CC = readFileSync(resolve(REPO, 'packages/renderer/src/scene/CameraController.ts'), 'utf8');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.495 — CameraController static state', () => {
  it('declares static useMouseTurning flag', () => {
    expect(CC).toMatch(/private static useMouseTurning = false/);
  });

  it('exposes static accessors', () => {
    expect(CC).toMatch(/static isMouseTurningEnabled\(\): boolean/);
    expect(CC).toMatch(/static setUseMouseTurning\(enabled: boolean\): void/);
  });

  // The mousemove gate (mouse-look active OR Use Mouse Turning) is covered
  // behaviorally in tests/verify-retail-mouselook-defaults.ts (real DOM
  // events through CameraController.bind); the old source-text pin here
  // asserted the pre-2026-09-26 right-drag default, which retail never had.
});

describe('FAITHFUL.495 — GameUI wiring', () => {
  it('useMouseTurning defaults to false', () => {
    const defaultsBlock = UI.match(/DEFAULTS: Record<[^>]+> = \{[\s\S]+?\};/)?.[0] ?? '';
    expect(defaultsBlock).toMatch(/useMouseTurning:\s*false/);
  });

  it('OPTIONS_TO_CHARACTER_OPTION maps useMouseTurning to 0x31', () => {
    const mapBlock = UI.match(/OPTIONS_TO_CHARACTER_OPTION:\s*Record<string, number>\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
    expect(mapBlock).toMatch(/useMouseTurning:\s*0x31/);
  });

  // BUG.character-tab-not-retail — the row is the Config page's Input
  // section only (gmConfigUI::InitOptions, ID_Input_UseMouseTurning); the
  // Character page (CharacterSettingsModel) has none.
  it('Use Mouse Turning is not a Character-page row', () => {
    expect(characterSettingsRowForKey('useMouseTurning')).toBeUndefined();
  });
});

describe('FAITHFUL.495 — main.ts live + startup wiring', () => {
  it('onCharacterOptionToggle handles option 0x31', () => {
    expect(MAIN).toMatch(/option === 0x31[\s\S]+?CameraController\.setUseMouseTurning\(value\)/);
  });

  it('startup-apply syncs persisted useMouseTurning', () => {
    expect(MAIN).toMatch(/CameraController\.setUseMouseTurning\(gameUI\.optionsSettings\.useMouseTurning === true\)/);
  });
});

describe('FAITHFUL.495 citations', () => {
  it('CameraController cites FAITHFUL.495', () => {
    expect(CC).toMatch(/FAITHFUL\.495/);
  });
  it('GameUI cites FAITHFUL.495', () => {
    expect(UI).toMatch(/FAITHFUL\.495/);
  });
  it('main.ts cites FAITHFUL.495', () => {
    expect(MAIN).toMatch(/FAITHFUL\.495/);
  });
});
