/**
 * A character the server has stopped playing: the stream supervisor's safety net (supervisor.ts).
 *
 * 2026-10-15, Claude Bulwark, local end-of-retail ACE: he portalled into Tumerok Cavern (landblock 0x0292) at
 * 10:09:25 UTC, 4 min 57 s after the last player had left it. ACE unloads a landblock 5 minutes after its last
 * activity (Landblock.UnloadInterval), and a player's own SetActive only runs from his 5-second heartbeat, so the
 * landblock unloaded with him just added: Landblock.Unload() removed him (CurrentLandblock = null) and nothing put
 * him in another. From then on the server never ticked him: no vital regen (HP 121/135 and mana 5/10 for four
 * hours), no enchantment expiry (every buff timer at "0s"), no position updates (ValidateMovement refuses with no
 * landblock, so the server kept him at the arrival point and his partner couldn't see him), and every action chain
 * of his was dropped (WorldObject.EnqueueAction drops a detached Creature's work), so the /ls he tried at 10:14 set
 * IsBusy and the chain that clears it never ran: "You're too busy!" for every later use, recall and gem. Only a
 * logout and login puts him back in a landblock (the 14:08 restart did).
 *
 * The signs, all readable without taking the player's turn:
 * - the vitals stop regenerating: polls of the daemon's /vitals show no vital rising (they can still fall: a jump
 *   costs stamina) while one is below its maximum;
 * - every action that needs the server is refused: "You're too busy!" in the chat log, "no reply", "interrupted",
 *   "Action cancelled" in the player's tool results, and none of its acting calls succeeds.
 * When both have held for `minutes`, the supervisor logs the character out and back in.
 */
import type { AgentVitals } from '../../packages/renderer/src/agent/types.ts';

/** Agent tools whose success needs the server to act on the character (walking and looking are the client's own). */
export const SERVER_ACTIONS: ReadonlySet<string> = new Set([
  'use', 'use_on', 'attack', 'cast', 'pick_up', 'loot', 'give', 'buy', 'sell', 'trade', 'drop', 'vendor',
]);

/** A refusal or a non-answer from the server, in a tool result or a chat line. */
export const REFUSAL = /you'?re too busy|you are too busy|no reply within|\binterrupted\b|action cancelled/i;

/** A chat-log line (`<iso> <text>`) that is the server's "You're too busy!". */
export function isBusyChatLine(line: string): boolean {
  return /^\S+ (?:\(\w+\) )?You(?:'re| are) too busy!?\s*$/.test(line);
}

/** What one agent CLI result says about the server: refused, answered, or nothing either way. */
export function classifyResult(tools: readonly string[], text: string): 'refused' | 'ok' | null {
  if (REFUSAL.test(text)) return 'refused';
  if (!tools.some((t) => SERVER_ACTIONS.has(t))) return null;
  // A call still going ("… is still in progress after 30 s") or a usage error says nothing about the server.
  if (/still in progress|^error:|unknown argument|exit code \d/i.test(text)) return null;
  return 'ok';
}

export interface StuckVerdict { why: string }

/** One character's watch. Feed it vitals polls, tool results and chat refusals; ask it whether to relog. */
export class StuckWatch {
  /** Since when no vital has risen (null: unknown, dead, or out of the world). */
  private frozenSince: number | null = null;
  private last: AgentVitals | null = null;
  private refusals: Array<{ what: string; t: number }> = [];
  private quietUntil = 0;

  constructor(readonly minutes: number, readonly minRefusals = 3) {}

  vitals(v: AgentVitals | null, t: number): void {
    const prev = this.last;
    this.last = v;
    if (!v || v.dead || !prev || prev.dead) { this.frozenSince = v && !v.dead ? t : null; return; }
    const rose = v.health.cur > prev.health.cur || v.stamina.cur > prev.stamina.cur || v.mana.cur > prev.mana.cur;
    if (rose || this.frozenSince === null) this.frozenSince = t;
  }

  refused(what: string, t: number): void {
    this.refusals.push({ what, t });
  }

  /** The server acted on something the character asked: whatever was refused before is not the stuck state. */
  answered(): void { this.refusals = []; }

  /** After a relog: start over, and don't judge again until a full window has passed. */
  reset(t: number): void {
    this.frozenSince = null;
    this.last = null;
    this.refusals = [];
    this.quietUntil = t + this.minutes * 60_000;
  }

  verdict(t: number): StuckVerdict | null {
    const v = this.last;
    if (!v || v.dead || this.frozenSince === null || t < this.quietUntil) return null;
    const frozenMs = t - this.frozenSince;
    if (frozenMs < this.minutes * 60_000) return null;
    const below = (['health', 'stamina', 'mana'] as const).filter((n) => v[n].cur < v[n].max);
    if (!below.length) return null; // full vitals that don't rise say nothing
    // Only refusals since the vitals froze count (an earlier "too busy" was an ordinary busy moment).
    const since = this.refusals.filter((r) => r.t >= this.frozenSince!);
    if (since.length < this.minRefusals) return null;
    const vit = below.map((n) => `${n} ${v[n].cur}/${v[n].max}`).join(', ');
    return { why: `no vital has risen for ${Math.round(frozenMs / 60_000)} min (${vit}) and the server refused all ${since.length} actions since (${[...new Set(since.map((r) => r.what))].slice(0, 3).join('; ')})` };
  }
}
