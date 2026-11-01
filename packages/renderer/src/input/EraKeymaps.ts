/**
 * Which default key bindings an era's client ships (eraClientRules().keymap; SWEEP1999.input).
 * End of retail and the classic eras run the end-of-retail exe and its portal KeyMaps
 * (KeybindDefaults.DEFAULT_KEYBINDS); the 1999 client loads Default.map (KeyMap1999.ts).
 */
import { DEFAULT_KEYBINDS } from './KeybindDefaults.js';
import { KEYBIND_DEFAULTS_1999 } from './KeyMap1999.js';
import { KeybindRegistry } from './KeybindRegistry.js';

export type EraKeymap = 'eor' | 'ac1999';

/** The built-in default bindings (actionId → up to 3 codes) for `keymap`. */
export function keybindDefaultsFor(keymap: EraKeymap): Record<number, string[]> {
  return keymap === 'ac1999' ? { ...KEYBIND_DEFAULTS_1999 } : DEFAULT_KEYBINDS;
}

/**
 * Where a player's own bindings are saved. A save holds every bound or emptied command, so one era's save
 * would overwrite the other era's defaults: each keymap keeps its own. End of retail keeps the
 * v2 key it has always used.
 */
export function keybindStorageKey(keymap: EraKeymap): string {
  return keymap === 'ac1999' ? 'ac_keybinds_ac1999_v1' : 'ac_keybinds_v2';
}

/** The part of Storage the keymap save uses (localStorage in the page). */
export interface KeybindStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The login load (main.ts): the era's default bindings, then the player's save over them. A
 * storage that throws (disabled, private window) leaves the defaults.
 */
export function loadEraKeybinds(keymap: EraKeymap, store: KeybindStore | null): KeybindRegistry {
  const registry = new KeybindRegistry(keybindDefaultsFor(keymap));
  try {
    const saved = store?.getItem(keybindStorageKey(keymap));
    if (saved) registry.loadSerialized(saved);
  } catch { /* storage disabled — defaults stand */ }
  return registry;
}

/** The Keyboard Config's OK (and the mouse-turning defaults): write the bindings to the era's save. */
export function saveEraKeybinds(registry: KeybindRegistry, keymap: EraKeymap, store: KeybindStore | null): void {
  try { store?.setItem(keybindStorageKey(keymap), registry.serialize()); } catch { /* ignore */ }
}
