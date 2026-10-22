/**
 * COMPAT.firefox-quick-find — Firefox opens its Quick Find bar on ' and /
 * typed outside a text field (and on any printable key with "Search for text
 * when you start typing" on), stealing focus from the game. A printable key
 * pressed in the world now has its default prevented by the real
 * CameraController.bind() keydown listener; browser shortcuts (Ctrl / Cmd),
 * F-keys, Tab and text fields keep theirs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { suppressesBrowserKeyDefault } from '../packages/renderer/src/input/BrowserDefaults.js';

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
const doc = { activeElement: null as unknown };
beforeAll(() => { savedDocument = g.document; g.document = doc; });
afterAll(() => { g.document = savedDocument; });

function keydown(code: string, key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): Event {
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods });
  return e;
}

function bound(): { cc: CameraController; el: EventTarget } {
  const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
  const el = new EventTarget();
  cc.bind(el as unknown as HTMLElement);
  const map: Record<string, string> = { KeyW: 'KeyW' };
  cc.keyTranslator = (code) => map[code] ?? code;
  return { cc, el };
}

describe("Firefox's Quick Find never opens over the world", () => {
  it("' and / (Quick Find's own keys) are prevented, even when no binding handles them", () => {
    doc.activeElement = null;
    const { el } = bound();
    for (const [code, key] of [['Quote', "'"], ['Slash', '/']] as const) {
      const e = keydown(code, key);
      el.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(true);
    }
  });

  it('a movement key (W) still moves the character, and its default is prevented (type-ahead find)', () => {
    doc.activeElement = null;
    const { cc, el } = bound();
    const e = keydown('KeyW', 'w');
    el.dispatchEvent(e);
    expect(cc.isMovingForward).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('browser shortcuts and non-printing keys keep their defaults', () => {
    doc.activeElement = null;
    const { el } = bound();
    const cases: Event[] = [
      keydown('KeyR', 'r', { metaKey: true }), // Cmd+R reload
      keydown('KeyT', 't', { ctrlKey: true }), // Ctrl+T new tab
      keydown('F5', 'F5'),
      keydown('Tab', 'Tab'),
      keydown('Escape', 'Escape'),
    ];
    for (const e of cases) {
      el.dispatchEvent(e);
      expect(e.defaultPrevented, (e as unknown as { code: string }).code).toBe(false);
    }
  });

  it('a text field keeps every key', () => {
    expect(suppressesBrowserKeyDefault({ code: 'Slash', key: '/' }, { tagName: 'INPUT' } as Element)).toBe(false);
    expect(suppressesBrowserKeyDefault({ code: 'KeyW', key: 'w' }, { tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(false);
    expect(suppressesBrowserKeyDefault({ code: 'Quote', key: "'" }, { tagName: 'DIV' } as Element)).toBe(true);
    // A dead key (Mac Option+E, a Spanish ´) names itself "Dead": not a character, left alone.
    expect(suppressesBrowserKeyDefault({ code: 'KeyE', key: 'Dead' }, null)).toBe(false);
  });
});
