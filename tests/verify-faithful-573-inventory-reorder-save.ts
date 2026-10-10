/**
 * FAITHFUL.573 — save-side complement to FAITHFUL.572. The drag-drop
 * handler `onDropToInventory(itemIndex, targetIndex)` in main.ts was a
 * pre-fix no-op with a comment "Reordering within inventory — no-op for
 * now (items are unordered in AC)" — outright wrong: ACE persists
 * `PlacementPosition` for every inventory item via
 * `reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionPutItemInContainer.cs:9-13`:
 *
 *   var itemGuid = message.Payload.ReadUInt32();
 *   var containerGuid = message.Payload.ReadUInt32();
 *   var placement = message.Payload.ReadInt32();
 *   session.Player.HandleActionPutItemInContainer(itemGuid, containerGuid, placement);
 *
 * Without the SAVE side wired, the user could drag items around the
 * grid but no network call fired and the next CreateObject re-emit
 * (at login) clobbered the layout back to arrival order — exactly the
 * gap FAITHFUL.572 fixed on the LOAD side.
 *
 * The fix:
 * 1. InventoryManager.reorderItem(itemId, newIndex) does an optimistic
 *    local placement update so the grid redraws immediately.
 * 2. main.ts's item-list drop (SWEEP1006B: the AcceptDragObject port)
 *    ships PutItemInContainer with the cell's placement in the list's
 *    container.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InventoryManager } from '@ac/shared';
import { acceptItemListDrop } from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { makeWorld, PLAYER } from './_harness/placementWorld.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const INV_MGR = readFileSync(resolve(REPO, 'packages/shared/src/inventory/InventoryManager.ts'), 'utf-8');
const ACE_PUT = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionPutItemInContainer.cs'), 'utf-8');

/* ================================================================ */
/*  InventoryManager.reorderItem                                     */
/* ================================================================ */

describe('FAITHFUL.573 — InventoryManager.reorderItem', () => {
  it('reorderItem method is exposed', () => {
    expect(INV_MGR).toMatch(/reorderItem\(itemId:\s*number,\s*newIndex:\s*number\)/);
  });

  it('docblock cites the ACE handler line range', () => {
    expect(INV_MGR).toMatch(/GameActionPutItemInContainer\.cs:9-13/);
  });

  it('moves an item from its current index to a new index', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 401);
    const bId = inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 402);
    const cId = inv.addItem({ weenieClassId: 1, name: 'C', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 403);
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'B', 'C']);
    // Move A (index 0) to index 2 — should become B, C, A
    inv.reorderItem(aId, 2);
    expect(inv.getAll().map(i => i.name)).toEqual(['B', 'C', 'A']);
    // Move A (now at index 2) back to index 0
    inv.reorderItem(aId, 0);
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'B', 'C']);
    // Verify all 3 IDs are still present
    expect([aId, bId, cId].every(id => inv.getItem(id) !== undefined)).toBe(true);
  });

  it('clamps newIndex into valid range (does not throw on out-of-bounds)', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 501);
    inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                  stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 502);
    // newIndex > length-1 → clamped to length-1
    inv.reorderItem(aId, 99);
    expect(inv.getAll().map(i => i.name)).toEqual(['B', 'A']);
    // newIndex < 0 → clamped to 0
    inv.reorderItem(aId, -5);
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'B']);
  });

  it('no-op when fromIndex == newIndex (after clamp)', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 601);
    inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                  stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 602);
    inv.reorderItem(aId, 0); // already at 0
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'B']);
  });

  it('silently no-ops when itemId is not in the inventory', () => {
    const inv = new InventoryManager();
    inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                  stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 701);
    expect(() => inv.reorderItem(999, 0)).not.toThrow();
    expect(inv.getAll().map(i => i.name)).toEqual(['A']);
  });

  it('preserves the existing PlacementPosition for items not moved', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 801);
    const bId = inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 802);
    const cId = inv.addItem({ weenieClassId: 1, name: 'C', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 803);
    // Start from a server-supplied order C, A, B
    inv.setPlacementOrder([cId, aId, bId]);
    expect(inv.getAll().map(i => i.name)).toEqual(['C', 'A', 'B']);
    // Drag A (index 1) to slot 0 — should become A, C, B
    inv.reorderItem(aId, 0);
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'C', 'B']);
  });
});

/* ================================================================ */
/*  The item-on-item drop is AcceptDragObject: merge or place        */
/* ================================================================ */

// SWEEP1006B: the drop runs the UIElement_ItemList::AcceptDragObject @
// 004e4250 port (inventory/ItemHolderPlacement.ts). It merges onto a
// same-weenie stack or places the item at the cell; it is never a
// UseWithTarget (the earlier source-text pins asserted a combine gesture
// retail never had).
describe('item-on-item drop (AcceptDragObject) — merge or place, never use', () => {
  it('two stacks of the same weenie merge (StackableMerge)', () => {
    const w = makeWorld([
      { id: 0x80001000, in: PLAYER, weenieClassId: 300, stackSize: 10, maxStackSize: 250 },
      { id: 0x80001001, in: PLAYER, weenieClassId: 300, stackSize: 20, maxStackSize: 250 },
    ]);
    expect(acceptItemListDrop({ itemId: 0x80001000, cellItemId: 0x80001001, listContainerId: PLAYER, cellPlacement: 1, containerList: false }, w))
      .toEqual({ kind: 'merge', targetId: 0x80001001, amount: 10 });
  });

  it('any other pair places the dropped item at the cell (PutItemInContainer with that placement)', () => {
    const w = makeWorld([{ id: 0x80001000, in: PLAYER }, { id: 0x80001001, in: PLAYER }, { id: 0x80001002, in: PLAYER }]);
    expect(acceptItemListDrop({ itemId: 0x80001002, cellItemId: 0x80001000, listContainerId: PLAYER, cellPlacement: 0, containerList: false }, w))
      .toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
  });
});

/* ================================================================ */
/*  ACE source anchor — UseWithTarget + StackableMerge wire formats   */
/* ================================================================ */

const ACE_USEWITH = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionUseWithTarget.cs');
const ACE_MERGE = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionStackableMerge.cs');

describe('GAP — ACE source anchors the combine wire formats', () => {
  it('GameActionUseWithTarget reads sourceGuid + targetGuid', () => {
    const src = readFileSync(ACE_USEWITH, 'utf-8');
    expect(src).toMatch(/ReadUInt32\(\)/);
    expect(src).toMatch(/HandleActionUseWithTarget/);
  });

  it('GameActionStackableMerge reads mergeFromGuid + mergeToGuid + amount', () => {
    const src = readFileSync(ACE_MERGE, 'utf-8');
    expect(src).toMatch(/mergeFromGuid = message\.Payload\.ReadUInt32\(\)/);
    expect(src).toMatch(/mergeToGuid = message\.Payload\.ReadUInt32\(\)/);
    expect(src).toMatch(/amount = message\.Payload\.ReadInt32\(\)/);
  });

  // PutItemInContainer remains the wire format for equip/container moves.
  it('GameActionPutItemInContainer.cs still anchors itemGuid+containerGuid+placement (used elsewhere)', () => {
    expect(ACE_PUT).toMatch(/var placement = message\.Payload\.ReadInt32\(\)/);
  });
});
