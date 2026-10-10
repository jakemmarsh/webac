/**
 * GAP.81 — loadingBg AC_COLORS entry must be evidence-derived, not a
 * hand-picked hex guess.
 *
 * AC_COLORS.loadingBg fills the portal-space transition overlay
 * (GameUI.showPortalSpace) behind the PortalSpaceRenderer 3D canvas --
 * visible only briefly before that canvas mounts, or as a fallback if it
 * fails to load. PortalSpaceRenderer itself already establishes a pure
 * BLACK scene.background/clearColor for the void the tunnel recedes into
 * (DAT surface 0x050001B2 backing texture + era-correct EoL reference
 * video, see tests/verify-portal-space-funnel.ts), and the independently
 * skeptic-verified retail reference screenshot (portal-space-ref1.jpg)
 * shows the same thing: its central throat samples to avg rgb(21,24,31),
 * effectively black.
 *
 * The prior value was an invented navy '#080e18' with no citation. This
 * test asserts the real exported constant is pure black (matching the
 * established void, not a new guess) and fails if it drifts back toward
 * a hand-picked non-black tone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';

const ROOT = resolve(__dirname, '..');
const REFERENCE_SCREENSHOT = resolve(ROOT, 'reference/images/preworld/portal-space-ref1.jpg');

describe('GAP.81: loadingBg color matches the established portal-space void', () => {
  it.skipIf(!existsSync(REFERENCE_SCREENSHOT))('the cited reference screenshot exists in the repo (local-only; reference/images is gitignored, absent in CI)', () => {
    expect(existsSync(REFERENCE_SCREENSHOT)).toBe(true);
  });

  it('AC_COLORS still exports loadingBg as a 6-digit hex', () => {
    expect(AC_COLORS.loadingBg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is no longer the old invented navy #080e18 guess', () => {
    expect(AC_COLORS.loadingBg).not.toBe('#080e18');
  });

  it('is pure black, matching PortalSpaceRenderer\'s own established void color', () => {
    expect(AC_COLORS.loadingBg).toBe('#000000');
    expect(AC_COLORS.loadingBg).toBe(AC_COLORS.black);
  });
});
