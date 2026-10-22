/**
 * The 1999 AppraisalProfile fields that have no end-of-retail property
 * (BUG.ac1999-appraisal-details). The 1999 adapter (network era1999
 * codecs/Inventory1999.ts) turns the fixed-field 1999 profile into end of
 * retail's property tables; these fields ride in those tables under keys past
 * every STypes range, so no end-of-retail reader mistakes them for a real
 * property. Only the 1999 item page (renderer ui/examine/ItemAppraisalText1999.ts)
 * reads them.
 *
 * Offsets are the 1999 client's AppraisalProfile (UnPack @ 0x005e0fa0 in the
 * 1999 client.exe; reference/ac1999 kb structures/AppraisalProfile).
 */
export const APPRAISAL_1999_STRING = {
  /** +0x8c, magic block 0x800000: the spell names. The magic section's master gate (0x005df8d0). */
  spellNames: 0x7f000001,
  /** +0x98, magic block: the text after "Spell Descriptions:\n" (gate 0x005df920). */
  spellDescriptions: 0x7f000002,
  /** +0xa4, block 0x2000000: the text after "Enchantments:\n" (gate 0x005df970). */
  enchantments: 0x7f000003,
} as const;

export const APPRAISAL_1999_FLOAT = {
  /** +0x74, magic block: read as a dword, used as a float — "Mana Cost: 1 point per %d seconds." (ftol(|x|)). */
  manaRate: 0x7f000001,
  /** +0xb0, magic block f64: the missile-range fallback (0x005df9c0) when the weapon profile drew no range. */
  rangeFallback: 0x7f000002,
} as const;
