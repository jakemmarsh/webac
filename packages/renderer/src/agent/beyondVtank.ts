/**
 * Routine conditions and actions beyond VTank, Jake 2026-10-12 (AGENT.routine-beyond-vtank): neither VirindiTank
 * nor UtilityBelt had these, so a later VTank-parity audit must not strip them as "not VTank". The routine engine
 * (RoutineEngine.ts) runs them on the agent API's own pieces: attackersOfMe() (the attack lines of the last
 * AgentApi.ATTACKER_WINDOW_MS, each pinned on its creature), the cast-at-you event, walkTo's flee and jump().
 * These are the pure parts, for the engine and its tests (tests/verify-routine-beyond-vtank.ts).
 */
import type { AgentEvent } from './types.ts';
import { objectAt } from './routeNodes.ts';

/**
 * being-cast-at holds this many seconds after a cast-at-you event (unless the condition sets its own): a monster's
 * spell words come a second or two before the bolt, and a caster's next cast is several seconds off.
 */
export const BEING_CAST_AT_S = 5;
/** pull gives up when no swing or shot has landed on the target this long after the attack order (the run-up included). */
export const PULL_LAND_MS = 25_000;
/**
 * How far an aborted recall runs from the attackers: past ACE's 8 m recall-move limit (Player_Location
 * RecallMoveThreshold: a recall that ends more than 8 m from where it began is cancelled, "You have moved too far").
 */
export const RECALL_MOVE_M = 10;
/** How long a recall is waited for before it is called failed (the kneel, or the spell's wind-up, then portal space). */
export const RECALL_WAIT_MS = 30_000;

/** Whether a monster (by distance and bearing from you) stands within the held position's range. */
export function holdAllows(hold: { x: number; y: number; meters: number }, me: { x: number; y: number }, o: { dist: number; bearing: number }): boolean {
  const at = objectAt(me, o);
  return Math.hypot(at.x - hold.x, at.y - hold.y) <= hold.meters;
}

/**
 * Whether a pull has landed: the target is among those attacking you, or a chat line since the order names it in the
 * second person ("You hit the Drudge Skulker for 6 points…", "The Drudge Skulker evaded your attack.", "You killed
 * …"): our own swing or shot. Its attacks on you (CombatEnemy, 0x15) are left to attackersOfMe. Null: not yet.
 */
export function pullLanded(target: { guid: number; name: string }, events: readonly AgentEvent[], attackers: ReadonlyMap<number, number>): string | null {
  if (attackers.has(target.guid)) return `${target.name} turned on you`;
  const name = target.name.toLowerCase();
  for (const e of events) {
    // Not someone's words: a fellow's "/f pull the Drudge Skulker, you tank" named it with "you" (2026-10-16 sweep).
    if (e.type !== 'chat' || e.chatType === 0x15 || /^\((say|tell|emote|channel)\) /.test(e.text)) continue;
    const line = e.text.replace(/^\([a-z]+\) /, '');
    if (line.toLowerCase().includes(name) && /\byou(r)?\b/i.test(line)) return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  }
  return null;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** The compass word pointing away from these creatures (the opposite of their mean bearing), or null with none placed. */
export function awayWord(from: ReadonlyArray<{ bearing: number }>): string | null {
  if (!from.length) return null;
  let sx = 0, sy = 0;
  for (const o of from) { const r = (o.bearing * Math.PI) / 180; sx += Math.sin(r); sy += Math.cos(r); }
  if (Math.hypot(sx, sy) < 1e-6) return COMPASS[Math.round(((from[0].bearing + 90) % 360) / 45) % 8];
  const toward = (Math.atan2(sx, sy) * 180) / Math.PI;
  const away = (toward + 180 + 360) % 360;
  return COMPASS[Math.round(away / 45) % 8];
}
