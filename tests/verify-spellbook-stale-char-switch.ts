/**
 * BUG.spellbook-stale-char-switch (monitor, 2026-11-25, Seedsow / classic-dereth-1-0, trace
 * 92313d167e79eab8): a player logged out and entered other characters in the same page, then ran
 * a macro; its casts drew "You don't know that spell!" (WeenieError 0x03FE) eight times. The agent's
 * cast only sends a spell the client's spellbook (MagicController) holds, but that book was never
 * emptied when a session ended and each PlayerDescription only added to it, so the next character
 * inherited the previous one's spells.
 *
 * Now the PlayerDescription's list replaces the book (MagicController.replaceSpellbook) and the
 * world teardown empties it (MagicController.clear). Every era: the book is shared code.
 */
import { describe, it, expect } from 'vitest';
import { MagicController } from '../packages/renderer/src/controllers/MagicController.js';
import { MagicSchool, SpellTargetType } from '@ac/shared';
import type { SpellDefinition } from '@ac/shared';

function spell(id: number, name: string): SpellDefinition {
  return {
    id, name, school: MagicSchool.CreatureEnchantment, level: 1, power: 1, manaCost: 1,
    difficulty: 1, duration: 60, components: [], targetType: SpellTargetType.Self,
  };
}

describe('BUG.spellbook-stale-char-switch', () => {
  it('a second character\'s PlayerDescription replaces the first character\'s spellbook', () => {
    const mc = new MagicController();
    expect(mc.replaceSpellbook([spell(2, 'Strength Self I'), spell(18, 'Flame Bolt I')])).toBe(2);
    // The next character in this page knows only Heal Self I.
    expect(mc.replaceSpellbook([spell(6, 'Heal Self I')])).toBe(1);
    expect(mc.isSpellKnown(2)).toBe(false);
    expect(mc.isSpellKnown(18)).toBe(false);
    expect(mc.knownSpells.map((s) => s.id)).toEqual([6]);
  });

  it('a character with no spells gets an empty book, not the last one\'s', () => {
    const mc = new MagicController();
    mc.replaceSpellbook([spell(2, 'Strength Self I')]);
    expect(mc.replaceSpellbook([])).toBe(0);
    expect(mc.knownSpells).toEqual([]);
  });

  it('clear() (the world teardown) empties the book', () => {
    const mc = new MagicController();
    mc.learnSpell(spell(2, 'Strength Self I'));
    mc.learnSpell(spell(18, 'Flame Bolt I'));
    mc.clear();
    expect(mc.knownSpells).toEqual([]);
    expect(mc.isSpellKnown(2)).toBe(false);
    // A spell learned after the clear is the new character's own.
    expect(mc.learnSpell(spell(2, 'Strength Self I'))).toBe(true);
  });

  it('a duplicate id in the list is kept once (the first definition)', () => {
    const mc = new MagicController();
    expect(mc.replaceSpellbook([spell(6, 'Heal Self I'), spell(6, 'dup')])).toBe(1);
    expect(mc.getSpell(6)?.name).toBe('Heal Self I');
  });

  it('a resume (same character) refills the same spells after the teardown', () => {
    const mc = new MagicController();
    const book = [spell(2, 'Strength Self I'), spell(6, 'Heal Self I')];
    mc.replaceSpellbook(book);
    mc.clear();
    mc.replaceSpellbook(book);
    expect(mc.knownSpells.map((s) => s.id).sort((a, b) => a - b)).toEqual([2, 6]);
  });
});
