/**
 * "Where my time went": the segment opening's `- last hour: …` line (supervisor.ts runSegment → prompt.ts
 * segmentOpening, right after the readiness block). For each character, from its previous segment: minutes travelling
 * (walks, follows, portal space), fighting, buffing (casts at itself or a cast member), shopping (vendors), looting and
 * gear, and waiting/idle (waits, looks, the model thinking); the longest single trip with where it started and ended;
 * and how many of today's trips went to that same place.
 *
 * Facts only, no advice (Jake, 2026-10-16): the players draw their own conclusions, e.g. that a 10-minute walk to the
 * same dungeon every hour is worth a Portal Tie.
 *
 * Sources, all written by the supervisor already: segments.jsonl (each segment's profile, start, end and session id),
 * sessions/<profile>-<day>-seg<n>.jsonl (the player's stream-json: every tool call with its time and result, read by
 * dead-air.ts parseSession), and the feed (feed.jsonl: the character's status lines with its location every few seconds,
 * and its chat, whose combat lines and "In Portal Space" lines time the fights and portal trips).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapCoords } from '../../packages/renderer/src/ui/MapMarkers.ts';
import { type SessionTimeline, parseSession } from './dead-air.ts';
import { cliCalls } from './feed.ts';
import type { FeedChat, FeedStatus } from './feed-types.ts';
import { localDay } from './policy.ts';
import { nearestTownOf, placeMapCoords } from './shops.ts';

export type TimeKind = 'travelling' | 'fighting' | 'buffing' | 'shopping' | 'looting/gear' | 'waiting/idle';
/** Priority order: a second gets the first kind that covers it. */
export const TIME_KINDS: readonly TimeKind[] = ['fighting', 'travelling', 'buffing', 'shopping', 'looting/gear', 'waiting/idle'];

/** One segment's inputs: its window, the player's tool calls, and the character's feed status + chat lines in it. */
export interface OwnTimeSegment {
  start: number;
  end: number;
  session: SessionTimeline;
  feed: ReadonlyArray<FeedStatus | FeedChat>;
}

export interface Trip {
  start: number;
  end: number;
  from: string;
  to: string;
  /** What "the same destination" means when counting: the named target, else the place text. */
  key: string;
}

export interface SegmentTime {
  seconds: Record<TimeKind, number>;
  /** The kind of each second from the segment's start. */
  perSecond: TimeKind[];
  portals: number;
  trips: Trip[];
}

/** Two combat lines this close are one fight (dead-air.ts FIGHT_GAP_MS). */
const FIGHT_GAP_MS = 8000;
const FIGHT_PAD_MS = 1500;
/** An attack, or a walk / follow / repeat cast that answered "still in progress", runs until a task-done or the next action. */
const ATTACK_CAP_MS = 60_000;
const BACKGROUND_CAP_MS = 180_000;
/** The longest one background task counts for. */
const WALK_MAX_MS = 20 * 60_000;
/** Travel legs this close (with no fighting between) are one trip: a look around or a word between two walks. */
export const TRIP_GAP_MS = 60_000;
/** Shorter trips aren't named (or counted): a minute's walk is not a journey. */
export const MIN_TRIP_MS = 60_000;

const IN_PROGRESS = /still in progress|keeps going|moved to the background/i;
const TASK_DONE = /task-done|arrived|stopped:|died\b|target-lost|target-died/i;
const ACTIONS = new Set(['attack', 'cast', 'walk_to', 'follow', 'use', 'loot', 'stop_moving', 'routine', 'vendor', 'buy', 'sell']);
const LOOT_TOOLS = new Set(['loot', 'pick_up', 'give', 'inventory', 'equip', 'unequip', 'wear', 'drop', 'appraise', 'gear', 'use_on']);
const SHOP_TOOLS = new Set(['vendor', 'buy', 'sell']);
const VENDOR_NAME = /\b(?:Shopkeeper|Blacksmith|Armorer|Weaponsmith|Grocer|Bowyer|Jeweler|Tailor|Archmage|Scrivener|Healer|Vendor|Barkeeper|Provisioner|Merchant|Trader|Peddler|Alchemist|Butcher)\b/i;
const PORTAL_RESULT = /portal space|entered portal/i;
/** Walk targets that say nothing about where the character went. */
const RELATIVE = /^\s*[\d.]+\s*m\b|^(?:#|0x)?[0-9a-f]{8}$|^#[0-9a-f]+$/i;
const COORDS = /^\s*(\d+(?:\.\d+)?)\s*([NS])[,\s]+(\d+(?:\.\d+)?)\s*([EW])\s*$/i;

interface Span { k: TimeKind; start: number; end: number }
interface Leg { start: number; end: number; target: string | null; portal: boolean }

const targetOf = (command: string): string => {
  const c = cliCalls(command)[0];
  return (c?.args.target ?? c?.args._0 ?? '').trim();
};

/** Whether a cast went at a monster (fighting) or at the caster / a cast member (buffing). */
export function castIsBuff(command: string, result: string, cast: readonly string[]): boolean {
  if (/\bon yourself\b/.test(result)) return true;
  const t = targetOf(command);
  if (!t) return true;
  if (cast.some((n) => n.toLowerCase() === t.toLowerCase())) return true;
  const at = /\b(?:casting \S.*? at|cast \S.*? at) (.+?)(?: #[0-9a-f]+)?(?: \d+ times?| \(|:|\n|$)/i.exec(result);
  return !!at && cast.some((n) => at[1].trim().startsWith(n));
}

/** "42.1N, 33.6E" → map coordinates. */
export function parseCoords(text: string): MapCoords | null {
  const m = COORDS.exec(text.replace(/,/g, ' '));
  if (!m) return null;
  return { ns: Number(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1), ew: Number(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1) };
}

const coordsText = (c: MapCoords): string => `${Math.abs(c.ns).toFixed(1)}${c.ns < 0 ? 'S' : 'N'} ${Math.abs(c.ew).toFixed(1)}${c.ew < 0 ? 'W' : 'E'}`;
const cellOf = (location: string): number | null => {
  const m = /0x([0-9a-f]{8})/i.exec(location);
  return m ? parseInt(m[1], 16) >>> 0 : null;
};

/** A status location as a place: a town's name within 3 map units, else the coordinates; indoors, the place a portal into its landblock was called. */
export function placeText(location: string, landblockNames: ReadonlyMap<number, string> = new Map()): string {
  const c = parseCoords(location);
  if (c) {
    const town = nearestTownOf(c);
    return town && town.distance <= 3 ? town.name : coordsText(c);
  }
  const cell = cellOf(location);
  if (cell === null) return location || 'unknown';
  const named = landblockNames.get(cell >>> 16);
  if (named) return named;
  const town = nearestTownOf(placeMapCoords(cell, 96, 96));
  if (town && town.distance <= 3) return `${town.name} (indoors)`;
  return `indoors (landblock 0x${(cell >>> 16).toString(16).toUpperCase().padStart(4, '0')})`;
}

/** The character's location at `t`: the last status at or before it, else the first after. */
function locationAt(status: readonly FeedStatus[], t: number): FeedStatus | undefined {
  let best: FeedStatus | undefined;
  for (const s of status) { if (s.t <= t) best = s; else return best ?? s; }
  return best;
}

/** Each kind's spans, the travel legs and the portal trips of one segment. */
function spansOf(seg: OwnTimeSegment, cast: readonly string[]): { spans: Span[]; legs: Leg[]; portals: number } {
  const spans: Span[] = [];
  const legs: Leg[] = [];
  const combat = seg.feed.filter((e): e is FeedChat => e.type === 'chat' && e.channel === 'combat').map((e) => e.t).sort((a, b) => a - b);
  combat.forEach((t, i) => {
    const next = combat[i + 1];
    spans.push({ k: 'fighting', start: t - FIGHT_PAD_MS, end: next !== undefined && next - t <= FIGHT_GAP_MS ? next : t + FIGHT_PAD_MS });
  });
  // Portal space: a run of "In Portal Space" lines (one per second or so) is one trip through a portal or a recall.
  const portal = seg.feed.filter((e): e is FeedChat => e.type === 'chat' && /^In Portal Space/.test(e.text)).map((e) => e.t).sort((a, b) => a - b);
  let portals = 0;
  for (let i = 0; i < portal.length;) {
    let j = i;
    while (j + 1 < portal.length && portal[j + 1] - portal[j] <= 10_000) j++;
    spans.push({ k: 'travelling', start: portal[i], end: portal[j] + 2000 });
    legs.push({ start: portal[i], end: portal[j] + 2000, target: null, portal: true });
    portals++;
    i = j + 1;
  }
  const calls = seg.session.calls.filter((c) => c.end >= seg.start && c.start <= seg.end);
  // A background task runs until a wait says it finished or the next action replaces it. The cap is on the silence
  // after it (no call within `cap`), not its length: a nine-minute walk is a run of 20 s waits (to WALK_MAX_MS).
  const endOfBackground = (i: number, cap: number): number => {
    const c = calls[i];
    let last = c.end;
    for (let j = i + 1; j < calls.length; j++) {
      const d = calls[j];
      if (d.start > last + cap || d.start > c.end + WALK_MAX_MS) break;
      if (ACTIONS.has(d.tool)) return d.start;
      if (d.tool === 'wait' && TASK_DONE.test(d.result)) return d.end;
      last = Math.max(last, d.end);
    }
    return Math.min(last, c.end + WALK_MAX_MS) + (last === c.end ? Math.min(cap, 20_000) : 0);
  };
  calls.forEach((c, i) => {
    const bgEnd = IN_PROGRESS.test(c.result) ? endOfBackground(i, BACKGROUND_CAP_MS) : c.end;
    if (c.tool === 'attack' && !c.isError) spans.push({ k: 'fighting', start: c.start, end: endOfBackground(i, ATTACK_CAP_MS) });
    else if (c.tool === 'cast') spans.push({ k: castIsBuff(c.command, c.result, cast) ? 'buffing' : 'fighting', start: c.start, end: bgEnd });
    else if (c.tool === 'walk_to' || c.tool === 'follow' || c.tool === 'move' || c.tool === 'jump') {
      spans.push({ k: 'travelling', start: c.start, end: bgEnd });
      const t = targetOf(c.command);
      const named = c.tool === 'walk_to' && t && !RELATIVE.test(t) && !cast.some((n) => n.toLowerCase() === t.toLowerCase());
      legs.push({ start: c.start, end: bgEnd, target: named ? t : null, portal: false });
    } else if (c.tool === 'use') {
      const t = targetOf(c.command);
      if (PORTAL_RESULT.test(c.result)) {
        spans.push({ k: 'travelling', start: c.start, end: bgEnd });
        legs.push({ start: c.start, end: bgEnd, target: t && !RELATIVE.test(t) ? t : null, portal: true });
      } else if (VENDOR_NAME.test(t) || /\bsells\b|\bvendor\b/i.test(c.result)) spans.push({ k: 'shopping', start: c.start, end: bgEnd });
      else if (bgEnd - c.start >= 5000) {
        // A use walks to its target first (an NPC, a door across the room): that walk is travel.
        spans.push({ k: 'travelling', start: c.start, end: bgEnd });
        legs.push({ start: c.start, end: bgEnd, target: null, portal: false });
      } else spans.push({ k: 'looting/gear', start: c.start, end: c.end });
    } else if (SHOP_TOOLS.has(c.tool)) spans.push({ k: 'shopping', start: c.start, end: c.end });
    else if (LOOT_TOOLS.has(c.tool)) spans.push({ k: 'looting/gear', start: c.start, end: bgEnd });
  });
  return { spans, legs, portals };
}

/** Landblock → the name of the portal that led into it (a portal use followed by an indoor location in that landblock). */
export function portalNames(segs: readonly OwnTimeSegment[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const seg of segs) {
    const status = seg.feed.filter((e): e is FeedStatus => e.type === 'status').sort((a, b) => a.t - b.t);
    for (const c of seg.session.calls) {
      if (c.tool !== 'use' || !PORTAL_RESULT.test(c.result)) continue;
      const name = targetOf(c.command);
      if (!name || RELATIVE.test(name)) continue;
      const after = status.find((s) => s.t > c.end + 2000 && s.t <= c.end + 90_000);
      const cell = after && !parseCoords(after.location) ? cellOf(after.location) : null;
      if (cell !== null) out.set(cell >>> 16, name);
    }
  }
  return out;
}

/** Seconds per kind over [start, end), the portal trips, and the trips (legs of travel joined across short pauses). */
export function segmentTime(seg: OwnTimeSegment, cast: readonly string[], landblockNames: ReadonlyMap<number, string> = new Map()): SegmentTime {
  const { spans, legs, portals } = spansOf(seg, cast);
  const n = Math.max(0, Math.ceil((seg.end - seg.start) / 1000));
  const idle = TIME_KINDS.length - 1;
  const best = new Array<number>(n).fill(idle);
  const rank = new Map(TIME_KINDS.map((k, i) => [k, i]));
  for (const s of spans) {
    const r = rank.get(s.k)!;
    const i0 = Math.max(0, Math.floor((s.start - seg.start) / 1000));
    const i1 = Math.min(n, Math.ceil((s.end - seg.start) / 1000));
    for (let i = i0; i < i1; i++) if (r < best[i]) best[i] = r;
  }
  const seconds = Object.fromEntries(TIME_KINDS.map((k) => [k, 0])) as Record<TimeKind, number>;
  for (const r of best) seconds[TIME_KINDS[r]]++;

  // Trips: legs in time order, joined while the next starts within TRIP_GAP_MS of the last one's end with no fighting between.
  const fightingAt = (t0: number, t1: number): boolean => {
    for (let t = Math.max(t0, seg.start); t < Math.min(t1, seg.end); t += 1000) if (best[Math.floor((t - seg.start) / 1000)] === 0) return true;
    return false;
  };
  const sorted = legs.filter((l) => l.end > seg.start && l.start < seg.end).sort((a, b) => a.start - b.start);
  const groups: Leg[][] = [];
  for (const l of sorted) {
    const g = groups[groups.length - 1];
    const lastEnd = g ? Math.max(...g.map((x) => x.end)) : -Infinity;
    if (g && l.start - lastEnd <= TRIP_GAP_MS && !fightingAt(lastEnd, l.start)) g.push(l);
    else groups.push([l]);
  }
  const status = seg.feed.filter((e): e is FeedStatus => e.type === 'status').sort((a, b) => a.t - b.t);
  const trips: Trip[] = groups.map((g) => {
    const start = Math.max(seg.start, g[0].start);
    const end = Math.min(seg.end, Math.max(...g.map((x) => x.end)));
    const startLoc = locationAt(status, start - 1000);
    const endLoc = locationAt(status, end + 3000);
    const from = startLoc ? placeText(startLoc.location, landblockNames) : 'unknown';
    const named = [...g].reverse().find((x) => x.target && !parseCoords(x.target))?.target ?? null;
    let to: string;
    let key: string;
    if (named) {
      // The named place and where it is: the last outdoor position on the way (a dungeon's portal is outdoors).
      const outdoor = [...status].reverse().find((s) => s.t <= end + 3000 && s.t >= start && parseCoords(s.location));
      const c = outdoor ? parseCoords(outdoor.location) : null;
      to = c ? `${named} (${coordsText(c)})` : named;
      key = named.toLowerCase();
    } else {
      to = endLoc ? placeText(endLoc.location, landblockNames) : 'unknown';
      key = to.toLowerCase();
    }
    return { start, end, from, to, key };
  });
  return { seconds, perSecond: best.map((r) => TIME_KINDS[r]), portals, trips };
}

const ORDINAL = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
};
const minutes = (s: number): number => Math.round(s / 60);

/**
 * The time line: "- last hour: travelling 22 min (2 portal trips), fighting 18 min, …; longest trip Holtburg →
 * Mountain Keep (54.7N 32.9E), 9 min, 3rd time today". `earlier` are today's segments before `prev` (for the count).
 * Null when the segment has no seconds.
 */
export function ownTimeLine(prev: OwnTimeSegment, earlier: readonly OwnTimeSegment[], cast: readonly string[], names = portalNames([...earlier, prev]), t = segmentTime(prev, cast, names)): string | null {
  if (prev.end <= prev.start) return null;
  const parts: string[] = [];
  for (const k of ['travelling', 'fighting', 'buffing', 'shopping', 'looting/gear', 'waiting/idle'] as const) {
    const m = minutes(t.seconds[k]);
    if (m < 1 && k !== 'travelling' && k !== 'fighting' && k !== 'waiting/idle') continue;
    const extra = k === 'travelling' && t.portals ? ` (${t.portals} portal trip${t.portals === 1 ? '' : 's'})` : '';
    parts.push(`${k} ${m} min${extra}`);
  }
  // A segment cut short (a restart) is labelled by its real length, so a 7-minute stretch doesn't read as an hour.
  const segMin = Math.round((prev.end - prev.start) / 60_000);
  const label = segMin >= 50 ? 'last hour' : `last ${segMin} min`;
  let line = `- ${label}: ${parts.join(', ')}`;
  // A trip goes somewhere: moving about inside one place (a dungeon, a town) is travel time but not a trip.
  const goes = (x: Trip): boolean => x.from !== x.to && x.end - x.start >= MIN_TRIP_MS;
  const longest = t.trips.filter(goes).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  if (longest) {
    const before = earlier.flatMap((s) => segmentTime(s, cast, names).trips);
    const n = [...before, ...t.trips].filter((x) => goes(x) && x.key === longest.key && x.start <= longest.start).length;
    line += `; longest trip ${longest.from} → ${longest.to}, ${minutes((longest.end - longest.start) / 1000)} min, ${ORDINAL(n)} time today`;
  }
  return line;
}

// ── XP per hour by spot ──

/** A hunting spot: indoors, the place (a dungeon's portal name, a town's building); outdoors, the nearest town's area or whole map units. */
export function spotOf(location: string, landblockNames: ReadonlyMap<number, string> = new Map()): string {
  const c = parseCoords(location);
  if (!c) return placeText(location, landblockNames);
  const town = nearestTownOf(c);
  if (town) return town.text;
  return coordsText({ ns: Math.round(c.ns), ew: Math.round(c.ew) }).replace(/\.0/g, '');
}

/** Status samples further apart than this are a gap (the stream was off): neither time nor XP is counted across it. */
const SAMPLE_GAP_MS = 90_000;
/** A spot needs this long in the hour to get a rate. */
const MIN_SPOT_MS = 5 * 60_000;

/** XP gained and time spent per spot from status samples: each interval goes to the spot of its later sample. */
export function xpBySpot(status: readonly FeedStatus[], names: ReadonlyMap<number, string>): Map<string, { xp: number; ms: number }> {
  const out = new Map<string, { xp: number; ms: number }>();
  const s = [...status].sort((a, b) => a.t - b.t);
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt <= 0 || dt > SAMPLE_GAP_MS) continue;
    const spot = spotOf(s[i].location, names);
    const e = out.get(spot) ?? { xp: 0, ms: 0 };
    e.ms += dt;
    const dx = (s[i].xp?.total ?? 0) - (s[i - 1].xp?.total ?? 0);
    if (dx > 0) e.xp += dx;
    out.set(spot, e);
  }
  return out;
}

export const xpText = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const hours = (ms: number): string => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

/** "- XP per hour: Mountain Keep 1.4M (today 1.2M/h over 2.1 h), Holtburg 0 (…)"; the hour's spots with 5 minutes or more. */
export function xpLine(prevStatus: readonly FeedStatus[], todayStatus: readonly FeedStatus[], names: ReadonlyMap<number, string>): string | null {
  const hour = [...xpBySpot(prevStatus, names)].filter(([, v]) => v.ms >= MIN_SPOT_MS).sort((a, b) => b[1].ms - a[1].ms).slice(0, 4);
  if (!hour.length) return null;
  const day = xpBySpot(todayStatus, names);
  const parts = hour.map(([spot, v]) => {
    const d = day.get(spot);
    const today = d && d.ms > v.ms + 60_000 ? ` (today ${xpText(d.xp / (d.ms / 3600_000))}/h over ${hours(d.ms)})` : '';
    return `${spot} ${xpText(v.xp / (v.ms / 3600_000))}/h over ${hours(v.ms)}${today}`;
  });
  return `- XP per hour: ${parts.join(', ')}`;
}

// ── waiting: no monster in sight, resting ──

/** Monsters (not dying) in an observe result's nearby list, or null when the result has no list. */
export function monstersInObserve(result: string): number | null {
  if (!/^nearby \(/m.test(result) && !/^nearby: /m.test(result)) return null;
  return result.split('\n').filter((l) => /^\s+#\S+\s.*\[monster/.test(l) && !/\bDYING\b/.test(l)).length;
}

/** A vital under half: the lowest one (health, stamina, mana; mana only with a real pool). */
export function lowVital(s: FeedStatus): 'health' | 'stamina' | 'mana' | null {
  const f = (v?: { cur: number; max: number }) => (v && v.max > 0 ? v.cur / v.max : 1);
  const c: Array<['health' | 'stamina' | 'mana', number]> = [['health', f(s.health)], ['stamina', f(s.stamina)], ['mana', s.mana && s.mana.max > 30 ? f(s.mana) : 1]];
  const low = c.filter(([, x]) => x < 0.5).sort((a, b) => a[1] - b[1])[0];
  return low ? low[0] : null;
}

/** How long a look's partner distance stands for. */
const OBSERVE_HOLD_MS = 120_000;
/** How long a look's monster count stands for while the character waits (its waits wake on aggro, so nothing came). */
const MONSTER_HOLD_MS = 5 * 60_000;

/** "- waiting: 9 min with no monster in sight, 6 min resting (stamina 4, mana 2)", over the segment's idle seconds. */
export function waitingLine(seg: OwnTimeSegment, t: SegmentTime): string | null {
  const status = seg.feed.filter((e): e is FeedStatus => e.type === 'status').sort((a, b) => a.t - b.t);
  const looks = seg.session.calls.filter((c) => c.tool === 'observe').map((c) => ({ t: c.end, n: monstersInObserve(c.result) })).filter((x): x is { t: number; n: number } => x.n !== null);
  let noMonsters = 0;
  const rest: Record<string, number> = {};
  let si = -1, li = -1;
  t.perSecond.forEach((k, i) => {
    if (k !== 'waiting/idle') return;
    const at = seg.start + i * 1000;
    while (si + 1 < status.length && status[si + 1].t <= at) si++;
    while (li + 1 < looks.length && looks[li + 1].t <= at) li++;
    const st = si >= 0 && at - status[si].t <= SAMPLE_GAP_MS ? status[si] : undefined;
    const low = st ? lowVital(st) : null;
    if (low) rest[low] = (rest[low] ?? 0) + 1;
    else if (li >= 0 && looks[li].n === 0 && at - looks[li].t <= MONSTER_HOLD_MS) noMonsters++;
  });
  const restTotal = Object.values(rest).reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (minutes(noMonsters) >= 1) parts.push(`${minutes(noMonsters)} min with no monster in sight`);
  if (minutes(restTotal) >= 1) {
    const by = Object.entries(rest).filter(([, v]) => minutes(v) >= 1).sort((a, b) => b[1] - a[1]);
    parts.push(`${minutes(restTotal)} min resting (${by.length > 1 ? by.map(([k, v]) => `${k} ${minutes(v)}`).join(', ') : (by[0]?.[0] ?? Object.keys(rest)[0])})`);
  }
  return parts.length ? `- waiting: ${parts.join(', ')}` : null;
}

// ── offensive casts refused ──

const CAST_REFUSED = /no line of fire|out of range|too far/i;
const MIN_CASTS = 5;

/** "- offensive casts refused (no line of fire or out of range): Mountain Keep 41% (37/90), outdoors 8% (2/25)". */
export function castRefusalLine(seg: OwnTimeSegment, cast: readonly string[], names: ReadonlyMap<number, string>): string | null {
  const status = seg.feed.filter((e): e is FeedStatus => e.type === 'status').sort((a, b) => a.t - b.t);
  const by = new Map<string, { refused: number; total: number }>();
  for (const c of seg.session.calls) {
    if (c.tool !== 'cast' || castIsBuff(c.command, c.result, cast)) continue;
    const times = Number(/\b(\d+) times?\b/.exec(c.result)?.[1] ?? (c.isError ? 0 : 1));
    const refused = CAST_REFUSED.test(c.result) && /refused|not cast|stopped/i.test(c.result) ? 1 : 0;
    if (times + refused === 0) continue;
    const loc = locationAt(status, c.start)?.location ?? '';
    const place = parseCoords(loc) ? 'outdoors' : loc ? placeText(loc, names) : 'unknown';
    const e = by.get(place) ?? { refused: 0, total: 0 };
    e.refused += refused;
    e.total += times + refused;
    by.set(place, e);
  }
  const total = [...by.values()].reduce((a, b) => a + b.total, 0);
  if (total < MIN_CASTS) return null;
  const parts = [...by].sort((a, b) => b[1].total - a[1].total).map(([p, v]) => `${p} ${Math.round((v.refused / v.total) * 100)}% (${v.refused}/${v.total})`);
  return `- offensive casts refused for no line of fire or out of range: ${parts.join(', ')}`;
}

// ── time apart from the partner ──

const APART_M = 30;
/** A height difference this big is another floor. */
const FLOOR_M = 4;

/** The partner's distance and height from an observe's "fellows:" line: null when the line doesn't name them. */
export function fellowSample(result: string, partner: string): { far: boolean; floor: boolean } | null {
  const line = /^fellows: (.*)$/m.exec(result)?.[1];
  if (!line) return null;
  const bit = line.split('; ').find((b) => b.startsWith(`${partner} `));
  if (!bit) return null;
  if (/out of sight/.test(bit)) return { far: true, floor: false };
  const m = /HP, (\d+) m [NSEW]+(?:, (?:up|down) (\d+) m)?/.exec(bit);
  if (!m) return null;
  return { far: Number(m[1]) > APART_M, floor: Number(m[2] ?? 0) >= FLOOR_M };
}

/** "- apart from Claude Bulwark: 14 min (different floors 9)", from the observes' fellows lines (each holds until the next, up to 2 min). */
export function apartLine(seg: OwnTimeSegment, partners: readonly string[]): string | null {
  for (const partner of partners) {
    const samples = seg.session.calls.filter((c) => c.tool === 'observe').map((c) => ({ t: c.end, s: fellowSample(c.result, partner) })).filter((x): x is { t: number; s: { far: boolean; floor: boolean } } => !!x.s);
    if (samples.length < 2) continue;
    let apart = 0, floors = 0;
    samples.forEach((x, i) => {
      const until = Math.min(samples[i + 1]?.t ?? seg.end, x.t + OBSERVE_HOLD_MS, seg.end);
      const ms = Math.max(0, until - x.t);
      if (x.s.far || x.s.floor) apart += ms;
      if (x.s.floor) floors += ms;
    });
    return `- apart from ${partner} (over ${APART_M} m, another floor or out of sight): ${minutes(apart / 1000)} min${minutes(floors / 1000) >= 1 ? ` (different floors ${minutes(floors / 1000)})` : ''}`;
  }
  return null;
}

/**
 * The opening's block (right after readiness): the time line, then XP per hour by spot, waiting, offensive casts refused
 * and time apart, each only when its data is there. Null when there is no previous segment.
 */
export function ownTimeBlock(prev: OwnTimeSegment, earlier: readonly OwnTimeSegment[], cast: readonly string[], me?: string): string | null {
  const names = portalNames([...earlier, prev]);
  const t = segmentTime(prev, cast, names);
  const first = ownTimeLine(prev, earlier, cast, names, t);
  if (!first) return null;
  const statusOf = (s: OwnTimeSegment) => s.feed.filter((e): e is FeedStatus => e.type === 'status');
  const lines = [
    first,
    xpLine(statusOf(prev), [...earlier, prev].flatMap(statusOf), names),
    waitingLine(prev, t),
    castRefusalLine(prev, cast, names),
    apartLine(prev, cast.filter((n) => n !== me)),
  ];
  return lines.filter((l): l is string => !!l).join('\n');
}

// ── reading a run's files ──

interface SegmentRow { profile: string; character?: string; segment: number; start: string; end: string; sessionId?: string | null }

/** The character's status and chat events from the feed, in [from, to]. */
export function feedFor(feedFile: string, profile: string, from: number, to: number): Array<FeedStatus | FeedChat> {
  if (!existsSync(feedFile)) return [];
  const tag = `"char":${JSON.stringify(profile)}`;
  const out: Array<FeedStatus | FeedChat> = [];
  for (const line of readFileSync(feedFile, 'utf8').split('\n')) {
    if (!line.includes(tag) || !(line.includes('"type":"status"') || line.includes('"type":"chat"'))) continue;
    let e: FeedStatus | FeedChat;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.char === profile && e.t >= from && e.t <= to) out.push(e);
  }
  return out;
}

/**
 * The line for `profile`'s next opening, from its latest segment in `streamDir` (segments.jsonl + sessions/) and the
 * feed: null when it has none, or when that segment ended more than `maxAgeMs` ago (a new day's stream).
 */
export function loadOwnTime(o: { streamDir: string; feedFile: string; profile: string; character?: string; cast: readonly string[]; nowMs: number; maxAgeMs?: number }): string | null {
  const segFile = join(o.streamDir, 'segments.jsonl');
  if (!existsSync(segFile)) return null;
  const rows: SegmentRow[] = readFileSync(segFile, 'utf8').split('\n').filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l) as SegmentRow]; } catch { return []; } })
    .filter((r) => r.profile === o.profile && Number.isFinite(Date.parse(r.start)) && Date.parse(r.end) <= o.nowMs);
  const prev = rows[rows.length - 1];
  if (!prev || o.nowMs - Date.parse(prev.end) > (o.maxAgeMs ?? 3 * 3600_000)) return null;
  const day = localDay(prev.start);
  const today = rows.filter((r) => localDay(r.start) === day);
  const from = Date.parse(today[0].start), to = Date.parse(prev.end);
  const feed = feedFor(o.feedFile, o.profile, from, to);
  const fileCache = new Map<string, string[]>();
  const lines = (f: string): string[] => {
    if (!fileCache.has(f)) fileCache.set(f, existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []);
    return fileCache.get(f)!;
  };
  const segOf = (r: SegmentRow): OwnTimeSegment => {
    const start = Date.parse(r.start), end = Date.parse(r.end);
    const files = [...new Set([localDay(r.start), localDay(r.end)])].map((d) => join(o.streamDir, 'sessions', `${r.profile}-${d}-seg${r.segment}.jsonl`));
    const session = parseSession(files.flatMap(lines), r.sessionId ?? undefined);
    session.calls = session.calls.filter((c) => c.end >= start && c.start <= end);
    return { start, end, session, feed: feed.filter((e) => e.t >= start && e.t <= end) };
  };
  return ownTimeBlock(segOf(prev), today.slice(0, -1).map(segOf), o.cast, o.character ?? prev.character);
}
