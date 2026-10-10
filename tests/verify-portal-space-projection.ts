/**
 * VISUAL.portal-space-throat-black — portal space renders in a CreatureMode
 * viewport with UseSmartboxFOV (gmSmartBoxUI::PostInit), so its camera takes
 * the game projection Render::SetFOVRad(m_fGameFOV / (aspect − 0.1))
 * (CreatureMode draw, decomp ~85916) — not the hand-picked 95° that shrank
 * the throat to a pinhole.
 */
import { describe, it, expect } from 'vitest';
import { portalSpaceVerticalFovDeg } from '@ac/renderer/effects/PortalSpaceRenderer.js';
import { retailVerticalFovDeg } from '@ac/renderer/scene/RetailCamera.js';

describe('VISUAL.portal-space-throat-black: portal space uses the game FOV', () => {
  it('derives the vertical angle from the retail default m_fGameFOV (90°)', () => {
    // 16:9 → 90 / (1.778 − 0.1) ≈ 53.6°
    expect(portalSpaceVerticalFovDeg(90, 16 / 9)).toBeCloseTo(90 / (16 / 9 - 0.1), 6);
    expect(portalSpaceVerticalFovDeg(90, 16 / 9)).toBeLessThan(60);
  });

  it('follows the player Field of View preference like the world camera', () => {
    for (const [fov, aspect] of [[70, 1.6], [110, 2.02], [90, 1.25]] as const) {
      expect(portalSpaceVerticalFovDeg(fov, aspect)).toBe(retailVerticalFovDeg(fov, aspect));
    }
  });

  it('falls back to the retail default when the host reports no preference', () => {
    expect(portalSpaceVerticalFovDeg(undefined, 2)).toBeCloseTo(90 / 1.9, 6);
  });

  it('never returns the rejected out-of-range projection', () => {
    // aspect below 0.1 makes m_fGameFOV/(aspect − 0.1) negative — retail rejects it
    const v = portalSpaceVerticalFovDeg(90, 0.05);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(180);
  });
});
