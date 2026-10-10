/**
 * BUG.6 — first-spawn position resolution.
 *
 * ACE's failed-first-spawn path (WorldManager.cs:223-241) relocates the
 * player with LandblockManager.AddObject followed by a 5s-delayed Teleport.
 * Under fragment-timing skew the client can process the PlayerTeleport
 * BEFORE its own CreateObject, and the CreateObject may arrive without a
 * usable position — pre-fix, startGame() then never ran and the client sat
 * at character select forever while network-in-world.
 *
 * The teleport handler stashes its position pre-game; this helper decides
 * what position (if any) the player's own CreateObject should start at.
 */
export interface SpawnPos {
  landblock: number;
  x: number; y: number; z: number;
  rw: number; rx: number; ry: number; rz: number;
}

/**
 * Returns the position the game should start at, or null when there is
 * nothing usable (no position on the CreateObject and no stashed pre-game
 * teleport). The stash is only valid before the game has started — after
 * that, a positionless CreateObject is an appearance update, not a spawn.
 */
export function resolveFirstSpawnPosition(
  objPosition: SpawnPos | null | undefined,
  preGameTeleportPos: SpawnPos | null,
  gameStarted: boolean,
): SpawnPos | null {
  if (objPosition) return objPosition;
  if (!gameStarted && preGameTeleportPos) return preGameTeleportPos;
  return null;
}
