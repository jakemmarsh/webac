/**
 * GAP.16 + RECON.craft-confirmations-and-gesture — the retail client's own
 * confirmations on the targeted use-with gesture (ItemHolder::TargetAcquired
 * @ 00588ef0), driven through the shipped decision function
 * (packages/shared/src/systems/TargetAcquired.ts):
 *  - an EMPTY mana stone (ItemType.ManaStone, UiEffects.Magical clear) onto a
 *    Retained target → the chat refusal, nothing sent; onto anything else →
 *    TargetedUsageConfirmation_ManaStone @ 00566140;
 *  - a salvage bag (ItemType.TinkeringMaterial) while "Use Crafting Chance of
 *    Success Dialog" is off → TargetedUsageConfirmation_Salvage @ 005669f0;
 *  - everything else sends at once.
 * And UIElement_ItemList::AcceptDragObject @ 004e4250: a drop on an item
 * cell places the item at that cell's slot — never a use.
 */
import { describe, it, expect } from 'vitest';
import {
  targetAcquiredDecision, manaStoneConfirmText, salvageConfirmText, itemListDropSlot,
  MANA_STONE_RETAINED_REFUSAL, ITEM_TYPE_MANASTONE, ITEM_TYPE_TINKERING_MATERIAL, UI_EFFECT_MAGICAL, OBJECT_DESC_RETAINED,
  ItemType, UiEffects,
} from '@ac/shared';

const wand = { name: 'Ivory Wand' };
const decide = (itemType: number | undefined, uiEffects?: number, tgt: { name: string; objectDescFlags?: number } = wand, craftDialog = false) =>
  targetAcquiredDecision({ name: 'Mana Stone', itemType, uiEffects }, tgt, craftDialog);

describe('TargetAcquired — mana stone', () => {
  it('the bits are the real ACE enum values the decompiled gate checks', () => {
    expect(ITEM_TYPE_MANASTONE).toBe(ItemType.ManaStone);
    expect(ITEM_TYPE_TINKERING_MATERIAL).toBe(ItemType.TinkeringMaterial >>> 0);
    expect(UI_EFFECT_MAGICAL).toBe(UiEffects.Magical);
    expect(OBJECT_DESC_RETAINED).toBe(0x01000000);
  });

  it('a source that is not a mana stone sends at once', () => {
    expect(decide(ItemType.MeleeWeapon)).toEqual({ kind: 'send' });
    expect(decide(undefined)).toEqual({ kind: 'send' });
    expect(decide(0, 0)).toEqual({ kind: 'send' });
  });

  it('an EMPTY mana stone confirms (the destructive drain), whatever other UiEffects bits are set', () => {
    for (const fx of [undefined, 0, UiEffects.Poisoned]) {
      expect(decide(ItemType.ManaStone, fx)).toEqual({ kind: 'confirm', which: 'manaStone', text: manaStoneConfirmText('Ivory Wand') });
    }
    // Bitmask, not equality.
    expect(decide(ItemType.ManaStone | ItemType.PromissoryNote).kind).toBe('confirm');
  });

  it('a CHARGED mana stone (UiEffects.Magical) sends at once — the non-destructive fill', () => {
    expect(decide(ItemType.ManaStone, UiEffects.Magical)).toEqual({ kind: 'send' });
    expect(decide(ItemType.ManaStone, UiEffects.Magical | UiEffects.Poisoned)).toEqual({ kind: 'send' });
  });

  it('an empty stone onto a Retained target is refused in chat with the binary\'s literal, no dialog', () => {
    expect(decide(ItemType.ManaStone, 0, { name: 'Ivory Wand', objectDescFlags: OBJECT_DESC_RETAINED | 0x10 }))
      .toEqual({ kind: 'refuse', chat: MANA_STONE_RETAINED_REFUSAL });
    expect(MANA_STONE_RETAINED_REFUSAL).toBe('You cannot drain the mana of this item because it is "Retained".\n');
  });

  it('the confirmation text is the binary\'s literal, leading newline included (@ 00566140)', () => {
    expect(manaStoneConfirmText('Chainmail Pantaloons'))
      .toBe('\nAre you sure you want to attempt to destroy your Chainmail Pantaloons and drain its mana into this stone?');
  });
});

describe('TargetAcquired — salvage', () => {
  const bag = { name: 'Salvaged Iron (100)', itemType: ItemType.TinkeringMaterial >>> 0 };
  it('a salvage bag confirms while the craft-success option is off, naming both items, " (100)" cut', () => {
    const d = targetAcquiredDecision(bag, { name: 'Iron Sword' }, false);
    expect(d).toEqual({ kind: 'confirm', which: 'salvage', text: '\nAre you sure you want to apply the Salvaged Iron to the Iron Sword? The Iron Sword may be destroyed.' });
    expect(salvageConfirmText('Salvaged Steel', 'Mace')).toContain('apply the Salvaged Steel to the Mace');
  });
  it('with the craft-success option on the server asks instead: send at once', () => {
    expect(targetAcquiredDecision(bag, { name: 'Iron Sword' }, true)).toEqual({ kind: 'send' });
  });
  it('the mana stone check comes first: an empty stone still confirms its drain with the option on', () => {
    expect(targetAcquiredDecision({ name: 'Mana Stone', itemType: ItemType.ManaStone }, wand, true).kind).toBe('confirm');
  });
});

describe('ItemList drop slot (AcceptDragObject)', () => {
  const pack = [
    { id: 1, isPack: false }, { id: 2, isPack: true }, { id: 3, isPack: false }, { id: 4, isPack: false }, { id: 5, isPack: true },
  ];
  it('an item lands at the target item\'s index among the container\'s items (packs numbered apart, as ACE does)', () => {
    expect(itemListDropSlot(pack, 1, false)).toBe(0);
    expect(itemListDropSlot(pack, 3, false)).toBe(1);
    expect(itemListDropSlot(pack, 4, false)).toBe(2);
  });
  it('a target outside the dropped item\'s kind clamps to the end (WhatNum clamped to the item count)', () => {
    expect(itemListDropSlot(pack, 2, false)).toBe(3);
    expect(itemListDropSlot(pack, 5, true)).toBe(1);
  });
});
