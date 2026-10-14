/**
 * Mag-Tools' Auto Add To Trade and Auto Trade Accept (docs/plugin-specs/magtools.md §3.4, §9.2,
 * §9.3), rebuilt from the spec (clean room). UI-free decisions over injected trade state.
 */
import type { LootRule } from '../routines/RoutineDoc.js';
import { MT_TRADE_WHITELIST_KEY, type MtOptionStorage } from './options.js';

// ─── Auto trade accept ───────────────────────────────────────────────

/** The whitelist (global; JSON string[] under MT_TRADE_WHITELIST_KEY). Unreadable storage reads as empty. */
export function readMtTradeWhitelist(store: MtOptionStorage): string[] {
  const raw = store.get(MT_TRADE_WHITELIST_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
export function writeMtTradeWhitelist(store: MtOptionStorage, patterns: readonly string[]): void {
  store.set(MT_TRADE_WHITELIST_KEY, JSON.stringify(patterns.filter((p) => p.trim() !== '')));
}

/**
 * Whether a name fully matches any whitelist regex (case-sensitive, .NET's default). Upstream
 * pastes `^` + text + `$`, so `Mule|Bob` there would also take "Mulex"; ours groups the text
 * (`^(?:…)$`), the full match the spec describes. A bad regex matches nothing.
 */
export function mtTradeWhitelistMatches(name: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    try { if (new RegExp(`^(?:${p})$`).test(name)) return true; } catch { /* not a regex: skip it */ }
  }
  return false;
}

/**
 * The whitelist editor's Add (ours: upstream had no UI, users hand-edited Mag-Tools.xml; spec §3.4). The
 * text is trimmed; a blank or an entry already listed is ignored (`changed: false`, no error); text that
 * isn't a regex, on its own or wrapped as mtTradeWhitelistMatches wraps it, is refused with an error
 * message (the caller prints it as a Mag-Tools line). Otherwise the list with the entry appended.
 */
export function mtTradeWhitelistAdd(list: readonly string[], text: string): { list: string[]; changed: boolean; error?: string } {
  const p = text.trim();
  if (p === '' || list.includes(p)) return { list: [...list], changed: false };
  try { new RegExp(p); new RegExp(`^(?:${p})$`); } catch {
    return { list: [...list], changed: false, error: `Auto Trade Accept - "${p}" is not a valid regular expression.` };
  }
  return { list: [...list, p], changed: true };
}

/** At least this long between two auto-accepts. */
export const MT_AUTO_ACCEPT_GAP_MS = 2000;

/**
 * Auto Trade Accept: feed it each AcceptTrade event (someone pressed Accept). True when we should
 * accept too: the option is on, the one who accepted is the partner (not me), 2 s have passed since
 * the last auto-accept, and the partner's name fully matches a whitelist regex.
 */
export class MtAutoTradeAccept {
  private last = -Infinity;
  constructor(private readonly now: () => number) {}

  accepted(e: { enabled: boolean; whoAccepted: string; me: string; partner: string; whitelist: readonly string[] }): boolean {
    if (!e.enabled || e.whoAccepted === e.me || e.whoAccepted !== e.partner) return false;
    const t = this.now();
    if (t - this.last < MT_AUTO_ACCEPT_GAP_MS) return false;
    if (!mtTradeWhitelistMatches(e.partner, e.whitelist)) return false;
    this.last = t;
    return true;
  }
}

// ─── Auto add to trade ───────────────────────────────────────────────

export interface MtTradeItem { id: number; name: string; equipped: boolean }

/** A profile's answer for one item: only Keep (not Keep #) adds it. */
export type MtTradeVerdict = 'keep' | 'no' | 'appraise';

/** A matched loot rule as the trade verdict: action keep only. */
export function mtTradeRuleVerdict(rule: LootRule | null): 'keep' | 'no' {
  return rule && !rule.disabled && rule.action === 'keep' ? 'keep' : 'no';
}

export const MT_TRADE_ADD_DONE = 'Auto Add To Trade - Inventory scan complete.';

export interface MtAutoTradeAddHost {
  /** What you carry. */
  inventory(): MtTradeItem[];
  /** The partner's profile (`<PartnerName>.utl`) as a verdict function, or null when there is none. */
  profile(partner: string): ((item: MtTradeItem) => MtTradeVerdict) | null;
  /** Add an item to the trade window. */
  add(id: number): void;
  appraise(id: number): void;
  /** A `<{Mag-Tools}>: ` line. */
  print(text: string): void;
}

/**
 * Auto Add To Trade. `opened` on RegisterTrade: it runs only when I initiated (so a mule trading
 * back doesn't re-add). Then one `step()` per 100 ms adds one Keep item; when every item is
 * decided it prints the done line and stops. `ended` on trade close.
 */
export class MtAutoTradeAdd {
  private verdict: ((item: MtTradeItem) => MtTradeVerdict) | null = null;
  private readonly added = new Set<number>();
  private readonly asked = new Map<number, number>();

  constructor(private readonly host: MtAutoTradeAddHost, private readonly now: () => number, private readonly appraiseMs = 10000) {}

  get running(): boolean { return this.verdict !== null; }

  /** A trade opened. False when it doesn't start (option off, the partner initiated, no profile). */
  opened(e: { enabled: boolean; iInitiated: boolean; partner: string }): boolean {
    this.ended();
    if (!e.enabled || !e.iInitiated) return false;
    this.verdict = this.host.profile(e.partner);
    return this.verdict !== null;
  }

  ended(): void { this.verdict = null; this.added.clear(); this.asked.clear(); }

  /** One tick: 'added', 'appraising', 'done' (just finished) or 'idle'. */
  step(): 'added' | 'appraising' | 'done' | 'idle' {
    const v = this.verdict;
    if (!v) return 'idle';
    const t = this.now();
    const waiting: number[] = [];
    for (const item of this.host.inventory()) {
      if (item.equipped || this.added.has(item.id)) continue;
      const r = v(item);
      if (r === 'keep') { this.added.add(item.id); this.host.add(item.id); return 'added'; }
      if (r === 'appraise') {
        const at = this.asked.get(item.id);
        if (at === undefined) { this.asked.set(item.id, t); this.host.appraise(item.id); waiting.push(item.id); }
        else if (t - at < this.appraiseMs) waiting.push(item.id);
      }
    }
    if (waiting.length) return 'appraising';
    this.verdict = null;
    this.host.print(MT_TRADE_ADD_DONE);
    return 'done';
  }
}
