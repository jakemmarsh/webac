/**
 * FAITHFUL.432 — optionsSettings persist across sessions via
 *  localStorage.
 *
 * Pre-fix the optionsSettings dict (showHelm, showCloak, autoTarget,
 * repeatAttacks, sidestepAuto, runAsDefault, vivifyColors,
 * disableWeather, renderDistance, masterVolume, musicVolume,
 * effectsVolume, etc.) reset to local defaults every launch. ACE
 * persists the server-side subset via the CharacterOptions1/2 round-
 * trip (FAITHFUL.372), but until the PlayerDescription
 * CharacterOptions1/2 parse is wired, even server-persisted options
 * default at login. Pure client-only options (volumes, render
 * distance, sidestepAuto, showNames) never get a server round-trip
 * and so always reset.
 *
 * Sibling of FAITHFUL.430 (chatFilters) + FAITHFUL.431 (notell/chat
 * toggles).
 *
 * Stored under `ac_options_settings_v1` as the full JSON-serialized
 * Record<string, boolean | number | string>. Init reads it, deep-
 * merges over DEFAULTS, type-checks each key's value against the
 * default's typeof to reject corrupted entries.
 *
 * `GameUI.optionsSettings` is a public field initialized synchronously
 * from `localStorage` at construction time, and `saveOptionsSettings()`
 * is a public method — both callable without a DAT-backed
 * LayoutRenderer, so the restore/merge/type-guard/save behavior is
 * driven directly against real code below. The individual click-handler
 * mutation sites (addToggleRow, combat-bar repeatAttacks/autoTarget)
 * live inside the DAT-driven options render; the first describe drives
 * the real toggle-row click and reads the persisted blob back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('Mutation sites call saveOptionsSettings (FAITHFUL.432, behavioural — real addToggleRow click)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    const win = H.win;
    const renderPanel = (_layoutId: number, parent: HTMLElement) => {
      const wrapper = win.document.createElement('div');
      parent.appendChild(wrapper);
      const root = win.document.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        let el = get(id);
        if (!el) { el = win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root, elements,
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, close: () => { wrapper.remove(); },
      };
    };
    H.ui.layoutRenderer = { renderPanel, render: renderPanel, setFontResolver: () => {} };
  });
  afterAll(() => H.teardown());

  it('clicking an options toggle row flips the key and persists it to ac_options_settings_v1', () => {
    H.ui.optionsTab = 'character';
    H.ui.toggleOptionsPanel();
    const row = H.ui.optionsPanel.querySelector('.option-toggle-row[data-option-key="showHelm"]') as HTMLElement;
    expect(row).not.toBeNull();
    const before = !!H.ui.optionsSettings.showHelm;
    row.dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(H.ui.optionsSettings.showHelm).toBe(!before);
    expect(JSON.parse(H.win.localStorage.getItem('ac_options_settings_v1')).showHelm).toBe(!before);
  });

  // CORE.11 — the combat-bar repeatAttacks/autoTarget inline mutation sites
  // were replaced by bindCombatBarCheckbox; the click→persist behavior is
  // driven for real in verify-core11-combat-bar.ts (localStorage assertion
  // after a dispatched click).
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.432 — optionsSettings restore + save (behavioral, requires happy-dom devDep)', () => {
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

  // CORE.17.h.g.a — a fresh profile is OPTIONS_DEFAULTS with the few keys
  // GameUI.FRESH_PROFILE_OVERRIDES deliberately seeds differently from the
  // retail Defaults-button value (none since CORE.17.h.g.a.a set the draw distance to retail's 8).
  const FRESH = () => ({ ...GameUICtor.OPTIONS_DEFAULTS, ...GameUICtor.FRESH_PROFILE_OVERRIDES });

  it('with no persisted storage, optionsSettings equals GameUI.OPTIONS_DEFAULTS + the fresh-profile overrides', () => {
    domWindow.localStorage.clear();
    const ui = freshUI();
    expect(ui.optionsSettings).toEqual(FRESH());
    expect(ui.optionsSettings.landscapeDrawDistance).toBe(8);
    expect(GameUICtor.OPTIONS_DEFAULTS.landscapeDrawDistance).toBe(8);
  });

  it('restores a persisted value, merged over the remaining defaults', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ showHelm: false }));
    const ui = freshUI();
    expect(ui.optionsSettings.showHelm).toBe(false);
    // every other key still comes from DEFAULTS (+ the fresh-profile overrides)
    for (const [k, v] of Object.entries(FRESH())) {
      if (k === 'showHelm') continue;
      expect(ui.optionsSettings[k]).toEqual(v);
    }
  });

  it('drops a stored key whose value type does not match the default type', () => {
    domWindow.localStorage.clear();
    // effectsVolume's default is a number — a string value must be rejected.
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ effectsVolume: 'loud' }));
    const ui = freshUI();
    expect(ui.optionsSettings.effectsVolume).toBe(GameUICtor.OPTIONS_DEFAULTS.effectsVolume);
  });

  it('ignores a stored key that is not a recognized option', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ notARealOption: true }));
    const ui = freshUI();
    expect(ui.optionsSettings).not.toHaveProperty('notARealOption');
    expect(ui.optionsSettings).toEqual(FRESH());
  });

  it('drops corrupted JSON silently and falls back to defaults without throwing', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', 'not valid json {{{');
    expect(() => freshUI()).not.toThrow();
    const ui = freshUI();
    expect(ui.optionsSettings).toEqual(FRESH());
  });

  it('saveOptionsSettings() writes JSON.stringify(optionsSettings) to ac_options_settings_v1', () => {
    domWindow.localStorage.clear();
    const ui = freshUI();
    ui.optionsSettings.showHelm = false;
    ui.saveOptionsSettings();
    expect(domWindow.localStorage.getItem('ac_options_settings_v1')).toBe(JSON.stringify(ui.optionsSettings));
  });

  it('saveOptionsSettings() swallows a localStorage.setItem failure (quota/disabled) without throwing', () => {
    domWindow.localStorage.clear();
    const ui = freshUI();
    const original = domWindow.localStorage.setItem;
    domWindow.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      expect(() => ui.saveOptionsSettings()).not.toThrow();
    } finally {
      domWindow.localStorage.setItem = original;
    }
  });
});
