/**
 * gmVendorUI::FillComponentList @ 004c4540 (+ ShopHasItem @ 004c0b70,
 * AddMissingComp @ 004c2e90, VendorItemsUI::AddToBuyList @ 004c3dc0,
 * ComponentTracker::DetermineComponentCategory @ 00585f50 / GetNumComponent
 * @ 00585fe0, the desired-comp PackableHashTable order) — behavioral tests of
 * packages/renderer/src/ui/FillComponentList.ts.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUY_LIST_TOO_MUCH,
  FILL_COMPONENTS_ITEMS_FILTER,
  SPELL_COMPONENT_CATEGORY_UNDEF,
  buildScidByWcid,
  componentNameFromWcid,
  desiredCompIterationOrder,
  determineComponentCategory,
  fillComponentList,
  getNumComponent,
  shopHasItem,
  type FillComponentInput,
  type FillShopItem,
} from '../packages/renderer/src/ui/FillComponentList';
import { buildComponentRows } from '../packages/renderer/src/ui/SpellComponentList';
import { DatReader } from '../packages/dat-parser/src/DatReader';
import { SpellComponentTable } from '../packages/dat-parser/src/file-types/SpellComponentTable';
import { readDualDidMapper } from '../packages/dat-parser/src/file-types/DualDidMapper';
import { DAT_PATHS, openDat } from './_harness/dat';

// Fake world: wcid → (category, name).
const COMPS: Record<number, { cat: number; name: string }> = {
  691: { cat: 0, name: 'Lead Scarab' },
  689: { cat: 0, name: 'Iron Scarab' },
  774: { cat: 1, name: 'Hyssop' },
  775: { cat: 1, name: 'Mandrake' },
  749: { cat: 4, name: 'Poplar Talisman' },
};

function input(over: Partial<FillComponentInput> & { have?: Record<number, number>; unitPrice?: number } = {}): FillComponentInput {
  const have = over.have ?? {};
  const unit = over.unitPrice ?? 10;
  return {
    vendorGuid: 0x80001234,
    desired: [],
    numComponent: (w) => have[w] ?? 0,
    categoryOf: (w) => COMPS[w]?.cat ?? SPELL_COMPONENT_CATEGORY_UNDEF,
    compName: (w) => COMPS[w]?.name ?? '',
    shopItems: [],
    buyList: [],
    sellPrice: (_g, q) => q * unit,
    ...over,
  };
}

const UNLIMITED = (guid: number, wcid: number): FillShopItem => ({ guid, wcid, amount: -1 });

describe('fillComponentList — no vendor', () => {
  it('prints "You need an open vendor." (0x1a, window 0) and does nothing else', () => {
    const r = fillComponentList(input({ vendorGuid: 0, desired: [[691, 5]], shopItems: [UNLIMITED(1, 691)], buyList: [{ guid: 9, qty: 2 }] }), 8, 0);
    expect(r.vendorOpen).toBe(false);
    expect(r.lines).toEqual([{ text: 'You need an open vendor.', chatType: 0x1a, window: 0 }]);
    expect(r.buyList).toEqual([{ guid: 9, qty: 2 }]);
    expect(r.itemsFilter).toBeNull();
    expect(r.openBuyTab).toBe(false);
  });
});

describe('fillComponentList — open vendor', () => {
  it('buys the shortfall of every desired component, filters to SpellComponents and opens the Buying tab', () => {
    const r = fillComponentList(input({
      desired: [[691, 10], [774, 3]],
      have: { 691: 4 },
      shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)],
    }), 8, 0);
    expect(r.vendorOpen).toBe(true);
    expect(r.buyList).toEqual([{ guid: 1, qty: 6 }, { guid: 2, qty: 3 }]);
    expect(r.totalPrice).toBe(90);
    expect(r.lines).toEqual([]);
    expect(r.itemsFilter).toBe(FILL_COMPONENTS_ITEMS_FILTER);
    expect(r.itemsFilter).toBe(0x1000);
    expect(r.openBuyTab).toBe(true);
    expect(r.aborted).toBe(false);
  });

  it('skips components already at or above the desired count', () => {
    const r = fillComponentList(input({ desired: [[691, 5], [774, 2]], have: { 691: 5, 774: 9 }, shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)] }), 8, 0);
    expect(r.buyList).toEqual([]);
    expect(r.lines).toEqual([]);
  });

  it('a category other than Undef only fills that category', () => {
    const r = fillComponentList(input({ desired: [[691, 2], [774, 2], [749, 1]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774), UNLIMITED(3, 749)] }), 1, 0);
    expect(r.buyList).toEqual([{ guid: 2, qty: 2 }]);
  });

  it('Undef (8) fills every category', () => {
    const r = fillComponentList(input({ desired: [[691, 2], [774, 2], [749, 1]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774), UNLIMITED(3, 749)] }), SPELL_COMPONENT_CATEGORY_UNDEF, 0);
    expect(r.buyList.map((e) => e.guid)).toEqual([1, 2, 3]);
  });

  it('an unstocked component goes in the "There was not enough: " report, then a separate "\\n" line', () => {
    const r = fillComponentList(input({ desired: [[691, 2], [774, 2], [775, 1]], shopItems: [UNLIMITED(1, 691)] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 2 }]);
    expect(r.lines).toEqual([
      { text: 'There was not enough: Hyssop, Mandrake', chatType: 0, window: 0 },
      { text: '\n', chatType: 0, window: 0 },
    ]);
  });

  it('limited stock: buys what the shop has and reports the shortfall', () => {
    const r = fillComponentList(input({ desired: [[691, 10]], shopItems: [{ guid: 1, wcid: 691, amount: 3 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 3 }]);
    expect(r.lines[0]).toEqual({ text: 'There was not enough: Lead Scarab', chatType: 0, window: 0 });
    expect(r.totalPrice).toBe(30);
  });

  it('stock that covers the need is not a shortfall', () => {
    const r = fillComponentList(input({ desired: [[691, 3]], shopItems: [{ guid: 1, wcid: 691, amount: 3 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 3 }]);
    expect(r.lines).toEqual([]);
  });

  it('tops up an existing Buying entry to the need (AddToBuyList merges)', () => {
    const r = fillComponentList(input({ desired: [[691, 10]], shopItems: [UNLIMITED(1, 691)], buyList: [{ guid: 1, qty: 4 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 10 }]);
    expect(r.totalPrice).toBe(60); // priced on the added 6
  });

  it('quirk: a queued amount above the need adds a negative quantity (buy entry trimmed to the need)', () => {
    const r = fillComponentList(input({ desired: [[691, 10]], shopItems: [UNLIMITED(1, 691)], buyList: [{ guid: 1, qty: 15 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 10 }]);
    expect(r.totalPrice).toBe(-50);
  });

  it('quirk: limited stock compares against the need, then adds the stock on top of what is queued', () => {
    const r = fillComponentList(input({ desired: [[691, 10]], shopItems: [{ guid: 1, wcid: 691, amount: 3 }], buyList: [{ guid: 1, qty: 3 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 6 }]);
    expect(r.lines[0].text).toBe('There was not enough: Lead Scarab');
  });

  it('quirk: a zero-stock profile appends a 0-quantity entry and reports the shortfall', () => {
    const r = fillComponentList(input({ desired: [[691, 2]], shopItems: [{ guid: 1, wcid: 691, amount: 0 }] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 0 }]);
    expect(r.lines[0].text).toBe('There was not enough: Lead Scarab');
  });

  it('a merge reaching 5001 is refused with the DisplayStringInfo notice, but its price still counts', () => {
    // A merged amount equals the need, so only a wire-sized desired count (> 5000) can trip it.
    const r = fillComponentList(input({ desired: [[691, 6000]], shopItems: [UNLIMITED(1, 691)], buyList: [{ guid: 1, qty: 1 }], unitPrice: 1 }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 1 }]);
    expect(r.lines).toEqual([{ text: BUY_LIST_TOO_MUCH, chatType: 0x1a, window: 0 }]);
    expect(r.totalPrice).toBe(5999);
    const ok = fillComponentList(input({ desired: [[691, 5000]], shopItems: [UNLIMITED(1, 691)], buyList: [{ guid: 1, qty: 1 }], unitPrice: 1 }), 8, 0);
    expect(ok.buyList).toEqual([{ guid: 1, qty: 5000 }]);
    expect(ok.lines).toEqual([]);
  });

  it('a new entry is appended uncapped', () => {
    const r = fillComponentList(input({ desired: [[691, 6000]], shopItems: [UNLIMITED(1, 691)] }), 8, 0);
    expect(r.buyList).toEqual([{ guid: 1, qty: 6000 }]);
    expect(r.lines).toEqual([]);
  });
});

describe('fillComponentList — max price', () => {
  it('checks the running total before the next entry: RemoveTail + "Buying aborted; max price reached.\\n"', () => {
    const r = fillComponentList(input({ desired: [[691, 5], [774, 5], [775, 5]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774), UNLIMITED(3, 775)] }), 8, 90);
    // 691: total 50 < 90 → 774: total 100 → before 775, 90 <= 100 → remove the tail (774's entry).
    expect(r.buyList).toEqual([{ guid: 1, qty: 5 }]);
    expect(r.aborted).toBe(true);
    expect(r.totalPrice).toBe(100);
    expect(r.lines).toEqual([{ text: 'Buying aborted; max price reached.\n', chatType: 0, window: 0 }]);
    expect(r.openBuyTab).toBe(true);
  });

  it('quirk: the entry that crosses the cap stays when it is the last one walked', () => {
    const r = fillComponentList(input({ desired: [[691, 5], [774, 5]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)] }), 8, 60);
    expect(r.buyList).toEqual([{ guid: 1, qty: 5 }, { guid: 2, qty: 5 }]);
    expect(r.aborted).toBe(false);
  });

  it('quirk: the check runs on entries that need nothing too', () => {
    const r = fillComponentList(input({ desired: [[691, 5], [774, 1]], have: { 774: 4 }, shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)] }), 8, 50);
    expect(r.buyList).toEqual([]);
    expect(r.aborted).toBe(true);
  });

  it('quirk: RemoveTail drops the LAST list entry, even when the crossing buy merged into an earlier one', () => {
    const r = fillComponentList(input({
      desired: [[691, 10], [774, 1]],
      shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)],
      buyList: [{ guid: 1, qty: 2 }, { guid: 7, qty: 1 }],
    }), 8, 50);
    expect(r.buyList).toEqual([{ guid: 1, qty: 10 }]);
  });

  it('abort comes before the missing report, which still prints', () => {
    const r = fillComponentList(input({ desired: [[775, 1], [691, 5], [774, 5]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)] }), 8, 10);
    expect(r.lines.map((l) => l.text)).toEqual(['Buying aborted; max price reached.\n', 'There was not enough: Mandrake', '\n']);
  });

  it('maxPrice 0 never aborts', () => {
    const r = fillComponentList(input({ desired: [[691, 5], [774, 5]], shopItems: [UNLIMITED(1, 691), UNLIMITED(2, 774)], unitPrice: 1e6 }), 8, 0);
    expect(r.aborted).toBe(false);
    expect(r.buyList).toHaveLength(2);
  });
});

describe('ShopHasItem', () => {
  it('first matching profile, skipping unknown objects; -1 = unlimited; amount caps the want', () => {
    const shop: FillShopItem[] = [{ guid: 1, wcid: undefined, amount: -1 }, { guid: 2, wcid: 691, amount: 4 }, { guid: 3, wcid: 691, amount: -1 }];
    expect(shopHasItem(shop, 691, 10)).toEqual({ guid: 2, avail: 4 });
    expect(shopHasItem(shop, 691, 2)).toEqual({ guid: 2, avail: 2 });
    expect(shopHasItem([UNLIMITED(5, 691)], 691, 99)).toEqual({ guid: 5, avail: 99 });
    expect(shopHasItem(shop, 774, 1)).toBeNull();
  });
});

describe('desired-comp hash iteration order', () => {
  it('ascending wcid % 256 buckets; within a bucket the later insert comes first', () => {
    // 691 % 256 = 179, 774 % 256 = 6, 262 % 256 = 6, 1030 % 256 = 6.
    const order = desiredCompIterationOrder(new Map([[691, 1], [262, 2], [774, 3], [1030, 4]]));
    expect(order).toEqual([[1030, 4], [774, 3], [262, 2], [691, 1]]);
  });

  it('a repeated key updates in place', () => {
    expect(desiredCompIterationOrder([[262, 1], [774, 2], [262, 9]])).toEqual([[774, 2], [262, 9]]);
  });

  it('table size from the wire header; empty / zero-size tables walk nothing', () => {
    expect(desiredCompIterationOrder([[5, 1], [3, 1]], 4)).toEqual([[5, 1], [3, 1]]);
    expect(desiredCompIterationOrder([], 256)).toEqual([]);
    expect(desiredCompIterationOrder([[5, 1]], 0)).toEqual([]);
  });

  it('drives fillComponentList in that order (the missing report follows it)', () => {
    const desired = desiredCompIterationOrder(new Map([[691, 1], [775, 1], [774, 1]]));
    const r = fillComponentList(input({ desired }), 8, 0);
    expect(r.lines[0].text).toBe('There was not enough: Hyssop, Mandrake, Lead Scarab');
  });
});

describe('ComponentTracker lookups', () => {
  const scidByWcid = buildScidByWcid(new Map([[1, 691], [7, 774], [99, 691]]));
  const table = new Map([[1, { name: 'Lead Scarab', category: 0 }], [7, { name: 'Hyssop', category: 1 }]]);

  it('buildScidByWcid reverses SCID→WCID, first SCID wins', () => {
    expect(scidByWcid.get(691)).toBe(1);
    expect(scidByWcid.get(774)).toBe(7);
  });

  it('DetermineComponentCategory: the entry category, Undef (8) when unmapped or missing', () => {
    expect(determineComponentCategory(691, scidByWcid, table)).toBe(0);
    expect(determineComponentCategory(774, scidByWcid, table)).toBe(1);
    expect(determineComponentCategory(12345, scidByWcid, table)).toBe(8);
  });

  it('GetCompNameFromWCID: the entry name, "" when missing', () => {
    expect(componentNameFromWcid(774, scidByWcid, table)).toBe('Hyssop');
    expect(componentNameFromWcid(12345, scidByWcid, table)).toBe('');
  });

  it('GetNumComponent: numItems of the category entry keyed by its first object\'s wcid', () => {
    const rows = buildComponentRows(
      [
        { id: 10, name: 'Lead Scarab', weenieClassId: 691, itemType: 0x1000, stackSize: 5 },
        { id: 11, name: 'Lead Scarab', weenieClassId: 691, itemType: 0x1000, stackSize: 7 },
        { id: 12, name: 'Hyssop', weenieClassId: 774, itemType: 0x1000, stackSize: 0 },
      ],
      (w) => scidByWcid.get(w),
      (s) => table.get(s)?.category,
    );
    expect(getNumComponent(rows, 691, 0)).toBe(12);
    expect(getNumComponent(rows, 774, 1)).toBe(1);
    expect(getNumComponent(rows, 691, 1)).toBe(0);
    expect(getNumComponent(rows, 775, 1)).toBe(0);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('DetermineComponentCategory from the portal DAT', () => {
  let scidByWcid: Map<number, number>;
  let table: SpellComponentTable;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    table = new SpellComponentTable(new DatReader(db.getFileData(0x0e00000f)!));
    scidByWcid = buildScidByWcid(readDualDidMapper(new DatReader(db.getFileData(0x27000002)!)).client.enumToId);
  });

  it('maps real component wcids to their SpellComponentCategory and name', () => {
    const cases: Array<[number, number, string]> = [
      [691, 0, 'Lead Scarab'],
      [774, 1, 'Hyssop'],
      [782, 2, 'Powdered Agate'],
      [753, 3, 'Brimstone'],
      [749, 4, 'Poplar Talisman'],
      [20631, 5, 'Prismatic Taper'],
      [8329, 6, 'Lead Scarab Pea'],
    ];
    for (const [wcid, cat, name] of cases) {
      expect(determineComponentCategory(wcid, scidByWcid, table.components)).toBe(cat);
      expect(componentNameFromWcid(wcid, scidByWcid, table.components)).toBe(name);
    }
  });

  it('a non-component wcid is Undef (8); no WCID appears under two SCIDs', () => {
    expect(determineComponentCategory(273 /* pyreal */, scidByWcid, table.components)).toBe(8);
    const raw = readDualDidMapper(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x27000002)!)).client.enumToId;
    expect(new Set(raw.values()).size).toBe(raw.size);
  });
});
