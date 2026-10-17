/**
 * The segment opening's corpse facts (Jake, 2026-10-17: "they also should be prioritizing getting their corpses and
 * never going without gear, even if they have to replace it"): for each of the character's deaths in the last hours
 * that dropped items, where the corpse lies, what is on it, and how long it has before it rots, or that it rotted.
 *
 * Why from the feed: the stream reloads the game page every segment (and a supervisor restart starts a new session),
 * so the page's own death log starts empty and the tally restarts. Arcanist died at 18:48:02Z, the supervisor
 * restarted at 18:48:45Z, and his 18:49Z opening said nothing of the death or its corpse. The feed keeps every death
 * the client's chat showed, across restarts:
 *  - the death event (feed.ts parseChatLine: the victim line, else the loss or corpse line), its time and killer;
 *  - the "You've lost …" line (ACE Player_Death.DropMessage; AC1999 Player.cpp sendLostItemMessage) for what dropped;
 *  - "Your corpse is located at (…)" (ACE Creature_Death.CreateCorpse, outdoors only, when something dropped);
 *  - the last status row before the death for where it was (map coordinates outdoors, the cell inside) and the level.
 * Rot time: ACE Corpse.RecalculateDecayTime, max(3600 s, level × 300 s) for a corpse holding items (an empty one,
 * Corpse.EmptyDecayTime, 15 s). Coins are never on it: ACE's corpse_destroy_pyreals (PropertyManager default true;
 * true on our local server's ace_shard.config_properties_boolean, checked 2026-10-17) destroys dropped pyreals in
 * Player_Death.CalculateDeathItems, so a death that dropped only coins leaves nothing to fetch.
 * Facts only; the brief carries the rule (corpse first, never hunt with a gear gap).
 */
import { existsSync, readFileSync } from 'node:fs';
import { itemsText, parseDeathLoss } from '../../packages/renderer/src/agent/deathLines.ts';
import { DEATH_LINES_MS } from './feed.ts';
import type { FeedChat, FeedDeath, FeedEvent, FeedStatus, FeedTool } from './feed-types.ts';
import { placeText } from './own-time.ts';

/** ACE Corpse.RecalculateDecayTime for a player corpse holding items, in ms. */
export function corpseRotMs(level: number): number {
  return Math.max(3600, (level || 1) * 300) * 1000;
}

/** A rotted corpse is still mentioned this long after (its gear has to be replaced). */
export const ROTTED_MENTION_MS = 2 * 3600_000;

/** A corpse of yours you opened is still mentioned this long after (then it counts as fetched). */
export const OPENED_KEEP_MS = 10 * 60_000;

export interface CorpseFact {
  /** When you died (epoch ms). */
  t: number;
  killer: string | null;
  /** Where: the status row's location ("42.1N, 33.6E" or "indoors (0x5B470124)"), the corpse line's coordinates outdoors. */
  location: string;
  /** The server's corpse line, when one came (outdoors). */
  corpseAt: string | null;
  level: number;
  items: string[];
  pyreals: number;
  rotsAt: number;
  /** When you opened (used or looted) a "Corpse of <you>" in that landblock after the death, if you did. */
  openedAt: number | null;
}

const cellOf = (location: string): number | null => {
  const m = /0x([0-9a-f]{8})/i.exec(location);
  return m ? parseInt(m[1], 16) >>> 0 : null;
};

/**
 * The character's deaths that dropped items, oldest first, from its feed events (any order), up to `nowMs`; a corpse
 * that rotted more than {@link ROTTED_MENTION_MS} ago is left out.
 */
export function corpseFacts(events: readonly FeedEvent[], character: string, nowMs: number): CorpseFact[] {
  const evs = [...events].filter((e) => e.t <= nowMs).sort((a, b) => a.t - b.t);
  const status = evs.filter((e): e is FeedStatus => e.type === 'status');
  const mine = `corpse of ${character}`.toLowerCase();
  const out: CorpseFact[] = [];
  for (const d of evs.filter((e): e is FeedDeath => e.type === 'death')) {
    // The death's own lines: the loss and corpse lines come within a few seconds of the victim line.
    const lines = evs.filter((e): e is FeedChat => e.type === 'chat' && e.t >= d.t - 1000 && e.t - d.t < DEATH_LINES_MS);
    const loss = lines.map((l) => parseDeathLoss(l.text)).find(Boolean) ?? null;
    if (!loss?.items.length) continue;
    const corpseAt = lines.map((l) => /^Your corpse is located at\s*\(([^)]+)\)/i.exec(l.text)?.[1]?.trim()).find(Boolean) ?? null;
    let at: FeedStatus | undefined;
    for (const s of status) { if (s.t <= d.t) at = s; else break; }
    const location = at?.location ?? '';
    const level = at?.level ?? 1;
    const rotsAt = d.t + corpseRotMs(level);
    if (nowMs - rotsAt > ROTTED_MENTION_MS) continue;
    const lb = cellOf(location);
    const opened = evs.find((e): e is FeedTool => e.type === 'tool' && e.t > d.t && e.t <= rotsAt && /^(?:ac_)?(?:use|loot)$/.test(e.tool) && e.summary.toLowerCase().includes(mine)
      && (lb === null || (() => { let s: FeedStatus | undefined; for (const x of status) { if (x.t <= e.t) s = x; else break; } const c = s ? cellOf(s.location) : null; return c === null || c >>> 16 === lb >>> 16; })()));
    // Opened more than 10 min ago (or rotted since): taken back (a corpse looted empty rots in 15 s,
    // Corpse.EmptyDecayTime); the feed can't see what was left, so a fresh open is said and an old one dropped.
    if (opened && (rotsAt <= nowMs || nowMs - opened.t > OPENED_KEEP_MS)) continue;
    out.push({ t: d.t, killer: d.killer ?? null, location, corpseAt, level, items: loss.items, pyreals: loss.pyreals, rotsAt, openedAt: opened?.t ?? null });
  }
  return out;
}

const span = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};

/** "18:48" in the opening's own clock (prompt.ts). */
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** One corpse as an opening line. */
export function corpseLine(c: CorpseFact, nowMs: number): string {
  const cell = cellOf(c.location);
  const where = c.corpseAt ? `outdoors at ${c.corpseAt}`
    : cell !== null ? `${placeText(c.location)}, cell 0x${cell.toString(16).toUpperCase().padStart(8, '0')} (a walk_to target from inside)`
      : c.location ? `near ${placeText(c.location)}` : 'where you fell';
  const coins = c.pyreals ? ` (the ${c.pyreals.toLocaleString('en-US')} pyreals you lost are destroyed, not on it)` : '';
  const left = c.rotsAt - nowMs;
  const state = left <= 0 ? `ROTTED at ${clock(c.rotsAt)}, ${span(-left)} ago: what was on it is gone, so replace any of it you wore`
    : `rots at about ${clock(c.rotsAt)}, ${span(left)} from now`;
  const opened = c.openedAt ? `; you opened a corpse of yours there at ${clock(c.openedAt)} (\`./ac inventory\` shows what came back)` : '';
  return `- corpse from your death at ${clock(c.t)}${c.killer ? ` (${c.killer})` : ''}, ${where}: on it ${itemsText(c.items)}${coins}; ${state}${opened}`;
}

/** The opening's corpse block: a heading and one line per corpse, newest first; null with none. */
export function corpseBlock(facts: readonly CorpseFact[], nowMs: number): string | null {
  if (!facts.length) return null;
  return ['Your corpses (a player corpse with items lasts max(1 h, level × 5 min) on ACE; `./ac observe` and `./ac gear` show them too):', ...[...facts].reverse().map((c) => corpseLine(c, nowMs))].join('\n');
}

/** The feed's events for `profile` since `fromMs`. */
function feedEvents(feedFile: string, profile: string, fromMs: number): FeedEvent[] {
  if (!existsSync(feedFile)) return [];
  const tag = `"char":${JSON.stringify(profile)}`;
  const out: FeedEvent[] = [];
  for (const line of readFileSync(feedFile, 'utf8').split('\n')) {
    if (!line.includes(tag)) continue;
    let e: FeedEvent;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e as { char?: string }).char === profile && e.t >= fromMs) out.push(e);
  }
  return out;
}

/** The corpse block for `profile`'s next opening, from the feed (deaths up to 8 h back: a level-80 corpse lasts 6 h 40 min). */
export function loadCorpses(o: { feedFile: string; profile: string; character: string; nowMs: number }): string | null {
  const facts = corpseFacts(feedEvents(o.feedFile, o.profile, o.nowMs - 8 * 3600_000 - ROTTED_MENTION_MS), o.character, o.nowMs);
  return corpseBlock(facts, o.nowMs);
}
