/**
 * RECON.death-flow-behavioral-tests — the edge main.ts's checkPlayerDeath
 * acts on. ACE is authoritative for death (Player_Death.cs): it drops
 * Health to 0 (PlayerKilled + VictimNotification), teleports the player to
 * the lifestone and restores the vitals (75% of max, Player_Death.cs
 * TeleportOnDeath / SetMinimumVitae). The client only follows Health:
 *  - alive → Health <= 0: 'died' (mark dead, stop auto-attack, drop the
 *    target chain and pending casts; no local "You have died!" line,
 *    FAITHFUL.264);
 *  - dead → Health > 0: 'revived' (the death animation state ends).
 */
export type DeathTransition = 'died' | 'revived' | null;

export function deathTransition(wasDead: boolean, isDeadNow: boolean): DeathTransition {
  if (!wasDead && isDeadNow) return 'died';
  if (wasDead && !isDeadNow) return 'revived';
  return null;
}
