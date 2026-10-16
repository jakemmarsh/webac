/**
 * The supervisor's decisions, as pure functions (tested in tests/verify-stream-supervisor.ts): what to do when a
 * player's turn ends, whether and when the next segment starts, and what today's segments have cost.
 */
import type { StreamConfig } from './config.ts';
import type { SegmentUsage } from './feed.ts';

/** One finished segment, as the segment log (stream/segments.jsonl) keeps it. */
export interface SegmentRecord {
  profile: string;
  character: string;
  segment: number;
  start: string;
  end: string;
  minutes: number;
  reason: SegmentEndReason;
  model: string;
  sessionId: string | null;
  usage: SegmentUsage | null;
  /** The last thing the player wrote (its report, when it got to write one), clipped. */
  finalText: string;
}

export type SegmentEndReason = 'done' | 'quit-early' | 'crashed' | 'timed-out' | 'stopping' | 'budget';

/**
 * A player's turn ended (`result`). Keep it going with a nudge while the segment has time left (an early quit: a
 * report written at minute 20, "waiting for my partner", a give-up), else end the segment.
 */
export function afterTurn(s: { nowMs: number; deadlineMs: number; stopping: boolean; wrapUpSent: boolean; nudges: number; maxNudges: number; resultSubtype?: string }): 'nudge' | 'end' {
  if (s.stopping || s.wrapUpSent || s.nowMs >= s.deadlineMs) return 'end';
  // A budget or turn cap ends the session for real; nudging it would only fail again.
  if (s.resultSubtype && /max_budget|budget|max_turns/.test(s.resultSubtype)) return 'end';
  return s.nudges < s.maxNudges ? 'nudge' : 'end';
}

/**
 * Whether to ask a quiet player to say what they're doing: their turn is running (not between turns, not wrapping up),
 * they have neither written a line nor made a call that acts for `quietMs`, and nothing of theirs is running in the game
 * (`task` null from the daemon's vitals: no walk, follow, fight or repeat cast; undefined = unknown, never nudged). A
 * running task counts as activity (the supervisor stamps `lastActiveMs` when it sees one), so a walk that ends doesn't
 * set one off at once. At most one per `quietMs`.
 */
export function quietNudge(s: { nowMs: number; quietMs: number | null; inTurn: boolean; wrapUpSent: boolean; stopping: boolean; lastActiveMs: number; lastNudgeMs: number; task: string | null | undefined }): boolean {
  if (s.quietMs === null || s.quietMs <= 0 || !s.inTurn || s.wrapUpSent || s.stopping) return false;
  if (s.task !== null) return false;
  return s.nowMs - s.lastActiveMs >= s.quietMs && s.nowMs - s.lastNudgeMs >= s.quietMs;
}

/** Agent CLI tools that only look or wait: a player making only these calls is quiet (quietNudge). */
export const QUIET_TOOLS: ReadonlySet<string> = new Set(['wait', 'observe', 'look', 'status', 'trace', 'map', 'vitals', 'sessions', 'help']);

/** Why a segment ended, from how its session ended. */
export function endReason(s: { stopping: boolean; wrapUpSent: boolean; killed: boolean; sawResult: boolean; exitCode: number | null; resultSubtype?: string }): SegmentEndReason {
  if (s.stopping) return 'stopping';
  if (s.resultSubtype && /budget/.test(s.resultSubtype)) return 'budget';
  if (s.killed) return 'timed-out';
  if (!s.sawResult || (s.exitCode !== null && s.exitCode !== 0)) return 'crashed';
  return s.wrapUpSent ? 'done' : 'quit-early';
}

export interface DayUsage { segments: number; minutes: number; usd: number }

/** What a character's segments started on `day` (local YYYY-MM-DD) have used. */
export function dayUsage(records: readonly SegmentRecord[], profile: string, day: string, dayOf: (iso: string) => string = localDay): DayUsage {
  const mine = records.filter((r) => r.profile === profile && dayOf(r.start) === day);
  return {
    segments: mine.length,
    minutes: mine.reduce((n, r) => n + r.minutes, 0),
    usd: mine.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0),
  };
}

export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type NextStep = { action: 'start'; delayMs: number } | { action: 'halt'; why: string };

/**
 * After a segment: the next one after a pause, or halt the character. A crash or a quick quit backs off (the pause
 * doubles per consecutive quick exit, capped) and too many in a row halt it; the run's and the day's caps halt it.
 */
export function nextSegment(s: {
  cfg: StreamConfig;
  stopping: boolean;
  segmentsThisRun: number;
  /** Consecutive quick exits so far, this one included. */
  quickExits: number;
  last: SegmentEndReason | null;
  today: DayUsage;
}): NextStep {
  const { cfg } = s;
  if (s.stopping) return { action: 'halt', why: 'the stream is stopping' };
  if (s.last === 'budget') return { action: 'halt', why: 'the segment budget ran out (segment.budgetUsd); raise it or restart the stream' };
  if (s.segmentsThisRun >= cfg.maxSegments) return { action: 'halt', why: `played ${s.segmentsThisRun} segments, the run's maxSegments` };
  if (s.today.segments >= cfg.daily.maxSegments) return { action: 'halt', why: `daily cap: ${s.today.segments} segments today (daily.maxSegments)` };
  if (s.today.minutes >= cfg.daily.maxMinutes) return { action: 'halt', why: `daily cap: ${Math.round(s.today.minutes)} minutes today (daily.maxMinutes)` };
  if (cfg.daily.maxUsd !== null && s.today.usd >= cfg.daily.maxUsd) return { action: 'halt', why: `daily cap: $${s.today.usd.toFixed(2)} API-equivalent today (daily.maxUsd)` };
  if (s.quickExits >= cfg.segment.maxQuickExits) return { action: 'halt', why: `${s.quickExits} segments in a row ended within ${cfg.segment.quickExitMinutes} min (crashing?): see the supervisor log` };
  if (s.last === null) return { action: 'start', delayMs: 0 };
  const base = cfg.segment.restartPauseSeconds * 1000;
  const delayMs = s.quickExits > 0 ? Math.min(cfg.segment.maxBackoffSeconds * 1000, Math.max(base, 30_000) * 2 ** (s.quickExits - 1)) : base;
  return { action: 'start', delayMs };
}
