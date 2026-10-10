/**
 * RELEASE.gdle-untested-surfaces.a — what a secure trade hands us arrives on
 * GDLE as a ContainerID property update, not a ServerSaysContainID.
 *
 * GDLE's TradeManager completes a trade with CPlayerWeenie::
 * OnReceiveInventoryItem (Player.cpp): SetWeenieContainer (a
 * PublicUpdateInstanceID 0x02DA, key 2 ContainerID = the receiver), then
 * ReleaseFromBlock (a PickupEvent). It sends no 0x0022, which is what our
 * client (like ACE's TryCreateInInventoryWithNetworking path) puts an item in
 * the pack on. The retail client, which GDLE was written for, reacts to the
 * ContainerID quality itself (ClientObjMaintSystem::<InstanceID_QualityType>::
 * UpdateStat @ 00558360 → QualityRegistrar::CallChangeHandler).
 *
 * Only the partner's offered items take this path: ACE's ground pickup sends
 * the same ContainerID update just before its 0x0022, and that flow keeps
 * running on the 0x0022 alone.
 */
export interface TradeReceiveContext {
  /** Our character's guid (null before login). */
  playerGuid: number | null;
  /** Our side packs. */
  sidePackGuids: readonly number[];
  /** The guids the trade partner has on the table. */
  partnerTradeGuids: readonly number[];
  /** Whether our pack already lists the item. */
  holds: (guid: number) => boolean;
}

/** True when a ContainerID update moves a partner's traded item into our pack (treat it as ServerSaysContainID). */
export function tradeReceiveContainsIn(itemGuid: number, containerGuid: number, ctx: TradeReceiveContext): boolean {
  if (ctx.playerGuid === null) return false;
  if (containerGuid !== ctx.playerGuid && !ctx.sidePackGuids.includes(containerGuid)) return false;
  if (!ctx.partnerTradeGuids.includes(itemGuid)) return false;
  return !ctx.holds(itemGuid);
}
