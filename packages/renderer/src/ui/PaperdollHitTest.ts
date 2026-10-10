/**
 * PaperdollHitTest — clicking the paperdoll portrait selects the worn item
 * under the mouse, and a selected worn item blinks on the portrait.
 *
 * Ground truth (decompiled EoL client, build ac1_sep13):
 *
 *  - `gmPaperDollUI::CreateClickMap @ 004a4850` loads the UIASSET image
 *    `GetDIDByEnum(0x1000000c)` ("PaperDollHitTest", 0x06004d8b: a 100x214
 *    R8G8B8 silhouette, one flat colour per body region) — the size of the
 *    drag band 0x100001d6 it is read against.
 *  - `GetPaperDollItemUnderMouse @ 004a4920` reads the click map's pixel at
 *    the mouse's offset from the drag band (`SurfaceWindow::GetColorFromPoint`,
 *    false off the image), maps the colour to an EquipMask pair (clothing |
 *    armor bit; head is HeadWear only, hand / foot are the clothing bits),
 *    and returns `GetUpperInvObj(mask)`. Any other colour (the black
 *    background) is mask 0 → 0 → no hit.
 *  - `GetUpperInvObj @ 004a4750`: the player's InventoryPlacement whose
 *    location meets the mask with the higher `DetermineHigherPriority @
 *    004a44b0` (a priority-0 placement on an armor bit 0x200–0x4000 counts
 *    as 0x7f; a priority-0 placement on any other bit loses), or — nothing
 *    worn there — the PLAYER itself.
 *  - `ListenToElementMessage @ 004a5c30` on the band: a click (action 7)
 *    with a target mode armed runs it on the player; otherwise
 *    `SetSelectedObject(hit)`. A right-click (8) selects and examines the
 *    hit. A drag (0x21) of a hit starts the worn item's drag.
 *  - `RecvNotice_SetSelectedItem @ 004a4e70` → `BeginPartSelectionLighting
 *    @ 004a4c50`: the selection's `GetSelectionMaskFromObject @ 004a4b50`
 *    (which body regions it is the upper item of; the player = 0x7fffffff)
 *    arms the blink, `UpdatePartSelectionLighting @ 004a4360` steps it:
 *    flip 1 = HIGH, flip 2 = LOW, flip 3 = `EndPartSelectionLighting`
 *    (restore), one SELECTION_FLIP_TIME apart, the first flip at once.
 *    `ApplyPartSelectionLighting @ 004a3ca0` lights the regions' Setup
 *    parts (or the whole figure for 0x7fffffff).
 */

import { EquipMask } from '@ac/shared';
import { readMapper, UIASSET_MASTER_ENUM, type IconMapperSource } from './ItemIconComposite.js';
import { LIGHT_HIGH, LIGHT_LOW, type LightingLevels } from '../world/SelectionLighting.js';

/** UIASSET enum → PaperDollHitTest (CreateClickMap's GetDIDByEnum(.., 0x1000000c)). */
export const UIASSET_PAPERDOLL_HIT_TEST_ENUM = 0x1000000c;

/** GetSelectionMaskFromObject's answer for the player: the whole figure. */
export const PAPERDOLL_WHOLE_FIGURE_MASK = 0x7fffffff;

/** The click map's DID through the master map → UIASSET table (0 when absent). */
export function loadPaperdollHitTestDid(db: IconMapperSource, masterMapId: number): number {
  const master = readMapper(db, masterMapId);
  const uiAsset = readMapper(db, master?.client.enumToId.get(UIASSET_MASTER_ENUM));
  return uiAsset?.client.enumToId.get(UIASSET_PAPERDOLL_HIT_TEST_ENUM) ?? 0;
}

/**
 * The RGBAColor_HitTest_* constants (acclient.exe .rdata) as 8-bit RGB, in
 * GetPaperDollItemUnderMouse's test order, with the EquipMask each yields.
 * 0.5019608 = 128/255.
 */
export const PAPERDOLL_HIT_COLORS: ReadonlyArray<{ rgb: readonly [number, number, number]; mask: number }> = [
  { rgb: [0, 0, 255], mask: EquipMask.HeadWear },                                   // Head 0x1
  { rgb: [0, 255, 0], mask: EquipMask.ChestWear | EquipMask.ChestArmor },           // Chest 0x202
  { rgb: [255, 0, 0], mask: EquipMask.AbdomenWear | EquipMask.AbdomenArmor },       // Abdomen 0x404
  { rgb: [0, 255, 255], mask: EquipMask.UpperArmWear | EquipMask.UpperArmArmor },   // Upper arm 0x808
  { rgb: [255, 0, 255], mask: EquipMask.LowerArmWear | EquipMask.LowerArmArmor },   // Lower arm 0x1010
  { rgb: [255, 255, 0], mask: EquipMask.UpperLegWear | EquipMask.UpperLegArmor },   // Upper leg 0x2040
  { rgb: [0, 0, 128], mask: EquipMask.LowerLegWear | EquipMask.LowerLegArmor },     // Lower leg 0x4080
  { rgb: [0, 128, 0], mask: EquipMask.HandWear },                                   // Hand 0x20
  { rgb: [128, 0, 0], mask: EquipMask.FootWear },                                   // Foot 0x100
];

/** The EquipMask a click-map colour names (0 = no region). */
export function hitColorMask(r: number, g: number, b: number): number {
  for (const c of PAPERDOLL_HIT_COLORS) {
    if (c.rgb[0] === r && c.rgb[1] === g && c.rgb[2] === b) return c.mask;
  }
  return 0;
}

/** One InventoryPlacement: what the player wears where, at what layer priority. */
export interface WornPlacement {
  id: number;
  /** CurrentWieldedLocation (EquipMask). */
  loc: number;
  /** ClothingPriority (CoverageMask); 0 when the item has none. */
  priority: number;
}

/** InventoryPlacement::DetermineHigherPriority @ 004a44b0: `a` unless `b` outranks it on `mask`. */
function higherPriority(a: WornPlacement, b: WornPlacement, mask: number): WornPlacement {
  const aLoc = a.loc & mask;
  const bLoc = b.loc & mask;
  let aPri = a.priority;
  let bPri = b.priority;
  if (aLoc !== 0 && aPri === 0 && aLoc > 0x1ff && aLoc < 0x4001) aPri = 0x7f;
  if (bLoc !== 0 && bPri === 0) {
    if (bLoc < 0x200 || bLoc > 0x4000) return a;
    bPri = 0x7f;
  }
  return aPri < bPri ? b : a;
}

/** gmPaperDollUI::GetUpperInvObj @ 004a4750 — 0 for mask 0, the player when nothing worn meets it. */
export function upperWornObject(worn: readonly WornPlacement[], mask: number, playerId: number): number {
  if (mask === 0) return 0;
  let best: WornPlacement = { id: 0, loc: 0, priority: 0 };
  for (const p of worn) {
    if ((p.loc & mask) !== 0) best = higherPriority(p, best, mask);
  }
  return best.id !== 0 ? best.id : playerId;
}

/** An RGBA image (the decoded click map). */
export interface HitTestImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** gmPaperDollUI::GetPaperDollItemUnderMouse @ 004a4920 at (x, y) px inside the drag band. */
export function paperdollItemAt(
  map: HitTestImage, x: number, y: number, worn: readonly WornPlacement[], playerId: number,
): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= map.width || py >= map.height) return 0;
  const o = (py * map.width + px) * 4;
  return upperWornObject(worn, hitColorMask(map.data[o], map.data[o + 1], map.data[o + 2]), playerId);
}

/** gmPaperDollUI::GetSelectionMaskFromObject @ 004a4b50 — the regions `guid` is the upper item of. */
export function selectionMaskFromObject(guid: number, worn: readonly WornPlacement[], playerId: number): number {
  if (guid === 0) return 0;
  if (guid === playerId) return PAPERDOLL_WHOLE_FIGURE_MASK;
  let mask = 0;
  const regions: ReadonlyArray<[number, number]> = [
    [0x404, 0x4], [0x2040, 0x40], [0x4080, 0x80], [0x100, 0x100], [0x202, 0x2],
    [0x808, 0x8], [0x1010, 0x10], [0x20, 0x20], [0x1, 0x1],
  ];
  for (const [query, bit] of regions) {
    if (upperWornObject(worn, query, playerId) === guid) mask |= bit;
  }
  return mask;
}

/**
 * gmPaperDollUI::ApplyPartSelectionLighting @ 004a3ca0 — the Setup part
 * indices a selection mask lights; null = the whole figure (SetLighting).
 */
export function partsForSelectionMask(mask: number): number[] | null {
  if (mask === PAPERDOLL_WHOLE_FIGURE_MASK) return null;
  const parts: number[] = [];
  if (mask & 0x1) parts.push(0x10);
  if (mask & 0x202) parts.push(9);
  if (mask & 0x404) parts.push(0);
  if (mask & 0x808) parts.push(10, 0xd);
  if (mask & 0x1010) parts.push(0xb, 0xe);
  if (mask & 0x2040) parts.push(1, 5);
  if (mask & 0x4080) parts.push(2, 6);
  if (mask & 0x20) parts.push(0xc, 0xf);
  if (mask & 0x100) parts.push(3, 7, 4, 8);
  return parts;
}

/**
 * UpdatePartSelectionLighting @ 004a4360 for a due flip: flip 1 = HIGH,
 * flip 2 = LOW (the count advances and the next flip is SELECTION_FLIP_TIME
 * out), anything else = restore (EndPartSelectionLighting).
 */
export function partSelectionFlipLevels(flipCount: number): LightingLevels | null {
  if (flipCount === 1) return LIGHT_HIGH;
  if (flipCount === 2) return LIGHT_LOW;
  return null;
}
