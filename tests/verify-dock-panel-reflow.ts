/**
 * CORE.5.c — right-dock panels RESIZE (reflow) to the dock slot per DAT
 * edge flags, instead of uniform-downscaling.
 *
 * Drives the REAL LayoutRenderer against the real DATs:
 *  - renderPanel() now accepts subtreeElementId, rendering only the panel
 *    window's subtree (rebased to (0,0), container sized to the window)
 *    and exposing resizeSubtree.
 *  - resizeSubtree() sizes the window element itself (retail resizes the
 *    window via SetSize; only children go through
 *    UIElement::UpdateForParentSizeChange @ 00462640) and reflows every
 *    child per its DAT edges:
 *      inventory 0x21000023 root 0x100001cc: grid 0x100001cf (L1T1R1B1)
 *      and side strip 0x100001ce (L2T1R1B1) stretch; bottom filler
 *      0x100001d1 (T1B1 at y=361) covers the grown region; background
 *      0x100001d0 (B2) keeps its authored 362px; close/title/paperdoll
 *      stay fixed.
 *      character 0x2100002e root 0x10000227: tab pages 300x575 (L1T1R1B1)
 *      stretch under the fixed 25px tab row.
 *  - options 0x2100002b subtree render excludes the sibling row/widget
 *    TEMPLATE elements (retail instances them; never shown directly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const INV_LAYOUT = 0x21000023;
const INV_ROOT = 0x100001cc;
const CHAR_LAYOUT = 0x2100002e;
const CHAR_ROOT = 0x10000227;
const OPTIONS_LAYOUT = 0x2100002b;
const OPTIONS_ROOT = 0x10000208;

const px = (el: HTMLElement, prop: 'left' | 'top' | 'width' | 'height'): number =>
  parseFloat(el.style[prop]);

describe.skipIf(!hasLang || !hasPortal)('CORE.5.c — dock panel reflow (DAT edge flags)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const datMod = await import('@ac/dat-parser');
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');

    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));

    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    renderer = new lrMod.LayoutRenderer(langDb, uiTextureLoader, null);
    hud = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(hud);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('renderPanel(subtreeElementId) renders the window subtree rebased to (0,0) with resizeSubtree available', () => {
    const handle = renderer.renderPanel(INV_LAYOUT, hud, { subtreeElementId: INV_ROOT });
    expect(handle).not.toBeNull();
    expect(typeof handle.resizeSubtree).toBe('function');
    // Window element rebased from its DAT-baked (500,138) to (0,0); the
    // container is sized to the 300x362 window, not the 800x600 canvas.
    const rootEl = handle.elements.get(INV_ROOT)!;
    expect(px(rootEl, 'left')).toBe(0);
    expect(px(rootEl, 'top')).toBe(0);
    expect(px(handle.root, 'width')).toBe(300);
    expect(px(handle.root, 'height')).toBe(362);
    handle.close();
  });

  it('grow: inventory reflow to a 810px dock slot stretches grid/strip/filler, keeps fixed chrome', () => {
    const handle = renderer.renderPanel(INV_LAYOUT, hud, { subtreeElementId: INV_ROOT });
    handle.resizeSubtree!(300, 810); // an arbitrary tall dock slot (~1080 logical - 140 dock top - 122 toolbar)
    const dH = 810 - 362;

    // The window element itself is resized (retail SetSize), so its own
    // backing does not stay at the authored height.
    const rootEl = handle.elements.get(INV_ROOT)!;
    expect(px(rootEl, 'width')).toBe(300);
    expect(px(rootEl, 'height')).toBe(810);
    expect(px(handle.root, 'height')).toBe(810);

    // Item grid 0x100001cf (0,237) 234x120, L1T1R1B1 → bottom follows: +dH.
    const grid = handle.elements.get(0x100001cf)!;
    expect(px(grid, 'top')).toBe(237);
    expect(px(grid, 'height')).toBe(120 + dH);

    // Side-pack strip 0x100001ce (239,23) 61x339, L2T1R1B1 → stretches
    // (left follows width delta = 0 here).
    const strip = handle.elements.get(0x100001ce)!;
    expect(px(strip, 'left')).toBe(239);
    expect(px(strip, 'height')).toBe(339 + dH);

    // 1px bottom filler 0x100001d1 (0,361), T1B1 → stretches over exactly
    // the grown region below the fixed background art.
    const filler = handle.elements.get(0x100001d1)!;
    expect(px(filler, 'top')).toBe(361);
    expect(px(filler, 'height')).toBe(1 + dH);

    // Background 0x100001d0 (0,0) 300x362, B2 = fixed → keeps authored height.
    const bg = handle.elements.get(0x100001d0)!;
    expect(px(bg, 'height')).toBe(362);

    // Fixed chrome: close button 0x100001d2 (276,0) 24x23 (R1 with dW=0,
    // B2 fixed) and paperdoll 0x100001cd (0,23) 224x214 (R2/B2 fixed).
    const close = handle.elements.get(0x100001d2)!;
    expect(px(close, 'left')).toBe(276);
    expect(px(close, 'top')).toBe(0);
    expect(px(close, 'height')).toBe(23);
    const paperdoll = handle.elements.get(0x100001cd)!;
    expect(px(paperdoll, 'top')).toBe(23);
    expect(px(paperdoll, 'height')).toBe(214);
    handle.close();
  });

  it('shrink: inventory reflow to a 330px dock slot (800x600 logical minimum) shrinks the stretch regions', () => {
    const handle = renderer.renderPanel(INV_LAYOUT, hud, { subtreeElementId: INV_ROOT });
    handle.resizeSubtree!(300, 330);
    const grid = handle.elements.get(0x100001cf)!;
    expect(px(grid, 'height')).toBe(120 - 32); // loses one 32px row
    const strip = handle.elements.get(0x100001ce)!;
    expect(px(strip, 'height')).toBe(339 - 32);
    // Fixed-bottom background keeps its authored height (overhang is
    // clipped by the dock wrapper's overflow:hidden in GameUI).
    const bg = handle.elements.get(0x100001d0)!;
    expect(px(bg, 'height')).toBe(362);
    handle.close();
  });

  it('character panel: tab pages stretch under the fixed 25px tab row', () => {
    const handle = renderer.renderPanel(CHAR_LAYOUT, hud, { subtreeElementId: CHAR_ROOT });
    handle.resizeSubtree!(300, 810);
    const dH = 810 - 600; // window element authored 300x600
    for (const pageId of [0x10000539, 0x1000022b, 0x1000022c]) {
      const page = handle.elements.get(pageId)!;
      expect(px(page, 'top')).toBe(25);
      expect(px(page, 'height')).toBe(575 + dH);
    }
    // Tab buttons stay in the fixed 25px row.
    const tab1 = handle.elements.get(0x10000228)!;
    expect(px(tab1, 'top')).toBe(0);
    expect(px(tab1, 'height')).toBe(25);
    handle.close();
  });

  it('incorporation reflow: the spellbook page sizes its inherited classic-page tree to the page (footer bottom-pinned)', () => {
    // 0x100002ac (300x575) incorporates the classic spellbook page root
    // 0x10000294@0x21000032 (300x337). Retail sizes the incorporated tree
    // to the incorporating element (spellbook-panel.jpg: the Schools/
    // Levels/Delete footer 0x10000297, T2B1, is pinned to the PAGE bottom
    // and the list 0x10000295, B1, fills above it) — so at resolution the
    // base children reflow by dH=+238.
    const layout = renderer.getResolvedLayout(0x21000034)!;
    const win = layout.elements.get(0x100002a8)!;
    const page = [...win.children.values()].find((c: { elementId: number }) => c.elementId === 0x100002ac)!;
    const byId = (id: number) => [...page.children.values()].find((c: { elementId: number }) => c.elementId === id)!;
    const footer = byId(0x10000297);
    expect(footer.y).toBe(224 + 238);      // bottom-pinned: 462 + 113 = 575
    expect(footer.height).toBe(113);
    const list = byId(0x10000295);
    expect(list.y).toBe(0);
    expect(list.height).toBe(224 + 238);   // fills down to the footer
    const sb = byId(0x10000296);
    expect(sb.height).toBe(224 + 238);

    // And the runtime dock reflow composes with it: window 600 → 810 gives
    // the page dH=+210, so the footer lands at 672 = page bottom again.
    const handle = renderer.renderPanel(0x21000034, hud, { subtreeElementId: 0x100002a8 });
    handle.resizeSubtree!(300, 810);
    const footerEl = handle.elements.get(0x10000297)!;
    expect(px(footerEl, 'top')).toBe(672);
    expect(px(footerEl, 'height')).toBe(113);
    handle.close();
  });

  it('options panel: subtree render excludes the sibling row/widget template elements', () => {
    const handle = renderer.renderPanel(OPTIONS_LAYOUT, hud, { subtreeElementId: OPTIONS_ROOT });
    expect(handle.elements.get(OPTIONS_ROOT)).toBeTruthy();
    // Row/widget templates are top-level SIBLINGS of the window element in
    // 0x2100002b — a subtree render must not instantiate them.
    for (const templateId of [0x10000216, 0x10000217, 0x10000218, 0x1000021a, 0x10000220, 0x10000522]) {
      expect(handle.elements.get(templateId)).toBeUndefined();
    }
    // Pages 0x10000211.. ((2,25) 298x575, L1T1R1B1) stretch on reflow.
    handle.resizeSubtree!(300, 810);
    const page = handle.elements.get(0x10000211)!;
    expect(px(page, 'top')).toBe(25);
    expect(px(page, 'height')).toBe(575 + 210);
    handle.close();
  });
});
