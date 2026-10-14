/**
 * Dead air in a stream run: how much of each segment a viewer watched a character doing something visible (fighting,
 * moving, talking) and where the rest went (the model thinking, a `wait`, other tool calls).
 *
 *   npx tsx tools/stream/dead-air.ts <stream-dir> [--logs <dir>] [--top 8] [--json]
 *
 * <stream-dir> is a supervisor run's directory ($TMPDIR/acjs-agent/stream): segments.jsonl names each segment's
 * profile, character, start, end and session id; sessions/*.jsonl hold the raw `claude -p` stream-json (every tool
 * call and result with its time). The game side comes from <logs>/<profile>.chat.log (default: the stream dir's
 * parent, where the play daemons write it), whose timestamped lines carry every swing, cast, hit and chat line.
 *
 * Each second of a segment gets ONE class, the first that applies:
 *   fighting  the character's own combat or magic line (swing, cast, damage either way, evade) within FIGHT_GAP_MS of
 *             the next one, an `attack` until it ends, a `cast` while it runs
 *   talking   TALK_MS after each of the character's own say / tell / fellowship / emote lines
 *   stuck     a walk_to / follow / use … call that ended "took longer than … stopped N m away" / "stopped N m short",
 *             and, from the daemon log's timed walk trace (<profile>.log, 2026-10-14 on), each route search that found
 *             nothing and each stall (the character stood or pushed into a wall: not something a viewer reads as travel)
 *   moving    a walk_to / follow / use / loot / pick_up call while it runs (and a walk that answered "still in
 *             progress" until a task-done), portal space
 *   waiting   inside a `wait` call with nothing above
 *   tools     inside any other tool call (observe, inventory, character, raise, world-query …)
 *   thinking  between calls (the model reading the last result and deciding), nothing above
 * The first three (and talking) are what a viewer sees happen; the last three are dead air.
 *
 * Learned from the rehearsals of 2026-10-13 (docs/agent-play.md, "Dead air").
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cliCalls, parseChatLine, type ChatParseState } from './feed.ts';

export type Activity = 'fighting' | 'moving' | 'stuck' | 'talking' | 'waiting' | 'tools' | 'thinking';
export const ACTIVITIES: readonly Activity[] = ['fighting', 'talking', 'stuck', 'moving', 'waiting', 'tools', 'thinking'];
export const VISIBLE: ReadonlySet<Activity> = new Set(['fighting', 'moving', 'talking']);

/** Two combat lines this close are one fight (a bolt every ~3 s, a swing every ~1.5–2.5 s in the rehearsals). */
export const FIGHT_GAP_MS = 8000;
/** A lone combat line counts for this long around it. */
const FIGHT_PAD_MS = 1500;
/** A chat line stays on screen (bubble, overlay) and reads for about this long. */
export const TALK_MS = 5000;
/** An `attack` keeps swinging until the target dies; capped when nothing says it ended. */
const ATTACK_CAP_MS = 60_000;
/** A walk or a cast repeat that answered "still in progress" keeps going until a task-done, capped. */
const BACKGROUND_CAP_MS = 180_000;

const MOVE_TOOLS = new Set(['walk_to', 'follow', 'use', 'use_on', 'loot', 'pick_up', 'give', 'move', 'jump']);
const STUCK_RESULT = /took longer than|stopped [\d.]+ m (?:short|away)|couldn't reach|hasn't moved|\bstuck\b/i;

export interface ToolCall {
  start: number;
  end: number;
  /** The agent CLI tool ("wait", "observe" …), "world-query", or "bash". */
  tool: string;
  command: string;
  result: string;
  isError: boolean;
}
export interface TextBlock { t: number; text: string }
export interface SessionTimeline {
  calls: ToolCall[];
  texts: TextBlock[];
  /** User messages that aren't tool results (the supervisor's), with their time. */
  supervisor: TextBlock[];
}

/** A session's tool calls (with their times and results), its narration and the supervisor's messages. */
export function parseSession(lines: readonly string[], sessionId?: string): SessionTimeline {
  const open = new Map<string, { start: number; command: string }>();
  const out: SessionTimeline = { calls: [], texts: [], supervisor: [] };
  for (const line of lines) {
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || (sessionId && m.session_id && m.session_id !== sessionId)) continue;
    const t = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    const content = m.message?.content;
    if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') open.set(String(b.id), { start: t, command: String(b.input?.command ?? b.input?.file_path ?? b.name ?? '') });
        else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.texts.push({ t, text: b.text.trim() });
      }
    } else if (m.type === 'user') {
      if (typeof content === 'string') { out.supervisor.push({ t, text: content }); continue; }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const o = open.get(String(b.tool_use_id));
          if (!o) continue;
          open.delete(String(b.tool_use_id));
          const c = b.content;
          const result = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === 'text' ? x.text : '')).join('\n') : '';
          const cli = cliCalls(o.command)[0];
          const tool = cli ? cli.tool : /world-query/.test(o.command) ? 'world-query' : 'bash';
          out.calls.push({ start: o.start, end: Math.max(t, o.start), tool, command: o.command, result, isError: !!b.is_error });
        } else if (b?.type === 'text' && typeof b.text === 'string') out.supervisor.push({ t, text: b.text });
      }
    }
  }
  out.calls.sort((a, b) => a.start - b.start);
  return out;
}

export interface ChatMark { t: number; kind: 'combat' | 'talk' | 'portal' | 'partner' }
/** A timed `[AC:Agent] walk …` line of the daemon log; `failed` for a search that found nothing or a stall. */
export interface WalkMark { t: number; failed: boolean }

const WALK_FAILED = /walk search none|no doorway route|no way (?:into|inside|on foot|through|out)|walk stall \d/;
/** Longest a single failed search counts as standing (a gap past it is the walk doing something else). */
const SEARCH_CAP_MS = 30_000;

/** The daemon log's timed walk trace in [from, to] (lines "<ISO> [page] [AC:Agent] walk …"; older logs have no time). */
export function walkMarks(lines: readonly string[], from: number, to: number): WalkMark[] {
  const out: WalkMark[] = [];
  for (const line of lines) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[page\] \[AC:Agent\] (walk.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (t >= from && t <= to) out.push({ t, failed: WALK_FAILED.test(m[2]) });
  }
  return out;
}

/** The character's own visible chat-log lines in [from, to]: combat/magic, its own speech, portal space. */
export function chatMarks(lines: readonly string[], profile: string, me: string, cast: readonly string[], from: number, to: number): ChatMark[] {
  const state: ChatParseState = { incantations: new Set() };
  const out: ChatMark[] = [];
  for (const line of lines) {
    const ts = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(ts) || ts < from - 10_000 || ts > to) continue;
    // A cast member speaking to this one (feed.ts leaves their lines to their own log, so match them here).
    const heard = /^\S+ (?:\[[A-Za-z ]+\] )?(.+?) (?:says|tells you), "/.exec(line);
    if (heard && heard[1] !== me && cast.includes(heard[1]) && ts >= from) { out.push({ t: ts, kind: 'partner' }); continue; }
    for (const { t, draft } of parseChatLine(line, profile, me, cast, state)) {
      if (t < from || draft.type !== 'chat') continue;
      const text = draft.text;
      if (/^In Portal Space/.test(text)) out.push({ t, kind: 'portal' });
      else if (draft.channel === 'combat' || draft.channel === 'magic') out.push({ t, kind: 'combat' });
      else if (draft.channel === 'tell-out' || ((draft.channel === 'say' || draft.channel === 'fellowship' || draft.channel === 'emote') && draft.speaker === me)) out.push({ t, kind: 'talk' });
      else if (draft.channel === 'system' && text.startsWith(`${me} `) && !/^\S+ \S+ (?:cast|is now|has|may|does)\b/.test(text)) out.push({ t, kind: 'talk' });
    }
  }
  return out;
}

const IN_PROGRESS = /still in progress|keeps going|moved to the background/i;
const TASK_DONE = /task-done|arrived|stopped:|died\b|target-lost|target-died/i;

/** Spans [start, end) of each activity, before priorities are applied. */
export function activitySpans(s: SessionTimeline, marks: readonly ChatMark[], walks: readonly WalkMark[] = []): Array<{ a: Activity; start: number; end: number }> {
  const spans: Array<{ a: Activity; start: number; end: number }> = [];
  // A failed search is printed when it ends: it stood from the walk's previous line to this one.
  for (let i = 1; i < walks.length; i++) {
    if (walks[i].failed && walks[i].t - walks[i - 1].t <= SEARCH_CAP_MS) spans.push({ a: 'stuck', start: walks[i - 1].t, end: walks[i].t });
  }
  const combat = marks.filter((m) => m.kind === 'combat').map((m) => m.t).sort((x, y) => x - y);
  for (let i = 0; i < combat.length; i++) {
    const t = combat[i];
    const next = combat[i + 1];
    spans.push({ a: 'fighting', start: t - FIGHT_PAD_MS, end: next !== undefined && next - t <= FIGHT_GAP_MS ? next : t + FIGHT_PAD_MS });
  }
  const portal = marks.filter((m) => m.kind === 'portal').map((m) => m.t);
  if (portal.length) {
    let a = portal[0], b = portal[0];
    for (const t of portal.slice(1)) { if (t - b > 10_000) { spans.push({ a: 'moving', start: a, end: b + 2000 }); a = t; } b = t; }
    spans.push({ a: 'moving', start: a, end: b + 2000 });
  }
  for (const m of marks) if (m.kind === 'talk') spans.push({ a: 'talking', start: m.t, end: m.t + TALK_MS });
  const calls = s.calls;
  // When a background task (an attack's swings, a walk or repeat that answered "in progress") ends: the first later
  // result that says so, or the next call that replaces it.
  const endOfBackground = (i: number, cap: number, replacedBy: Set<string>): number => {
    const c = calls[i];
    for (let j = i + 1; j < calls.length; j++) {
      const d = calls[j];
      if (d.start > c.end + cap) break;
      if (replacedBy.has(d.tool)) return Math.min(d.start, c.end + cap);
      if (d.tool === 'wait' && TASK_DONE.test(d.result)) return Math.min(d.end, c.end + cap);
    }
    return c.end + Math.min(cap, 20_000);
  };
  const ACTIONS = new Set(['attack', 'cast', 'walk_to', 'follow', 'use', 'loot', 'stop_moving', 'routine']);
  calls.forEach((c, i) => {
    if (c.tool === 'attack' && !c.isError) spans.push({ a: 'fighting', start: c.start, end: endOfBackground(i, ATTACK_CAP_MS, ACTIONS) });
    else if (c.tool === 'cast') {
      spans.push({ a: 'fighting', start: c.start, end: c.end });
      if (IN_PROGRESS.test(c.result)) spans.push({ a: 'fighting', start: c.end, end: endOfBackground(i, BACKGROUND_CAP_MS, ACTIONS) });
    } else if (MOVE_TOOLS.has(c.tool)) {
      const stuck = STUCK_RESULT.test(c.result) && !/arrived/.test(c.result);
      spans.push({ a: stuck ? 'stuck' : 'moving', start: c.start, end: c.end });
      if (IN_PROGRESS.test(c.result)) spans.push({ a: 'moving', start: c.end, end: endOfBackground(i, BACKGROUND_CAP_MS, ACTIONS) });
    } else if (c.tool === 'wait') spans.push({ a: 'waiting', start: c.start, end: c.end });
    else spans.push({ a: 'tools', start: c.start, end: c.end });
  });
  return spans;
}

/** One activity per second of [from, to): the first in ACTIVITIES order that covers it, else thinking. */
export function classifySeconds(from: number, to: number, spans: ReadonlyArray<{ a: Activity; start: number; end: number }>): Activity[] {
  const n = Math.max(0, Math.ceil((to - from) / 1000));
  const rank = new Map(ACTIVITIES.map((a, i) => [a, i]));
  const best = new Array<number>(n).fill(ACTIVITIES.indexOf('thinking'));
  for (const s of spans) {
    const r = rank.get(s.a)!;
    const i0 = Math.max(0, Math.floor((s.start - from) / 1000));
    const i1 = Math.min(n, Math.ceil((s.end - from) / 1000));
    for (let i = i0; i < i1; i++) if (r < best[i]) best[i] = r;
  }
  return best.map((r) => ACTIVITIES[r]);
}

export interface IdleStretch {
  start: number;
  end: number;
  seconds: number;
  /** Seconds of each dead-air kind in it. */
  waiting: number; tools: number; thinking: number; stuck: number;
  /** What the player called during it, and its own words just before and during it. */
  commands: string[];
  said: string[];
  cause: string;
}

/**
 * Causes, by what the player wrote and called around a stretch (first match wins). They name what the rehearsals'
 * idle time was spent on; anything else is "other".
 */
export const CAUSES: ReadonlyArray<{ cause: string; re: RegExp }> = [
  { cause: 'stuck walk / portal hand-off', re: /took longer than|stopped [\d.]+ m (?:short|away)|couldn't reach|out of sight|through (?:the|a) portal|portal space|hasn't come through|the hole|weak spot/i },
  { cause: 'waiting for mana', re: /\bmana\b.*(?:low|regen|back|top|meditat|wait|empty|out|recover)|meditat|regenerat|\bOOM\b/i },
  { cause: 'waiting for the partner', re: /waiting for (?:her|him|them|claude|arcanist|bulwark|my partner)|hasn't (?:answered|replied|come)|no (?:answer|reply)|still no|silent|holding (?:the door|here|at)|hold here|where (?:is|are) (?:she|he|you)|catch up|caught up|(?:she|he)'s (?:still|not)|ping(?:ing)? (?:her|him)|nothing within/i },
  { cause: 'buffing', re: /\bbuff|\bward|armor (?:self|other)|protection (?:self|other)/i },
  { cause: 'shopping, loot and inventory', re: /\b(?:sell|vendor|buy|shop|loot|inventory|pack|burden|scroll)\b/i },
  { cause: 'character sheet and raises', re: /\b(?:raise|train|credits?|skill|xp)\b/i },
  { cause: 'planning a route', re: /world-query|SELECT|\bmap\b|coordinates?|where (?:the|to)|route/i },
  { cause: 'healing and resting', re: /\bheal|\brest\b|health|stamina/i },
];

export function causeOf(text: string): string {
  for (const c of CAUSES) if (c.re.test(text)) return c.cause;
  return 'other';
}

/** Runs of dead air (no visible activity) at least `minSeconds` long, each with its context and a cause. */
export function idleStretches(from: number, seconds: readonly Activity[], s: SessionTimeline, minSeconds = 10): IdleStretch[] {
  const out: IdleStretch[] = [];
  let i = 0;
  while (i < seconds.length) {
    if (VISIBLE.has(seconds[i])) { i++; continue; }
    let j = i;
    while (j < seconds.length && !VISIBLE.has(seconds[j])) j++;
    if (j - i >= minSeconds) {
      const start = from + i * 1000, end = from + j * 1000;
      const count = (a: Activity) => seconds.slice(i, j).filter((x) => x === a).length;
      const calls = s.calls.filter((c) => c.start < end && c.end >= start);
      // Its own words just before (the reason it gave) and during the stretch.
      const said = s.texts.filter((x) => x.t >= start - 15_000 && x.t < end).map((x) => x.text.replace(/\s+/g, ' ').slice(0, 200));
      const commands = calls.map((c) => `${c.command.replace(/\s+/g, ' ').slice(0, 110)} → ${c.result.replace(/\s+/g, ' ').slice(0, 90)}`);
      out.push({ start, end, seconds: j - i, waiting: count('waiting'), tools: count('tools'), thinking: count('thinking'), stuck: count('stuck'), commands, said, cause: causeOf([...calls.map((c) => `${c.command}\n${c.result.slice(0, 300)}`), ...said].join('\n')) });
    }
    i = j;
  }
  return out;
}

export interface SegmentInput {
  profile: string;
  character: string;
  segment: number;
  start: number;
  end: number;
  session: SessionTimeline;
  chat: readonly ChatMark[];
  walks?: readonly WalkMark[];
  /** When the supervisor sent the wrap-up (supervisor.log; stream-json output doesn't echo input messages). */
  wrapUp?: number | null;
}
export interface SegmentReport {
  profile: string; character: string; segment: number; start: number; end: number;
  /** When the supervisor said wrap up (null: never). */
  wrapUp: number | null;
  totals: Record<Activity, number>;
  /** The same, from the start to the wrap-up (the play the brief asks for; the wrap-up is its own list). */
  play: Record<Activity, number>;
  stretches: IdleStretch[];
  /** One letter per second from `start` to the wrap-up (CODE: f m s t w o k), for lining two players up. */
  timeline: string;
  /** Dead-air seconds by cause, over the stretches. */
  causes: Record<string, number>;
  /** Time between a result and the next call (the model deciding), and how long calls took, per tool. */
  thinkGaps: { count: number; medianMs: number; p90Ms: number; totalMs: number };
  /**
   * Waits that slept on after the partner spoke to this character (a /f line, a tell, a say): how many, and the
   * seconds from the partner's line to the wait's end. The brief's fight wait is meant to wake on those.
   */
  missedWakes: { count: number; seconds: number };
  toolTime: Record<string, { count: number; totalMs: number }>;
}

/** A letter per activity for SegmentReport.timeline. */
export const CODE: Record<Activity, string> = { fighting: 'f', moving: 'm', stuck: 's', talking: 't', waiting: 'w', tools: 'o', thinking: 'k' };
const VISIBLE_CODES = new Set([...VISIBLE].map((a) => CODE[a]));

/**
 * Both players' dead air at once: seconds where neither did anything visible (what a viewer watching both windows
 * sees as nothing happening), over the overlap of the two play windows.
 */
export function pairDeadAir(a: SegmentReport, b: SegmentReport): { overlap: number; bothIdle: number } {
  const from = Math.max(a.start, b.start);
  const to = Math.min(a.start + a.timeline.length * 1000, b.start + b.timeline.length * 1000);
  let overlap = 0, bothIdle = 0;
  for (let t = from; t < to; t += 1000) {
    const ca = a.timeline[Math.floor((t - a.start) / 1000)], cb = b.timeline[Math.floor((t - b.start) / 1000)];
    if (ca === undefined || cb === undefined) continue;
    overlap++;
    if (!VISIBLE_CODES.has(ca) && !VISIBLE_CODES.has(cb)) bothIdle++;
  }
  return { overlap, bothIdle };
}

const tally = (xs: readonly Activity[]): Record<Activity, number> => Object.fromEntries(ACTIVITIES.map((a) => [a, xs.filter((x) => x === a).length])) as Record<Activity, number>;

export function analyzeSegment(inp: SegmentInput, minStretch = 10): SegmentReport {
  const spans = activitySpans(inp.session, inp.chat, inp.walks ?? []);
  const secs = classifySeconds(inp.start, inp.end, spans);
  const wrap = inp.wrapUp ?? inp.session.supervisor.find((m) => /wrap up|stream is ending/i.test(m.text) && m.t > inp.start)?.t ?? null;
  const playSecs = wrap ? secs.slice(0, Math.max(0, Math.floor((wrap - inp.start) / 1000))) : secs;
  const stretches = idleStretches(inp.start, playSecs, inp.session, minStretch);
  const causes: Record<string, number> = {};
  for (const s of stretches) causes[s.cause] = (causes[s.cause] ?? 0) + s.seconds;
  // The model's turn time: from a result to the next call it makes (parallel calls: from the latest result before it).
  const gaps: number[] = [];
  const calls = inp.session.calls;
  for (let i = 1; i < calls.length; i++) {
    const lastEnd = Math.max(...calls.slice(0, i).map((c) => c.end));
    if (calls[i].start > lastEnd) gaps.push(calls[i].start - lastEnd);
  }
  gaps.sort((a, b) => a - b);
  const partner = inp.chat.filter((m) => m.kind === 'partner').map((m) => m.t);
  const missedWakes = { count: 0, seconds: 0 };
  for (const c of calls) {
    if (c.tool !== 'wait') continue;
    const first = partner.find((t) => t > c.start + 500 && t < c.end - 2000);
    if (first !== undefined) { missedWakes.count++; missedWakes.seconds += Math.round((c.end - first) / 1000); }
  }
  const toolTime: Record<string, { count: number; totalMs: number }> = {};
  for (const c of calls) { const t = (toolTime[c.tool] ??= { count: 0, totalMs: 0 }); t.count++; t.totalMs += c.end - c.start; }
  return {
    profile: inp.profile, character: inp.character, segment: inp.segment, start: inp.start, end: inp.end, wrapUp: wrap,
    totals: tally(secs), play: tally(playSecs), timeline: playSecs.map((a) => CODE[a]).join(''), stretches, causes,
    thinkGaps: { count: gaps.length, medianMs: gaps[Math.floor(gaps.length / 2)] ?? 0, p90Ms: gaps[Math.floor(gaps.length * 0.9)] ?? 0, totalMs: gaps.reduce((a, b) => a + b, 0) },
    missedWakes, toolTime,
  };
}

// ── the CLI: read a run's directory ──

interface SegmentRow { profile: string; character: string; segment: number; start: string; end: string; sessionId?: string }

export function analyzeRun(streamDir: string, logsDir = dirname(resolve(streamDir)), minStretch = 10): SegmentReport[] {
  const rows: SegmentRow[] = readFileSync(join(streamDir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cast = [...new Set(rows.map((r) => r.character))];
  const sessionsDir = join(streamDir, 'sessions');
  const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')) : [];
  const chatCache = new Map<string, string[]>();
  // "<ISO> Claude Arcanist: segment 1: wrap-up sent" (or "stream ending sent").
  const supLog = join(streamDir, 'supervisor.log');
  const wrapUps = existsSync(supLog) ? readFileSync(supLog, 'utf8').split('\n').map((l) => /^(\S+) (.+?): segment (\d+): (?:wrap-up|stream ending)/i.exec(l)).filter((m): m is RegExpExecArray => !!m) : [];
  return rows.map((r) => {
    const lines = files.filter((f) => f.startsWith(`${r.profile}-`) && (r.sessionId || f.endsWith(`-seg${r.segment}.jsonl`)))
      .flatMap((f) => readFileSync(join(sessionsDir, f), 'utf8').split('\n'));
    const session = parseSession(lines, r.sessionId);
    const chatFile = join(logsDir, `${r.profile}.chat.log`), logFile = join(logsDir, `${r.profile}.log`);
    for (const f of [chatFile, logFile]) if (!chatCache.has(f)) chatCache.set(f, existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []);
    const start = Date.parse(r.start), end = Date.parse(r.end);
    return analyzeSegment({ profile: r.profile, character: r.character, segment: r.segment, start, end, session, chat: chatMarks(chatCache.get(chatFile)!, r.profile, r.character, cast, start, end), walks: walkMarks(chatCache.get(logFile)!, start, end),
      wrapUp: wrapUps.map((m) => ({ t: Date.parse(m[1]), who: m[2], seg: Number(m[3]) })).find((w) => w.who === r.character && w.seg === r.segment && w.t >= start && w.t <= end)?.t ?? null }, minStretch);
  });
}

const pct = (n: number, d: number): string => `${d ? Math.round((n / d) * 100) : 0}%`;
const mmss = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function formatReport(reports: readonly SegmentReport[], top = 8): string {
  const out: string[] = [];
  const sum = (key: 'totals' | 'play') => {
    const t = Object.fromEntries(ACTIVITIES.map((a) => [a, 0])) as Record<Activity, number>;
    for (const r of reports) for (const a of ACTIVITIES) t[a] += r[key][a];
    return t;
  };
  const row = (label: string, t: Record<Activity, number>): string => {
    const total = ACTIVITIES.reduce((a, k) => a + t[k], 0);
    const visible = [...VISIBLE].reduce((a, k) => a + t[k], 0);
    return `${label.padEnd(26)} ${mmss(total * 1000).padStart(6)}  visible ${pct(visible, total).padStart(4)} | ${ACTIVITIES.map((a) => `${a} ${pct(t[a], total)}`).join('  ')}`;
  };
  out.push('Per segment, start to wrap-up (the play):');
  for (const r of reports) out.push(row(`${r.character} #${r.segment}`, r.play));
  out.push(row('all', sum('play')), '', 'Whole segments (with the wrap-up):');
  for (const r of reports) out.push(row(`${r.character} #${r.segment}`, r.totals));
  out.push(row('all', sum('totals')), '');
  // The two players of each segment together (a viewer watches both windows).
  const bySeg = new Map<number, SegmentReport[]>();
  for (const r of reports) bySeg.set(r.segment, [...(bySeg.get(r.segment) ?? []), r]);
  for (const [seg, rs] of bySeg) {
    if (rs.length !== 2) continue;
    const p = pairDeadAir(rs[0], rs[1]);
    out.push(`Segment ${seg}, both players idle at once: ${mmss(p.bothIdle * 1000)} of ${mmss(p.overlap * 1000)} (${pct(p.bothIdle, p.overlap)})`);
  }
  out.push('');
  const causes: Record<string, number> = {};
  for (const r of reports) for (const [k, v] of Object.entries(r.causes)) causes[k] = (causes[k] ?? 0) + v;
  const deadPlay = reports.reduce((a, r) => a + r.play.waiting + r.play.tools + r.play.thinking + r.play.stuck, 0);
  out.push(`Dead air before the wrap-up: ${mmss(deadPlay * 1000)}; in stretches of 10 s or more, by cause:`);
  for (const [k, v] of Object.entries(causes).sort((a, b) => b[1] - a[1])) out.push(`  ${mmss(v * 1000).padStart(6)}  ${k}`);
  out.push('', 'The model between calls (a result to its next call):');
  for (const r of reports) out.push(`  ${r.character} #${r.segment}: ${r.thinkGaps.count} gaps, median ${(r.thinkGaps.medianMs / 1000).toFixed(1)} s, p90 ${(r.thinkGaps.p90Ms / 1000).toFixed(1)} s, total ${mmss(r.thinkGaps.totalMs)}`);
  out.push('', 'Waits that slept on after the partner spoke (count, seconds slept after the line):');
  for (const r of reports) out.push(`  ${r.character} #${r.segment}: ${r.missedWakes.count}, ${mmss(r.missedWakes.seconds * 1000)}`);
  out.push('', 'Tool time (calls, total):');
  for (const r of reports) out.push(`  ${r.character} #${r.segment}: ${Object.entries(r.toolTime).sort((a, b) => b[1].totalMs - a[1].totalMs).map(([k, v]) => `${k} ${v.count}× ${mmss(v.totalMs)}`).join(', ')}`);
  for (const r of reports) {
    out.push('', `${r.character} #${r.segment}: longest dead-air stretches (time into the segment, wall clock)`);
    for (const s of [...r.stretches].sort((a, b) => b.seconds - a.seconds).slice(0, top)) {
      out.push(`  ${mmss(s.start - r.start)}–${mmss(s.end - r.start)} (${new Date(s.start).toISOString().slice(11, 19)}Z) ${s.seconds} s [${s.cause}]  wait ${s.waiting} s, tools ${s.tools} s, thinking ${s.thinking} s${s.stuck ? `, stuck ${s.stuck} s` : ''}`);
      for (const t of s.said.slice(0, 2)) out.push(`      says: ${t}`);
      for (const c of s.commands.slice(0, 4)) out.push(`      ${c}`);
    }
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = args.find((a, i) => !a.startsWith('--') && !['--logs', '--top', '--min'].includes(args[i - 1] ?? ''));
  if (!dir) {
    console.error('usage: npx tsx tools/stream/dead-air.ts <stream-dir> [--logs <dir>] [--top 8] [--min 10] [--json]');
    process.exit(2);
  }
  const reports = analyzeRun(dir, opt('--logs'), Number(opt('--min') ?? 10));
  console.log(args.includes('--json') ? JSON.stringify(reports, null, 2) : formatReport(reports, Number(opt('--top') ?? 8)));
}
