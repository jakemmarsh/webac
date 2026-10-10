/**
 * BUG.deleted-item-stays-in-pack — ACE's ConsumeItem removal (@delete, an
 * expiring lifespan item) sends DeleteObject with no InventoryRemoveObject;
 * the held item must leave the pack (retail SmartBox::HandleDeleteObject
 * @ 00451ea0 destroys the weenie). Found 2026-10-01 when 17 @delete'd
 * harness items stayed listed until relog.
 */
import { describe, it, expect } from 'vitest';
import { InventoryManager } from '@ac/shared';
import { dropDeletedOwnedItem } from '../packages/renderer/src/player/deletedOwnedItem.js';

const item = (name: string) => ({ weenieClassId: 166, name, value: 0, burden: 0, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x50000003 });

describe('DeleteObject for a held item', () => {
  it('drops it from the pack; other items and unknown guids are untouched', () => {
    const inv = new InventoryManager();
    inv.addItem(item('Sack'), 0x800014be);
    inv.addItem(item('Other Sack'), 0x800014bf);
    expect(dropDeletedOwnedItem(inv, 0x800014be)).toBe(true);
    expect(inv.getItem(0x800014be)).toBeUndefined();
    expect(inv.getItem(0x800014bf)?.name).toBe('Other Sack');
    expect(dropDeletedOwnedItem(inv, 0x80009999)).toBe(false); // a world object's delete
    expect(inv.getAll()).toHaveLength(1);
  });
});
