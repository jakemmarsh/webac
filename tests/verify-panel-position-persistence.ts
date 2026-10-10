/**
 * FAITHFUL.477 — panel-position persistence across sessions.
 *
 *  Closes the panel-position persistence gap explicitly noted in the
 *  session-opening audit. Pre-fix the panels supported drag-to-move
 *  (LayoutRenderer's dragHandle), but the dragged positions reset to
 *  the panel's hardcoded default x/y every login. Retail AC saved
 *  per-character panel positions per the UI layout config.
 *
 *  Implementation:
 *  - `PanelOptions.persistKey: string` — opt-in key per panel.
 *  - On render, if persistKey is set, the panel's initial position is
 *    read from `localStorage[ac_panel_pos_v1][persistKey]` (overrides
 *    options.x/y).
 *  - On drag-end, the new position is written back under the same key.
 *
 *  Wired into 7 panels via persistKey: inventory, magic, character,
 *  map, social, options, enchantment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import type { ElementDesc, LayoutDescData } from '@ac/dat-parser/file-types/LayoutDesc.js';

// A DAT-free synthetic layout (window 0x10000001 with a title/drag element
// 0x10000002), seeded into the real LayoutRenderer's layout cache so the
// persistKey mechanics run on CI too. The DAT-backed per-character scoping
// cycle lives in tests/verify-bug-panel-positions-not-per-character.ts.
const LAYOUT_ID = 0x21fffff0;
const ROOT_ID = 0x10000001;
const DRAG_ID = 0x10000002;

function el(elementId: number, x: number, y: number, w: number, h: number, children: ElementDesc[] = []): ElementDesc {
  return {
    stateId: 0, passToChildren: false, incorporationFlags: 0, properties: new Map(), media: [],
    uiReadOrder: 0, elementId, type: 3, baseElement: 0, baseLayout: 0, defaultState: 0,
    x, y, width: w, height: h, zLevel: 0, leftEdge: 0, topEdge: 0, rightEdge: 0, bottomEdge: 0,
    states: new Map(), children: new Map(children.map((c) => [c.elementId, c])),
  };
}
const LAYOUT: LayoutDescData = {
  id: LAYOUT_ID, displayWidth: 800, displayHeight: 600,
  elements: new Map([[ROOT_ID, el(ROOT_ID, 0, 0, 200, 150, [el(DRAG_ID, 0, 0, 200, 20)])]]),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('FAITHFUL.477 — LayoutRenderer persistKey (behavioural, synthetic layout)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LayoutRenderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    domWindow.localStorage.clear();
    LayoutRenderer = (await import('../packages/renderer/src/ui/LayoutRenderer.js')).LayoutRenderer;
    renderer = new LayoutRenderer({ getFileData: () => null }, { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null }, null);
    renderer.layoutCache.set(LAYOUT_ID, LAYOUT);
    hud = domWindow.document.createElement('div');
    Object.defineProperty(hud, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(hud, 'offsetHeight', { value: 600, configurable: true });
    domWindow.document.body.appendChild(hud);
    LayoutRenderer.setPanelPositionsScope('acct', 'Char');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const pos = (handle: { root: HTMLElement }) => {
    const panel = handle.root.parentElement as HTMLElement;
    return { left: parseInt(panel.style.left) || 0, top: parseInt(panel.style.top) || 0 };
  };
  const open = (persistKey?: string) => renderer.renderPanel(LAYOUT_ID, hud, { x: 10, y: 20, persistKey, dragHandleId: DRAG_ID });
  const drag = (handle: { elements: Map<number, HTMLElement> }, dx: number, dy: number) => {
    const d = handle.elements.get(DRAG_ID)!;
    d.dispatchEvent(new domWindow.MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }));
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mouseup', { bubbles: true }));
  };

  it('with no stored position the panel opens at options.x / options.y', () => {
    const h = open('pp-test');
    expect(h).not.toBeNull();
    expect(pos(h)).toEqual({ left: 10, top: 20 });
    h.destroy();
  });

  it('dragging a persistKey panel saves the position; the next open restores it over options.x/y', () => {
    const h = open('pp-test');
    drag(h, 30, 40);
    expect(pos(h)).toEqual({ left: 40, top: 60 });
    h.destroy();
    const again = open('pp-test');
    expect(pos(again)).toEqual({ left: 40, top: 60 });
    again.destroy();
  });

  it('a panel without persistKey never restores or saves a position', () => {
    const h = open(undefined);
    drag(h, 5, 5);
    h.destroy();
    const again = open(undefined);
    expect(pos(again)).toEqual({ left: 10, top: 20 });
    again.destroy();
  });
});
