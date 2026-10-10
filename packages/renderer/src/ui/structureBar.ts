/**
 * BUG.structure-maxstructure-discarded — retail item-icon uses-remaining bar.
 *
 * The EoL client overlays a thin vertical meter on the inventory icon of a
 * limited-use item (healing kits, lockpicks, mana stones, pet devices):
 *
 *   UIElement_UIItem::UpdateStructureDisplay @ 004e17a0 reads the item's
 *   PublicWeenieDesc _structure / _maxStructure and drives the
 *   m_elem_Icon_StructureBar meter (bound via GetChildRecursive(0x10000348)
 *   in the UIItem template 0x10000346, LayoutDesc 0x21000037): hidden when
 *   _maxStructure == 0 or the ratio equals exactly 1.0, otherwise shown
 *   with fill attribute 0x69 = Clamp(structure / maxStructure, 0, 1).
 *
 *   The meter element in the DAT is a type-7 UIElement_Meter at (26,1),
 *   5x30 inside the 32x32 icon — background texture 0x06004d24, fill child
 *   (element 0x2) texture 0x06004d25 (bright green). Its direction
 *   property (p111 / attribute 0x6f) is 4: per UIElement_Meter::
 *   DrawChildren @ 0046fbd0 case 4, the fill child's box is clipped so
 *   only the BOTTOM fraction of the fill texture is drawn — the bar drains
 *   downward from the top as uses are consumed.
 *
 * The values are kept live by GameMessagePublicUpdatePropertyInt
 * broadcasts of PropertyInt.Structure = 92 (ACE Healer.cs:191, Lock.cs:94,
 * PetDevice.cs:94/576).
 */

/** Meter background (track) texture — element 0x10000348's media. */
export const STRUCTURE_BAR_BG_TEXTURE = 0x06004d24;

/** Meter fill texture — element 0x10000348's child 0x2 media. */
export const STRUCTURE_BAR_FILL_TEXTURE = 0x06004d25;

/** Meter geometry inside the 32x32 UIItem icon (LayoutDesc 0x21000037). */
export const STRUCTURE_BAR_X = 26;
export const STRUCTURE_BAR_Y = 1;
export const STRUCTURE_BAR_W = 5;
export const STRUCTURE_BAR_H = 30;
/** The icon size the geometry above is authored against. */
export const STRUCTURE_BAR_ICON_SIZE = 32;

/**
 * UpdateStructureDisplay mirror: the meter's fill fraction, or null when
 * the meter is hidden. Retail hides when maxStructure is 0 (item has no
 * uses meter) or when structure/maxStructure equals exactly 1.0 (a fresh,
 * unused item shows no bar); otherwise the fill is
 * Clamp(structure/maxStructure, 0, 1) — so an over-full item (ratio > 1,
 * e.g. a tinkered MaxStructure not yet re-broadcast) still shows a full
 * bar rather than hiding.
 */
export function structureBarFraction(
  structure: number | undefined,
  maxStructure: number | undefined,
): number | null {
  const max = maxStructure ?? 0;
  if (max === 0) return null;
  const ratio = (structure ?? 0) / max;
  if (ratio === 1.0) return null;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * RECON.inventory-grid-dat-cells.a — the container fullness meter, the
 * StructureBar's sibling in the same UIItem overlays (0x21000037:0x10000346
 * child 0x10000347: the same 5x30 direction-4 meter at (26,1), track
 * 0x06004d22, fill child 0x2 0x06004d23).
 *
 * UIElement_UIItem::UpdateCapacityDisplay @ 004e16e0: shown only for a
 * container UIItem (isContainer — `_itemsCapacity` or `_containersCapacity`
 * non-zero or bitfield 0x800000, set in UIItem's update @ 004e2300; the
 * player's own main-pack cell qualifies) whose `_itemsCapacity` is >= 1, at
 * GetNumContainedItems / capacity (the `_itemsList` count — side packs sit
 * in `_containersList`, not counted), clamped to 0..1; hidden at exactly 0.
 */
export const CAPACITY_BAR_BG_TEXTURE = 0x06004d22;
export const CAPACITY_BAR_FILL_TEXTURE = 0x06004d23;

export function capacityBarFraction(itemsCapacity: number | undefined, containedItems: number): number | null {
  const capacity = itemsCapacity ?? 0;
  if (capacity < 1) return null;
  const ratio = containedItems / capacity;
  if (ratio === 0) return null;
  return Math.min(1, Math.max(0, ratio));
}
