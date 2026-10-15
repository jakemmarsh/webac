import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  MAP_TOWNS, compareItemNames, formatPlace, formatShops, learnRule, nearestTown, parseShopOffers, parseShopVendors, placeMapCoords, shopOfferSql,
  shopPrice, shopVendorSql, shortNames, type ShopDatInfo,
} from '../tools/stream/shops.ts';
import { mapCoordinateText } from '../packages/renderer/src/ui/MapMarkers.ts';
import { worldQueryRefusal } from '../tools/stream/world-query.ts';
import { join } from 'node:path';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { playerToolNames, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamJsonLine } from '../tools/stream/feed.ts';
import { TOOLS } from '../tools/ac-agent/tools.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { MagicSchool, SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';

// 2026-10-15: Claude Arcanist trained Item Enchantment, asked the Holtburg healer and an Archmage for Impenetrability
// scrolls, gave up, and never learned one, though Holtburg's scriveners sell them. `./world-query sells "<item>"`
// says who sells it, for how much, and where.

const tsv = (rows: (string | number)[][]) => rows.map((r) => r.join('\t')).join('\n');

// The local ACE world DB's rows: Holtburg's four item scriveners (create list destination 4), their scroll's
// Value (int 19) and Spell (DID 28); SellPrice (float 38) 50 for each.
const OFFERS = tsv([
  [20213, 2843, 'Scroll of Impenetrability III', 20, 8192, 1483],
  [20214, 2844, 'Scroll of Impenetrability IV', 100, 8192, 1484],
  [20215, 1887, 'Scroll of Impenetrability', 1, 8192, 51],
  [20216, 2842, 'Scroll of Impenetrability II', 5, 8192, 1482],
  [20216, 2842, 'Scroll of Impenetrability II', 5, 8192, 1482], // a duplicate create-list row
  [99999, 2842, 'Scroll of Impenetrability II', 5, 8192, 1482], // a vendor placed nowhere
]);
const VENDORS = tsv([
  ['v', 20213, 'Journeyman Scrivener of Item Magic', 50, 'NULL'],
  ['v', 20214, 'Scrivener of Item Magic', 50, 'NULL'],
  ['v', 20215, 'Apprentice Scrivener of Item and War Magic', 50, 'NULL'],
  ['v', 20216, 'Apprentice Scrivener of Item and War Magic', 50, 'NULL'],
  ['v', 99999, 'Nowhere Scrivener', 50, 'NULL'],
  ['p', 20213, 0xa9b3003c, 183.232, 76.6786],
  ['p', 20214, 0xa9b3003c, 187.288, 86.7918],
  ['p', 20215, 0xa9b30101, 183.749, 79.9449], // inside a Holtburg building
  ['p', 20216, 0xa9b30000, 184.004, 79.7872],
  ['p', 20216, 0xa9b30000, 184.004, 79.7872], // the same placement twice
  ['g', 20214, 0xa9b3003c, 187.288, 86.7918], // and once more via a generator at the same spot
]);

// SpellTable powers for those scrolls (I 1, II 50, III 100, IV 150), all Item Enchantment.
const POWER = new Map([[51, 1], [1482, 50], [1483, 100], [1484, 150]]);
const DAT: ShopDatInfo = {
  spell: (id) => (POWER.has(id) ? { power: POWER.get(id)!, school: 3 } : undefined),
  envCellFlags: (cell) => (cell === 0xa9b30101 ? 0x1 : undefined),
};

describe('sells: the SQL', () => {
  it('reads the shop create lists (destination 4) by item name, escaping the query; both are read-only statements', () => {
    const sql = shopOfferSql("Bob's 100%_kit");
    expect(sql).toContain('c.destination_Type = 4');
    expect(sql).toContain("LIKE LOWER('%Bob''s 100\\%\\_kit%')");
    expect(worldQueryRefusal(sql)).toBeNull();
    for (const s of shopVendorSql([20213, 20213, -1, 20214])) {
      expect(worldQueryRefusal(s)).toBeNull();
      expect(s).toContain('IN (20213,20214)');
    }
    expect(shopVendorSql([])[0]).toContain('IN (0)');
  });
});

describe('sells: rows → shops', () => {
  it('parses offers once per vendor + item, and vendors with their placements (deduplicated)', () => {
    const offers = parseShopOffers(OFFERS);
    expect(offers).toHaveLength(5);
    expect(offers[0]).toEqual({ vendor: 20213, item: 2843, name: 'Scroll of Impenetrability III', value: 20, itemType: 8192, spell: 1483 });
    const vendors = parseShopVendors(VENDORS);
    expect(vendors.get(20213)).toMatchObject({ name: 'Journeyman Scrivener of Item Magic', sellRate: 50, places: [{ cell: 0xa9b3003c, viaGenerator: false }] });
    expect(vendors.get(20213)!.currency).toBeUndefined();
    expect(vendors.get(20216)!.places).toHaveLength(1);
    expect(vendors.get(20214)!.places).toHaveLength(1);
    expect(vendors.get(99999)!.places).toHaveLength(0);
  });

  it('prices as Vendor.GetSellCost: ceil(SellPrice × Value − 0.1), at least 1, promissory notes at 1.15', () => {
    expect(shopPrice(20, 50)).toBe(1000);
    expect(shopPrice(100, 50)).toBe(5000);
    expect(shopPrice(45, 1.5)).toBe(68);
    expect(shopPrice(0, 1.5)).toBe(1);
    expect(shopPrice(undefined, undefined)).toBe(1);
    expect(shopPrice(1000, 3, 0x40000)).toBe(1150);
  });

  it('gives who can learn a scroll as Player.CanReadScroll does (power < 50 or ≥ 300: anyone; else trained, skill ≥ power − 50)', () => {
    const o = (spell: number) => ({ vendor: 1, item: 1, name: 'x', spell });
    expect(learnRule(o(51), DAT)).toEqual({ anyone: true });
    expect(learnRule(o(1482), DAT)).toEqual({ school: 'Item Enchantment', min: 0 });
    expect(learnRule(o(1484), DAT)).toEqual({ school: 'Item Enchantment', min: 100 });
    expect(learnRule({ ...o(1), spell: undefined }, DAT)).toBeUndefined();
    expect(learnRule(o(7), DAT)).toBeUndefined();
    expect(learnRule(o(7), { spell: () => ({ power: 300, school: 1 }) })).toEqual({ anyone: true });
  });

  it('orders spell tiers by their numeral and cuts a family to the numeral', () => {
    const names = ['Scroll of Impenetrability IV', 'Scroll of Impenetrability', 'Scroll of Impenetrability VI', 'Scroll of Impenetrability II', 'Apple'];
    const sorted = [...names].sort(compareItemNames);
    expect(sorted).toEqual(['Apple', 'Scroll of Impenetrability', 'Scroll of Impenetrability II', 'Scroll of Impenetrability IV', 'Scroll of Impenetrability VI']);
    expect(shortNames(sorted)).toEqual(['Apple', 'Scroll of Impenetrability', 'II', 'IV', 'VI']);
  });
});

describe('sells: where', () => {
  it('turns a placement into the retail map readout the agent prints, indoor cells by their landblock like outdoor ones', () => {
    expect(mapCoordinateText(placeMapCoords(0xa9b3003c, 183.232, 76.6786))).toBe('41.6N, 34.0E');
    // 0xA9B30101 is a cell inside a Holtburg building: landblock A9B3 + its origin, the same formula.
    expect(mapCoordinateText(placeMapCoords(0xa9b30101, 183.749, 79.9449))).toBe('41.6N, 34.0E');
    expect(mapCoordinateText(placeMapCoords(0x7d64000d, 100, 100))).toBe('21.5S, 1.5W'); // Yaraq
  });

  it('names the nearest town on the retail map', () => {
    expect(MAP_TOWNS).toHaveLength(53);
    expect(nearestTown({ ns: 42.1, ew: 33.6 })).toBe('Holtburg');
    expect(nearestTown({ ns: -21.5, ew: -1.3 })).toBe('Yaraq');
    expect(nearestTown({ ns: -33.6, ew: 73.4 })).toBe('Shoushi');
    expect(nearestTown({ ns: 48, ew: 33.6 })).toMatch(/^\d+ N of Holtburg$/);
    expect(nearestTown({ ns: 0, ew: -95 })).toBeUndefined();
  });

  it('says whether an interior cell is in a building or underground (EnvCell SeenOutside)', () => {
    const at = (cell: number, flags?: number) => formatPlace({ cell, x: 183.749, y: 79.9449, viaGenerator: false }, { envCellFlags: () => flags });
    expect(at(0xa9b30101, 0x1)).toBe('41.6N, 34.0E inside a building (Holtburg)');
    expect(at(0xa9b30102, 0x0)).toBe('41.6N, 34.0E underground (a dungeon or cellar) (Holtburg)');
    expect(at(0xa9b30102)).toBe('41.6N, 34.0E indoors (Holtburg)');
    expect(at(0xa9b3003c, 0x0)).toBe('41.6N, 34.0E (Holtburg)');
    expect(formatPlace({ cell: 0xa9b3003c, x: 183.232, y: 76.6786, viaGenerator: true })).toBe('41.6N, 34.0E (Holtburg), spawned there');
  });
});

describe('sells: the answer', () => {
  it('lists each tier with its shop, price and place, lowest tier first, and who can learn each', () => {
    const out = formatShops('Impenetrability', parseShopOffers(OFFERS), parseShopVendors(VENDORS), DAT);
    expect(out.split('\n')).toEqual([
      '4 shops sell 4 items matching "Impenetrability"; prices are what you pay; use a scroll to learn its spell.',
      'To learn: Scroll of Impenetrability: anyone; II: Item Enchantment trained; III: skill 50+; IV: skill 100+.',
      'Apprentice Scrivener of Item and War Magic: Scroll of Impenetrability 50 pyreals, at 41.6N, 34.0E inside a building (Holtburg)',
      'Apprentice Scrivener of Item and War Magic: Scroll of Impenetrability II 250 pyreals, at 41.6N, 34.0E (Holtburg)',
      'Journeyman Scrivener of Item Magic: Scroll of Impenetrability III 1,000 pyreals, at 41.6N, 34.0E (Holtburg)',
      'Scrivener of Item Magic: Scroll of Impenetrability IV 5,000 pyreals, at 41.6N, 34.0E (Holtburg)',
    ]);
  });

  it('groups a vendor with several places and several matching items, and caps the lines with a tail', () => {
    const offers = parseShopOffers(tsv([[1, 10, 'Handy Healing Kit', 10, 0, 'NULL'], [1, 11, 'Adept Healing Kit', 45, 0, 'NULL'], [2, 11, 'Adept Healing Kit', 45, 0, 'NULL']]));
    const vendors = parseShopVendors(tsv([
      ['v', 1, 'Peddler', 1.5, 'NULL'], ['v', 2, 'Ancient Trader', 2, 'Trade Note'],
      ...Array.from({ length: 7 }, (_, i) => ['p', 1, 0xa9b30001 + i, 6 + i * 25, 12]),
      ['p', 2, 0x7d64000d, 100, 100],
    ]));
    const lines = formatShops('Healing Kit', offers, vendors).split('\n');
    expect(lines[0]).toBe('8 shops sell 2 items matching "Healing Kit"; prices are what you pay.');
    expect(lines[1]).toBe('Ancient Trader (prices in Trade Note): Adept Healing Kit 90, at 21.5S, 1.5W (Yaraq)');
    expect(lines[2]).toBe('Peddler: Adept Healing Kit 68, Handy Healing Kit 15 pyreals, at:');
    expect(lines.slice(3)).toHaveLength(3); // 7 places, three to a line
    const capped = formatShops('Healing Kit', offers, vendors, {}, 4).split('\n');
    expect(capped).toHaveLength(5);
    expect(capped[3]).toMatch(/\(\+4 more\)$/);
    expect(capped[4]).toBe('… 4 more shops not shown; give more of the name (e.g. "Handy Healing Kit").');
  });

  it('says so when nothing matches, when no matching vendor stands anywhere, and when the query is empty', () => {
    expect(formatShops('zzqx', [], new Map())).toBe('no shop sells anything called "zzqx" (try a shorter part of the name)');
    const lone = parseShopOffers(tsv([[99999, 2842, 'Scroll of Impenetrability II', 5, 8192, 1482]]));
    expect(formatShops('Imp', lone, parseShopVendors(VENDORS))).toBe('1 shop listing name "Imp", but none of those vendors is placed in this world.');
    expect(formatShops('  ', [], new Map())).toMatch(/^give part of an item name/);
  });
});

describe('sells: what the player is told and what viewers see', () => {
  it('the brief names the command as a fact next to lore', () => {
    const cfg = parseStreamConfig(JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8')));
    const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), cfg.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
    expect(sys).toContain('`./world-query sells "<item>"` finds which shop sells it, the price, and where.');
  });
  it('the feed says "looks for a shop selling <item>"', () => {
    const call = (command: string) => parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }), 'mage').drafts[0];
    expect(call('./world-query sells "Scroll of Impenetrability"')).toMatchObject({ tool: 'bash', summary: 'looks for a shop selling Scroll of Impenetrability' });
    expect(call('./world-query lore "Drudge"')).toMatchObject({ summary: 'looks up Drudge' });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('sells: the DAT facts it relies on', () => {
  let spells: SpellTable;
  beforeAll(() => {
    spells = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
  });

  it('the Impenetrability scroll spells have the powers the fixture uses, in Item Enchantment', () => {
    for (const [id, power] of POWER) {
      expect(spells.spells.get(id)?.power).toBe(power);
      expect(spells.spells.get(id)?.school).toBe(MagicSchool.ItemEnchantment);
    }
  });

  it('0xA9B30101 is a Holtburg building interior (EnvCell SeenOutside)', () => {
    const data = openDat(DAT_PATHS.cell).getFileData(0xa9b30101)!;
    expect(new DataView(data).getUint32(4, true) & 0x1).toBe(0x1);
  });
});
