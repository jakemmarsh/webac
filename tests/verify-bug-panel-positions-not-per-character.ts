/**
 * BUG.panel-positions-not-per-character — panel drag positions
 * (`ac_panel_pos_v2`) were persisted under a single bare global localStorage
 * key with no account/character component, unlike retail's per-character UI
 * layout save. Worse than the analogous BUG.chat-history-leaks-across-
 * characters defect: `loadPanelPositions()` isn't even cached at
 * construction time — it's read fresh from localStorage on every
 * `renderPanel()` call — so a character switch mid-session (no page reload)
 * immediately shows the OTHER character's saved panel layout the next time
 * a panel is opened.
 *
 * Fix: `LayoutRenderer.setPanelPositionsScope(accountName, characterName)`
 * (mirroring `ChatHistoryState.keyFor`) namespaces the `ac_panel_pos_v2`
 * storage key by account+character. `GameUI.setChatHistoryScope()` — already
 * called at enter-world before any chat/panel interaction — now also calls
 * it, so panel positions are re-scoped at the same point in the lifecycle
 * as chat history.
 *
 * This suite drives the real `LayoutRenderer` (with real DAT-parsed layout
 * data) through a full renderPanel -> drag -> persist -> re-render cycle
 * for two different character scopes, proving the positions don't leak.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Panel 0x21000023 (the inventory panel chrome, per GameUI.ts renderInventoryPanel):
// closeButtonId 0x100001d2, dragHandleId 0x100001d3 — real DAT-baked element ids.
const PANEL_LAYOUT_ID = 0x21000023;
const DRAG_HANDLE_ID = 0x100001d3;

describe.skipIf(!hasLang || !hasPortal)('BUG.panel-positions-not-per-character — LayoutRenderer scoping (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LayoutRenderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let DatDatabase: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // happy-dom lacks rAF; renderPanel's right-dock re-anchor + viewport
    // clamp use it. No-op stub (matches verify-options-panel-behavioral.ts).
    if (typeof (g as Record<string, unknown> & { requestAnimationFrame?: unknown }).requestAnimationFrame !== 'function') {
      (g as any).requestAnimationFrame = () => 0;
      (g as any).cancelAnimationFrame = () => {};
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }

    const datMod = await import('@ac/dat-parser');
    DatDatabase = datMod.DatDatabase;
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    LayoutRenderer = lrMod.LayoutRenderer;

    // Layout element parsing resolves BaseProperty types via the portal.dat
    // MasterProperty table (0x39000001) — same prerequisite as
    // verify-layout-parser.ts.
    const portalDb = openDat(PORTAL_PATH);
    const mpData = portalDb.getFileData(0x39000001)!;
    const mpTypes = datMod.parseMasterProperty(new datMod.DatReader(mpData));
    datMod.setMasterPropertyTypes(mpTypes);

    const langDb = openDat(LANG_PATH);

    // Texture loading is irrelevant to position persistence — a permissive
    // stub keeps this test from depending on portal.dat texture data.
    const uiTextureLoader = {
      getTextureDataURL: () => null,
      getTextureDataURLWithAlpha: () => null,
    };

    renderer = new LayoutRenderer(langDb, uiTextureLoader, null);
    hud = domWindow.document.createElement('div');
    Object.defineProperty(hud, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(hud, 'offsetHeight', { value: 600, configurable: true });
    domWindow.document.body.appendChild(hud);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  /** Renders the panel, drags it by (dx, dy) via its real title-bar drag
   *  handle, and returns the final persisted {left, top}. */
  function renderDragAndPersist(persistKey: string, dx: number, dy: number): { left: number; top: number } {
    const handle = renderer.renderPanel(PANEL_LAYOUT_ID, hud, {
      x: 0, y: 0, persistKey, dragHandleId: DRAG_HANDLE_ID,
    });
    expect(handle).not.toBeNull();
    const dragEl: HTMLElement = handle!.elements.get(DRAG_HANDLE_ID);
    expect(dragEl).toBeTruthy();

    dragEl.dispatchEvent(new domWindow.MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }));
    domWindow.document.dispatchEvent(new domWindow.MouseEvent('mouseup', { bubbles: true }));

    const panelEl = handle!.root.parentElement as HTMLElement;
    handle!.destroy();
    return { left: parseInt(panelEl.style.left) || 0, top: parseInt(panelEl.style.top) || 0 };
  }

  /** Renders the panel and returns its initial {left, top} WITHOUT dragging
   *  — i.e. whatever loadPanelPositions() restored (or the x/y default). */
  function renderAndReadInitial(persistKey: string): { left: number; top: number } {
    const handle = renderer.renderPanel(PANEL_LAYOUT_ID, hud, {
      x: 0, y: 0, persistKey, dragHandleId: DRAG_HANDLE_ID,
    });
    expect(handle).not.toBeNull();
    const panelEl = handle!.root.parentElement as HTMLElement;
    const pos = { left: parseInt(panelEl.style.left) || 0, top: parseInt(panelEl.style.top) || 0 };
    handle!.destroy();
    return pos;
  }

  it('dragging + persisting a panel position for character A does not leak into character B\'s scope', () => {
    LayoutRenderer.setPanelPositionsScope('testacjs', 'CharA');
    const aDragged = renderDragAndPersist('bugtest-panel', 50, 60);
    expect(aDragged).toEqual({ left: 50, top: 60 });

    // Character switch, same session, no page reload — mirrors GameUI's
    // setChatHistoryScope call site at enter-world.
    LayoutRenderer.setPanelPositionsScope('testacjs', 'CharB');
    const bInitial = renderAndReadInitial('bugtest-panel');
    // CharB has never dragged this panel — must NOT see CharA's (50, 60).
    expect(bInitial).toEqual({ left: 0, top: 0 });
  });

  it('character B persisting its own position does not overwrite character A\'s', () => {
    LayoutRenderer.setPanelPositionsScope('testacjs', 'CharB');
    const bDragged = renderDragAndPersist('bugtest-panel', 200, 220);
    expect(bDragged).toEqual({ left: 200, top: 220 });

    LayoutRenderer.setPanelPositionsScope('testacjs', 'CharA');
    const aRestored = renderAndReadInitial('bugtest-panel');
    expect(aRestored).toEqual({ left: 50, top: 60 }); // CharA's own position, untouched by CharB's drag
  });

  it('same character name on a different account gets an isolated position', () => {
    LayoutRenderer.setPanelPositionsScope('otherAccount', 'CharA');
    const otherAcctInitial = renderAndReadInitial('bugtest-panel');
    expect(otherAcctInitial).toEqual({ left: 0, top: 0 }); // does not see testacjs:CharA's (50, 60)
  });
});
