/**
 * FAITHFUL.435 / CORE.17.k.b.b.a.g.f — the default keys are retail's KeyMap
 * (portal 0x14000000 gmDefaultMap): the panels on F3-F12, ` alone for
 * combat, Q autorun, X back, S stop, End / Del / PgDn / Ins / PgUp for the
 * spell bar in magic mode. (This file used to also pin our invented /help
 * keybind block; @help now prints retail's own help texts, RetailHelpTexts.ts,
 * covered in verify-retail-commands-text-ui-help.ts.)
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS, activeInputMaps } from '@ac/renderer/input/KeybindDefaults.js';

describe('retail default keys (FAITHFUL.435 / CORE.17.k.b.b.a.g.f)', () => {
  const r = new KeybindRegistry(DEFAULT_KEYBINDS);

  it('the retail panel keys resolve in the registry', () => {
    expect(r.resolve('F12')).toBe(ACT.ShowHideInventoryPanel);
    expect(r.resolve('F8')).toBe(ACT.ShowHideAttributesPage);
    expect(r.resolve('F9')).toBe(ACT.ShowHideSkillsPage);
    expect(r.resolve('F5')).toBe(ACT.ShowHideSpellbookPage);
    expect(r.resolve('F6')).toBe(ACT.ShowHideSpellComponentsPage);
    expect(r.resolve('F3')).toBe(ACT.ShowHideAllegiancePage);
    expect(r.resolve('F4')).toBe(ACT.ShowHideFellowshipPage);
    expect(r.resolve('F10')).toBe(ACT.ShowHideWorldPanel);
    expect(r.resolve('F11')).toBe(ACT.ShowHideOptionsPanel);
    expect(r.resolve('F1')).toBe(ACT.OpenHelp);
  });

  it('combat-mode toggle is backtick alone (Tab is the chat toggle in retail)', () => {
    expect(r.resolve('Backquote')).toBe(ACT.ToggleCombatMode);
    expect(r.resolve('Tab')).toBe(ACT.EnterExitChatMode);
  });

  it('Home → last attacker', () => {
    expect(r.resolve('Home')).toBe(ACT.SelectLastAttacker);
  });

  it('PgUp is free out of combat (chat scrollback)', () => {
    expect(r.resolve('PageUp')).toBeNull();
  });

  it('in magic mode the digits are the spell bar and End / Del / PgDn / Ins / PgUp are the spell keys', () => {
    r.setActiveInputMaps(activeInputMaps(CombatMode.Magic));
    expect(r.resolve('Digit1')).toBe(ACT.SpellSlot1);
    expect(r.resolve('End')).toBe(ACT.CastSpell);
    expect(r.resolve('Delete')).toBe(ACT.PreviousSpell);
    expect(r.resolve('PageDown')).toBe(ACT.NextSpell);
    expect(r.resolve('Insert')).toBe(ACT.PreviousSpellTab);
    expect(r.resolve('PageUp')).toBe(ACT.NextSpellTab);
    r.setActiveInputMaps(activeInputMaps(CombatMode.NonCombat));
  });

  it('the retail movement keys: X back, Q autorun, S stop', () => {
    expect(r.resolve('KeyX')).toBe(ACT.MoveBackward);
    expect(r.resolve('KeyS')).toBe(ACT.StopMoving);
    expect(r.resolve('KeyQ')).toBe(ACT.Autorun);
  });
});
