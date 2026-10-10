/**
 * ASSESS: KeybindRegistry + key-code helpers (VISUAL.127).
 *
 * Drives the SHIPPED registry the live input router and Keyboard Config dialog
 * both use: default seeding, reverse resolution, retail conflict policy,
 * reset/snapshot/serialize, and the canonical event↔label helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  KeybindRegistry, eventToCode, codeToLabel,
} from '@ac/renderer/input/KeybindRegistry.js';
import { ActionClass } from '@ac/renderer/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } from '@ac/renderer/input/KeybindDefaults.js';

describe('eventToCode', () => {
  it('returns the bare code with no modifiers', () => {
    expect(eventToCode({ code: 'KeyW' })).toBe('KeyW');
  });
  it('prefixes modifiers in Ctrl+Alt+Shift order', () => {
    expect(eventToCode({ code: 'KeyA', shiftKey: true })).toBe('Shift+KeyA');
    expect(eventToCode({ code: 'Digit1', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+Digit1');
  });
  it('does not prefix a bare modifier key with itself', () => {
    expect(eventToCode({ code: 'ShiftLeft', shiftKey: true })).toBe('ShiftLeft');
  });
});

describe('codeToLabel', () => {
  it('maps letter/digit codes to friendly labels', () => {
    expect(codeToLabel('KeyW')).toBe('W');
    expect(codeToLabel('Digit1')).toBe('1');
  });
  it('maps named keys', () => {
    expect(codeToLabel('Backquote')).toBe('`');
    expect(codeToLabel('ArrowUp')).toBe('Up');
    expect(codeToLabel('Space')).toBe('Space');
    expect(codeToLabel('Escape')).toBe('Esc');
  });
  it('keeps modifier prefixes', () => {
    expect(codeToLabel('Shift+KeyA')).toBe('Shift+A');
  });
  it('returns empty string for null (unbound)', () => {
    expect(codeToLabel(null)).toBe('');
  });
});

describe('KeybindRegistry', () => {
  it('seeds Mapping 1/2/3 from defaults and resolves both', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.getMappings(ACT.MoveForward)).toEqual(['KeyW', 'ArrowUp', null]);
    expect(r.resolve('KeyW')).toBe(ACT.MoveForward);
    expect(r.resolve('ArrowUp')).toBe(ACT.MoveForward);
    expect(r.resolve('F12')).toBe(ACT.ShowHideInventoryPanel);
  });

  it('enforces retail one-key-one-command conflict policy', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    // Steal F12 (Inventory — the retail KeyMap default, CORE.17.k.b.b.a.g.f)
    // for Map — it must leave Inventory (both live in the UI map 0x10000009).
    r.setMapping(ACT.ShowHideMapPage, 2, 'F12');
    expect(r.resolve('F12')).toBe(ACT.ShowHideMapPage);
    expect(r.getMappings(ACT.ShowHideInventoryPanel).includes('F12')).toBe(false);
  });

  it('clears a mapping and forgets the reverse lookup', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.clearMapping(ACT.MoveForward, 0);
    expect(r.getMappings(ACT.MoveForward)).toEqual([null, 'ArrowUp', null]);
    expect(r.resolve('KeyW')).toBeNull();
  });

  it('resetToDefaults restores the built-in bindings', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.MoveForward, 0, 'KeyT');
    r.resetToDefaults();
    expect(r.getMappings(ACT.MoveForward)).toEqual(['KeyW', 'ArrowUp', null]);
  });

  it('snapshot + restore round-trips for Revert/Cancel', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const snap = r.snapshot();
    r.setMapping(ACT.ShowHideInventoryPanel, 0, 'KeyV');
    expect(r.resolve('KeyV')).toBe(ACT.ShowHideInventoryPanel);
    r.restore(snap);
    expect(r.resolve('KeyV')).toBeNull();
    expect(r.resolve('F12')).toBe(ACT.ShowHideInventoryPanel);
  });

  it('serialize → loadSerialized preserves custom bindings', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.ShowHideOptionsPanel, 1, 'F8');
    const json = r.serialize();
    const r2 = new KeybindRegistry(DEFAULT_KEYBINDS);
    r2.loadSerialized(json);
    expect(r2.getMappings(ACT.ShowHideOptionsPanel)).toEqual(['F11', 'F8', null]);
  });

  it('loadSerialized keeps the constructor default for an action absent from the save', () => {
    // Simulates a save written before ACT.MoveForward existed in DEFAULT_KEYBINDS —
    // it must inherit the shipped default, not get wiped to unbound.
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const saved = JSON.parse(r.serialize());
    delete saved[ACT.MoveForward];
    const r2 = new KeybindRegistry(DEFAULT_KEYBINDS);
    r2.loadSerialized(JSON.stringify(saved));
    expect(r2.getMappings(ACT.MoveForward)).toEqual(['KeyW', 'ArrowUp', null]);
    expect(r2.resolve('KeyW')).toBe(ACT.MoveForward);
  });

  it('exposes the full baked command list grouped by class', () => {
    const r = new KeybindRegistry();
    // Counts pin the generated ActionMap table (296 named commands).
    expect(r.actionsForClass(ActionClass.Movement).length).toBe(14);
    expect(r.actionsForClass(ActionClass.Camera).length).toBe(12);
    expect(r.actionsForClass(ActionClass.Combat).length).toBe(32);
    expect(r.actionsForClass(ActionClass.UI).length).toBe(103);
    expect(r.actionsForClass(ActionClass.CharacterSettings).length).toBe(48);
    expect(r.actionsForClass(ActionClass.Emotes).length).toBe(87);
    expect(r.actions().length).toBe(296);
  });

  it('movement translation maps (re)bound keys to the canonical movement code', () => {
    // Mirrors the CameraController.keyTranslator main.ts installs: a key that
    // resolves to a movement command becomes its canonical code; anything else
    // passes through unchanged so it still reaches the one-shot router.
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const translate = (code: string): string => {
      const id = r.resolve(code);
      if (id != null) { const c = MOVEMENT_CANONICAL[id]; if (c) return c; }
      return code;
    };
    expect(translate('KeyW')).toBe('KeyW');     // primary
    expect(translate('ArrowUp')).toBe('KeyW');  // arrow secondary → canonical
    expect(translate('F12')).toBe('F12');     // non-movement passthrough
    // Rebind Move Forward to T — pressing T now drives forward movement.
    r.setMapping(ACT.MoveForward, 0, 'KeyT');
    expect(translate('KeyT')).toBe('KeyW');
  });

  it('every ACT id + MOVEMENT_CANONICAL id is a real baked command', () => {
    const r = new KeybindRegistry();
    for (const id of Object.values(ACT)) {
      expect(r.action(id), `ACT id 0x${id.toString(16)} missing from ActionMap`).not.toBeNull();
    }
    for (const id of Object.keys(MOVEMENT_CANONICAL).map(Number)) {
      const a = r.action(id);
      expect(a, `movement id 0x${id.toString(16)} missing`).not.toBeNull();
      expect(a!.cls).toBe(ActionClass.Movement);
    }
  });
});
