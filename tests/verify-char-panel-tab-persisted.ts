/**
 * FAITHFUL.456 — charPanelTab persists across sessions.
 *
 *  Sibling of FAITHFUL.452-455. Pre-fix the Character panel's sub-tab
 *  ('attributes'|'skills'|'titles') reset to 'attributes' every
 *  login. A player who used the Skills or Titles tab couldn't return
 *  directly each session.
 *
 *  The tab-click write site lives inline inside a DAT-driven render
 *  method's click-listener closure with no exported test seam, so it
 *  stays a source citation below; the default + constructor-restore
 *  behavior is independently testable via `GameUI.OPTIONS_DEFAULTS`
 *  and a real `GameUI` instance, so those run against real code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.456 — charPanelTab default + restore (behavioral, requires happy-dom devDep)', () => {
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

  it("GameUI.OPTIONS_DEFAULTS.charPanelTab is 'attributes'", () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.charPanelTab).toBe('attributes');
  });

  it("a fresh instance (no persisted state) starts on 'attributes'", () => {
    domWindow.localStorage.clear();
    const ui: any = freshUI();
    expect(ui.charPanelTab).toBe('attributes');
  });

  it.each(['attributes', 'skills', 'titles'])('constructor restores a persisted charPanelTab of %s', (tab) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ charPanelTab: tab }));
    const ui: any = freshUI();
    expect(ui.charPanelTab).toBe(tab);
  });

  it('constructor ignores an unrecognized persisted charPanelTab and keeps the default', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ charPanelTab: 'inventory' }));
    const ui: any = freshUI();
    expect(ui.charPanelTab).toBe('attributes');
  });
});

describe('FAITHFUL.456 — tab click writes optionsSettings + persists (behavioural, real renderCharPanel)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => { installDomGlobals(domWindow, DOM_GLOBALS, saved); });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  it('clicking the Skills / Titles tab buttons (0x10000229 / 0x10000538) sets charPanelTab and saves it to ac_options_settings_v1', async () => {
    domWindow.localStorage.clear();
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container);
    ui.getTexURL = () => null;
    const handles = new Map<number, { elements: Map<number, HTMLElement> }>();
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const els = new Map<number, HTMLElement>();
      const elements = {
        get: (id: number) => {
          let el = els.get(id);
          if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); els.set(id, el); }
          return el;
        },
        set: () => {},
      } as unknown as Map<number, HTMLElement>;
      const h = {
        root, elements, descs: new Map(),
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
        onClick: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => root.remove(), destroy: () => root.remove(),
      };
      handles.set(layoutId, h);
      return h;
    };
    ui.layoutRenderer = {
      renderPanel: (id: number, parent: HTMLElement) => makeHandle(id, parent),
      render: (id: number, parent: HTMLElement) => makeHandle(id, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.renderCharPanel();
    const tabBtn = (id: number): HTMLElement => {
      for (const h of handles.values()) {
        const el = (h.elements as unknown as { get(id: number): HTMLElement }).get(id);
        if (el.isConnected && el.style.cursor === 'pointer') return el;
      }
      throw new Error(`tab button 0x${id.toString(16)} not wired`);
    };
    tabBtn(0x10000229).click();
    expect(ui.charPanelTab).toBe('skills');
    expect(ui.optionsSettings.charPanelTab).toBe('skills');
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).charPanelTab).toBe('skills');
    tabBtn(0x10000538).click();
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).charPanelTab).toBe('titles');
  });
});

