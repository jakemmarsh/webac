/**
 * SetStackSize (0x0197) application logic — FAITHFUL.157 + GAP.10 +
 * CORE.10.a. Extracted from the main.ts handler so the wiring is
 * behaviorally testable (the old test source-grepped main.ts).
 *
 * ACE emits GameMessageSetStackSize on every stack mutation (splits,
 * merges, ammo launches, vendor sales). One message must update every
 * client-side mirror of that guid:
 *  - the equipped-item copy (GAP.10 — wielded ammo decrements),
 *  - the persisted world object (CORE.10.a — ground stacks),
 *  - a live toolbar selection of the stack (CORE.10.a — the split UI
 *    re-bounds maxSplitSize and clamps the user's split choice),
 *  - the player inventory item (+ its open-container mirror),
 *  - an open container/vendor panel's copy.
 */

export interface SetStackSizeData {
  guid: number;
  stackSize: number;
  value: number;
}

export interface SetStackSizeDeps {
  /** PlayerState.equipment — updates a wielded copy (GAP.10). */
  equipmentUpdateStackSize: (guid: number, stackSize: number) => void;
  /** PlayerState.inventory.getItem — the player-pack copy. */
  getInventoryItem: (guid: number) => { stackSize: number; value: number } | undefined;
  /** OpenContainerTracker.updateStackSize — returns true when the guid was present. */
  openContainerUpdateStackSize: (guid: number, stackSize: number) => boolean;
  /** ServerObjectManager.getObject — the persisted world object (may be absent). */
  getWorldObject: (guid: number) => { stackSize: number } | undefined;
  /** The live toolbar selection (hudState.target), if any. */
  getToolbarTarget: () => { id: number; stackSize?: number } | null;
  /** Guid of the open container panel, 0/null when closed. */
  getOpenContainerGuid: () => number | null;
  syncInventoryUI: () => void;
  syncOpenContainerUI: () => void;
  updateHUD: () => void;
}

export function applySetStackSize(deps: SetStackSizeDeps, data: SetStackSizeData): void {
  // GAP.10 — equipped stacks (wielded arrows/thrown weapons) live as a
  // COPY in the equipment map; ACE decrements ammo after every launch
  // via this same message (UpdateAmmoAfterLaunch), so update the
  // equipped copy too or the wielded ammo count goes stale.
  deps.equipmentUpdateStackSize(data.guid, data.stackSize);

  // CORE.10.a — keep the persisted world object's stack count (and a
  // live toolbar selection of this stack) tracking splits/merges.
  const worldObj = deps.getWorldObject(data.guid);
  if (worldObj) worldObj.stackSize = data.stackSize;
  const toolbarSel = deps.getToolbarTarget();
  if (toolbarSel && toolbarSel.id === data.guid) {
    toolbarSel.stackSize = data.stackSize;
    deps.updateHUD();
  }

  // Player inventory (most common case — splits + consumption).
  const invItem = deps.getInventoryItem(data.guid);
  if (invItem) {
    invItem.stackSize = data.stackSize;
    if (data.value > 0) invItem.value = data.value;
    deps.syncInventoryUI();
    // If this stack is also rendered in an open container panel, refresh it
    // too (e.g. selling stacks of components at a vendor reduces the player
    // stack while the vendor stack grows — same SetStackSize machinery).
    deps.openContainerUpdateStackSize(data.guid, data.stackSize);
    return;
  }
  // Container/ground item (vendor stacks, corpse loot, world drops).
  if (deps.openContainerUpdateStackSize(data.guid, data.stackSize) && deps.getOpenContainerGuid()) {
    deps.syncOpenContainerUI();
  }
}
