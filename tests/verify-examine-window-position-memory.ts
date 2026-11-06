/**
 * webac#24 — "Examine panel does not remember its position. If you move the
 * examine panel it will reset to its default position the next time you
 * examine something."
 *
 * Retail: gmFloatyExaminationUI is the HUD's one examine window (WindowID 7,
 * attr 0x1000007e on root slot 0x100005f7). Its MoveTo @ 004d45e0 clamps the
 * position into the parent region and writes it to PlayerModule chat-window
 * options 0x10000086/87 under that WindowID (ResizeTo @ 004d4470 writes
 * 0x10000088/89), and UpdateFromPlayerModule @ 004d4250 moves / sizes it from
 * them at login, so a moved window stays put for the session and across
 * sessions (the module is saved to the server).
 *
 * Ours re-creates the window on every examine at
 * examinationWindowPlacement(persisted WindowID 7 rect). The DAT Dragbar
 * persisted through wireFloatyWindowBorders, but the title strip moved the
 * window through LayoutRenderer's generic drag, which saved nothing — so the
 * next examine reopened at the default spot. These tests drive the real
 * GameUI (happy-dom) and, with the DATs present, the real LayoutRenderer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';
import { parseMasterProperty, setMasterPropertyTypes } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { EXAMINATION_WINDOW, examinationWindowPlacement } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;
const E = EXAMINATION_WINDOW;
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

const itemView = (guid = 0x800009e4, title = 'Apple') => ({
  guid, title, page: 'item',
  item: { value: '', burden: '', runs: [], text: '', paragraphs: [], lines: [{ text: 'Value: 7', color: 0 }] },
  inscription: { visible: false, text: '', signature: '' },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drag(win: any, el: HTMLElement, dx: number, dy: number): void {
  el.dispatchEvent(new win.MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
  if (dx !== 0 || dy !== 0) {
    win.document.dispatchEvent(new win.MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }));
  }
  win.document.dispatchEvent(new win.MouseEvent('mouseup', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }));
}
const pos = (el: HTMLElement): { x: number; y: number } => ({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) });

describe('examine window position (real GameUI, recording layout renderer)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let win: any;
  let raised = 0;
  // 1600x900 → HUD scale 1, so the HUD is 1600x900 design px.
  const W = 1600, H = 900;

  beforeAll(async () => {
    win = await loadDomWindow({ innerWidth: W, innerHeight: H });
    installDomGlobals(win, DOM_GLOBALS as never, saved);
    const g = globalThis as Record<string, unknown>;
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    ui = new GameUI(container);
    ui.setChatHistoryScope('acct24', 'Mover');
    // A renderPanel stand-in that places the wrapper like LayoutRenderer.renderPanel (left/top = x/y).
    const renderPanel = (_layout: number, parent: HTMLElement, opts: { x?: number; y?: number } = {}) => {
      const wrapper = win.document.createElement('div');
      Object.assign(wrapper.style, { position: 'absolute', left: `${opts.x ?? 0}px`, top: `${opts.y ?? 0}px`, width: `${E.design.w}px`, height: `${E.design.h}px` });
      const root = win.document.createElement('div');
      wrapper.appendChild(root); parent.appendChild(wrapper);
      const elements = new Map<number, HTMLElement>();
      for (const id of [E.title, E.pages.item, E.pages.creature, E.pages.spell, E.item.body, E.item.scrollbar, E.item.inscriptionBlock, E.item.inscription, E.item.inscriptionScrollbar, E.item.signature]) {
        const d = win.document.createElement('div'); root.appendChild(d); elements.set(id, d);
      }
      return {
        root, layout: {}, elements, descs: new Map([[E.item.body, { width: 280, height: 286 }], [E.item.inscription, { width: 276, height: 57 }]]),
        setText() {}, setVisible() {}, setFill() {}, setState() {}, setPalette() {}, setInteractive() {}, setScrollable() { return {}; }, setDraggable() {}, setDropTarget() {},
        bringToFront: () => { raised++; },
        close: () => { wrapper.remove(); },
      };
    };
    ui.layoutRenderer = { renderPanel, render: renderPanel };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS as never, saved);
    const g = globalThis as Record<string, unknown>;
    g.MutationObserver = saved.MutationObserver; g.ResizeObserver = saved.ResizeObserver;
  });

  it('opens at the authored slot (R1/B1 gaps) when nothing is persisted', () => {
    ui.showExaminationWindow(itemView());
    expect(pos(ui.examinePanel)).toEqual({ x: W - E.design.right - E.design.w, y: H - E.design.bottom - E.design.h });
  });

  it('a press on the title that never moves saves nothing (no MoveTo)', () => {
    ui.showExaminationWindow(itemView());
    drag(win, ui.examinePanelHandle.elements.get(E.title), 0, 0);
    expect(ui.getFloatyWindowGeometry(E.windowId)).toEqual({});
  });

  it('webac#24: moved by its title, closed, examined again → it reopens where it was moved', () => {
    ui.showExaminationWindow(itemView());
    const start = pos(ui.examinePanel);
    const before = raised;
    drag(win, ui.examinePanelHandle.elements.get(E.title), -(start.x - 40), -(start.y - 30));
    expect(raised).toBe(before + 1);
    expect(pos(ui.examinePanel)).toEqual({ x: 40, y: 30 });
    // The live module copy carries it (the next server save), under WindowID 7.
    expect(ui.getFloatyWindowGeometry(E.windowId)).toMatchObject({ x: 40, y: 30 });
    expect(ui.buildChatWindowOptionsData().chatWindows.get(E.windowId)).toMatchObject({ x: 40, y: 30 });
    ui.hideExaminePanel();
    expect(ui.examinePanel).toBeNull();
    ui.showExaminationWindow(itemView(0x80000f55, 'Practice Wand'));
    expect(pos(ui.examinePanel)).toEqual({ x: 40, y: 30 });
    // Re-examining while open (a new selection) re-creates it at the same spot too.
    ui.showExaminationWindow(itemView(0x800009e4, 'Apple'));
    expect(pos(ui.examinePanel)).toEqual({ x: 40, y: 30 });
  });

  it('the title drag is held on screen like MoveTo @ 004d45e0 (x ∈ [0, W−w], y ∈ [0, H−h])', () => {
    ui.showExaminationWindow(itemView());
    drag(win, ui.examinePanelHandle.elements.get(E.title), 5000, 5000);
    expect(pos(ui.examinePanel)).toEqual({ x: W - E.design.w, y: H - E.design.h });
    drag(win, ui.examinePanelHandle.elements.get(E.title), -9000, -9000);
    expect(pos(ui.examinePanel)).toEqual({ x: 0, y: 0 });
  });

  it('LockUI: the title does not move the window', async () => {
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    ui.showExaminationWindow(itemView());
    const at = pos(ui.examinePanel);
    const prev = LayoutRenderer.isUILocked();
    LayoutRenderer.setUILocked(true);
    try {
      drag(win, ui.examinePanelHandle.elements.get(E.title), 200, 200);
      expect(pos(ui.examinePanel)).toEqual(at);
    } finally {
      LayoutRenderer.setUILocked(prev);
    }
  });

  it('a smaller browser window clamps a moved examine window back on screen; growing it back returns it', () => {
    ui.showExaminationWindow(itemView());
    drag(win, ui.examinePanelHandle.elements.get(E.title), 5000, 0);
    const moved = pos(ui.examinePanel);
    expect(moved.x).toBe(W - E.design.w);
    win.happyDOM.setWindowSize({ width: 1000, height: 700 });
    try {
      ui.reclampFloatyWindowsToScreen();
      expect(pos(ui.examinePanel).x).toBe(1000 - E.design.w);
      // Opening on the small screen clamps the stored spot too.
      ui.showExaminationWindow(itemView());
      expect(pos(ui.examinePanel).x).toBe(1000 - E.design.w);
    } finally {
      win.happyDOM.setWindowSize({ width: W, height: H });
    }
    ui.reclampFloatyWindowsToScreen();
    expect(pos(ui.examinePanel)).toEqual(moved);
  });

  it('sweep: a moved transaction dock (WindowID 6) is clamped back on screen too; an unmoved, centred one is left alone', () => {
    const host = win.document.createElement('div');
    host.dataset.dockPanel = 'vendor';
    Object.assign(host.style, { position: 'absolute', left: '900px', top: '700px', width: '610px', height: '120px' });
    ui.hudContainer.appendChild(host);
    const centred = win.document.createElement('div');
    centred.dataset.dockPanel = 'trade';
    Object.assign(centred.style, { position: 'absolute', left: '50%', marginLeft: '-305px', bottom: '80px', width: '610px', height: '120px' });
    ui.hudContainer.appendChild(centred);
    ui.persistFloatyWindowGeometry(6, { x: 900, y: 700, w: 610, h: 120 });
    win.happyDOM.setWindowSize({ width: 1000, height: 700 });
    try {
      ui.reclampFloatyWindowsToScreen();
      expect(pos(host)).toEqual({ x: 1000 - 610, y: 700 - 120 });
      expect(centred.style.left).toBe('50%');
    } finally {
      win.happyDOM.setWindowSize({ width: W, height: H });
    }
    ui.reclampFloatyWindowsToScreen();
    expect(pos(host)).toEqual({ x: 900, y: 700 });
    host.remove(); centred.remove();
  });
});

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);
// LayoutRenderer.renderPanel clamps on the next frame.
const DAT_DOM_GLOBALS = [...DOM_GLOBALS, 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe.skipIf(!hasDats)('examine window position (real GameUI + real LayoutRenderer over the EoL DATs)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let win: any;
  const W = 1600, H = 900;

  beforeAll(async () => {
    win = await loadDomWindow({ innerWidth: W, innerHeight: H });
    installDomGlobals(win, DAT_DOM_GLOBALS as never, saved, 'animationFrame');
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    win.document.body.innerHTML = '';
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.setChatHistoryScope('acct24dat', 'Mover');
    ui.showGame();
  });
  afterAll(() => { restoreDomGlobals(DAT_DOM_GLOBALS as never, saved); });

  it('the DAT top Dragbar 0x1000067c (type 2) and the title strip 0x1000012d both move it, and the next examine keeps it', () => {
    ui.showExaminationWindow(itemView());
    const h = ui.examinePanelHandle;
    expect(h.descs.get(0x1000067c)?.type).toBe(2);
    expect(h.elements.get(E.title)).toBeTruthy();
    const start = pos(ui.examinePanel);
    drag(win, h.elements.get(E.title), -(start.x - 100), -(start.y - 50));
    expect(pos(ui.examinePanel)).toEqual({ x: 100, y: 50 });
    ui.hideExaminePanel();
    ui.showExaminationWindow(itemView(0x80000f55, 'Practice Wand'));
    expect(pos(ui.examinePanel)).toEqual({ x: 100, y: 50 });
    drag(win, ui.examinePanelHandle.elements.get(0x1000067c), 20, 10);
    expect(pos(ui.examinePanel)).toEqual({ x: 120, y: 60 });
    ui.hideExaminePanel();
    ui.showExaminationWindow(itemView());
    expect(pos(ui.examinePanel)).toEqual({ x: 120, y: 60 });
    // What the placement reads is the persisted WindowID 7 rect.
    expect(examinationWindowPlacement(ui.getFloatyWindowGeometry(E.windowId), W, H)).toMatchObject({ x: 120, y: 60 });
  });

  it('a later session (fresh module from the server blob) opens it at the saved spot', () => {
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(E.windowId)).toMatchObject({ x: 120, y: 60 });
    // A different character's local fallback is empty; the server copy alone restores it.
    ui.setChatHistoryScope('acct24dat', 'OtherSession');
    ui.setServerChatWindowOptions(data);
    ui.hideExaminePanel();
    ui.showExaminationWindow(itemView());
    expect(pos(ui.examinePanel)).toEqual({ x: 120, y: 60 });
  });
});
