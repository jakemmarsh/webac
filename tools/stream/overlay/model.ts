/**
 * Stream overlay view model: folds feed events (tools/stream/feed-types.ts) into what the page draws.
 * Runs in the browser (the overlay server serves it transpiled at /model.ts) and in tests.
 * Only TYPE imports here: the browser build has no module graph beyond app.ts → model.ts.
 */
import type { ChatChannel, FeedEvent, FeedStatus, FeedVital } from '../feed-types.ts';

export interface RosterEntry {
  /** Agent profile id (the feed's `char`). */
  id: string;
  /** In-game name until a status event says otherwise. */
  name: string;
  /** Short role line under the name. */
  title: string;
}

export const DEFAULT_ROSTER: readonly RosterEntry[] = [
  { id: 'mage', name: 'Claude Arcanist', title: 'War Mage' },
  { id: 'soldier', name: 'Claude Bulwark', title: 'Sword & Board' },
];

/** How long a level-up / death callout stays up. */
export const CALLOUT_MS = 6000;
/** Same line seen by both clients (fellowship, a tell's two ends, nearby say) within this window = one line. */
export const CHAT_DEDUPE_MS = 8000;
/** A second death signal for the same character within this window is the same death. */
export const DEATH_DEDUPE_MS = 15000;
export const CHAT_KEEP = 40;
export const NARRATION_KEEP = 16;
/** Combat-log channels the chat panel leaves out. */
export const HIDDEN_CHAT_CHANNELS: readonly ChatChannel[] = ['combat', 'magic'];

export interface CharView {
  id: string;
  name: string;
  title: string;
  level: number | null;
  health: FeedVital | null;
  stamina: FeedVital | null;
  mana: FeedVital | null;
  xpTotal: number | null;
  xpToNext: number | null;
  xpLevelStart: number | null;
  /** XP total when this session first saw the character (baseline for "XP this session"). */
  xpBaseline: number | null;
  xpSession: number;
  location: string;
  goal: string | null;
  dead: boolean;
  deaths: number;
  levelUps: number;
  lastDeathT: number | null;
  lastTool: { tool: string; summary: string; ok: boolean; t: number } | null;
  lastStatusT: number | null;
}

export interface ChatView {
  t: number;
  channel: ChatChannel;
  /** Display name of the speaker, null for system text. */
  speaker: string | null;
  /** Roster id of the speaker when it is one of ours, else null. */
  speakerId: string | null;
  /** Recipient for tells. */
  to: string | null;
  /** The message (quotes stripped) or the whole line for unparsed text. */
  body: string;
  /** Which client printed it (roster id). */
  seenBy: string;
}

export interface NarrationView { t: number; char: string; name: string; text: string }

export interface Callout {
  id: number;
  kind: 'level-up' | 'death';
  char: string;
  name: string;
  /** Headline, e.g. "LEVEL 17" / "SLAIN". */
  text: string;
  /** Second line, e.g. "Claude Arcanist" / "by Drudge Skulker". */
  sub: string;
  t: number;
  until: number;
}

export interface OverlayState {
  roster: RosterEntry[];
  sessionStart: number | null;
  sessionTitle: string | null;
  segment: { title: string; detail: string | null; t: number } | null;
  chars: Record<string, CharView>;
  chat: ChatView[];
  narration: NarrationView[];
  callouts: Callout[];
  nextCalloutId: number;
  /** Dedupe memory: key → last time seen. */
  recentChat: Record<string, number>;
  lastT: number;
}

function newChar(r: RosterEntry): CharView {
  return {
    id: r.id, name: r.name, title: r.title, level: null, health: null, stamina: null, mana: null,
    xpTotal: null, xpToNext: null, xpLevelStart: null, xpBaseline: null, xpSession: 0,
    location: '', goal: null, dead: false, deaths: 0, levelUps: 0, lastDeathT: null, lastTool: null, lastStatusT: null,
  };
}

export function createState(roster: readonly RosterEntry[] = DEFAULT_ROSTER): OverlayState {
  const chars: Record<string, CharView> = {};
  for (const r of roster) chars[r.id] = newChar(r);
  return {
    roster: roster.map((r) => ({ ...r })), sessionStart: null, sessionTitle: null, segment: null,
    chars, chat: [], narration: [], callouts: [], nextCalloutId: 1, recentChat: {}, lastT: 0,
  };
}

function charFor(s: OverlayState, id: string): CharView {
  let c = s.chars[id];
  if (!c) {
    const r: RosterEntry = { id, name: id, title: '' };
    s.roster.push(r);
    c = s.chars[id] = newChar(r);
  }
  return c;
}

/** Roster id for an in-game name ("Claude Bulwark"), case-insensitive. */
export function idForName(s: OverlayState, name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const c of Object.values(s.chars)) if (c.name.toLowerCase() === n) return c.id;
  return null;
}

const BRACKET_CHANNELS: Record<string, ChatChannel> = {
  fellowship: 'fellowship', allegiance: 'allegiance', general: 'general', trade: 'trade', lfg: 'lfg',
  roleplay: 'roleplay', society: 'society', patron: 'allegiance', vassals: 'allegiance', covassals: 'allegiance', monarch: 'allegiance',
};

export interface ParsedChat {
  channel: ChatChannel | null;
  /** Raw speaker as printed ("You" kept). */
  speaker: string | null;
  to: string | null;
  body: string;
}

/** Parse the retail chat formats the agents' clients print. Unknown shapes come back with speaker null. */
export function parseChatText(text: string): ParsedChat {
  let m = /^\[([^\]]+)\]\s+(.+?)\s+says?,\s+"([\s\S]*)"$/.exec(text);
  if (m) return { channel: BRACKET_CHANNELS[m[1].toLowerCase()] ?? 'other', speaker: m[2], to: null, body: m[3] };
  m = /^(.+?) tells you,\s+"([\s\S]*)"$/.exec(text);
  if (m) return { channel: 'tell-in', speaker: m[1], to: 'You', body: m[2] };
  m = /^You tell (.+?),\s+"([\s\S]*)"$/.exec(text);
  if (m) return { channel: 'tell-out', speaker: 'You', to: m[1], body: m[2] };
  m = /^(.+?)\s+says?,\s+"([\s\S]*)"$/.exec(text);
  if (m) return { channel: 'say', speaker: m[1], to: null, body: m[2] };
  return { channel: null, speaker: null, to: null, body: text };
}

function dedupeGroup(ch: ChatChannel): string {
  return ch === 'tell-in' || ch === 'tell-out' ? 'tell' : ch;
}

function addCallout(s: OverlayState, now: number, c: Omit<Callout, 'id' | 'until'>): void {
  // A replayed historical event (page loaded later) gets no callout.
  if (now - c.t >= CALLOUT_MS) return;
  s.callouts.push({ ...c, id: s.nextCalloutId++, until: c.t + CALLOUT_MS });
}

/** Record a level seen for `c`. A rise over the last known level (or an explicit event) is a level-up. */
function noteLevel(s: OverlayState, c: CharView, level: number, t: number, now: number, explicit: boolean): void {
  if (!Number.isFinite(level) || level <= 0) return;
  const prev = c.level;
  if (prev !== null && level <= prev) { if (level < prev) c.level = level; return; }
  c.level = level;
  if (prev === null && !explicit) return; // first sighting: nothing to celebrate
  c.levelUps++;
  addCallout(s, now, { kind: 'level-up', char: c.id, name: c.name, text: `LEVEL ${level}`, sub: c.name, t });
}

function noteDeath(s: OverlayState, c: CharView, t: number, now: number, killer: string | null): void {
  if (c.lastDeathT !== null && Math.abs(t - c.lastDeathT) < DEATH_DEDUPE_MS) return;
  c.lastDeathT = t;
  c.deaths++;
  c.dead = true;
  addCallout(s, now, { kind: 'death', char: c.id, name: c.name, text: 'SLAIN', sub: killer ? `${c.name} — by ${killer}` : c.name, t });
}

function noteXp(c: CharView, st: FeedStatus): void {
  const total = st.xp?.total;
  if (typeof total !== 'number' || !Number.isFinite(total)) return;
  if (c.xpBaseline === null || total < c.xpBaseline) c.xpBaseline = total;
  c.xpTotal = total;
  c.xpToNext = typeof st.xp.toNext === 'number' ? st.xp.toNext : null;
  c.xpLevelStart = typeof st.xp.levelStart === 'number' ? st.xp.levelStart : null;
  c.xpSession = total - c.xpBaseline;
}

function resetSession(s: OverlayState, t: number, title: string | null): void {
  s.sessionStart = t;
  s.sessionTitle = title;
  s.segment = null;
  s.callouts = [];
  for (const c of Object.values(s.chars)) {
    c.deaths = 0; c.levelUps = 0; c.xpSession = 0; c.xpBaseline = c.xpTotal; c.lastDeathT = null;
  }
}

/**
 * Apply one feed event (mutates and returns `s`). `now` = the wall clock, used to suppress callouts
 * for events replayed from history; defaults to the event's own time (always "fresh").
 */
export function applyEvent(s: OverlayState, ev: FeedEvent, now: number = ev.t): OverlayState {
  if (s.sessionStart === null && ev.type !== 'session-start') s.sessionStart = ev.t;
  s.lastT = Math.max(s.lastT, ev.t);
  switch (ev.type) {
    case 'session-start':
      resetSession(s, ev.t, ev.title ?? null);
      break;
    case 'segment-start':
      s.segment = { title: ev.title, detail: ev.detail ?? null, t: ev.t };
      break;
    case 'segment-end':
      if (s.segment && s.segment.title === ev.title) s.segment = null;
      break;
    case 'status': {
      const c = charFor(s, ev.char);
      if (ev.name) c.name = ev.name;
      noteLevel(s, c, ev.level, ev.t, now, false);
      c.health = ev.health ?? c.health;
      c.stamina = ev.stamina ?? c.stamina;
      c.mana = ev.mana ?? c.mana;
      noteXp(c, ev);
      c.location = ev.location ?? c.location;
      c.goal = ev.goal ?? null;
      const dead = !!ev.dead || (ev.health ? ev.health.cur <= 0 && ev.health.max > 0 : false);
      if (dead && !c.dead) noteDeath(s, c, ev.t, now, null);
      c.dead = dead;
      c.lastStatusT = ev.t;
      break;
    }
    case 'level-up':
      noteLevel(s, charFor(s, ev.char), ev.level, ev.t, now, true);
      break;
    case 'death':
      noteDeath(s, charFor(s, ev.char), ev.t, now, ev.killer ?? null);
      break;
    case 'narration': {
      const c = charFor(s, ev.char);
      s.narration.push({ t: ev.t, char: c.id, name: c.name, text: ev.text });
      if (s.narration.length > NARRATION_KEEP) s.narration.splice(0, s.narration.length - NARRATION_KEEP);
      break;
    }
    case 'tool': {
      const c = charFor(s, ev.char);
      c.lastTool = { tool: ev.tool, summary: ev.summary, ok: ev.ok !== false, t: ev.t };
      break;
    }
    case 'chat':
      applyChat(s, ev, now);
      break;
  }
  pruneCallouts(s, now);
  return s;
}

function applyChat(s: OverlayState, ev: Extract<FeedEvent, { type: 'chat' }>, now: number): void {
  const seer = charFor(s, ev.char);
  const text = ev.text ?? '';

  // Level-up / death signals carried by chat text.
  let m = /^You are now level (\d+)!/.exec(text) ?? /^You have reached the maximum level of (\d+)!/.exec(text);
  if (m) noteLevel(s, seer, Number(m[1]), ev.t, now, true);
  m = /^(.+?) is now level (\d+)!$/.exec(text);
  if (m) { const id = idForName(s, m[1]); if (id) noteLevel(s, s.chars[id], Number(m[2]), ev.t, now, true); }
  if (/^Your death is preceded by\b/.test(text) || /^You have died\b/.test(text)) {
    const k = /courtesy of (.+?)!$/.exec(text);
    noteDeath(s, seer, ev.t, now, k ? k[1] : null);
  }
  m = /^(.+?)'s death is preceded by\b.*?(?:courtesy of (.+?))?!$/.exec(text);
  if (m) { const id = idForName(s, m[1]); if (id) noteDeath(s, s.chars[id], ev.t, now, m[2] ?? null); }

  const parsed = parseChatText(text);
  const channel: ChatChannel = ev.channel ?? parsed.channel ?? 'other';
  if (HIDDEN_CHAT_CHANNELS.includes(channel)) return;
  const rawSpeaker = ev.speaker ?? parsed.speaker;
  const rawTo = ev.to ?? parsed.to;
  const body = ev.message ?? parsed.body;
  const speaker = rawSpeaker === 'You' ? seer.name : rawSpeaker;
  const to = rawTo === 'You' ? seer.name : rawTo;
  const speakerId = idForName(s, speaker);

  // Both clients print fellowship lines, a tell's two ends, nearby says: show each once.
  const key = speaker
    ? `${dedupeGroup(channel)}|${speaker.toLowerCase()}|${body}`
    : `${seer.id}|${channel}|${body}`;
  const prev = s.recentChat[key];
  if (prev !== undefined && Math.abs(ev.t - prev) < CHAT_DEDUPE_MS) return;
  s.recentChat[key] = ev.t;
  for (const [k, t] of Object.entries(s.recentChat)) if (ev.t - t > CHAT_DEDUPE_MS * 4) delete s.recentChat[k];

  // A tell is shown from the teller's side regardless of which end printed it.
  const shownChannel: ChatChannel = channel === 'tell-in' ? 'tell-out' : channel;
  s.chat.push({ t: ev.t, channel: shownChannel, speaker, speakerId, to, body, seenBy: seer.id });
  if (s.chat.length > CHAT_KEEP) s.chat.splice(0, s.chat.length - CHAT_KEEP);
}

export function pruneCallouts(s: OverlayState, now: number): void {
  s.callouts = s.callouts.filter((c) => c.until > now);
}

/** Fill of the XP-to-next bar in [0,1], or null when it can't be known. */
export function xpFraction(c: CharView): number | null {
  if (c.xpTotal === null || c.xpToNext === null) return null;
  if (c.xpToNext <= 0) return 1;
  if (c.xpLevelStart === null || c.xpLevelStart > c.xpTotal) return null;
  const span = c.xpTotal + c.xpToNext - c.xpLevelStart;
  return span > 0 ? Math.min(1, Math.max(0, (c.xpTotal - c.xpLevelStart) / span)) : null;
}

export function vitalFraction(v: FeedVital | null): number {
  if (!v || v.max <= 0) return 0;
  return Math.min(1, Math.max(0, v.cur / v.max));
}

/** H:MM:SS (or M:SS under an hour). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 950 → "950", 12_345 → "12,345", 1_234_567 → "1.23M", 2_500_000_000 → "2.50B". */
export function formatXp(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return Math.round(n).toLocaleString('en-US');
}

/** Opacity for chat line `index` of `count` (0 = oldest) at `ageMs`: newest lines solid, older fade. */
export function chatOpacity(index: number, count: number, ageMs: number): number {
  const fromNewest = count - 1 - index;
  const byPos = fromNewest < 6 ? 1 : Math.max(0.2, 1 - (fromNewest - 5) * 0.12);
  const byAge = ageMs < 90_000 ? 1 : Math.max(0.35, 1 - (ageMs - 90_000) / 180_000);
  return Math.min(byPos, byAge);
}

/**
 * Character-card geometry (px at 1920x1080). app.ts publishes these as CSS custom properties
 * (cardLayoutCssVars) and overlay.css sizes every card row from them, so the fit test below
 * the layout is checking the numbers the page actually uses. Each text row is one line
 * (ellipsis on overflow) with line-height = its row height.
 */
export const CARD_LAYOUT = {
  top: 608,
  height: 212,
  padTop: 10,
  padBottom: 8,
  /** Top border (the character-colour stripe). */
  border: 3,
  gap: 5,
  rows: {
    head: { h: 36, font: 30 },
    vitals: { h: 26, font: 15 },
    /** 8 px bar + 2 px gap + 18 px text line. */
    xp: { h: 28, font: 15 },
    location: { h: 24, font: 19 },
    goal: { h: 24, font: 19 },
    tool: { h: 18, font: 14 },
  },
  /** The chat / narration row starts here. */
  bottomRowTop: 828,
} as const;

/** Height the card's rows need, padding and border included. */
export function cardContentHeight(l: typeof CARD_LAYOUT = CARD_LAYOUT): number {
  const rows = Object.values(l.rows);
  return l.border + l.padTop + l.padBottom + rows.reduce((a, r) => a + r.h, 0) + l.gap * (rows.length - 1);
}

/** The CSS custom properties app.ts sets on :root. */
export function cardLayoutCssVars(l: typeof CARD_LAYOUT = CARD_LAYOUT): Record<string, string> {
  const vars: Record<string, string> = {
    '--card-top': `${l.top}px`, '--card-h': `${l.height}px`, '--card-pad-top': `${l.padTop}px`,
    '--card-pad-bottom': `${l.padBottom}px`, '--card-border': `${l.border}px`, '--card-gap': `${l.gap}px`,
    '--bottom-top': `${l.bottomRowTop}px`,
  };
  for (const [k, r] of Object.entries(l.rows)) {
    vars[`--row-${k}`] = `${r.h}px`;
    vars[`--font-${k}`] = `${r.font}px`;
  }
  return vars;
}
