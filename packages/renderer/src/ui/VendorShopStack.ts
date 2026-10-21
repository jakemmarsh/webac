/**
 * BUG.vendor-buy-quantity — the stack size a vendor's merchandise object
 * carries on the client while the shop is open.
 *
 * The ApproachVendor ItemProfile gives each shop object an `amount` (ACE
 * GameEventApproachVendor.cs:54 `VendorShopCreateListStackSize ?? StackSize
 * ?? 1`, -1 = unlimited supply) beside its PublicWeenieDesc, whose own
 * _stackSize is the weenie's (1 for a Prismatic Taper, wcid 20631:
 * StackSize 1, MaxStackSize 1000). Retail never shows the desc's 1: when the
 * shop list is built, VendorItemsUI::UpdateItemsList @ 004c1ea0 (decomp
 * 188214–188249) rewrites each object's _stackSize through
 * VendorSubUI::SetObjectStackSize @ 004c0490:
 *   - amount -1 (unlimited) and _maxStackSize > 1 → _maxStackSize;
 *   - a finite amount: what is left after the Buying list's entry for it
 *     (amount − queued; with an entry, < 1 → the object is left out of the
 *     shop list), then,
 *     when _maxStackSize > 1, min(that, _maxStackSize);
 *   - _maxStackSize ≤ 1 → the desc's own _stackSize is kept.
 * VendorItemsUI::RemoveFromShop @ 004c3ce0 (decomp 189784–189833) applies
 * the same rule after an Add to List.
 *
 * That object stack is what the toolbar reads: gmToolbarUI::
 * HandleSelectionChanged @ 004bf380 (decomp 185712–185761) shows the split
 * entry box 0x100001a3 and slider 0x100001a4 only for _stackSize ≥ 2, with
 * maxSplitSize = _stackSize. Reading the profile amount (-1) instead kept
 * the slider hidden for every unlimited stackable a vendor sells.
 */

export interface VendorShopStackInput {
  /** ItemProfile.amount (our merchandise row's `stackSize`): -1 = unlimited. */
  stackSize?: number;
  /** PublicWeenieDesc._maxStackSize (0 / undefined when not sent). */
  maxStackSize?: number;
  /** PublicWeenieDesc._stackSize (0 / undefined when not sent). */
  descStackSize?: number;
}

/**
 * The object's _stackSize after VendorItemsUI::UpdateItemsList, or null when
 * a finite stock is all on the Buying list (the row is left out). `queued` is
 * the Buying list's amount for this object (0 when absent).
 */
export function vendorShopStackSize(item: VendorShopStackInput, queued: number): number | null {
  const amount = item.stackSize;
  const max = item.maxStackSize ?? 0;
  // A row without a desc stack (test fixtures) keeps its listed amount as the
  // object stack, as a desc _stackSize equal to the amount would.
  const desc = item.descStackSize ?? (amount !== undefined && amount > 0 ? amount : 0);
  if (amount === undefined || amount === -1) {
    return max > 1 ? max : desc;
  }
  // Only an entry on the Buying list can empty the row (retail's `< 1` test
  // sits inside the buy-list match).
  const left = queued > 0 ? amount - queued : amount;
  if (queued > 0 && left < 1) return null;
  return max > 1 ? Math.min(left, max) : desc;
}
