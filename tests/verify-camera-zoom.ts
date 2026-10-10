/**
 * Mouse-wheel camera zoom + the in-head view (CORE.18.b / CORE.18.b.a: the
 * retail CameraSet Farther / Closer steps and SetInHead; CORE.18.b.a.a: the
 * step is one tick of 1 / SceneTool::m_FramesPerSecond at the camera
 * adjustment speed, and a held zoom key keeps ticking). Drives the real
 * CameraController.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';

/** A controller whose frame-rate meter has seen 20 frames at `fps`. */
function makeController(cfg?: ConstructorParameters<typeof CameraController>[1], fps = 60): CameraController {
  const c = new CameraController(new THREE.PerspectiveCamera(), cfg);
  for (let i = 0; i < 20; i++) c.frameRate.push(1 / fps);
  return c;
}

/** Run update() for a while (nothing in the offset eases any more; the view does, in RetailCameraRig). */
function settle(c: CameraController): void {
  for (let i = 0; i < 200; i++) c.update(1 / 60);
}

// CORE.18.b — the zoom is the retail rig: the boom starts at SetDefaultOffsets'
// (0, −2.5, 0.75) × 1.1. CORE.18.b.a.a — each notch is one CameraSet::Farther
// / Closer tick of 1 / fps: the offset scales by 1 ± (1/60) × 40 × 0.2 at 60 fps.
const HOME = Math.hypot(2.75, 0.825);
const IN = 1 - (1 / 60) * 40 * 0.2;   // ≈ 0.8667
const OUT = 1 + (1 / 60) * 40 * 0.2;  // ≈ 1.1333

describe('CameraController zoom', () => {
  let c: CameraController;
  beforeEach(() => { c = makeController(); });

  it('starts at the retail default boom, not first-person', () => {
    expect(c.cameraDistance).toBeCloseTo(HOME, 6);
    expect(c.isFirstPerson).toBe(false);
  });

  it('zooms out one Farther step per positive notch (wheel down)', () => {
    c.zoomBy(2); // +2 notches
    expect(c.cameraDistance).toBeCloseTo(HOME * OUT * OUT, 5);
    expect(c.isFirstPerson).toBe(false);
  });

  it('zooms in one Closer step per negative notch (wheel up)', () => {
    c.zoomBy(-2);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN * IN, 5);
  });

  it('the notch size follows the frame rate and the Camera Adjustment Speed', () => {
    const slow = makeController(undefined, 30);
    slow.zoomBy(-1);
    expect(slow.cameraDistance).toBeCloseTo(HOME * (1 - (1 / 30) * 8), 5);
    const quick = makeController();
    quick.adjustmentSpeed = 80;
    quick.zoomBy(1);
    expect(quick.cameraDistance).toBeCloseTo(HOME * (1 + (1 / 60) * 16), 5);
  });

  it('with no frame time yet the step is refused (1 / 0 overshoots every limit)', () => {
    const fresh = new CameraController(new THREE.PerspectiveCamera());
    fresh.zoomBy(-1);
    fresh.zoomBy(1);
    expect(fresh.cameraDistance).toBeCloseTo(HOME, 6);
  });

  it('a held Zoom In key ticks at once, then with the elapsed time every update until released', () => {
    c.startZoom(-1);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN, 5);
    c.update(0.05);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN * (1 - 0.05 * 40 * 0.2), 5);
    c.stopZoom();
    const d = c.cameraDistance;
    c.update(0.05);
    expect(c.cameraDistance).toBe(d);
  });

  it('refuses a step that puts the viewer more than CAMERA_FAR_LIMIT (10 m) behind', () => {
    c.zoomBy(1000);
    const back = c.thirdPersonBoom().back;
    expect(back).toBeLessThanOrEqual(10);
    expect(back * OUT).toBeGreaterThan(10); // the next step was the refused one
  });

  it('stops zooming in at CAMERA_MIN_CHAR_DIST (0.5 m) — the wheel never enters the head', () => {
    c.zoomBy(-1000);
    // 2.871 × 0.8667^12 = 0.515 m; the 13th step (0.446 m) is the refused one.
    expect(c.cameraDistance).toBeCloseTo(HOME * IN ** 12, 5);
    expect(c.cameraDistance).toBeGreaterThanOrEqual(0.5);
    expect(c.cameraDistance * IN).toBeLessThan(0.5);
    expect(c.isFirstPerson).toBe(false);
  });

  it('the First Person Camera action enters the head; Closer is inert there', () => {
    c.enterHead(); settle(c);
    expect(c.isFirstPerson).toBe(true);
    expect(c.cameraDistance).toBe(0);
    expect(c.viewPitch).toBe(0); // SetTargetDirection (0, 1, 0): level
    c.zoomBy(-3); settle(c);
    expect(c.isFirstPerson).toBe(true);
  });

  it('zooming out of the head restores retail Farther-from-head offset (0, −0.6, 0.5)', () => {
    c.enterHead(); settle(c);
    c.zoomBy(1); settle(c);
    expect(c.isFirstPerson).toBe(false);
    expect(c.cameraDistance).toBeCloseTo(Math.hypot(0.6, 0.5), 5);
    const boom = c.thirdPersonBoom();
    expect(boom.back).toBeCloseTo(0.6, 5);
    expect(boom.up).toBeCloseTo(0.5, 5);
    // 0.5 m above the pivot is inside SetTargetForOffset's [−0.5, 0.75] band: look level.
    expect(c.viewPitch).toBeCloseTo(0, 3);
  });

  it('Move camera to default leaves the head', () => {
    c.enterHead(); c.resetZoom(); settle(c);
    expect(c.isFirstPerson).toBe(false);
    expect(c.cameraDistance).toBeCloseTo(HOME, 5);
  });

  it('a step changes the offset at once (the visible ease is the viewer frame\'s stiffness, RetailCameraRig)', () => {
    c.zoomBy(-3);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN ** 3, 6);
    c.update(1 / 60);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN ** 3, 6);
  });

  it('resetZoom (Move camera to default) returns to the default boom straight behind', () => {
    c.zoomBy(3); c.simulateMouseMove(120, -40); settle(c);
    expect(c.cameraDistance).toBeGreaterThan(HOME);
    c.resetZoom(); settle(c);
    expect(c.cameraDistance).toBeCloseTo(HOME, 5);
    expect(c.cameraYawOffset).toBe(0);
    expect(c.thirdPersonBoom().up).toBeCloseTo(0.825, 5);
  });

  it('accumulated notches compound (multiple wheel events before settling)', () => {
    c.zoomBy(-1);
    c.zoomBy(-1);
    settle(c);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN * IN, 5);
  });
});

/**
 * CORE.1.b — wheel over HUD/screen UI must NOT zoom the camera (or
 * preventDefault, which killed native panel scrolling: the zoom listener is
 * bound to document.body, so every wheel over the inventory grid bubbled
 * into it). Retail only zooms when the pointer is over the 3D world.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('CameraController wheel — HUD guard (CORE.1.b)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let hudChild: HTMLElement;
  let c: CameraController;

  afterAll(() => {
    restoreDomGlobals(GLOBALS, saved);
  });

  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) {
      if (!(key in saved)) saved[key] = g[key];
      g[key] = key === 'window' ? domWindow : domWindow[key];
    }
    domWindow.document.body.innerHTML = '';
    const hud = domWindow.document.createElement('div');
    hud.id = 'game-hud';
    hudChild = domWindow.document.createElement('div');
    hud.appendChild(hudChild);
    domWindow.document.body.appendChild(hud);
    c = makeController();
    c.bind(domWindow.document.body);
  });

  // Each test's controller stays bound to the shared body; unbind its wheel
  // so it cannot answer the next test's events.
  afterEach(() => { c.wheelZoomBound = false; });

  function wheel(target: HTMLElement, deltaY: number): boolean {
    const e = new domWindow.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it('wheel over a #game-hud descendant neither zooms nor preventDefaults (panel keeps its scroll)', () => {
    const prevented = wheel(hudChild, 100);
    settle(c);
    expect(prevented).toBe(false);
    expect(c.cameraDistance).toBeCloseTo(HOME, 6);
  });

  it('retail default: the wheel over the world does NOT zoom (KeyMap binds it to the UI scroll map 0xa) and is left to the page', () => {
    const prevented = wheel(domWindow.document.body, 100);
    settle(c);
    expect(prevented).toBe(false);
    expect(c.cameraDistance).toBeCloseTo(HOME, 6);
  });

  it('once the mouse-turning bindings are applied (wheel → Zoom Camera In / Out), the wheel over the world zooms and preventDefaults', () => {
    c.wheelZoomBound = true;
    const prevented = wheel(domWindow.document.body, 100);
    settle(c);
    expect(prevented).toBe(true);
    expect(c.cameraDistance).toBeGreaterThan(HOME);
    // Still never over the HUD.
    const before = c.cameraDistance;
    expect(wheel(hudChild, 100)).toBe(false);
    expect(c.cameraDistance).toBeCloseTo(before, 9);
  });

  it('each wheel sub-control fires only the zoom it is bound to (up = Zoom In, down = Zoom Out)', () => {
    c.wheelZoom = { up: -1, down: 0 }; // only wheel up bound (to Zoom Camera In)
    expect(wheel(domWindow.document.body, 100)).toBe(false); // down: unbound, left to the page
    settle(c);
    expect(c.cameraDistance).toBeCloseTo(HOME, 6);
    expect(wheel(domWindow.document.body, -100)).toBe(true);
    settle(c);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN, 5);
    c.wheelZoom = { up: -1, down: 1 };
    expect(wheel(domWindow.document.body, 100)).toBe(true);
    settle(c);
    expect(c.cameraDistance).toBeCloseTo(HOME * IN * OUT, 5);
  });
});
