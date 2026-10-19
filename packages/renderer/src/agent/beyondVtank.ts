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
 *     stands a storey up or down indoors, or that is aimed at you but not reaching you (observe's AIMED AT YOU BUT NOT
 *     REACHING YOU: a chase no nearer in AgentApi.AGGRO_STALL_MS), is no target, unless indoors the doorway route reaches
 *     it (AgentApi.walkReaches): then the walk to it judges (AgentApi.meleeChaseBar: the long way round, another storey,
 *     a fellow left behind), and one a walk reaches is fought, as the routine's far attack walks there (2026-10-19: "Bulwark
 *     fights" left every Sand Shallow mummy stuck behind a wall alone, and Bulwark fetched each by hand with far=true).
 *     A bolt still reaches what its line is open to (UseProjectileAwareness decides that), and observe says, of a stuck
 *     one, which fellow in view has a line of fire to it.
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
 *   BuffMinLandChance (75; 2026-10-18): a buff level whose cast chance (ACE SkillCheck.GetMagicSkillChance: your buffed
 *     school skill against its power) is under this percent is passed over for the next level down, as the cast tool's
 *     level pick does (AgentApi.SPELL_PICK_MIN_CHANCE). VTank's SpellDiffExcessThreshold-Buff (5) alone let Impenetrability
 *     VI and Invulnerability Self VI through at Item / Creature Enchantment 255 against 250: 59%, two casts in five
 *     fizzled (Arcanist, Aerbax Haven, 2026-10-18 06:18:57–06:19:03Z). 0 is VTank's rule only.
 *   FollowLeash (0, off; 2026-10-18): with a Follow route running, a leader farther than Follow/Nav Min
 *     (NavCloseStopRange) + this many metres, or out of sight in another room, is followed before the macro buffs or
 *     fights (recharging still first, and a monster hitting you is still fought). VTank fights first wherever the leader
 *     went: Arcanist's routine bolted a mild chaser from where it stood while Bulwark walked on, 16–28 m ahead (Aerbax
 *     Laboratory, 2026-10-18 14:17Z). A caster's close-in for range or a line (AgentApi.castAttack) never takes you past it.
 *   FollowThroughPortals (on; 2026-10-18): a Follow route's leader who goes through a portal (they stood beside it, then the
 *     server placed them far off or in another space, or they went from your client) is followed through it, and one placed
 *     in another space is followed by the portal near you that took you to their landblock before (AgentApi.fellowPortal).
 *     VTank's Follow stands still once the leader is out of sight: Arcanist's stood when Bulwark took Aerbax Laboratory's
 *     Surface portal 2 m from her and came back in at the entrance, 622 m off by no foot route (2026-10-18 14:51:58Z).
 *   FightBeforeBuffs (60; 2026-10-18): with a monster you can fight in range hitting you or coming at you (not one stuck
 *     behind a wall), a due rebuff (VTank's BuffSelfNormal: a buff under RebuffTimeRemainingSeconds, or a bane missing on
 *     a piece) waits for the fight, up to this many seconds of it; then buffs go in again as VTank orders them (above
 *     Attack), so a long fight doesn't run them out. A Force Buff round is never held. VTank casts the rebuff first:
 *     "Arcanist fights" cast Invulnerability Self VI and four banes while two Innocuous Dolls hit him at the Aerbax
 *     Laboratory portal, until he bolted them by hand (2026-10-18 18:40:05–17Z). 0 is VTank's order.
 *   SeekLineOfFire (on; 2026-10-19): a caster (not melee; a bow only says it) whose bolt line to a monster hitting you, running at
 *     you or on a fellow (within Monster Range) is blocked steps to the nearest spot within 3 m with an open line, else
 *     beside the fellow whose place has one (AgentApi.lineOfFireMove); two steps that open none, or no such spot, and the
 *     routine's log says so and it waits for the monster to come round. VTank leaves a blocked monster for the pass and
 *     stands: "Arcanist fights" stood 50 s, silent, with a Dread Mu-miyah 4 m off running at him behind a wall (Mountain
 *     Keep, 2026-10-19 15:33Z). Off is VTank's way.
 */
export const BEYOND_MACRO_DEFAULTS = { SkipUnreachableMonsters: true, ProtectFellows: false, ProtectFellowsDistance: 25, OnlyEngaged: false, WeighBoltsByDamage: true, BuffMinLandChance: 75, FollowLeash: 0, FollowThroughPortals: true, FightBeforeBuffs: 60, SeekLineOfFire: true } as const;

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
