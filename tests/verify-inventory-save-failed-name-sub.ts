/**
 * FAITHFUL.558 — InventoryServerSaveFailed handler substitutes `_`
 * placeholder with item name, matching the FAITHFUL.545 TradeFailure
 * fix pattern.
 *
 *  ACE Player_Inventory.cs:1391 ships:
 *    new GameEventInventoryServerSaveFailed(Session, itemGuid,
 *                                           WeenieError.AttunedItem)
 *  when player tries to drop an attuned item.
 *  weenieErrorText(AttunedItem 0x0426) returns the template
 *  "_ can't be dropped" — without substitution chat shows the literal
 *  underscore. Player gets a confusing message instead of the
 *  contextual "Sceptre can't be dropped".
 *
 *  Same pattern, same fix as .545 (TradeFailure) — the handler in
 *  main.ts calls the shared substituteWeenieErrorItemName() (packages/
 *  shared/src/combat/WeenieErrorText.ts), already exhaustively covered
 *  by tests/verify-trade-failure-name-substitution.ts. This file drives
 *  the same substitution end-to-end for the AttunedItem-drop template
 *  specifically, plus a thin wiring check that main.ts calls the real
 *  shared function rather than reimplementing the lookup inline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeenieError, weenieErrorText, substituteWeenieErrorItemName } from '@ac/shared';
import { InventoryManager, type InventoryItem } from '@ac/shared';

function makeInventory(items: InventoryItem[]): InventoryManager {
  const inv = new InventoryManager();
  for (const { id, ...rest } of items) inv.addItem(rest, id);
  return inv;
}

describe('FAITHFUL.558 — InventoryServerSaveFailed substitutes item name', () => {
  it('substitutes the AttunedItem drop template with the item name found in own inventory', () => {
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
      guid === 0x50009999 ? { name: 'Ivory Idol' } : undefined,
    );
    expect(result).toBe("Ivory Idol can't be dropped");
  });

  it('falls back to "That item" when both inventory and ServerObjectManager lookups miss', () => {
    const inventory = makeInventory([]);
    const text = weenieErrorText(WeenieError.AttunedItem);
    const result = substituteWeenieErrorItemName(text, 0x50000000, inventory, () => undefined);
    expect(result).toBe("That item can't be dropped");
  });

  it('is a no-op for non-templated inventory error text (e.g. the vendor-buy-reject string)', () => {
    const inventory = makeInventory([]);
    const result = substituteWeenieErrorItemName(
      'The vendor cannot complete that transaction. Check your coin or what the vendor accepts.',
      1,
      inventory,
    );
    expect(result).toBe('The vendor cannot complete that transaction. Check your coin or what the vendor accepts.');
  });

  // Thin wiring check: main.ts's onInventoryServerSaveFailed must call the
  // real shared substituteWeenieErrorItemName() (already behaviorally
  // tested above and in verify-trade-failure-name-substitution.ts), not
  // reimplement the own-inventory/SOM/default lookup inline.
  describe('main.ts wiring', () => {
    const MAIN = readFileSync(resolve(__dirname, '../packages/renderer/src/main.ts'), 'utf8');
    const block = MAIN.match(/onInventoryServerSaveFailed: \(data\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';

    it('calls the shared substituteWeenieErrorItemName helper', () => {
      expect(block.length).toBeGreaterThan(200);
      expect(block).toMatch(/FAITHFUL\.558/);
      expect(block).toMatch(/substituteWeenieErrorItemName\(\s*errText,\s*data\.itemGuid,\s*playerState\.inventory,/);
    });

    it('does not reimplement the own/SOM/default lookup inline', () => {
      expect(block).not.toMatch(/errText\.split\('_'\)\.join\(name\)/);
    });

    it('cites ACE Player_Inventory.cs source for the AttunedItem-drop emit site', () => {
      expect(block).toMatch(/Player_Inventory\.cs/);
      expect(block).toMatch(/AttunedItem/);
    });
  });
});
