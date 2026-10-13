/**
 * PanelPressGuard — a panel rebuild landing between a press and its release
 * swapped the button under the cursor and the click never fired (the examine
 * window's close X "took a few tries" while its 0.75 s re-appraisal and the
 * character panel's vital ticks rebuilt them). The guard holds the rebuild
 * until the click has run; a click that closed the panel makes it moot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PanelPressGuard } from '../packages/renderer/src/ui/PanelPressGuard.js';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1600, innerHeight: 900 });
} catch { /* skip */ }

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe.skipIf(!domWindow)('PanelPressGuard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  beforeAll(() => { doc = domWindow.document; });

  const press = (el: Element, type: string): void => { el.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true })); };

  it('runs a rebuild at once when no press is inside the panel', () => {
    const guard = new PanelPressGuard(doc);
    const panel = doc.createElement('div'); doc.body.appendChild(panel);
    const outside = doc.createElement('div'); doc.body.appendChild(outside);
    press(outside, 'pointerdown');
    expect(guard.defer(panel, () => undefined)).toBe(false);
    press(outside, 'pointerup');
    panel.remove(); outside.remove();
  });

  it('holds a rebuild during a press inside the panel and runs it once after the release', async () => {
    const guard = new PanelPressGuard(doc);
    const panel = doc.createElement('div'); doc.body.appendChild(panel);
    const button = doc.createElement('div'); panel.appendChild(button);
    let runs = 0;
    press(button, 'pointerdown');
    expect(guard.defer(panel, () => { runs++; })).toBe(true);
    expect(guard.defer(panel, () => { runs++; })).toBe(true);
    expect(runs).toBe(0);
    press(button, 'pointerup');
    expect(runs).toBe(0); // after the click, not inside the release
    await tick();
    expect(runs).toBe(1);
    panel.remove();
  });

  it('drops a held rebuild when the click closed the panel', async () => {
    const guard = new PanelPressGuard(doc);
    const panel = doc.createElement('div'); doc.body.appendChild(panel);
    const close = doc.createElement('div'); panel.appendChild(close);
    let runs = 0;
    press(close, 'pointerdown');
    guard.defer(panel, () => { runs++; });
    press(close, 'pointerup');
    panel.remove();
    await tick();
    expect(runs).toBe(0);
  });
});

/* The real GameUI: the examine window's close X still closes when a rebuild lands mid-press. */
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent'] as const;
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe.skipIf(!domWindow)('GameUI examine window: a rebuild during a press on its close X', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let renders = 0;
  const CLOSE = 0x100005f3;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // A panel whose close button behaves like LayoutRenderer.renderPanel's (a DOM click).
    const handleFor = (_layout: number, parent: HTMLElement, opts: { onClose?: () => void } = {}) => {
      renders++;
      const wrapper = domWindow.document.createElement('div');
      const root = domWindow.document.createElement('div');
      wrapper.appendChild(root); parent.appendChild(wrapper);
      const elements = new Map<number, HTMLElement>();
      const closeEl = domWindow.document.createElement('div');
      root.appendChild(closeEl); elements.set(CLOSE, closeEl);
      const h = {
        root, layout: {}, elements, descs: new Map(),
        setText() {}, setVisible() {}, setFill() {}, setState() {}, setPalette() {}, setInteractive() {}, setScrollable() { return {}; }, setDraggable() {}, setDropTarget() {},
        close: () => { wrapper.remove(); },
      };
      closeEl.addEventListener('click', () => { h.close(); opts.onClose?.(); });
      return h;
    };
    ui.layoutRenderer = { renderPanel: handleFor, render: handleFor };
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const spell = { guid: 0, title: 'Strength Self I', page: 'spell' as const, spell: { spellId: 1 } };

  it('a press, a rebuild, then the release: the click closes the window and the held rebuild does not reopen it', async () => {
    ui.showExaminationWindow({ guid: 0x80001ca1, title: 'Drudge Skulker', page: 'creature' });
    const closeEl: HTMLElement = ui.examinePanelHandle.elements.get(CLOSE);
    const before = renders;
    closeEl.dispatchEvent(new domWindow.PointerEvent('pointerdown', { bubbles: true }));
    // A rebuild lands mid-press (e.g. an inventory sync re-examining the spell page).
    ui.showExaminationWindow({ ...spell, guid: 0x80001ca1 });
    expect(renders).toBe(before);
    expect(ui.examinePanelHandle.elements.get(CLOSE)).toBe(closeEl);
    closeEl.dispatchEvent(new domWindow.PointerEvent('pointerup', { bubbles: true }));
    closeEl.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.examinePanelHandle).toBeNull();
    await tick();
    expect(ui.examinePanelHandle).toBeNull();
    expect(renders).toBe(before);
  });

  it('a press elsewhere in the window holds the rebuild until the release, then it runs', async () => {
    ui.showExaminationWindow({ guid: 0x80001ca1, title: 'Drudge Skulker', page: 'creature' });
    const root: HTMLElement = ui.examinePanelHandle.root;
    const before = renders;
    root.dispatchEvent(new domWindow.PointerEvent('pointerdown', { bubbles: true }));
    ui.showExaminationWindow({ guid: 0x80001ca2, title: 'Drudge Sneaker', page: 'creature' });
    expect(renders).toBe(before);
    root.dispatchEvent(new domWindow.PointerEvent('pointerup', { bubbles: true }));
    await tick();
    expect(renders).toBe(before + 1);
    expect(ui.examinedGuid).toBe(0x80001ca2);
    ui.hideExaminePanel();
  });
});
