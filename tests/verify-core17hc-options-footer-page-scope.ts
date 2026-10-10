/**
 * CORE.17.h.c — the Options panel's footer Reset / Defaults act on the
 * VISIBLE page only.
 *
 * Retail: each options tab is its own PlayerOptionPage (gmCharacterSettingsUI
 * / gmChatOptionsUI / gmConfigUI …) carrying its own m_UIOptionArray, and
 * the footer buttons call that page's OptionPage::RestoreSavedValues @
 * 004f2d00 / RestoreDefaultValues @ 004f2cb0, which iterate ONLY
 * `this->m_UIOptionArray` (reference/client-eol/decomp/acclient-decompiled.c
 * :232283-232333). Pressing Defaults on the Config tab therefore leaves the
 * Chat tab's filters/opacities and the Character tab's toggles alone — and
 * never touches the non-page state that shares our optionsSettings bag
 * (spell-bar tab, combat power, panel sub-tabs, the options tab itself).
 *
 * Pre-fix ours applied {...OPTIONS_DEFAULTS} / {...optionsSnapshot} in full.
 * This drives the REAL renderOptionsPanel in happy-dom and clicks the real
 * DAT footer buttons (0x100001fd Reset / 0x100001fe Defaults).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { CHARACTER_SETTINGS_PAGE, CHARACTER_SETTINGS_ROWS } from '../packages/renderer/src/ui/CharacterSettingsModel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

describe('CORE.17.h.c — footer Reset/Defaults scope to the visible options page', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICls: any;
  let DEFAULTS: Record<string, boolean | number | string>;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).cancelAnimationFrame = () => {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICls = mod.GameUI;
    DEFAULTS = GameUICls.OPTIONS_DEFAULTS;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          if (id === 0x10000211) {
            for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
              const btn = domWindow.document.createElement('div');
              btn.dataset.elementId = `0x${bid.toString(16)}`;
              for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
                const slice = domWindow.document.createElement('div');
                slice.dataset.elementId = `0x${sid.toString(16)}`;
                btn.appendChild(slice);
              }
              el.appendChild(btn);
            }
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
    };
    ui.callbacks.onCharacterOptionToggle = () => {};
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function openPanelOn(tab: string): void {
    // Close + reopen so the panel-open snapshot (Reset's baseline) is retaken.
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = tab;
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(true);
  }
  function switchTab(tab: string): void {
    // The tab strip binds through the layout handle's onClick (stubbed in
    // this harness), so mirror exactly what that handler writes: the live
    // tab, its persisted FAITHFUL.457 key, and a re-render.
    ui.optionsTab = tab;
    ui.optionsSettings.optionsTab = tab;
    ui.renderOptionsPanel();
  }
  function clickFooter(id: number): void {
    const btn = ui.optionsPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
  }
  function renderedKeys(): Set<string> {
    return new Set([...ui.optionsPanel.querySelectorAll('[data-option-key]')].map((el: HTMLElement) => el.dataset.optionKey!));
  }

  it('every option row a page renders (toggles, sliders, dropdowns) carries its option key hook', () => {
    openPanelOn('chat');
    const chat = renderedKeys();
    expect(chat.has('chatInactiveOpacity')).toBe(true);
    expect(chat.has('chatActiveOpacity')).toBe(true);
    expect(chat.has('chatMainWindowGeneral')).toBe(true);
    switchTab('config');
    const config = renderedKeys();
    for (const k of ['soundFeatures', 'effectsVolume', 'ambientVolume', 'interfaceVolume', 'playSoundsOnlyWhenActive',
      'cameraStiffness', 'cameraAdjustmentSpeed', 'fieldOfView', 'alignCameraToSlope', 'fullScreen',
      'syncWithRefreshRate', 'screenBrightness', 'adaptiveDegrade', 'adaptiveDegradeBias']) {
      expect(config.has(k), k).toBe(true);
    }
    // No cross-page leakage: the Config page owns none of the Chat page's options.
    for (const k of chat) expect(config.has(k), `config page must not register ${k}`).toBe(false);
  });

  it('Defaults on the Config tab restores only Config options — Chat/Character/non-page state untouched', () => {
    openPanelOn('character');
    // Perturb a Character toggle, a Chat filter + opacity, and Config values,
    // plus non-page state that shares the optionsSettings bag.
    ui.optionsSettings.showHelm = !DEFAULTS.showHelm;
    ui.optionsSettings.chatMainWindowGeneral = false;
    ui.optionsSettings.chatInactiveOpacity = 17;
    ui.optionsSettings.cameraStiffness = (DEFAULTS.cameraStiffness as number) === 5 ? 6 : 5;
    ui.optionsSettings.screenBrightness = (DEFAULTS.screenBrightness as number) === 5 ? 6 : 5;
    ui.optionsSettings.fullScreen = !DEFAULTS.fullScreen;
    ui.optionsSettings.activeSpellBarTab = 5;
    ui.optionsSettings.combatPowerLevel = 0.9;
    ui.optionsSettings.charPanelTab = 'skills';

    switchTab('config');
    clickFooter(0x100001fe); // Defaults

    // Config page options restored…
    expect(ui.optionsSettings.cameraStiffness).toBe(DEFAULTS.cameraStiffness);
    expect(ui.optionsSettings.screenBrightness).toBe(DEFAULTS.screenBrightness);
    expect(ui.optionsSettings.fullScreen).toBe(DEFAULTS.fullScreen);
    // …other pages' options left exactly as the player set them…
    expect(ui.optionsSettings.showHelm).toBe(!DEFAULTS.showHelm);
    expect(ui.optionsSettings.chatMainWindowGeneral).toBe(false);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(17);
    // …and the non-option state sharing the bag (retail keeps these in
    // entirely different objects) is not "defaulted" either.
    expect(ui.optionsSettings.activeSpellBarTab).toBe(5);
    expect(ui.optionsSettings.combatPowerLevel).toBe(0.9);
    expect(ui.optionsSettings.charPanelTab).toBe('skills');
    expect(ui.optionsSettings.optionsTab).toBe('config');
    expect(ui.optionsTab).toBe('config');
  });

  it('Defaults on the Chat tab restores the chat filters + opacities but leaves Character/Config edits alone', () => {
    openPanelOn('chat');
    ui.optionsSettings.chatMainWindowGeneral = false;
    ui.optionsSettings.chatInactiveOpacity = 17;
    ui.optionsSettings.chatActiveOpacity = 33;
    ui.optionsSettings.lockUI = !DEFAULTS.lockUI;
    ui.optionsSettings.fieldOfView = 61;
    ui.renderOptionsPanel();
    clickFooter(0x100001fe); // Defaults

    expect(ui.optionsSettings.chatMainWindowGeneral).toBe(DEFAULTS.chatMainWindowGeneral);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(DEFAULTS.chatInactiveOpacity);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(DEFAULTS.chatActiveOpacity);
    // CORE.17.h.a — the two chat opacity options now EXIST (Apply wrote them).
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.lockUI).toBe(!DEFAULTS.lockUI);
    expect(ui.optionsSettings.fieldOfView).toBe(61);
  });

  it('Reset on the Character tab reverts only Character options to the panel-open snapshot', () => {
    // Establish a baseline, open the panel (snapshot taken), then edit across pages.
    ui.optionsSettings.showCloak = true;
    ui.optionsSettings.autoTarget = true;
    ui.optionsSettings.chatMainWindowTrade = true;
    ui.optionsSettings.cameraAdjustmentSpeed = 40;
    openPanelOn('character');
    expect(ui.optionsSnapshot.showCloak).toBe(true);

    ui.optionsSettings.showCloak = false;
    ui.optionsSettings.autoTarget = false;
    ui.optionsSettings.chatMainWindowTrade = false;
    ui.optionsSettings.cameraAdjustmentSpeed = 90;
    ui.renderOptionsPanel();
    clickFooter(0x100001fd); // Reset

    expect(ui.optionsSettings.showCloak).toBe(true);
    expect(ui.optionsSettings.autoTarget).toBe(true);
    // Other pages' edits survive a Character-page Reset.
    expect(ui.optionsSettings.chatMainWindowTrade).toBe(false);
    expect(ui.optionsSettings.cameraAdjustmentSpeed).toBe(90);
  });

  it('whole-screen audit — Config check-slider labels keep their natural glyph width (the column width sits on the cell, not the text node)', () => {
    // Pre-fix `minWidth: 120px` was set on the renderACText node itself; for
    // the glyph canvas that overrides its natural `width: <canvas.width>px`
    // and stretches the label horizontally (live: "S o u n d  E f f e c t s").
    // CORE.17.h.d: the column is now the template's text cell (0x10000219 at
    // (6,2) 130x14, label inset 18 → 112 wide); the text node inside it
    // still carries no width override.
    openPanelOn('config');
    for (const key of ['effectsVolume', 'ambientVolume', 'interfaceVolume']) {
      const row = ui.optionsPanel.querySelector(`[data-option-key="${key}"]`) as HTMLElement | null;
      expect(row, key).toBeTruthy();
      const labelCol = row!.querySelector('.options-text-cell') as HTMLElement;
      expect(labelCol).toBeTruthy();
      expect(labelCol.style.width).toBe('112px');
      const textNode = labelCol.firstElementChild as HTMLElement;
      expect(textNode).toBeTruthy();
      expect(textNode.style.minWidth).toBe('');
      expect(textNode.style.width).toBe('');
    }
  });

  it('the Gameplay tab (action buttons only, no footer per DAT 0x2100002a) registers no options', () => {
    openPanelOn('gameplay');
    expect(renderedKeys().size).toBe(0);
    const footer = ui.optionsPanel.querySelector('[data-element-id="0x100001fe"]') as HTMLElement | null;
    // The DAT node exists in the pane base but is hidden on this tab.
    if (footer) expect(footer.style.display).toBe('none');
  });

  // BUG.character-tab-not-retail — the Character page is gmCharacterSettingsUI
  // ::InitOptions: its rows, in retail order, and nothing else.
  it('the Character page renders exactly the retail rows in InitOptions order under the six retail headers', () => {
    openPanelOn('character');
    const keys = [...ui.optionsPanel.querySelectorAll('.option-toggle-row')].map((el: HTMLElement) => el.dataset.optionKey);
    expect(keys).toEqual(CHARACTER_SETTINGS_ROWS.map((r) => r.ourKey));
    const headers = [...ui.optionsPanel.querySelectorAll('.options-section-header')].map((el: HTMLElement) => (el.textContent ?? '').trim());
    expect(headers).toEqual(CHARACTER_SETTINGS_PAGE.map((sec) => sec.header.label));
    for (const gone of ['lockUI', 'useMouseTurning', 'appearOffline']) expect(keys).not.toContain(gone);
    expect(ui.optionsPanel.textContent).not.toContain('Key Bindings');
  });

  it('Defaults on the Character tab restores PlayerModule::GetDefaultOptionValue, not the constructor word', () => {
    openPanelOn('character');
    for (const r of CHARACTER_SETTINGS_ROWS) ui.optionsSettings[r.ourKey!] = !r.defaultsButtonValue;
    ui.renderOptionsPanel();
    clickFooter(0x100001fe); // Defaults
    for (const r of CHARACTER_SETTINGS_ROWS) expect(ui.optionsSettings[r.ourKey!], r.ourKey!).toBe(r.defaultsButtonValue);
    // The three rows whose Defaults value differs from the fresh-character bit.
    expect(ui.optionsSettings.showHelm).toBe(false);
    expect(ui.optionsSettings.showCloak).toBe(false);
    expect(ui.optionsSettings.confirmUseOfRareGems).toBe(false);
    expect(DEFAULTS.showHelm).toBe(true);
  });

  it('the Side By Side Vitals row re-lays the vitals cluster when clicked', () => {
    openPanelOn('character');
    let refreshed = 0;
    const orig = ui.refreshVitalsCluster;
    ui.refreshVitalsCluster = () => { refreshed++; };
    try {
      const row = ui.optionsPanel.querySelector('.option-toggle-row[data-option-key="sideBySideVitals"]') as HTMLElement;
      expect((row.textContent ?? '').trim()).toBe('Side By Side Vitals');
      const before = !!ui.optionsSettings.sideBySideVitals;
      row.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
      expect(ui.optionsSettings.sideBySideVitals).toBe(!before);
      expect(refreshed).toBe(1);
    } finally { ui.refreshVitalsCluster = orig; }
  });
});
