/**
 * FAITHFUL.452 — activeSpellBarTab persists across sessions.
 *
 *  Pre-fix the spell-bar tab (0..7 page indicator) reset to 0 every
 *  login. A War mage who organized their bar to page 3 would return
 *  to page 0 each session — losing their preferred spell layout.
 *
 *  Persisted through optionsSettings → ac_options_settings_v1
 *  (FAITHFUL.432). The field declaration can't read optionsSettings
 *  inline (field initializers evaluate top-to-bottom, and
 *  activeSpellBarTab is declared above the optionsSettings IIFE), so
 *  the restore runs in the constructor body after optionsSettings
 *  is initialized. The tab-click write site updates optionsSettings
 *  + saveOptionsSettings so every tab change is durable.
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

describe('FAITHFUL.452 — activeSpellBarTab default + restore (behavioral, requires happy-dom devDep)', () => {
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

  // CORE.17.k.b.b.a.g.c — converted from a GameUI.ts source-text pin: the tab
  // click and the Next/Prev/First/Last Spell Tab keys share openSpellBarTab
  // (UIElement_Panel::OpenTab), which writes optionsSettings + persists.
  it('opening a tab (the click / the Spell Tab keys) writes optionsSettings.activeSpellBarTab and persists it', () => {
    domWindow.localStorage.clear();
    const ui: any = freshUI();
    ui.switchSpellBarTab('next');
    expect(ui.activeSpellBarTab).toBe(1);
    expect(ui.optionsSettings.activeSpellBarTab).toBe(1);
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).activeSpellBarTab).toBe(1);
    ui.switchSpellBarTab('last');
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).activeSpellBarTab).toBe(7);
    ui.switchSpellBarTab('next');   // GetNextTabID wraps 0x100005c2 → 0x100000a3
    expect(ui.activeSpellBarTab).toBe(0);
    ui.switchSpellBarTab('prev');
    expect(ui.activeSpellBarTab).toBe(7);
    ui.switchSpellBarTab('first');
    expect(ui.activeSpellBarTab).toBe(0);
  });

  it('GameUI.OPTIONS_DEFAULTS.activeSpellBarTab is 0', () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.activeSpellBarTab).toBe(0);
  });

  it('a fresh instance (no persisted state) starts on tab 0', () => {
    domWindow.localStorage.clear();
    const ui: any = freshUI();
    expect(ui.activeSpellBarTab).toBe(0);
  });

  it('constructor restores a valid persisted activeSpellBarTab (0..7)', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ activeSpellBarTab: 3 }));
    const ui: any = freshUI();
    expect(ui.activeSpellBarTab).toBe(3);
  });

  it('constructor ignores an out-of-range persisted activeSpellBarTab and keeps the default', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ activeSpellBarTab: 8 }));
    const ui: any = freshUI();
    expect(ui.activeSpellBarTab).toBe(0);
  });

  it('constructor ignores a non-integer persisted activeSpellBarTab and keeps the default', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ activeSpellBarTab: 2.5 }));
    const ui: any = freshUI();
    expect(ui.activeSpellBarTab).toBe(0);
  });
});
