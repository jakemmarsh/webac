/**
 * Which default key bindings an era's client ships (eraClientRules().keymap; SWEEP1999.input).
 * End of retail and the classic eras run the end-of-retail exe and its portal KeyMaps
 * (KeybindDefaults.DEFAULT_KEYBINDS); the 1999 client loads Default.map (KeyMap1999.ts).
 */
import { DEFAULT_KEYBINDS } from './KeybindDefaults.js';
import { KEYBIND_DEFAULTS_1999 } from './KeyMap1999.js';

export type EraKeymap = 'eor' | 'ac1999';

/** The built-in default bindings (actionId → up to 3 codes) for `keymap`. */
export function keybindDefaultsFor(keymap: EraKeymap): Record<number, string[]> {
  return keymap === 'ac1999' ? { ...KEYBIND_DEFAULTS_1999 } : DEFAULT_KEYBINDS;
}

/**
 * Where a player's own bindings are saved. A save holds every non-empty binding, so one era's save
 * would overwrite the other era's defaults: each keymap keeps its own. End of retail keeps the
 * v2 key it has always used.
 */
export function keybindStorageKey(keymap: EraKeymap): string {
  return keymap === 'ac1999' ? 'ac_keybinds_ac1999_v1' : 'ac_keybinds_v2';
}
