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

  /**
   * Forget every spell. BUG.spellbook-stale-char-switch: the spellbook is the
   * character's (CPlayerModule, rebuilt from each PlayerDescription), so a
   * session's end empties it; otherwise the next character entered in this
   * page inherits the last one's spells and casting them draws the server's
   * "You don't know that spell!" (WeenieError 0x03FE).
   */
  clear(): void {
    this._spellbook.clear();
  }

  /**
   * The login PlayerDescription's spell list is the whole spellbook
   * (gmSpellbookUI::RecvNotice_PlayerDescReceived flushes and rebuilds):
   * replace the book with it rather than adding to what was there.
   * @returns how many spells the book now holds.
   */
  replaceSpellbook(spells: Iterable<SpellDefinition>): number {
    this._spellbook.clear();
    for (const s of spells) if (!this._spellbook.has(s.id)) this._spellbook.set(s.id, s);
    return this._spellbook.size;
  }

  /** Get a specific spell definition by ID. */
  getSpell(spellId: number): SpellDefinition | undefined {
    return this._spellbook.get(spellId);
  }
}
