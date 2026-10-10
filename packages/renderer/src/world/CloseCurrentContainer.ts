export interface CloseCurrentContainerContext {
  /** The open ground container (gmExternalContainerUI::groundObjectID), 0 when none. */
  containerGuid: number;
  /** ItemHolder::UseObject(id, 0, 0): use the container again (ACE closes an open container its viewer uses). */
  useObject: (guid: number) => void;
  /** CPlayerSystem::UnregisterObjectRangeHandler for the panel's range entry. */
  unregisterRange: () => void;
  /** ItemList_Flush + ItemList_SetParentContainer(0) — the panel's lists. */
  flush: () => void;
}

/**
 * gmExternalContainerUI::CloseCurrentContainer @ 004cbcb0 — shared by the
 * panel's close box and the range exit. With a container open: use it again
 * (ItemHolder::UseObject(groundObjectID, 0, 0)), drop the range entry, and
 * flush the lists; with none open it does nothing. Returns the new
 * groundObjectID (always 0).
 *
 * The Use is what closes it. ACE Container.ActOnUse closes an open container
 * whose viewer uses it, and Player.HandleActionUseItem skips the walk-to for
 * the player's LastOpenedContainerId, so a range-exit close never pulls the
 * player back. NoLongerViewingContents is retail's message only when the
 * ground object is replaced (ClientUISystem::SetGroundObject).
 *
 * DECOMP.chest-close-extra-motion — no local lid motion: the lid closes
 * from ACE's own broadcast (Container.Close → Chest.Close →
 * ExecuteMotion(motionClosed)).
 */
export function closeCurrentContainer(ctx: CloseCurrentContainerContext): number {
  if (ctx.containerGuid !== 0) {
    ctx.useObject(ctx.containerGuid);
    ctx.unregisterRange();
    ctx.flush();
  }
  return 0;
}

export interface ReleaseGroundObjectContext {
  /** ClientUISystem::groundObject, 0 when none. */
  containerGuid: number;
  /** CM_Inventory::Event_NoLongerViewingContents(id). */
  noLongerViewing: (guid: number) => void;
  /** Hide the container panel (CM_Item::SendNotice_SetGroundObject(0)). */
  hidePanel: () => void;
  unregisterRange: () => void;
  flush: () => void;
}

/**
 * ClientUISystem::SetGroundObject(0, true) @ 00564510: drop the open ground
 * container without using it and tell the server we stopped viewing it.
 * Retail's callers are CPlayerSystem::RecvNotice_ServerSaysMoveItem
 * @ 00563260 (the server moved the very object being viewed) and
 * ClientUISystem::CleanUpGameUI @ 005648a0 (leaving the world). Returns the
 * new groundObject (always 0).
 */
export function releaseGroundObject(ctx: ReleaseGroundObjectContext): number {
  if (ctx.containerGuid !== 0) {
    ctx.noLongerViewing(ctx.containerGuid);
    ctx.hidePanel();
    ctx.unregisterRange();
    ctx.flush();
  }
  return 0;
}
