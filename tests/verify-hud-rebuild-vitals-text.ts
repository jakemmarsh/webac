/**
 * ASSESS: regression test for the HUD-rebuild stale-cache bug found during
 * live verification of the logout→char-select→re-enter loop (2026-06-10).
 *
 * updateHUD() only redraws each vital-bar text canvas when the formatted
 * string differs from its lastHealthText/lastStaminaText/lastManaText cache.
 * renderHUD() recreates the canvases blank, so a rebuild (e.g. re-entering
 * the world after /logout) with unchanged vitals skipped the first redraw —
 * bars rendered with no "5/5"-style text while playerState was correct.
 * The fix resets all change-detection caches at the top of renderHUD().
 *
 * Drives the real GameUI class under happy-dom (same idiom as
 * verify-gameui-dom-smoke.ts); tests/_harness/dom.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('renderHUD resets vital-text change-detection caches', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('clears every last* text cache when the HUD is rebuilt', () => {
    // Simulate a prior session having drawn "5/5"-style text.
    ui.lastHealthText = '5/5';
    ui.lastStaminaText = '10/10';
    ui.lastManaText = '290/290';
    // CORE.5.a/CORE.5.b.b — the compass-degrees text was removed (retail
    // gmRadarUI has none); the coord line is the EoL combined readout.
    ui.lastCoordText = '28.5S,7.2E';
    // (the former _lastStatusLeft/_lastStatusRight caches are gone —
    // CORE.4.a removed the non-retail statusbar coords/FPS text entirely;
    // see tests/verify-statusbar-row-background.ts)

    // Real rebuild path (no layoutRenderer/DATs needed — the resets are
    // unconditional at the top of renderHUD).
    ui.renderHUD();

    expect(ui.lastHealthText).toBe('');
    expect(ui.lastStaminaText).toBe('');
    expect(ui.lastManaText).toBe('');
    expect(ui.lastCoordText).toBe('');
  });
});
