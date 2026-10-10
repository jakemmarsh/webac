/**
 * RECON.vendor-price-formulas — retail's shop pricing (the decompiled EoL
 * client):
 *  - ShopSystem::SellPrice @ 006b6180 (what a vendor charges): the rate is
 *    1.15 for a promissory note (TYPE_PROMISSORY_NOTE 0x40000, .rdata
 *    0x3f933333), else the vendor's sell_price; ftol(ceil(rate * value *
 *    amount - SHOP_SYSTEM_EPSILON 0.1)), then 0 → 1 and < 1 → -1.
 *  - ShopSystem::BuyPrice @ 006b6120 (what a vendor pays): the rate is 1.0
 *    for a promissory note, else buy_price; ftol(floor(rate * value *
 *    amount + 0.1)), then 0 → 1 and < 0 → -1.
 *  - VendorProfile::VendorSellPrice @ 005d1b00: value = the desc's _value /
 *    _stackSize (integer division) when it has a stack size, × the amount.
 *  - VendorProfile::VendorBuyPrice @ 005d1b70: the WHOLE stack, value /
 *    stackSize × stackSize (or value × 1 without a stack size).
 * The products are single-precision floats (float × long → float).
 */
export const TYPE_PROMISSORY_NOTE = 0x40000;
export const SHOP_SYSTEM_EPSILON = 0.1;
const PROMISSORY_SELL_RATE = Math.fround(1.15);
const f = Math.fround;

export function shopSellPrice(value: number, itemType: number, rate: number, amount: number): number {
  const r = itemType === TYPE_PROMISSORY_NOTE ? PROMISSORY_SELL_RATE : f(rate);
  const p = Math.trunc(Math.ceil(f(f(f(r * f(value)) * f(amount)) - f(SHOP_SYSTEM_EPSILON))));
  if (p === 0) return 1;
  return p < 1 ? -1 : p;
}

export function shopBuyPrice(value: number, itemType: number, rate: number, amount: number): number {
  const r = itemType === TYPE_PROMISSORY_NOTE ? 1 : f(rate);
  const p = Math.trunc(Math.floor(f(f(f(r * f(value)) * f(amount)) + f(SHOP_SYSTEM_EPSILON))));
  if (p === 0) return 1;
  return p < 0 ? -1 : p;
}

/** A merchandise desc's per-unit value (PublicWeenieDesc _value / _stackSize, C integer division). */
export function unitValueOf(desc: { value: number; stackSize?: number }): number {
  const n = desc.stackSize ?? 0;
  return n !== 0 ? Math.trunc(desc.value / n) : desc.value;
}

/** VendorProfile::VendorSellPrice — `amount` units of a merchandise desc. */
export function vendorSellPrice(desc: { value: number; stackSize?: number; itemType: number }, sellRate: number, amount: number): number {
  return shopSellPrice(unitValueOf(desc), desc.itemType, sellRate, amount);
}

/** VendorProfile::VendorBuyPrice — the vendor's offer for a whole player-held stack. */
export function vendorBuyPrice(desc: { value: number; stackSize?: number; itemType: number }, buyRate: number): number {
  const n = desc.stackSize ?? 0;
  return shopBuyPrice(unitValueOf(desc), desc.itemType, buyRate, n !== 0 ? n : 1);
}
