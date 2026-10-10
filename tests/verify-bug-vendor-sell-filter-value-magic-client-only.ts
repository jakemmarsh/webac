/**
 * BUG.vendor-sell-filter-value-magic-client-only
 *
 * ACE's actual sell-tab gate is VerifySellItems (Player_Commerce.cs:232-289),
 * called from HandleActionSellItem. It only rejects an item for
 * (acceptedItemTypes & wo.ItemType) == 0 (plus !IsSellable / Retained /
 * trade / non-empty-container, which this client doesn't model as
 * VendorItem fields) or wo.Value < 1. GameEventApproachVendor.cs:16-21 also
 * ships merchandiseMinValue, merchandiseMaxValue, and dealMagicalItems to
 * the client, but VerifySellItems never reads them — they're display/
 * pricing-only fields. Pre-fix, vendorSellRejectionReason (and both of
 * main.ts's sell-tab build sites) enforced a value range and a
 * magical-item restriction the real server never checks, hiding sellable
 * items from the client's sell tab that ACE would accept.
 *
 * The fix narrows vendorSellRejectionReason (packages/shared/src/npc/
 * VendorSystem.ts) to the two checks VerifySellItems actually performs —
 * this test drives that shipped function directly.
 */
import { describe, it, expect } from 'vitest';
import { vendorSellRejectionReason } from '@ac/shared';
import type { VendorConfig } from '@ac/shared';

const OPEN_ALL_TYPES: Pick<VendorConfig, 'merchandiseItemTypes'> = {
  merchandiseItemTypes: 0,
};

describe('BUG.vendor-sell-filter-value-magic-client-only — vendorSellRejectionReason', () => {
  it('accepts an item within an unrestricted config', () => {
    expect(vendorSellRejectionReason({ value: 500, itemType: 0x01 }, OPEN_ALL_TYPES)).toBeNull();
  });

  it('rejects an item type outside the merchandiseItemTypes bitmask', () => {
    const reason = vendorSellRejectionReason(
      { value: 500, itemType: 0x02 },
      { merchandiseItemTypes: 0x01 },
    );
    expect(reason).toMatch(/type of item/);
  });

  it('merchandiseItemTypes === 0 accepts any item type (matches matchesMerchandiseFilter)', () => {
    expect(vendorSellRejectionReason(
      { value: 500, itemType: 0xDEADBEEF },
      OPEN_ALL_TYPES,
    )).toBeNull();
  });

  it('rejects a valueless item with the "no value" message (VerifySellItems wo.Value < 1)', () => {
    const reason = vendorSellRejectionReason({ value: 0, itemType: 0x01 }, OPEN_ALL_TYPES);
    expect(reason).toMatch(/no value/);
  });

  it('accepts an item at the value === 1 floor', () => {
    expect(vendorSellRejectionReason({ value: 1, itemType: 0x01 }, OPEN_ALL_TYPES)).toBeNull();
  });

  it('checks item type before value so the most specific mismatch is reported first', () => {
    const reason = vendorSellRejectionReason(
      { value: 0, itemType: 0x02 },
      { merchandiseItemTypes: 0x01 },
    );
    expect(reason).toMatch(/type of item/);
  });

  it('does not reject on value alone regardless of magnitude — ACE has no merchandiseMaxValue gate', () => {
    expect(vendorSellRejectionReason({ value: 1_000_000, itemType: 0x01 }, OPEN_ALL_TYPES)).toBeNull();
  });

  it('does not accept a merchandiseMinValue/merchandiseMaxValue/dealMagicalItems field even if present on the config object — the gate ignores them', () => {
    // A caller passing a full VendorConfig (with the display-only fields still
    // populated) must see identical accept/reject behavior to one that only
    // has merchandiseItemTypes, since vendorSellRejectionReason no longer reads them.
    const fullConfig: VendorConfig = {
      vendorId: 1, name: 'Vendor', buyRate: 0.5, sellRate: 1.5,
      merchandiseItemTypes: 0, merchandiseMinValue: 5000, merchandiseMaxValue: 1,
      dealMagicalItems: false, openForBusiness: true, uniqueRotTime: 300,
    };
    // Would have been rejected pre-fix: value 2 is below the old
    // merchandiseMinValue=5000 floor and above merchandiseMaxValue=1.
    expect(vendorSellRejectionReason({ value: 2, itemType: 0x01 }, fullConfig)).toBeNull();
  });
});
