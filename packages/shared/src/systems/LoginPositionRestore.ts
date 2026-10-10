/**
 * LoginPositionRestore — resolves the client-side restore action for each
 * PositionType entry the server ships in the login PlayerDescription
 * (`reference/ACE/Source/ACE.Server/Network/GameEvent/Events/
 * GameEventPlayerDescription.cs:202-212`, the generic Position hash table).
 *
 * BUG.login-position-restore-unreachable-positiontypes — that hash table is
 * built from exactly ONE entry, `Session.Player.GetPosition(PositionType
 * .LastOutsideDeath)` with `WriteHeader(Writer, 1, 16)` (count hardcoded to
 * 1). LinkedLifestone/LinkedPortalOne/LinkedPortalTwo/LastPortal are never
 * shipped here, at login or live: a repo-wide grep for `new
 * GameMessagePrivateUpdatePosition` across ACE.Server finds exactly one call
 * site (`Creature_Death.cs:559`), which also only ever sends
 * LastOutsideDeath. Binding a lifestone/portal (`WorldObject_Magic.cs`
 * `HandleCastSpell_PortalLink`) only calls `player.LinkedLifestone = ...` /
 * `player.LinkedPortalOneDID = ...` -- property setters that go through
 * `WorldObject_Properties.cs SetPosition`, which writes to
 * positionCache/Biota only, no network send -- plus a plain
 * `SendChatMessage` confirming the link. So LastOutsideDeath is the only
 * PositionType this resolver (or the login snapshot) will ever see; the
 * lifestone/portal binds are instead driven off that SendChatMessage
 * confirmation text in main.ts's onServerMessage handler, since that chat
 * line is the only client-visible signal a Tie actually succeeded.
 */

export interface LoginPosition {
  landblockId: number;
  x: number;
  y: number;
  z: number;
}

export type LoginPositionRestoreAction =
  | { kind: 'lastOutsideDeath'; worldX: number; worldZ: number };

/** PositionType numerics per ACE.Entity.Enum.Properties.PositionType.cs. */
export const POSTYPE_LAST_OUTSIDE_DEATH = 14;

/**
 * Resolve the restore action for one login-snapshot position entry, given
 * its already-converted world coordinates (landblockX/landblockY * 192 +
 * local xy, AC Z -> Three.js Y already applied by the caller). Returns
 * undefined for PositionTypes the login snapshot doesn't need to restore
 * (in practice, any PositionType other than LastOutsideDeath -- see above).
 */
export function resolveLoginPositionRestore(
  positionType: number,
  pos: LoginPosition,
  worldX: number,
  worldY: number,
  worldZ: number,
): LoginPositionRestoreAction | undefined {
  switch (positionType) {
    case POSTYPE_LAST_OUTSIDE_DEATH:
      return { kind: 'lastOutsideDeath', worldX, worldZ };
    default:
      return undefined;
  }
}
