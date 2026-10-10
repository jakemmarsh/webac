/**
 * gmToolbarUI::HandleSelectionChanged @ 004bf380 — the selection-driven
 * decisions of the toolbar's selected-object field, as pure functions:
 * which query a new selection fires, when the heart meter is visible, and
 * the Use button's state.
 */
import { ItemType, ObjectDescriptionFlag } from '@ac/shared';
import { isObjectAttackable } from '../input/InteractionSystem.js';

/** The PublicWeenieDesc fields HandleSelectionChanged reads off the selected weenie. */
export interface SelectionWeenie {
  itemType: number;
  objectDescFlags?: number;
  /** _pet_owner (0 / absent = not a pet). */
  petOwner?: number;
  /** _stackSize (0 / absent = not a stack). */
  stackSize?: number;
  /** _useability (wire ItemUseable; 0 = not sent). */
  usable?: number;
  /** _combatUse (0 = COMBAT_USE_NONE / not sent). */
  combatUse?: number;
}

export type SelectionQuery = 'health' | 'mana' | 'none';

/**
 * The one query a new selection fires (HandleSelectionChanged @ 004bf380,
 * decomp :185713-185728). A stack of >= 2 fires none. Otherwise an object
 * that is a player (vtable +0x10 IsPlayer), a pet (_pet_owner != 0) or passes
 * ClientCombatSystem::ObjectIsAttackable @ 0056a600 gets
 * CM_Combat::Event_QueryHealth(id); anything else gets
 * CM_Item::Event_QueryItemMana(id) only when IsOwnedByPlayer. A Yellow-radar
 * vendor or a non-attackable creature (the Loom) gets no health query.
 */
export function selectionQueryFor(
  obj: SelectionWeenie,
  opts: { isSelf?: boolean; ownedByPlayer: boolean; playerFlags: number },
): SelectionQuery {
  if ((obj.stackSize ?? 0) >= 2) return 'none';
  const isPlayer = !!opts.isSelf || ((obj.objectDescFlags ?? 0) & ObjectDescriptionFlag.Player) !== 0;
  if (isPlayer || (obj.petOwner ?? 0) !== 0) return 'health';
  if (isObjectAttackable({ itemType: obj.itemType, objectDescFlags: obj.objectDescFlags ?? 0, petOwner: obj.petOwner }, opts.playerFlags)) {
    return 'health';
  }
  return opts.ownedByPlayer ? 'mana' : 'none';
}

/**
 * Whether the heart meter (el 0x100001a1) shows. HandleSelectionChanged
 * hides it on every id change and never shows it; only
 * gmToolbarUI::RecvNotice_UpdateObjectHealth @ 004bd110 (a health reply for
 * the current selection) calls SetVisible(1). A stack selection and an owned
 * item's snake mana meter take the slot instead.
 */
export function targetHealthMeterVisible(t: { healthReceived?: boolean; stackSize?: number; manaFraction?: number }): boolean {
  if ((t.stackSize ?? 0) >= 2) return false;
  if (typeof t.manaFraction === 'number') return false;
  return t.healthReceived === true;
}

const USE_STATE_COMBAT_ITEM_TYPES = ItemType.Armor | ItemType.Clothing | ItemType.Jewelry; // 2 | 4 | 8

/**
 * The Use button's state (HandleSelectionChanged @ 004bf380, LAB_004bf795,
 * decomp :185760-185769): disabled (state 0xd) only when the object has no
 * combat use, is not Armor / Clothing / Jewelry, and ItemUses::IsUseable
 * @ 004fccc0 (`~_useable_bitfield & 1`) is false, i.e. its ItemUseable has
 * bit 0 (USEABLE_NO) set. Nothing selected → enabled (state 1). The object's
 * creature, player or radar type plays no part.
 */
export function toolbarUseButtonDisabled(obj: SelectionWeenie | null): boolean {
  if (!obj) return false;
  if ((obj.combatUse ?? 0) !== 0) return false;
  if ((obj.itemType & USE_STATE_COMBAT_ITEM_TYPES) !== 0) return false;
  return ((obj.usable ?? 0) & 1) === 1;
}
