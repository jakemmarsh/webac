/**
 * TargetAcquired — what the retail client does once a use-with source is
 * armed and the player picks its target (`ItemHolder::TargetAcquired`
 * @ 00588ef0), after the TargetCompatibleWithObject gate:
 *
 *  1. Source is a mana stone (`itemType & 0x80000`) that holds no mana
 *     (`_effects & 1` clear — UiEffects.Magical):
 *       - target Retained (PublicWeenieDesc `_bitfield & 0x1000000`) → the
 *         chat line "You cannot drain the mana of this item because it is
 *         \"Retained\".\n", nothing sent;
 *       - else `ClientUISystem::TargetedUsageConfirmation_ManaStone`
 *         @ 00566140: a Yes/No dialog whose Yes
 *         (`TargetedUsageCallback` @ 00565960) sends UseWithTarget.
 *  2. Unless the "Use Crafting Chance of Success Dialog" option is on
 *     (`PlayerModule::UseCraftSuccessDialog`; then the server asks), a
 *     salvage source (`itemType & 0x40000000`, TinkeringMaterial) raises
 *     `TargetedUsageConfirmation_Salvage` @ 005669f0: "Are you sure you want
 *     to apply the <source> to the <target>? The <target> may be destroyed."
 *     with " (100)" cut from the source's name.
 *  3. Otherwise UseWithTarget goes at once.
 *
 * Both dialog texts are acclient.exe literals (no string table), each
 * beginning with "\n" as the binary has them.
 */

/** ItemType.ManaStone (ACE ItemType.cs). */
export const ITEM_TYPE_MANASTONE = 0x00080000;
/** ItemType.TinkeringMaterial (ACE ItemType.cs) — salvage bags. */
export const ITEM_TYPE_TINKERING_MATERIAL = 0x40000000;
/** UiEffects.Magical (ACE UiEffects.cs) — a charged mana stone. */
export const UI_EFFECT_MAGICAL = 0x0001;
/** ObjectDescriptionFlag.Retained (ACE) — PublicWeenieDesc `_bitfield`. */
export const OBJECT_DESC_RETAINED = 0x01000000;

export interface TargetAcquiredSource {
  name: string;
  itemType?: number;
  uiEffects?: number;
}

export interface TargetAcquiredTarget {
  name: string;
  /** PublicWeenieDesc `_bitfield`, when known. */
  objectDescFlags?: number;
}

export type TargetAcquiredDecision =
  | { kind: 'refuse'; chat: string }
  | { kind: 'confirm'; which: 'manaStone' | 'salvage'; text: string }
  | { kind: 'send' };

export const MANA_STONE_RETAINED_REFUSAL = 'You cannot drain the mana of this item because it is "Retained".\n';

/** TargetedUsageConfirmation_ManaStone's text. */
export function manaStoneConfirmText(targetName: string): string {
  return `\nAre you sure you want to attempt to destroy your ${targetName} and drain its mana into this stone?`;
}

/** TargetedUsageConfirmation_Salvage's text; " (100)" is cut from the source's name. */
export function salvageConfirmText(sourceName: string, targetName: string): string {
  const source = sourceName.split(' (100)').join('');
  return `\nAre you sure you want to apply the ${source} to the ${targetName}? The ${targetName} may be destroyed.`;
}

export function targetAcquiredDecision(
  src: TargetAcquiredSource, tgt: TargetAcquiredTarget, useCraftSuccessDialog: boolean,
): TargetAcquiredDecision {
  const type = (src.itemType ?? 0) >>> 0;
  if ((type & ITEM_TYPE_MANASTONE) !== 0 && ((src.uiEffects ?? 0) & UI_EFFECT_MAGICAL) === 0) {
    if (((tgt.objectDescFlags ?? 0) & OBJECT_DESC_RETAINED) !== 0) return { kind: 'refuse', chat: MANA_STONE_RETAINED_REFUSAL };
    return { kind: 'confirm', which: 'manaStone', text: manaStoneConfirmText(tgt.name) };
  }
  if (!useCraftSuccessDialog && (type & ITEM_TYPE_TINKERING_MATERIAL) !== 0) {
    return { kind: 'confirm', which: 'salvage', text: salvageConfirmText(src.name, tgt.name) };
  }
  return { kind: 'send' };
}

/**
 * `UIElement_ItemList::AcceptDragObject` @ 004e4250 — an item dropped on an
 * item cell first tries `ItemHolder::AttemptMerge`; when that does not apply
 * it is placed in the list's container at the cell's position (`WhatNum`,
 * clamped to the item count) through AttemptToPlaceInContainer. Never a use.
 * ACE numbers items and packs separately (Container.TryAddToInventory:
 * PlacementPosition shifts only among same-kind entries), so the slot is the
 * target's index among the container's entries of the dropped item's kind.
 */
export function itemListDropSlot(
  containerEntries: ReadonlyArray<{ id: number; isPack: boolean }>, targetId: number, droppedIsPack: boolean,
): number {
  const sameKind = containerEntries.filter((e) => e.isPack === droppedIsPack);
  const i = sameKind.findIndex((e) => e.id === targetId);
  return i === -1 ? sameKind.length : i;
}
