/**
 * Retail's default mouse-look and wheel (Jake 2026-09-26: "always match
 * retail's defaults"). Evidence, all EoL client + portal.dat:
 *  - KeyMap 0x14000002 DefaultMap, input map 5: mouse (device 1) control 0xe
 *    (MIDDLE button) → Toggle Mouselook 0x3d, "Toggles mouselook on/off while
 *    depressed". KeyMap 0x14000000 gmDefaultMap: F2 / Numpad-/ → Toggle
 *    Alternate Camera Mode 0x3e. No default binding mouse-looks on the right
 *    button.
 *  - CameraManager::OnAction @ 00455f40: 0x3e registers the alternate camera
 *    map 6 at priority 2000 while held, then (like 0x3d)
 *    CameraSet::ToggleMouseLook(m_fStart): on while held.
 *  - CameraSet::MouseLookHandler @ 00458d80: delta × sensitivity × 0.0667;
 *    "Invert mouselook axes" negates BOTH; an axis acts after >5 consecutive
 *    non-zero calls; X → the camera-key Rotate (3rd person: mouse right =
 *    Rotate Camera Right), Y > 0 → Lower.
 *  - The wheel's default binding is input map 0xa (UIElement_Scrollbar /
 *    Scrollable only): it never zooms the camera by default.
 * Drives the real CameraController / KeybindRegistry with real DOM events.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import * as THREE from 'three';
import { CombatMode } from '@ac/shared';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { CAMERA_ROTATE_RADIANS, MOUSE_LOOK_SCALE } from '../packages/renderer/src/scene/RetailCamera.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS, HELD_CAMERA_ACTIONS, INPUT_MAP, activeInputMaps } from '../packages/renderer/src/input/KeybindDefaults.js';

function controller(): CameraController {
  const c = new CameraController(new THREE.PerspectiveCamera());
  c.frameRate.push(1 / 60);
  let t = 100;
  c.clock = () => (t += 1 / 60);
  return c;
}

describe('mouse-look math = CameraSet::MouseLookHandler', () => {
  it('off by default: no mouse-look until the middle button / F2 turns it on', () => {
    expect(controller().isMouseLookActive).toBe(false);
  });
  it('3rd person: 5 dead-band calls, then mouse right = Rotate Camera Right by |dx| × 0.55 × 0.0667 steps', () => {
    const c = controller();
    c.setMouseLook(true);
    for (let i = 0; i < 5; i++) { c.simulateMouseMove(10, 0); c.update(1 / 60); }
    expect(c.cameraYawOffset).toBe(0);
    c.simulateMouseMove(10, 0); c.update(1 / 60);
    expect(c.cameraYawOffset).toBeCloseTo(-10 * 0.55 * MOUSE_LOOK_SCALE * CAMERA_ROTATE_RADIANS, 12);
    // An all-zero call is a no-op (@00458d80 returns before touching the
    // extents unless Use Mouse Turning is on): the next move keeps rotating.
    c.update(1 / 60);
    const held = c.cameraYawOffset;
    c.simulateMouseMove(10, 0); c.update(1 / 60);
    expect(c.cameraYawOffset).toBeLessThan(held);
    // A non-zero call with this axis at 0 DOES reset it: a new dead band.
    c.simulateMouseMove(0, 10); c.update(1 / 60);
    const afterReset = c.cameraYawOffset;
    c.simulateMouseMove(10, 0); c.update(1 / 60);
    expect(c.cameraYawOffset).toBe(afterReset);
  });
  it('a frame split into several physics substeps (under 10 fps) still mouse-looks', () => {
    const c = controller();
    c.setMouseLook(true);
    // Each frame: the deltas land on the first substep, the second sees zeros.
    for (let i = 0; i < 6; i++) { c.simulateMouseMove(10, 0); c.update(0.1); c.update(0.05); }
    expect(c.cameraYawOffset).toBeLessThan(0);
  });
  it('sensitivity scales the step; Invert mouselook axes negates BOTH axes', () => {
    const a = controller(); a.mouseLookSensitivity = 1.0; a.setMouseLook(true);
    for (let i = 0; i < 6; i++) { a.simulateMouseMove(10, 0); a.update(1 / 60); }
    expect(a.cameraYawOffset).toBeCloseTo(-10 * 1.0 * MOUSE_LOOK_SCALE * CAMERA_ROTATE_RADIANS, 12);
    const inv = controller(); inv.invertMouseLookY = true; inv.setMouseLook(true);
    const pitch0 = inv.pitch;
    for (let i = 0; i < 6; i++) { inv.simulateMouseMove(10, -20); inv.update(1 / 60); }
    expect(inv.cameraYawOffset).toBeGreaterThan(0); // X flipped: now Rotate Camera Left
    const plain = controller(); plain.setMouseLook(true);
    for (let i = 0; i < 6; i++) { plain.simulateMouseMove(10, 20); plain.update(1 / 60); }
    // Inverted (10, −20) behaves exactly like plain (−10, +20) on Y: same pitch change.
    expect(inv.pitch - pitch0).toBeCloseTo(plain.pitch - pitch0, 12);
  });
});

describe('mouse-look calls are non-held (Rotate / Raise / Lower param 0 → the last-tick time is cleared)', () => {
  it('a Rotate Camera key pressed long after mouse-look gets one normal 1 / fps tick, not the whole gap (found live 2026-09-26: 64.8 rad in one tick)', () => {
    let t = 100;
    const c = new CameraController(new THREE.PerspectiveCamera());
    for (let i = 0; i < 20; i++) c.frameRate.push(1 / 60); // a full FPS_WINDOW at 60 fps
    c.clock = () => t;
    c.setMouseLook(true);
    for (let i = 0; i < 8; i++) { t += 1 / 60; c.simulateMouseMove(10, 10); c.update(1 / 60); }
    c.setMouseLook(false);
    t += 30; // half a minute later
    const before = c.cameraYawOffset;
    c.startRotate('left'); c.stopRotate();
    // One key tick = (1 / fps) × m_rCameraAdjustmentSpeed × CAMERA_ROTATE_RADIANS.
    expect(c.cameraYawOffset - before).toBeCloseTo((1 / 60) * c.adjustmentSpeed * CAMERA_ROTATE_RADIANS, 9);
    const pitchBefore = c.pitch;
    c.startRaiseLower('raise'); c.stopRaiseLower();
    expect(Math.abs(c.pitch - pitchBefore)).toBeLessThan(1);
  });
});

describe('keybindings: F2 / Numpad-/ = Toggle Alternate Camera Mode; map 6 while held', () => {
  it('the retail KeyMap binds 0x3e to Numpad-/ and F2; it is a held action (no key-repeat restarts)', () => {
    expect(DEFAULT_KEYBINDS[ACT.ToggleAlternateCameraMode]).toEqual(['NumpadDivide', 'F2']);
    expect(HELD_CAMERA_ACTIONS.has(ACT.ToggleAlternateCameraMode)).toBe(true);
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setActiveInputMaps(activeInputMaps(CombatMode.NonCombat));
    expect(r.resolve('F2')).toBe(ACT.ToggleAlternateCameraMode);
  });
  it('held: map 6 ranks above every 1000 map (priority 2000), so the arrows rotate the camera instead of moving', () => {
    const maps = activeInputMaps(CombatMode.NonCombat, true);
    expect(maps.indexOf(INPUT_MAP.AltCamera)).toBeLessThan(maps.indexOf(INPUT_MAP.Movement));
    expect(maps.indexOf(INPUT_MAP.AltCamera)).toBeGreaterThan(maps.indexOf(INPUT_MAP.ChatToggle));
    expect(activeInputMaps(CombatMode.NonCombat)).not.toContain(INPUT_MAP.AltCamera);
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setActiveInputMaps(maps);
    expect(r.resolve('ArrowLeft')).toBe(ACT.RotateCameraLeft);
    expect(r.resolve('ArrowUp')).toBe(ACT.RotateCameraUp);
    r.setActiveInputMaps(activeInputMaps(CombatMode.NonCombat));
    expect(r.resolve('ArrowLeft')).not.toBe(ACT.RotateCameraLeft);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('DOM: the mouse buttons (real events through CameraController.bind)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let c: CameraController;
  afterAll(() => {
    restoreDomGlobals(GLOBALS, saved);
  });
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) { if (!(key in saved)) saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    domWindow.document.body.innerHTML = '';
    c = controller();
    c.bind(domWindow.document.body);
  });
  const body = () => domWindow.document.body as HTMLElement;
  const button = (type: 'mousedown' | 'mouseup', b: number) => {
    const e = new domWindow.MouseEvent(type, { button: b, bubbles: true, cancelable: true });
    body().dispatchEvent(e);
    return e.defaultPrevented as boolean;
  };
  const move = (dx: number, dy: number) => {
    const e = new domWindow.MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: dy });
    body().dispatchEvent(e);
  };
  const drag = (dx: number) => { for (let i = 0; i < 8; i++) { move(dx, 0); c.update(1 / 60); } };

  it('right-button drag does NOT mouse-look (no retail default binds it)', () => {
    button('mousedown', 2);
    drag(20);
    button('mouseup', 2);
    expect(c.isMouseLookActive).toBe(false);
    expect(c.cameraYawOffset).toBe(0);
  });
  it('holding the middle button mouse-looks; releasing stops it (Toggle Mouselook "while depressed")', () => {
    expect(button('mousedown', 1)).toBe(true); // no browser autoscroll
    expect(c.isMouseLookActive).toBe(true);
    drag(20);
    const turned = c.cameraYawOffset;
    expect(turned).toBeLessThan(0); // mouse right = Rotate Camera Right
    button('mouseup', 1);
    expect(c.isMouseLookActive).toBe(false);
    drag(20);
    expect(c.cameraYawOffset).toBe(turned);
  });
});
