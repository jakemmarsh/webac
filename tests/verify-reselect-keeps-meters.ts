/**
 * BUG.reselect-drops-mana-meter — gmToolbarUI::HandleSelectionChanged
 * @ 004bf380 clears the selection meters only when the selected id changes.
 * Re-selecting the same item (second click / double-click to use) used to
 * rebuild the TargetInfo without manaFraction; the query plumbing sends no
 * new QueryItemMana for an unchanged guid, so the toolbar fell back to the
 * grey empty heart under a fully charged Sceptre.
 */
import { describe, it, expect } from 'vitest';
import { HUD } from '../packages/renderer/src/ui/HUD.js';

const item = (id: number) => ({ id, name: 'Sceptre', level: 0, healthFraction: 0, distance: 0, type: 'item' as const });
const creature = (id: number, healthFraction: number) => ({ id, name: 'Drudge', level: 1, healthFraction, distance: 0, type: 'creature' as const });

describe('HUD target re-select keeps queried meter values', () => {
  it('re-selecting the same item keeps its mana fraction', () => {
    const hud = new HUD();
    hud.setTarget(item(0x80000a2e));
    hud.target!.manaFraction = 0.999; // QueryItemManaResponse success
    hud.setTarget(item(0x80000a2e));
    expect(hud.target!.manaFraction).toBe(0.999);
  });

  it('selecting a different item does not inherit mana', () => {
    const hud = new HUD();
    hud.setTarget(item(1));
    hud.target!.manaFraction = 0.5;
    hud.setTarget(item(2));
    expect(hud.target!.manaFraction).toBeUndefined();
  });

  it('re-clicking the same creature keeps its reported health and the visible meter', () => {
    const hud = new HUD();
    hud.target = creature(7, 0);
    expect(hud.target!.healthReceived).toBeUndefined();
    hud.target!.healthFraction = 0.3; // UpdateHealth reply
    hud.target!.healthReceived = true;
    hud.target = creature(7, 0);
    expect(hud.target!.healthFraction).toBe(0.3);
    expect(hud.target!.healthReceived).toBe(true);
    hud.target = null;
    hud.target = creature(7, 0);
    // a fresh selection after a clear starts over: hidden until the next reply
    expect(hud.target!.healthReceived).toBeUndefined();
  });

  it('a different selection never inherits a health reply', () => {
    const hud = new HUD();
    hud.target = creature(7, 0);
    hud.target!.healthFraction = 0.3;
    hud.target!.healthReceived = true;
    hud.target = creature(8, 0);
    expect(hud.target!.healthReceived).toBeUndefined();
    expect(hud.target!.healthFraction).toBe(0);
  });

  it('an explicit mana value on the new info wins', () => {
    const hud = new HUD();
    hud.setTarget(item(3));
    hud.target!.manaFraction = 0.9;
    hud.setTarget({ ...item(3), manaFraction: 0.2 });
    expect(hud.target!.manaFraction).toBe(0.2);
  });
});
