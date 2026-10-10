/**
 * BUG.config-prefs-applied-on-open — "opening Config seemed to cause the
 * dimming". The saved Config preferences (Screen Brightness's gamma ramp,
 * draw distance, texture / degrade prefs) were applied only when the Config
 * tab was drawn, so a saved non-default brightness switched on then. Retail
 * applies them when the world starts (Render::UpdateFromPreferences
 * @ 0054d850). Real GameUI in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;

describe('saved Config prefs apply at game start', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let domWindow: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterAll(() => { domWindow.document.body.style.filter = ''; restoreDomGlobals(DOM_GLOBALS as never, saved); });

  it('a saved dark Screen Brightness is in effect once the world shows — without opening Config', () => {
    ui.optionsSettings.screenBrightness = -0.2;
    expect(domWindow.document.body.style.filter).toBe('');
    ui.showGame();
    expect(domWindow.document.body.style.filter).toContain('brightness(');
  });
  it('the default brightness installs no filter', () => {
    ui.optionsSettings.screenBrightness = 0;
    ui.showGame();
    expect(domWindow.document.body.style.filter).toBe('');
  });
});
