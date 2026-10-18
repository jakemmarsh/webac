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

/**
 * Macro settings beyond VTank (STREAM.routines-default, 2026-10-17): the stream pair's Mountain Keep (0x01D2) and Tusker
 * Habitat (0x5B47) hunts, where a melee macro ran at Dreads a floor up or behind a wall, and a tank's targeting never
 * looked at what was on its caster. They sit beside VTank's options in a profile's settings (any case) and an export
 * leaves them out (VTank ignores names it doesn't know).
 *   SkipUnreachableMonsters (on): with melee (no caster or bow in hand, not in magic or missile mode), a monster that
 *     is aimed at you but not reaching you (observe's AIMED AT YOU BUT NOT REACHING YOU: a chase no nearer in
 *     AgentApi.AGGRO_STALL_MS) or that stands a storey up or down indoors is no target: the server's straight-line
 *     walk-in can't reach it. A bolt still can when its line is open (UseProjectileAwareness decides that).
 *   ProtectFellows (off): a monster on a fellow (by the fellows line's rule: AgentApi.comingAt(fellow), within reach of
 *     them) is fought before the others of its priority, out to ProtectFellowsDistance metres from you even past
 *     Monster Range, and a swing at another breaks off when one gets on a fellow (peeling for the caster).
 *   OnlyEngaged (off): the macro starts no fights of its own. It fights only what is attacking you, coming at you, on or
 *     coming at a fellow in view, or the monster you last attacked or cast at by hand (RoutineEngine.pickedTarget): the
 *     player picks the pulls, the macro fights them out (heals, restams and peels between swings).
 *   WeighBoltsByDamage (on; 2026-10-18): a caster's Auto element is the one whose best castable bolt does the most against
 *     the monster (the bolt's damage from the era's spell table times the monster's Resist* multiplier for it), not the
 *     first of its damage list it can bolt at all (combatPlan.strongestBolt): Acid Stream I over Flame Bolt V at a Dread
 *     Mu-miyah, which takes both alike.
 */
export const BEYOND_MACRO_DEFAULTS = { SkipUnreachableMonsters: true, ProtectFellows: false, ProtectFellowsDistance: 25, OnlyEngaged: false, WeighBoltsByDamage: true } as const;

/** A beyond-VTank macro setting from a profile's settings (any case), else its default. */
export function beyondSetting<K extends keyof typeof BEYOND_MACRO_DEFAULTS>(settings: Record<string, string | number | boolean>, name: K): (typeof BEYOND_MACRO_DEFAULTS)[K] {
  const want = name.toLowerCase();
  const d = BEYOND_MACRO_DEFAULTS[name];
  for (const [k, v] of Object.entries(settings)) {
    if (k.toLowerCase() !== want) continue;
    if (typeof d === 'boolean') return (v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v))) as (typeof BEYOND_MACRO_DEFAULTS)[K];
    const n = Number(v);
    return (Number.isFinite(n) ? n : d) as (typeof BEYOND_MACRO_DEFAULTS)[K];
  }
  return d;
}
