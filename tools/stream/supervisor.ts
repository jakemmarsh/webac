/**
 * Stream supervisor: keeps AI-played characters playing for a stream with no human or lead session launching runs.
 *
 *   npx tsx tools/stream/supervisor.ts [run] [--config tools/stream/cast.json]
 *   npx tsx tools/stream/supervisor.ts stop        (or touch $TMPDIR/acjs-agent/stream/STOP, or Ctrl-C the supervisor)
 *   npx tsx tools/stream/supervisor.ts stop --at-segment-end   (each character finishes its segment first: restarts)
 *   npx tsx tools/stream/supervisor.ts status
 *
 * For each character in the cast it starts the ac-agent daemon if none is running (or, for a public server, attaches
 * to the tab the human logged in), then plays it as a headless Claude Code session (`claude -p`, stream-json in and
 * out) in segments: the shared brief + personality as the appended system prompt, the journal and last report as the
 * opening message. A segment ends at its time (the player is told to wrap up), on a crash, or when the player stops
 * early and won't continue; the next one starts with the journal so the story goes on. Stopping tells each player to
 * say goodbye, ends the sessions and logs every character out (Jake: "you should always log out if you stop
 * controlling them"). A stop at the segment end (the STOP file's `segment-end` mode) instead lets each running
 * segment reach its own wrap-up and report, then logs that character out instead of starting the next segment.
 *
 * It writes the stream's event feed (feed-events.ts) to $TMPDIR/acjs-agent/stream/feed.jsonl, each segment's usage
 * to segments.jsonl, each player's final report to reports/, its raw stream-json to sessions/, and its own log to
 * supervisor.log. Docs: docs/agent-play.md "Streaming".
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AgentItem, AgentSpell, AgentVitals } from '../../packages/renderer/src/agent/types.ts';
import { AgentClient } from '../ac-agent/client.ts';
import { formatJournal, loadJournal } from '../ac-agent/journal.ts';
import { STATE_DIR, logFile, pidAlive, readInfo } from '../ac-agent/state.ts';
import { type CharacterConfig, type StreamConfig, parseStreamConfig } from './config.ts';
import { type ChatParseState, FeedWriter, FileTail, type SegmentUsage, addUsage, feedPath, parseChatLine, parseStreamJsonLine, statusDraft } from './feed.ts';
import { type SegmentRecord, QUIET_TOOLS, afterTurn, dayUsage, endReason, localDay, nextSegment, quietNudge } from './policy.ts';
import { loadOwnTime } from './own-time.ts';
import { preparePlayerDir } from './player.ts';
import { type TableSpell, loadSpellTableRows } from './spellGaps.ts';
import { StuckWatch, classifyResult, isBusyChatLine } from './stuck.ts';
import { TOOLS } from '../ac-agent/tools.ts';
import { type SessionTally, clipReport, nudgeMessage, quietMessage, readinessBrief, sessionSoFar, playerToolNames, segmentOpening, streamEndingMessage, systemPrompt, userLine, wrapUpMessage } from './prompt.ts';

export const STREAM_DIR = join(STATE_DIR, 'stream');
export const STOP_FILE = join(STREAM_DIR, 'STOP');
/** The running supervisor's lock: its pid and start, and (since the boundary stop) its live state (LiveState). */
export const LOCK_FILE = join(STREAM_DIR, 'supervisor.json');

/**
 * How a stop was asked for. `now`: each player is told the stream is ending and says goodbye at once. `segment-end`:
 * each character's running segment runs to its normal end (wrap-up, report), then the character is logged out instead
 * of starting the next one; a character between segments stops at once.
 */
export type StopMode = 'now' | 'segment-end';

/**
 * The STOP file's contents. A plain stop writes a timestamp (or the file is merely touched): `now`. A boundary stop
 * writes `segment-end <iso>` on its first line.
 */
export function parseStopFile(text: string): StopMode {
  return /^\s*segment-end\b/.test(text) ? 'segment-end' : 'now';
}

export function stopFileText(mode: StopMode, nowMs: number): string {
  const at = new Date(nowMs).toISOString();
  return mode === 'segment-end' ? `segment-end ${at}\n` : `${at}\n`;
}

/** A running segment's clock, as the supervisor publishes it in its lock file. */
export interface LiveSegment { segment: number; startedAt: string; wrapUpAt: string; endsBy: string }

/** The supervisor's live state (written into LOCK_FILE): each character's running segment, or why it halted. */
export interface LiveState {
  stopMode: StopMode | null;
  characters: Array<{ profile: string; character: string; segment: LiveSegment | null; halted: string | null }>;
}

const hhmm = (iso: string): string => `${iso.slice(11, 16)}Z`;

/** When each character will stop under a boundary stop, one line each. */
export function boundaryPlanLines(state: LiveState): string[] {
  return state.characters.map((c) => {
    if (c.halted) return `${c.character}: already done for now (${c.halted})`;
    if (!c.segment) return `${c.character}: between segments: stops at once`;
    const s = c.segment;
    return `${c.character}: segment ${s.segment} (started ${hhmm(s.startedAt)}) gets its wrap-up at ${hhmm(s.wrapUpAt)} and ends by ${hhmm(s.endsBy)} at the latest`;
  });
}

/** What `supervisor.ts stop [--at-segment-end]` does: what to write to the STOP file (null: nothing), and what to say. */
export function stopCommand(o: { atSegmentEnd: boolean; alive: { pid: number; live?: LiveState } | null; current: StopMode | null; nowMs: number }): { write: string | null; lines: string[] } {
  if (!o.atSegmentEnd) {
    return {
      write: stopFileText('now', o.nowMs),
      lines: [o.alive ? `asked the supervisor (pid ${o.alive.pid}) to stop; it logs everyone out within a few minutes` : `no supervisor running; left ${STOP_FILE} (removed at the next start)`],
    };
  }
  if (!o.alive) return { write: null, lines: ['no supervisor running; nothing to stop'] };
  // A supervisor from before this mode reads any STOP file as "stop now": the very mid-fight wrap-up this avoids.
  if (!o.alive.live) return { write: null, lines: [`the running supervisor (pid ${o.alive.pid}) predates --at-segment-end and would stop at once; nothing written. Use a plain \`stop\` when a mid-segment stop is acceptable.`] };
  if (o.current === 'now') return { write: null, lines: [`an immediate stop is already pending (pid ${o.alive.pid}); left as it is`] };
  return {
    write: stopFileText('segment-end', o.nowMs),
    lines: [
      `asked the supervisor (pid ${o.alive.pid}) to stop at each character's segment end; it logs each one out then, and exits after the last`,
      ...boundaryPlanLines(o.alive.live).map((l) => `  ${l}`),
      'a plain `stop` still ends everything now',
    ],
  };
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A running player session: its stdout lines, its stdin, and how it ended. */
export interface PlayerProcess {
  lines: AsyncIterable<string>;
  send(text: string): void;
  endInput(): void;
  kill(): void;
  exit: Promise<number | null>;
}

export interface DaemonState { ready: boolean; attached: boolean }

/** Everything the supervisor touches outside itself, so tests run it with fakes (no claude, no browser, no daemon). */
export interface SupervisorDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How often a running segment checks its clock and the stop flag (ms). */
  tickMs: number;
  spawnPlayer(args: string[], env: Record<string, string>, name: string): PlayerProcess;
  /** `npx tsx tools/ac-agent/cli.ts <args…>` */
  runCli(args: string[]): Promise<{ code: number; out: string }>;
  /** The daemon's /status, or null when none runs for the profile. */
  daemonStatus(profile: string): Promise<DaemonState | null>;
  /** The daemon's read-only /vitals (null outside the world or with no daemon). */
  vitals(profile: string): Promise<AgentVitals | null>;
  /**
   * The character's inventory through the daemon (the agent API's `inventory`, a read: it never takes the agent's
   * chat), for the opening message's readiness block; null when it can't be read.
   */
  inventory(profile: string): Promise<AgentItem[] | null>;
  /** The character sheet text (the agent API's `characterSheet`, a read), for unspent XP and skill credits; null when unreadable. */
  characterSheet(profile: string): Promise<string | null>;
  /** The character's known spells (the agent API's `spells`, a read like inventory), for the readiness spells line; null when unreadable. */
  spells?(profile: string): Promise<AgentSpell[] | null>;
  /** The era's DAT spell table (name, school, power), for the spells line's family names; null when the DAT isn't there. */
  spellTable?(): Promise<TableSpell[] | null>;
  /**
   * Where the character's time went in its previous segment (own-time.ts loadOwnTime: travel, fights, buffs, trips, XP per
   * hour by spot, waiting, refused casts, time apart), for the opening; null when there is no previous segment.
   */
  ownTime?(profile: string, character: string, cast: readonly string[]): string | null;
  /** One agent-API call through the daemon (the stop flow's logout of an attached tab). */
  callAgent(profile: string, method: string, args?: unknown[]): Promise<unknown>;
  journal(profile: string): string;
  brief(): string;
  /** New lines of the profile's chat log since the last call. */
  chatLines(profile: string): string[];
  /** Whether a stop was asked for and how (the STOP file): true or 'now' stops at once, 'segment-end' at each segment's end. */
  stopRequested(): boolean | StopMode | null;
  /** Publish the live state (each character's running segment) for `status` and `stop --at-segment-end`. */
  liveState?(state: LiveState): void;
  feed: FeedWriter;
  segments: { read(): SegmentRecord[]; append(r: SegmentRecord): void };
  /** Keep the player's final report; returns where. */
  saveReport(profile: string, segment: number, text: string): string | null;
  /** Keep a player's raw stream-json line. */
  rawLine(profile: string, segment: number, line: string): void;
  log(msg: string): void;
}

/** The `claude` command line for one player segment (the prompt itself goes in on stdin as stream-json). */
export function claudeArgs(cfg: StreamConfig, c: CharacterConfig, system: string, name: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', c.model,
    '--name', name,
    '--append-system-prompt', system,
    '--tools', cfg.tools.join(','),
    '--permission-mode', cfg.permissionMode,
    ...(cfg.allowedTools.length ? ['--allowedTools', ...cfg.allowedTools] : []),
    ...(cfg.disallowedTools.length ? ['--disallowedTools', ...cfg.disallowedTools] : []),
    // No MCP servers (the repo's `ac` server runs an older build; the account's connectors aren't for players).
    '--strict-mcp-config',
    '--no-chrome',
    // No skills or slash commands: a player has no use for the account's coding skills, and their list costs context.
    '--disable-slash-commands',
    ...(c.effort ? ['--effort', c.effort] : []),
    ...(cfg.segment.budgetUsd !== null ? ['--max-budget-usd', String(cfg.segment.budgetUsd)] : []),
    ...cfg.extraArgs,
  ];
}

/**
 * The player session's environment. It runs in its own directory (tools/stream/player.ts), and these keep the rest of
 * Claude Code's per-turn context out: no CLAUDE.md files (the account's own ~/.claude/CLAUDE.md loads from any
 * directory), no auto-memory (its instructions and index), and a compact window that bounds each turn's re-read.
 */
export function playerEnv(cfg: StreamConfig, c: CharacterConfig): Record<string, string> {
  return {
    AC_AGENT_PROFILE: c.profile,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Claude Code's own "The user hasn't heard from you in a while" reminder came every few silent turns, during long
    // walks too (Arcanist, 2026-10-16); the supervisor's quiet nudge asks only when nothing of theirs is running.
    ...(cfg.segment.quietNudgeSeconds !== null ? { CLAUDE_CODE_SILENT_TURN_REMINDER: '0' } : {}),
    ...(cfg.segment.autoCompactTokens !== null ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(cfg.segment.autoCompactTokens) } : {}),
  };
}

/**
 * A segment's end for viewers: why, how long, how many tokens. No dollar figure: `claude -p` reports an API-price
 * estimate even when the players run on a claude.ai subscription, where nothing is billed per token (2026-10-15).
 */
export function segmentDetail(reason: string, minutes: number, usage: SegmentUsage | null): string {
  const bits = [`${reason} after ${minutes.toFixed(1)} min`];
  if (usage) bits.push(`${Math.round((usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens) / 1000)}k tokens`);
  return bits.join(', ');
}

/** `cli.ts start` arguments for a character with no daemon running. */
export function startArgs(c: CharacterConfig): string[] {
  const a = ['start', `profile=${c.profile}`, `character=${c.character}`];
  if (c.attach) a.push(`attach=${c.attach.endpoint}`);
  else {
    if (c.era) a.push(`era=${c.era}`);
    if (c.headless) a.push('headless=true');
  }
  return a;
}

interface Active { proc: PlayerProcess; c: CharacterConfig }

export class StreamSupervisor {
  stopping = false;
  /** A boundary stop is pending: no new segment starts; running ones end on their own clock. */
  stopAtBoundary = false;
  /** Each character's running segment (its number and start), for the live state. */
  private live = new Map<string, { segment: number; startMs: number }>();
  private stopWaiters: Array<() => void> = [];
  private active = new Map<string, Active>();
  private restarting = new Set<string>();
  private chatState = new Map<string, ChatParseState>();
  /** Spell words the cast has spoken (feed.ts isIncantation), shared so each is known from either log. */
  private incantations = new Set<string>();
  /** Each profile's deaths and level-ups since this session's session-start (the feed's own events). */
  private tally = new Map<string, SessionTally>();
  readonly halted = new Map<string, string>();
  /** Each character's stuck watch (stuck.ts): the server has stopped playing it. */
  private stuck = new Map<string, StuckWatch>();
  /** Each character's running task as the last status poll read it (null: none; absent: unknown), and when. */
  private tasks = new Map<string, { task: string | null; at: number }>();

  constructor(readonly cfg: StreamConfig, readonly deps: SupervisorDeps) {}

  private partnerOf(c: CharacterConfig): string {
    const others = this.cfg.characters.filter((o) => o !== c).map((o) => o.character);
    return others.length ? others.join(' and ') : 'nobody (you play alone this time)';
  }

  private watch(profile: string): StuckWatch | null {
    if (this.cfg.stuckMinutes <= 0) return null;
    let w = this.stuck.get(profile);
    if (!w) { w = new StuckWatch(this.cfg.stuckMinutes); this.stuck.set(profile, w); }
    return w;
  }

  requestStop(why: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.deps.log(`stopping: ${why}`);
    for (const w of this.stopWaiters.splice(0)) w();
    this.publishLive();
  }

  /**
   * Stop at the segment boundary: no character starts another segment; each running one runs to its own wrap-up and
   * report, then that character is logged out. A character between segments stops at once (its pause is cut short).
   * A later plain stop (requestStop) still ends everything at once.
   */
  requestBoundaryStop(why: string): void {
    if (this.stopping || this.stopAtBoundary) return;
    this.stopAtBoundary = true;
    this.deps.log(`stopping at each segment's end: ${why}`);
    for (const l of boundaryPlanLines(this.liveState())) this.deps.log(`  ${l}`);
    for (const w of this.stopWaiters.splice(0)) w();
    this.publishLive();
  }

  /** No new segment may start (either stop). */
  private get halting(): boolean { return this.stopping || this.stopAtBoundary; }

  liveState(): LiveState {
    const { cfg } = this;
    return {
      stopMode: this.stopping ? 'now' : this.stopAtBoundary ? 'segment-end' : null,
      characters: cfg.characters.map((c) => {
        const l = this.live.get(c.profile);
        const deadline = l ? l.startMs + cfg.segment.minutes * 60_000 : 0;
        return {
          profile: c.profile, character: c.character, halted: this.halted.get(c.profile) ?? null,
          segment: l ? {
            segment: l.segment,
            startedAt: new Date(l.startMs).toISOString(),
            wrapUpAt: new Date(deadline).toISOString(),
            // runSegment's hard deadline: the wrap-up time and a minute after the segment's time.
            endsBy: new Date(deadline + cfg.segment.wrapUpMinutes * 60_000 + 60_000).toISOString(),
          } : null,
        };
      }),
    };
  }

  private publishLive(): void {
    try { this.deps.liveState?.(this.liveState()); } catch (e) { this.deps.log(`live state: ${(e as Error).message}`); }
  }

  /** Sleep that a stop cuts short (with `betweenSegments`, a boundary stop too). */
  private async pause(ms: number, betweenSegments = false): Promise<void> {
    if (this.stopping || (betweenSegments && this.stopAtBoundary) || ms <= 0) return;
    await Promise.race([this.deps.sleep(ms), new Promise<void>((r) => this.stopWaiters.push(r))]);
  }

  /** Run the stream until stopped (or every character halts), then log everyone out. */
  async run(): Promise<void> {
    const { deps } = this;
    deps.feed.write({ type: 'session-start', title: this.cfg.characters.map((c) => c.character).join(' & ') });
    this.publishLive();
    let playing = true;
    const watcher = (async () => {
      let lastStatus = 0;
      while (playing) {
        const asked = deps.stopRequested();
        if (asked === true || asked === 'now') this.requestStop('stop requested');
        else if (asked === 'segment-end') this.requestBoundaryStop('stop at segment end requested');
        this.pumpChat();
        if (deps.now() - lastStatus >= this.cfg.statusEverySeconds * 1000) {
          lastStatus = deps.now();
          await this.pollStatus();
        }
        await deps.sleep(1000);
      }
    })();
    await Promise.all(this.cfg.characters.map((c) => this.runCharacter(c).catch((e) => deps.log(`${c.character}: ${(e as Error)?.stack ?? e}`))));
    // Every loop has ended (stopped or halted): log out whoever is still in the world.
    for (const c of this.cfg.characters) await this.logOut(c);
    this.pumpChat();
    playing = false;
    await watcher;
    const detail = this.stopping ? 'stopped; everyone logged out'
      : this.stopAtBoundary ? 'stopped at the segment ends; everyone logged out'
        : `every character halted (${[...this.halted.values()].join('; ')})`;
    deps.feed.write({ type: 'segment-end', title: 'Stream over', detail });
  }

  /** Feed the new chat lines of every character. */
  pumpChat(): void {
    const cast = this.cfg.characters.map((c) => c.character);
    for (const c of this.cfg.characters) {
      const st = this.chatState.get(c.profile) ?? { incantations: this.incantations };
      this.chatState.set(c.profile, st);
      for (const line of this.deps.chatLines(c.profile)) {
        if (isBusyChatLine(line)) this.watch(c.profile)?.refused("You're too busy!", Date.parse(line.slice(0, line.indexOf(' '))) || this.deps.now());
        for (const { t, draft } of parseChatLine(line, c.profile, c.character, cast, st)) {
          this.deps.feed.write(draft, t);
          if (draft.type === 'death' || draft.type === 'level-up') {
            const tl = this.tally.get(c.profile) ?? { deaths: [], levels: [] };
            this.tally.set(c.profile, tl);
            if (draft.type === 'death') tl.deaths.push(draft.killer ?? null);
            else tl.levels.push(draft.level);
          }
        }
      }
    }
  }

  private async pollStatus(): Promise<void> {
    for (const c of this.cfg.characters) {
      if (this.halted.has(c.profile)) continue;
      const st = await this.deps.daemonStatus(c.profile).catch(() => null);
      if (!st) {
        // The daemon went away under a playing segment (crash, idle logout): bring it back for the player.
        if (this.active.has(c.profile) && !this.stopping && !c.attach) void this.restartDaemon(c);
        continue;
      }
      const vit = await this.deps.vitals(c.profile).catch(() => null);
      if (vit) this.tasks.set(c.profile, { task: vit.task ?? null, at: this.deps.now() });
      else this.tasks.delete(c.profile);
      const v = statusDraft(c.profile, vit);
      if (v) this.deps.feed.write(v);
      const w = this.watch(c.profile);
      if (!w || this.restarting.has(c.profile)) continue;
      w.vitals(vit, this.deps.now());
      const stuck = w.verdict(this.deps.now());
      if (stuck && !this.stopping) void this.relogStuck(c, stuck.why);
    }
  }

  /**
   * The server has stopped playing this character (stuck.ts): log it out and back in, the way the stream starts it
   * (`cli.ts stop`, then `start`), and tell its player. An attached tab is the human's own login, so its player is
   * told instead.
   */
  async relogStuck(c: CharacterConfig, why: string): Promise<void> {
    const { deps } = this;
    if (this.restarting.has(c.profile)) return;
    this.restarting.add(c.profile);
    const tell = (text: string): void => this.active.get(c.profile)?.proc.send(userLine(text));
    try {
      deps.log(`${c.character}: stuck: ${why}`);
      if (c.attach) {
        tell(`[supervisor] Your client looks stuck: ${why}. Only a logout and login clears that; ask the human who logged you in.`);
        deps.feed.write({ type: 'tool', char: c.profile, tool: 'relog', summary: 'is stuck (the server stopped answering); waiting for a relog', ok: false });
        return;
      }
      deps.feed.write({ type: 'tool', char: c.profile, tool: 'relog', summary: 'was stuck (the server stopped answering): logging out and back in' });
      const stop = await deps.runCli(['stop', `profile=${c.profile}`]);
      if (stop.code !== 0) deps.log(`${c.character}: stop failed: ${stop.out.slice(-500)}`);
      const start = await deps.runCli(startArgs(c));
      if (start.code !== 0 || !(await this.waitReady(c))) {
        deps.log(`${c.character}: relog failed: ${start.out.slice(-500)}`);
        return;
      }
      deps.log(`${c.character}: logged out and back in`);
      tell(`[supervisor] Your client was stuck (${why}); you've been logged out and back in. Observe before acting: you may be somewhere else now.`);
    } finally {
      this.watch(c.profile)?.reset(deps.now());
      this.restarting.delete(c.profile);
    }
  }

  private async restartDaemon(c: CharacterConfig): Promise<void> {
    if (this.restarting.has(c.profile)) return;
    this.restarting.add(c.profile);
    try {
      this.deps.log(`${c.character}: daemon gone mid-segment; starting it again`);
      const r = await this.deps.runCli(startArgs(c));
      if (r.code === 0) this.active.get(c.profile)?.proc.send(userLine('[supervisor] Your game session dropped and has been restarted: you are back in the world. Observe before acting.'));
      else this.deps.log(`${c.character}: restart failed: ${r.out.slice(-500)}`);
    } finally {
      this.restarting.delete(c.profile);
    }
  }

  private async ensureDaemon(c: CharacterConfig): Promise<boolean> {
    if (await this.deps.daemonStatus(c.profile).catch(() => null)) return true;
    this.deps.log(`${c.character}: starting its game session (${startArgs(c).join(' ')})`);
    const r = await this.deps.runCli(startArgs(c));
    if (r.code !== 0) this.deps.log(`${c.character}: start failed: ${r.out.slice(-800)}`);
    return r.code === 0;
  }

  /**
   * Until the character is in the world (attached: until the human has logged it in). `betweenSegments`: before a
   * segment, where a boundary stop ends the wait too (a mid-segment relog keeps waiting through one).
   */
  private async waitReady(c: CharacterConfig, betweenSegments = false): Promise<boolean> {
    let said = -Infinity;
    while (!this.stopping && !(betweenSegments && this.stopAtBoundary)) {
      const st = await this.deps.daemonStatus(c.profile).catch(() => null);
      if (!st) return false;
      if (st.ready) return true;
      if (this.deps.now() - said >= 300_000) {
        said = this.deps.now();
        const why = c.attach ? `waiting for ${c.character} to be logged in (attach ${c.attach.endpoint})` : 'waiting for the world';
        this.deps.log(`${c.character}: ${why}`);
      }
      await this.pause(5000, betweenSegments);
    }
    return false;
  }

  async runCharacter(c: CharacterConfig): Promise<void> {
    let segment = 0;
    let quickExits = 0;
    let last: SegmentRecord['reason'] | null = null;
    let lastReport: string | null = null;
    for (;;) {
      const today = dayUsage(this.deps.segments.read(), c.profile, localDay(new Date(this.deps.now())));
      const step = nextSegment({ cfg: this.cfg, stopping: this.halting, segmentsThisRun: segment, quickExits, last, today });
      if (step.action === 'halt') {
        if (this.stopAtBoundary && !this.stopping) await this.stopAtSegmentEnd(c);
        else if (!this.stopping) {
          this.halted.set(c.profile, step.why);
          this.deps.log(`${c.character}: halted: ${step.why}`);
          this.deps.feed.write({ type: 'segment-end', char: c.profile, title: `${c.character} is done for now`, detail: step.why });
          this.publishLive();
          await this.logOut(c);
        }
        return;
      }
      await this.pause(step.delayMs, true);
      if (this.halting) { await this.stopAtSegmentEnd(c); return; }
      if (!(await this.ensureDaemon(c)) || !(await this.waitReady(c, true))) {
        if (this.halting) { await this.stopAtSegmentEnd(c); return; }
        quickExits++;
        last = 'crashed';
        continue;
      }
      if (this.halting) { await this.stopAtSegmentEnd(c); return; }
      segment++;
      const rec = await this.runSegment(c, segment, lastReport);
      this.deps.segments.append(rec);
      if (rec.finalText.trim()) {
        lastReport = rec.finalText;
        const at = this.deps.saveReport(c.profile, segment, rec.finalText);
        if (at) this.deps.log(`${c.character}: segment ${segment} report: ${at}`);
      }
      last = rec.reason;
      quickExits = rec.reason !== 'stopping' && rec.minutes < this.cfg.segment.quickExitMinutes ? quickExits + 1 : 0;
    }
  }

  /**
   * A boundary stop reached this character between segments: log it out now rather than leave it standing in the
   * world until the others' segments end (a plain stop logs everyone out at the end of run()).
   */
  private async stopAtSegmentEnd(c: CharacterConfig): Promise<void> {
    if (this.stopping || !this.stopAtBoundary) return;
    this.deps.log(`${c.character}: stopped at the segment boundary; logging out`);
    this.deps.feed.write({ type: 'segment-end', char: c.profile, title: `${c.character} is done for now`, detail: 'the stream is stopping at the segment end' });
    await this.logOut(c);
  }

  /** One headless Claude Code session playing `c`, from its opening message until it ends. */
  async runSegment(c: CharacterConfig, segment: number, lastReport: string | null): Promise<SegmentRecord> {
    const { deps, cfg } = this;
    const partner = this.partnerOf(c);
    // What the opening says beside the journal: this character's readiness (gear gaps, unspent XP, kits and potions)
    // and the session's deaths and levels.
    this.pumpChat(); // the latest deaths and level-ups into the tally
    const readiness = readinessBrief({
      items: await deps.inventory(c.profile).catch(() => null),
      sheet: await deps.characterSheet(c.profile).catch(() => null),
      spells: await deps.spells?.(c.profile).catch(() => null) ?? null,
      table: await deps.spellTable?.().catch(() => null) ?? null,
      session: sessionSoFar(cfg.characters.map((o) => ({ character: o.character, tally: this.tally.get(o.profile) }))),
    });
    let ownTime: string | null = null;
    try { ownTime = deps.ownTime?.(c.profile, c.character, cfg.characters.map((o) => o.character)) ?? null; } catch (e) { deps.log(`${c.character}: own time: ${(e as Error).message}`); }
    const startMs = deps.now();
    const deadline = startMs + cfg.segment.minutes * 60_000;
    const hardDeadline = deadline + cfg.segment.wrapUpMinutes * 60_000 + 60_000;
    const name = `stream: ${c.character} #${segment}`;
    const proc = deps.spawnPlayer(claudeArgs(cfg, c, systemPrompt(deps.brief(), c, partner), name), playerEnv(cfg, c), name);
    this.active.set(c.profile, { proc, c });
    this.live.set(c.profile, { segment, startMs });
    this.publishLive();
    deps.log(`${c.character}: segment ${segment} started (${c.model}, ${cfg.segment.minutes} min)`);
    deps.feed.write({ type: 'segment-start', char: c.profile, title: `${c.character}: segment ${segment}`, detail: `${c.model}, ${cfg.segment.minutes} min` });
    proc.send(userLine(segmentOpening({ c, partner, segment, nowMs: startMs, playMinutes: cfg.segment.minutes, journal: deps.journal(c.profile), lastReport, readiness, ownTime })));

    const names = new Map<string, string>();
    const callTools = new Map<string, string[]>();
    let usage: SegmentUsage | null = null;
    let sessionId: string | null = null;
    let model = c.model;
    let finalText = '';
    let sawResult = false;
    let resultSubtype: string | undefined;
    let wrapUpSent = false;
    let stopSentAt: number | null = null;
    let inputClosed = false;
    let killed = false;
    let nudges = 0;
    // The quiet nudge (policy.ts quietNudge): when the player last spoke or acted, or had a task running.
    let inTurn = true;
    let lastActive = startMs;
    let lastQuietNudge = -Infinity;
    this.tasks.delete(c.profile);

    // stdout lines into a queue the loop below reads between clock ticks.
    const queue: string[] = [];
    let eof = false;
    const wake: { fn: (() => void) | null } = { fn: null };
    void (async () => {
      try { for await (const l of proc.lines) { queue.push(l); wake.fn?.(); } } finally { eof = true; wake.fn?.(); }
    })();
    const nextEvent = (): Promise<void> => (queue.length || eof ? Promise.resolve() : Promise.race([new Promise<void>((r) => (wake.fn = r)), deps.sleep(deps.tickMs)]));

    const closeInput = (): void => { if (!inputClosed) { inputClosed = true; proc.endInput(); } };
    while (!(eof && !queue.length)) {
      await nextEvent();
      wake.fn = null;
      while (queue.length) {
        const line = queue.shift()!;
        deps.rawLine(c.profile, segment, line);
        const o = parseStreamJsonLine(line, c.profile, names);
        for (const d of o.drafts) deps.feed.write(d);
        for (const k of o.calls ?? []) callTools.set(k.id, k.tools);
        if (o.drafts.some((d) => d.type === 'narration') || (o.calls ?? []).some((k) => k.tools.some((t) => !QUIET_TOOLS.has(t)))) lastActive = deps.now();
        for (const r of o.results ?? []) {
          const tools = callTools.get(r.id);
          if (!tools) continue;
          callTools.delete(r.id);
          const kind = classifyResult(tools, r.text);
          if (kind === 'refused') this.watch(c.profile)?.refused(`${tools.join('+')}: ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`, deps.now());
          else if (kind === 'ok') this.watch(c.profile)?.answered();
        }
        if (o.init) { sessionId = o.init.sessionId || sessionId; model = o.init.model ?? model; }
        if (o.result) {
          sawResult = true;
          usage = addUsage(usage, o.result.usage);
          resultSubtype = o.result.subtype;
          if (o.result.text.trim()) finalText = o.result.text;
          const next = afterTurn({ nowMs: deps.now(), deadlineMs: deadline, stopping: this.stopping || stopSentAt !== null, wrapUpSent, nudges, maxNudges: cfg.segment.maxNudges, resultSubtype });
          inTurn = false;
          if (next === 'nudge' && !inputClosed) {
            inTurn = true;
            lastActive = deps.now();
            nudges++;
            deps.log(`${c.character}: turn ended with ${Math.round((deadline - deps.now()) / 60_000)} min left; nudge ${nudges}`);
            proc.send(userLine(nudgeMessage((deadline - deps.now()) / 60_000, partner)));
          } else closeInput();
        }
      }
      if (eof) break;
      const now = deps.now();
      const seen = this.tasks.get(c.profile);
      if (seen?.task) lastActive = Math.max(lastActive, seen.at);
      const quietMs = cfg.segment.quietNudgeSeconds === null ? null : cfg.segment.quietNudgeSeconds * 1000;
      if (!inputClosed && quietNudge({ nowMs: now, quietMs, inTurn, wrapUpSent, stopping: this.stopping || stopSentAt !== null, lastActiveMs: lastActive, lastNudgeMs: lastQuietNudge, task: seen ? seen.task : undefined })) {
        lastQuietNudge = now;
        deps.log(`${c.character}: quiet ${Math.round((now - lastActive) / 1000)} s with nothing running; asked what they're doing`);
        proc.send(userLine(quietMessage((now - lastActive) / 60_000)));
      }
      if (this.stopping && stopSentAt === null && !inputClosed) {
        stopSentAt = now;
        proc.send(userLine(streamEndingMessage(cfg.stopGraceSeconds)));
      }
      if (!wrapUpSent && !inputClosed && now >= deadline && stopSentAt === null) {
        wrapUpSent = true;
        deps.log(`${c.character}: segment ${segment}: wrap-up sent`);
        proc.send(userLine(wrapUpMessage(cfg.segment.wrapUpMinutes)));
      }
      const overStop = stopSentAt !== null && now - stopSentAt >= cfg.stopGraceSeconds * 1000;
      if (!killed && (now >= hardDeadline || overStop)) {
        killed = true;
        deps.log(`${c.character}: segment ${segment}: ending the session (${overStop ? 'stop grace over' : 'wrap-up time over'})`);
        closeInput();
        proc.kill();
      }
    }
    const exitCode = await proc.exit;
    this.active.delete(c.profile);
    this.live.delete(c.profile);
    this.publishLive();
    const endMs = deps.now();
    const reason = endReason({ stopping: this.stopping, wrapUpSent, killed, sawResult, exitCode, resultSubtype });
    const minutes = (endMs - startMs) / 60_000;
    deps.feed.write({ type: 'segment-end', char: c.profile, title: `${c.character}: segment ${segment}`, detail: segmentDetail(reason, minutes, usage) });
    deps.log(`${c.character}: segment ${segment} ended: ${reason} after ${minutes.toFixed(1)} min${usage?.costUsd != null ? `, $${usage.costUsd.toFixed(2)} API-equivalent` : ''}${exitCode ? ` (exit ${exitCode})` : ''}`);
    return {
      profile: c.profile, character: c.character, segment, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
      minutes, reason, model, sessionId, usage, finalText: clipReport(finalText, 20_000),
    };
  }

  /** Log a character out and stop its daemon (an attached tab is logged out first unless logoutOnStop is false). */
  async logOut(c: CharacterConfig): Promise<void> {
    const { deps } = this;
    const st = await deps.daemonStatus(c.profile).catch(() => null);
    if (!st) return;
    if (c.attach?.logoutOnStop && st.ready) {
      deps.log(`${c.character}: logging out of the attached tab`);
      await deps.callAgent(c.profile, 'logout').catch((e) => deps.log(`${c.character}: logout: ${(e as Error).message}`));
      for (let i = 0; i < 30; i++) {
        const s = await deps.callAgent(c.profile, 'status').catch(() => null) as { screen?: string } | null;
        if (s?.screen === 'character-select') break;
        await deps.sleep(1000);
      }
    }
    deps.log(`${c.character}: cli stop profile=${c.profile}`);
    const r = await deps.runCli(['stop', `profile=${c.profile}`]);
    if (r.code !== 0) deps.log(`${c.character}: stop failed: ${r.out.slice(-500)}`);
  }
}

// ── the real world ──

/** The players' working directories (one per profile, with its `./ac` and `./world-query`: tools/stream/player.ts). */
export const PLAYER_ROOT = join(STREAM_DIR, 'player');

function realPlayer(bin: string, args: string[], env: Record<string, string>): PlayerProcess {
  const { dir } = preparePlayerDir(PLAYER_ROOT, REPO, env.AC_AGENT_PROFILE);
  const child = spawn(bin, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout! });
  child.stderr!.on('data', (d) => appendFileSync(join(STREAM_DIR, 'supervisor.log'), `[claude ${env.AC_AGENT_PROFILE}] ${d}`));
  child.stdin!.on('error', () => {});
  return {
    lines: rl,
    send: (t) => { if (child.stdin!.writable) child.stdin!.write(t); },
    endInput: () => { child.stdin!.end(); },
    kill: () => {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000).unref();
    },
    exit: new Promise((r) => child.on('exit', (code) => r(code))),
  };
}

function runCliReal(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn('npx', ['tsx', 'tools/ac-agent/cli.ts', ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => res({ code: code ?? 1, out }));
  });
}

export function realDeps(cfg: StreamConfig): SupervisorDeps {
  mkdirSync(join(STREAM_DIR, 'reports'), { recursive: true });
  mkdirSync(join(STREAM_DIR, 'sessions'), { recursive: true });
  const segFile = join(STREAM_DIR, 'segments.jsonl');
  const tails = new Map<string, FileTail>();
  let spellRows: Promise<TableSpell[] | null> | undefined; // read once: the DAT spell table does not change in a run
  const client = (profile: string): AgentClient | null => { const i = readInfo(profile); return i ? new AgentClient(i) : null; };
  const log = (m: string): void => {
    const line = `${new Date().toISOString()} ${m}`;
    appendFileSync(join(STREAM_DIR, 'supervisor.log'), line + '\n');
    console.log(line);
  };
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tickMs: 5000,
    spawnPlayer: (args, env) => realPlayer(cfg.claudeBin, args, env),
    runCli: runCliReal,
    daemonStatus: async (p) => {
      const c = client(p);
      if (!c) return null;
      const s = await c.status().catch(() => null);
      return s ? { ready: !!s.ready, attached: !!s.attached } : null;
    },
    vitals: async (p) => client(p)?.vitals() ?? null,
    inventory: async (p) => { const c = client(p); return c ? c.call<AgentItem[]>('inventory', [], 15_000).catch(() => null) : null; },
    characterSheet: async (p) => { const c = client(p); return c ? c.call<string>('characterSheet', [], 15_000).catch(() => null) : null; },
    spells: async (p) => { const c = client(p); return c ? c.call<AgentSpell[]>('spells', ['', 1000], 15_000).catch(() => null) : null; },
    spellTable: () => (spellRows ??= loadSpellTableRows()),
    ownTime: (p, character, cast) => loadOwnTime({ streamDir: STREAM_DIR, feedFile: feedPath(), profile: p, character, cast, nowMs: Date.now() }),
    callAgent: async (p, m, a = []) => { const c = client(p); if (!c) throw new Error(`no daemon for ${p}`); return c.call(m, a, 15_000); },
    journal: (p) => {
      const i = readInfo(p);
      return i ? formatJournal(loadJournal(i.era ?? 'eor', i.account, i.character)) : '(no session: journal unavailable)';
    },
    brief: () => readFileSync(resolve(REPO, cfg.brief), 'utf8').replaceAll('{{TOOLS}}', playerToolNames(TOOLS.map((t) => t.name))),
    chatLines: (p) => {
      let t = tails.get(p);
      if (!t) { t = new FileTail(logFile(p).replace(/\.log$/, '.chat.log')); tails.set(p, t); }
      return t.read();
    },
    stopRequested: () => {
      if (!existsSync(STOP_FILE)) return null;
      try { return parseStopFile(readFileSync(STOP_FILE, 'utf8')); } catch { return 'now'; }
    },
    liveState: (state) => {
      const lock = existsSync(LOCK_FILE) ? (JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as Record<string, unknown>) : { pid: process.pid, startedAt: new Date().toISOString() };
      writeFileSync(LOCK_FILE, JSON.stringify({ ...lock, live: state }) + '\n');
    },
    feed: new FeedWriter(feedPath()),
    segments: {
      read: () => (existsSync(segFile) ? readFileSync(segFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as SegmentRecord]; } catch { return []; } }) : []),
      append: (r) => appendFileSync(segFile, JSON.stringify(r) + '\n'),
    },
    saveReport: (p, n, text) => {
      const f = join(STREAM_DIR, 'reports', `${p}-${new Date().toISOString().replace(/[:.]/g, '-')}-seg${n}.md`);
      writeFileSync(f, text.trim() + '\n');
      return f;
    },
    rawLine: (p, n, line) => appendFileSync(join(STREAM_DIR, 'sessions', `${p}-${localDay(new Date())}-seg${n}.jsonl`), line + '\n'),
    log,
  };
}

function readConfig(path: string): StreamConfig {
  return parseStreamConfig(JSON.parse(readFileSync(resolve(REPO, path), 'utf8')));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  const ci = argv.indexOf('--config');
  const cfgPath = ci > -1 ? argv[ci + 1] : 'tools/stream/cast.json';
  const lock = LOCK_FILE;
  mkdirSync(STREAM_DIR, { recursive: true });
  const running = existsSync(lock) ? (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; startedAt: string; live?: LiveState }) : null;
  const alive = running && pidAlive(running.pid) ? running : null;
  const pendingStop = (): StopMode | null => (existsSync(STOP_FILE) ? parseStopFile(readFileSync(STOP_FILE, 'utf8')) : null);
  if (cmd === 'stop') {
    const atSegmentEnd = argv.includes('--at-segment-end');
    const unknown = argv.slice(1).filter((a, i, all) => a.startsWith('--') && a !== '--at-segment-end' && a !== '--config' && all[i - 1] !== '--config');
    if (unknown.length) throw new Error(`unknown stop option ${unknown.join(' ')} (stop [--at-segment-end])`);
    const r = stopCommand({ atSegmentEnd, alive, current: pendingStop(), nowMs: Date.now() });
    if (r.write !== null) writeFileSync(STOP_FILE, r.write);
    for (const l of r.lines) console.log(l);
    return;
  }
  if (cmd === 'status') {
    console.log(alive ? `supervisor pid ${alive.pid}, since ${alive.startedAt}` : 'no supervisor running');
    const pending = alive ? pendingStop() : null;
    if (pending === 'now') console.log('stop pending: everyone is wrapping up now');
    if (pending === 'segment-end') {
      console.log(`stop at segment end pending (asked ${readFileSync(STOP_FILE, 'utf8').trim().split(/\s+/)[1] ?? '?'}): no new segments start`);
      if (alive?.live) for (const l of boundaryPlanLines(alive.live)) console.log(`  ${l}`);
    }
    const segFile = join(STREAM_DIR, 'segments.jsonl');
    const recs = existsSync(segFile) ? readFileSync(segFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SegmentRecord) : [];
    const cfg = readConfig(cfgPath);
    for (const c of cfg.characters) {
      const u = dayUsage(recs, c.profile, localDay(new Date()));
      console.log(`${c.character} (${c.profile}): today ${u.segments} segments, ${Math.round(u.minutes)} min, $${u.usd.toFixed(2)} API-equivalent; daemon ${readInfo(c.profile) ? 'running' : 'not running'}`);
    }
    console.log(`feed: ${feedPath()}`);
    return;
  }
  if (cmd !== 'run') throw new Error(`unknown command "${cmd}" (run | stop | status)`);
  if (alive) throw new Error(`a supervisor is already running (pid ${alive.pid}); \`supervisor.ts stop\` first`);
  const cfg = readConfig(cfgPath);
  rmSync(STOP_FILE, { force: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  const sup = new StreamSupervisor(cfg, realDeps(cfg));
  let signals = 0;
  const onSignal = (sig: string): void => {
    signals++;
    if (signals === 1) sup.requestStop(sig);
    else console.log('already stopping: the players are wrapping up and every character will be logged out');
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  try {
    await sup.run();
  } finally {
    rmSync(lock, { force: true });
    rmSync(STOP_FILE, { force: true });
  }
}

if (process.argv[1] && /supervisor\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  });
}
