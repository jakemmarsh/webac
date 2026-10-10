/**
 * CORE.18.b.a.a.a.a.a.b.a — the Gameplay Options page's "Use Mouse Turning
 * Settings" button (gmGameplayOptionsUI element 0x100005cc).
 *
 * gmGameplayOptionsUI::ListenToElementMessage @ 0049e110 answers the click
 * with UIElementManager::BroadcastGlobalMessage(0xc, 0). Two listeners hold
 * global message 0xc:
 *
 *  - gmConfigUI::ListenToGlobalMessage @ 0049eb90 → SetMouseTurningDefaults
 *    @ 0049e8f0 moves six Config-page options to their mouse-turning value,
 *    each only when it differs, printing one line per change through
 *    ClientSystem::AddTextToScroll(text, 7, true, 0): Camera Stiffness 0.95
 *    (___real_3f733333), Camera Adjustment Speed 50.0 (___real_42480000),
 *    Mouselook Sensitivity 0.7 (___real_3f333333), Align camera to slope OFF,
 *    Invert mouselook axes ON, Use Mouse Turning ON.
 *  - UIOption_ActionKeyMap::ListenToGlobalMessage @ 004889d0 →
 *    SetMouseTurningDefaults @ 004886f0: the Zoom Camera In row (action 0x33,
 *    map 5) SetBinding(0x80101 wheel up, activation 2, index 0) and the Zoom
 *    Camera Out row (0x34) SetBinding(0x80201 wheel down, index 0), with
 *    m_skipConfirmation set so no overwrite prompt opens; each prints its
 *    line unconditionally.
 *
 * The line texts are the .rdata format strings the sprintf calls read
 * (acclient.exe; `%f` is C's six-decimal float).
 */
import { ChatMessageType } from '@ac/shared';
import { ACT } from '../input/KeybindDefaults.js';
import type { KeybindRegistry } from '../input/KeybindRegistry.js';

/** Registry codes for the wheel's two DIMOFS_Z sub-controls (0x80101 / 0x80201). */
export const WHEEL_UP_CODE = 'MouseWheelUp';
export const WHEEL_DOWN_CODE = 'MouseWheelDown';

/** AddTextToScroll's text type for every line (ChatMessageType.Magic). */
export const MOUSE_TURNING_TEXT_TYPE = ChatMessageType.Magic;

/** The slider options, in SetMouseTurningDefaults order, with their retail names. */
const SLIDERS: ReadonlyArray<{ key: string; value: number; name: string }> = [
  { key: 'cameraStiffness', value: 0.95, name: 'Camera Stiffness' },
  { key: 'cameraAdjustmentSpeed', value: 50.0, name: 'Camera Adjustment' },
  { key: 'mouseLookSensitivity', value: 0.7, name: 'Mouse Sensitivity' },
];

/** The checkbox options, in order: the value they are moved to, and the line printed. */
const TOGGLES: ReadonlyArray<{ key: string; value: boolean; line: string }> = [
  { key: 'alignCameraToSlope', value: false,
    line: 'Align To Slope was changed from TRUE to the mouse turning default of FALSE.' },
  { key: 'invertMouseLookYAxis', value: true,
    line: 'Invert Mouselook Axes was changed from FALSE to the mouse turning default of TRUE.' },
  { key: 'useMouseTurning', value: true,
    line: 'Turn to Face Camera was changed from FALSE to the mouse turning default of TRUE.' },
];

export const MOUSE_TURNING_OPTION_VALUES: Readonly<Record<string, number | boolean>> = Object.freeze({
  ...Object.fromEntries(SLIDERS.map((s) => [s.key, s.value])),
  ...Object.fromEntries(TOGGLES.map((t) => [t.key, t.value])),
});

export const ZOOM_IN_WHEEL_LINE = 'The key for Camera Zoom In has been changed to the mouse wheel up.';
export const ZOOM_OUT_WHEEL_LINE = 'The key for Camera Zoom Out has been changed to the mouse wheel down.';

/** C printf `%f` of a float argument (promoted to double): six decimals. */
function printfFloat(v: number): string {
  return Math.fround(v).toFixed(6);
}

export interface MouseTurningResult {
  /** Option keys whose value changed (callers persist / apply these). */
  changedKeys: string[];
  /** True when the key map was rebound (callers persist it). */
  keymapChanged: boolean;
  /** The chat lines, in the order retail prints them. */
  lines: string[];
}

/**
 * Apply the mouse-turning defaults to `settings` (the options blob, mutated in
 * place) and `registry` (the live key map; null skips the key-map half, as a
 * client with no UIOption_ActionKeyMap rows would).
 */
export function applyMouseTurningDefaults(
  settings: Record<string, unknown>, registry: KeybindRegistry | null,
): MouseTurningResult {
  const changedKeys: string[] = [];
  const lines: string[] = [];
  for (const s of SLIDERS) {
    const cur = Number(settings[s.key]);
    // UIOption_Slider::GetCurrentValue is a float compared against the float constant.
    if (Math.fround(cur) === Math.fround(s.value)) continue;
    settings[s.key] = s.value;
    changedKeys.push(s.key);
    lines.push(`${s.name} was changed from ${printfFloat(cur)} to the mouse turning default of ${printfFloat(s.value)}.`);
  }
  for (const t of TOGGLES) {
    // The checkbox's vtable+0x2e0 reads a bool; only the opposite value is changed.
    if ((settings[t.key] === true) === t.value) continue;
    settings[t.key] = t.value;
    changedKeys.push(t.key);
    lines.push(t.line);
  }
  let keymapChanged = false;
  if (registry) {
    registry.setMapping(ACT.ZoomCameraIn, 0, WHEEL_UP_CODE);
    lines.push(ZOOM_IN_WHEEL_LINE);
    registry.setMapping(ACT.ZoomCameraOut, 0, WHEEL_DOWN_CODE);
    lines.push(ZOOM_OUT_WHEEL_LINE);
    keymapChanged = true;
  }
  return { changedKeys, keymapChanged, lines };
}

/**
 * The camera zoom each wheel sub-control fires: −1 Zoom Camera In, +1 Zoom
 * Camera Out, 0 neither (retail's default KeyMap leaves the wheel to input
 * map 0xa — UIElement_Scrollbar / UIElement_Scrollable — so it only scrolls
 * UI until the mouse-turning bindings are applied).
 */
export function wheelZoomDirections(registry: KeybindRegistry): { up: -1 | 0 | 1; down: -1 | 0 | 1 } {
  const dir = (code: string): -1 | 0 | 1 => {
    if (registry.getMappings(ACT.ZoomCameraIn).includes(code)) return -1;
    if (registry.getMappings(ACT.ZoomCameraOut).includes(code)) return 1;
    return 0;
  };
  return { up: dir(WHEEL_UP_CODE), down: dir(WHEEL_DOWN_CODE) };
}
