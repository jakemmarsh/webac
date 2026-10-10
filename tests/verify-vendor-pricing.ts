/**
 * RECON.vendor-price-formulas — ShopSystem::SellPrice @ 006b6180 /
 * BuyPrice @ 006b6120 and VendorProfile::VendorSellPrice @ 005d1b00 /
 * VendorBuyPrice @ 005d1b70 (decompiled EoL client).
 */
import { describe, it, expect } from 'vitest';
import {
  shopSellPrice, shopBuyPrice, vendorSellPrice, vendorBuyPrice, unitValueOf, TYPE_PROMISSORY_NOTE,
} from '../packages/shared/src/inventory/vendorPricing.js';

describe('ShopSystem::SellPrice / BuyPrice', () => {
  it('sell: ceil(rate × value × amount − 0.1); buy: floor(rate × value × amount + 0.1)', () => {
    expect(shopSellPrice(100, 0x1, 1.25, 1)).toBe(125);
    expect(shopSellPrice(10, 0x1, 1.25, 3)).toBe(38);   // 37.5 − 0.1 → ceil 38
    expect(shopSellPrice(4, 0x1, 1.0, 1)).toBe(4);      // 3.9 → ceil 4 (the epsilon keeps exact values exact)
    expect(shopBuyPrice(100, 0x1, 0.75, 1)).toBe(75);
    expect(shopBuyPrice(10, 0x1, 0.75, 3)).toBe(22);    // 22.5 + 0.1 → floor 22
  });

  it('a result of 0 becomes 1 (a 1-pyreal item never sells or buys for nothing)', () => {
    expect(shopSellPrice(0, 0x1, 1.25, 1)).toBe(1);
    expect(shopBuyPrice(1, 0x1, 0.5, 1)).toBe(1);       // floor(0.6) = 0 → 1
  });

  it('promissory notes trade at fixed rates: the vendor sells them at 1.15, buys them at 1.0, whatever its own rates', () => {
    expect(shopSellPrice(100, TYPE_PROMISSORY_NOTE, 2.0, 1)).toBe(115);
    expect(shopBuyPrice(100, TYPE_PROMISSORY_NOTE, 0.3, 1)).toBe(100);
  });
});

describe('VendorProfile::VendorSellPrice / VendorBuyPrice', () => {
  it('per-unit value is _value / _stackSize (integer division); the vendor offer is for the whole stack', () => {
    expect(unitValueOf({ value: 1000, stackSize: 3 })).toBe(333);
    expect(unitValueOf({ value: 1000 })).toBe(1000);
    // 5 of a 100-stack worth 2000 (20 each) at 1.3: ceil(130 − 0.1) = 130
    expect(vendorSellPrice({ value: 2000, stackSize: 100, itemType: 0x80 }, 1.3, 5)).toBe(130);
    // the whole 3-stack worth 1000 at 0.9: floor(333 × 0.9 × 3 + 0.1) = 899 (not 900: the per-unit truncation)
    expect(vendorBuyPrice({ value: 1000, stackSize: 3, itemType: 0x80 }, 0.9)).toBe(899);
  });
});
