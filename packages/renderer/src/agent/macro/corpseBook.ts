/**
 * VirindiTank's corpse bookkeeping (docs/vtank-parity-gaps.md §3.3, §3.6):
 * which corpses may be looted, and what is remembered about each one until
 * it is forgotten. Facts from MOSS (openac-mosstank Looting.CorpseScan,
 * read for facts only; no code copied):
 *
 * - A corpse's killer is in its description, "Killed by <name>." (ACE
 *   Creature_Death.cs writes it with the admin "+" stripped; GDLE and the
 *   AC1999 server write the same sentence, Monster.cpp CreateCorpse). The
 *   description comes from examining the corpse (its LongDesc, string 16).
 * - Your own kill is always lootable. A fellow's kill only with
 *   LootFellowCorpses, at once when that fellow shares loot, else after
 *   100 s; anyone else's kill only with LootAllCorpses, after 100 s. A
 *   corpse with no killer in its description, and someone else's rare, never.
 * - The server's refusals ("… is already in use by someone else!", "You do
 *   not yet have the right to loot …"; GDLE / AC1999: "You do not have
 *   permission to loot that corpse!") skip the corpse for 10 s.
 * - An open that never answers counts an attempt; at
 *   BlacklistCorpseOpenAttemptCount the corpse is skipped for
 *   BlacklistCorpseOpenTimeoutSeconds. A description that never comes counts
 *   too: after three VTank skips the corpse the same way; ours stops asking,
 *   and an undescribed corpse is taken only as your own kill by its name.
 * - What is known about a corpse is forgotten once it has been out of sight
 *   for CorpseCacheTimeoutMinutes.
 *
 * The 100 s is VTank's, not the server's (ACE opens a monster corpse to all
 * after its HalfLife, 180 s; the AC1999 server after 15 s): VTank waits its
 * own time and the server's refusal covers the rest.
 */

/** VTank lets a stranger's corpse (or an unshared fellow's) be looted this long after it first appeared. */
export const CORPSE_OTHERS_AFTER_MS = 100_000;
/** A corpse the server refused ("in use", "no right") is skipped this long. */
export const CORPSE_DENIAL_SKIP_MS = 10_000;
/** Refusals before a corpse is skipped for the blacklist time (ours; VTank only skips 10 s each time). */
export const CORPSE_DENIALS_TO_BLACKLIST = 3;
/** A corpse whose description never came is skipped after this many tries. */
export const CORPSE_DESCRIPTION_TRIES = 3;

/** The killer a corpse's description names ("Killed by Name." at its start), "" when it names none. */
export function corpseKiller(description: string | null | undefined): string {
  const m = /^Killed by ([A-Za-z '\-+]*?)\./.exec(description ?? '');
  return m ? m[1].replace(/^\+/, '') : '';
}

/** A rare's corpse: its description goes on to say it generated something ("Killed by X. This corpse generated a rare item!"). */
export function corpseIsRare(description: string | null | undefined): boolean {
  return /^Killed by [A-Za-z '\-+]*\..*[gG]enerated/s.test(description ?? '');
}

/**
 * The server refusing you a corpse, on any of the eras' servers: ACE's Container.InUseMessage
 * and Corpse.Open, and GDLE / AC1999's CCorpseWeenie::CheckOpenContainer.
 */
export function isCorpseDenial(line: string): boolean {
  return /^The (Corpse|Treasure) of .* is already in use by .*!$/.test(line)
    || /^You do not yet have the right to loot the (Corpse|Treasure) of /.test(line)
    || /^You may not loot the (Corpse|Treasure) of .* because /.test(line)
    || /^You do not have permission to loot that corpse!$/.test(line);
}

export interface CorpseBookSettings {
  lootAll: boolean;
  lootFellow: boolean;
  cacheMinutes: number;
  openAttempts: number;
  blacklistSeconds: number;
}

/** The settings the book reads, from the macro's (VTank's names; defaults from vtankOptions.ts). */
export function corpseBookSettings(st: Record<string, string | number | boolean | undefined>): CorpseBookSettings {
  const on = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v));
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);
  return {
    lootAll: on(st.LootAllCorpses),
    lootFellow: on(st.LootFellowCorpses),
    cacheMinutes: Math.min(1440, Math.max(1, num(st.CorpseCacheTimeoutMinutes, 60))),
    openAttempts: Math.min(1000, Math.max(1, Math.round(num(st.BlacklistCorpseOpenAttemptCount, 30)))),
    blacklistSeconds: Math.min(3600, Math.max(1, num(st.BlacklistCorpseOpenTimeoutSeconds, 200))),
  };
}

interface Entry {
  firstSeen: number;
  lastSeen: number;
  present: boolean;
  /** The description's killer ("" none); undefined until described. */
  killer?: string;
  rare?: boolean;
  descriptionTries: number;
  openTries: number;
  done?: boolean;
  deniedAt?: number;
  denials?: number;
  blacklistedAt?: number;
}

export interface CorpseOwnerContext {
  /** Your character's name. */
  me: string;
  /** Your fellows (not you) and whether each shares loot. */
  fellows: Array<{ name: string; shareLoot: boolean }>;
  settings: CorpseBookSettings;
  now: number;
}

export class CorpseBook {
  private entries = new Map<number, Entry>();

  /** The corpses in sight now: stamps the new ones, and forgets the ones gone longer than the cache timeout. */
  observe(guids: Iterable<number>, now: number, s: CorpseBookSettings): void {
    const seen = new Set(guids);
    for (const g of seen) {
      const e = this.entries.get(g);
      if (!e) this.entries.set(g, { firstSeen: now, lastSeen: now, present: true, descriptionTries: 0, openTries: 0 });
      else { e.lastSeen = now; e.present = true; }
    }
    const expiry = s.cacheMinutes * 60_000;
    for (const [g, e] of this.entries) {
      if (seen.has(g)) continue;
      e.present = false;
      if (now - e.lastSeen >= expiry) this.entries.delete(g);
    }
  }

  private entry(g: number, now: number): Entry {
    let e = this.entries.get(g);
    if (!e) { e = { firstSeen: now, lastSeen: now, present: true, descriptionTries: 0, openTries: 0 }; this.entries.set(g, e); }
    return e;
  }

  /** Its description arrived (or `null`: the look came back without one, which counts a try). */
  describe(g: number, description: string | null, now: number): void {
    const e = this.entry(g, now);
    // No answer: counted; after three it is no longer asked about. VTank then skips it for the blacklist time;
    // ours stops asking and goes by the kill's name for your own kills (corpses of others are never taken undescribed).
    if (description === null) { e.descriptionTries++; return; }
    e.killer = corpseKiller(description);
    e.rare = corpseIsRare(description);
  }

  /** The killer its description named ("" none), or undefined while it isn't described. */
  killer(g: number): string | undefined { return this.entries.get(g)?.killer; }
  /** Its description is still to look for (not described, tries left). */
  needsDescription(g: number): boolean { const e = this.entries.get(g); return !e || (e.killer === undefined && e.descriptionTries < CORPSE_DESCRIPTION_TRIES); }
  /** How many looks for its description came back empty. */
  descriptionTries(g: number): number { return this.entries.get(g)?.descriptionTries ?? 0; }

  /** Looted (or found empty): never again while it is remembered. */
  complete(g: number, now: number): void { const e = this.entry(g, now); e.done = true; e.openTries = 0; e.blacklistedAt = undefined; }
  /**
   * The server refused it ("in use", "no right"): skipped for 10 s. Ours: the third refusal skips it for the
   * blacklist time (a player's corpse, say, refuses for good, and isn't asked every 10 s).
   */
  denied(g: number, now: number, s: CorpseBookSettings): void {
    const e = this.entry(g, now);
    e.deniedAt = now;
    e.denials = (e.denials ?? 0) + 1;
    if (e.denials >= CORPSE_DENIALS_TO_BLACKLIST) { e.denials = 0; e.blacklistedAt = now; }
  }
  /** An open that never answered. True when that was the last try and it is now skipped for the blacklist time. */
  openFailed(g: number, now: number, s: CorpseBookSettings): boolean {
    const e = this.entry(g, now);
    e.openTries++;
    if (e.openTries < s.openAttempts) return false;
    e.openTries = 0;
    e.blacklistedAt = now;
    return true;
  }
  openTries(g: number): number { return this.entries.get(g)?.openTries ?? 0; }

  /** Not to be tried now: looted, refused within 10 s, or skipped for the blacklist time. */
  skipped(g: number, now: number, s: CorpseBookSettings): boolean {
    const e = this.entries.get(g);
    if (!e) return false;
    if (e.done) return true;
    if (e.deniedAt !== undefined && now - e.deniedAt < CORPSE_DENIAL_SKIP_MS) return true;
    if (e.blacklistedAt !== undefined) {
      if (now - e.blacklistedAt < s.blacklistSeconds * 1000) return true;
      e.blacklistedAt = undefined;
      e.descriptionTries = 0;
    }
    return false;
  }

  /**
   * VTank's CanLoot, for a described corpse: yours; a fellow's with LootFellowCorpses (at once when they
   * share loot, else after 100 s); anyone else's with LootAllCorpses after 100 s. Never one whose description
   * names no killer, never someone else's rare. Undefined while it isn't described.
   */
  mayLoot(g: number, ctx: CorpseOwnerContext): boolean | undefined {
    const e = this.entries.get(g);
    if (!e || e.killer === undefined) return undefined;
    if (!e.killer) return false;
    const me = ctx.me.replace(/^\+/, '');
    if (me && e.killer.toLowerCase() === me.toLowerCase()) return true;
    if (e.rare) return false;
    const age = ctx.now - e.firstSeen;
    const fellow = ctx.fellows.find((f) => f.name.replace(/^\+/, '').toLowerCase() === e.killer!.toLowerCase());
    if (fellow) return ctx.settings.lootFellow && (fellow.shareLoot || age >= CORPSE_OTHERS_AFTER_MS);
    return ctx.settings.lootAll && age >= CORPSE_OTHERS_AFTER_MS;
  }

  /** Whether the description names you (an own kill). */
  isOwn(g: number, me: string): boolean {
    const k = this.entries.get(g)?.killer;
    return !!k && !!me && k.toLowerCase() === me.replace(/^\+/, '').toLowerCase();
  }

  /** How long since it was first seen (ms); 0 when unknown. */
  age(g: number, now: number): number { const e = this.entries.get(g); return e ? now - e.firstSeen : 0; }
}
