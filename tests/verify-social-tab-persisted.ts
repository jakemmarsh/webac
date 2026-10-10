/**
 * FAITHFUL.455 — socialTab persists across sessions.
 *
 *  Sibling of FAITHFUL.452-454. Pre-fix the Social panel's sub-tab
 *  ('fellowship'|'allegiance'|'friends') reset to 'fellowship' every
 *  login. A player who used the Friends or Allegiance tab couldn't
 *  return to that tab directly each session.
 *
 *  The tab-click write site lives inside the DAT-driven render method's
 *  click closure; a recording LayoutRenderer stand-in captures that real
 *  closure so the click is driven behaviourally, alongside the default +
 *  constructor-restore checks against a real `GameUI` instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';


/** A LayoutRenderer stand-in that auto-creates any element id asked for and
 *  records handle.onClick handlers, so the DAT-driven tab strip's real click
 *  closure can be invoked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recordingLayoutRenderer(win: any) {
  const clicks = new Map<number, () => void>();
  const renderPanel = (_layoutId: number, parent: HTMLElement) => {
    // The real renderer wraps the panel root in a positioned wrapper (callers
    // take handle.root.parentElement as the panel), so mirror that.
    const wrapper = win.document.createElement('div');
    parent.appendChild(wrapper);
    const root = win.document.createElement('div');
    wrapper.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = win.document.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    return {
      root, elements,
      setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
      setTexture: () => {}, close: () => { wrapper.remove(); },
      onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
    };
  };
  return { clicks, renderer: { renderPanel, render: renderPanel, setFontResolver: () => {} } };
}

describe('FAITHFUL.455 — tab click persists socialTab (behavioural, real renderSocialPanel click closure)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it.each(['allegiance', 'friends', 'fellowship'] as const)('clicking the %s tab writes optionsSettings.socialTab and persists it', (tab) => {
    const rec = recordingLayoutRenderer(H.win);
    H.ui.layoutRenderer = rec.renderer;
    H.ui.socialTab = tab === 'fellowship' ? 'friends' : 'fellowship';
    H.ui.toggleSocialPanel();
    try {
      const tabEl = H.win.document.querySelector(`[data-social-tab="${tab}"]`) as HTMLElement;
      expect(tabEl).not.toBeNull();
      const click = rec.clicks.get(parseInt(tabEl.dataset.elementId!, 16));
      expect(click).toBeTypeOf('function');
      click!();
      expect(H.ui.socialTab).toBe(tab);
      expect(H.ui.optionsSettings.socialTab).toBe(tab);
      expect(JSON.parse(H.win.localStorage.getItem('ac_options_settings_v1')).socialTab).toBe(tab);
    } finally {
      if (H.ui.socialPanelVisible) H.ui.toggleSocialPanel();
    }
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.455 — socialTab default + restore (behavioral, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function freshUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it("GameUI.OPTIONS_DEFAULTS.socialTab is 'fellowship'", () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.socialTab).toBe('fellowship');
  });

  it("a fresh instance (no persisted state) starts on 'fellowship'", () => {
    domWindow.localStorage.clear();
    const ui: any = freshUI();
    expect(ui.socialTab).toBe('fellowship');
  });

  it.each(['fellowship', 'allegiance', 'friends'])('constructor restores a persisted socialTab of %s', (tab) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ socialTab: tab }));
    const ui: any = freshUI();
    expect(ui.socialTab).toBe(tab);
  });

  it("constructor does NOT restore a persisted 'squelch' socialTab (not in the 3-value restore guard) and keeps the default", () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ socialTab: 'squelch' }));
    const ui: any = freshUI();
    expect(ui.socialTab).toBe('fellowship');
  });
});
