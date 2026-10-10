/**
 * VISUAL.127 (supersedes FAITHFUL.497/499) — digit keys cast from the spell bar.
 *
 * The hardcoded digit + Shift+digit-punctuation switch arms were replaced by
 * the rebindable KeybindRegistry: digits 1-9 are the default bindings for the
 * combat-class "Spell Slot 1".."Spell Slot 9" commands, and the router maps
 * each to gameUI.castFromSpellBar(slot-1).
 *
 * CORE.17.k.b.b.a.g.f — per the retail KeyMap DAT (portal 0x14000000
 * gmDefaultMap) the digits are the Spell Slot commands only in MAGIC mode:
 * they live in input map 0x10000005, which ClientCombatSystem::
 * RegisterInputMaps @ 0056aa20 registers on entering magic mode and drops on
 * leaving it. In every other mode the same digits are the always-registered
 * Quickslot map's (0x1000000c, ClientUISystem::OnBeginCharacterSession @
 * 005645e0) "Quickslot 1-9". Spell Slot 10-12 exist in the ActionMap and ship
 * unbound (the DAT binds nine digits; the task's "retail binds 10-12" premise
 * was wrong).
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ActionClass } from '@ac/renderer/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS, activeInputMaps } from '@ac/renderer/input/KeybindDefaults.js';

const SLOTS = [
  ACT.SpellSlot1, ACT.SpellSlot2, ACT.SpellSlot3, ACT.SpellSlot4, ACT.SpellSlot5,
  ACT.SpellSlot6, ACT.SpellSlot7, ACT.SpellSlot8, ACT.SpellSlot9,
];
const QUICKSLOT_1 = 0x10000042;

describe('VISUAL.127 / CORE.17.k.b.b.a.g.f — digit keys are the Spell Slot bindings in magic mode', () => {
  it('Digit1..Digit9 are Mapping 1 of Spell Slot 1..9', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    for (let i = 0; i < 9; i++) expect(r.getMappings(SLOTS[i])[0]).toBe(`Digit${i + 1}`);
  });

  it('in magic mode Digit1..Digit9 resolve to Spell Slot 1..9', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setActiveInputMaps(activeInputMaps(CombatMode.Magic));
    for (let i = 0; i < 9; i++) expect(r.resolve(`Digit${i + 1}`)).toBe(SLOTS[i]);
  });

  it('out of magic mode the digits are the Quickslot commands (0x1000000c), not the spell bar', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile]) {
      const r = new KeybindRegistry(DEFAULT_KEYBINDS);
      r.setActiveInputMaps(activeInputMaps(mode));
      for (let i = 0; i < 9; i++) expect(r.resolve(`Digit${i + 1}`)).toBe(QUICKSLOT_1 + i);
    }
  });

  it('Spell Slot 10-12 exist and ship unbound', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    for (const id of [ACT.SpellSlot10, ACT.SpellSlot11, ACT.SpellSlot12]) {
      expect(r.action(id)?.cls).toBe(ActionClass.Combat);
      expect(r.getMappings(id)).toEqual([null, null, null]);
    }
  });

  it('the Spell Slot commands are combat-class commands with retail names', () => {
    const r = new KeybindRegistry();
    expect(r.action(ACT.SpellSlot1)?.cls).toBe(ActionClass.Combat);
    expect(r.action(ACT.SpellSlot1)?.name).toBe('Spell Slot 1');
    expect(r.action(ACT.SpellSlot9)?.name).toBe('Spell Slot 9');
  });

  it('the obsolete Shift+digit punctuation alias leaves Shift+Digit unbound', () => {
    // The redundant '!'/'@'/… alias is gone; Shift+Digit1 is now a distinct,
    // unbound combo the user could rebind (it no longer silently fires slot 0).
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setActiveInputMaps(activeInputMaps(CombatMode.Magic));
    expect(r.resolve('Shift+Digit1')).toBeNull();
  });
});
