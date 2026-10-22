/**
 * COMPAT.wheel-deltamode — one physical wheel click is one notch in every
 * browser: one camera Farther / Closer step, one list step, one press of a
 * wheel-bound command (CInputManager_WIN32::GenerateMouseWheelEvent: one
 * press + release per WHEEL_DELTA). A touchpad stays smooth.
 *
 * Event shapes replayed against the real modules:
 *  - Firefox (Windows / Linux / macOS mouse): DOM_DELTA_LINE, ±3 lines per
 *    click, but only when deltaMode is read before deltaY; read a delta first
 *    and Firefox converts it to pixels at the line height (bug 1392460).
 *  - Chrome / Edge on Windows: DOM_DELTA_PIXEL, ±100 per click (150 reported
 *    at 150 % scaling by some builds), wheelDeltaY ∓120.
 *  - Chrome on Linux: ±53 px per click, wheelDeltaY ∓120.
 *  - Safari / Chrome on a macOS mouse: small accelerated pixel deltas,
 *    wheelDeltaY a multiple of ∓120.
 *  - A macOS touchpad: small pixel deltas, wheelDeltaY = −3 × deltaY.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as THREE from 'three';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import { wheelScrollPixels, wheelNotches, resetWheelLearning, WheelNotchCounter, type WheelLike } from '../packages/renderer/src/ui/wheelScroll.js';
import { wheelEventToCode } from '../packages/renderer/src/input/MouseControls.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';

/** Firefox's line-height conversion when a delta is read before deltaMode (16 px font → ≈19 px line). */
const FF_LINE_PX = 19;

/** Firefox's access-order getters on `target`: `lines` per event, as lines if deltaMode is read first, else pixels. */
function firefoxWheel<T extends object>(target: T, lines: number): T {
  let modeReadFirst: boolean | null = null;
  Object.defineProperty(target, 'deltaMode', {
    configurable: true,
    get() { if (modeReadFirst === null) modeReadFirst = true; return modeReadFirst ? 1 : 0; },
  });
  const delta = (v: number) => () => {
    if (modeReadFirst === null) modeReadFirst = false;
    return modeReadFirst ? v : v * FF_LINE_PX;
  };
  Object.defineProperty(target, 'deltaY', { configurable: true, get: delta(lines) });
  Object.defineProperty(target, 'deltaX', { configurable: true, get: delta(0) });
  return target;
}
const ff = (lines: number) => firefoxWheel({} as WheelLike, lines);
/** A pixel-mode mouse click (Chrome / Edge / Safari): `px` per click, wheelDeltaY ∓120 per click. */
const pixelClick = (px: number, clicks = 1): WheelLike => ({ deltaX: 0, deltaY: px * clicks, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: -120 * clicks });
const chromeWin = (clicks = 1) => pixelClick(100, clicks);
const chromeScaled = () => pixelClick(150);
const chromeLinux = () => pixelClick(53);
const macMouse = (px: number, wheelDelta = -120) => ({ deltaX: 0, deltaY: px, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: wheelDelta });
const touchpad = (px: number): WheelLike => ({ deltaX: 0, deltaY: px, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: -3 * px });

beforeEach(() => resetWheelLearning());

describe('one click is one notch in every browser', () => {
  it('camera notches: Firefox 3 lines, Chrome 100 / 150 / 53 px, a macOS mouse click — each exactly 1', () => {
    for (const [name, e] of [
      ['firefox', ff(3)], ['chrome-win', chromeWin()], ['chrome-150%', chromeScaled()],
      ['chrome-linux', chromeLinux()], ['mac-mouse', macMouse(4)], ['mac-mouse-accel', macMouse(12.5)],
    ] as const) {
      expect(wheelNotches(e), name).toBe(1);
    }
    expect(wheelNotches(ff(-3))).toBe(-1);
    expect(wheelNotches(pixelClick(-100))).toBe(-1);
  });

  it('coalesced clicks count each click (Firefox 6 lines, Chrome two clicks in one event)', () => {
    expect(wheelNotches(ff(3))).toBe(1);
    expect(wheelNotches(ff(6))).toBe(2);
    expect(wheelNotches(chromeWin(2))).toBe(2);
  });

  it('a Windows "lines per click" setting other than 3 (5) is still one click per event', () => {
    expect(wheelNotches(ff(5))).toBe(1);
    expect(wheelNotches(ff(10))).toBe(2);
  });

  it('a touchpad stays smooth: fractions of a 100 px notch, its own pixels in a list', () => {
    expect(wheelNotches(touchpad(4))).toBeCloseTo(0.04, 9);
    expect(wheelScrollPixels(touchpad(7.5), 14, 280)).toBe(7.5);
  });

  it('lists: one retail step per click in every browser', () => {
    for (const e of [ff(3), chromeWin(), chromeScaled(), chromeLinux(), macMouse(4)]) {
      expect(wheelScrollPixels(e, 14, 280)).toBe(14);
    }
    expect(wheelScrollPixels(ff(3), 32, 128, 'x')).toBe(32);
  });

  it('an event without deltaMode is pixels (the DOM default): a 100 px wheel is one click, one list step', () => {
    const bare = { deltaX: 0, deltaY: 100 } as unknown as WheelLike;
    expect(wheelNotches(bare)).toBe(1);
    expect(wheelScrollPixels(bare, 40, 400)).toBe(40);
  });

  it('wheelEventToCode reads deltaMode first, so a Firefox event stays in lines for later listeners', () => {
    const e = ff(3);
    expect(wheelEventToCode(e)).toBe('MouseWheelDown');
    expect(wheelScrollPixels(e, 14, 280)).toBe(14);
    expect(wheelEventToCode(ff(-3))).toBe('MouseWheelUp');
  });

  it('WheelNotchCounter: a click presses at once; a touchpad stream presses once per 100 px; a direction change starts over', () => {
    const c = new WheelNotchCounter();
    expect(c.add(ff(3))).toBe(1);
    expect(c.add(chromeWin())).toBe(1);
    let presses = 0;
    for (let i = 0; i < 24; i++) presses += c.add(touchpad(4)); // 96 px
    expect(presses).toBe(0);
    presses += c.add(touchpad(4)); // 100 px
    expect(presses).toBe(1);
    expect(c.add(touchpad(-60))).toBe(0);
    expect(c.add(touchpad(-40))).toBe(-1);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('the world wheel in each browser (real CameraController)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let c: CameraController;
  const HOME = Math.hypot(2.75, 0.825);
  const OUT = 1 + (1 / 60) * 40 * 0.2;
  const IN = 1 - (1 / 60) * 40 * 0.2;

  afterAll(() => restoreDomGlobals(GLOBALS, saved));
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) {
      if (!(key in saved)) saved[key] = g[key];
      g[key] = key === 'window' ? domWindow : domWindow[key];
    }
    domWindow.document.body.innerHTML = '';
    c = new CameraController(new THREE.PerspectiveCamera());
    for (let i = 0; i < 20; i++) c.frameRate.push(1 / 60);
    c.bind(domWindow.document.body);
    c.wheelZoomBound = true;
  });
  afterEach(() => { c.wheelZoomBound = false; c.mouseControlHandler = null; });

  function dispatch(shape: WheelLike | ((e: object) => void)): Event {
    const e = new domWindow.WheelEvent('wheel', { bubbles: true, cancelable: true });
    if (typeof shape === 'function') shape(e);
    else for (const [k, v] of Object.entries(shape)) Object.defineProperty(e, k, { configurable: true, value: v });
    domWindow.document.body.dispatchEvent(e);
    return e;
  }
  const ffShape = (lines: number) => (e: object) => { firefoxWheel(e, lines); };

  it('zoom: one Firefox click is one full Farther step (was ≈0.57, or 3 if lines were read raw)', () => {
    dispatch(ffShape(3));
    expect(c.cameraDistance).toBeCloseTo(HOME * OUT, 5);
  });

  it('zoom: one Firefox click up is one full Closer step', () => {
    dispatch(ffShape(-3));
    expect(c.cameraDistance).toBeCloseTo(HOME * IN, 5);
  });

  it('zoom: one Chrome click at 150 % scaling and one on Linux are one step each', () => {
    dispatch(chromeScaled());
    expect(c.cameraDistance).toBeCloseTo(HOME * OUT, 5);
    dispatch(chromeLinux());
    expect(c.cameraDistance).toBeCloseTo(HOME * OUT * OUT, 5);
  });

  it('a wheel-bound command fires once per click in Firefox and Chrome, and once per 100 px of touchpad', () => {
    c.wheelZoomBound = false;
    const calls: Array<[string, boolean]> = [];
    c.mouseControlHandler = (code, down) => { calls.push([code, down]); return true; };
    expect(dispatch(ffShape(-3)).defaultPrevented).toBe(true);
    expect(calls).toEqual([['MouseWheelUp', true], ['MouseWheelUp', false]]);
    calls.length = 0;
    dispatch(chromeScaled());
    expect(calls).toEqual([['MouseWheelDown', true], ['MouseWheelDown', false]]);
    calls.length = 0;
    for (let i = 0; i < 20; i++) dispatch(touchpad(4)); // 80 px: no press yet
    expect(calls).toEqual([]);
    for (let i = 0; i < 5; i++) dispatch(touchpad(4)); // 100 px
    expect(calls).toEqual([['MouseWheelDown', true], ['MouseWheelDown', false]]);
  });
});
