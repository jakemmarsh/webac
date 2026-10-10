/**
 * ASSESS: DOM smoke test for the real GameUI class — proves the 14k-line
 * monolith is instantiable under a synthetic DOM with zero source changes,
 * so behavior tests can execute the shipped code instead of regex-matching
 * its source text (2026-06-10 fresh-eyes audit §tests; a deliberate GameUI
 * display regression previously passed all 10,252 tests).
 *
 * Feasibility findings (GameUI.ts read 2026-06-10):
 *   - Module scope of GameUI + its import chain (UIManager, HUD,
 *     CharacterCreate, CharacterSelect, LayoutRenderer, ACFontRenderer,
 *     ZIndexRegistry, derethTime, three) is DOM-free — other tests already
 *     import AC_COLORS from GameUI.js under the node environment.
 *   - The constructor (GameUI.ts:973) needs only `container: HTMLElement`;
 *     portalDb/textureManager/soundPlayer/etc are optional and null-guarded
 *     (loadDATAssets returns immediately without portalDb).
 *   - Construction touches three globals: `document` (createElement),
 *     `window` (innerWidth/innerHeight + resize listener), `localStorage`
 *     (chatHistory + optionsSettings field-initializer IIFEs, try/caught).
 *   - renderACText falls back to plain <span> when no fontRenderer is
 *     loaded, so DAT-free dialog rendering works.
 *
 * happy-dom is a devDependency loaded through tests/_harness/dom.ts, which
 * THROWS if it cannot import — a broken environment fails this suite instead
 * of silently skipping it (DEBT.test-harness-hygiene).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI DOM smoke (requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AC_COLORS: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // Import AFTER the globals are installed (module scope is DOM-free
    // today, but this keeps the test robust if that ever changes).
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
    AC_COLORS = mod.AC_COLORS;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('constructs against a real DOM and mounts its containers', () => {
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUICtor(container);
    // The constructor appends both top-level containers (GameUI.ts:1085).
    expect(container.querySelector('#game-ui-screens')).toBeTruthy();
    expect(container.querySelector('#game-hud')).toBeTruthy();
  });

  it('GAP.81: does not render the invented radar-adjacent level/XP-bar HUD block', () => {
    // Retail's classic HUD shows nothing below the radar disc but the
    // coordinate readout (reference/images/hud/radar-compass.jpg,
    // radar-coordinates.jpg, and full-window captures rawg_01/04/06.jpg all
    // confirm this); Level + XP live only in the Character Info panel
    // (reference/images/hud/character-panel.jpg — "Character Level" box +
    // "Total Experience (XP)" / "XP for next level" rows), which GameUI
    // already renders faithfully via appendCharHeaderBlock. The HUD used to
    // additionally draw a "Lvl N" bitmap-font label + a 70x4px XP progress
    // bar under the radar with no DAT/decompiled-client/screenshot basis —
    // removed as an invented feature, not merely an uncited color.
    const hud = container.querySelector('#game-hud');
    expect(hud).toBeTruthy();
    expect(hud.textContent).not.toMatch(/Lvl\s*\d/);
    // AC_COLORS.xpBarFill backed only that removed fill bar; it must not
    // survive as a dangling, now-uncited literal.
    expect(Object.prototype.hasOwnProperty.call(AC_COLORS, 'xpBarFill')).toBe(false);
  });

  it('showConfirmationDialog renders real DOM nodes; Yes-click fires the callback and tears down', () => {
    let answer: boolean | null = null;
    ui.showConfirmationDialog('Do you accept this smoke test?', (accepted: boolean) => {
      answer = accepted;
    });
    const dialog = domWindow.document.body.lastElementChild;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Do you accept this smoke test?');
    // Yes on the left (x=80), No on the right (x=240) — DAT template
    // positions from DialogFactory layout 0x2100003C (CORE.13.b);
    // getString falls back to 'Yes'/'No' without a loaded StringTable.
    expect(dialog.textContent).toContain('Yes');
    expect(dialog.textContent).toContain('No');
    const btns = dialog.querySelectorAll('.ac-dialog-button');
    expect(btns.length).toBe(2);
    const yesBtn = btns[0];
    yesBtn.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(answer).toBe(true);
    // hideConfirmationDialog removes the dialog from the document.
    expect(domWindow.document.body.contains(dialog)).toBe(false);
  });
});
