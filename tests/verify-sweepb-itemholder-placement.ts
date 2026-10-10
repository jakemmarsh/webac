/**
 * SWEEP1006B placement — retail's ItemHolder placement path, ported in
 * packages/renderer/src/inventory/ItemHolderPlacement.ts:
 *   CPlayerSystem::PlaceInBackpack @ 0055d8c0,
 *   ItemHolder::AttemptToPlaceInContainer @ 00588140 (auto-merge, then the
 *     requested → holder → holder's packs fit fallback, then the 0x1a
 *     "completely full" line with nothing sent),
 *   ItemHolder::AttemptAutoMerge @ 00587c40, AttemptMerge @ 005878f0,
 *   ItemHolder::WillItemFitInContainer @ 00587d60,
 *   UIElement_ItemList::AcceptDragObject @ 004e4250,
 *   ItemHolder::CheckHookStatus @ 00586e90 + its callers (_IsContainerLegal
 *     @ 005879b0, WillItemFitInContainer, AttemptToPlaceInContainer) and
 *     gmExternalContainerUI::DragItemAcceptable @ 004cbb60.
 * Findings: SWEEP1006B.ui-panels.taking-unequipping-item-always-sends,
 * .attemptautomerge-looted-picked-up-stacks, .placing-item-full-pack-has.
 */
import { describe, it, expect } from 'vitest';
import {
  attemptToPlaceInContainer, attemptAutoMerge, willItemFitInContainer, placeInBackpack,
  acceptItemListDrop, exhaustiveContainedItems, placementFullNotice, PLACEMENT_FULL_STRINGS,
  checkHookStatus, externalContainerDragAcceptable, isContainerLegal, CONTAINER_LEGAL_STRINGS,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { makeWorld, pack, filler, PLAYER } from './_harness/placementWorld.js';

const SIDE = 0x80000100;
const SIDE2 = 0x80000200;
const GROUND = 0x70000001;
const WORN = 0x80000999;

describe('PlaceInBackpack (CPlayerSystem::PlaceInBackpack → AttemptToPlaceInContainer)', () => {
  it('sends to the shown side pack when MainPackPreferred is off', () => {
    const w = makeWorld([pack(SIDE, 24), { id: GROUND }]);
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('sends to the main pack when MainPackPreferred is on, or no side pack is shown', () => {
    const w = makeWorld([pack(SIDE, 24), { id: GROUND }]);
    expect(placeInBackpack(GROUND, SIDE, true, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
    expect(placeInBackpack(GROUND, 0, false, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
  });

  it('a worn item (no container) is placed in the shown pack too — the unwield path', () => {
    const w = makeWorld([pack(SIDE, 24), { id: WORN, name: 'Helm' }]);
    expect(placeInBackpack(WORN, SIDE, false, w)).toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('a full shown pack falls back to the main pack, then the first side pack with room', () => {
    const w = makeWorld([pack(SIDE, 2), ...filler(SIDE, 2, 0x80001000), { id: GROUND }]);
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });

    const w2 = makeWorld([
      pack(SIDE, 2), ...filler(SIDE, 2, 0x80001000),
      pack(SIDE2, 5, 'Sack'), ...filler(PLAYER, 3, 0x80002000), { id: GROUND },
    ], { playerItems: 3 });
    expect(placeInBackpack(GROUND, SIDE, false, w2)).toEqual({ kind: 'put', containerId: SIDE2, placement: 0 });
  });

  it('no room anywhere: nothing is sent and the player\'s "%s is completely full!" line shows', () => {
    const w = makeWorld([pack(SIDE, 1), ...filler(SIDE, 1, 0x80001000), ...filler(PLAYER, 2, 0x80002000), { id: GROUND }], { playerItems: 2 });
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'refused', notice: 'Tester is completely full!' });
  });

  it('a container that will not fit uses the "can carry no more containers" line', () => {
    const w = makeWorld([pack(SIDE, 24), { id: 0x70000002, isContainer: true, holder: true, itemsCapacity: 24, name: 'Sack' }], { playerContainers: 1 });
    expect(placeInBackpack(0x70000002, 0, false, w)).toEqual({ kind: 'refused', notice: 'Tester can carry no more containers!' });
  });

  it('a partial toolbar split goes StackableSplitToContainer', () => {
    const w = makeWorld([pack(SIDE, 24), { id: GROUND, stackSize: 10, maxStackSize: 100 }], { splitSize: 4, maxSplitSize: 10, selectedId: GROUND });
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'split', containerId: SIDE, placement: 0, amount: 4 });
  });
});

describe('AttemptAutoMerge (ItemHolder::AttemptAutoMerge @ 00587c40)', () => {
  const stack = (id: number, holder: number, stackSize: number, wcid = 300, max = 250) =>
    ({ id, in: holder, weenieClassId: wcid, stackSize, maxStackSize: max });

  it('a picked-up stack merges into the first carried stack with room (main pack first, then side packs)', () => {
    const w = makeWorld([pack(SIDE, 24), stack(0x80003001, SIDE, 10), stack(0x80003002, PLAYER, 20), { ...stack(GROUND, 0, 5), in: undefined }],
      { splitSize: 5, maxSplitSize: 5, selectedId: GROUND });
    expect(exhaustiveContainedItems(PLAYER, w)).toEqual([0x80003002, 0x80003001]);
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'merge', targetId: 0x80003002, amount: 5 });
  });

  it('the room test uses the toolbar split size; the amount is capped at the room', () => {
    // The target has room 3; splitSize 5 > 3 → not eligible → placed instead.
    const w = makeWorld([stack(0x80003002, PLAYER, 247), stack(GROUND, 0, 5)], { splitSize: 5, maxSplitSize: 5, selectedId: GROUND });
    expect(attemptAutoMerge(GROUND, PLAYER, w)).toBeNull();
    // Not the selected object: splitSize 1 qualifies, the whole stack (5) is sent, capped at room 3.
    const w2 = makeWorld([stack(0x80003002, PLAYER, 247), stack(GROUND, 0, 5)], { splitSize: 1, maxSplitSize: 1 });
    expect(attemptAutoMerge(GROUND, PLAYER, w2)).toEqual({ kind: 'merge', targetId: 0x80003002, amount: 3 });
  });

  it('skips different weenies, full stacks, traded stacks and non-stackables', () => {
    const w = makeWorld([
      stack(0x80003001, PLAYER, 10, 999),
      stack(0x80003002, PLAYER, 250),
      { ...stack(0x80003003, PLAYER, 10), inTrade: true },
      stack(GROUND, 0, 5),
    ]);
    expect(attemptAutoMerge(GROUND, PLAYER, w)).toBeNull();
    const single = makeWorld([{ id: 0x80003004, in: PLAYER, weenieClassId: 7 }, { id: GROUND, weenieClassId: 7 }]);
    expect(attemptAutoMerge(GROUND, single.playerId, single)).toBeNull();
  });

  it('an item already carried never merges with itself', () => {
    const w = makeWorld([stack(0x80003001, PLAYER, 10)]);
    expect(attemptAutoMerge(0x80003001, PLAYER, w)).toBeNull();
  });
});

describe('WillItemFitInContainer (@ 00587d60)', () => {
  it('a full pack still fits an object already inside when the split is the whole stack', () => {
    const w = makeWorld([pack(SIDE, 1), { id: 0x80001000, in: SIDE, stackSize: 10, maxStackSize: 100 }]);
    expect(willItemFitInContainer(0x80001000, SIDE, w)).toBe(true);
    expect(willItemFitInContainer(GROUND, SIDE, w)).toBe(false);
    const partial = makeWorld([pack(SIDE, 1), { id: 0x80001000, in: SIDE, stackSize: 10, maxStackSize: 100 }], { splitSize: 3, maxSplitSize: 10 });
    expect(willItemFitInContainer(0x80001000, SIDE, partial)).toBe(false);
  });

  it('refuses a non-holder, the item itself and a pack being traded; -1 is unlimited', () => {
    const w = makeWorld([{ id: 0x80004000, in: PLAYER }, { ...pack(SIDE, 24), inTrade: true }, { ...pack(SIDE2, -1), in: PLAYER }, ...filler(SIDE2, 300, 0x80005000)]);
    expect(willItemFitInContainer(GROUND, 0x80004000, w)).toBe(false);
    expect(willItemFitInContainer(SIDE, SIDE, w)).toBe(false);
    expect(willItemFitInContainer(0x80004000, SIDE, w)).toBe(false);
    expect(willItemFitInContainer(0x80004000, SIDE2, w)).toBe(true);
  });
});

describe('AttemptToPlaceInContainer\'s full lines (acclient.exe .rdata)', () => {
  it('the player\'s name has no article; a pack\'s does', () => {
    expect(PLACEMENT_FULL_STRINGS).toEqual({
      playerItems: '%s is completely full!', playerContainers: '%s can carry no more containers!',
      items: 'The %s is completely full!', containers: 'The %s can fit no more containers!',
    });
    const w = makeWorld([pack(SIDE, 0, 'Bag')]);
    expect(placementFullNotice(w.object(SIDE)!, false)).toBe('The Bag is completely full!');
    expect(placementFullNotice(w.object(SIDE)!, true)).toBe('The Bag can fit no more containers!');
  });

  it('an invalid requested container is ignored (treated as 0)', () => {
    const w = makeWorld([{ id: 0x80004000, in: PLAYER }, { id: GROUND }]);
    expect(attemptToPlaceInContainer(GROUND, PLAYER, 0x80004000, false, 0, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
  });
});

describe('AcceptDragObject (UIElement_ItemList @ 004e4250)', () => {
  const stack = (id: number, holder: number, stackSize: number) => ({ id, in: holder, weenieClassId: 300, stackSize, maxStackSize: 250 });

  it('a worn item dropped on a plain cell of the shown pack lands there at the cell', () => {
    const w = makeWorld([pack(SIDE, 24), { id: 0x80001000, in: SIDE }, { id: WORN }]);
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: 0x80001000, listContainerId: SIDE, cellPlacement: 0, containerList: false }, w))
      .toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('an empty cell places into the list\'s pack at the end slot', () => {
    const w = makeWorld([pack(SIDE, 24), { id: 0x80001000, in: SIDE }, { id: WORN }]);
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: 0, listContainerId: SIDE, cellPlacement: 1, containerList: false }, w))
      .toEqual({ kind: 'put', containerId: SIDE, placement: 1 });
  });

  it('a same-weenie stack merges onto the cell (never a use)', () => {
    const w = makeWorld([stack(0x80001000, PLAYER, 10), stack(0x80001001, PLAYER, 20)]);
    expect(acceptItemListDrop({ itemId: 0x80001000, cellItemId: 0x80001001, listContainerId: PLAYER, cellPlacement: 1, containerList: false }, w))
      .toEqual({ kind: 'merge', targetId: 0x80001001, amount: 10 });
  });

  it('a pack cell (or a pack-column slot) takes the item into that pack with auto-merge within it, placement 0', () => {
    const w = makeWorld([pack(SIDE, 24), stack(0x80001000, SIDE, 10), stack(0x80001001, PLAYER, 20), stack(0x80001002, PLAYER, 5)]);
    // Auto-merge searches the DROPPED-ON pack only: the 0x80001002 stack merges into the pack's stack.
    expect(acceptItemListDrop({ itemId: 0x80001002, cellItemId: SIDE, listContainerId: PLAYER, cellPlacement: 3, containerList: true }, w))
      .toEqual({ kind: 'merge', targetId: 0x80001000, amount: 5 });
    const w2 = makeWorld([pack(SIDE, 24), { id: WORN }]);
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: SIDE, listContainerId: PLAYER, cellPlacement: 1, containerList: true }, w2))
      .toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('a drop on a full side pack refuses with "The %s is completely full!" and sends nothing', () => {
    const w = makeWorld([pack(SIDE, 1, 'Bag'), ...filler(SIDE, 1, 0x80001000), { id: WORN }]);
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: SIDE, listContainerId: PLAYER, cellPlacement: 0, containerList: true }, w))
      .toEqual({ kind: 'refused', notice: 'The Bag is completely full!' });
  });

  it('a full main pack grid falls back to the side packs (AttemptToPlaceInContainer with no preferred pack)', () => {
    const w = makeWorld([pack(SIDE, 24), ...filler(PLAYER, 2, 0x80002000), { id: GROUND }], { playerItems: 2 });
    expect(acceptItemListDrop({ itemId: GROUND, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 2, containerList: false }, w))
      .toEqual({ kind: 'put', containerId: SIDE, placement: 2 });
  });

  it('the retail refusals: container in item list, item in container list, a container that holds no items', () => {
    const w = makeWorld([pack(SIDE, 24), { id: 0x80006000, in: PLAYER, isContainer: true, name: 'Focus' }, { id: WORN }]);
    expect(acceptItemListDrop({ itemId: SIDE, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 0, containerList: false }, w))
      .toEqual({ kind: 'refused', notice: 'Cannot place container in item list' });
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 0, containerList: true }, w))
      .toEqual({ kind: 'refused', notice: 'Cannot place item in container list' });
    expect(acceptItemListDrop({ itemId: WORN, cellItemId: 0x80006000, listContainerId: PLAYER, cellPlacement: 0, containerList: false }, w))
      .toEqual({ kind: 'refused', notice: 'The Focus cannot accept items' });
  });
});

describe('House hooks (ItemHolder::CheckHookStatus @ 00586e90 and its callers)', () => {
  const HOOK = 0x70000100;
  const ITEM = 0x80007000;
  const OWNER = 0x50000002;
  // ITEM_TYPE: TYPE_MISC 0x80, TYPE_ARMOR 0x2, TYPE_CONTAINER 0x200.
  const hook = (over: Partial<{ hookType: number; hookItemTypes: number; houseOwnerId: number }> = {}) => ({
    id: HOOK, name: 'Floor Hook', holder: true, isContainer: true, itemsCapacity: 1,
    hookType: 1, hookItemTypes: 0x80 | 0x2, houseOwnerId: OWNER, ...over,
  });
  const item = (over: Partial<{ hookType: number; itemType: number }> = {}) =>
    ({ id: ITEM, in: PLAYER, name: 'Statue', hookType: 1 | 4, itemType: 0x80, ...over });

  it('a container that is not a hook (hook_type 0 or hook_item_types 0) accepts', () => {
    const w = makeWorld([pack(SIDE, 24), item()]);
    expect(checkHookStatus(w.object(ITEM), w.object(SIDE))).toEqual({ ok: true, noOwner: false });
    const half = makeWorld([hook({ hookItemTypes: 0 }), item({ hookType: 0 })]);
    expect(checkHookStatus(half.object(ITEM), half.object(HOOK))).toEqual({ ok: true, noOwner: false });
    expect(attemptToPlaceInContainer(ITEM, SIDE, 0, false, 0, w)).toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('either object unknown → refused, no owner flag', () => {
    const w = makeWorld([hook()]);
    expect(checkHookStatus(undefined, w.object(HOOK))).toEqual({ ok: false, noOwner: false });
    expect(checkHookStatus(w.object(HOOK), undefined)).toEqual({ ok: false, noOwner: false });
  });

  it('an unowned hook refuses with the hook line plus the ownership sentence', () => {
    const w = makeWorld([hook({ houseOwnerId: 0 }), item()]);
    expect(checkHookStatus(w.object(ITEM), w.object(HOOK))).toEqual({ ok: false, noOwner: true });
    expect(CONTAINER_LEGAL_STRINGS.hook).toBe('That item cannot be placed on the hook.');
    expect(CONTAINER_LEGAL_STRINGS.hookNoOwner).toBe(' You must own the house to manipulate the hook.');
    expect(attemptToPlaceInContainer(ITEM, HOOK, 0, false, 0, w)).toEqual({
      kind: 'refused', notice: 'That item cannot be placed on the hook. You must own the house to manipulate the hook.',
    });
    expect(willItemFitInContainer(ITEM, HOOK, w)).toBe(false);
  });

  it('an owned hook accepts an item whose hook_type overlaps and whose ITEM_TYPE it takes', () => {
    const w = makeWorld([hook(), item()]);
    expect(checkHookStatus(w.object(ITEM), w.object(HOOK))).toEqual({ ok: true, noOwner: false });
    expect(willItemFitInContainer(ITEM, HOOK, w)).toBe(true);
    expect(attemptToPlaceInContainer(ITEM, HOOK, 0, false, 0, w)).toEqual({ kind: 'put', containerId: HOOK, placement: 0 });
  });

  it('refuses a hook_type mismatch, a hookless item, or an ITEM_TYPE outside hook_item_types — the bare hook line', () => {
    const line = { kind: 'refused', notice: 'That item cannot be placed on the hook.' };
    for (const over of [{ hookType: 2 }, { hookType: 0 }, { itemType: 0x200 }]) {
      const w = makeWorld([hook(), item(over)]);
      expect(checkHookStatus(w.object(ITEM), w.object(HOOK))).toEqual({ ok: false, noOwner: false });
      expect(willItemFitInContainer(ITEM, HOOK, w)).toBe(false);
      expect(attemptToPlaceInContainer(ITEM, HOOK, 0, false, 0, w)).toEqual(line);
    }
  });

  it('a requested hook that refuses the item is dropped back to the holder (PlaceInBackpack-style request)', () => {
    const w = makeWorld([hook({ houseOwnerId: 0 }), item()]);
    expect(attemptToPlaceInContainer(ITEM, PLAYER, HOOK, false, 0, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
  });

  it('_IsContainerLegal: its other gates, in retail order, and quiet mode stays silent', () => {
    const w = makeWorld([
      hook({ houseOwnerId: 0 }), item(),
      { id: 0x70000200, name: 'Chest', isContainer: true, itemsCapacity: 10 },
      { ...pack(SIDE, 24, 'Bag'), inTrade: true },
    ]);
    expect(isContainerLegal(ITEM, 0x7000ffff, false, w)).toEqual({ ok: false, notice: 'The destination container is not valid!' });
    expect(isContainerLegal(ITEM, ITEM, false, w)).toEqual({ ok: false, notice: 'You cannot place an object within itself!' });
    expect(isContainerLegal(ITEM, 0x70000200, false, w)).toEqual({ ok: false, notice: 'The Chest is locked' });
    expect(isContainerLegal(ITEM, SIDE, false, w)).toEqual({ ok: false, notice: 'The Bag is being traded' });
    expect(isContainerLegal(ITEM, HOOK, true, w)).toEqual({ ok: false });
    expect(isContainerLegal(ITEM, PLAYER, false, w)).toEqual({ ok: true });
  });

  it('gmExternalContainerUI::DragItemAcceptable', () => {
    const w = makeWorld([hook(), item(), { id: ITEM + 1, hookType: 1, itemType: 0x200 }]);
    expect(externalContainerDragAcceptable(0, undefined, undefined)).toBe(true);
    expect(externalContainerDragAcceptable(HOOK, undefined, w.object(ITEM))).toBe(true);
    expect(externalContainerDragAcceptable(HOOK, w.object(HOOK), undefined)).toBe(false);
    expect(externalContainerDragAcceptable(HOOK, w.object(HOOK), w.object(ITEM))).toBe(true);
    expect(externalContainerDragAcceptable(HOOK, w.object(HOOK), w.object(ITEM + 1))).toBe(false);
    const unowned = makeWorld([hook({ houseOwnerId: 0 }), item()]);
    expect(externalContainerDragAcceptable(HOOK, unowned.object(HOOK), unowned.object(ITEM))).toBe(false);
    const chest = makeWorld([{ id: 0x70000200, holder: true, isContainer: true, itemsCapacity: 10 }, item()]);
    expect(externalContainerDragAcceptable(0x70000200, chest.object(0x70000200), chest.object(ITEM))).toBe(true);
  });
});
