/**
 * Screen-regression determinism: GameUI.pinPortalSpace(seconds, seed) holds
 * portal space as a reproducible still (frozen clock, seeded roll draws), so
 * two captures of identical code match. The live tunnel captured ~1.8 s after
 * an unseeded start differed by up to 29% between runs (cloud, 2026-10-01).
 * hidePortalSpace() returns to the live clock and unseeded roll.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.pinPortalSpace', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, {});
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });

  it('the same seconds + seed give the same frozen frame; the live clock returns on hide', () => {
    ui.pinPortalSpace(1.8, 7);
    const t1 = ui.portalClock();
    expect(t1).toBeCloseTo(1001.8, 6);
    expect(ui.portalClock()).toBe(t1); // frozen
    const f1 = ui.teleportAnim.update(t1, 0);
    ui.hidePortalSpace();
    ui.pinPortalSpace(1.8, 7);
    const f2 = ui.teleportAnim.update(ui.portalClock(), 0);
    expect(f2.rollDeg).toBe(f1.rollDeg);
    expect(f2.tunnelVisible).toBe(f1.tunnelVisible);
    ui.hidePortalSpace();
    const live = ui.portalClock();
    expect(Math.abs(live - performance.now() / 1000)).toBeLessThan(1);
  });
});
