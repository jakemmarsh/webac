/**
 * Stream supervisor: keeps AI-played characters playing for a stream with no human or lead session launching runs.
 *
 *   npx tsx tools/stream/supervisor.ts [run] [--config tools/stream/cast.json]
 *   npx tsx tools/stream/supervisor.ts stop        (or touch $TMPDIR/acjs-agent/stream/STOP, or Ctrl-C the supervisor)
 *   npx tsx tools/stream/supervisor.ts status
 *
 * For each character in the cast it starts the ac-agent daemon if none is running (or, for a public server, attaches
 * to the tab the human logged in), then plays it as a headless Claude Code session (`claude -p`, stream-json in and
 * out) in segments: the shared brief + personality as the appended system prompt, the journal and last report as the
 * opening message. A segment ends at its time (the player is told to wrap up), on a crash, or when the player stops
 * early and won't continue; the next one starts with the journal so the story goes on. Stopping tells each player to
 * say goodbye, ends the sessions and logs every character out (Jake: "you should always log out if you stop
 * controlling them").
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
import { type SegmentRecord, afterTurn, dayUsage, endReason, localDay, nextSegment } from './policy.ts';
import { preparePlayerDir } from './player.ts';
import { type TableSpell, loadSpellTableRows } from './spellGaps.ts';
import { StuckWatch, classifyResult, isBusyChatLine } from './stuck.ts';
import { TOOLS } from '../ac-agent/tools.ts';
import { type SessionTally, clipReport, nudgeMessage, readinessBrief, sessionSoFar, playerToolNames, segmentOpening, streamEndingMessage, systemPrompt, userLine, wrapUpMessage } from './prompt.ts';

export const STREAM_DIR = join(STATE_DIR, 'stream');
export const STOP_FILE = join(STREAM_DIR, 'STOP');
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
  /** One agent-API call through the daemon (the stop flow's logout of an attached tab). */
  callAgent(profile: string, method: string, args?: unknown[]): Promise<unknown>;
  journal(profile: string): string;
  brief(): string;
  /** New lines of the profile's chat log since the last call. */
  chatLines(profile: string): string[];
  stopRequested(): boolean;
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
    ...(cfg.segment.autoCompactTokens !== null ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(cfg.segment.autoCompactTokens) } : {}),
  };
}

/** A segment's end for viewers: why, how long, what it cost. */
export function segmentDetail(reason: string, minutes: number, usage: SegmentUsage | null): string {
  const bits = [`${reason} after ${minutes.toFixed(1)} min`];
  if (usage?.costUsd != null) bits.push(`$${usage.costUsd.toFixed(2)}`);
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
  }

  /** Sleep that a stop cuts short. */
  private async pause(ms: number): Promise<void> {
    if (this.stopping || ms <= 0) return;
    await Promise.race([this.deps.sleep(ms), new Promise<void>((r) => this.stopWaiters.push(r))]);
  }

  /** Run the stream until stopped (or every character halts), then log everyone out. */
  async run(): Promise<void> {
    const { deps } = this;
    deps.feed.write({ type: 'session-start', title: this.cfg.characters.map((c) => c.character).join(' & ') });
    let playing = true;
    const watcher = (async () => {
      let lastStatus = 0;
      while (playing) {
        if (deps.stopRequested()) this.requestStop('stop requested');
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
    deps.feed.write({ type: 'segment-end', title: 'Stream over', detail: this.stopping ? 'stopped; everyone logged out' : `every character halted (${[...this.halted.values()].join('; ')})` });
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

  /** Until the character is in the world (attached: until the human has logged it in). */
  private async waitReady(c: CharacterConfig): Promise<boolean> {
    let said = -Infinity;
    while (!this.stopping) {
      const st = await this.deps.daemonStatus(c.profile).catch(() => null);
      if (!st) return false;
      if (st.ready) return true;
      if (this.deps.now() - said >= 300_000) {
        said = this.deps.now();
        const why = c.attach ? `waiting for ${c.character} to be logged in (attach ${c.attach.endpoint})` : 'waiting for the world';
        this.deps.log(`${c.character}: ${why}`);
      }
      await this.pause(5000);
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
      const step = nextSegment({ cfg: this.cfg, stopping: this.stopping, segmentsThisRun: segment, quickExits, last, today });
      if (step.action === 'halt') {
        if (!this.stopping) {
          this.halted.set(c.profile, step.why);
          this.deps.log(`${c.character}: halted: ${step.why}`);
          this.deps.feed.write({ type: 'segment-end', char: c.profile, title: `${c.character} is done for now`, detail: step.why });
          await this.logOut(c);
        }
        return;
      }
      await this.pause(step.delayMs);
      if (this.stopping) return;
      if (!(await this.ensureDaemon(c)) || !(await this.waitReady(c))) {
        if (this.stopping) return;
        quickExits++;
        last = 'crashed';
        continue;
      }
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
    const startMs = deps.now();
    const deadline = startMs + cfg.segment.minutes * 60_000;
    const hardDeadline = deadline + cfg.segment.wrapUpMinutes * 60_000 + 60_000;
    const name = `stream: ${c.character} #${segment}`;
    const proc = deps.spawnPlayer(claudeArgs(cfg, c, systemPrompt(deps.brief(), c, partner), name), playerEnv(cfg, c), name);
    this.active.set(c.profile, { proc, c });
    deps.log(`${c.character}: segment ${segment} started (${c.model}, ${cfg.segment.minutes} min)`);
    deps.feed.write({ type: 'segment-start', char: c.profile, title: `${c.character}: segment ${segment}`, detail: `${c.model}, ${cfg.segment.minutes} min` });
    proc.send(userLine(segmentOpening({ c, partner, segment, nowMs: startMs, playMinutes: cfg.segment.minutes, journal: deps.journal(c.profile), lastReport, readiness })));

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
          if (next === 'nudge' && !inputClosed) {
            nudges++;
            deps.log(`${c.character}: turn ended with ${Math.round((deadline - deps.now()) / 60_000)} min left; nudge ${nudges}`);
            proc.send(userLine(nudgeMessage((deadline - deps.now()) / 60_000, partner)));
          } else closeInput();
        }
      }
      if (eof) break;
      const now = deps.now();
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
    const endMs = deps.now();
    const reason = endReason({ stopping: this.stopping, wrapUpSent, killed, sawResult, exitCode, resultSubtype });
    const minutes = (endMs - startMs) / 60_000;
    deps.feed.write({ type: 'segment-end', char: c.profile, title: `${c.character}: segment ${segment}`, detail: segmentDetail(reason, minutes, usage) });
    deps.log(`${c.character}: segment ${segment} ended: ${reason} after ${minutes.toFixed(1)} min${usage?.costUsd != null ? `, $${usage.costUsd.toFixed(2)}` : ''}${exitCode ? ` (exit ${exitCode})` : ''}`);
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
    stopRequested: () => existsSync(STOP_FILE),
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
  const lock = join(STREAM_DIR, 'supervisor.json');
  mkdirSync(STREAM_DIR, { recursive: true });
  const running = existsSync(lock) ? (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; startedAt: string }) : null;
  const alive = running && pidAlive(running.pid) ? running : null;
  if (cmd === 'stop') {
    writeFileSync(STOP_FILE, new Date().toISOString() + '\n');
    console.log(alive ? `asked the supervisor (pid ${alive.pid}) to stop; it logs everyone out within a few minutes` : `no supervisor running; left ${STOP_FILE} (removed at the next start)`);
    return;
  }
  if (cmd === 'status') {
    console.log(alive ? `supervisor pid ${alive.pid}, since ${alive.startedAt}` : 'no supervisor running');
    const segFile = join(STREAM_DIR, 'segments.jsonl');
    const recs = existsSync(segFile) ? readFileSync(segFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SegmentRecord) : [];
    const cfg = readConfig(cfgPath);
    for (const c of cfg.characters) {
      const u = dayUsage(recs, c.profile, localDay(new Date()));
      console.log(`${c.character} (${c.profile}): today ${u.segments} segments, ${Math.round(u.minutes)} min, $${u.usd.toFixed(2)}; daemon ${readInfo(c.profile) ? 'running' : 'not running'}`);
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
