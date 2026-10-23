/**
 * The PublicUpdatePropertyDataID (0x02D8) consumer, and GDLE's
 * PublicRemoveDataIDEvent (0x01DA), which ServerMessageHandler delivers as
 * the same update with value 0 and `removed: true`.
 *
 * FAITHFUL.378 — PropertyDataId.Icon (8) live-updates the mirrored
 * ServerObject.iconId (ACE broadcasts it when an item swaps icon mid-life).
 * FAITHFUL.380 — Setup (1), MotionTable (2), SoundTable (3) are mirrored so
 * appearance rebuilds and animation playback see the server-current values
 * (polymorph, mount/dismount, weapon swap).
 * BUG.icon-overlay-underlay-dropped — IconOverlay (50) / IconUnderlay (52)
 * mirror too, so a live overlay swap updates the rendered icon.
 * GAP.gdle-qualities-remove-events — a cleared overlay / underlay (ACE: the
 * update with 0; GDLE: the 0x01DA remove) applies, so the icon drops it.
 * Other DIDs at 0 are not applied (an object never loses its Setup).
 *
 * Our own items have no ServerObject (CorePlating sets a pack item's
 * IconOverlay this way), so those go to the inventory mirror instead.
 *
 * VTE-1 — VendorsClassId (40), a trade note's issuing vendor (the 1999
 * adapter's PublicWeenieDesc 0x200000), is kept by guid in `noteIssuers`
 * whatever the object's state: the note may still be on the ground, in a
 * corpse or arriving in a pack, and the vendor's sell-back price reads it
 * (ShopSystem_BuyPrice's isIssuer, 1999 VendorProfile_VendorBuyPrice).
 */
import { PropertyDataId } from '@ac/shared';
import type { InventoryManager } from '@ac/shared';
import type { PropertyUpdateData } from './ServerMessageHandler.js';
import { applyPropertyDataIdUpdate, type ServerObject } from '../world/ServerObjectManager.js';

export interface PublicPropertyDataIdDeps {
  getObject(guid: number): ServerObject | undefined | null;
  inventory: Pick<InventoryManager, 'applyPublicPropertyDataId'>;
  /** An inventory item's icon changed: re-sync its worn copy and redraw. */
  onInventoryItemChanged(guid: number): void;
  /** Trade notes' issuing-vendor wcids by guid (VendorsClassId). */
  noteIssuers?: Map<number, number>;
  log?(line: string): void;
}

export function applyPublicPropertyDataIdUpdate(data: PropertyUpdateData, deps: PublicPropertyDataIdDeps): void {
  const val = data.value as number;
  if (data.key === PropertyDataId.VendorsClassId && deps.noteIssuers) {
    if (Number.isFinite(val) && val > 0 && !data.removed) deps.noteIssuers.set(data.guid >>> 0, val >>> 0);
    else deps.noteIssuers.delete(data.guid >>> 0);
  }
  const clearsIconLayer = val === 0 && (data.key === PropertyDataId.IconOverlay || data.key === PropertyDataId.IconUnderlay);
  if (Number.isFinite(val) && (val > 0 || clearsIconLayer)) {
    const obj = deps.getObject(data.guid);
    if (obj) applyPropertyDataIdUpdate(obj, data.key, val);
    else if (deps.inventory.applyPublicPropertyDataId(data.guid, data.key, val)) deps.onInventoryItemChanged(data.guid);
  }
  (deps.log ?? console.log)(`[Property] PublicDID: guid=0x${data.guid.toString(16)} key=${data.key} value=${val}${data.removed ? ' (removed)' : ''}`);
}
