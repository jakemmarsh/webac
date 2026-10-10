/**
 * FAITHFUL.444 — Panel layout (open/closed) persists across sessions.
 *
 *  Pre-fix the only path to persisting which panels were open
 *  required typing /saveui before logoff AND /loadui after login. The
 *  underlying getUIState / setUIState / `ac_ui_state` localStorage
 *  key existed (see /saveui + /loadui handlers in main.ts) but had no
 *  automation, so the typical player saw "all panels closed" every
 *  login regardless of their last-session layout. Retail AC saved/
 *  loaded UI per-character automatically.
 *
 *  Closed by:
 *    - `persistUIState()` helper on GameUI. Calls localStorage.set
 *      with the existing UI_STATE_KEY.
 *    - `restoreUIState()` helper on GameUI. Reads + applies on
 *      startup, returns boolean.
 *    - `updateToolbarActiveStates` calls persistUIState as its final
 *      step. Every toggle* method ends with that call, so the auto-
 *      save covers all six panels without touching each toggle.
 *    - main.ts startup calls `gameUI.restoreUIState()` after the
 *      FAITHFUL.438/.440 startup-apply block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.444 — persistUIState helper', () => {
  it('declares the UI_STATE_KEY constant', () => {
    expect(UI).toMatch(/UI_STATE_KEY\s*=\s*'ac_ui_state'/);
  });

  it('persistUIState() writes the result of getUIState()', () => {
    const fn = UI.match(/persistUIState\(\): void \{[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(fn).toMatch(/localStorage\.setItem\(GameUI\.UI_STATE_KEY/);
    expect(fn).toMatch(/this\.getUIState\(\)/);
  });

  it('restoreUIState() reads + applies via setUIState() and returns true on success', () => {
    const fn = UI.match(/restoreUIState\(\): boolean \{[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(fn).toMatch(/localStorage\.getItem\(GameUI\.UI_STATE_KEY\)/);
    expect(fn).toMatch(/this\.setUIState\(/);
    expect(fn).toMatch(/return true/);
  });
});

describe('FAITHFUL.444 — auto-save wiring', () => {
  it('updateToolbarActiveStates calls persistUIState as its final step', () => {
    const fn = UI.match(
      /private updateToolbarActiveStates\(\)[\s\S]+?\n  \}/,
    )?.[0] ?? '';
    expect(fn).toMatch(/this\.persistUIState\(\)/);
  });
});

describe('FAITHFUL.444 — startup restore', () => {
  it('main.ts calls gameUI.restoreUIState() once at startup', () => {
    expect(MAIN).toMatch(/gameUI\.restoreUIState\(\)/);
  });

  it('the startup restore call runs AFTER showGame() so renderHUD has built the toolbar', () => {
    // FAITHFUL.447 — file-order doesn't matter because showGame is
    // inside a login-success callback that fires AFTER GameUI is
    // constructed at runtime. What MUST be true is that the restore
    // happens AFTER showGame() in the same callback so renderHUD
    // (which wipes hudContainer) doesn't clobber the restored panels.
    const showGameIdx = MAIN.indexOf('gameUI.showGame()');
    const restoreIdx = MAIN.indexOf('gameUI.restoreUIState()');
    expect(showGameIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeGreaterThan(showGameIdx);
  });
});

describe('FAITHFUL.444 citations', () => {
  it('GameUI cites FAITHFUL.444', () => {
    expect(UI).toMatch(/FAITHFUL\.444/);
  });
  it('main.ts cites FAITHFUL.444', () => {
    expect(MAIN).toMatch(/FAITHFUL\.444/);
  });
});
