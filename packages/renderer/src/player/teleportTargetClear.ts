/**
 * FAITHFUL.461 / FAITHFUL.463 — what a server teleport (lifestone recall,
 * /house, portal traversal: ACE PlayerTeleport) drops on the client side.
 * Every case moves the player well outside the previous target's range, so
 * the selection, its lighting, the HUD target panel, the melee approach /
 * auto-attack chain and any server MoveTo all end (the same chain as the
 * death and respawn paths, FAITHFUL.459 / .460).
 */
export interface TeleportClearTargets {
  clearCurrentTarget(): void;
  selectionLighting: { clear(): void };
  hudState: { target: unknown };
  /** clearAutoAttackChain(combatController); main stores the returned melee target. */
  clearAutoAttackChain(): void;
  cancelMoveTo?(): void;
}

export function clearTargetOnTeleport(t: TeleportClearTargets): void {
  t.clearCurrentTarget();
  t.selectionLighting.clear();
  t.hudState.target = null;
  t.clearAutoAttackChain();
  t.cancelMoveTo?.();
}
