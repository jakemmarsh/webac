/**
 * The stream event feed: one JSON object per line (JSONL), appended by the stream supervisor
 * (tools/stream/supervisor.ts) and tailed by the overlay server (tools/stream/overlay-server.ts).
 *
 * Default path: `$TMPDIR/acjs-agent/stream/feed.jsonl` ({@link defaultFeedPath}). The overlay
 * tolerates a partial last line, truncation and rotation (rename + new file), so the writer can
 * simply `appendFileSync(path, JSON.stringify(ev) + '\n')`.
 *
 * Rules every event follows:
 * - `v` is {@link FEED_VERSION}; `t` is the wall-clock time in epoch ms (Date.now()).
 * - `char` is the agent PROFILE id (`mage`, `soldier`), not the character name. The character's
 *   in-game name travels in `status.name` (and the overlay's roster defaults).
 * - Unknown extra fields are ignored; unknown `type`s are dropped by the parser.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FEED_VERSION = 1 as const;

/** `$ACJS_STREAM_FEED`, else `$TMPDIR/acjs-agent/stream/feed.jsonl` (next to the play daemons' state). */
export function defaultFeedPath(): string {
  return process.env.ACJS_STREAM_FEED ?? join(process.env.ACJS_AGENT_STATE_DIR ?? tmpdir(), 'acjs-agent', 'stream', 'feed.jsonl');
}

/** Profile id of the agent that produced (or saw) the event: 'mage' | 'soldier' | … */
export type FeedCharId = string;

interface FeedBase {
  v: typeof FEED_VERSION;
  /** Epoch ms. */
  t: number;
}

/**
 * Chat channel of a line as the character's client showed it.
 * tell-in = someone told this character; tell-out = this character told someone.
 * fellowship/general/trade/lfg/roleplay/society/allegiance = the bracketed channels.
 * system = server/system text (level-up, "You have entered …"); combat/magic = combat-log spam
 * (the overlay hides those two by default but they may be sent).
 */
export type ChatChannel =
  | 'say' | 'emote' | 'tell-in' | 'tell-out'
  | 'fellowship' | 'allegiance' | 'general' | 'trade' | 'lfg' | 'roleplay' | 'society'
  | 'system' | 'combat' | 'magic' | 'other';

/** A chat line seen in `char`'s client. Both windows see fellowship lines: the overlay dedupes. */
export interface FeedChat extends FeedBase {
  type: 'chat';
  char: FeedCharId;
  channel: ChatChannel;
  /** The full line exactly as the client printed it, e.g. `[Fellowship] Claude Bulwark says, "Behind me."`. */
  text: string;
  /** Optional, when the writer knows them: speaker name ("You" allowed), recipient for tells, the bare message. */
  speaker?: string;
  to?: string;
  message?: string;
}

/** One of the player's short "what I'm doing and why" lines (the agent's own narration, not game chat). */
export interface FeedNarration extends FeedBase {
  type: 'narration';
  char: FeedCharId;
  text: string;
}

/** A summarised agent tool call, e.g. tool 'ac_walk_to', summary 'Holtburg lifestone (42 m)'. */
export interface FeedTool extends FeedBase {
  type: 'tool';
  char: FeedCharId;
  tool: string;
  summary: string;
  /** false when the call failed / was refused. */
  ok?: boolean;
}

/** A stream segment ("Drudge hunt west of Holtburg"). `char` absent = both players. */
export interface FeedSegment extends FeedBase {
  type: 'segment-start' | 'segment-end';
  title: string;
  char?: FeedCharId;
  detail?: string;
}

/** Start of a streaming session: resets the session clock, "XP this session" and death counters. */
export interface FeedSession extends FeedBase {
  type: 'session-start';
  title?: string;
}

export interface FeedDeath extends FeedBase {
  type: 'death';
  char: FeedCharId;
  /** Killer name when known. */
  killer?: string;
  /** The victim line, e.g. "Your death is preceded by a sharp, stabbing pain, courtesy of Drudge Skulker!". */
  text?: string;
}

export interface FeedLevelUp extends FeedBase {
  type: 'level-up';
  char: FeedCharId;
  /** The NEW level. */
  level: number;
}

export interface FeedVital { cur: number; max: number }

/** Periodic snapshot of one character (every few seconds, and on change). */
export interface FeedStatus extends FeedBase {
  type: 'status';
  char: FeedCharId;
  /** In-game character name, e.g. "Claude Arcanist". */
  name: string;
  level: number;
  health: FeedVital;
  stamina: FeedVital;
  mana: FeedVital;
  xp: {
    /** Total XP earned (PropertyInt64 TotalExperience). */
    total: number;
    /** XP still needed for the next level (0 at max level). */
    toNext: number;
    /** Total XP at which the CURRENT level began, if known (makes the XP bar exact). */
    levelStart?: number;
  };
  /** Human location text, e.g. "Holtburg, 42.1N 33.6E" or "Drudge Hideout (dungeon)". */
  location: string;
  /** The character's current goal line (ac_goal text), or null when none. */
  goal: string | null;
  dead?: boolean;
}

export type FeedEvent =
  | FeedChat | FeedNarration | FeedTool | FeedSegment | FeedSession
  | FeedDeath | FeedLevelUp | FeedStatus;

export type FeedEventType = FeedEvent['type'];

export const FEED_EVENT_TYPES: readonly FeedEventType[] = [
  'chat', 'narration', 'tool', 'segment-start', 'segment-end', 'session-start', 'death', 'level-up', 'status',
];
