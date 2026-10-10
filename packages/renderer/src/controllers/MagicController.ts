/**
 * MagicController -- the player's spellbook for the renderer.
 *
 * Holds the spells ACE reports (PlayerDescription spellbook + learn/remove
 * events). Casting is server-authoritative: the client only sends the cast
 * action and ACE (Player_Magic.cs) validates, rolls fizzle and spends mana,
 * so no local cast/fizzle/damage simulation lives here.
 * Pure logic: no DOM or Three.js.
 */

import type { SpellDefinition } from '@ac/shared';

export class MagicController {
  private _spellbook: Map<number, SpellDefinition> = new Map();

  /**
   * Learn a spell (add to spellbook).
   * @returns false if the spell is already known.
   */
  learnSpell(spell: SpellDefinition): boolean {
    if (this._spellbook.has(spell.id)) return false;
    this._spellbook.set(spell.id, spell);
    return true;
  }

  /**
   * Forget (remove) a spell from the spellbook.
   * @returns false if the spell was not known.
   */
  forgetSpell(spellId: number): boolean {
    return this._spellbook.delete(spellId);
  }

  /** Check if a spell is in the spellbook. */
  isSpellKnown(spellId: number): boolean {
    return this._spellbook.has(spellId);
  }

  /** Get all known spells as an array. */
  get knownSpells(): SpellDefinition[] {
    return [...this._spellbook.values()];
  }

  /** Get a specific spell definition by ID. */
  getSpell(spellId: number): SpellDefinition | undefined {
    return this._spellbook.get(spellId);
  }
}
