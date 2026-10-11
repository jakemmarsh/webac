/**
 * The quest list behind UtilityBelt's quest expression functions
 * (getqueststatus, testquestflag, getquestktprogress, getquestktrequired,
 * isrefreshingquests; docs/vtank-parity-gaps.md §0.10).
 *
 * The client never gets a quest list from the server. UtilityBelt fills one
 * from the server's `/myquests` lines, and so does this, ported from UB's
 * QuestTracker.cs and Lib/Quests/QuestFlag.cs (UtilityBelt, MIT,
 * gitlab.com/utilitybelt/utilitybelt):
 *
 * - The list is asked for once per character after login (UB's AutoRequest,
 *   on by default), up to three tries 15 s apart, and the lines are hidden
 *   from the chat while it is asked quietly (UB's `e.Eat`).
 * - It is done 1 s after the last line, or at once on "Quest list is empty."
 *   or the server's "not currently enabled" line.
 * - When the player types `/myquests` themselves, the lines are shown and
 *   still update the list.
 * - Ours also asks again, quietly, 2 s after the server's kill-task line
 *   ("You have killed N …"); UB left that to the player.
 * - The old list stays readable until the new one is complete (UB cleared it
 *   first; metas that check isrefreshingquests see the same thing).
 *
 * Servers: ACE and ClassicACE answer only when their `quest_info_enabled`
 * property is on (off by default) and otherwise say the command is not
 * enabled; GDLE and the AC1999 server always answer. Where no list comes,
 * the functions answer as UB does with no data: every quest ready, no flag,
 * 0 solves, 0 required.
 */
import type { HostQuest } from '@ac/shared';

/** One `/myquests` line: `key - N solves (lastUnix)"description" maxSolves repeatSeconds`. */
export interface QuestFlag {
  key: string;
  description: string;
  solves: number;
  /** -1 when the quest has no limit (ACE prints the quest's MaxSolves). */
  maxSolves: number;
  /** Unix seconds of the last solve. */
  completedOn: number;
  /** Seconds before it can be solved again (the server's MinDelta). */
  repeatSeconds: number;
}

/** UB's MyQuestRegex, anchored at the line start (we feed it only the server's own lines). */
const MY_QUESTS_LINE = /^(\S+) - (\d+) solves \((\d{0,11})\)"?(?:(.*)" (.*) (\d{0,11}))?.*$/;
/** UB's KillTaskRegex: flags named like a kill counter. */
const KILL_TASK_KEY = /(killtask|killcount|slayerquest|totalgolem.*dead|(kills$))/;
/** ACE PlayerCommands.HandleQuests / GDLE / the AC1999 server: the list has no entries. */
const EMPTY_LINE = 'Quest list is empty.';
/** ACE and ClassicACE with quest_info_enabled off. */
const DISABLED_LINE = 'The command "myquests" is not currently enabled on this server.';
/** ACE GameActionTalk for a server without the command. */
const UNKNOWN_LINE = 'Unknown command: myquests';
/** A kill task moved on: ACE / ClassicACE QuestManager.HandleKillTask, the AC1999 server's EmoteManager. */
const KILL_TASK_LINE = /^You have killed \d+ .+[!.] (?:Your task is complete!|You must kill \d+ to complete your task[.!])$/;

export function parseMyQuestsLine(line: string): QuestFlag | null {
  const m = MY_QUESTS_LINE.exec(line.replace(/\s+$/, ''));
  if (!m) return null;
  const int = (s: string | undefined) => { const n = parseInt(s ?? '', 10); return Number.isFinite(n) ? n : 0; };
  const completedOn = int(m[3]);
  return {
    key: m[1]!.toLowerCase(),
    description: m[4] ?? '',
    solves: int(m[2]),
    maxSolves: int(m[5]),
    completedOn,
    // UB reads the repeat time only when the completion time parsed.
    repeatSeconds: m[3] ? int(m[6]) : 0,
  };
}

export type QuestFlagType = 'killtask' | 'once' | 'timed';

/** QuestFlag.FlagType. */
export function questFlagType(f: QuestFlag): QuestFlagType {
  if (KILL_TASK_KEY.test(f.key) && f.maxSolves >= 0) return 'killtask';
  if (f.maxSolves === 1 && f.solves <= 1) return 'once';
  return 'timed';
}

/** QuestFlag.IsReady: its timer has run out, and it is not a once-only quest already done. */
export function questReady(f: QuestFlag, nowMs: number): boolean {
  if ((f.completedOn + f.repeatSeconds) * 1000 - nowMs > 0) return false;
  return questFlagType(f) !== 'once';
}

/** UB's friendly time: "1d 1h 1m 1s". */
export function friendlyTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  return `${d ? `${d}d ` : ''}${h ? `${h}h ` : ''}${m ? `${m}m ` : ''}${r ? `${r}s ` : ''}`.trim() || '0s';
}

/** What the server last said about the list. */
export type QuestListState = 'unknown' | 'listed' | 'empty' | 'disabled' | 'unavailable';

export interface QuestTrackerDeps {
  /** Send a chat line to the server as Event_Talk (retail turns a typed /myquests into @myquests); false when there is no connection. */
  send(command: string): boolean;
  /** Wall clock, ms (quest times are the server's unix seconds). */
  now?(): number;
  /** Run `fn` after `ms`; returns a cancel. */
  after?(ms: number, fn: () => void): () => void;
}

const HEARTBEAT_MS = 1000;
const TIMEOUT_MS = 15000;
const LOGIN_TRIES = 3;
const KILL_TASK_REFRESH_MS = 2000;

export class QuestTracker {
  private flags = new Map<string, QuestFlag>();
  private pending: Map<string, QuestFlag> | null = null;
  private quiet = false;
  private tries = 0;
  private gotLine = false;
  private timer: (() => void) | null = null;
  private killTaskTimer: (() => void) | null = null;
  private character: string | null = null;
  private listState: QuestListState = 'unknown';
  private readonly now: () => number;
  private readonly after: (ms: number, fn: () => void) => () => void;

  constructor(private readonly deps: QuestTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.after = deps.after ?? ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  }

  /** What the server last said: listed, empty, disabled (ACE's quest_info_enabled off), unavailable (no answer). */
  get state(): QuestListState { return this.listState; }

  /** isrefreshingquests[]. */
  isRefreshing(): boolean { return this.pending !== null; }

  /** Every flag, as last listed. */
  list(): QuestFlag[] { return [...this.flags.values()]; }

  /** The quest functions' view of one flag; null when the list doesn't have it (UB's answers for no flag follow). */
  quest(name: string): HostQuest | null {
    // Asked for the first time this session: ask the server now, quietly. Only a meta that reads quests sends
    // /myquests; a player who never runs one sends nothing retail's client wouldn't have (UB asks at login).
    if (this.listState === 'unknown' && !this.pending) this.refresh(LOGIN_TRIES);
    const f = this.flags.get(name.trim().toLowerCase());
    return f ? { solves: f.solves, maxSolves: f.maxSolves, ready: questReady(f, this.now()) } : null;
  }

  /** One flag as last listed (any case), or null. */
  get(name: string): QuestFlag | null { return this.flags.get(name.trim().toLowerCase()) ?? null; }

  /**
   * `/ub quests check <regex>`: UB's ThinkQuestFlag lines for up to five matching flags, then "has not been
   * completed" when none is exactly the text (UtilityBelt QuestTracker, MIT).
   */
  check(text: string): { thoughts: string[]; truncated: boolean } {
    let re: RegExp;
    try { re = new RegExp(text, 'i'); } catch { re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const thoughts: string[] = [];
    let exact = false, truncated = false;
    for (const f of this.flags.values()) {
      if (!re.test(f.key)) continue;
      const type = questFlagType(f);
      const left = f.completedOn + f.repeatSeconds - this.now() / 1000;
      thoughts.push(type === 'once' ? `Quest: ${f.key} is completed`
        : type === 'killtask' ? (f.solves >= f.maxSolves ? `Quest: ${f.key} is completed` : `Quest: ${f.key} is at ${f.solves} of ${f.maxSolves}`)
          : left <= 0 ? `Quest: ${f.key} is ready` : `Quest: ${f.key} is not ready (${friendlyTime(left)})`);
      if (f.key === text.toLowerCase()) exact = true;
      if (thoughts.length >= 5) { truncated = true; break; }
    }
    if (!thoughts.length || !exact) thoughts.push(`Quest: ${text} has not been completed`);
    return { thoughts, truncated };
  }

  /** The player is in the world (LoginComplete). A new character's list is forgotten; it is asked for on first use. */
  loginComplete(character: string): void {
    if (character === this.character) return;
    this.reset();
    this.character = character;
  }

  /** Ask the server for the list, hiding its lines. False when a request is already running or nothing was sent. */
  refresh(tries = 1): boolean {
    if (this.pending) return false;
    this.begin(true);
    this.tries = tries;
    return this.ask();
  }

  /**
   * A server chat line (ServerMessage). Returns true when the chat should not
   * show it: a quiet request's answer.
   */
  onServerLine(text: string): boolean {
    const line = text.replace(/\s+$/, '');
    if (line === EMPTY_LINE || line === DISABLED_LINE || line === UNKNOWN_LINE) {
      const hide = this.pending !== null && this.quiet;
      if (line === EMPTY_LINE) { this.flags = new Map(); this.listState = 'empty'; }
      else this.listState = line === DISABLED_LINE ? 'disabled' : 'unavailable';
      this.finish(false);
      return hide;
    }
    const flag = parseMyQuestsLine(line);
    if (flag) {
      // Lines nobody here asked for: the player typed /myquests. Shown, and still read.
      if (!this.pending) { this.begin(false); this.tries = 1; }
      this.pending!.set(flag.key, flag);
      this.gotLine = true;
      this.arm(HEARTBEAT_MS, () => this.finish(true));
      return this.quiet;
    }
    if (KILL_TASK_LINE.test(line) && (this.listState === 'listed' || this.listState === 'empty')) {
      this.killTaskTimer?.();
      this.killTaskTimer = this.after(KILL_TASK_REFRESH_MS, () => { this.killTaskTimer = null; this.refresh(); });
    }
    return false;
  }

  /** A new character session: forget the list. */
  reset(): void {
    this.timer?.(); this.timer = null;
    this.killTaskTimer?.(); this.killTaskTimer = null;
    this.flags = new Map();
    this.pending = null;
    this.quiet = false;
    this.character = null;
    this.listState = 'unknown';
  }

  private begin(quiet: boolean): void {
    this.pending = new Map();
    this.quiet = quiet;
    this.gotLine = false;
  }

  private ask(): boolean {
    if (this.tries < 1 || !this.deps.send('@myquests')) {
      // GetMyQuestList "failed too many times, retiring" (or no connection to ask on).
      if (this.tries < 1) this.listState = 'unavailable';
      this.finish(false);
      return false;
    }
    this.arm(TIMEOUT_MS, () => { if (!this.gotLine) { this.tries--; this.ask(); } });
    return true;
  }

  private arm(ms: number, fn: () => void): void {
    this.timer?.();
    this.timer = this.after(ms, () => { this.timer = null; fn(); });
  }

  private finish(listed: boolean): void {
    this.timer?.(); this.timer = null;
    if (listed && this.pending) { this.flags = this.pending; this.listState = 'listed'; }
    this.pending = null;
    this.quiet = false;
  }
}
