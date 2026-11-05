/**
 * BUG.ac1999-combat-ammo-count (webac#19) — the number the toolbar's combat button shows in
 * missile mode: how many arrows / bolts / darts are left.
 *
 * Both clients pick the object the same way and show it in missile mode only:
 *
 * - End of retail: gmToolbarUI::UpdateAmmoID @ 004bf210 sets m_idAmmoObject to the object at
 *   EquipMask 0x400000 (MissileWeapon) when its _maxStackSize > 1 (a thrown weapon: the stack is
 *   the ammunition), else the object at 0x800000 (MissileAmmo). UpdateAmmoNumber @ 004be9e0 writes
 *   its _stackSize (0 reads as 1) into the text of 0x21000016:0x10000194, the missile-mode state of
 *   the combat button (p21 5 bottom, p38 4 bottom margin, centred by its template 0x100002bc), or
 *   an empty string with no object. The state elements are shown one per mode, so the number is
 *   on screen only in missile mode. It runs on RecvNotice_ServerSaysMoveItem @ 004bf2b0 (a move to
 *   or from the player touching 0xc00000) and RecvNotice_ItemAttributesChanged @ 004bf8f0 (the
 *   player, or the ammo object itself: a shot's SetStackSize).
 * - The 1999 client.exe: CombatButton (ctor @ 0x00501950) builds a TextRegion (x 0xb, y 0x26,
 *   32 x 16, flags 4). 0x005024a0 picks the same object (0x400000 with maxStackSize > 1, else
 *   0x800000) and 0x005025a0 writes ACCWeenieObject_GetEffectiveStackSize (stack size, min 1) with
 *   "%u" (0x5f926c), or "" (0x5f529c) with none. 0x00502310 parents the TextRegion under the
 *   button only in combat mode 3 (missile). 0x00502250 / 0x005022a0 refresh it on the player's
 *   or the ammo's update and on a move to or from the player touching 0x400000 / 0x800000.
 *
 * A bow with no arrows wielded shows nothing; so does every other mode.
 */
import { CombatMode, EquipMask } from '@ac/shared';

/** What the pick reads of a worn object. */
export interface CombatAmmoWorn {
  readonly id: number;
  readonly slot: number;
  readonly stackSize?: number;
  readonly maxStackSize?: number;
}

/** UpdateAmmoID @ 004bf210 / 1999 0x005024a0: the object whose count the combat button shows. */
export function combatAmmoObject<T extends CombatAmmoWorn>(worn: readonly T[]): T | null {
  const launcher = worn.find((e) => (e.slot & EquipMask.MissileWeapon) !== 0);
  if (launcher && (launcher.maxStackSize ?? 0) > 1) return launcher;
  return worn.find((e) => (e.slot & EquipMask.MissileAmmo) !== 0) ?? null;
}

/** UpdateAmmoNumber @ 004be9e0 / 1999 0x005025a0: the text ("" with no object). */
export function combatAmmoCountText(worn: readonly CombatAmmoWorn[]): string {
  const obj = combatAmmoObject(worn);
  if (!obj) return '';
  return String(Math.max(1, Math.floor(obj.stackSize ?? 0)));
}

/** The count is drawn by the missile-mode state of the button (1999: parented in mode 3 only). */
export function combatAmmoCountShown(mode: CombatMode): boolean {
  return mode === CombatMode.Missile;
}
