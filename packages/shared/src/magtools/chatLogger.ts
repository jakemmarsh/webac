/**
 * Mag-Tools' chat logger (docs/plugin-specs/magtools.md §6.1), rebuilt clean-room from the spec's facts:
 * players' tells, local says and channel lines, captured into two groups whose channels the player picks.
 *
 * Browser adaptation: a browser page can't append to `<Character>.ChatLogger.txt`. With Keep Persistent
 * Logs on, the logged lines are kept in the host's per-character store instead, in the file's own line
 * format (`yyMMddHHmmss,<channel int>,<message>`), capped at the last 1 MiB (upstream reads back the
 * same last 1 MiB at login), and the Loggers → Options tab gets an Export button that hands the player
 * that text as a download. Clear History clears the stored log too (upstream wrote the combat stats over
 * the log path instead, spec §12 #9).
 */
import { ChatMessageType } from '../enums/ChatMessageType.js';
import { mtDateTime, mtFileStamp, type MtTextStore } from './format.js';
import { MT_CHAT_LOGGER_CHANNELS, mtChatLoggerDefault, type MtChatLoggerChannel, type MtOptionStorage } from './options.js';

/** Every channel the logger knows, with its file int (Util.cs, spec §6.1). Only MT_CHAT_LOGGER_CHANNELS can be picked. */
export const MT_CHAT_CHANNEL_INTS = {
  Area: 1, Tells: 2, Fellowship: 4, Allegiance: 8, General: 16, Trade: 32, LFG: 64, Roleplay: 128, Society: 256,
} as const;
export type MtChatChannel = keyof typeof MT_CHAT_CHANNEL_INTS;

/** The two lists' columns: Time 75, Message 500. */
export const MT_CHAT_LOG_COLUMNS = [75, 500] as const;
/** A list past this many rows is trimmed to MT_CHAT_LOG_TRIM_TO. */
export const MT_CHAT_LOG_MAX = 10_000;
export const MT_CHAT_LOG_TRIM_TO = 9_000;
/** The stored log keeps this many characters at most (upstream reads back the last 1 MiB). */
export const MT_CHAT_LOG_STORE_MAX = 1024 * 1024;

/** A chat line as the host receives it. */
export interface MtChatInput {
  text: string;
  /** Its ChatMessageType. */
  type: number;
  /** Said or told by a player (you included), not an NPC or a monster. */
  fromPlayer: boolean;
}

const CHANNEL_PREFIX = /^\[(Fellowship|Allegiance|General|Trade|LFG|Roleplay|Society)\] /;

/**
 * A spell incantation (`You say, "Zojak …"` / `<name> says, "Zojak …"`): the first word of the quote is
 * one of the power words. `words` come from the era's SpellComponentTable (each component's Text).
 */
export function mtIsIncantation(text: string, words: ReadonlySet<string>): boolean {
  const m = /^(?:You say|.+? says), "([^ "]+)/.exec(text);
  return !!m && words.has(m[1]!);
}

/** Which channel a line is logged under, or null (NPC speech, incantations, everything else). */
export function mtChatChannel(e: MtChatInput, isIncantation: (text: string) => boolean = () => false): MtChatChannel | null {
  const pre = CHANNEL_PREFIX.exec(e.text);
  if (pre) return pre[1] as MtChatChannel;
  if (!e.fromPlayer) return null;
  if (e.type === ChatMessageType.Tell || e.type === ChatMessageType.OutgoingTell) return 'Tells';
  if (e.type === ChatMessageType.Speech && !isIncantation(e.text)) return 'Area';
  return null;
}

/** The message with its `<Tell:…>name<\Tell>` markup removed (Util.cs, spec §6.1). */
export function mtCleanChat(text: string): string {
  return text.replace(/<Tell:[^>]*>([^<]*)<\\Tell>/g, '$1');
}

export interface MtChatLogLine {
  time: number;
  channel: MtChatChannel;
  text: string;
}

export interface MtChatLoggerOpts {
  /** The global settings store (the groups' channel choices live there; they aren't `/mt opt` settings). */
  settings: MtOptionStorage;
  /** Keep Persistent Logs (ChatLogger.Persistent). */
  persistent: () => boolean;
  /** Where the log lives (per server + character). */
  store?: () => MtTextStore | null;
  now?: () => number;
  isIncantation?: (text: string) => boolean;
}

const groupKey = (group: 1 | 2, channel: MtChatLoggerChannel) => `ChatLogger.Group${group}.${channel}`;

export class MtChatLogger {
  /** Each group's lines, newest first. */
  private readonly lists: Record<1 | 2, MtChatLogLine[]> = { 1: [], 2: [] };
  /** The stored log as text (cached so a line appends without a read). */
  private stored: string | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: MtChatLoggerOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether a group logs a channel (defaults: Group 1 Tells only). */
  enabled(group: 1 | 2, channel: MtChatLoggerChannel): boolean {
    const v = this.opts.settings.get(groupKey(group, channel));
    return v === undefined ? mtChatLoggerDefault(group, channel) : /^true$/i.test(v);
  }

  setEnabled(group: 1 | 2, channel: MtChatLoggerChannel, on: boolean): void {
    this.opts.settings.set(groupKey(group, channel), on ? 'True' : 'False');
  }

  private groupHas(group: 1 | 2, channel: MtChatChannel): boolean {
    return (MT_CHAT_LOGGER_CHANNELS as readonly string[]).includes(channel) && this.enabled(group, channel as MtChatLoggerChannel);
  }

  /** A chat line arrived. Returns the channel it was logged under, or null. */
  add(e: MtChatInput): MtChatChannel | null {
    const channel = mtChatChannel(e, this.opts.isIncantation);
    if (!channel) return null;
    const in1 = this.groupHas(1, channel);
    const in2 = this.groupHas(2, channel);
    if (!in1 && !in2) return null;
    const line: MtChatLogLine = { time: this.now(), channel, text: mtCleanChat(e.text) };
    if (in1) this.push(1, line);
    if (in2) this.push(2, line);
    if (this.opts.persistent()) this.append(line);
    return channel;
  }

  private push(group: 1 | 2, line: MtChatLogLine): void {
    const l = this.lists[group];
    l.unshift(line);
    if (l.length > MT_CHAT_LOG_MAX) l.length = MT_CHAT_LOG_TRIM_TO;
  }

  /** A group's lines, newest first. */
  lines(group: 1 | 2): readonly MtChatLogLine[] { return this.lists[group]; }

  /** A group's rows: `yy/MM/dd HH:mm` and the message. */
  rows(group: 1 | 2): Array<[string, string]> {
    return this.lists[group].map((l) => [mtDateTime(l.time), l.text]);
  }

  private store(): MtTextStore | null {
    try { return this.opts.store?.() ?? null; } catch { return null; }
  }

  private append(line: MtChatLogLine): void {
    const s = this.store();
    if (!s) return;
    if (this.stored === null) { try { this.stored = s.get() ?? ''; } catch { this.stored = ''; } }
    let text = this.stored + mtChatLogFileLine(line);
    if (text.length > MT_CHAT_LOG_STORE_MAX) {
      text = text.slice(text.length - MT_CHAT_LOG_STORE_MAX);
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    this.stored = text;
    try { s.set(text); } catch { /* storage full or blocked */ }
  }

  /** At login: read the stored log back into both lists (each group keeps the channels it logs). */
  load(): void {
    this.lists[1] = [];
    this.lists[2] = [];
    this.stored = null;
    const s = this.store();
    let raw = '';
    try { raw = s?.get() ?? ''; } catch { raw = ''; }
    this.stored = s ? raw : null;
    for (const line of mtParseChatLog(raw)) {
      if (this.groupHas(1, line.channel)) this.push(1, line);
      if (this.groupHas(2, line.channel)) this.push(2, line);
    }
  }

  /** Clear History: both lists, and the stored log. */
  clear(): void {
    this.lists[1] = [];
    this.lists[2] = [];
    this.stored = null;
    try { this.store()?.remove(); } catch { /* storage blocked */ }
  }

  /**
   * The log as `<Character>.ChatLogger.txt` holds it, oldest first: the stored log with Keep Persistent
   * Logs on, else this session's lines from both groups.
   */
  exportText(): string {
    if (this.opts.persistent()) {
      const s = this.store();
      if (s) { try { return this.stored ?? s.get() ?? ''; } catch { /* fall through */ } }
    }
    const seen = new Set<MtChatLogLine>();
    const all = [...this.lists[1], ...this.lists[2]].filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
    all.sort((a, b) => a.time - b.time);
    return all.map(mtChatLogFileLine).join('');
  }
}

/** One file line: `yyMMddHHmmss,<channel int>,<message>` and a newline. */
export function mtChatLogFileLine(l: MtChatLogLine): string {
  return `${mtFileStamp(l.time)},${MT_CHAT_CHANNEL_INTS[l.channel]},${l.text.replace(/[\r\n]+/g, ' ')}\n`;
}

/** The file's lines back (oldest first); unreadable lines are skipped. */
export function mtParseChatLog(text: string): MtChatLogLine[] {
  const byInt = new Map<number, MtChatChannel>(Object.entries(MT_CHAT_CHANNEL_INTS).map(([k, v]) => [v, k as MtChatChannel]));
  const out: MtChatLogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}),(\d+),(.*)$/.exec(raw);
    if (!m) continue;
    const channel = byInt.get(Number(m[7]));
    if (!channel) continue;
    const time = new Date(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    out.push({ time, channel, text: m[8]! });
  }
  return out;
}
