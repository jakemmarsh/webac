/**
 * CORE.17.k.b.b.a.g.f — the retail default key bindings, derived from the
 * portal KeyMap DAT rather than a hand-written table.
 *
 * Pure conversion (no DAT I/O): the two KeyMaps the retail client merges
 * (gmKeyboardUI::InitOptions @ 004dd8b0 — DBObj::GetByEnum(0x10000001, 10,
 * 0x1d) = "gmDefaultMap" 0x14000000, then CMasterInputMap::Merge with
 * GetByEnum(1, 10, 0x1d) = "DefaultMap" 0x14000002; CInputManager_WIN32::
 * AddKeyMap @ 006864c0 merges the same enums into the live master map) become
 * a KeybindRegistry defaults table: actionId → the canonical codes in file
 * order (the game map first, then the engine map), keyboard and mouse
 * devices (RECON.keyboard-dialog — DefaultMap's middle button for Toggle
 * Mouselook; the mouse X / Y axes stay out), plus
 * the ActionMap's action → input-map and input-map co-activity tables the
 * registry needs to resolve a key the way the retail CInputManager does.
 *
 * tools/gen-keybind-defaults.mjs bakes the result into
 * KeybindDefaults.generated.ts (CI has no DATs); the DAT-gated test re-runs
 * this conversion and compares.
 */
import type { KeyMap, ActionMap } from '@ac/dat-parser';
import { dikToCode, metaModeToPrefix } from './DirectInputKeys.js';
import { MOUSE_DEVICE, mouseControlToCode } from './MouseControls.js';

/** Device index 0 in both retail maps is GUID_SysKeyboard (device type 1). */
const KEYBOARD_DEVICE = 0;

export interface KeyMapDefaultsResult {
  /** actionId → canonical codes, DAT order, deduped. */
  defaults: Record<number, string[]>;
  /** actionId → the input map (ActionMap section) that owns it. */
  actionInputMap: Record<number, number>;
  /** inputMapId → the input maps that may be active at the same time (ActionMap InputMapConflicts). */
  coactive: Record<number, number[]>;
  /**
   * CORE.17.k.b.b.a.g.f.a — inputMapId → actionId → canonical codes for EVERY
   * (section, action) pair, the alternate-camera map 0x6 included: the dialog
   * row for (action, map) is CInputMap::FindKeysForAction(action) over that
   * map's own section (gmKeyboardUI::InitOptions @ 004dd8b0), so a map that is
   * never registered at runtime still shows its keys in the dialog.
   */
  sectionDefaults: Record<number, Record<number, string[]>>;
  /** Bindings skipped because the browser cannot deliver them (mouse axes, unknown device, unmapped DIK, mouse/Win metas). */
  skipped: Array<{ inputMapId: number; actionId: number; raw: number; metaMode: number; reason: string }>;
}

/** The canonical code for one keyboard or mouse binding, or null when the browser cannot deliver it. */
export function bindingToCode(b: { key: { device: number; control: number }; metaMode: number }): string | null {
  const device = b.key.device & 0xff;
  const base = device === KEYBOARD_DEVICE ? dikToCode(b.key.control)
    // The device word's high byte is the sub-control (the wheel's Up / Down).
    : device === MOUSE_DEVICE ? mouseControlToCode(b.key.control, (b.key.device >>> 8) & 0xff)
    : null;
  if (!base) return null;
  const prefix = metaModeToPrefix(b.metaMode);
  if (prefix === null) return null;
  return prefix + base;
}

/**
 * @param keyMaps   the maps in merge order (gmDefaultMap, then DefaultMap)
 * @param actionMap the portal ActionMap 0x26000000
 * @param namedIds  the action ids the registry knows (KEYBIND_ACTIONS); other
 *                  ids (the engine's unnamed edit / system / mouse actions)
 *                  are dropped from `defaults` but still counted in `skipped`
 *                  only when they fail for a browser reason.
 */
export function keyMapsToDefaults(keyMaps: KeyMap[], actionMap: ActionMap, namedIds: ReadonlySet<number>): KeyMapDefaultsResult {
  const actionInputMap: Record<number, number> = {};
  for (const [mapId, values] of actionMap.inputMaps) {
    for (const actionId of values.keys()) {
      if (actionInputMap[actionId] === undefined) actionInputMap[actionId] = mapId;
    }
  }

  const defaults: Record<number, string[]> = {};
  const sectionDefaults: Record<number, Record<number, string[]>> = {};
  const skipped: KeyMapDefaultsResult['skipped'] = [];
  for (const km of keyMaps) {
    for (const b of km.allBindings()) {
      if (!namedIds.has(b.actionId)) continue;
      const code = bindingToCode(b);
      if (!code) {
        const device = b.key.device & 0xff;
        const reason = device !== KEYBOARD_DEVICE && device !== MOUSE_DEVICE ? 'unknown device'
          : device === MOUSE_DEVICE ? (mouseControlToCode(b.key.control, (b.key.device >>> 8) & 0xff)
            ? 'undeliverable meta mode' : `mouse axis 0x${b.key.control.toString(16)}`)
          : !dikToCode(b.key.control) ? `unmapped DIK 0x${b.key.control.toString(16)}`
          : 'undeliverable meta mode';
        skipped.push({ inputMapId: b.inputMapId, actionId: b.actionId, raw: b.key.raw, metaMode: b.metaMode, reason });
        continue;
      }
      const section = sectionDefaults[b.inputMapId] ?? (sectionDefaults[b.inputMapId] = {});
      const sectionList = section[b.actionId] ?? (section[b.actionId] = []);
      if (!sectionList.includes(code)) sectionList.push(code);
      // A row in the retail dialog is (action, input map) — UIOption_ActionKeyMap
      // ::RefreshMappings @ 00488520 lists FindKeysForAction(action, m_idInputMap),
      // so a binding in a section other than the action's own map (the
      // alternate-camera map 6's arrow keys for Rotate Camera, never registered
      // at runtime) is not one of the command's mappings.
      if (actionInputMap[b.actionId] !== undefined && actionInputMap[b.actionId] !== b.inputMapId) continue;
      const list = defaults[b.actionId] ?? (defaults[b.actionId] = []);
      if (!list.includes(code)) list.push(code);
    }
  }

  const coactive: Record<number, number[]> = {};
  for (const [mapId, v] of actionMap.conflictingMaps) {
    coactive[mapId] = v.conflictingInputMaps.slice();
  }
  return { defaults, actionInputMap, coactive, sectionDefaults, skipped };
}
