/**
 * FriendsUpdateType — flag bitfield indicating WHY the server sent a
 * FriendsListUpdate event.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/GameEvent/Events/
 *   GameEventFriendsListUpdate.cs (nested enum FriendsUpdateTypeFlag)
 *
 *   FullList            = 0x0000   — initial / full refresh
 *   FriendAdded         = 0x0001   — single friend added
 *   FriendRemoved       = 0x0002   — single friend removed
 *   FriendStatusChanged = 0x0004   — online state changed
 *
 * Wire format: uint32 trailing field on FriendsListUpdate payload.
 *
 * The single-friend updates (Added/Removed/StatusChanged) still arrive
 * with the FULL friends array — the type field is just a UI hint for
 * whether to show "<name> has been added/removed/come online".
 */
export enum FriendsUpdateType {
  FullList            = 0x0000,
  FriendAdded         = 0x0001,
  FriendRemoved       = 0x0002,
  FriendStatusChanged = 0x0004,
}
