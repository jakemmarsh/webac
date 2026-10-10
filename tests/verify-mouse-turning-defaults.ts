/**
 * CORE.18.b.a.a.a.a.a.b.a — the Gameplay page's "Use Mouse Turning Settings"
 * button: global message 0xc → gmConfigUI::SetMouseTurningDefaults @ 0049e8f0
 * (six Config options, a line per change) + UIOption_ActionKeyMap::
 * SetMouseTurningDefaults @ 004886f0 (wheel → Zoom Camera In / Out). Drives
 * the real model, KeybindRegistry and key-name formatter.
 */
import { RETAIL_DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.generated.js';
import { describe, it, expect } from 'vitest';
import { ChatMessageType } from '../packages/shared/src/index.js';
import {
  applyMouseTurningDefaults, wheelZoomDirections, MOUSE_TURNING_OPTION_VALUES, MOUSE_TURNING_TEXT_TYPE,
  WHEEL_UP_CODE, WHEEL_DOWN_CODE, ZOOM_IN_WHEEL_LINE, ZOOM_OUT_WHEEL_LINE,
} from '../packages/renderer/src/ui/MouseTurningDefaults.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.js';
import { retailKeyLabel } from '../packages/renderer/src/input/KeyNames.js';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';

/** The Config options at their retail install defaults (GameUI.OPTIONS_DEFAULTS). */
function freshSettings(): Record<string, unknown> {
  return { ...(GameUI.OPTIONS_DEFAULTS as Record<string, unknown>) };
}

describe('mouse-turning defaults — Config options (gmConfigUI::SetMouseTurningDefaults)', () => {
  it('moves the six options to their mouse-turning values from the install defaults, one line each in retail order', () => {
    const s = freshSettings();
    const r = applyMouseTurningDefaults(s, null);
    expect(s.cameraStiffness).toBe(0.95);
    expect(s.cameraAdjustmentSpeed).toBe(50);
    expect(s.mouseLookSensitivity).toBe(0.7);
    expect(s.alignCameraToSlope).toBe(false);
    expect(s.invertMouseLookYAxis).toBe(true);
    expect(s.useMouseTurning).toBe(true);
    expect(r.changedKeys).toEqual([
      'cameraStiffness', 'cameraAdjustmentSpeed', 'mouseLookSensitivity',
      'alignCameraToSlope', 'invertMouseLookYAxis', 'useMouseTurning',
    ]);
    expect(r.lines).toEqual([
      'Camera Stiffness was changed from 0.450000 to the mouse turning default of 0.950000.',
      'Camera Adjustment was changed from 40.000000 to the mouse turning default of 50.000000.',
      'Mouse Sensitivity was changed from 0.550000 to the mouse turning default of 0.700000.',
      'Align To Slope was changed from TRUE to the mouse turning default of FALSE.',
      'Invert Mouselook Axes was changed from FALSE to the mouse turning default of TRUE.',
      'Turn to Face Camera was changed from FALSE to the mouse turning default of TRUE.',
    ]);
    expect(r.keymapChanged).toBe(false);
  });

  it('prints nothing for an option already at its mouse-turning value (a second press is silent)', () => {
    const s = freshSettings();
    applyMouseTurningDefaults(s, null);
    const again = applyMouseTurningDefaults(s, null);
    expect(again.changedKeys).toEqual([]);
    expect(again.lines).toEqual([]);
    // A float equal to the constant as a float counts as unchanged.
    const s2 = { ...s, cameraStiffness: Math.fround(0.95), mouseLookSensitivity: 0.30000001 };
    const r2 = applyMouseTurningDefaults(s2, null);
    expect(r2.changedKeys).toEqual(['mouseLookSensitivity']);
    expect(r2.lines).toEqual(['Mouse Sensitivity was changed from 0.300000 to the mouse turning default of 0.700000.']);
  });

  it('exposes the values and prints as text type 7 (Magic)', () => {
    expect(MOUSE_TURNING_OPTION_VALUES).toMatchObject({
      cameraStiffness: 0.95, cameraAdjustmentSpeed: 50, mouseLookSensitivity: 0.7,
      alignCameraToSlope: false, invertMouseLookYAxis: true, useMouseTurning: true,
    });
    expect(MOUSE_TURNING_TEXT_TYPE).toBe(ChatMessageType.Magic);
    expect(MOUSE_TURNING_TEXT_TYPE).toBe(7);
  });
});

describe('mouse-turning defaults — key map (UIOption_ActionKeyMap::SetMouseTurningDefaults)', () => {
  it('the retail KeyMap leaves the wheel off the camera; ours adds it as a browser-UX default after the numpad keys', () => {
    expect(wheelZoomDirections(new KeybindRegistry(RETAIL_DEFAULT_KEYBINDS))).toEqual({ up: 0, down: 0 });
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(wheelZoomDirections(reg)).toEqual({ up: -1, down: 1 });
    // Retail's own bindings keep their slots; the wheel takes the next free one.
    expect(reg.getMappings(ACT.ZoomCameraIn).slice(0, 2)).toEqual(['NumpadSubtract', WHEEL_UP_CODE]);
    expect(reg.getMappings(ACT.ZoomCameraOut).slice(0, 2)).toEqual(['NumpadAdd', WHEEL_DOWN_CODE]);
  });

  it('binds wheel up → Zoom Camera In and wheel down → Zoom Camera Out in Mapping 1, printing both lines every press', () => {
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    const r = applyMouseTurningDefaults(freshSettings(), reg);
    expect(reg.getMappings(ACT.ZoomCameraIn)[0]).toBe(WHEEL_UP_CODE);
    expect(reg.getMappings(ACT.ZoomCameraOut)[0]).toBe(WHEEL_DOWN_CODE);
    expect(r.keymapChanged).toBe(true);
    expect(r.lines.slice(-2)).toEqual([ZOOM_IN_WHEEL_LINE, ZOOM_OUT_WHEEL_LINE]);
    expect(ZOOM_IN_WHEEL_LINE).toBe('The key for Camera Zoom In has been changed to the mouse wheel up.');
    expect(ZOOM_OUT_WHEEL_LINE).toBe('The key for Camera Zoom Out has been changed to the mouse wheel down.');
    expect(wheelZoomDirections(reg)).toEqual({ up: -1, down: 1 });
    // UIOption_ActionKeyMap lines are unconditional: a repeat press still prints them.
    const again = applyMouseTurningDefaults(freshSettings(), reg);
    expect(again.lines.slice(-2)).toEqual([ZOOM_IN_WHEEL_LINE, ZOOM_OUT_WHEEL_LINE]);
  });

  it('removing the wheel binding survives the key map save / load round trip; Defaults restores it', () => {
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    reg.setMapping(ACT.ZoomCameraIn, 1, null);
    reg.setMapping(ACT.ZoomCameraOut, 1, null);
    expect(wheelZoomDirections(reg)).toEqual({ up: 0, down: 0 });
    const loaded = new KeybindRegistry(DEFAULT_KEYBINDS);
    loaded.loadSerialized(reg.serialize());
    expect(wheelZoomDirections(loaded)).toEqual({ up: 0, down: 0 });
    loaded.resetToDefaults();
    expect(wheelZoomDirections(loaded)).toEqual({ up: -1, down: 1 });
  });

  it('the Keyboard dialog names the wheel sub-controls "<KEY> <SUBCONTROL>" (ID_KeyNameWithSubControl)', () => {
    expect(retailKeyLabel(WHEEL_UP_CODE)).toBe('Wheel Up');
    expect(retailKeyLabel(WHEEL_DOWN_CODE)).toBe('Wheel Down');
  });
});

describe('GameUI.applyMouseTurningSettings (the 0x100005cc button action)', () => {
  it('applies the options, round-trips Use Mouse Turning (0x31), commits the key map, updates the camera and prints the lines as type 7', async () => {
    const { loadDomWindow, installDomGlobals, restoreDomGlobals } = await import('./_harness/dom.js');
    const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;
    const saved: Record<string, unknown> = {};
    const domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    try {
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      const ui = new GameUI(container);
      const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
      ui.keybindRegistry = reg;
      let commits = 0;
      ui.onKeybindsCommitted = () => { commits++; };
      const toggles: Array<[number, boolean]> = [];
      ui.callbacks.onCharacterOptionToggle = (code: number, on: boolean) => { toggles.push([code, on]); };
      const cam = { lookSpeed: 0, mouseLookSensitivity: 0, invertMouseLookY: false, adjustmentSpeed: 0, alignToSlope: true,
        stiffness: 0, setStiffness(v: number) { this.stiffness = v; } };
      (ui as unknown as { uiHost: unknown }).uiHost = { cameraController: cam };
      const lines: Array<{ text: string; type: number }> = [];
      ui.addSystemMessage = (text: string, _c?: string, type?: number) => { lines.push({ text, type: type ?? -1 }); };

      ui.applyMouseTurningSettings();

      expect(ui.optionsSettings.useMouseTurning).toBe(true);
      expect(toggles).toContainEqual([0x31, true]);
      expect(commits).toBe(1);
      expect(reg.getMappings(ACT.ZoomCameraIn)[0]).toBe(WHEEL_UP_CODE);
      expect(cam.stiffness).toBe(0.95);
      expect(cam.adjustmentSpeed).toBe(50);
      expect(cam.mouseLookSensitivity).toBe(0.7);
      expect(cam.invertMouseLookY).toBe(true);
      expect(cam.alignToSlope).toBe(false);
      expect(lines).toHaveLength(8);
      expect(lines.every((l) => l.type === 7)).toBe(true);
      expect(lines[7].text).toBe(ZOOM_OUT_WHEEL_LINE);
    } finally {
      restoreDomGlobals(DOM_GLOBALS as never, saved);
    }
  });
});
