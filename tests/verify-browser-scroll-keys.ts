/**
 * The arrows / Space / Page keys belong to the game: pressed outside a text
 * field they move the character and must not also scroll the panel the
 * player last clicked (Jake 2026-10-11: the inventory scrolled while the
 * arrows walked). BEHAVIORAL: the real CameraController.bind() keydown
 * listener, driven by cancelable events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { suppressesBrowserScroll, isKeyboardField, suppressPageContextMenu } from '../packages/renderer/src/input/BrowserDefaults.js';

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
const doc = { activeElement: null as unknown };
beforeAll(() => { savedDocument = g.document; g.document = doc; });
afterAll(() => { g.document = savedDocument; });

function keydown(code: string): Event {
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, { code });
  return e;
}

function bound(): { cc: CameraController; el: EventTarget } {
  const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
  const el = new EventTarget();
  cc.bind(el as unknown as HTMLElement);
  // Retail map 5: the arrows walk / turn, Space jumps.
  const map: Record<string, string> = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
  cc.keyTranslator = (code) => map[code] ?? code;
  return { cc, el };
}

describe('browser scroll keys never scroll a panel during play', () => {
  it('an arrow walks the character and its default (scrolling) is prevented', () => {
    doc.activeElement = null;
    const { cc, el } = bound();
    const e = keydown('ArrowUp');
    el.dispatchEvent(e);
    expect(cc.isMovingForward).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('every page-scrolling key is prevented; ordinary keys keep their default', () => {
    doc.activeElement = null;
    const { el } = bound();
    for (const code of ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space']) {
      const e = keydown(code);
      el.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(true);
    }
    for (const code of ['KeyW', 'Tab', 'F5']) {
      const e = keydown(code);
      el.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(false);
    }
  });

  it('inside a text field the keys keep their caret behaviour', () => {
    expect(isKeyboardField({ tagName: 'INPUT' } as Element)).toBe(true);
    expect(isKeyboardField({ tagName: 'TEXTAREA' } as Element)).toBe(true);
    expect(isKeyboardField({ tagName: 'SELECT' } as Element)).toBe(true);
    expect(isKeyboardField({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true);
    expect(isKeyboardField({ tagName: 'DIV', isContentEditable: false } as unknown as Element)).toBe(false);
    expect(suppressesBrowserScroll('ArrowUp', { tagName: 'TEXTAREA' } as Element)).toBe(false);
    expect(suppressesBrowserScroll('ArrowUp', { tagName: 'DIV' } as Element)).toBe(true);
    expect(suppressesBrowserScroll('KeyA', null)).toBe(false);
  });
});

describe('the browser right-click menu never opens over the game', () => {
  function rightClick(target: EventTarget, on: object | null): Event {
    const e = new Event('contextmenu', { cancelable: true, bubbles: true });
    Object.defineProperty(e, 'target', { value: on });
    target.dispatchEvent(e);
    return e;
  }
  it('is suppressed on any screen, but a text field keeps it (paste)', () => {
    const page = new EventTarget();
    suppressPageContextMenu(page as unknown as Document);
    expect(rightClick(page, { tagName: 'DIV' }).defaultPrevented).toBe(true);
    expect(rightClick(page, { tagName: 'IMG' }).defaultPrevented).toBe(true);
    expect(rightClick(page, { tagName: 'INPUT' }).defaultPrevented).toBe(false);
  });
});
