/**
 * VirindiTank's timers for buffs on items (its BuffedItems; facts from MOSS
 * ItemEnchantLedger / ItemEnchantPersistenceStore, no code copied).
 *
 * A bane, an impenetrability or a weapon spell cast on an item puts the
 * enchantment on that item, not on you, and the client is never told how long
 * an item's enchantment has left: the effects list shows only your own. So,
 * as VTank does, the macro keeps a timer per item for each confirmed cast:
 *
 * - A cast is recorded only on the server's success line, which names each
 *   item it went on ("You cast Acid Bane on Leather Coat"): a cast on yourself
 *   is redirected to every worn piece the spell fits (ACE
 *   TryCastSpell_WithRedirects; GDLE the same), one line per piece.
 * - The record is (item, family, spell) → expiry at cast time + the spell's
 *   duration, with the spell's power; a new cast replaces it only when it ends
 *   later. A family counts as up on an item while a record of at least the
 *   wanted power has time left (the longest one).
 * - Records are kept per character in browser storage with wall-clock expiries,
 *   so they survive a reload or a relog; an expired one is dropped, and a
 *   record whose item now has another name is not that item any more.
 * - Death clears them all (ACE strips item enchantments with the rest), as
 *   VTank's death handler does; so does a clock that went backwards.
 */

export interface ItemRef { guid: number; name: string }

interface Row { item: number; name: string; category: number; spellId: number; power: number; at: number; until: number }

/** Where the records live: browser storage (memory only when it is unavailable). */
export interface LedgerStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void }

const VERSION = 1;
/** Every character's records are under this localStorage prefix (the agent daemon carries it across launches: pageStorage.ts). */
export const ITEM_TIMERS_KEY_PREFIX = 'acjs.vtank.itemTimers.';
const key = (char: { guid: number; name: string }): string => `${ITEM_TIMERS_KEY_PREFIX}v${VERSION}.${char.name.trim().toLowerCase()}.${(char.guid >>> 0).toString(16)}`;
const defaultStore = (): LedgerStore | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export class ItemBuffLedger {
  private rows = new Map<string, Row>();
  private bound: string | null = null;
  private lastWall = -Infinity;

  constructor(private readonly wall: () => number = () => Date.now(), private readonly store: () => LedgerStore | null = defaultStore) {}

  /** Load the character's records (once per character); a different character starts from its own. */
  bind(char: { guid: number; name: string }): void {
    const k = key(char);
    if (this.bound === k) return;
    this.bound = k;
    this.rows.clear();
    const now = this.observe();
    let raw: string | null = null;
    try { raw = this.store()?.getItem(k) ?? null; } catch { /* storage blocked */ }
    if (!raw) return;
    try {
      const doc = JSON.parse(raw) as { v?: number; rows?: Row[] };
      if (doc.v !== VERSION || !Array.isArray(doc.rows)) throw new Error('schema');
      for (const r of doc.rows) {
        if (!(r.until > now)) continue;
        // Recorded in the future: the clock went back since. Nothing stored can be trusted.
        if (r.at > now + 60_000) { this.rows.clear(); break; }
        this.rows.set(rowKey(r.item, r.category, r.spellId), r);
      }
    } catch { this.rows.clear(); }
    this.save();
  }

  /** A confirmed cast of `spell` on `items` (VTank: only a success is recorded; a longer record is kept). */
  note(items: ItemRef[], spell: { id: number; category: number; power: number; duration: number }): void {
    if (!(spell.duration > 0) || !Number.isFinite(spell.duration)) return;
    const now = this.observe();
    const until = now + spell.duration * 1000;
    let changed = false;
    for (const it of items) {
      const k = rowKey(it.guid, spell.category, spell.id);
      const had = this.rows.get(k);
      if (had && had.name.toLowerCase() === it.name.toLowerCase() && had.until >= until) continue;
      this.rows.set(k, { item: it.guid, name: it.name, category: spell.category, spellId: spell.id, power: spell.power, at: now, until });
      changed = true;
    }
    if (changed) this.save();
  }

  /** Seconds left on `category` (at least `power`) on one item, or null when no record covers it. */
  remainingOn(item: ItemRef, category: number, power: number): number | null {
    const now = this.observe();
    let best: number | null = null;
    for (const [k, r] of this.rows) {
      if (r.item !== item.guid) continue;
      if (r.name.toLowerCase() !== item.name.toLowerCase()) { this.rows.delete(k); this.save(); continue; }
      if (r.category !== category || r.power < power || r.until <= now) continue;
      const left = (r.until - now) / 1000;
      if (best === null || left > best) best = left;
    }
    return best;
  }

  /** Seconds left on `category` over every item (the shortest), or null when any of them has none. */
  remainingOnAll(items: ItemRef[], category: number, power: number): number | null {
    if (!items.length) return null;
    let worst = Infinity;
    for (const it of items) {
      const left = this.remainingOn(it, category, power);
      if (left === null) return null;
      worst = Math.min(worst, left);
    }
    return worst;
  }

  /** Drop expired records. */
  expire(): void {
    const now = this.observe();
    let changed = false;
    for (const [k, r] of this.rows) if (r.until <= now) { this.rows.delete(k); changed = true; }
    if (changed) this.save();
  }

  /** Death (or anything else that strips item enchantments): every record goes. */
  clear(): void {
    if (!this.rows.size) return;
    this.rows.clear();
    this.save();
  }

  get size(): number { return this.rows.size; }

  /** The wall clock, clearing everything when it went backwards (a record's time left can't be trusted then). */
  private observe(): number {
    const now = this.wall();
    if (now < this.lastWall - 60_000) { this.rows.clear(); this.save(); }
    this.lastWall = now;
    return now;
  }

  private save(): void {
    if (!this.bound) return;
    try {
      const s = this.store();
      if (!s) return;
      if (!this.rows.size && s.removeItem) s.removeItem(this.bound);
      else s.setItem(this.bound, JSON.stringify({ v: VERSION, rows: [...this.rows.values()] }));
    } catch { /* storage full or blocked: the timers still work for this session */ }
  }
}

const rowKey = (item: number, category: number, spellId: number): string => `${item >>> 0}:${category}:${spellId}`;
