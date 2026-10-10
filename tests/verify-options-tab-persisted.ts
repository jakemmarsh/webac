/**
 * FAITHFUL.457 — optionsTab persists across sessions.
 *
 *  Sibling of FAITHFUL.452-456. Pre-fix the Options panel's sub-tab
 *  reset every login. A player auditing one tab had to re-click it
 *  each session. (VISUAL.22 later replaced the invented tab set with
 *  the real DAT set: 'gameplay'|'character'|'chat'|'config'.)
 *
 *  The tab-click write site is driven through the real renderOptionsPanel's
 *  DAT tab handlers; the default + constructor-restore behavior runs via
 *  `GameUI.OPTIONS_DEFAULTS` and a real `GameUI` instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';

// Options panel 0x2100002b element ids renderOptionsPanel touches (same set
// as verify-options-panel-behavioral.ts).
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];
const TAB_IDS = { gameplay: 0x1000020d, character: 0x1000020e, chat: 0x1000050b, config: 0x1000020f } as const;

// DEBT.test-harness-hygiene: the tab click write site is now driven
// behaviourally — the real renderOptionsPanel wires handle.onClick for each
// DAT tab element; the double records those handlers and the test fires them.
describe('FAITHFUL.457 — tab click writes optionsSettings + persists (behavioural)', () => {
  let H: GameUIFixture;
  let clicks = new Map<number, () => void>();
  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = doc.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        clicks = new Map();
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
          close: () => { root.remove(); },
        };
      },
      render: stubLayoutRender(H.win.document),
    };
    if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
  });
  afterAll(() => H.teardown());

  it.each(['character', 'chat', 'config', 'gameplay'] as const)('clicking the %s tab switches to it and persists it', (tab) => {
    clicks.get(TAB_IDS[tab])!();
    expect(H.ui.optionsTab).toBe(tab);
    expect(H.ui.optionsSettings.optionsTab).toBe(tab);
    expect(JSON.parse(H.win.localStorage.getItem('ac_options_settings_v1')!).optionsTab).toBe(tab);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.457 — optionsTab default + restore (behavioral, requires happy-dom devDep)', () => {
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

  it("GameUI.OPTIONS_DEFAULTS.optionsTab is 'gameplay' (VISUAL.22 real DAT default tab)", () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.optionsTab).toBe('gameplay');
  });

  it("a fresh instance (no persisted state) starts on 'gameplay'", () => {
    domWindow.localStorage.clear();
    const ui: any = freshUI();
    expect(ui.optionsTab).toBe('gameplay');
  });

  it.each(['gameplay', 'character', 'chat', 'config'])('constructor restores a persisted optionsTab of %s', (tab) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ optionsTab: tab }));
    const ui: any = freshUI();
    expect(ui.optionsTab).toBe(tab);
  });

  it('constructor ignores an unrecognized persisted optionsTab and keeps the default', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ optionsTab: 'video' }));
    const ui: any = freshUI();
    expect(ui.optionsTab).toBe('gameplay');
  });
});
