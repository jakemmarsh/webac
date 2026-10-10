/**
 * FAITHFUL.545 — TradeFailure handler substitutes item name into `_`
 * placeholder strings before chat display.
 *
 *  Live trade verification in FAITHFUL.539 surfaced this bug: trying
 *  to trade the attuned Sceptre triggered ACE's
 *    new GameEventTradeFailure(Session, itemGuid, WeenieError.AttunedItem)
 *  Our handler called weenieErrorText(0x0426) which returned the raw
 *  template `"_ can't be dropped"` — chat displayed literal underscore.
 *
 *  ACE WeenieError <summary> tags carry `_` as the item-name
 *  placeholder for several entries (AttunedItem 0x0426, TradeAiDoesntWant
 *  0x046A, etc.). The original AC client substituted before display.
 *
 *  We have data.objectGuid on every TradeFailure event (ACE
 *  GameEventTradeFailure.cs:10-11 writes `objectGuid u32 + reason u32`)
 *  so we can look up the item name and substitute. Look in inventory
 *  first (most TradeFailures are server rejecting OUR item), fall back
 *  to ServerObjectManager for partner-owned cases.
 *
 *  Drives the real substituteWeenieErrorItemName() extracted from
 *  main.ts's onTradeFailure handler (packages/shared/src/combat/
 *  WeenieErrorText.ts) — not a source-text regex pin.
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText, substituteWeenieErrorItemName } from '@ac/shared';
import { InventoryManager, type InventoryItem } from '@ac/shared';

function makeInventory(items: InventoryItem[]): InventoryManager {
  const inv = new InventoryManager();
  for (const { id, ...rest } of items) inv.addItem(rest, id);
  return inv;
}

describe('FAITHFUL.545 — TradeFailure substitutes item name', () => {
  it('weenieErrorText(AttunedItem) returns the raw `_` placeholder template', () => {
    expect(weenieErrorText(WeenieError.AttunedItem)).toBe("_ can't be dropped");
  });

  it('substitutes the placeholder with the item name found in own inventory', () => {
    const inventory = makeInventory([
      { id: 0x50001234, weenieClassId: 1, name: 'Sceptre of Fire', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 },
    ]);
    const text = weenieErrorText(WeenieError.AttunedItem);
    const result = substituteWeenieErrorItemName(text, 0x50001234, inventory);
    expect(result).toBe("Sceptre of Fire can't be dropped");
  });

  it('falls back to a ServerObjectManager lookup when the item is not in own inventory', () => {
    const inventory = makeInventory([]);
    const text = weenieErrorText(WeenieError.AttunedItem);
    const result = substituteWeenieErrorItemName(text, 0x50009999, inventory, (guid) =>
      guid === 0x50009999 ? { name: "Olthoi Queen's Ichor" } : undefined,
    );
    expect(result).toBe("Olthoi Queen's Ichor can't be dropped");
  });

  it('falls back to "That item" when both inventory and ServerObjectManager lookups miss', () => {
    const inventory = makeInventory([]);
    const text = weenieErrorText(WeenieError.AttunedItem);
    const result = substituteWeenieErrorItemName(text, 0x50000000, inventory, () => undefined);
    expect(result).toBe("That item can't be dropped");
  });

  it('substitutes ALL `_` occurrences, not just the first', () => {
    const inventory = makeInventory([
      { id: 1, weenieClassId: 1, name: 'Widget', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 },
    ]);
    const result = substituteWeenieErrorItemName('_ rejects _ outright', 1, inventory);
    expect(result).toBe('Widget rejects Widget outright');
  });

  it('is a no-op for text without a `_` placeholder', () => {
    const inventory = makeInventory([]);
    const result = substituteWeenieErrorItemName('Trade partner left the world.', 1, inventory);
    expect(result).toBe('Trade partner left the world.');
  });

  it('passes through null text unchanged', () => {
    const inventory = makeInventory([]);
    expect(substituteWeenieErrorItemName(null, 1, inventory)).toBeNull();
  });

  it('prefers the own-inventory match over the ServerObjectManager fallback', () => {
    const inventory = makeInventory([
      { id: 42, weenieClassId: 1, name: 'Own Copy', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 },
    ]);
    const result = substituteWeenieErrorItemName('_ is gone', 42, inventory, () => ({ name: 'Other Copy' }));
    expect(result).toBe('Own Copy is gone');
  });
});
