/**
 * UtilityBelt's AutoVendor (Tools/AutoVendor.cs at 5fe9825a, MIT;
 * docs/vtank-parity-gaps.md §11.2): when a vendor opens, load the loot
 * profile named after the vendor (else `default`) and trade by its rules in
 * rounds: buy, then sell, again until neither has anything left.
 *   - Keep #: buy up to that many (what you carry counts).
 *   - Keep: buy as many as you can afford.
 *   - Sell: sell every one.
 * Cheapest first, trade notes last; a buy that can't all be afforded ends the
 * buy round so the sell round can raise the money; at most 99 items a sell
 * round (GDLE's limit, kept as UB keeps it). Trade notes are sold only to pay
 * for something that isn't a note, one at a time. Navigation is held while it
 * runs (UB's VTank navigation lock).
 *
 * It never sells (UB Util.IsItemSafeToGetRidOf and ItemIsSafeToGetRidOf):
 * worn or wielded items, packs, foci, attuned, retained, inscribed, tinkered
 * or imbued items, rares, items of no value, anything named in
 * AutoVendor.NeverSell, and (with OnlyFromMainPack) anything outside the main
 * pack. Vendor profiles are the routine profile's loot sets (an imported
 * `Vendor Name.utl` keeps the vendor's name).
 */
import type { LootRule } from '@ac/shared';
import type { AgentItem } from '../types.ts';
import { lootRuleFor, type ItemProps } from '../RoutineEngine.ts';

export interface VendorRow { guid: number; name: string; price: number; stack?: number }
export interface VendorItemProps { int?: Record<number, number>; bool?: Record<number, boolean>; string?: Record<number, string>; float?: Record<number, number>; spells?: string[] }

/** ACE PropertyInt / Bool / String ids the never-sell rules read. */
const P_ATTUNED = 114, P_TINKERED = 171, P_IMBUED = 179, P_RARE = 17, P_RETAINED_BOOL = 91, P_INSCRIPTION = 7;
/** ItemType Container (0x200): packs. */
const IT_CONTAINER = 0x200;
/** ObjectDescriptionFlags Retained (0x01000000, ACE ObjectDescriptionFlag.Retained). */
const ODF_RETAINED = 0x01000000;

/** Whether UB would ever sell this item (and ours: not on the never-sell list). */
export function safeToSell(i: AgentItem, props: VendorItemProps | null, o: { neverSell: readonly string[]; onlyMainPack: boolean }): boolean {
  if (i.where === 'equipped') return false;
  if ((i.value ?? 0) <= 0) return false;
  if (o.onlyMainPack && i.where !== 'pack') return false;
  if (((i.itemType ?? 0) & IT_CONTAINER) !== 0) return false;
  if (/^Foci of /i.test(i.name)) return false;
  if (((i.objectDescFlags ?? 0) & ODF_RETAINED) !== 0) return false;
  if (o.neverSell.some((n) => n.trim() && n.trim().toLowerCase() === i.name.toLowerCase())) return false;
  if (props) {
    if ((props.int?.[P_ATTUNED] ?? 0) > 1) return false; // UB: Attuned > 1
    if (props.bool?.[P_RETAINED_BOOL]) return false;
    if ((props.int?.[P_TINKERED] ?? 0) > 1) return false;
    if ((props.int?.[P_IMBUED] ?? 0) > 1) return false;
    if ((props.int?.[P_RARE] ?? 0) > 0) return false; // UB skips rares by their icon underlay
    if (props.string?.[P_INSCRIPTION]) return false;
  }
  return true;
}

const ruleOf = (rules: LootRule[], item: { name: string; value?: number; burden?: number; type?: string }, props?: VendorItemProps | null): LootRule | null =>
  lootRuleFor(rules, { name: item.name, ...(item.value !== undefined ? { value: item.value } : {}), ...(item.burden !== undefined ? { burden: item.burden } : {}), ...(item.type ? { type: item.type } : {}), ...(props ? { props: props as ItemProps } : {}) });

export interface BuyLine { item: VendorRow; amount: number; rule: string }
export interface SellLine { item: AgentItem; rule: string }

/** UB GetBuyItems: Keep # to make up the count carried, Keep without limit; notes last, cheapest first. */
export function buyList(rules: LootRule[], vendor: readonly VendorRow[], inv: readonly AgentItem[]): BuyLine[] {
  const carried = (name: string) => inv.filter((i) => i.name.toLowerCase() === name.toLowerCase()).reduce((n, i) => n + Math.max(1, i.stack ?? 1), 0);
  const out: BuyLine[] = [];
  for (const v of vendor) {
    const r = ruleOf(rules, { name: v.name, value: v.price });
    if (!r) continue;
    if (r.action === 'keep-up-to') {
      const want = (r.count ?? 0) - carried(v.name);
      if (want > 0) out.push({ item: v, amount: want, rule: r.label ?? 'Keep #' });
    } else if (r.action === 'keep') out.push({ item: v, amount: Infinity, rule: r.label ?? 'Keep' });
  }
  return out.sort((a, b) => Number(isNote(a.item.name)) - Number(isNote(b.item.name)) || a.item.price - b.item.price);
}

const isNote = (name: string): boolean => /trade note/i.test(name);

/** UB GetSellItems: Sell rules, never-sell rules applied; notes last, cheapest whole stack first. */
export function sellList(rules: LootRule[], inv: readonly AgentItem[], props: (guid: number) => VendorItemProps | null, o: { neverSell: readonly string[]; onlyMainPack: boolean }): SellLine[] {
  const out: SellLine[] = [];
  for (const i of inv) {
    const p = props(i.guid);
    if (!safeToSell(i, p, o)) continue;
    const r = ruleOf(rules, i, p);
    if (r?.action !== 'sell') continue;
    out.push({ item: i, rule: r.label ?? 'Sell' });
  }
  return out.sort((a, b) => Number(isNote(a.item.name)) - Number(isNote(b.item.name)) || (a.item.value ?? 0) - (b.item.value ?? 0));
}

export const MAX_VENDOR_BUY_COUNT = 5000;
export const MAX_SELL_PER_ROUND = 99;

/**
 * One round of UB DoVendoring: the buys to make now (what the purse and free pack slots allow, notes
 * needing no slot), else the sells. A buy that can't be bought in full ends the list (sell first).
 */
export function vendorRound(o: { buys: BuyLine[]; sells: SellLine[]; pyreals: number; freeSlots: number }): { buy: Array<{ item: VendorRow; amount: number }> } | { sell: AgentItem[]; splitNote?: AgentItem } | null {
  const buy: Array<{ item: VendorRow; amount: number }> = [];
  let spent = 0, slots = 0;
  for (const b of o.buys) {
    const price = b.item.price;
    if (price <= 0) continue;
    const note = isNote(b.item.name);
    if (spent + price > o.pyreals || o.freeSlots - slots <= (note ? 0 : 1)) { if (buy.length) break; else continue; }
    const n = Math.min(Math.floor((o.pyreals - spent) / price), b.amount, MAX_VENDOR_BUY_COUNT);
    if (n <= 0) break;
    buy.push({ item: b.item, amount: n });
    spent += Math.ceil(price * n - 0.1);
    slots += 1;
    if (b.amount > n) break;
  }
  if (buy.length) return { buy };
  const next = o.buys[0];
  const sell: AgentItem[] = [];
  for (const s of o.sells) {
    if (sell.length >= MAX_SELL_PER_ROUND) break;
    if (isNote(s.item.name)) {
      // Notes only pay for something that isn't a note, and one at a time.
      if (!next || isNote(next.item.name)) break;
      if (sell.length) break;
      if ((s.item.stack ?? 1) > 1) return { sell: [], splitNote: s.item };
      sell.push(s.item);
      break;
    }
    sell.push(s.item);
  }
  return sell.length ? { sell } : null;
}

/** AutoVendor's TEST MODE lines (UB DoTestMode). */
export function testModeLines(buys: BuyLine[], sells: SellLine[]): string[] {
  return [
    'AutoVendor TEST MODE',
    'Buy Items:',
    ...(buys.length ? buys.map((b) => `  ${b.item.name} * ${b.amount === Infinity ? '∞' : b.amount} - ${b.rule}`) : ['  (Nothing)']),
    'Sell Items:',
    ...(sells.length ? sells.map((s) => `  ${s.item.name}${(s.item.stack ?? 1) > 1 ? ` * ${s.item.stack}` : ''} - ${s.rule}`) : ['  (Nothing)']),
  ];
}
