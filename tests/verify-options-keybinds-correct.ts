/**
 * FAITHFUL.434 — Options-panel Key Bindings list reflects the actual bindings.
 *
 * Pre-fix the displayed bindings claimed "Spellbook M" + "Character C" — both
 * wrong for the client of the day. CORE.17.k.b.b.a.g.f made the block a live
 * read of the KeybindRegistry (KeyboardConfigModel.optionsKeyBindingRows), so
 * it shows the retail KeyMap DAT defaults (F12 inventory, ` combat, Q autorun,
 * X back, S stop …) and follows any rebinding — the hand-written list that
 * carried our invented I / B / M / P / O / Q / Tab keys is gone. Asserted
 * behaviourally against the shipped model (the former source-text pin on
 * GameUI.ts is converted here).
 */
import { describe, it, expect } from 'vitest';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';
import { optionsKeyBindingRows, OPTIONS_KEYBIND_ROWS } from '@ac/renderer/ui/KeyboardConfigModel.js';

describe('Options Key Bindings list (FAITHFUL.434 / CORE.17.k.b.b.a.g.f)', () => {
  const rows = Object.fromEntries(optionsKeyBindingRows(new KeybindRegistry(DEFAULT_KEYBINDS)));

  const expected: Array<[string, string]> = [
    ['Move Forward', 'W'], ['Move Backward', 'X'], ['Stop Moving', 'S'],
    ['Turn Left', 'A'], ['Turn Right', 'D'], ['Strafe Left', 'Z'], ['Strafe Right', 'C'],
    ['Jump', 'Space'], ['Autorun', 'Q'], ['Toggle Run/Walk', 'Shift'],
    ['Toggle Combat Mode', '`'], ['Cast Spell', 'End'],
    ['Examine Selected', 'E'], ['Use Selected', 'R'], ['Select Last Attacker', 'Home'],
    ['Inventory', 'F12'], ['Attributes', 'F8'], ['Skills', 'F9'], ['Spellbook', 'F5'],
    ['Allegiance', 'F3'], ['Fellowship', 'F4'], ['World / Map', 'F10'], ['Options', 'F11'], ['Help', 'F1'],
    ['Begin Chat', 'Enter'],
  ];

  it.each(expected)('lists [%s, %s]', (label, key) => {
    expect(rows[label]).toBe(key);
  });

  it('lists exactly the fixed command set, one row each', () => {
    expect(optionsKeyBindingRows(new KeybindRegistry(DEFAULT_KEYBINDS)).map(([l]) => l)).toEqual(OPTIONS_KEYBIND_ROWS.map((r) => r.label));
  });

  it('never claims "Spellbook M" or "Character C" (the FAITHFUL.434 defects) nor our former invented keys', () => {
    expect(rows['Spellbook']).not.toBe('M');
    expect(rows['Inventory']).not.toBe('I');
    expect(rows['Options']).not.toBe('O');
    expect(rows['Toggle Combat Mode']).not.toBe('Tab');
  });

  it('follows a rebinding — the block reads the live registry, not a table', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.ShowHideInventoryPanel, 0, 'KeyI');
    expect(Object.fromEntries(optionsKeyBindingRows(r))['Inventory']).toBe('I');
    r.clearMapping(ACT.ShowHideInventoryPanel, 0);
    expect(Object.fromEntries(optionsKeyBindingRows(r))['Inventory']).toBe('—');
  });
});
