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
 *
 * The trade-note rates are the era client's (PromissoryNoteRates). The 1999
 * client.exe (VTE-1): ShopSystem_SellPrice @ 0x005f3ce0 charges a flat 1.1;
 * ShopSystem_BuyPrice @ 0x005f3c70 pays 1.0 when the note's issuing vendor
 * (PublicWeenieDesc header 0x200000, the issuer's wcid) is the vendor's own
 * wcid (VendorProfile_VendorBuyPrice @ 0x005e19c0), else 0.8; both clamp to
 * max(1, p). The AC1999 server charges and pays the same (Vendor.h:9-11).
 */
export const TYPE_PROMISSORY_NOTE = 0x40000;
export const SHOP_SYSTEM_EPSILON = 0.1;
const f = Math.fround;

/** What a vendor charges for a trade note, and pays back for one it issued or another vendor did. */
export interface PromissoryNoteRates {
  sell: number;
  issuerBuy: number;
  foreignBuy: number;
}
/** End of retail (and the classic eras' end-of-retail exe): 1.15 to buy, face value back anywhere. */
export const PROMISSORY_NOTE_RATES_EOR: PromissoryNoteRates = Object.freeze({ sell: 1.15, issuerBuy: 1, foreignBuy: 1 });
/** The 1999 client.exe: 1.1 to buy, face value back at the issuing vendor, 80% anywhere else. */
export const PROMISSORY_NOTE_RATES_1999: PromissoryNoteRates = Object.freeze({ sell: 1.1, issuerBuy: 1, foreignBuy: 0.8 });

export function shopSellPrice(value: number, itemType: number, rate: number, amount: number, notes: PromissoryNoteRates = PROMISSORY_NOTE_RATES_EOR): number {
  const r = itemType === TYPE_PROMISSORY_NOTE ? f(notes.sell) : f(rate);
  const p = Math.trunc(Math.ceil(f(f(f(r * f(value)) * f(amount)) - f(SHOP_SYSTEM_EPSILON))));
  if (p === 0) return 1;
  return p < 1 ? -1 : p;
}

/** `isIssuer`: the note's issuing vendor is this vendor (always true outside 1999, where both rates are 1). */
export function shopBuyPrice(value: number, itemType: number, rate: number, amount: number, notes: PromissoryNoteRates = PROMISSORY_NOTE_RATES_EOR, isIssuer = true): number {
  const r = itemType === TYPE_PROMISSORY_NOTE ? f(isIssuer ? notes.issuerBuy : notes.foreignBuy) : f(rate);
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
export function vendorSellPrice(desc: { value: number; stackSize?: number; itemType: number }, sellRate: number, amount: number, notes: PromissoryNoteRates = PROMISSORY_NOTE_RATES_EOR): number {
  return shopSellPrice(unitValueOf(desc), desc.itemType, sellRate, amount, notes);
}

/** VendorProfile::VendorBuyPrice — the vendor's offer for a whole player-held stack. */
export function vendorBuyPrice(desc: { value: number; stackSize?: number; itemType: number }, buyRate: number, notes: PromissoryNoteRates = PROMISSORY_NOTE_RATES_EOR, isIssuer = true): number {
  const n = desc.stackSize ?? 0;
  return shopBuyPrice(unitValueOf(desc), desc.itemType, buyRate, n !== 0 ? n : 1, notes, isIssuer);
}
