/**
 * SWEEP1006 enchantment expiry — ClientMagicSystem::NotifyOfEnchantmentRemoval
 * @ 005686c0: "<spell name>[ penalty] has expired." for a removed
 * enchantment whose spell id is below 0x8000; nothing for a cooldown id.
 * ACE sends no text of its own on expiry (EnchantmentManager only sends the
 * RemoveEnchantment event and the expiry sound).
 */
import { describe, it, expect } from 'vitest';
import { enchantmentExpiredLine, VITAE_SPELL_ID } from '../packages/renderer/src/chat/EnchantmentExpiry.js';

describe('enchantmentExpiredLine', () => {
  it('names the spell', () => {
    expect(enchantmentExpiredLine(2, 'Strength Self I')).toBe('Strength Self I has expired.');
  });
  it('Vitae (0x29a) reads "… penalty has expired."', () => {
    expect(enchantmentExpiredLine(VITAE_SPELL_ID, 'Vitae')).toBe('Vitae penalty has expired.');
  });
  it('a cooldown (id ≥ 0x8000) or an unknown spell prints nothing', () => {
    expect(enchantmentExpiredLine(0x8000 + 12, 'Cooldown')).toBeNull();
    expect(enchantmentExpiredLine(5000, null)).toBeNull();
  });
});
