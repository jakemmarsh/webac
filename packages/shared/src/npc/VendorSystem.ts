/**
 * VendorSystem — the vendor data the ApproachVendor event ships, and the
 * client-side sell-tab gate. Pricing and stock are server-authoritative
 * (ACE.Server/WorldObjects/Vendor.cs, Player_Commerce.cs).
 */

// ─── Types ──────────────────────────────────────────────────

export interface VendorItem {
  weenieClassId: number;
  name: string;
  value: number;            // base item value
  burden: number;
  stackSize: number;
  maxStackSize: number;
  isUnique: boolean;        // player-sold items
  uniqueExpiry?: number;    // timestamp when unique items expire
  itemType: number;         // ItemType flags for filtering
  isMagical: boolean;
}

export interface VendorConfig {
  vendorId: number;
  name: string;
  buyRate: number;          // PropertyFloat.BuyPrice — multiplier when player sells
  sellRate: number;         // PropertyFloat.SellPrice — multiplier when player buys
  merchandiseItemTypes: number;   // bitmask of allowed item types
  merchandiseMinValue: number;
  merchandiseMaxValue: number;
  dealMagicalItems: boolean;
  openForBusiness: boolean;
  alternateCurrencyWcid?: number; // custom currency WCID
  uniqueRotTime: number;         // seconds before unique items expire (default 300)
}

/** ACE Player_Commerce.cs VerifySellItems: an item must be worth >= 1 to sell. */
const MIN_COST = 1;

/**
 * Evaluate the sell-side gate ACE's VerifySellItems actually enforces
 * (Player_Commerce.cs:262-289): item-type acceptance mask, then a
 * hardcoded value >= 1 floor. GameEventApproachVendor.cs:16-21 also ships
 * merchandiseMinValue/merchandiseMaxValue/dealMagicalItems to the client,
 * but VerifySellItems never reads them — they're display/pricing-only
 * fields, not sell-tab filter criteria. Returns null if the vendor will
 * buy the item, or the rejection reason otherwise.
 *
 * Used by the client's sell-tab population (main.ts), which builds
 * candidate rows directly from the player's inventory.
 */
export function vendorSellRejectionReason(
  item: Pick<VendorItem, 'value' | 'itemType'>,
  config: Pick<VendorConfig, 'merchandiseItemTypes'>,
): string | null {
  if (config.merchandiseItemTypes !== 0 && (item.itemType & config.merchandiseItemTypes) === 0) {
    return 'Vendor does not buy this type of item.';
  }
  if (item.value < MIN_COST) {
    return 'This item has no value and cannot be sold.';
  }
  return null;
}
