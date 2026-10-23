/**
 * TELEMETRY.refusal-events — every refusal a player sees reaches the bridge log.
 *
 * webac#12: an AC1999 player got "You can only move or use one item at a time"
 * over and over. Our client printed it (the pending-inventory-request lock), and
 * the bridge logs had nothing; webac#9's "You must select a suitable target before
 * casting this spell" was client-printed too. Players hit refusals we never saw
 * until they wrote in. This reporter sends one `refusal` event per (source, code)
 * the first time it happens on the page, then rolls repeats up into a count once a
 * minute, so a monitor (tools/watch-refusals.sh) can flag a new (era, code) pair
 * before anyone reports it.
 *
 * Sources, and where main.ts feeds them:
 * - client: every line the client itself puts in the spew box
 *   (GameUI.displayErrorText, retail's SendNotice_DisplayStringInfo(0x1a): the
 *   client's validation failures, the inventory-request lock, cast target checks,
 *   jump / posture refusals, trade / vendor / slumlord refusals). A few spew lines
 *   that are not refusals (AutoRun ON/OFF, "Casting …", portal storm and portal
 *   space notices) are skipped (NOT_REFUSAL). Chat-command feedback (typed text
 *   may echo there) and server text delivered through the spew are skipped too:
 *   main.ts runs those inside `quietly`.
 * - server, by code: WeenieError 0x028A and WeenieErrorWithString 0x028B (ACE,
 *   GDLE; the AC1999 server's flat 0x1C AttemptFailed is decoded to the same
 *   event), a non-zero UseDone 0x01C7, and InventoryServerSaveFailed 0x00A0 (all
 *   three eras; the 1999 server's NotifyInventoryFailedEvent is the same number).
 *   Reported whether or not retail printed anything for the code (`sink` none):
 *   a silent refusal is the one players can't describe.
 * - server, by text: a server chat line (ServerMessage 0xF7E0; the 1999 server's
 *   0xF62C ServerChatLine) of the error type 0x1a, or one that reads as a refusal
 *   (REFUSAL_TEXT: GDLE and the AC1999 server send many of theirs as plain text,
 *   e.g. "You do not have permission to loot that corpse!"), and transient strings
 *   (0x02EB; the 1999 server's OverlayText).
 *
 * Privacy: the text is a template. Names of every object the client knows (items,
 * creatures, players, the player's own) become '_' through the `scrub` main.ts
 * passes; every number becomes '#'; anything outside printable ASCII is dropped;
 * WeenieErrorWithString sends the code's template, never the substituted value.
 * No player speech: tells, says and channel lines never come here.
 *
 * Codes: `we:0x<hex>` for a server code (`context` says which message), `c:<8 hex>`
 * for a client line and `t:<8 hex>` for a server text line, the hex being the
 * FNV-1a hash of the template, so the same refusal keeps its code across pages.
 *
 * Transport: `POST /client-preworld` as the other in-world events; the bridge logs
 * it as `client_refusal` (services/ws-tcp-bridge/src/clientRefusal.ts).
 * Limits: MAX_REFUSAL_CODES distinct keys and MAX_REFUSAL_EVENTS events per page.
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export const REFUSAL_OUTCOME = 'refusal';
export const REFUSAL_SOURCES = ['client', 'server'] as const;
export type RefusalSource = typeof REFUSAL_SOURCES[number];
/** Where the refusal came from: the spew box, or which server message. */
export const REFUSAL_CONTEXTS = ['spew', 'weenie_error', 'weenie_error_str', 'use_done', 'inventory_failed', 'server_text', 'transient'] as const;
export type RefusalContext = typeof REFUSAL_CONTEXTS[number];
/** Where the player saw it: retail's sink for the code (WeenieErrorNotices), or nothing. */
export const REFUSAL_SINKS = ['spew', 'chat', 'none'] as const;
export type RefusalSink = typeof REFUSAL_SINKS[number];

export const MAX_REFUSAL_TEXT = 120;
/** Repeats of a refusal are sent as one count this often. */
export const REFUSAL_ROLLUP_MS = 60_000;
export const MAX_REFUSAL_CODES = 64;
export const MAX_REFUSAL_EVENTS = 200;
/** A GameActionType opcode the refused request was (optional context). */
export const MAX_ACTION = 0xffff;

export interface RefusalEvent {
  outcome: 'refusal';
  era: string;
  server: string | null;
  trace: string;
  build: string;
  source: RefusalSource;
  code: string;
  text: string | null;
  context: RefusalContext;
  sink: RefusalSink;
  /** The GameActionType of the request the client refused, when known. */
  action: number | null;
  /** Occurrences this event stands for (1 for the first). */
  count: number;
  /** The first of this code on this page (sent at once). */
  first: boolean;
  /** The roll-up's span, first to last occurrence counted (0 for the first). */
  windowMs: number;
}

export interface RefusalReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  /** Replace every name the client knows in `text` with '_' (main.ts: the object names). */
  scrub?: (text: string) => string;
  now?: () => number;
  send?: TelemetrySend;
}

/** Spew lines that are notices, not refusals. */
const NOT_REFUSAL: readonly RegExp[] = [
  /^AutoRun (ON|OFF)$/,
  /^Casting /,
  /Portal Storm/i,
  /^In Portal Space/,
  /^Removing .* from shopping list$/,
  /^Some game data for this area could not be downloaded/,
];

/**
 * A server text line that reads as a refusal. GDLE's and the AC1999 server's SendText refusals
 * ("You can't do that yet!", "Not enough pack space!", "Your Lockpicking skill is too low for that.").
 */
export const REFUSAL_TEXT = /^(you (can't|cannot|can not|do not|don't|are not|aren't|must|lack|have no|need|may not|fail)|you're (too|not)|not enough|unable|invalid|only |can't|cannot|couldn't|could not|this (command )?is not|that (can't|cannot|is not|isn't))|too (busy|recently|encumbered|far|heavy|low|soon)|not (allowed|permitted|enough)|permission/i;

/** FNV-1a 32-bit, 8 hex digits. */
export function refusalHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A refusal's text as a template: names already scrubbed, numbers '#', printable ASCII, one line, capped. */
export function refusalTemplate(text: string): string {
  return text
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/[0-9]+(?:[.,][0-9]+)*/g, '#')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REFUSAL_TEXT)
    .trim();
}

/**
 * Every occurrence of each name (longest first, so "Bob the Great" goes before "Bob") as '_'.
 * Names shorter than two characters are left alone (they would eat ordinary words).
 */
export function scrubNames(text: string, names: Iterable<string | null | undefined>): string {
  const list = [...new Set([...names].filter((n): n is string => typeof n === 'string' && n.trim().length >= 2).map((n) => n.trim()))]
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const n of list) if (out.includes(n)) out = out.split(n).join('_');
  return out;
}

export const weenieCode =(code: number): string => `we:0x${(code >>> 0).toString(16).padStart(4, '0')}`;

interface Pending {
  source: RefusalSource;
  code: string;
  text: string | null;
  context: RefusalContext;
  sink: RefusalSink;
  action: number | null;
  count: number;
  firstAt: number;
  lastAt: number;
}

function safe<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try { return f(); } catch { return fallback; }
}

export class RefusalReporter {
  private readonly now: () => number;
  private readonly outbox: TelemetryOutbox;
  /** key → repeats not yet sent (null: nothing pending since the last send). */
  private readonly seen = new Map<string, Pending | null>();
  private sent = 0;
  private lastFlushAt: number;
  private quietDepth = 0;
  private action: number | null = null;

  constructor(private readonly opts: RefusalReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, this.now, true);
    this.lastFlushAt = this.now();
  }

  /** Run `f` with the client spew tap off (server text shown through the spew, chat-command feedback). */
  quietly<T>(f: () => T): T {
    this.quietDepth++;
    try { return f(); } finally { this.quietDepth--; }
  }

  /** Run `f` with `action` (a GameActionType) as the context of any client refusal it raises. */
  forAction<T>(action: number, f: () => T): T {
    const before = this.action;
    this.action = Number.isInteger(action) && action >= 0 && action <= MAX_ACTION ? action : null;
    try { return f(); } finally { this.action = before; }
  }

  /** GameUI.displayErrorText's tap: a line the client put in the spew box. */
  clientSpew(text: string): void {
    if (this.quietDepth > 0 || typeof text !== 'string') return;
    const raw = text.trim();
    if (!raw || NOT_REFUSAL.some((re) => re.test(raw))) return;
    const t = this.template(raw);
    if (!t) return;
    this.record('client', `c:${refusalHash(t)}`, t, 'spew', 'spew', this.action);
  }

  /**
   * A server refusal by code: WeenieError, WeenieErrorWithString, a non-zero UseDone, an
   * InventoryServerSaveFailed. `template` is the code's own text (with '_' for a WithString value).
   */
  serverCode(context: Exclude<RefusalContext, 'spew' | 'server_text' | 'transient'>, code: number, template: string | null, sink: RefusalSink): void {
    if (!Number.isFinite(code)) return;
    const t = template ? this.template(template) : null;
    this.record('server', weenieCode(code), t || null, context, sink, null);
  }

  /** A server text line (chat type `chatType`) or transient string; kept when it reads as a refusal. */
  serverText(context: 'server_text' | 'transient', text: string, chatType: number | null): void {
    if (typeof text !== 'string') return;
    const raw = text.trim();
    if (!raw) return;
    if (context === 'server_text' && chatType !== 0x1a && !REFUSAL_TEXT.test(raw)) return;
    if (NOT_REFUSAL.some((re) => re.test(raw))) return;
    const t = this.template(raw);
    if (!t) return;
    this.record('server', `t:${refusalHash(t)}`, t, context, context === 'transient' || chatType === 0x1a ? 'spew' : 'chat', null);
  }

  /** The reporters' 100 ms clock: resend what the network refused, and send the minute's roll-ups. */
  tick(): void {
    this.outbox.retry();
    if (this.now() - this.lastFlushAt >= REFUSAL_ROLLUP_MS) this.flush();
  }

  /** Send every pending roll-up now (a minute passed, the world session ended, the page is going). */
  flush(): void {
    this.lastFlushAt = this.now();
    for (const [key, p] of this.seen) {
      if (!p) continue;
      this.seen.set(key, null);
      this.post(p, false);
    }
  }

  /** online → retry; a hidden or leaving page sends its roll-ups by beacon. */
  install(win: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.addEventListener('pagehide', () => { this.flush(); this.outbox.retry(true); });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') { this.flush(); this.outbox.retry(true); } });
  }

  private template(raw: string): string {
    const scrubbed = this.opts.scrub ? safe(() => this.opts.scrub!(raw), raw) : raw;
    return refusalTemplate(scrubbed);
  }

  private record(source: RefusalSource, code: string, text: string | null, context: RefusalContext, sink: RefusalSink, action: number | null): void {
    const key = `${source}|${code}|${context}`;
    const at = this.now();
    if (!this.seen.has(key)) {
      if (this.seen.size >= MAX_REFUSAL_CODES) return;
      this.seen.set(key, null);
      this.post({ source, code, text, context, sink, action, count: 1, firstAt: at, lastAt: at }, true);
      return;
    }
    const p = this.seen.get(key);
    if (p) { p.count++; p.lastAt = at; if (p.action === null) p.action = action; return; }
    this.seen.set(key, { source, code, text, context, sink, action, count: 1, firstAt: at, lastAt: at });
  }

  private post(p: Pending, first: boolean): void {
    if (this.sent >= MAX_REFUSAL_EVENTS) return;
    this.sent++;
    const ev: RefusalEvent = {
      outcome: 'refusal',
      era: safe(this.opts.era, 'unknown'),
      server: safe(this.opts.server, null),
      trace: this.opts.trace,
      build: this.opts.build,
      source: p.source, code: p.code, text: p.text, context: p.context, sink: p.sink, action: p.action,
      count: p.count, first,
      windowMs: Math.max(0, Math.round(p.lastAt - p.firstAt)),
    };
    if (!this.opts.endpoint) return;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
