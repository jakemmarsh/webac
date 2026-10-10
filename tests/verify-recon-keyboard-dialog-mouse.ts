/**
 * RECON.keyboard-dialog — mouse controls are bindings like keys.
 *
 * Retail's MapInstructions text reads "The next key you press or mouse
 * button that you click will be mapped", and UIOption_ActionKeyMap::
 * KeyHitHandler @ 00489570 binds any mouse control but the X / Y axes and a
 * bare DIMOFS_BUTTON0 (left click). The DAT DefaultMap 0x14000002 binds
 * DIMOFS_BUTTON2 (middle) to Toggle Mouselook 0x3d. This drives the shipped
 * MouseControls helpers, the KeyNames labels, the registry defaults, and the
 * CameraController's live routing with real DOM events.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import {
  baseOfCode, browserButtonToDirectInput, isCapturableMouseCode, isMouseCode, mouseControlToCode,
  mouseEventToCode, swallowMouseRelease, wheelEventToCode,
} from '../packages/renderer/src/input/MouseControls.js';
import { retailKeyLabel } from '../packages/renderer/src/input/KeyNames.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.js';

describe('MouseControls — DIMOFS controls ↔ registry codes', () => {
  it('DIMOFS_BUTTON0-7 are MouseButton0-7; the wheel sub-controls are Up / Down; the axes have no code', () => {
    expect(mouseControlToCode(0x0c, 0)).toBe('MouseButton0');
    expect(mouseControlToCode(0x0e, 0)).toBe('MouseButton2');
    expect(mouseControlToCode(0x13, 0)).toBe('MouseButton7');
    expect(mouseControlToCode(0x08, 1)).toBe('MouseWheelUp');
    expect(mouseControlToCode(0x08, 2)).toBe('MouseWheelDown');
    expect(mouseControlToCode(0x08, 0)).toBeNull();
    expect(mouseControlToCode(0x00, 0)).toBeNull();
    expect(mouseControlToCode(0x04, 0)).toBeNull();
    expect(mouseControlToCode(0x14, 0)).toBeNull();
  });

  it('the browser numbers middle 1 / right 2; DirectInput right 1 / middle 2', () => {
    expect([0, 1, 2, 3, 4, 5].map(browserButtonToDirectInput)).toEqual([0, 2, 1, 3, 4, null]);
    expect(mouseEventToCode({ button: 1 })).toBe('MouseButton2');
    expect(mouseEventToCode({ button: 2, shiftKey: true, ctrlKey: true })).toBe('Ctrl+Shift+MouseButton1');
    expect(mouseEventToCode({ button: 0, metaKey: true, altKey: true })).toBe('Ctrl+Alt+MouseButton0');
    expect(mouseEventToCode({ button: 7 })).toBeNull();
    expect(wheelEventToCode({ deltaY: -3 })).toBe('MouseWheelUp');
    expect(wheelEventToCode({ deltaY: 100, altKey: true })).toBe('Alt+MouseWheelDown');
    expect(wheelEventToCode({ deltaY: 0 })).toBeNull();
  });

  it('KeyHitHandler @ 00489570: a bare left click never binds; a meta left click, the other buttons and the wheel do', () => {
    expect(isCapturableMouseCode('MouseButton0')).toBe(false);
    expect(isCapturableMouseCode('Ctrl+MouseButton0')).toBe(true);
    expect(isCapturableMouseCode('MouseButton1')).toBe(true);
    expect(isCapturableMouseCode('MouseButton4')).toBe(true);
    expect(isCapturableMouseCode('MouseWheelUp')).toBe(true);
    expect(isCapturableMouseCode('KeyW')).toBe(false);
    expect(isMouseCode('Shift+MouseWheelDown')).toBe(true);
    expect(baseOfCode('Ctrl+Alt+MouseButton3')).toBe('MouseButton3');
  });

  it('labels: DirectInput object names ("Button <n>", "Wheel Up"), metas as their left key', () => {
    expect(retailKeyLabel('MouseButton2')).toBe('Button 2');
    expect(retailKeyLabel('MouseButton1')).toBe('Button 1');
    expect(retailKeyLabel('Ctrl+MouseButton0')).toBe('Left Ctrl+Button 0');
    expect(retailKeyLabel('Shift+MouseWheelUp')).toBe('Shift+Wheel Up');
  });

  it('RECON.keyboard-dialog.a: every DIMOFS_BUTTON reads as Windows names the system mouse object ("Button 0" … "Button 7")', () => {
    // Windows en-US GUID_SysMouse tszName (Wine dlls/dinput/tests/device8.c,
    // asserted on real Windows): "Button 0" … "Button 4"; the 8-button
    // DIMOUSESTATE2 format continues the same template.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => retailKeyLabel(`MouseButton${n}`)))
      .toEqual(['Button 0', 'Button 1', 'Button 2', 'Button 3', 'Button 4', 'Button 5', 'Button 6', 'Button 7']);
    expect(retailKeyLabel('MouseButton8')).toBe('');
  });

  it('the shipped defaults bind Toggle Mouselook to the middle button, and the registry resolves it', () => {
    expect(DEFAULT_KEYBINDS[ACT.ToggleMouselook]).toEqual(['MouseButton2']);
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.resolve('MouseButton2')).toBe(ACT.ToggleMouselook);
    // a save that predates the mouse default (no 0x3d entry) keeps it
    r.loadSerialized(JSON.stringify({ [ACT.Jump]: ['Space', null, null] }));
    expect(r.getMappings(ACT.ToggleMouselook)).toEqual(['MouseButton2', null, null]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('swallowMouseRelease — a bound press never reaches the element under the pointer', () => {
  it('swallows the release, click and context menu until one task after the release', async () => {
    const doc = domWindow.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    const seen: string[] = [];
    for (const t of ['mouseup', 'click', 'contextmenu']) el.addEventListener(t, () => seen.push(t));
    swallowMouseRelease(doc);
    const fire = (t: string) => { const e = new domWindow.MouseEvent(t, { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
    expect(fire('contextmenu').defaultPrevented).toBe(true);
    fire('mouseup');
    fire('click');
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    fire('click');
    expect(seen).toEqual(['click']);
    el.remove();
  });
});

describe('CameraController — bound mouse controls over the world (real DOM events)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let c: CameraController;
  let canvas: HTMLElement;
  let root: HTMLElement;
  afterAll(() => restoreDomGlobals(GLOBALS, saved));
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) { if (!(key in saved)) saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    domWindow.document.body.innerHTML = '';
    // a fresh root per test: listeners bound by an earlier controller stay on their own root
    root = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(root);
    canvas = domWindow.document.createElement('canvas');
    root.appendChild(canvas);
    c = new CameraController(new THREE.PerspectiveCamera());
    c.bind(root);
  });
  const fire = (type: string, b: number, mods: Record<string, boolean> = {}) => {
    const e = new domWindow.MouseEvent(type, { button: b, bubbles: true, cancelable: true, ...mods });
    canvas.dispatchEvent(e);
    return e;
  };

  it('Shift + middle still mouse-looks (a meta press with no binding of its own is the bare control)', () => {
    fire('mousedown', 1, { shiftKey: true });
    expect(c.isMouseLookActive).toBe(true);
    fire('mouseup', 1);
    expect(c.isMouseLookActive).toBe(false);
  });

  it('Toggle Mouselook rebound to Button 3: the side button looks, the middle no longer does', () => {
    c.isMouseLookControl = (code) => baseOfCode(code) === 'MouseButton3';
    fire('mousedown', 1);
    expect(c.isMouseLookActive).toBe(false);
    fire('mouseup', 1);
    fire('mousedown', 3);
    expect(c.isMouseLookActive).toBe(true);
    fire('mouseup', 3);
    expect(c.isMouseLookActive).toBe(false);
  });

  it('a button bound to a command runs it on press and release; an unbound right click keeps its default', () => {
    const calls: Array<[string, boolean]> = [];
    c.mouseControlHandler = (code, down) => {
      if (code !== 'MouseButton4') return false;
      calls.push([code, down]);
      return true;
    };
    fire('mousedown', 4);
    fire('mouseup', 4);
    expect(calls).toEqual([['MouseButton4', true], ['MouseButton4', false]]);
    fire('mousedown', 2);
    fire('mouseup', 2);
    expect(calls.length).toBe(2);
  });

  it('a button bound to movement holds the movement key while depressed', () => {
    c.keyTranslator = (code) => (code === 'MouseButton3' ? 'KeyW' : code);
    fire('mousedown', 3);
    expect(c.isMoving).toBe(true);
    fire('mouseup', 3);
    expect(c.isMoving).toBe(false);
  });

  it('presses over HUD panels are the panel\'s: a bound command does not run', () => {
    let ran = 0;
    c.mouseControlHandler = () => { ran++; return true; };
    const panel = domWindow.document.createElement('div');
    root.appendChild(panel);
    panel.dispatchEvent(new domWindow.MouseEvent('mousedown', { button: 4, bubbles: true, cancelable: true }));
    expect(ran).toBe(0);
  });

  it('the wheel bound to a command (not to zoom) fires it once per notch: press then release', () => {
    c.wheelZoomBound = false;
    const calls: Array<[string, boolean]> = [];
    c.mouseControlHandler = (code, down) => { calls.push([code, down]); return code === 'MouseWheelUp'; };
    const wheel = (deltaY: number) => {
      const e = new domWindow.Event('wheel', { bubbles: true, cancelable: true }) as Event & { deltaY: number };
      Object.defineProperty(e, 'deltaY', { value: deltaY });
      canvas.dispatchEvent(e);
      return e;
    };
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(calls).toEqual([['MouseWheelUp', true], ['MouseWheelUp', false]]);
    // an unbound sub-control is left to scroll what is under it
    expect(wheel(100).defaultPrevented).toBe(false);
    expect(calls.slice(2)).toEqual([['MouseWheelDown', true]]);
  });
});
