import type { OpenContainerTracker } from './OpenContainerTracker';

/**
 * BUG.login-sidepack-viewcontents-opens-panel — classify an incoming
 * ViewContents before any panel/sound side effects run.
 *
 * ACE's login sequence (Player_Networking.cs SendInventoryAndWieldedItems
 * :242-262, called from SendSelf) sends one GameEventViewContents per side
 * pack the character carries — a silent contents snapshot ordered by
 * PlacementPosition (GameEventViewContents.cs:15-16), NOT a user-initiated
 * container open. Retail filled its own CObjectInventory from these and
 * showed nothing; only an external container open (ACE
 * Container.SendInventory, Container.cs:786-808) may pop the panel, queue
 * the lid motion, and play the Sound.Open chime.
 *
 * Wire-order landmine (observed live, 2026-08-22): GameEventViewContents
 * ships on GameMessageGroup.UIQueue while CreateObject ships on the object
 * queue, so the login pack's ViewContents CAN arrive before the pack's own
 * CreateObject — the pack is then in neither sidePackGuids nor the
 * inventory. The decisive signal is that a genuine user container-open is
 * impossible for a guid the client has never seen: the player can only Use
 * a world object that already exists locally (ACE only calls
 * Container.Open from ActOnUse). An unknown-guid ViewContents is therefore
 * always a silent snapshot, never an open.
 *
 * Routes:
 *  - 'own-pack': the player themself, one of their carried packs, or a
 *    container the client doesn't know at all (login race above). The
 *    event's authoritative PlacementPosition order is applied via
 *    ctx.setSlotForItem; the caller must mark the inventory dirty and do
 *    nothing else.
 *  - 'sub': fills a nested container of the already-open external
 *    container (panel state must not be reset).
 *  - 'opened': (re)opens an external container — show panel, lid motion,
 *    open chime.
 *  - 'deferred': a GDLE nested pack's list that came before the pack itself
 *    (RELEASE.gdle-contents-before-viewcontents); the tracker keeps it and
 *    the caller does nothing else.
 */
export interface ViewContentsContext {
  /** Player character guid, null before login completes. */
  charGuid: number | null;
  /** [0] = main pack (player guid), [1..] = side packs, arrival order. */
  sidePackGuids: readonly number[];
  /** Whether the guid has an inventory record (side pack already landed). */
  hasInventoryItem: (guid: number) => boolean;
  /** Whether the guid exists as a client-known world object. */
  isKnownWorldObject: (guid: number) => boolean;
  /** Persist one item's authoritative slot index within its container. */
  setSlotForItem: (guid: number, slot: number) => void;
  /** External-container state (chest/corpse/hook + nested packs). */
  tracker: OpenContainerTracker;
}

export function routeViewContents(
  ctx: ViewContentsContext,
  containerGuid: number,
  items: Array<{ guid: number; containerType: number }>,
): 'own-pack' | 'sub' | 'opened' | 'deferred' {
  const t = ctx.tracker;
  // The already-open external container (refresh) or one of its tracked
  // nested containers. Checked FIRST: Container.SendInventory sends the
  // nested pack's ViewContents before its CreateObject (Container.cs
  // :786-808), so a tracked-but-unknown guid must still route 'sub'.
  const externalTracked = t.openGuid !== 0
    && (containerGuid === t.openGuid || t.has(containerGuid));
  if (!externalTracked) {
    const isOwnPack = (ctx.charGuid !== null && containerGuid === ctx.charGuid)
      || ctx.sidePackGuids.includes(containerGuid)
      || ctx.hasInventoryItem(containerGuid);
    // RELEASE.gdle-contents-before-viewcontents — a GDLE nested pack's 0x196
    // arrives before the pack's own CreateObject (MakeAwareViewContent
    // recurses into packs first), after its items' CreateObjects named it as
    // their container: kept for when the outer container is opened.
    if (!isOwnPack && !ctx.isKnownWorldObject(containerGuid) && t.hasEarlyContentsFor(containerGuid)) {
      t.noteEarlyContentsList(containerGuid, items);
      return 'deferred';
    }
    if (isOwnPack || !ctx.isKnownWorldObject(containerGuid)) {
      for (let i = 0; i < items.length; i++) ctx.setSlotForItem(items[i].guid, i);
      return 'own-pack';
    }
  }
  return t.viewContents(containerGuid, items);
}
