/**
 * CORE.10.d — GenItemHolder::splitSize consumers for drag gestures.
 *
 * Retail carries the toolbar split size into every drag of the SELECTED
 * stack; any other object always drags its full stack:
 *
 * - ItemHolder::GetObjectSplitSize @ 00586f00: the selected object's drag
 *   amount is GenItemHolder::splitSize; anything else is stackSize (0 → 1).
 * - ItemHolder::AttemptToPlaceInContainer @ 00588120: splitSize >=
 *   maxSplitSize → UIAttemptPutInContainer (a plain move), otherwise
 *   UIAttemptSplitToContainer(container, slot, splitSize).
 * - ACCWeenieObject::UIAttemptWield @ 0058d590: stackSize > 1 and
 *   splitSize != maxSplitSize → Event_StackableSplitToWield(splitSize),
 *   otherwise Event_GetAndWieldItem.
 * - ItemHolder::AttemptDrop3D (00588... region, UIAttemptSplitTo3D read at
 *   decomp line 377498): splitSize < maxSplitSize → UIAttemptSplitTo3D
 *   (StackableSplitTo3D), otherwise UIAttemptPutIn3D (DropItem).
 * - ItemHolder::AttemptMerge @ 005878f0: the merge amount is
 *   GetObjectSplitSize clamped to the room left in the target stack
 *   (maxStackSize - stackSize, stackSize 0 → 1).
 */

export interface ToolbarSplitState {
  /** GenItemHolder::splitSize — the amount the split entry box / slider holds. */
  splitSize: number;
  /** GenItemHolder::maxSplitSize — the selected stack's full size. */
  maxSplitSize: number;
}

export interface DragSplitDecision {
  /** How many of the stack this drag gesture carries. */
  amount: number;
  /**
   * True when the gesture is a partial split (splitSize < maxSplitSize on
   * the selected stack) — the consumer sends StackableSplitTo* instead of
   * the plain move/wield/drop action.
   */
  partial: boolean;
}

/**
 * Mirrors ItemHolder::GetObjectSplitSize plus the splitSize==maxSplitSize
 * comparisons its drag consumers make.
 *
 * @param itemId      guid of the dragged object
 * @param stackSize   the dragged object's stack size (0/1 = not a stack)
 * @param selectedId  ACCWeenieObject::selectedID (0 = nothing selected)
 * @param split       the toolbar's GenItemHolder::splitSize/maxSplitSize pair
 */
export function getObjectSplitSize(
  itemId: number,
  stackSize: number,
  selectedId: number,
  split: ToolbarSplitState,
): DragSplitDecision {
  const fullStack = Math.max(1, Math.floor(stackSize) || 1);
  // UIAttemptWield's `uVar1 != 0 && 1 < uVar1` gate: a non-stack never splits.
  if (fullStack < 2 || itemId !== selectedId) {
    return { amount: fullStack, partial: false };
  }
  const max = Math.max(1, Math.floor(split.maxSplitSize) || 1);
  const size = Math.min(max, Math.max(1, Math.floor(split.splitSize) || 1));
  return { amount: size, partial: size < max };
}

/**
 * Mirrors ItemHolder::AttemptMerge @ 005878f0's amount computation: the
 * drag amount (GetObjectSplitSize) clamped to the room left in the target
 * stack. Retail merges `min(dragAmount, maxStackSize - stackSize)` — a
 * target with no room merges 0 (IsMergeAttemptLegal rejects it upstream;
 * callers should treat 0 as "don't send").
 */
export function getMergeAmount(
  dragAmount: number,
  targetStackSize: number,
  targetMaxStackSize: number,
): number {
  const tgtSize = Math.max(1, Math.floor(targetStackSize) || 1);
  const room = Math.max(0, Math.floor(targetMaxStackSize) - tgtSize);
  return Math.min(Math.max(0, Math.floor(dragAmount)), room);
}
