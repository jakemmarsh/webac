/**
 * BUG.5 — character select must not resurrect over a started game.
 *
 * The char-select DOM persists behind display:none after showGame(), so a
 * stray or queued click on a hidden .char-slot re-entered
 * renderCharacterSelect(), which unconditionally set the screens container
 * back to display:block at z=1000 — covering the running game forever.
 * Observed live 2026-07-04 (remote-env full-loop session, see progress.md):
 * "Game started — 444 models" + HUD display:block, yet the page showed
 * character select. Caller traced to the .char-slot click handler.
 *
 * Fix under test: renderCharacterSelect() early-returns unless
 * uiManager.currentScreen === 'character-select'.
 *
 * Behavioral suite — drives the real GameUI class under happy-dom (same
 * harness as verify-gameui-dom-smoke.ts: tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('BUG.5 — char select does not resurrect over the game screen', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let screens: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hud: any;

  const SLOT = { id: '1342177281', name: '+Fable', level: 1, race: 'Aluvian', class: 'Adventurer' };

  beforeAll(async () => {
    // Bind functions (e.g. requestAnimationFrame) so happy-dom's `this` survives.
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    screens = container.querySelector('#game-ui-screens');
    hud = container.querySelector('#game-hud');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('showCharacterSelect renders the slot list with screens visible', () => {
    ui.showCharacterSelect([SLOT]);
    expect(screens.style.display).toBe('block');
    expect(screens.querySelector('.char-slot')).toBeTruthy();
  });

  it('showGame hides the screens container and shows the HUD', () => {
    ui.showGame();
    expect(screens.style.display).toBe('none');
    expect(hud.style.display).toBe('block');
  });

  it('a stray click on the hidden .char-slot does NOT resurrect character select', () => {
    const slot = screens.querySelector('.char-slot');
    expect(slot).toBeTruthy();
    // Real DOM event through the real handler — the pre-fix path called
    // renderCharacterSelect() and flipped screens back to display:block.
    slot.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(screens.style.display).toBe('none');
    expect(hud.style.display).toBe('block');
  });

  it('legitimate return to character select (logout flow) still renders', () => {
    ui.showCharacterSelect([SLOT]);
    expect(screens.style.display).toBe('block');
    expect(screens.querySelector('.char-slot')).toBeTruthy();
  });
});
