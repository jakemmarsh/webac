/**
 * MOVE.stuck-forward-after-map-switch — a held key's keyup releases the
 * canonical code its keydown produced, even when the key's translation
 * changed while it was held.
 *
 * Repro (live, 2026-09-26): hold ArrowUp (translated to the canonical
 * 'KeyW' — Move Forward), press F2 (Toggle Alternate Camera Mode registers
 * input map 6, where ArrowUp is Rotate Camera Up), release ArrowUp. The
 * keyup used to re-translate under map 6, delete 'ArrowUp', and leave
 * 'KeyW' held — the player ran on with no key down.
 *
 * Also: window blur releases every held movement key (the keyups for keys
 * held while focus leaves never arrive); auto-run is a lock and survives.
 *
 * BEHAVIORAL: the real CameraController.bind() listeners, driven by real
 * DOM-shaped events on a Node EventTarget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
beforeAll(() => { savedDocument = g.document; g.document = { activeElement: null }; });
afterAll(() => { g.document = savedDocument; });

function key(type: 'keydown' | 'keyup', code: string): Event {
  const e = new Event(type);
  Object.assign(e, { code });
  return e;
}

function bound(): { cc: CameraController; el: EventTarget; altMap: { on: boolean } } {
  const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
  const el = new EventTarget();
  cc.bind(el as unknown as HTMLElement);
  const altMap = { on: false };
  // Map 5 (default): ArrowUp = Move Forward → canonical KeyW.
  // Map 6 (alternate camera held): ArrowUp = Rotate Camera Up → passes through.
  cc.keyTranslator = (code) => (code === 'ArrowUp' && !altMap.on ? 'KeyW' : code);
  return { cc, el, altMap };
}

describe('held-key release follows the keydown translation', () => {
  it('ArrowUp held, alternate camera map registered, ArrowUp released → forward stops', () => {
    const { cc, el, altMap } = bound();
    el.dispatchEvent(key('keydown', 'ArrowUp'));
    expect(cc.isMovingForward).toBe(true);
    altMap.on = true; // F2 pressed
    el.dispatchEvent(key('keyup', 'ArrowUp'));
    expect(cc.isMovingForward).toBe(false);
  });

  it('an ordinary press/release still round-trips', () => {
    const { cc, el } = bound();
    el.dispatchEvent(key('keydown', 'KeyW'));
    expect(cc.isMovingForward).toBe(true);
    el.dispatchEvent(key('keyup', 'KeyW'));
    expect(cc.isMovingForward).toBe(false);
  });

  it('a keyup with no recorded keydown falls back to the current translation', () => {
    const { cc, el } = bound();
    cc.simulateKeyDown('KeyW');
    el.dispatchEvent(key('keyup', 'ArrowUp'));
    expect(cc.isMovingForward).toBe(false);
  });

  it('releaseAllKeys (window blur) drops held movement keys but keeps the auto-run lock', () => {
    const { cc, el } = bound();
    el.dispatchEvent(key('keydown', 'KeyW'));
    cc.releaseAllKeys();
    expect(cc.isMovingForward).toBe(false);
    cc.autoRun = true;
    cc.releaseAllKeys();
    expect(cc.isMovingForward).toBe(true);
  });
});

describe('pointer-lock edge cases for held mouse-look', () => {
  it('a rejected requestPointerLock promise is swallowed', async () => {
    const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
    const el = new EventTarget() as EventTarget & { requestPointerLock?: () => Promise<void> };
    let rejected = false;
    el.requestPointerLock = () => { const p = Promise.reject(new Error('SecurityError')); p.catch(() => { rejected = true; }); return p; };
    cc.bind(el as unknown as HTMLElement);
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    cc.setMouseLook(true);
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    expect(rejected).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('losing pointer lock (Esc) while the look button is held turns mouse-look off', () => {
    const doc = new EventTarget() as EventTarget & { activeElement: null; pointerLockElement: unknown };
    doc.activeElement = null;
    doc.pointerLockElement = null;
    const prev = g.document;
    g.document = doc;
    try {
      const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
      const el = new EventTarget() as EventTarget & { requestPointerLock?: () => void };
      el.requestPointerLock = () => { doc.pointerLockElement = el; };
      cc.bind(el as unknown as HTMLElement);
      cc.setMouseLook(true);
      expect(cc.isMouseLookActive).toBe(true);
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
      expect(cc.isMouseLookActive).toBe(false);
    } finally {
      g.document = prev;
    }
  });
});
