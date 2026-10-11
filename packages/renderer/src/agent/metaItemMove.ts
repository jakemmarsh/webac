/**
 * UtilityBelt's actiontrymove / actiontrysplit (docs/vtank-parity-gaps.md
 * §5.1): what the client sends to put an item (or part of a stack) into a
 * container. The same three requests a drag sends (ItemHolderPlacement's
 * PlacementResult): a merge onto a stack of the same thing already there
 * (StackableMerge), a split into a slot (StackableSplitToContainer), or the
 * whole item into a slot (PutItemInContainer).
 */
import type { PlacementResult } from '../inventory/ItemHolderPlacement.ts';

export interface MoveItem { id: number; wcid: number; stack: number; maxStack: number }

/**
 * `amount` null moves the whole item; a number splits that many off (the
 * whole item when it is the stack or more). With `joinStack`, the moved part
 * joins a stack of the same weenie in the container that has room.
 */
export function metaMovePlan(item: MoveItem, containerId: number, slot: number, amount: number | null, joinStack: boolean, contents: MoveItem[]): PlacementResult {
  const stack = Math.max(1, item.stack);
  const n = amount === null ? stack : Math.trunc(amount);
  if (n < 1) return { kind: 'refused' };
  if (joinStack && item.maxStack > 1 && item.wcid) {
    const onto = contents.find((o) => o.id !== item.id && o.wcid === item.wcid && o.stack < o.maxStack);
    if (onto) return { kind: 'merge', targetId: onto.id, amount: Math.min(n, onto.maxStack - onto.stack) };
  }
  if (n < stack) return { kind: 'split', containerId, placement: slot, amount: n };
  return { kind: 'put', containerId, placement: slot };
}
