/**
 * FAITHFUL.594 / RECON.spellbook-itemlist-template — the spellbook filter's
 * server round trip, as code the tests can call:
 *  - LOAD: PlayerDescription carries Character.SpellbookFilters (ACE
 *    GameEventPlayerDescription.cs:383-384); login applies it as-is.
 *  - SAVE: a toggle sends GameActionSpellbookFilter, a single u32
 *    (GameActionSpellbookFilter.cs).
 */
import { BinaryWriter } from '@ac/network';

export function spellbookFilterPayload(filters: number): Uint8Array {
  const p = new BinaryWriter(4);
  p.writeUInt32(filters >>> 0);
  return p.toBuffer();
}

/**
 * Applies the login filter; false (nothing applied) for the parser's -1
 * sentinel, which an aborted parse leaves behind and which as a bitmask
 * would set every filter.
 */
export function applyLoginSpellbookFilters(
  ui: { setSpellbookFilters(filters: number): void },
  desc: { spellbookFilters?: number },
): boolean {
  if (typeof desc.spellbookFilters !== 'number' || desc.spellbookFilters < 0) return false;
  ui.setSpellbookFilters(desc.spellbookFilters);
  return true;
}
