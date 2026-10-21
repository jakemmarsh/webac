/**
 * FillComponentList — the vendor "fill components" routine (`@fillcomps`,
 * gmVendorUI::RecvNotice_FillComponentBuyList → gmVendorUI::FillComponentList
 * @ 004c4540, decomp acclient-decompiled.annotated.c ~190227–190399), ported
 * as a pure function from the decompiled end-of-retail client. The caller
 * (ClientCommunicationSystem::DoFillComponents, ported in
 * chat/commands/EmoteStatusCommands.ts) passes a SpellComponentCategory
 * (8 = Undef = every category) and a max price (0 = no cap).
 *
 * What retail does, in order:
 *  1. No open vendor (gmVendorUI::shopVendorID == 0): AddTextToScroll(
 *     "You need an open vendor.", 0x1a, true, 0) and stop.
 *  2. VendorItemsUI::UpdateItemsList(m_itemsUI, 0x1000, false): the
 *     merchandise view filters to ItemType SpellComponents (UI only).
 *  3. Walk PlayerModule's desired-comp PackableHashTable (wcid → desired
 *     count) in hash order (see desiredCompIterationOrder). At the TOP of
 *     every step, before anything else, `maxPrice <= runningTotal &&
 *     maxPrice != 0` → PackableList::RemoveTail(m_buyList) (whatever entry
 *     is last), AddTextToScroll("Buying aborted; max price reached.\n", 0,
 *     true, 0), break.
 *  4. For each (wcid, desired): have = ComponentTracker::GetNumComponent;
 *     skip unless (DetermineComponentCategory(wcid) == category || category
 *     == Undef) && have < desired. need = desired - have.
 *     ShopHasItem @ 004c0b70: the FIRST shop ItemProfile whose weenie's wcid
 *     matches; its amount (-1 = unlimited) caps `avail = min(need, amount)`.
 *     Not stocked → AddMissingComp. Stocked → `qty = need - (amount already
 *     in m_buyList for that guid)`; if avail < qty → AddMissingComp and qty
 *     = avail. Then VendorItemsUI::AddToBuyList(qty) and the running total
 *     += VendorProfile::VendorSellPrice(pwd, qty) — added even when
 *     AddToBuyList refused the merge (see below).
 *  5. The AddMissingComp report (when non-empty) as one line (0, true, 0),
 *     then a separate "\n" line (0, true, 0).
 *  6. AdoptAsContents + VendorBuyUI::UpdateBuyUI / UpdateTransactionValue /
 *     UpdateTotalValue; when the vendor panel exists, m_last_sale = 0 and
 *     OpenTab(0x100000ba) (the Buying tab).
 *
 * Every AddTextToScroll argument triple (chat type, bool, window) was read
 * from the push operands in acclient.exe (the Ghidra C scrambles the report
 * call's arguments): 004c4568 (0, 1, 0x1a), 004c4768 report (0, 1, 0),
 * 004c47bc "\n" (0, 1, 0), 004c4898 abort (0, 1, 0). Strings by address:
 * 0x7b5b24 "You need an open vendor.", 0x7b5b00 "Buying aborted; max price
 * reached.\n", 0x794508 "\n", 0x7b5878 "There was not enough: ", 0x794334 ", ".
 */

/** SpellComponentCategory (globals.tsv): Scarab 0, Herb 1, PowderedGem 2, AlchemicalSubstance 3, Talisman 4, Taper 5, Pea 6; Num 7; Undef 8. */
export const SPELL_COMPONENT_CATEGORY_UNDEF = 8;
/** VendorItemsUI::UpdateItemsList(m_itemsUI, 0x1000, false) — ItemType SpellComponents. */
export const FILL_COMPONENTS_ITEMS_FILTER = 0x1000;
/** PlayerModule::SetDesiredCompLevel @ 005d4940 creates the table with 0x100 buckets; ACE writes numBuckets 256 too. */
export const DESIRED_COMP_TABLE_SIZE = 0x100;
/** VendorItemsUI::AddToBuyList @ 004c3dc0: a merged amount must be < 0x1389. */
export const BUY_LIST_MERGE_LIMIT = 0x1389;
/** gmVendorUI::m_vendorPanel->OpenTab(0x100000ba) — the Buying tab. */
export const VENDOR_BUY_TAB_ID = 0x100000ba;

export const FILL_NEED_OPEN_VENDOR = 'You need an open vendor.';
export const FILL_MAX_PRICE_REACHED = 'Buying aborted; max price reached.\n';
export const FILL_MISSING_PREFIX = 'There was not enough: ';
export const FILL_MISSING_SEPARATOR = ', ';
/** AddToBuyList's refusal (wide literal), shown through ECM_UI::SendNotice_DisplayStringInfo(0x1a, …). */
export const BUY_LIST_TOO_MUCH = "I can't possibly sell you that much! Please be a little more reasonable.";

/** One AddTextToScroll(text, chatType, true, window) — every line here passes true. */
export interface FillComponentLine {
  text: string;
  chatType: number;
  window: number;
}

/** A merchandise ItemProfile (gmVendorUI::shopItemProfileList), in list order. */
export interface FillShopItem {
  guid: number;
  /** The weenie's wcid; undefined when the object is unknown (GetWeenieObject == null → ShopHasItem skips it). */
  wcid: number | undefined;
  /** ItemProfile.amount: -1 = unlimited stock. */
  amount: number;
}

/** A gmVendorUI::m_buyList ItemProfile (iid + amount), in list order. */
export interface FillBuyEntry {
  guid: number;
  qty: number;
}

export interface FillComponentInput {
  /** gmVendorUI::shopVendorID; 0 = no vendor open. */
  vendorGuid: number;
  /** (wcid, desired count) in retail hash-iteration order — pass through desiredCompIterationOrder. */
  desired: Iterable<readonly [number, number]>;
  /** ComponentTracker::GetNumComponent — see getNumComponent. */
  numComponent(wcid: number): number;
  /** ComponentTracker::DetermineComponentCategory — see determineComponentCategory. */
  categoryOf(wcid: number): number;
  /** ComponentTracker::GetCompNameFromWCID — see componentNameFromWcid. */
  compName(wcid: number): string;
  shopItems: readonly FillShopItem[];
  buyList: readonly FillBuyEntry[];
  /** VendorProfile::VendorSellPrice(merchandise guid's desc, qty) — qty may be 0 or negative (retail passes it through). */
  sellPrice(guid: number, qty: number): number;
}

export interface FillComponentResult {
  /** False on the "You need an open vendor." path: nothing else happens (no filter, no tab). */
  vendorOpen: boolean;
  /** m_buyList after the run (replace the Buying list with it). Unchanged copy when !vendorOpen. */
  buyList: FillBuyEntry[];
  /** Chat lines in the order retail prints them. */
  lines: FillComponentLine[];
  /** The running total (local_44) the max-price check compares. */
  totalPrice: number;
  /** True when the max-price abort fired (RemoveTail done). */
  aborted: boolean;
  /** UpdateItemsList filter (0x1000) when the vendor is open, else null. */
  itemsFilter: number | null;
  /** Open the Buying tab (0x100000ba) and zero m_last_sale — retail does so only when m_vendorPanel exists. */
  openBuyTab: boolean;
}

/**
 * gmVendorUI::ShopHasItem @ 004c0b70 (decomp 187143–187170): the first shop
 * profile whose weenie wcid matches; `want` is lowered to the profile's
 * amount unless that is -1 (unlimited). Returns null when not stocked.
 */
export function shopHasItem(shopItems: readonly FillShopItem[], wcid: number, want: number): { guid: number; avail: number } | null {
  for (const item of shopItems) {
    if (item.wcid === undefined || item.wcid !== wcid) continue;
    const avail = item.amount !== -1 && item.amount < want ? item.amount : want;
    return { guid: item.guid, avail };
  }
  return null;
}

/**
 * VendorItemsUI::AddToBuyList @ 004c3dc0 (decomp 189836–189926), on a copy:
 * an entry for the guid gets `qty` added when the sum is < 0x1389, else the
 * refusal notice and no change; a new guid is appended uncapped (even at 0).
 * Returns the notice line, or null.
 */
export function addToBuyList(list: FillBuyEntry[], guid: number, qty: number): FillComponentLine | null {
  const existing = list.find((e) => e.guid === guid);
  if (existing) {
    const merged = qty + existing.qty;
    if (merged >= BUY_LIST_MERGE_LIMIT) return { text: BUY_LIST_TOO_MUCH, chatType: 0x1a, window: 0 };
    existing.qty = merged;
    return null;
  }
  list.push({ guid, qty });
  return null;
}

/**
 * gmVendorUI::AddMissingComp @ 004c2e90 (decomp 189046–189098): the first
 * name is prefixed "There was not enough: ", later ones ", ".
 */
function addMissingComp(report: string, name: string): string {
  return report + (report.length === 0 ? FILL_MISSING_PREFIX : FILL_MISSING_SEPARATOR) + name;
}

/** gmVendorUI::FillComponentList @ 004c4540 — see the module docblock. */
export function fillComponentList(input: FillComponentInput, category: number, maxPrice: number): FillComponentResult {
  const buyList = input.buyList.map((e) => ({ guid: e.guid, qty: e.qty }));
  const lines: FillComponentLine[] = [];
  if (input.vendorGuid === 0) {
    lines.push({ text: FILL_NEED_OPEN_VENDOR, chatType: 0x1a, window: 0 });
    return { vendorOpen: false, buyList, lines, totalPrice: 0, aborted: false, itemsFilter: null, openBuyTab: false };
  }
  let total = 0;
  let report = '';
  let aborted = false;
  for (const [wcid, desired] of input.desired) {
    // Retail quirk: checked before each entry (needed or not) on the running
    // total, so the entry that crosses the cap stays unless another follows.
    if (maxPrice <= total && maxPrice !== 0) {
      buyList.pop(); // PackableList::RemoveTail — the last entry, whichever item it is
      lines.push({ text: FILL_MAX_PRICE_REACHED, chatType: 0, window: 0 });
      aborted = true;
      break;
    }
    const have = input.numComponent(wcid);
    const cat = input.categoryOf(wcid);
    if (!((cat === category || category === SPELL_COMPONENT_CATEGORY_UNDEF) && have < desired)) continue;
    let qty = desired - have;
    const stocked = shopHasItem(input.shopItems, wcid, qty);
    if (!stocked) {
      report = addMissingComp(report, input.compName(wcid));
      continue;
    }
    const queued = buyList.find((e) => e.guid === stocked.guid);
    if (queued) qty -= queued.qty;
    if (stocked.avail < qty) {
      report = addMissingComp(report, input.compName(wcid));
      qty = stocked.avail;
    }
    const notice = addToBuyList(buyList, stocked.guid, qty);
    if (notice) lines.push(notice);
    total += input.sellPrice(stocked.guid, qty);
  }
  if (report.length > 0) {
    lines.push({ text: report, chatType: 0, window: 0 });
    lines.push({ text: '\n', chatType: 0, window: 0 });
  }
  return { vendorOpen: true, buyList, lines, totalPrice: total, aborted, itemsFilter: FILL_COMPONENTS_ITEMS_FILTER, openBuyTab: true };
}

/**
 * The order PackableHashIterator walks PlayerModule's desired-comp table:
 * buckets 0..tableSize-1 (bucket = wcid % tableSize), each chain from its
 * head. PackableHashTable<IDClass,int>::add @ 0052d370 PREPENDS to the chain,
 * and both fillers go through it: PackableHashTable::UnPack @ 005d4cf0 (the
 * PlayerDescription table, header = tableSize << 16 | count, 256 from ACE)
 * and PlayerModule::SetDesiredCompLevel @ 005d4940 (0x100 buckets; an
 * existing key is updated in place). `entries` is insertion order (wire order,
 * then later sets) — a Map's iteration order. A repeated key updates the
 * value and keeps its place (SetDesiredCompLevel's lookup path).
 */
export function desiredCompIterationOrder(
  entries: Iterable<readonly [number, number]>,
  tableSize: number = DESIRED_COMP_TABLE_SIZE,
): Array<[number, number]> {
  if (tableSize <= 0) return [];
  const buckets = new Map<number, Array<[number, number]>>();
  for (const [wcid, count] of entries) {
    const b = (wcid >>> 0) % tableSize;
    const chain = buckets.get(b) ?? [];
    buckets.set(b, chain);
    const hit = chain.find((e) => e[0] === wcid);
    if (hit) { hit[1] = count; continue; }
    chain.unshift([wcid, count]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).flatMap((b) => buckets.get(b)!.map((e) => [e[0], e[1]] as [number, number]));
}

/** The SpellComponentTable entry fields these lookups read. */
export interface SpellComponentInfo {
  name: string;
  category: number;
}

/**
 * SpellComponentTable::WCIDtoSCID @ 005bc240: DualEnumIDMap::DIDToEnum on the
 * spell-component DualDidMapper (0x27000002); an unmapped wcid leaves 0.
 * `scidByWcid` is that map's client enum→id table reversed.
 */
export function wcidToScid(wcid: number, scidByWcid: ReadonlyMap<number, number>): number {
  return scidByWcid.get(wcid) ?? 0;
}

/** The client enum→id table (SCID → WCID) reversed to WCID → SCID; the first SCID wins on a repeated WCID. */
export function buildScidByWcid(enumToId: ReadonlyMap<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [scid, wcid] of enumToId) if (!out.has(wcid)) out.set(wcid, scid);
  return out;
}

/**
 * ComponentTracker::DetermineComponentCategory @ 00585f50 (decomp
 * 375004–375029): the SpellComponentTable (0x0E00000F) entry of
 * WCIDtoSCID(wcid)'s category, or Undef (8) when there is no entry.
 */
export function determineComponentCategory(
  wcid: number,
  scidByWcid: ReadonlyMap<number, number>,
  components: ReadonlyMap<number, SpellComponentInfo>,
): number {
  const base = components.get(wcidToScid(wcid, scidByWcid));
  return base ? base.category : SPELL_COMPONENT_CATEGORY_UNDEF;
}

/**
 * ComponentTracker::GetCompNameFromWCID @ 00586090: the table entry's name
 * (CSpellBase::InqName nibble-swaps the stored bytes; our parser's
 * readObfuscatedString already did), or "" (SpellComponentBase::Init) when
 * there is no entry — AddMissingComp still appends its prefix/separator.
 */
export function componentNameFromWcid(
  wcid: number,
  scidByWcid: ReadonlyMap<number, number>,
  components: ReadonlyMap<number, SpellComponentInfo>,
): string {
  return components.get(wcidToScid(wcid, scidByWcid))?.name ?? '';
}

/**
 * ComponentTracker::GetNumComponent @ 00585fe0 (decomp 375032–375058): the
 * numItems of the entry in the wcid's category list whose wcid (the first
 * object that made the entry) equals `wcid`; 0 when none. Feed it the
 * SpellComponentList.buildComponentRows rows — the same tracker the
 * components page shows.
 */
export function getNumComponent(
  rows: ReadonlyArray<{ kind: string; category: number; entry?: { wcid: number; numItems: number } }>,
  wcid: number,
  category: number,
): number {
  for (const row of rows) {
    if (row.kind === 'component' && row.category === category && row.entry && row.entry.wcid === wcid) return row.entry.numItems;
  }
  return 0;
}
