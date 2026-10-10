/**
 * FAITHFUL.447 — restoreUIState must run AFTER showGame() because
 *  showGame's renderHUD wipes the hudContainer.
 *
 *  Pre-fix (FAITHFUL.444 placement): restoreUIState was called right
 *  after GameUI construction, BEFORE showGame. The toggle methods
 *  rendered panels into the hudContainer, but later showGame() →
 *  renderHUD() executed `this.hudContainer.innerHTML = ''` —
 *  wiping the restored panels before they ever became visible.
 *
 *  Effects: players who had any panel open in a prior session would
 *  see all panels closed at login despite the persisted state. The
 *  visible behavior matched pre-FAITHFUL.444 because the late wipe
 *  defeated the restore.
 *
 *  Fix: move the call to AFTER gameUI.showGame() in the login-
 *  success callback (line ~2632), AND remove the early call so the
 *  restore doesn't double-fire (the second call would no-op because
 *  booleans were already set by the first).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.447 — restoreUIState ordering vs showGame', () => {
  it('exactly one call to gameUI.restoreUIState() in main.ts', () => {
    const matches = MAIN.match(/gameUI\.restoreUIState\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the call site is after a gameUI.showGame() invocation', () => {
    const showGameIdx = MAIN.indexOf('gameUI.showGame()');
    const restoreIdx = MAIN.indexOf('gameUI.restoreUIState()');
    expect(showGameIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeGreaterThan(showGameIdx);
  });

  it('the old early-restore location (after disableWeather apply) is gone', () => {
    // FAITHFUL.444 placed the call right after the disableWeather
    // apply, before any login flow. Pin that the file no longer has
    // restoreUIState anywhere in the FAITHFUL.438/.440 startup-apply
    // block.
    const blockStart = MAIN.indexOf('FAITHFUL.438');
    const blockEnd = MAIN.indexOf('FAITHFUL.270', blockStart + 1);
    if (blockStart > 0 && blockEnd > blockStart) {
      const block = MAIN.slice(blockStart, blockEnd);
      expect(block).not.toMatch(/gameUI\.restoreUIState\(\)/);
    }
  });

  it('cites FAITHFUL.447', () => {
    expect(MAIN).toMatch(/FAITHFUL\.447/);
  });
});
