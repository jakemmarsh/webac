/**
 * GAP.58 — corpse loot: /consent on|off toggles the
 * AcceptCorpseLootingPermissions character option.
 *
 * The open/take/permit/consent-list send-paths were already real; the one
 * unwired bit was `/consent on|off`, which was punted to the Options panel.
 * It maps to CharacterOption.AcceptCorpseLootingPermissions (0x10): ACE
 * Player_Death.HandleActionAddPlayerPermission refuses a /permit unless the
 * TARGET has GetCharacterOption(AcceptCorpseLootingPermissions) set, so
 * /consent on|off gates whether others can permit you to loot their corpses.
 *
 * main.ts now sends SetSingleCharacterOption(0x10, on/off) AND calls
 * GameUI.setCharacterOptionLocal('acceptCorpseLooting', on/off) to keep the
 * Options-panel checkbox in sync. This drives the shipped GameUI toggle +
 * anchors the option code to ACE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GAP.58 — /consent on|off local toggle (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('acceptCorpseLooting maps to CharacterOption 0x10 in OPTIONS_TO_CHARACTER_OPTION', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    expect(mod.GameUI.OPTIONS_TO_CHARACTER_OPTION.acceptCorpseLooting).toBe(0x10);
  });

  it('setCharacterOptionLocal flips the acceptCorpseLooting option and reports change', () => {
    // default is false
    expect(!!ui.optionsSettings.acceptCorpseLooting).toBe(false);
    expect(ui.setCharacterOptionLocal('acceptCorpseLooting', true)).toBe(true);
    expect(ui.optionsSettings.acceptCorpseLooting).toBe(true);
    // idempotent — no change when already set
    expect(ui.setCharacterOptionLocal('acceptCorpseLooting', true)).toBe(false);
    // /consent off
    expect(ui.setCharacterOptionLocal('acceptCorpseLooting', false)).toBe(true);
    expect(ui.optionsSettings.acceptCorpseLooting).toBe(false);
  });

  it('unknown option key is a no-op', () => {
    expect(ui.setCharacterOptionLocal('notARealOption', true)).toBe(false);
  });
});

const ACE = 'reference/ACE/Source/ACE.Server';
const ENUM = 'reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs';
const hasAce = aceReferenceExists(ENUM);

describe.skipIf(!hasAce)('GAP.58 — the option code + permit gate are ACE-anchored', () => {
  it('CharacterOption.AcceptCorpseLootingPermissions === 0x10', () => {
    const src = fs.readFileSync(ENUM, 'utf8');
    expect(src).toMatch(/AcceptCorpseLootingPermissions\s*=\s*0x10/);
  });

  it('ACE gates /permit on the target having AcceptCorpseLootingPermissions', () => {
    const death = fs.readFileSync(`${ACE}/WorldObjects/Player_Death.cs`, 'utf8');
    expect(death).toMatch(/GetCharacterOption\(CharacterOption\.AcceptCorpseLootingPermissions\)/);
    expect(death).toMatch(/not accepting corpse looting permissions/);
  });
});
