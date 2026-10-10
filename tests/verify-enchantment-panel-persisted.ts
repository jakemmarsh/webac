/**
 * FAITHFUL.450 — the effects windows persist their visibility.
 *
 *  FAITHFUL.444 added auto-save/restore for the toolbar panels; the
 *  "Active Spells" panel opened from the status indicator strip, not the
 *  toolbar, so its toggle had to persist itself.
 *
 *  GAP.indicator-bar-interactive replaced that single improvised panel with
 *  retail's two gmEffectsUI windows (0x2100001b:0x1000011f "Beneficial
 *  Spells in Effect" / 0x10000121 "Harmful Spells in Effect"), so the state
 *  now carries `positiveEffectsVisible` + `negativeEffectsVisible`. A saved
 *  state from before carries only `enchantmentPanelVisible`, which restores
 *  as the positive window (the old panel opened from the beneficial side,
 *  and `toggleEnchantmentPanel` stays the positive toggle).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.450 — effects window persistence (requires happy-dom devDep)', () => {
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
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }
  const stored = () => JSON.parse(domWindow.localStorage.getItem('ac_ui_state'));

  it('getUIState reports both windows; each toggle flips + persists its own key', () => {
    domWindow.localStorage.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();

    expect(ui.getUIState()).toMatchObject({ positiveEffectsVisible: false, negativeEffectsVisible: false });

    ui.togglePositiveEffectsPanel();
    expect(ui.getUIState().positiveEffectsVisible).toBe(true);
    expect(stored()).toMatchObject({ positiveEffectsVisible: true, negativeEffectsVisible: false });

    ui.togglePositiveEffectsPanel();
    expect(stored()).toMatchObject({ positiveEffectsVisible: false, negativeEffectsVisible: false });

    ui.toggleNegativeEffectsPanel();
    expect(stored()).toMatchObject({ positiveEffectsVisible: false, negativeEffectsVisible: true });
    ui.toggleNegativeEffectsPanel();
    expect(stored()).toMatchObject({ positiveEffectsVisible: false, negativeEffectsVisible: false });
  });

  it('toggleEnchantmentPanel is the positive window (the indicator strip / main.ts keybind alias)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    ui.toggleEnchantmentPanel();
    expect(ui.isEffectsPanelVisible('positive')).toBe(true);
    expect(ui.isEffectsPanelVisible('negative')).toBe(false);
    ui.toggleEnchantmentPanel();
    expect(ui.isEffectsPanelVisible('positive')).toBe(false);
  });

  it('setUIState drives the windows (restore path), no-op when already there', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    ui.setUIState({ negativeEffectsVisible: true });
    expect(ui.getUIState()).toMatchObject({ positiveEffectsVisible: false, negativeEffectsVisible: true });
    ui.setUIState({ negativeEffectsVisible: true });
    expect(ui.getUIState().negativeEffectsVisible).toBe(true);
    ui.setUIState({ negativeEffectsVisible: false });
    expect(ui.getUIState().negativeEffectsVisible).toBe(false);
  });

  it('a pre-split saved state ({ enchantmentPanelVisible: true }) restores the positive window', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    domWindow.localStorage.setItem('ac_ui_state', JSON.stringify({ enchantmentPanelVisible: true }));
    expect(ui.restoreUIState()).toBe(true);
    expect(ui.getUIState()).toMatchObject({ positiveEffectsVisible: true, negativeEffectsVisible: false });
    // Re-saved in the new shape.
    expect(stored()).toMatchObject({ positiveEffectsVisible: true, negativeEffectsVisible: false });
    expect(stored().enchantmentPanelVisible).toBeUndefined();
    ui.togglePositiveEffectsPanel(); // close — stops the 1 s duration tick
  });
});
