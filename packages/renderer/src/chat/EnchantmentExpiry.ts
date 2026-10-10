/**
 * SWEEP1006 enchantment expiry — the chat line retail prints when a buff or
 * debuff runs out. ClientMagicSystem::Handle_Magic__RemoveEnchantment
 * @ 00568950 calls NotifyOfEnchantmentRemoval @ 005686c0 for a
 * RemoveEnchantment / RemoveMultipleEnchantments (CM_Magic::DispatchUI_*
 * pass true; a Dispel passes false — no line). Unless the Magic channel (7)
 * is globally squelched, a spell id below 0x8000 (cooldowns are 0x8000+)
 * prints its SpellTable name, " penalty" for spell 0x29a (Vitae), then
 * " has expired." on chat type 7 (Magic).
 */
export const VITAE_SPELL_ID = 0x29a;

/** The expiry line for `spellId` (null for a cooldown id or an unknown spell). */
export function enchantmentExpiredLine(spellId: number, spellName: string | null | undefined): string | null {
  const id = spellId & 0xffff;
  if (id >= 0x8000 || !spellName) return null;
  return `${spellName}${id === VITAE_SPELL_ID ? ' penalty' : ''} has expired.`;
}
