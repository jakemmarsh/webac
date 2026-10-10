/**
 * FAITHFUL.449 — Combat-bar power slider + attack-height button
 *  persist across sessions.
 *
 *  Pre-fix `combatPowerLevel` (0..1) and `combatAttackHeight`
 *  ('high'|'medium'|'low') were private fields with hardcoded
 *  defaults 0.5 / 'medium'. Every login reset to the defaults so a
 *  melee build's "Power 100% + High" stance was lost each session.
 *
 *  Neither value has a CharacterOption mapping (they're not yes/no
 *  bits), so the natural persistence path is the FAITHFUL.432
 *  optionsSettings → ac_options_settings_v1 localStorage dict that
 *  already round-trips other client-only state (volume sliders,
 *  toggles).
 *
 *  Closed by:
 *   - Adding `combatPowerLevel: 0.5` and `combatAttackHeight: 'medium'`
 *     to optionsSettings DEFAULTS.
 *   - Initializing the private fields from optionsSettings at
 *     class-field-evaluation time (with type guards).
 *   - Updating both write sites (slider drag, height button click)
 *     to also write optionsSettings + saveOptionsSettings.
 *
 *  DEBT.test-harness-hygiene: the two write sites (slider drag, height
 *  button click) are driven for real — renderCombatBar runs against a stub
 *  layoutRenderer and the test dispatches the mousedown / click events. The
 *  DEFAULTS entries and the field-initializer restore behavior run against
 *  `GameUI.OPTIONS_DEFAULTS` and a real `GameUI` instance's public
 *  `getCombatPowerLevel()`/`getCombatAttackHeight()` getters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { CombatMode } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.449 — write-back sites persist on change (behavioural)', () => {
  let H: GameUIFixture;
  let elements: Map<number, HTMLElement>;

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    // Stub LayoutRenderer for layout 0x21000007: every element id the combat
    // bar asks for exists as a plain div.
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = doc.createElement('div') as HTMLElement;
      parent.appendChild(root);
      elements = new Map<number, HTMLElement>();
      const get = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = doc.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root, elements: { get, set: () => {} }, descs: new Map(),
        setText: () => {}, setState: () => {}, setVisible: () => {}, setInteractive: () => {},
        close: () => root.remove(), destroy: () => root.remove(),
      };
    };
    H.ui.layoutRenderer = { render: makeHandle, renderPanel: makeHandle };
    H.ui.hud.combatMode = CombatMode.Melee;
  }, 60_000);
  afterAll(() => H.teardown());

  const persisted = (): Record<string, unknown> =>
    JSON.parse(H.win.localStorage.getItem('ac_options_settings_v1') ?? '{}');

  it('dragging the power slider writes combatPowerLevel to optionsSettings and localStorage', () => {
    H.ui.renderCombatBar();
    const slider = elements.get(0x1000004f)!;
    slider.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 10, right: 300, bottom: 10, x: 100, y: 0, toJSON() {} }) as DOMRect;
    slider.dispatchEvent(new H.win.MouseEvent('mousedown', { clientX: 250, bubbles: true, cancelable: true }));
    expect(H.ui.getCombatPowerLevel()).toBe(0.75);
    expect(H.ui.optionsSettings.combatPowerLevel).toBe(0.75);
    expect(persisted().combatPowerLevel).toBe(0.75);
    // Drag continues through window mousemove until mouseup.
    H.win.dispatchEvent(new H.win.MouseEvent('mousemove', { clientX: 150 }));
    expect(persisted().combatPowerLevel).toBe(0.25);
    H.win.dispatchEvent(new H.win.MouseEvent('mouseup', {}));
    H.win.dispatchEvent(new H.win.MouseEvent('mousemove', { clientX: 300 }));
    expect(persisted().combatPowerLevel).toBe(0.25);
  });

  it('clicking an attack-height button writes combatAttackHeight to optionsSettings and localStorage', () => {
    H.ui.renderCombatBar();
    elements.get(0x10000057)!.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));  // High
    expect(H.ui.getCombatAttackHeight()).toBe('high');
    expect(persisted().combatAttackHeight).toBe('high');
    elements.get(0x10000059)!.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));  // Low (re-rendered bar)
    expect(persisted().combatAttackHeight).toBe('low');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.449 — combatPowerLevel/combatAttackHeight default + restore (behavioral, requires happy-dom devDep)', () => {
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

  it('GameUI.OPTIONS_DEFAULTS.combatPowerLevel is 0.5', () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.combatPowerLevel).toBe(0.5);
  });

  it("GameUI.OPTIONS_DEFAULTS.combatAttackHeight is 'medium'", () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.combatAttackHeight).toBe('medium');
  });

  it('a fresh instance (no persisted state) starts at power 0.5 / height medium', () => {
    domWindow.localStorage.clear();
    const ui = freshUI();
    expect(ui.getCombatPowerLevel()).toBe(0.5);
    expect(ui.getCombatAttackHeight()).toBe('medium');
  });

  it.each([0, 0.25, 0.75, 1])('constructor restores a persisted combatPowerLevel of %f', (power) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ combatPowerLevel: power }));
    const ui = freshUI();
    expect(ui.getCombatPowerLevel()).toBe(power);
  });

  it.each([-5, 1.5])('constructor clamps an out-of-range persisted combatPowerLevel of %f into [0, 1]', (power) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ combatPowerLevel: power }));
    const ui = freshUI();
    expect(ui.getCombatPowerLevel()).toBe(Math.max(0, Math.min(1, power)));
  });

  it('constructor treats a non-number persisted combatPowerLevel as unrecognized and falls back to 0.5', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ combatPowerLevel: '1' }));
    const ui = freshUI();
    expect(ui.getCombatPowerLevel()).toBe(0.5);
  });

  it.each(['high', 'medium', 'low'])('constructor restores a persisted combatAttackHeight of %s', (height) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ combatAttackHeight: height }));
    const ui = freshUI();
    expect(ui.getCombatAttackHeight()).toBe(height);
  });

  it("constructor treats an unrecognized persisted combatAttackHeight as unrecognized and falls back to 'medium'", () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ combatAttackHeight: 'extreme' }));
    const ui = freshUI();
    expect(ui.getCombatAttackHeight()).toBe('medium');
  });
});
