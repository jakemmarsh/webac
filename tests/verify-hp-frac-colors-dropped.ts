/**
 * GAP.81 — drop orphaned hpFracHigh/hpFracMid/hpFracCrit from AC_COLORS.
 *
 * These three "vital-fraction stage colors" backed a single 4px CSS health
 * bar segment shader that VISUAL.116 replaced with real DAT vitals-bar
 * textures (0x0600251c/0x06002520/0x0600251e) for the fellowship member
 * list — see tests/verify-visual-social-2026-06-09.ts's
 * `not.toMatch(/hpFracHigh : hpPct > 0\.25/)` assertion, which already
 * confirmed the CSS-shader call site was gone. The AC_COLORS entries
 * themselves were left behind as dead exports with no remaining call site
 * anywhere in packages/renderer/src.
 *
 * GAP.81's mandate is "no CSS-approximations / no made-up colors" for real
 * UI elements — for a color with zero consumers, deleting the invented hex
 * is the correct fix (there's nothing left to re-derive from DAT).
 */
import { describe, it, expect } from 'vitest';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';

describe('GAP.81: orphaned hpFrac* AC_COLORS entries removed', () => {
  it('hpFracHigh/hpFracMid/hpFracCrit are no longer exported', () => {
    expect('hpFracHigh' in AC_COLORS).toBe(false);
    expect('hpFracMid' in AC_COLORS).toBe(false);
    expect('hpFracCrit' in AC_COLORS).toBe(false);
  });
});
