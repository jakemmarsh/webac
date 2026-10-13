/**
 * VISUAL.examine-panel-layout-2100001c — GameUI.showExaminationWindow drives
 * the EoL floaty examination layout 0x2100006b (real GameUI in happy-dom,
 * a recording layout renderer):
 *  - one page visible (SetActiveExamineUI @ 004ab420), the title set;
 *  - the item page's appraisal lines in the body 0x1000013c; the inscription
 *    hidden for a non-inscribable item (SetInscription @ 004ae2f0);
 *  - RecvNotice_SelectionChanged @ 004ab3d0: a new selection re-examines, a
 *    cleared one closes the window;
 *  - UseTime @ 004ab530: outside peace mode a creature page re-appraises
 *    every 0.75 s, an item page never does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EXAMINATION_WINDOW } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1600, innerHeight: 900 });
} catch { /* skip */ }
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe.skipIf(!domWindow)('GameUI.showExaminationWindow (real GameUI in happy-dom)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();
  const visible = new Map<number, boolean>();
  let rendered: { layout: number; subtree?: number } | null = null;
  let lastElements: Map<number, HTMLElement> = new Map();

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const handleFor = (layout: number, parent: HTMLElement, opts: { subtreeElementId?: number; onClose?: () => void } = {}) => {
      rendered = { layout, subtree: opts.subtreeElementId };
      const wrapper = domWindow.document.createElement('div');
      const root = domWindow.document.createElement('div');
      wrapper.appendChild(root); parent.appendChild(wrapper);
      const elements = new Map<number, HTMLElement>();
      lastElements = elements;
      const el = (id: number) => { if (!elements.has(id)) { const d = domWindow.document.createElement('div'); root.appendChild(d); elements.set(id, d); } return elements.get(id)!; };
      [0x1000012e, 0x10000140, 0x10000153, 0x1000013c, 0x1000013d, 0x10000137, 0x1000013e, 0x1000046e, 0x1000013f, 0x10000149, 0x10000335, 0x10000148].forEach(el);
      return {
        root, layout: {}, elements, descs: new Map([[0x1000013c, { width: 280, height: 286 }], [0x1000013e, { width: 276, height: 57 }]]),
        setText: (id: number, t: string) => { texts.set(id, t); },
        setVisible: (id: number, v: boolean) => { visible.set(id, v); },
        setFill() {}, setState() {}, setPalette() {}, setInteractive() {}, setScrollable() { return {}; }, setDraggable() {}, setDropTarget() {},
        close: () => { wrapper.remove(); },
      };
    };
    ui.layoutRenderer = { renderPanel: handleFor, render: handleFor };
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const itemView = (guid = 0x800009e4) => ({
    guid, title: 'Apple', page: 'item',
    item: { value: '', burden: '', runs: [], text: '', paragraphs: [], lines: [{ text: 'Value: 7', color: 0 }, { text: 'Burden: 50', color: 0 }, { text: '', color: 0 }, { text: 'Use this item to eat it.', color: 0 }] },
    inscription: { visible: false, text: '', signature: '' },
  });

  it('renders the floaty examination window: item page only, the title, the appraisal lines, no inscription', () => {
    ui.showExaminationWindow(itemView());
    expect(rendered).toEqual({ layout: EXAMINATION_WINDOW.layout, subtree: EXAMINATION_WINDOW.root });
    expect(texts.get(EXAMINATION_WINDOW.title)).toBe('Apple');
    expect(visible.get(0x1000012e)).toBe(true);
    expect(visible.get(0x10000140)).toBe(false);
    expect(visible.get(0x10000153)).toBe(false);
    expect(visible.get(EXAMINATION_WINDOW.item.inscription)).toBe(false);
    const body = domWindow.document.querySelector('[data-examine-body]');
    expect(body).toBeTruthy();
    expect(body.children[0].children.length).toBe(4);
  });

  // The inscription 0x1000013e (276x57 on 0x2100006b, p30 = 300 characters)
  // wraps at its width like UIElement_Text and scrolls under its p114 bar
  // 0x1000046e (p121 = true). setText drew one unwrapped line off its edge.
  it('a long inscription wraps at the element width and scrolls under its DAT bar 0x1000046e, not a native one', () => {
    const savedFont = ui.loadFontRenderer;
    const savedDesc = ui.datDescFor;
    ui.datDescFor = (ref: string) => (ref.endsWith('1000013e') ? { width: 276, height: 57 } : savedDesc.call(ui, ref));
    // 10 px glyphs, 18 px lines.
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 18, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => domWindow.document.createElement('canvas'),
      renderWrappedTextToCanvas: () => domWindow.document.createElement('canvas'),
    });
    try {
      const long = 'This blade was forged in the fires of the Direlands and carried by my father before me';
      ui.showExaminationWindow({ ...itemView(), inscription: { visible: true, text: long, signature: '--Asheron', scribe: 'Asheron', inscription: long } });
      const el = lastElements.get(EXAMINATION_WINDOW.item.inscription)!;
      const cell = el.querySelector('.ac-dat-text-element') as HTMLElement;
      expect(cell).toBeTruthy();
      expect(Number(cell.dataset.acLines)).toBeGreaterThan(1);
      expect(el.style.getPropertyValue('scrollbar-width')).toBe('none');
      expect(el.style.overflowY).toBe('auto');
      const bar = lastElements.get(EXAMINATION_WINDOW.item.inscriptionScrollbar)!;
      expect(bar.querySelector('[data-dat-scroll-btn="down"]')).toBeTruthy();
      // It takes the wheel (a pointer target), and its clicks are the block 0x10000137's.
      expect(el.style.pointerEvents).toBe('auto');
      let blockClicks = 0;
      lastElements.get(EXAMINATION_WINDOW.item.inscriptionBlock)!.addEventListener('click', () => { blockClicks++; });
      el.click();
      expect(blockClicks).toBe(1);
    } finally {
      ui.loadFontRenderer = savedFont;
      ui.datDescFor = savedDesc;
    }
  });

  it('a touchpad swipe over the appraisal text scrolls it by its pixels; a mouse notch by one step', () => {
    ui.showExaminationWindow(itemView());
    const body = domWindow.document.querySelector('[data-examine-body]');
    Object.defineProperty(body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 286, configurable: true });
    body.scrollTop = 0;
    body.dispatchEvent(new domWindow.WheelEvent('wheel', { deltaY: 7, deltaMode: 0, bubbles: true, cancelable: true }));
    expect(body.scrollTop).toBe(7);
    body.dispatchEvent(new domWindow.WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
    expect(body.scrollTop).toBe(7 + (ui.fontRenderer?.lineHeight ?? 14));
    // …and it is a pointer target (DAT text elements are pointer-events:none).
    expect(body.style.pointerEvents).toBe('auto');
  });

  it('follows the selection while open, and closes when it is cleared', () => {
    const asked: number[] = [];
    ui.onExamineSelection = (g: number) => asked.push(g);
    ui.uiManager.setScreen('game');
    ui.hud.setTarget({ id: 0x800009e4, name: 'Apple', level: 0, healthFraction: 0, distance: 0, type: 'item' });
    ui.showExaminationWindow(itemView());
    ui.updateHUD();
    expect(asked).toEqual([]);
    ui.hud.setTarget({ id: 0x80000f55, name: 'Practice Wand', level: 0, healthFraction: 0, distance: 0, type: 'item' });
    ui.updateHUD();
    expect(asked).toEqual([0x80000f55]);
    ui.hud.target = null;
    ui.updateHUD();
    expect(ui.examinePanelHandle).toBeNull();
  });

  it('UseTime: a creature page re-appraises every 0.75 s outside peace mode; an item page never', () => {
    ui.showExaminationWindow({ guid: 0x80001ca1, title: 'Drudge Skulker', page: 'creature', creature: { page: 'creature', headerPanel: 0x1000014d, level: '8', stats: [], miscInfo: [], creatureDisplayName: 'Drudge', allegianceName: '' } });
    expect(ui.examineUseTime(100, true)).toBe(0);
    expect(ui.examineUseTime(100, false)).toBe(0x80001ca1);
    expect(ui.examineUseTime(100.5, false)).toBe(0);
    expect(ui.examineUseTime(100.8, false)).toBe(0x80001ca1);
    ui.showExaminationWindow(itemView());
    expect(ui.examineUseTime(200, false)).toBe(0);
  });

  const drudge = (level: string) => ({ guid: 0x80001ca1, title: 'Drudge Skulker', page: 'creature', creature: { page: 'creature', headerPanel: 0x1000014d, level, stats: [], miscInfo: [], creatureDisplayName: 'Drudge', allegianceName: '' } });

  it('a re-appraisal refills the open creature page in place: same window, same close button', () => {
    ui.showExaminationWindow(drudge('8'));
    const handle = ui.examinePanelHandle;
    const wrapper = ui.examinePanel;
    expect(ui.refreshExaminationWindow(drudge('9'))).toBe(true);
    expect(ui.examinePanelHandle).toBe(handle);
    expect(ui.examinePanel).toBe(wrapper);
    expect(wrapper.isConnected).toBe(true);
    expect(texts.get(0x1000014c)).toBe('9');
  });

  it('a re-appraisal landing after the close button does not reopen the window', () => {
    ui.showExaminationWindow(drudge('8'));
    ui.hideExaminePanel();
    rendered = null;
    expect(ui.refreshExaminationWindow(drudge('9'))).toBe(false);
    expect(ui.examinePanelHandle).toBeNull();
    expect(rendered).toBeNull();
    expect(ui.examinedGuid).toBeNull();
  });

  it('a reply for another object does not replace the open window', () => {
    ui.showExaminationWindow(drudge('8'));
    const handle = ui.examinePanelHandle;
    expect(ui.refreshExaminationWindow(itemView())).toBe(false);
    expect(ui.examinePanelHandle).toBe(handle);
    expect(ui.examinedGuid).toBe(0x80001ca1);
  });
});
