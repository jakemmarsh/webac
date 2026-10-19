/**
 * VirindiTank's monster blacklist and ghost removal (docs/vtank-macro-behavior.md
 * "Blacklist and ghosts"; facts from MOSS CombatFailureTracker,
 * MonsterHealthTracker and CombatController, read for facts only):
 *
 * - An attempt that provably didn't reach a monster is a miss: a cast the
 *   server never answered, or "Your missile attack hit the environment." (ACE
 *   ProjectileCollisionHelper / Creature_Missile, AC1999 Ammunition.cpp: the
 *   same words; bolts and arrows alike). An ordinary miss or evade is not.
 *   One more miss than BlacklistMonsterAttemptCount (4) blacklists it for
 *   BlacklistMonsterTimeoutSeconds (120), and the count starts over. A blow
 *   that lands or a debuff that goes on clears the count.
 * - "Invalid target" blacklists it at once: AC1999 / GDLE WeenieError 0x04FA
 *   "{target} is an invalid target.", ACE Player_Magic.VerifySpellTarget
 *   "{spell} cannot be cast on {target}.".
 * - A ghost (the client still draws a monster the server has dropped):
 *   GhostMonsterSpellAttemptCount (200) casts in a row with no answer at all
 *   (DeleteGhostMonsters), or, for a monster the era's table gives a maximum
 *   health, GhostDeleteHPTrackerSeconds (30) on it with no change to its
 *   health (DeleteGhostMonstersByHPTracker).
 *
 * VTank deletes a ghost from the client. Ours leaves the client's objects
 * alone and sets the ghost aside instead: it is no target until its health
 * reads differently or it leaves view. INF: VTank's HP tracker counts each
 * health report from the server; the client gives us the latest fraction
 * only, so a change of value counts.
 */
export interface TrackerSettings {
  BlacklistMonsterAttemptCount: number;
  BlacklistMonsterTimeoutSeconds: number;
  DeleteGhostMonsters: boolean;
  GhostMonsterSpellAttemptCount: number;
  DeleteGhostMonstersByHPTracker: boolean;
  GhostDeleteHPTrackerSeconds: number;
}

/** The server's words for a cast at something that can't be its target (see above). */
export const INVALID_TARGET = /\bis an invalid target\b|\bcannot be cast on\b/i;
/** A bolt or an arrow stopped by the world (ACE and AC1999 alike). */
export const HIT_ENVIRONMENT = /^Your missile attack hit the environment\.?$/i;

interface Entry {
  name: string;
  misses: number;
  silent: number;
  blacklistedUntil: number;
  /** Set aside as a ghost: its health then (undefined: none known). */
  ghost?: { health: number | undefined };
  seenAt: number;
}

export class TargetTracker {
  private entries = new Map<number, Entry>();
  /** The monster being fought, for the HP tracker: when it was taken on, its last health and when that last changed. */
  private hp: { guid: number; name: string; since: number; health: number | undefined; changedAt: number | null } | null = null;

  constructor(private readonly now: () => number) {}

  private get(guid: number, name: string): Entry {
    let e = this.entries.get(guid);
    if (!e) this.entries.set(guid, (e = { name, misses: 0, silent: 0, blacklistedUntil: 0, seenAt: this.now() }));
    return e;
  }

  /**
   * The monsters in view this pass (with the selected one's health). A ghost whose health now reads
   * differently is real after all; an entry not seen for five minutes (or the blacklist time, if
   * longer) is forgotten, so a monster back in view later starts clean.
   */
  observe(monsters: Array<{ guid: number; name: string; health?: number }>, s: TrackerSettings): void {
    const t = this.now();
    const live = new Set<number>();
    for (const m of monsters) {
      live.add(m.guid);
      const e = this.entries.get(m.guid);
      if (e) {
        e.seenAt = t;
        if (e.ghost && m.health !== undefined && m.health !== e.ghost.health) delete e.ghost;
      }
      if (this.hp?.guid === m.guid && m.health !== this.hp.health) { this.hp.health = m.health; this.hp.changedAt = t; }
    }
    for (const [g, e] of this.entries) {
      // A ghost out of view is gone for good; anything else is kept a while (its blacklist runs on).
      if (!live.has(g) && (e.ghost || t - e.seenAt > Math.max(300, s.BlacklistMonsterTimeoutSeconds) * 1000)) this.entries.delete(g);
    }
    if (this.hp && !live.has(this.hp.guid)) this.hp = null;
  }

  /** Whether the macro leaves this monster out: blacklisted, or set aside as a ghost. */
  excluded(guid: number): boolean {
    const e = this.entries.get(guid);
    return !!e && (!!e.ghost || e.blacklistedUntil > this.now());
  }

  /** A miss (see above). The notice when it tipped the monster onto the blacklist. */
  miss(guid: number, name: string, s: TrackerSettings): string | null {
    const e = this.get(guid, name);
    e.misses++;
    if (e.misses <= s.BlacklistMonsterAttemptCount) return null;
    const n = e.misses;
    e.misses = 0;
    this.blacklist(e, s);
    return `${name} blacklisted for ${Math.round(s.BlacklistMonsterTimeoutSeconds)} s: ${n} attempts in a row didn't reach it`;
  }

  /** The server called it an invalid target: blacklisted at once. */
  invalid(guid: number, name: string, s: TrackerSettings): string {
    const e = this.get(guid, name);
    e.misses = 0;
    this.blacklist(e, s);
    return `${name} blacklisted for ${Math.round(s.BlacklistMonsterTimeoutSeconds)} s: the server says it is an invalid target`;
  }

  /** The deadline only moves out, never in. */
  private blacklist(e: Entry, s: TrackerSettings): void {
    e.blacklistedUntil = Math.max(e.blacklistedUntil, this.now() + Math.max(0, s.BlacklistMonsterTimeoutSeconds) * 1000);
  }

  /** It was reached (a blow landed, a debuff went on): the miss count starts over. */
  reached(guid: number): void {
    const e = this.entries.get(guid);
    if (e) e.misses = 0;
  }

  /** The server answered a cast at it (anything at all): the silence count starts over. */
  answered(guid: number): void {
    const e = this.entries.get(guid);
    if (e) e.silent = 0;
  }

  /** A cast at it with no answer at all. The notice when that made it a ghost. */
  silent(guid: number, name: string, health: number | undefined, s: TrackerSettings): string | null {
    const e = this.get(guid, name);
    e.silent++;
    if (e.silent <= s.GhostMonsterSpellAttemptCount) return null;
    e.silent = 0;
    if (!s.DeleteGhostMonsters) return null;
    e.ghost = { health };
    return `ghost monster ${name} set aside: ${s.GhostMonsterSpellAttemptCount} casts at it were never answered`;
  }

  /** The macro acts on this monster (a cast or an attack): the HP tracker follows it from now, unless it already does. */
  engage(guid: number, name: string, health: number | undefined): void {
    if (this.hp?.guid === guid) return;
    this.hp = { guid, name, since: this.now(), health, changedAt: health === undefined ? null : this.now() };
  }

  /**
   * DeleteGhostMonstersByHPTracker: the monster fought for GhostDeleteHPTrackerSeconds whose health
   * hasn't changed in that time is a ghost. Only one with a known maximum health (`listed`): for any
   * other, an unchanging health says nothing. The notice when it was set aside.
   */
  checkHp(listed: (name: string) => boolean, s: TrackerSettings, why?: (guid: number) => string | null): string | null {
    const h = this.hp;
    if (!h || !s.DeleteGhostMonstersByHPTracker || !listed(h.name)) return null;
    const t = this.now();
    const stale = Math.max(0, s.GhostDeleteHPTrackerSeconds) * 1000;
    if (t - h.since < stale || (h.changedAt !== null && t - h.changedAt < stale)) return null;
    const e = this.get(h.guid, h.name);
    e.ghost = { health: h.health };
    this.hp = null;
    const secs = Math.round(s.GhostDeleteHPTrackerSeconds);
    // The likely reason when one is known (no line of fire, another floor, out of range, bolts into the wall): a monster
    // the routine couldn't hit is no ghost. "ghost monster Ancient Mu-miyah set aside" was a mummy behind a wall from
    // Arcanist, its one bolt blocked (Sand Shallow, 2026-10-19 14:19:20Z).
    const reason = why?.(h.guid) ?? (e.misses > 0 ? `${e.misses === 1 ? 'an attack' : `${e.misses} attacks`} at it hit the environment (a wall or the floor in the way)` : null);
    if (reason) return `${h.name} set aside: its health hasn't changed in ${secs} s of fighting it, most likely because ${reason}; it is a target again once its health changes or it leaves view`;
    return `ghost monster ${h.name} set aside: its health hasn't changed in ${secs} s of fighting it`;
  }

  /** Death or a fresh start: nothing is held against anyone. */
  clear(): void { this.entries.clear(); this.hp = null; }
}
