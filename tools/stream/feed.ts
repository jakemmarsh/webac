/**
 * The stream feed: turns what the players say and do into FeedEvents (feed-events.ts) and appends them as JSONL.
 *
 * - Chat: each character's <profile>.chat.log (the daemon writes every line the player saw, timestamped), tailed.
 *   A line between two cast members is in both logs; it is written once, from the speaker's own log.
 * - Narration and tool calls: the player session's `claude -p --output-format stream-json` lines.
 * - Status: the daemon's read-only /vitals (supervisor.ts polls it).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentVitals } from '../../packages/renderer/src/agent/types.ts';
import { FEED_VERSION, defaultFeedPath, type ChatChannel, type FeedEvent, type FeedStatus } from './feed-types.ts';

type OmitBase<T> = T extends unknown ? Omit<T, 'v' | 't'> : never;
/** An event before the writer stamps its version and time. */
export type FeedDraft = OmitBase<FeedEvent>;

/** Where the feed goes: $ACJS_STREAM_FEED, else <agent state dir>/stream/feed.jsonl (feed-types.ts). */
export const feedPath = defaultFeedPath;

export class FeedWriter {
  constructor(readonly file: string, private readonly now: () => number = () => Date.now()) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Append one event; `t` (epoch ms) defaults to now (a chat line passes the time the game printed it). */
  write(draft: FeedDraft, t?: number): FeedEvent {
    const ev = { v: FEED_VERSION, t: t ?? this.now(), ...draft } as FeedEvent;
    appendFileSync(this.file, JSON.stringify(ev) + '\n');
    return ev;
  }
}

// ── chat ──

export interface ChatParseState {
  /** The last line that said who killed this character, and when (ms), for the death event that follows it. */
  killer?: { name: string; text: string; at: number };
  /** When this character last began a cast ("Casting Flame Bolt III"), ms. */
  castingAt?: number;
  /**
   * Incantations seen spoken right after a "Casting …" line ("Zojak Quaguz"). Shared between the cast's states (the
   * supervisor passes one set), so a line once known as spell words stays spell words.
   */
  incantations?: Set<string>;
}

/** How soon after "Casting X" the character's own incantation is printed (the rehearsal's logs: 0.5–2 s). */
export const INCANTATION_AFTER_CASTING_MS = 5000;
/** Spell words: two or three capitalised power words, nothing else ("Zojak Quaguz", "Malar Cazael"). */
const INCANTATION_SHAPE = /^[A-Z][a-z']+(?: [A-Z][a-z']+){1,2}$/;
const CASTING = /^Casting \S/;

/**
 * Whether a say line's message is the character's own spell words, which retail prints as speech
 * ("You say, "Zojak Quaguz""): shaped like an incantation and either spoken just after a "Casting …" line or already
 * known as one. Real /say speech has punctuation, lower-case words or more words, and a cast member's /say right
 * after a cast that happens to be two capitalised words is the only miss.
 */
export function isIncantation(message: string, t: number, state: ChatParseState): boolean {
  if (!INCANTATION_SHAPE.test(message.trim())) return false;
  if (state.incantations?.has(message.trim())) return true;
  return state.castingAt !== undefined && t - state.castingAt >= 0 && t - state.castingAt <= INCANTATION_AFTER_CASTING_MS;
}

const SAID = /^(?:\[([A-Za-z][\w ]*)\] )?You say, "([\s\S]*)"$/;
const TOLD = /^You tell (.+?), "([\s\S]*)"$/;
const HEARD = /^(?:\[([A-Za-z][\w ]*)\] )?(.+?) says, "([\s\S]*)"$/;
const TELLS_YOU = /^(.+?) tells you, "([\s\S]*)"$/;
const LEVEL = /^You are now level (\d+)!/;
const CORPSE = /^Your corpse is located at \(([^)]+)\)/;
// ACE's death messages vary by damage type ("X slays you viciously…", "X splits you apart!", "Your death is preceded by a
// sharp, stabbing pain, courtesy of X!"); a "<name> <verb> you…!" line just before the corpse line names the killer.
const KILLED_BY = [/courtesy of (.+?)[!.]?$/i, /^(?!You\b|Your\b)(.+?) \w+ you\b(?![^!]*\bfor \d+ points?)[^"]*!$/];
const CHANNELS: ReadonlySet<string> = new Set(['fellowship', 'allegiance', 'general', 'trade', 'lfg', 'roleplay', 'society']);
const MAGIC = /^(Casting |You cast |Your spell |With .+ you restore|The spell consumed|You resist the spell|You learn |You fail to affect|.+ casts .+ on you)|\bspell\b/i;
const COMBAT = /\bfor \d+ points? of [\w ]*damage|\bevaded\b|^You (killed|slay)\b|\bdied!$|deafening silence of death|^Critical hit|\bslays you\b|\bkills you\b/i;

/** A chat channel by its bracketed name ("[Fellowship]" → fellowship), else other. */
function channelOf(bracket: string | undefined, fallback: ChatChannel): ChatChannel {
  if (!bracket) return fallback;
  const c = bracket.trim().toLowerCase();
  return (CHANNELS.has(c) ? c : 'other') as ChatChannel;
}

/** A line nobody said: its likely channel (the chat log keeps no chat type, so by its wording). */
export function systemChannel(text: string): ChatChannel {
  if (COMBAT.test(text)) return 'combat';
  if (MAGIC.test(text)) return 'magic';
  return 'system';
}

/**
 * One chat-log line ("<ISO> <text>", as the daemon writes it) as feed drafts for profile `char`, whose character is
 * `me`. Every line becomes a chat event (text = the line as printed); a level-up or death line adds its event. Speech
 * by another cast member is left to the speaker's own log (each line once).
 */
export function parseChatLine(line: string, char: string, me: string, cast: readonly string[], state: ChatParseState = {}): Array<{ t: number; draft: FeedDraft }> {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ([\s\S]*)$/.exec(line.replace(/\r?\n$/, ''));
  if (!m) return [];
  const t = Date.parse(m[1]);
  const text = m[2];
  if (!text.trim()) return [];
  const isCast = (n: string): boolean => cast.some((c) => c.toLowerCase() === n.trim().toLowerCase());
  const out: Array<{ t: number; draft: FeedDraft }> = [];
  const chat = (channel: ChatChannel, extra: { speaker?: string; to?: string; message?: string } = {}): void => { out.push({ t, draft: { type: 'chat', char, channel, text, ...extra } }); };
  let r: RegExpExecArray | null;
  if (CASTING.test(text)) state.castingAt = t;
  if ((r = SAID.exec(text))) {
    // Our own spell words are the magic log, not speech (the overlay leaves magic out of its chat panel).
    if (!r[1] && isIncantation(r[2], t, state)) {
      (state.incantations ??= new Set()).add(r[2].trim());
      chat('magic', { speaker: me, message: r[2] });
    } else chat(channelOf(r[1], 'say'), { speaker: me, message: r[2] });
  }
  else if ((r = TOLD.exec(text))) chat('tell-out', { speaker: me, to: r[1], message: r[2] });
  else if ((r = TELLS_YOU.exec(text))) { if (!isCast(r[1])) chat('tell-in', { speaker: r[1], to: me, message: r[2] }); }
  else if ((r = HEARD.exec(text))) {
    // Someone else's say that is a known incantation (another caster nearby using the same spell): magic too.
    if (!isCast(r[2])) chat(!r[1] && state.incantations?.has(r[3].trim()) ? 'magic' : channelOf(r[1], 'say'), { speaker: r[2], message: r[3] });
  }
  else chat(systemChannel(text));
  if ((r = LEVEL.exec(text))) out.push({ t, draft: { type: 'level-up', char, level: Number(r[1]) } });
  if ((r = CORPSE.exec(text))) {
    const k = state.killer && t - state.killer.at < 15_000 ? state.killer : undefined;
    state.killer = undefined;
    out.push({ t, draft: { type: 'death', char, text: k ? k.text : text, ...(k ? { killer: k.name } : {}) } });
  } else {
    for (const re of KILLED_BY) {
      const km = re.exec(text);
      if (km && !text.includes('"')) { state.killer = { name: km[1].replace(/^the /i, ''), text, at: t }; break; }
    }
  }
  return out;
}

/** Follows a growing log file from where it ends now (history is not replayed); a truncated file starts over. */
export class FileTail {
  private offset: number;
  private partial = '';
  constructor(readonly file: string, fromStart = false) {
    this.offset = fromStart || !existsSync(file) ? 0 : statSync(file).size;
  }

  /** Complete new lines since the last read. */
  read(): string[] {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) { this.offset = 0; this.partial = ''; }
    if (size === this.offset) return [];
    const fd = openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines.filter((l) => l.length > 0);
    } finally {
      closeSync(fd);
    }
  }
}

// ── the player's stream-json ──

/** Split a shell command line into words (single and double quotes, backslash escapes; no expansion). */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; any = true; }
    else if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/**
 * The agent CLI calls in a Bash command: a player's `./ac cast spell=… …` (its wrapper, tools/stream/player.ts) or
 * `npx tsx tools/ac-agent/cli.ts …`, chained with && or ;.
 */
export function cliCalls(command: string): Array<{ tool: string; args: Record<string, string> }> {
  const out: Array<{ tool: string; args: Record<string, string> }> = [];
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = shellWords(part.trim());
    const i = words.findIndex((w) => /(^|\/)cli\.ts$/.test(w) || /^(\.\/|\/.*\/)ac$/.test(w));
    if (i < 0 || !words[i + 1]) continue;
    const args: Record<string, string> = {};
    let free = 0;
    for (const w of words.slice(i + 2)) {
      const eq = w.indexOf('=');
      if (eq > 0 && /^[a-z_]+$/.test(w.slice(0, eq))) args[w.slice(0, eq)] = w.slice(eq + 1);
      else args[`_${free++}`] = w;
    }
    out.push({ tool: words[i + 1].replace(/^ac_/, ''), args });
  }
  return out;
}

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A viewer's one-line summary of an agent CLI call, or null for calls not worth a line (help, sessions, vitals).
 * `name` turns an object id ("#8000123a") into the name the player last saw it under.
 */
export function summarizeCliCall(tool: string, a: Record<string, string>, name: (v: string) => string = (v) => v): string | null {
  const t = (k: string): string => name(a[k] ?? a._0 ?? '');
  switch (tool) {
    case 'observe': return a.filter ? `looks around for ${a.filter}` : 'looks around';
    case 'look': return 'takes a look';
    case 'screenshot': return 'takes a screenshot';
    case 'walk_to': return `walks to ${t('target')}${a.stay_with ? ` with ${a.stay_with}` : ''}${a.flee === 'true' ? ' (fleeing)' : ''}`;
    case 'follow': return `follows ${t('target')}`;
    case 'move': return `moves ${a.direction ?? a._0 ?? ''}`.trim();
    case 'turn': return `turns ${a.toward ?? a._0 ?? ''}`.trim();
    case 'jump': return 'jumps';
    case 'use': return `uses ${t('target')}`;
    case 'use_on': return `uses ${name(a.item ?? a._0 ?? '')} on ${name(a.target ?? a._1 ?? '')}`;
    case 'attack': return `attacks ${t('target')}`;
    case 'cast': return `casts ${a.spell ?? a._0 ?? 'a spell'}${a.target ? ` at ${name(a.target)}` : ''}${a.repeat === 'true' ? ' (repeat)' : ''}`;
    case 'combat_mode': return `switches to ${a.mode ?? a._0 ?? ''} mode`.replace('  ', ' ');
    case 'stop_moving': return 'stops';
    case 'say': return `says: ${clip(a.text ?? a._0 ?? '')}`;
    case 'wait': return `waits${a.types ? ` (${a.types})` : ''}`;
    case 'loot': return `loots ${name(a.target ?? a.container ?? a._0 ?? 'a corpse')}${a.match ? ` (${a.match})` : ''}`;
    case 'pick_up': return `picks up ${t('item')}`;
    case 'drop': return `drops ${t('item')}`;
    case 'give': return `gives ${name(a.item ?? a._0 ?? '')} to ${name(a.target ?? a._1 ?? '')}`;
    case 'equip': return `equips ${t('item')}`;
    case 'appraise': return `appraises ${t('target')}`;
    case 'vendor': return 'checks the vendor\'s wares';
    case 'buy': return `buys ${a.amount && a.amount !== '1' ? `${a.amount}× ` : ''}${name(a.item ?? a._0 ?? '')}`;
    case 'sell': return `sells ${name(a.item ?? a._0 ?? '')}`;
    case 'trade': return `trade: ${a.action ?? a._0 ?? 'view'}`;
    case 'inventory': return 'checks the pack';
    case 'character': return 'checks the character sheet';
    case 'spells': return 'checks the spellbook';
    case 'raise': return `raises ${a.stat ?? a._0 ?? ''}${a.times ? ` ×${a.times}` : ''}`;
    case 'train_skill': return `trains ${a.skill ?? a._0 ?? ''}`;
    case 'fellowship': return `fellowship: ${[a.action ?? a._0, a.name, a.target].filter(Boolean).join(' ')}`;
    case 'allegiance': return 'checks the allegiance';
    case 'dialog': return `answers a dialog: ${a.button ?? a._0 ?? ''}`;
    case 'map': return 'checks the map';
    case 'journal': return 'reads the journal';
    case 'note': return `notes (${a.kind ?? 'note'}): ${clip(a.text ?? a._0 ?? '')}`;
    case 'goal': return `new goal: ${clip(a.text ?? a._0 ?? '')}`;
    case 'routine': return `routine: ${a.action ?? a._0 ?? ''}`;
    case 'routines': return `routines: ${a.action ?? a._0 ?? ''}`;
    case 'press': return `presses ${a.key ?? a._0 ?? ''}`;
    case 'help': case 'sessions': case 'vitals': case 'status': return null;
    default: return `${tool}${Object.values(a).length ? ` ${clip(Object.values(a).map(name).join(' '), 80)}` : ''}`;
  }
}

/** Object ids and the names observe/inventory printed them with ("#8000123a  Drudge Servant  [monster L5]"). */
export function learnNames(text: string, into: Map<string, string>): void {
  for (const m of text.matchAll(/#([0-9a-f]{4,8})\s{2}(.+?)\s{2}\[/g)) into.set(m[1].toLowerCase(), m[2]);
}

export interface SegmentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  turns: number | null;
}

export interface StreamJsonOutcome {
  drafts: FeedDraft[];
  /** The session's id and model (from its init line). */
  init?: { sessionId: string; model?: string };
  /** The turn ended (a `result` line): its usage, and the text it ended on (the player's report). */
  result?: { usage: SegmentUsage; text: string; isError: boolean; subtype?: string; sessionId?: string };
}

/** The longest narration line the overlay's ticker shows (the rehearsals' own lines ran 30–180 characters). */
export const NARRATION_MAX_CHARS = 240;

/**
 * A player's text block as one narration line, or null when it isn't one. Narration is the short "what I'm doing and
 * why" between tool calls; the end-of-segment report ("## Report: Segment 1 …", 3,000+ characters of markdown) went
 * to the ticker whole in the second stream rehearsal (2026-10-13). Dropped: any block with a markdown heading, list,
 * table or rule, and any multi-paragraph block longer than the cap (a report, a plan written out). A long single
 * paragraph is cut at the last sentence end within the cap (else at a word, with "…"); line breaks become spaces.
 */
export function narrationLine(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const lines = t.split(/\r?\n/);
  if (lines.some((l) => /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||(?:-{3,}|\*{3,}|_{3,})\s*$|>\s)/.test(l))) return null;
  const flat = t.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= NARRATION_MAX_CHARS) return flat;
  if (/\n\s*\n/.test(t)) return null;
  const head = flat.slice(0, NARRATION_MAX_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= NARRATION_MAX_CHARS / 2) return head.slice(0, end + 1);
  const sp = head.lastIndexOf(' ');
  return `${head.slice(0, sp > NARRATION_MAX_CHARS / 2 ? sp : NARRATION_MAX_CHARS - 1)}…`;
}

/**
 * One `claude -p --output-format stream-json` line as feed drafts: the model's short text → narration (narrationLine), each Bash call to the
 * agent CLI → a tool line, other tools → a short line; `result` → usage. `names` learns object names from tool results.
 */
export function parseStreamJsonLine(line: string, char: string, names: Map<string, string> = new Map()): StreamJsonOutcome {
  const out: StreamJsonOutcome = { drafts: [] };
  let msg: any;
  try { msg = JSON.parse(line); } catch { return out; }
  if (!msg || typeof msg !== 'object') return out;
  // An id the way the tools take one (#8000123a, 0x8000123a, 8000123a) → the name it was printed with.
  const named = (v: string): string => {
    const s = v.trim();
    const m = /^(?:#|0x)?([0-9a-f]{4,8})$/i.exec(s);
    if (!m || !(/^(#|0x)/i.test(s) || s.length >= 6)) return v;
    return names.get(m[1].toLowerCase()) ?? v;
  };
  if (msg.type === 'system' && msg.subtype === 'init') {
    out.init = { sessionId: String(msg.session_id ?? ''), ...(msg.model ? { model: String(msg.model) } : {}) };
    return out;
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        const line = narrationLine(b.text);
        if (line) out.drafts.push({ type: 'narration', char, text: line });
      }
      if (b?.type !== 'tool_use') continue;
      if (b.name === 'Bash') {
        const cmd = String(b.input?.command ?? '');
        const calls = cliCalls(cmd);
        for (const c of calls) {
          const s = summarizeCliCall(c.tool, c.args, named);
          if (s) out.drafts.push({ type: 'tool', char, tool: `ac_${c.tool}`, summary: s });
        }
        if (!calls.length && !/^\s*date\b/.test(cmd)) {
          const what = /world-query|ace_world|sqlite3/.test(cmd) ? 'checks the world database' : `runs: ${clip(String(b.input?.description ?? cmd), 80)}`;
          out.drafts.push({ type: 'tool', char, tool: 'bash', summary: what });
        }
      } else if (b.name === 'Read') {
        const f = String(b.input?.file_path ?? '');
        out.drafts.push({ type: 'tool', char, tool: 'read', summary: /\.(jpe?g|png)$/i.test(f) ? 'looks at the screenshot' : `reads ${basename(f)}` });
      }
    }
    return out;
  }
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b?.type !== 'tool_result') continue;
      const c = b.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === 'text' ? x.text : '')).join('\n') : '';
      learnNames(text, names);
    }
    return out;
  }
  if (msg.type === 'result') {
    const u = msg.usage ?? {};
    out.result = {
      usage: {
        inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0), cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
        turns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
      },
      text: typeof msg.result === 'string' ? msg.result : '',
      isError: !!msg.is_error,
      ...(msg.subtype ? { subtype: String(msg.subtype) } : {}),
      ...(msg.session_id ? { sessionId: String(msg.session_id) } : {}),
    };
  }
  return out;
}

/** Usage summed over a segment's turns (each `result` reports its own turn). */
export function addUsage(a: SegmentUsage | null, b: SegmentUsage): SegmentUsage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    turns: a.turns === null && b.turns === null ? null : (a.turns ?? 0) + (b.turns ?? 0),
  };
}

/** The daemon's /vitals answer as a status draft for profile `char` (null outside the world). */
export function statusDraft(char: string, v: AgentVitals | null): Omit<FeedStatus, 'v' | 't'> | null {
  if (!v) return null;
  return {
    type: 'status', char, name: v.name, level: v.level, health: v.health, stamina: v.stamina, mana: v.mana,
    xp: { total: v.xp?.total ?? 0, toNext: v.xp?.toNext ?? 0, ...(v.xp?.levelStart != null ? { levelStart: v.xp.levelStart } : {}) },
    location: v.coords ?? (v.indoors ? `indoors (${v.cell})` : v.cell),
    goal: v.goal,
    ...(v.dead ? { dead: true } : {}),
  };
}
