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
 * Privacy: the text is a template. A line the client built from one of its own
 * templates is keyed by that template, every name slot '_' (RefusalTemplates.ts
 * matchClientTemplate: the attempt-failed, paperdoll, UseObject and notice tables of
 * both eras), so one refusal keeps one code whatever item it named. Names of every
 * object the client knows (items in the world, the pack and the paperdoll, creatures,
 * players, the player's own) become '_' through the `scrub` main.ts passes; every number becomes '#'; anything outside printable ASCII is dropped;
 * WeenieErrorWithString sends the code's template, never the substituted value. Then, whatever the context
 * (TELEMETRY.refusal-name-safety, after ACE's loot-consent notice sent eight players' names on 2026-10-23):
 * only words the retail / server templates vouch for survive (RefusalTemplates.nameSafeText); every other
 * word, a quoted string, a leading subject becomes '_', and a line that can't be made name-free goes with
 * text null. The bridge drops a text that still carries an unknown capitalized word.
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
import { isUseStatusNotice } from '../input/UseObject.js';
import {
  matchClientTemplate, isUseHintNotice, isTargetPromptNotice, isServerTextNotice, nameSafeText, cleanRefusalDetail, type RefusalDetail,
} from './RefusalTemplates.js';

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
/** A server refusal this soon after a request names that request as its `action` (TELEMETRY.refusal-context). */
export const SERVER_REFUSAL_ACTION_MS = 3_000;

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
  /** TELEMETRY.refusal-context — the closed context fields (RefusalTemplates.ts RefusalDetail), when known. */
  pending?: RefusalDetail['pending'];
  pendingMs?: number;
  spellTargetType?: number;
  selection?: RefusalDetail['selection'];
  selectionType?: number;
  prevSelection?: RefusalDetail['prevSelection'];
  prevSelectionType?: number;
  selectionGoneMs?: number;
  castInput?: RefusalDetail['castInput'];
  castGapMs?: number;
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
export const NOT_REFUSAL: readonly RegExp[] = [
  /^AutoRun (ON|OFF)$/,
  /^Casting /,
  /Portal Storm/i,
  /^In Portal Space/,
  /^Removing .* from shopping list$/,
  /^Some game data for this area could not be downloaded/,
  // TELEMETRY.refusal-trade-notices (2026-10-23): Handle_Trade__Recv_CloseTrade @ 0056de30 posts this (0x1a) on every
  // CloseTrade, whatever the end reason (ServerMessageText.ts TRADE_CLOSED_TEXT): the trade window's state, not a refusal.
  /^The trade has been cancelled\.$/,
  // The auto-wield's own status line ("Moving %s to your backpack", acclient.exe 0x3ccd38; main.ts) when the slot's
  // old item goes to the pack first. The " - cannot unwield the %s" form is a failure and stays reported.
  /^Moving .+ to your backpack$/,
];

/**
 * WeenieError / WeenieErrorWithString codes that are notices, not refusals: the server reports a success or a state
 * change through the error messages (ACE.Entity/Enum/WeenieError.cs, WeenieErrorWithString.cs). Every end-of-retail
 * and Dark Majesty login posted two as client refusals until 2026-10-23 (found by tools/ac1999-playthrough.ts):
 * ACE Player_Networking.cs sends TurbineChatIsEnabled (0x51D) on login (line 88) and YouHaveEnteredThe_Channel
 * (0x51B) for each channel it joins you to (line 182). The rest, by the enum's own text and ACE's senders:
 * links made (Lifestone 0x49D, Portal 0x4A1: the lifestone / portal "Tie" uses), skill and attribute alterations
 * that worked (SkillAlterationDevice.cs: 0x4D6-0x4D9, 0x55B / 0x55C augmentations, 0x4E1 attribute transfer), the
 * hear-list and squelch toggles (0x521-0x524), PK Lite (0x508), the fellowship's open / closed / leader notices
 * (Fellowship.cs: 0x50B-0x50D), channel joins and leaves (GameActionAddChannel / RemoveChannel: 0x51B / 0x51C),
 * snooping (0x52C) and allegiance status changes (0x534, 0x539, 0x541, 0x549, 0x56B, 0x56E, 0x575, 0x57B).
 *
 * TELEMETRY.refusal-trade-notices (2026-10-23, production on an end-of-retail ACE server): the trade flow's steps.
 * ACE WorldObjects/Player_Trade.cs sends TradeClosed (0x451, "Trade closed.") on every HandleActionCloseTradeNegotiations
 * (line 113: the window closing, beside CloseTrade) and TradeComplete (0x529, "Trade Complete!") to both sides when
 * FinalizeTrade commits (267-268); GDLE and the AC1999 server send 0x529 too (TradeManager.cpp 221-222). Opening
 * (RegisterTrade), adding an item (AddToTrade) and reset (ResetTrade) carry no text. Trade refusals stay reported:
 * TradeIgnoringRequests 0x44C, TradeAlreadyTrading, TradeNonCombatMode 0x455, TradeMaxDistanceExceeded.
 * The same sweep, success or state-change notices by their text and senders:
 * - PK status changes: 0x4F1 "You are once more a player killer" / 0x4F2 "temporarily no longer a player killer"
 *   (ACE Player_Death.cs 967 / 1009, GDLE PK_SWITCH_AUTO_PK / RESPITE), 0x504 "once again a Non-Player Killer"
 *   (Player_Networking.cs 68, Player_Death.cs 972); the protections 0x502 (Player_Death.cs 915
 *   HandleLifestoneProtection, GDLE LIFESTONE_PROTECTION) and 0x503 (the portal's twin).
 * - house hooks after a successful hook / unhook (Player_Inventory.cs 1108-1134): 0x512 / 0x513 and, with a
 *   hook group, 0x514 / 0x515.
 * - fellowship: 0x50E "You have passed leadership of the fellowship to _" (Fellowship.cs 384 / 404).
 * - allegiance (GDLE's senders; ACE has none): dissolved / patron broken 0x496 / 0x497, officers cleared 0x546,
 *   no longer an officer 0x54A / 0x543, titles cleared 0x572, unbanned 0x53A, the banned list 0x53B, the lock's
 *   display 0x574, pre-approved 0x578, pre-approval cleared 0x57C, chat privileges restored 0x581 / 0x582 / 0x583;
 *   snooping stopped 0x52D.
 * Everything else, including a punishment's notice (booted 0x533, gagged 0x57F / 0x580) and the channel refusals
 * (0x422-0x425, 0x548, 0x551), stays reported.
 */
export const NOT_REFUSAL_CODES: Readonly<{ weenie_error: ReadonlySet<number>; weenie_error_str: ReadonlySet<number> }> = Object.freeze({
  weenie_error: new Set([
    0x049d, 0x04a1, 0x04e1, 0x0508, 0x051d, 0x0523, 0x0524, 0x056b,
    // TELEMETRY.refusal-trade-notices
    0x0451, 0x0529, 0x0496, 0x0497, 0x04f1, 0x04f2, 0x0502, 0x0503, 0x0504, 0x0512, 0x0513, 0x0546, 0x054a, 0x0572,
    0x057c, 0x0581,
  ]),
  weenie_error_str: new Set([
    0x04d6, 0x04d7, 0x04d8, 0x04d9, 0x050b, 0x050c, 0x050d, 0x051b, 0x051c, 0x0521, 0x0522, 0x052c,
    0x0534, 0x0539, 0x0541, 0x0549, 0x055b, 0x055c, 0x056e, 0x0575, 0x057b,
    // TELEMETRY.refusal-trade-notices
    0x050e, 0x0514, 0x0515, 0x052d, 0x053a, 0x053b, 0x0543, 0x0574, 0x0578, 0x0582, 0x0583,
  ]),
});

/** Whether a server code in a context is a notice (NOT_REFUSAL_CODES), not a refusal. */
export function isNoticeCode(context: string, code: number): boolean {
  const set = context === 'weenie_error' ? NOT_REFUSAL_CODES.weenie_error : context === 'weenie_error_str' ? NOT_REFUSAL_CODES.weenie_error_str : null;
  return !!set && set.has(code >>> 0);
}

/**
 * A spew line that is a notice, not a refusal: NOT_REFUSAL, or a use's own status line ("Approaching %s" /
 * "Using the %s", UseObject.ts USE_STATUS_TEMPLATES, from the client's literals). Every use reported
 * "Approaching _" / "Using the _" as a refusal until 2026-10-23 (found by tools/ac1999-playthrough.ts).
 */
export function isSpewNotice(text: string): boolean {
  return NOT_REFUSAL.some((re) => re.test(text)) || isUseStatusNotice(text) || isUseHintNotice(text) || isTargetPromptNotice(text);
}

/**
 * A server text line that reads as a refusal. GDLE's and the AC1999 server's SendText refusals
 * ("You can't do that yet!", "Not enough pack space!", "Your Lockpicking skill is too low for that.").
 * Anchored at the line's start (TELEMETRY.refusal-name-safety): until 2026-10-23 the alternatives
 * `permission`, `too (busy|…)` and `not (allowed|…)` matched anywhere, so ACE's loot-consent notice
 * "Reemer has given you permission to loot his or her kills." counted, a player's name with it.
 */
export const REFUSAL_TEXT = /^(you (can't|cannot|can not|can only|do not|don't|are not|aren't|are too|are unable|are encumbered|must|lack|have no|need|may not|fail)\b|you're (too|not|unable)\b|your [a-z' -]{1,40} (is|are) (too|not)\b|not enough\b|unable\b|invalid\b|only |can't\b|cannot\b|couldn't\b|could not\b|you have not\b|there(?:'s| is) not enough\b|this (command )?is not\b|that (can't|cannot|is not|isn't)\b|that [a-z ]{1,30} (is|are) too (far|heavy|low|high)\b|[^.!?\n]{0,80}\btoo (recently|soon)\b)/i;

/**
 * A refusal led by someone or something's name: "Reemer is too busy to accept gifts right now.",
 * "Ming Masun cannot …" (a run of capitalized words, then the refusal's predicate). The subject leaves as '_'
 * (RefusalTemplates.nameSafeText).
 */
export const NAME_FIRST_REFUSAL = /^[A-Z][A-Za-z'-]*(?: (?:[A-Z][A-Za-z'-]*|of|the|de|du|van|von|al))* (?:(?:is|are) (?:too busy|not (?:accepting|allowed|permitted|able)|unable)\b|(?:cannot|can't|can not|won't|will not|may not|refuses)\b)/;

/**
 * Whether a server text line (chat type `chatType`, null for a transient) is a refusal: never a known
 * notice (the loot-consent family, the target-mode prompt, NOT_REFUSAL); a transient or an error-type
 * (0x1a) line otherwise is; any other line only in a refusal's wording.
 */
export function isServerTextRefusal(text: string, chatType: number | null, transient = false): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (NOT_REFUSAL.some((re) => re.test(raw)) || isServerTextNotice(raw)) return false;
  if (transient || chatType === 0x1a) return true;
  return REFUSAL_TEXT.test(raw) || NAME_FIRST_REFUSAL.test(raw);
}

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
  detail: RefusalDetail | null;
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
  private detail: RefusalDetail | null = null;
  private lastSent: { action: number; at: number; detail: RefusalDetail | null } | null = null;

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

  /**
   * Run `f` with `detail` (TELEMETRY.refusal-context: the pending request, the cast's target type and
   * selection) as the context of any refusal it raises. Only RefusalDetail's closed fields are kept.
   */
  withDetail<T>(detail: RefusalDetail | null, f: () => T): T {
    const before = this.detail;
    const clean = cleanRefusalDetail(detail);
    this.detail = Object.keys(clean).length > 0 ? { ...(before ?? {}), ...clean } : before;
    try { return f(); } finally { this.detail = before; }
  }

  /**
   * A GameAction went to the server (main.ts serializeTrackedGameAction). A server refusal within
   * SERVER_REFUSAL_ACTION_MS carries it as `action`, so "You're too busy!" says what it answered.
   */
  noteActionSent(action: number): void {
    if (!Number.isInteger(action) || action < 0 || action > MAX_ACTION) return;
    // The context the request went out in (a cast press's source and cadence) answers for its refusal too.
    this.lastSent = { action, at: this.now(), detail: this.detail };
  }

  private recentAction(): number | null {
    const l = this.lastSent;
    return l && this.now() - l.at <= SERVER_REFUSAL_ACTION_MS ? l.action : null;
  }

  /** A server refusal's context: the one it was raised in, else the request it answered. */
  private serverDetail(): RefusalDetail | null {
    if (this.detail) return this.detail;
    const l = this.lastSent;
    return l && this.now() - l.at <= SERVER_REFUSAL_ACTION_MS ? l.detail : null;
  }

  /** GameUI.displayErrorText's tap: a line the client put in the spew box. */
  clientSpew(text: string): void {
    if (this.quietDepth > 0 || typeof text !== 'string') return;
    const raw = text.trim();
    if (!raw || isSpewNotice(raw)) return;
    const t = this.template(raw);
    if (!t) return;
    this.record('client', `c:${refusalHash(t.key)}`, t.text, 'spew', 'spew', this.action, this.detail);
  }

  /**
   * A server refusal by code: WeenieError, WeenieErrorWithString, a non-zero UseDone, an
   * InventoryServerSaveFailed. `template` is the code's own text (with '_' for a WithString value).
   */
  serverCode(context: Exclude<RefusalContext, 'spew' | 'server_text' | 'transient'>, code: number, template: string | null, sink: RefusalSink): void {
    if (!Number.isFinite(code)) return;
    if (isNoticeCode(context, code)) return;
    const t = template ? this.template(template) : null;
    this.record('server', weenieCode(code), t?.text ?? null, context, sink, this.recentAction(), this.serverDetail());
  }

  /** A server text line (chat type `chatType`) or transient string; kept when it reads as a refusal. */
  serverText(context: 'server_text' | 'transient', text: string, chatType: number | null): void {
    if (typeof text !== 'string') return;
    const raw = text.trim();
    if (!raw) return;
    if (!isServerTextRefusal(raw, chatType, context === 'transient')) return;
    const t = this.template(raw);
    if (!t) return;
    this.record('server', `t:${refusalHash(t.key)}`, t.text, context, context === 'transient' || chatType === 0x1a ? 'spew' : 'chat', this.recentAction(), this.serverDetail());
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

  /**
   * TELEMETRY.refusal-name-keying — the client template the line came from first (every name slot
   * '_', RefusalTemplates.matchClientTemplate), then every name the client knows ('_'), then numbers.
   */
  private template(raw: string): { text: string | null; key: string } | null {
    const keyed = safe(() => matchClientTemplate(raw), raw);
    const scrubbed = this.opts.scrub ? safe(() => this.opts.scrub!(keyed), keyed) : keyed;
    const t = refusalTemplate(scrubbed);
    if (!t) return null;
    // TELEMETRY.refusal-name-safety — then name-free by construction (RefusalTemplates.nameSafeText): the server
    // template it came from, a leading subject as '_', only the vocabulary's words. `text` null when too little
    // is left to vouch for; `key` (the code's hash input) is the scrubbed text either way, never the raw line.
    const safeText = safe(() => nameSafeText(t), null);
    if (!safeText) return { text: null, key: 'unscrubbable' };
    const text = safeText.text ? refusalTemplate(safeText.text) || null : null;
    return { text, key: safeText.scrubbed || 'speech' };
  }

  private record(source: RefusalSource, code: string, text: string | null, context: RefusalContext, sink: RefusalSink, action: number | null, detail: RefusalDetail | null = null): void {
    const key = `${source}|${code}|${context}`;
    const at = this.now();
    if (!this.seen.has(key)) {
      if (this.seen.size >= MAX_REFUSAL_CODES) return;
      this.seen.set(key, null);
      this.post({ source, code, text, context, sink, action, detail, count: 1, firstAt: at, lastAt: at }, true);
      return;
    }
    const p = this.seen.get(key);
    if (p) { p.count++; p.lastAt = at; if (p.action === null) p.action = action; if (p.detail === null) p.detail = detail; return; }
    this.seen.set(key, { source, code, text, context, sink, action, detail, count: 1, firstAt: at, lastAt: at });
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
      ...(p.detail ?? {}),
    };
    if (!this.opts.endpoint) return;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
