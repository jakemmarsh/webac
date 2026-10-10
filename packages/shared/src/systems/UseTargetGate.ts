/**
 * UseTargetGate — client-side mirror of ACE's target-resolution gate shared
 * by the Use and IdentifyObject actions. Both are silent server-side when
 * the target guid doesn't resolve to anything at all:
 *
 *   Player_Use.cs:210-214 (HandleActionUseItem):
 *     var item = FindObject(itemGuid, MyInventory | MyEquippedItems | Landblock);
 *     if (item != null) { ... }
 *     else { log.DebugFormat(...); SendUseDoneEvent(); }  // WeenieError.None
 *
 *   Player.cs:265-272 (HandleActionIdentifyObject):
 *     var wo = FindObject(objectGuid, SearchLocations.Everywhere, ...);
 *     if (wo == null) {
 *       Session.Network.EnqueueSend(new GameEventIdentifyObjectResponse(Session, objectGuid));
 *       return;
 *     }
 *
 * Neither branch sends a WeenieError the client renders as text (UseDone's
 * default is WeenieError.None, already silent client-side per FAITHFUL.386;
 * an IdentifyObjectResponse built with no `wo` carries no appraisal data to
 * show) -- so mirroring this buys no new player-facing feedback. The value
 * is avoiding a doomed round-trip for a target guid that went stale between
 * when it was captured and when the action actually dispatches: a right-click
 * context menu stays open for as long as the player leaves it up, and a
 * keybound Use/Examine (GameActionType.Use / IdentifyObject) fires against
 * whatever `currentTargetGuid` was selected, possibly long before the guid
 * stops resolving to anything the client still tracks (picked up, looted,
 * or otherwise removed from the landblock in the meantime).
 */
export function canUseTarget(targetExists: boolean): boolean {
  return targetExists;
}

/** Where the client can find an object, mirroring ACE FindObject's search locations. */
export interface TargetLocations {
  inPack(guid: number): boolean;
  worn(guid: number): boolean;
  inOpenContainer(guid: number): boolean;
  inWorld(guid: number): boolean;
}

/**
 * BUG.examine-pack-item-suppressed — does `guid` still resolve the way ACE's
 * FindObject would: ourselves (Player_Inventory.cs:521-524 checks
 * `objectGuid == Guid` first), our packs, our worn items, the open
 * container, or the landblock (Player_Use.cs:210 MyInventory |
 * MyEquippedItems | Landblock; IdentifyObject searches Everywhere). The
 * old gate asked the 3D-object map only, so every examine of a pack or
 * worn item was dropped before it was sent.
 */
export function targetResolves(guid: number, selfGuid: number | null, where: TargetLocations): boolean {
  if (selfGuid !== null && guid === selfGuid) return true;
  return where.inPack(guid) || where.worn(guid) || where.inOpenContainer(guid) || where.inWorld(guid);
}
