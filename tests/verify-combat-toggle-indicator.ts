/**
 * FAITHFUL.259 — Live combat-toggle HUD indicator.
 *
 * The small `combat-toggle` status-bar indicator (texActive 0x060016d1 red
 * sword / texInactive 0x060016d0 grey sword) had its `onClick` wired in
 * `createHud` (calls `toggleCombatMode`) but its visual state was never
 * actually updated — it stayed grey forever, even while in combat. The big
 * combat-mode button in the bottom toolbar gets repainted by `drawCombatMode`,
 * but that function didn't touch the small indicator.
 *
 * Fix (FAITHFUL.255/256 pattern): inside `drawCombatMode`, call
 * `setIndicatorActive('combat-toggle', mode !== CombatMode.NonCombat)` after
 * the big-button repaint. Active in any non-NonCombat mode.
 *
 * 2026-07-21 (GAP.81): drawCombatMode's own vector-icon canvas-fallback
 * dead-code was removed, shrinking the function to just the DAT-texture
 * repaint + this indicator call. The mode->texture mapping it used is now
 * the real exported GameUI.combatModeTextureId static, which this test
 * drives directly (no source-grep) instead of regexing the function body.
 *
 * DEBT.test-harness-hygiene: the remaining drawCombatMode / indicator pins
 * are now behavioural too (a real GameUI in happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CombatMode } from '@ac/shared';
import { GameUI } from '../packages/renderer/src/ui/GameUI';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Minimal LayoutRenderer stand-in so renderHUD builds the HUD (indicator strip, toolbar). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(ui: any, win: any): void {
  const makeHandle = (_layoutId: number, parent: HTMLElement) => {
    const root = win.document.createElement('div') as HTMLElement;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const getOrCreate = (id: number): HTMLElement => {
      let el = elements.get(id);
      if (!el) { el = win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
      return el;
    };
    return {
      root, elements: { get: (id: number) => getOrCreate(id), set: () => {} }, descs: new Map(),
      setText: () => {}, setFill: () => {}, setPalette: () => {}, setVisible: () => {}, setState: () => {},
      setInteractive: () => {},
      setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
      close: () => root.remove(), destroy: () => root.remove(),
    };
  };
  ui.getTexURL = () => null;
  ui.layoutRenderer = { render: makeHandle, renderPanel: makeHandle, getTextureDataURLWithAlpha: () => null };
}

describe('FAITHFUL.259 — live combat-toggle indicator', () => {
  it('GameUI.combatModeTextureId maps each mode to its real LayoutDesc 0x21000016 ornament-frame texture', () => {
    expect(GameUI.combatModeTextureId(CombatMode.NonCombat)).toBe(0x06004cec);
    expect(GameUI.combatModeTextureId(CombatMode.Melee)).toBe(0x06004cee);
    expect(GameUI.combatModeTextureId(CombatMode.Missile)).toBe(0x06004cf0);
    expect(GameUI.combatModeTextureId(CombatMode.Magic)).toBe(0x06004cf2);
  });

  it('CombatMode.NonCombat (1) is correctly identified as the OFF state', () => {
    expect(CombatMode.NonCombat).toBe(1);
    expect(CombatMode.Melee).toBe(2);
    expect(CombatMode.Missile).toBe(4);
    expect(CombatMode.Magic).toBe(8);
  });
});

describe('CORE.5.b — combat mode has no small indicator; drawCombatMode follows mode changes (behavioural)', () => {
  let H: GameUIFixture;
  const indicatorCalls: string[] = [];
  let drawCalls = 0;

  beforeAll(async () => {
    H = await mountGameUI();
    stubLayoutRenderer(H.ui, H.win);
    H.ui.renderHUD();
    const realSet = H.ui.setIndicatorActive.bind(H.ui);
    H.ui.setIndicatorActive = (id: string, active: boolean) => { indicatorCalls.push(id); return realSet(id, active); };
    const realDraw = H.ui.drawCombatMode.bind(H.ui);
    H.ui.drawCombatMode = () => { drawCalls++; return realDraw(); };
  }, 60_000);
  afterAll(() => H.teardown());

  it('CORE.5.b — no combat-toggle indicator is registered or rendered (classic-only element 0x100000f1)', () => {
    expect(H.ui.indicatorTexById.has('combat-toggle')).toBe(false);
    expect(H.win.document.getElementById('hud-indicator-combat-toggle')).toBeNull();
  });

  it('CORE.5.b — toggling combat mode never drives a combat-toggle indicator (the toolbar button is the sole surface)', () => {
    H.ui.toggleCombatMode();
    H.ui.toggleCombatMode();
    expect(indicatorCalls).not.toContain('combat-toggle');
  });

  it('updateHUD redraws the combat button whenever hud.combatMode changes (and only then)', () => {
    H.ui.uiManager.setScreen('game');
    H.ui.updateHUD();           // sync lastCombatMode
    drawCalls = 0;
    H.ui.updateHUD();
    expect(drawCalls).toBe(0);  // unchanged mode → no redraw
    H.ui.hud.combatMode = CombatMode.Magic;
    H.ui.updateHUD();
    expect(drawCalls).toBe(1);
    expect(indicatorCalls).not.toContain('combat-toggle');
  });
});
