/**
 * Mag-Tools' Trackers → Inv. Items (docs/plugin-specs/magtools.md §5.5), rebuilt clean-room from the
 * spec's facts: the inventory's pyreal value (Peas, Comps, Salvage, Net Profit) as MMD per hour, and
 * the consumables' count, burn per hour and hours left, from inventory snapshots the host hands in.
 *
 * Ours, where it differs: a value series keeps 60 minutes of history (upstream passes 60 to its
 * snapshot group and never prunes, spec §12 #10).
 */
import { mtN } from './format.js';
import { MtObjectClass } from './itemInfo.js';

/** One inventory item as the tracker reads it (packs and wielded items alike). */
export interface MtInvItem {
  id: number;
  name: string;
  /** Decal ObjectClass (MtObjectClass). */
  objectClass: number;
  /** portal.dat icon id (0x06…), for the consumable rows. */
  icon?: number;
  /** PropertyInt StackSize (12); 1 when absent. */
  stackSize?: number;
  /** PropertyInt Value (19): the whole stack's pyreal value. */
  value?: number;
}

/** One MMD (a 250,000-pyreal trade note): the profit rows' unit. */
export const MT_MMD = 250_000;
/** The two windows the rates look back over. */
export const MT_RATE_5M = 5 * 60_000;
export const MT_RATE_1H = 60 * 60_000;
/** The list's column widths (InventoryTrackerGUI: Icon 16, then text 55 / 35 / 65 / 65 / 40). */
export const MT_INV_COLUMNS = [16, 55, 35, 65, 65, 40] as const;

/** A value over time: snapshots, and the per-hour change against the one nearest a time ago (ValueSnapShotGroup, spec §5.5). */
export class MtValueSeries {
  private snaps: Array<{ t: number; v: number }> = [];
  constructor(private readonly keepMs = MT_RATE_1H) {}

  add(t: number, v: number): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && last.t === t) last.v = v;
    else this.snaps.push({ t, v });
    // Prune past the retention, keeping the newest snapshot older than it (the 1 h rate's reference).
    const cut = t - this.keepMs;
    let drop = 0;
    while (drop + 1 < this.snaps.length && this.snaps[drop + 1]!.t <= cut) drop++;
    if (drop) this.snaps.splice(0, drop);
  }

  latest(): number { return this.snaps[this.snaps.length - 1]?.v ?? 0; }
  get size(): number { return this.snaps.length; }

  /** `(latest − nearest(now − H)) × 60 min ÷ minutes since that snapshot`; 0 with no history. */
  perHour(now: number, horizonMs: number): number {
    if (!this.snaps.length) return 0;
    const target = now - horizonMs;
    let ref = this.snaps[0]!;
    for (const s of this.snaps) if (Math.abs(s.t - target) < Math.abs(ref.t - target)) ref = s;
    const minutes = (now - ref.t) / 60_000;
    if (minutes <= 0) return 0;
    return (this.latest() - ref.v) * (60 / minutes);
  }
}

/** The four profit rows (ProfitLossTracker). */
export const MT_PROFIT_ROWS = ['Peas', 'Comps', 'Salvage', 'Net Profit'] as const;
export type MtProfitRow = typeof MT_PROFIT_ROWS[number];

/** Which profit totals an item adds its Value to. */
export function mtProfitGroups(item: MtInvItem): MtProfitRow[] {
  const out: MtProfitRow[] = [];
  const c = item.objectClass;
  if (c === MtObjectClass.SpellComponent) out.push(item.name.includes('Pea') ? 'Peas' : 'Comps');
  if (c === MtObjectClass.Salvage) out.push('Salvage');
  if (c === MtObjectClass.SpellComponent || c === MtObjectClass.Salvage || c === MtObjectClass.TradeNote || c === MtObjectClass.Money) out.push('Net Profit');
  return out;
}

/**
 * The consumable group an item counts toward and its class order (spell comps, mana stones, healing
 * kits, trade notes, salvage, others), or null when it isn't tracked (InventoryTracker, spec §5.5).
 */
export function mtConsumableGroup(item: MtInvItem): { name: string; order: number } | null {
  const c = item.objectClass;
  const n = item.name;
  if (c === MtObjectClass.SpellComponent && (n.includes('Taper') || n.includes('Scarab'))) return { name: n, order: 0 };
  if (c === MtObjectClass.ManaStone) return { name: n, order: 1 };
  if (c === MtObjectClass.HealingKit) return { name: n, order: 2 };
  if (n.includes('Trade Note')) return { name: 'Trade Note', order: 3 };
  if (n.includes('Salvage')) return { name: 'Salvage', order: 4 };
  if (c === MtObjectClass.Misc && (n === 'Corrupted Essence' || n === 'Lesser Corrupted Essence')) return { name: 'Corrupted Essence', order: 5 };
  return null;
}

/** A list row: the icon (column 0) and the five text cells. */
export interface MtInvRow {
  icon?: number;
  cells: [string, string, string, string, string];
  /** Set on consumable rows: the group's name. */
  group?: string;
}

interface Group { name: string; order: number; icon?: number; count: number; unitValue: number; series: MtValueSeries }

const n1 = (v: number) => mtN(v, 1);
const blankZero = (v: number) => (v === 0 ? '' : n1(v));

export class MtInventoryTracker {
  private readonly profit = new Map<MtProfitRow, MtValueSeries>(MT_PROFIT_ROWS.map((r) => [r, new MtValueSeries()]));
  private readonly groups = new Map<string, Group>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Start over (a new login: the history belongs to the character that made it). */
  reset(): void {
    for (const r of MT_PROFIT_ROWS) this.profit.set(r, new MtValueSeries());
    this.groups.clear();
  }

  /** The whole inventory as it is now; call on any create, change or release of an item you carry. */
  update(items: readonly MtInvItem[], t = this.now()): void {
    const totals = new Map<MtProfitRow, number>(MT_PROFIT_ROWS.map((r) => [r, 0]));
    const counts = new Map<string, { order: number; icon?: number; count: number; value: number }>();
    for (const it of items) {
      const value = it.value ?? 0;
      for (const g of mtProfitGroups(it)) totals.set(g, totals.get(g)! + value);
      const cg = mtConsumableGroup(it);
      if (!cg) continue;
      const stack = Math.max(1, it.stackSize ?? 1);
      const cur = counts.get(cg.name) ?? { order: cg.order, count: 0, value: 0 };
      if (cur.icon === undefined && it.icon !== undefined) cur.icon = it.icon;
      cur.count += stack;
      cur.value += value;
      counts.set(cg.name, cur);
    }
    for (const r of MT_PROFIT_ROWS) this.profit.get(r)!.add(t, totals.get(r)!);
    // A group once seen stays listed (its count at 0, its cells blank).
    for (const [name, g] of this.groups) if (!counts.has(name)) { g.count = 0; g.series.add(t, 0); }
    for (const [name, c] of counts) {
      let g = this.groups.get(name);
      if (!g) { g = { name, order: c.order, count: 0, unitValue: 0, series: new MtValueSeries() }; this.groups.set(name, g); }
      g.count = c.count;
      if (c.icon !== undefined) g.icon = c.icon;
      if (c.count > 0) g.unitValue = c.value / c.count;
      g.series.add(t, c.count);
    }
  }

  /** A profit row's MMD per hour over ~5 min / ~1 h. */
  profitPerHour(row: MtProfitRow, horizonMs: number, now = this.now()): number {
    return this.profit.get(row)!.perHour(now, horizonMs) / MT_MMD;
  }

  /** The consumable groups in list order (class, then higher per-unit value first). */
  consumables(): Array<{ name: string; icon?: number; count: number; perHour5m: number; perHour1h: number; hoursLeft: number | null }> {
    const now = this.now();
    return [...this.groups.values()]
      .sort((a, b) => a.order - b.order || b.unitValue - a.unitValue || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((g) => {
        const perHour1h = g.series.perHour(now, MT_RATE_1H);
        return {
          name: g.name, ...(g.icon !== undefined ? { icon: g.icon } : {}), count: g.count,
          perHour5m: g.series.perHour(now, MT_RATE_5M), perHour1h,
          hoursLeft: perHour1h < 0 && g.count > 0 ? g.count / -perHour1h : null,
        };
      });
  }

  /** The list, row for row (spec §5.5's layout). */
  rows(): MtInvRow[] {
    const now = this.now();
    const rows: MtInvRow[] = [{ cells: ['', '', 'MMD/h ~5m', 'MMD/h ~1h', ''] }];
    for (const r of MT_PROFIT_ROWS) rows.push({ cells: [r, '', blankZero(this.profitPerHour(r, MT_RATE_5M, now)), blankZero(this.profitPerHour(r, MT_RATE_1H, now)), ''] });
    rows.push({ cells: ['', '', '', '', ''] });
    rows.push({ cells: ['', 'Count', 'Avg/h ~5m', 'Avg/h ~1h', '(Hrs)'] });
    for (const c of this.consumables()) {
      const has = c.count > 0;
      rows.push({
        ...(c.icon !== undefined ? { icon: c.icon } : {}), group: c.name,
        cells: [c.name, has ? String(c.count) : '', has ? n1(c.perHour5m) : '', has ? n1(c.perHour1h) : '', has && c.hoursLeft !== null ? n1(c.hoursLeft) : ''],
      });
    }
    return rows;
  }
}
