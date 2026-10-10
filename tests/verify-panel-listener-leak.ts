/**
 * PERF.session-soak-dom-nodes — a closed panel must leave nothing on `document`.
 *
 * The 60-minute session soak (2026-10-03) ended with DOM nodes 3–5x above
 * start on unchanged code. A heap snapshot traced the detached trees to
 * `document` → `mouseup` listener `onUp` → the panel handle: renderPanel
 * attached its title-bar drag listeners to document for the panel's whole
 * life, and close()/destroy() never removed them, so every examine window,
 * container and vendor stayed in memory (~140 nodes per examine). The
 * scrollbar thumb did the same. Now both listen only while the button is held.
 *
 * Behavioral: real LayoutRenderer.renderPanel on the DAT inventory chrome
 * (0x21000023, drag handle 0x100001d3) in happy-dom; document's
 * add/removeEventListener are counted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const PANEL_LAYOUT_ID = 0x21000023;
const DRAG_HANDLE_ID = 0x100001d3;

describe.skipIf(!hasDats)('PERF.session-soak-dom-nodes — panels leave no document listeners behind', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;
  /** Live listeners on document, by type (adds minus removes). */
  const live = new Map<string, number>();

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown> & { requestAnimationFrame?: unknown };
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof g.requestAnimationFrame !== 'function') {
      (g as any).requestAnimationFrame = () => 0;
      (g as any).cancelAnimationFrame = () => {};
      domWindow.requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const doc = domWindow.document;
    const add = doc.addEventListener.bind(doc), rem = doc.removeEventListener.bind(doc);
    doc.addEventListener = (t: string, ...a: unknown[]) => { live.set(t, (live.get(t) ?? 0) + 1); return add(t, ...a); };
    doc.removeEventListener = (t: string, ...a: unknown[]) => { live.set(t, (live.get(t) ?? 0) - 1); return rem(t, ...a); };

    const datMod = await import('@ac/dat-parser');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const portalDb = openDat(PORTAL_PATH);
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    // Textures are irrelevant to listener bookkeeping: a permissive stub (as verify-bug-panel-positions-not-per-character.ts).
    const uiTextureLoader = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null } as unknown as ConstructorParameters<typeof LayoutRenderer>[1];
    renderer = new LayoutRenderer(openDat(LANG_PATH), uiTextureLoader, null);
    hud = doc.createElement('div');
    Object.defineProperty(hud, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(hud, 'offsetHeight', { value: 600, configurable: true });
    doc.body.appendChild(hud);
  });

  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const moveUp = () => (live.get('mousemove') ?? 0) + (live.get('mouseup') ?? 0);
  const open = () => renderer.renderPanel(PANEL_LAYOUT_ID, hud, { x: 0, y: 0, dragHandleId: DRAG_HANDLE_ID });

  it('opening and closing panels adds no lasting document mousemove/mouseup listeners', () => {
    open()!.close();   // first render may register the app-wide drag handlers once
    const before = moveUp();
    for (let i = 0; i < 10; i++) open()!.close();
    for (let i = 0; i < 5; i++) open()!.destroy();
    expect(moveUp()).toBe(before);
  });

  it('a title-bar drag still moves the panel, and its listeners go away on release', () => {
    const before = moveUp();
    const h = open()!;
    const dragEl: HTMLElement = h.elements.get(DRAG_HANDLE_ID);
    dragEl.dispatchEvent(new domWindow.MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
    expect(moveUp()).toBe(before + 2);                       // only while pressed
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mousemove', { clientX: 140, clientY: 125, bubbles: true }));
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mouseup', { bubbles: true }));
    expect(moveUp()).toBe(before);
    const panelEl = h.root.parentElement as HTMLElement;
    expect([parseInt(panelEl.style.left), parseInt(panelEl.style.top)]).toEqual([40, 25]);
    h.close();
  });
});
