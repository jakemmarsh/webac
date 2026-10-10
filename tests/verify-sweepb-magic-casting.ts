/**
 * SWEEP1006B.magic-casting — the targeted-cast gate, the spell-bar prune and
 * the spellbook Delete prompt, against the decompiled EoL client.
 *
 *  - ClientMagicSystem::ObjectCompatibleWithSpellTargetType @ 00567230
 *    (annotated decomp :349381-349490): type 0 → refuse; the caster with a
 *    type lacking 0x8107 → "You cannot cast this spell upon yourself";
 *    unknown object → silent false; _stackSize >= 2 → "Cannot cast spell on
 *    a stack of items."; ItemType mismatch (without 0x8107) or a
 *    non-player lacking Attackable (0x10) → "This spell cannot be cast on
 *    %s"; a pet → the same line.
 *  - ObjectCompatibleWithSpell @ 00567c30: a pass raises "Casting %hs"
 *    (.rdata 0x7ce8f0) on 0x1a; CastSpell @ 00568040 sends only on a pass.
 *  - SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 /
 *    RemoveSpellFromPlayerModule @ 004c6410: unknown favorites drop out of
 *    every tab with one Event_RemoveSpellFavorite each.
 *  - gmSpellbookUI::DeleteSpell @ 0048bd50: the .rdata 0x7a3ea8 format.
 */
import { describe, it, expect } from 'vitest';
import {
  spellTargetRefusal, spellTargetRefusalText, spellCastTargetCheck, castingSpellText,
  objectCompatibleWithSpellTargetType, pruneUnknownSpellFavorites, type SpellTargetObject,
} from '../packages/renderer/src/ui/SpellShortcutBar.js';
import { spellbookDeleteConfirmText } from '../packages/renderer/src/ui/spellbookFilter.js';
import { CLIENT_NOTICES as CN, raiseClientNotice } from '../packages/renderer/src/ui/ClientNotices.js';

const CREATURE = 0x10;
const ITEM_MASK = 0x88b8f;
const drudge: SpellTargetObject = { isSelf: false, itemType: CREATURE, stackSize: 0, isPlayer: false, objectDescFlags: 0x10, petOwner: 0, name: 'Drudge Skulker' };
const me: SpellTargetObject = { isSelf: true, itemType: CREATURE, stackSize: 0, isPlayer: true, objectDescFlags: 0x8, petOwner: 0, name: 'Me' };

describe('ObjectCompatibleWithSpellTargetType @ 00567230 — retail order and texts', () => {
  it('passes an attackable creature for a Creature spell', () => {
    expect(spellTargetRefusal(CREATURE, drudge)).toBeNull();
    expect(objectCompatibleWithSpellTargetType(CREATURE, drudge)).toBe(true);
  });

  it('target type 0 accepts no object', () => {
    expect(spellTargetRefusal(0, drudge)).toBe('no-target-type');
  });

  it('refuses the caster for a type without the 0x8107 bits — before the object lookup', () => {
    expect(spellTargetRefusal(CREATURE, me)).toBe('self');
    expect(spellTargetRefusalText('self', 'Me')).toBe('You cannot cast this spell upon yourself');
    // 0x88b8f carries 0x8107 bits: the caster passes on to the object checks.
    expect(spellTargetRefusal(ITEM_MASK, me)).toBeNull();
  });

  it('an unknown object fails silently', () => {
    expect(spellTargetRefusal(CREATURE, null)).toBe('unknown');
    expect(spellTargetRefusalText('unknown', '')).toBeNull();
  });

  it('a stack of 2+ is refused before the type test', () => {
    const stack: SpellTargetObject = { isSelf: false, itemType: 0x2, stackSize: 5, isPlayer: false, objectDescFlags: 0x10, name: 'Pyreals' };
    expect(spellTargetRefusal(ITEM_MASK, stack)).toBe('stack');
    expect(spellTargetRefusalText('stack', 'Pyreals')).toBe('Cannot cast spell on a stack of items.');
    expect(spellTargetRefusal(ITEM_MASK, { ...stack, stackSize: 1 })).toBeNull();
  });

  it('an ItemType mismatch is refused with the object name', () => {
    const rock: SpellTargetObject = { isSelf: false, itemType: 0x1, stackSize: 0, isPlayer: false, objectDescFlags: 0x10, name: 'Rock' };
    expect(spellTargetRefusal(CREATURE, rock)).toBe('incompatible');
    expect(spellTargetRefusalText('incompatible', 'Rock')).toBe('This spell cannot be cast on Rock');
  });

  it('a non-player without Attackable is refused even when the ItemType matches; a player is not', () => {
    const crier: SpellTargetObject = { ...drudge, objectDescFlags: 0x0, name: 'Town Crier' };
    expect(spellTargetRefusal(CREATURE, crier)).toBe('incompatible');
    const player: SpellTargetObject = { ...drudge, isPlayer: true, objectDescFlags: 0x8 };
    expect(spellTargetRefusal(CREATURE, player)).toBeNull();
  });

  it('a pet is refused with the same line', () => {
    const pet: SpellTargetObject = { ...drudge, petOwner: 0x50000002, name: 'Wolf' };
    expect(spellTargetRefusal(CREATURE, pet)).toBe('pet');
    expect(spellTargetRefusalText('pet', 'Wolf')).toBe('This spell cannot be cast on Wolf');
  });
});

describe('ObjectCompatibleWithSpell @ 00567c30 (loud, from CastSpell)', () => {
  it('a pass carries the "Casting %hs" line', () => {
    expect(spellCastTargetCheck(CREATURE, drudge, 'Flame Bolt I')).toEqual({ ok: true, text: 'Casting Flame Bolt I' });
    expect(castingSpellText('Strength Other I')).toBe('Casting Strength Other I');
  });

  it('a refusal carries its line (or none for an unknown object)', () => {
    expect(spellCastTargetCheck(CREATURE, me, 'Flame Bolt I')).toEqual({ ok: false, refusal: 'self', text: 'You cannot cast this spell upon yourself' });
    expect(spellCastTargetCheck(CREATURE, null, 'Flame Bolt I')).toEqual({ ok: false, refusal: 'unknown', text: null });
  });

  it('both lines go to the 0x1a spew sink, untargeted', () => {
    const spew: Array<[string, number | undefined]> = [];
    const surface = { displayErrorText: (t: string, w?: number) => { spew.push([t, w]); }, addSystemMessage: () => {} };
    raiseClientNotice(surface, CN.castingSpell, { text: 'Casting Flame Bolt I' });
    raiseClientNotice(surface, CN.castTargetRefused, { text: 'This spell cannot be cast on Rock' });
    expect(spew).toEqual([['Casting Flame Bolt I', 0], ['This spell cannot be cast on Rock', 0]]);
  });
});

describe('UpdateFromPlayerModule @ 004c6570 — pruneUnknownSpellFavorites', () => {
  it('drops unknown spells from every tab, keeps order, one removal per (spell, tab)', () => {
    const known = new Set([1, 3, 5]);
    const { tabs, removed } = pruneUnknownSpellFavorites([[1, 2, 3], [], [2], [5, 4, 1]], (id) => known.has(id));
    expect(tabs).toEqual([[1, 3], [], [], [5, 1]]);
    expect(removed).toEqual([{ spellId: 2, tab: 0 }, { spellId: 2, tab: 2 }, { spellId: 4, tab: 3 }]);
  });

  it('keeps more than nine favorites (the retail list is unbounded)', () => {
    const ids = Array.from({ length: 14 }, (_, i) => i + 1);
    expect(pruneUnknownSpellFavorites([ids], () => true).tabs[0]).toHaveLength(14);
  });
});

describe('gmSpellbookUI::DeleteSpell @ 0048bd50 — the confirmation text', () => {
  it('is the .rdata 0x7a3ea8 format with the plain spell name', () => {
    expect(spellbookDeleteConfirmText('Flame Bolt I')).toBe(
      'Are you sure you want to remove Flame Bolt I from your spellbook? You will no longer be able to cast this spell unless you learn it again!',
    );
  });
});
