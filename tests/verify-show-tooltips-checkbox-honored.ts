/**
 * FAITHFUL.371 — "Show 3D Tooltips" Options checkbox actually controls
 * the 3D hover tooltip.
 *
 * Pre-fix the checkbox toggled `optionsSettings.showTooltips` but no
 * consumer read it — the hover name appeared unconditionally on canvas
 * mouse move, even when the player opted out. Retail's ShowTooltips
 * (CharacterOptions1.ShowTooltips = 0x00000100 per ACE
 * CharacterOptions1.cs:22, Default ON) is PlayerModule::ShowTooltips, the
 * gate UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0
 * reads before SetTooltip-ing the 3D view with the object's name.
 *
 * CORE.17.k.b.b.a.g.a converted the source-text pins on main.ts's
 * `setHovered(...)` call (the hover name was an invented overhead label;
 * retail's is UIElementManager's tooltip at the mouse) to the shipped rule
 * `worldHoverTooltipText`, which main.ts feeds to GameUI.tagHudTooltip on
 * the renderer canvas.
 *
 * The "cursor stays unconditional" assertion drives the real, shipped
 * resolveWorldCursorName function: it has no tooltip-setting parameter at
 * all (arity check), so by construction nothing can gate the cursor
 * decision on `showTooltips` the way the tooltip text is gated.
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import { resolveWorldCursorName } from '../packages/renderer/src/ui/CursorManager.js';
import { worldHoverTooltipText } from '../packages/renderer/src/ui/WorldHoverTooltip.js';

describe('the 3D hover tooltip honors optionsSettings.showTooltips (FAITHFUL.371)', () => {
  it('the hovered object\'s name only while the option is on', () => {
    expect(worldHoverTooltipText({ name: 'Town Crier' }, true)).toBe('Town Crier');
    expect(worldHoverTooltipText({ name: 'Town Crier' }, false)).toBeNull();
  });

  it('does NOT regress to an unconditional name: with the option off nothing is tagged whatever is under the mouse', () => {
    for (const hit of [{ name: 'Drudge Slinker' }, { name: 'Chest' }, { name: '' }, null]) {
      expect(worldHoverTooltipText(hit, false)).toBeNull();
    }
    expect(worldHoverTooltipText(null, true)).toBeNull();
  });

  it('the world-cursor resolver takes no tooltip/display-setting parameter (cursor cannot be gated on showTooltips)', () => {
    expect(resolveWorldCursorName.length).toBe(2); // (combatMode, overObject) only
  });

  it('cursor changes with hover state independent of combat mode (GAP.84 — real DAT-cursor decision logic)', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      const overName = resolveWorldCursorName(mode, true);
      const idleName = resolveWorldCursorName(mode, false);
      expect(overName).not.toBe(idleName);
      expect(overName).toMatch(/_OverObject$/);
      expect(idleName).not.toMatch(/_OverObject$/);
    }
  });
});
