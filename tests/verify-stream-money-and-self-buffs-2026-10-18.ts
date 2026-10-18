/**
 * Money and Self-buff facts for the stream players (2026-10-18).
 *
 * Jake, watching: "do they not have trade notes? why are they so broke". Claude Bulwark carried about 405,000 in trade
 * notes (2×100k, 1×50k, 9×10k, 70×500, 30×1,000) and ~2,350 in coins; Claude Arcanist one 10,000 note and ~1,150 in
 * coins. Observe's header showed coins alone, so both acted broke. Now observe, `character` and the segment opening
 * count the notes by each row's Value (never the name), in every pack and side pack.
 *
 * Jake: "why is arcanist using level 1 spells". His routine cast Strength, Quickness and Coordination Self I, Aura of
 * Defender Self I and Impregnability Self I (the highest Self he knew) while he knew the Other versions at III–V for
 * Bulwark: the spells line counted a family by its best level of either. The opening now says the Self level, the
 * level his skill can learn, the Other levels he knows, and who sells the scrolls (world DB, nearest first), with both
 * fellows' purses so one can see the other could fund it.
 *
 * ACE, checked (reference/ACE): a vendor takes only coins (Vendor.BuyItems_ValidateTransaction checks CoinValue, the
 * Coin stacks' sum, or its AlternateCurrency; FinalizeBuyTransaction spends coin stacks); it buys a note at its face
 * value (GetBuyCost: rate 1.0 for PromissoryNote) and sells one at 115%; every Trade Note weenie is Bonded (33 = 1), and
 * Player_Death.CalculateDeathItems leaves bonded items out, so notes are kept on death.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { coinsOf, formatObservation, moneyLine, tradeNotesOf } from '../packages/renderer/src/agent/format.ts';
import type { AgentItem, AgentSpell, AgentVitals } from '../packages/renderer/src/agent/types.ts';
import { moneyLines, readinessBrief, selfBuffLines, selfScrollIds } from '../tools/stream/prompt.ts';
import { parseShopOffers, parseShopVendors, scrollSellerLines, shopScrollOfferSql } from '../tools/stream/shops.ts';
import { type KnownSpell, type TableSpell, selfBuffGaps, selfBuffLine } from '../tools/stream/spellGaps.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { FeedWriter } from '../tools/stream/feed.ts';
import { StreamSupervisor, type PlayerProcess, type SupervisorDeps } from '../tools/stream/supervisor.ts';
import { readFileSync } from 'node:fs';
import { FakeHost } from './_harness/agentFake.ts';

const MONEY = 0x40;
const NOTE = 0x40000;
const row = (guid: number, name: string, itemType: number, value: number, stack: number | undefined, where = 'main pack'): AgentItem => ({ guid, name, where, itemType, value, ...(stack ? { stack } : {}) });

/** Bulwark's packs on 2026-10-18: notes of each denomination (a stack's Value is units × face value), coins in two stacks, a side pack, worn gear. */
function bulwarkInv(): AgentItem[] {
  return [
    row(0x80001001, 'Pyreal', MONEY, 2000, 2000),
    row(0x80001002, 'Pyreal', MONEY, 350, 350, 'Belt Pouch'),
    row(0x80001010, 'Trade Note (100,000)', NOTE, 200_000, 2),
    row(0x80001011, 'Trade Note (50,000)', NOTE, 50_000, undefined),
    row(0x80001012, 'Trade Note (10,000)', NOTE, 90_000, 9, 'Belt Pouch'),
    row(0x80001013, 'Trade Note (500)', NOTE, 35_000, 70),
    row(0x80001014, 'Trade Note (1,000)', NOTE, 30_000, 30, 'Belt Pouch'),
    // Named like a note, but a Writable: not money (notes are counted by type and Value, never by name).
    row(0x80001020, 'Trade Note Receipt', 0x2000, 0, undefined),
    { guid: 0x80001030, name: 'Belt Pouch', where: 'pack slots', itemType: 0x200, value: 50 },
    { guid: 0x80001040, name: 'Tachi', where: 'equipped', slot: 'MeleeWeapon', itemType: 0x1, value: 2400 },
  ];
}

/** Arcanist's: one 10,000 note and ~1,150 coins in two stacks. */
function arcanistInv(): AgentItem[] {
  return [
    row(0x80002001, 'Pyreal', MONEY, 1000, 1000),
    row(0x80002002, 'Pyreal', MONEY, 150, 150, 'Pack'),
    row(0x80002003, 'Trade Note (10,000)', NOTE, 10_000, undefined, 'Pack'),
    { guid: 0x80002010, name: 'Mana Potion', where: 'main pack', itemType: 0x80, value: 30, stack: 4 },
  ];
}

/** The end-of-retail SpellTable rows of the five families (ids and powers as the DAT has them). */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const POWER = [1, 50, 100, 150, 200, 250];
const FAMILIES: Array<{ base: string; school: number; self: number[]; other: number[] }> = [
  { base: 'Strength', school: 4, self: [2, 1328, 1329, 1330, 1331, 1332], other: [1, 1333, 1334, 1335, 1336, 1337] },
  { base: 'Quickness', school: 4, self: [1397, 1398, 1399, 1400, 1401, 1402], other: [1403, 1404, 1405, 1406, 1407, 1408] },
  { base: 'Coordination', school: 4, self: [1373, 1374, 1375, 1376, 1377, 1378], other: [1379, 1380, 1381, 1382, 1383, 1384] },
  { base: 'Impregnability', school: 4, self: [256, 257, 258, 259, 260, 261], other: [250, 251, 252, 253, 254, 255] },
  { base: 'Aura of Defender', school: 3, self: [1599, 1601, 1602, 1603, 1604, 1605], other: [5999, 6000, 6001, 6002, 6003, 6004] },
];
const TABLE: TableSpell[] = FAMILIES.flatMap((f) => ROMAN.flatMap((r, i) => [
  { id: f.self[i], name: `${f.base} Self ${r}`, school: f.school, power: POWER[i] },
  { id: f.other[i], name: `${f.base} Other ${r}`, school: f.school, power: POWER[i] },
]));
const idOf = (name: string): number => TABLE.find((t) => t.name === name)!.id!;
const spell = (name: string, school: 'Creature' | 'Item'): KnownSpell => ({ id: idOf(name), name, school, level: ROMAN.indexOf(name.split(' ').pop()!) + 1, buff: true });

/** Arcanist's known buffs: every one of the five at Self I only, their Other at III–V (cast on Bulwark). */
function arcanistSpells(): KnownSpell[] {
  return [
    spell('Strength Self I', 'Creature'), spell('Quickness Self I', 'Creature'), spell('Coordination Self I', 'Creature'),
    spell('Impregnability Self I', 'Creature'), spell('Aura of Defender Self I', 'Item'),
    spell('Strength Other V', 'Creature'), spell('Quickness Other V', 'Creature'), spell('Coordination Other IV', 'Creature'),
    spell('Impregnability Other III', 'Creature'), spell('Aura of Defender Other V', 'Item'),
    // A Self spell that is no buff (an instant heal) is not "your own buffs".
    { id: 6, name: 'Heal Self I', school: 'Life', level: 1, buff: false },
  ];
}

/** GameUI.agentCharacterSheet's lines, as Arcanist's read on 2026-10-18 (level 52; the schools at 256). */
const ARCANIST_SHEET = [
  'Claude Arcanist  level 52  Aluvian Male  Non-Player Killer',
  'XP 68,710,896 total, 544,470 unassigned, 4,216,770 to next level; 4 skill credits',
  'Specialized skills: Mana Conversion 252 (base 229), War Magic 318 (base 270)',
  'Trained skills: Arcane Lore 218 (base 173), Creature Enchantment 256 (base 218), Item Enchantment 256 (base 218), Life Magic 256 (base 218)',
].join('\n');
const BULWARK_SHEET = [
  'Claude Bulwark  level 48  Aluvian Male  Non-Player Killer',
  'XP 50,000,000 total, 0 unassigned, 4,000,000 to next level; 0 skill credits',
  'Specialized skills: Heavy Weapons 330 (base 300), Melee Defense 300',
  'Trained skills: Healing 200, Shield 150, Run 220',
].join('\n');

/**
 * The world DB's shops for the Self V and VI scrolls (world-query.ts scrollShops: shopScrollOfferSql + shopVendorSql),
 * as mysql -N --batch rows: the end-of-retail Master / Grand Master Scriveners (wcids 20207, 20208, 20211, 20212) and
 * their placements (four of each Grand Master's six), the scroll names (wcid 2745 "Scroll of Self Strength V" …), Value and spell (PropertyDataId 28).
 */
function shopsFixture(): ReturnType<typeof parseShops> {
  const sc = 0x2000;
  const offers = [
    [20207, 2745, 'Scroll of Self Strength V', 200, sc, 1331], [20208, 2746, 'Scroll of Self Strength VI', 1000, sc, 1332],
    [20207, 2747, 'Scroll of Quickness Self V', 200, sc, 1401], [20208, 2748, 'Scroll of Quickness Self VI', 1000, sc, 1402],
    [20207, 2749, 'Scroll of Coordination Self V', 200, sc, 1377], [20208, 2750, 'Scroll of Coordination Self VI', 1000, sc, 1378],
    [20207, 2751, 'Scroll of Impregnability Self V', 200, sc, 260], [20208, 2752, 'Scroll of Impregnability Self VI', 1000, sc, 261],
    [20211, 2810, 'Aura of Defender Self V', 200, sc, 1604], [20212, 2811, 'Aura of Defender Self VI', 1000, sc, 1605],
  ].map((r) => r.join('\t')).join('\n');
  const vendors = [
    ['v', 20207, 'Master Scrivener of Creature Magic', 50, 'NULL'], ['v', 20208, 'Grand Master Scrivener of Creature Magic', 50, 'NULL'],
    ['v', 20211, 'Master Scrivener of Item Magic', 50, 'NULL'], ['v', 20212, 'Grand Master Scrivener of Item Magic', 50, 'NULL'],
    ['p', 20207, 1236664625, 16.2567, 133.561], ['p', 20207, 2535588213, 34.0562, 172.324], ['p', 20207, 3665101165, 157.94, 81.1664],
    ['p', 20208, 288620557, 41.4561, 104.499], ['p', 20208, 629211504, 107.076, 87.9284], ['p', 20208, 722600241, 138.351, 60.756], ['p', 20208, 1060176134, 87.7342, 87.4239],
    ['p', 20211, 1236664631, 14.8336, 136.301], ['p', 20211, 2535588220, 31.7253, 181.977], ['p', 20211, 3665101165, 159.011, 87.6706],
    ['p', 20212, 288620557, 33.3447, 102.261], ['p', 20212, 629211502, 110.157, 82.434], ['p', 20212, 722600241, 138.311, 66.33], ['p', 20212, 1060176135, 88.0986, 82.9783],
  ].map((r) => r.join('\t')).join('\n');
  return parseShops(offers, vendors);
}
function parseShops(offers: string, vendors: string) {
  return { offers: parseShopOffers(offers), vendors: parseShopVendors(vendors) };
}

const FMT = (n: number) => n.toLocaleString('en-US');

describe('money: coins and trade notes, counted by Value in every pack', () => {
  it('Bulwark: 405,000 in 112 notes across the main pack and a side pack; 2,350 in coins; the look-alike name is not counted', () => {
    expect(tradeNotesOf(bulwarkInv())).toEqual({ value: 405_000, count: 112, unpriced: 0 });
    expect(coinsOf(bulwarkInv())).toBe(2350);
    expect(tradeNotesOf(arcanistInv())).toEqual({ value: 10_000, count: 1, unpriced: 0 });
    expect(coinsOf(arcanistInv())).toBe(1150);
    // Rows with no type bits at all (an old tab): coins unknown, not 0.
    expect(coinsOf([{ guid: 1, name: 'Pyreal', where: 'main pack', value: 5 }])).toBeNull();
    // A note whose Value hasn't arrived is counted as a note, its worth said unknown.
    expect(tradeNotesOf([{ guid: 1, name: 'Trade Note (500)', where: 'main pack', itemType: NOTE }])).toEqual({ value: 0, count: 1, unpriced: 1 });
  });

  it('the money line says coins + notes = total and what ACE does with each', () => {
    expect(moneyLine(2350, tradeNotesOf(bulwarkInv()), 48)).toBe(
      'money: 2,350 in coins + 405,000 in trade notes (112 notes) = 407,350 (half your coins are lost if you die, notes are kept; vendors take only coins as payment: sell a note to a vendor (most buy them) for its face value in coins)');
    expect(moneyLine(400, { value: 0, count: 0, unpriced: 0 }, 20)).toBe('money: 400 in coins, no trade notes');
    expect(moneyLine(4500, null, 4)).toBe('money: 4,500 in coins, no trade notes');
    expect(moneyLine(800, tradeNotesOf(arcanistInv()), 52)).toMatch(/^money: 800 in coins \+ 10,000 in trade notes \(1 note\) = 10,800 \(notes are kept on death; vendors take only coins/);
    expect(moneyLine(undefined, tradeNotesOf(arcanistInv()))).toMatch(/^money: \? in coins \+ 10,000 in trade notes \(1 note\) \(/);
  });

  it('observe\'s header carries the notes (the agent API reads the packs), not coins alone', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.me.level = 48; host.me.pyreals = 1781;
    host.inv = bulwarkInv();
    const text = formatObservation(api.observe());
    expect(text).toContain('money: 1,781 in coins + 405,000 in trade notes (112 notes) = 406,781 (half your coins are lost if you die, notes are kept; vendors take only coins as payment');
    expect(text).not.toMatch(/^pyreals /m);
    expect(api.self()?.tradeNotes).toEqual({ value: 405_000, count: 112, unpriced: 0 });
    host.inv = [];
    expect(api.self()?.tradeNotes).toBeUndefined();
  });

  it('`character` carries a Money line: the server\'s CoinValue plus the notes', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.me.level = 52; host.me.pyreals = 1150;
    host.inv = arcanistInv();
    host.characterSheet = () => ARCANIST_SHEET;
    const sheet = api.characterSheet();
    expect(sheet.startsWith(ARCANIST_SHEET)).toBe(true);
    expect(sheet).toMatch(/\nMoney: 1,150 in coins \+ 10,000 in trade notes \(1 note\) = 11,150 \(half your coins are lost if you die, notes are kept; vendors take only coins as payment/);
  });

  it('the opening\'s money lines: yours, and both fellows\' purses when the partner\'s packs were read', () => {
    expect(moneyLines(arcanistInv(), ARCANIST_SHEET, { name: 'Claude Bulwark', items: bulwarkInv() })).toEqual([
      '- money: 1,150 in coins + 10,000 in trade notes (1 note) = 11,150 (half your coins are lost if you die, notes are kept; vendors take only coins as payment: sell a note to a vendor (most buy them) for its face value in coins)',
      '- fellowship money: you 11,150 (1,150 in coins + 10,000 in notes), Claude Bulwark 407,350 (2,350 in coins + 405,000 in notes)',
    ]);
    // The partner unreadable: no purse line, no guess.
    expect(moneyLines(bulwarkInv(), BULWARK_SHEET, { name: 'Claude Arcanist', items: null })).toEqual([
      '- money: 2,350 in coins + 405,000 in trade notes (112 notes) = 407,350 (half your coins are lost if you die, notes are kept; vendors take only coins as payment: sell a note to a vendor (most buy them) for its face value in coins)',
    ]);
    expect(moneyLines(null, null, null)).toEqual([]);
  });
});

describe('your own buffs: the Self level against the level your skill can learn', () => {
  it('Arcanist: all five at Self I, learnable to Self VI (skill 256: power 250 ≤ 256 + 50), with his Other levels', () => {
    const gaps = selfBuffGaps(ARCANIST_SHEET, arcanistSpells(), TABLE);
    expect(gaps.map((g) => [g.display, g.school, g.self, g.cap, g.other])).toEqual([
      ['Aura of Defender', 'Item Enchantment', 1, 6, 5],
      ['Coordination', 'Creature Enchantment', 1, 6, 4],
      ['Impregnability', 'Creature Enchantment', 1, 6, 3],
      ['Quickness', 'Creature Enchantment', 1, 6, 5],
      ['Strength', 'Creature Enchantment', 1, 6, 5],
    ]);
    // Each upgrade names the era's Self spells (highest first) and their ids, for the scroll lookup.
    expect(gaps.find((g) => g.display === 'Strength')!.upgrades.map((u) => [u.level, u.name, u.ids])).toEqual([
      [6, 'Strength Self VI', [1332]], [5, 'Strength Self V', [1331]], [4, 'Strength Self IV', [1330]], [3, 'Strength Self III', [1329]], [2, 'Strength Self II', [1328]],
    ]);
    expect(selfBuffLine(gaps, { magic: true, partner: 'Claude Bulwark' })).toBe(
      '- your own buffs: Aura of Defender is at Self I, though you can learn up to Self VI (your Item Enchantment 256); Coordination, Impregnability, Quickness and Strength are at Self I, though you can learn up to Self VI (your Creature Enchantment 256); you know Other V of Aura of Defender, Quickness and Strength, Other IV of Coordination and Other III of Impregnability, which go on someone else (Claude Bulwark), not on you');
  });

  it('the learnable level follows CanReadScroll per level\'s power (skill 180 → V; 120 → IV); a Self already at the cap says nothing', () => {
    const at = (skill: number) => ARCANIST_SHEET.replace(/Creature Enchantment 256/, `Creature Enchantment ${skill}`).replace(/Item Enchantment 256/, `Item Enchantment ${skill}`);
    expect(selfBuffGaps(at(180), arcanistSpells(), TABLE).map((g) => g.cap)).toEqual([5, 5, 5, 5, 5]);
    expect(selfBuffGaps(at(120), arcanistSpells(), TABLE).map((g) => g.cap)).toEqual([4, 4, 4, 4, 4]);
    const known = [spell('Strength Self VI', 'Creature'), spell('Quickness Self V', 'Creature')];
    expect(selfBuffGaps(ARCANIST_SHEET, known, TABLE).map((g) => [g.display, g.self, g.cap])).toEqual([['Quickness', 5, 6]]);
    // Without the table: learnableLevel's rule, no ids.
    expect(selfBuffGaps(ARCANIST_SHEET, known, null).map((g) => [g.display, g.self, g.cap, g.upgrades.length])).toEqual([['Quickness', 5, 6, 0]]);
  });

  it('Bulwark (no magic school) is told he casts none on himself', () => {
    expect(selfBuffLines({ sheet: BULWARK_SHEET, spells: [], table: TABLE })).toEqual(['- your own buffs: no magic school trained or specialized, so you cast none on yourself']);
  });

  it('the scrolls: the world DB\'s names and prices, from the seller nearest you, the highest level and the step below', () => {
    const gaps = selfBuffGaps(ARCANIST_SHEET, arcanistSpells(), TABLE);
    const { offers, vendors } = shopsFixture();
    const near = { ns: 41.9, ew: 33.6 }; // Holtburg
    const lines = scrollSellerLines(gaps, offers, vendors, near);
    expect(lines).toHaveLength(2);
    // Price: Vendor.GetSellCost ceil(SellPrice 50 × Value − 0.1): 1000 → 50,000; 200 → 10,000.
    expect(lines[0]).toBe('- Self VI scrolls: Aura of Defender Self VI, 50,000 pyreals, from Grand Master Scrivener of Item Magic at 1.6N, 71.9W indoors (Fort Tethana), the nearest, 112.9 W of you; Scroll of Coordination Self VI, Scroll of Impregnability Self VI, Scroll of Quickness Self VI and Scroll of Self Strength VI, 50,000 pyreals each, from Grand Master Scrivener of Creature Magic at 1.6N, 71.9W indoors (Fort Tethana), the nearest, 112.9 W of you');
    expect(lines[1]).toMatch(/^- Self V scrolls: Aura of Defender Self V, 10,000 pyreals, from Master Scrivener of Item Magic at 8\.0S, 73\.1E indoors \(Dryreach\), the nearest, [\d.]+ SE of you; Scroll of Coordination Self V, Scroll of Impregnability Self V, Scroll of Quickness Self V and Scroll of Self Strength V, 10,000 pyreals each, from Master Scrivener of Creature Magic/);
    // Where you are unknown (a dungeon): the vendor with the most places and its towns.
    expect(scrollSellerLines(gaps, offers, vendors, null)[0]).toMatch(/^- Self VI scrolls: Aura of Defender Self VI, 50,000 pyreals, from Grand Master Scrivener of Item Magic at [^;]+ and \d+ more towns;/);
    // A family no shop sells is said so.
    expect(scrollSellerLines(gaps, offers.filter((o) => o.spell !== 1604 && o.spell !== 1605), vendors, near).at(-1)).toBe('- no shop in this world sells a higher Self scroll of Aura of Defender');
  });

  it('the scroll lookup asks the world DB by spell id (PropertyDataId 28), not by name', () => {
    const ids = selfScrollIds(ARCANIST_SHEET, arcanistSpells(), TABLE);
    expect(ids).toEqual(expect.arrayContaining([1332, 1331, 1402, 1378, 261, 1605, 1328]));
    expect(ids).not.toContain(2); // Strength Self I: known already
    const sql = shopScrollOfferSql(ids);
    expect(sql).toMatch(/d\.type = 28 /);
    expect(sql).toContain('d.value IN (');
    expect(sql).toMatch(/destination_Type = 4\b/);
  });
});

describe('the segment opening carries both', () => {
  it('readinessBrief: the Self I gaps with the learnable level and the sellers, then both purses', () => {
    const r = readinessBrief({
      items: arcanistInv(), sheet: ARCANIST_SHEET, session: null, spells: arcanistSpells(), table: TABLE,
      partner: { name: 'Claude Bulwark', items: bulwarkInv() }, shops: shopsFixture(), near: { ns: 41.9, ew: 33.6 },
    })!;
    const lines = r.split('\n');
    const own = lines.findIndex((l) => l.startsWith('- your own buffs: '));
    expect(lines[own]).toContain('Coordination, Impregnability, Quickness and Strength are at Self I, though you can learn up to Self VI (your Creature Enchantment 256)');
    expect(lines[own + 1]).toMatch(/^- Self VI scrolls: .*Scroll of Self Strength VI, 50,000 pyreals each, from Grand Master Scrivener of Creature Magic at 1\.6N, 71\.9W indoors \(Fort Tethana\), the nearest/);
    expect(lines[own + 2]).toMatch(/^- Self V scrolls: /);
    expect(r).toContain('\n- money: 1,150 in coins + 10,000 in trade notes (1 note) = 11,150 (');
    expect(r).toContain('\n- fellowship money: you 11,150 (1,150 in coins + 10,000 in notes), Claude Bulwark 407,350 (2,350 in coins + 405,000 in notes)');
    // Bulwark's own: no magic, his money, Arcanist's purse.
    const b = readinessBrief({ items: bulwarkInv(), sheet: BULWARK_SHEET, session: null, spells: [], table: TABLE, partner: { name: 'Claude Arcanist', items: arcanistInv() } })!;
    expect(b).toContain('\n- your own buffs: no magic school trained or specialized, so you cast none on yourself');
    expect(b).toContain(`\n- money: 2,350 in coins + ${FMT(405_000)} in trade notes (112 notes) = 407,350 (`);
    expect(b).toContain('\n- fellowship money: you 407,350 (2,350 in coins + 405,000 in notes), Claude Arcanist 11,150 (1,150 in coins + 10,000 in notes)');
  });

  it('the supervisor reads the partner\'s packs, asks the shops for the Self scroll ids, and puts it all in the opening', async () => {
    const CAST = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8'));
    const cfg = parseStreamConfig({ ...CAST, maxSegments: 1, statusEverySeconds: 2, segment: { ...CAST.segment, minutes: 1, restartPauseSeconds: 0 } });
    const dir = mkdtempSync(join(tmpdir(), 'acjs-money-'));
    let now = Date.UTC(2026, 9, 18, 12);
    const opened: Record<string, string> = {};
    const asked: number[][] = [];
    const inv: Record<string, AgentItem[]> = { mage: arcanistInv(), soldier: bulwarkInv() };
    const sheets: Record<string, string> = { mage: ARCANIST_SHEET, soldier: BULWARK_SHEET };
    const known: Record<string, AgentSpell[]> = { mage: arcanistSpells().map((s) => ({ id: s.id!, name: s.name, school: s.school, level: s.level, buff: s.buff })), soldier: [] };
    const vitals = (): AgentVitals => ({ name: 'X', level: 50, health: { cur: 1, max: 1 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 }, xp: null, coords: '41.9N, 33.6E', cell: '0xA9B40021', indoors: false, dead: false, combatMode: 'peace', task: null, goal: null });
    const proc = (profile: string): PlayerProcess => {
      let done = false; let wake: (() => void) | null = null; let exitResolve!: (c: number | null) => void;
      const queue: string[] = [];
      const p: PlayerProcess = {
        lines: { [Symbol.asyncIterator]: () => ({ next: async () => { while (!queue.length && !done) await new Promise<void>((r) => (wake = r)); return queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true }; } }) } as AsyncIterable<string>,
        send(t) {
          const text = JSON.parse(t).message.content[0].text as string;
          opened[profile] ??= text;
          if (/Wrap up now/.test(text)) { queue.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'report', total_cost_usd: 0, num_turns: 1 })); wake?.(); }
        },
        endInput() { done = true; wake?.(); exitResolve(0); },
        kill() { done = true; wake?.(); exitResolve(143); },
        exit: new Promise((r) => (exitResolve = r)),
      };
      return p;
    };
    const deps: SupervisorDeps = {
      now: () => now,
      sleep: async (ms) => { now += ms; await new Promise((r) => setImmediate(r)); },
      tickMs: 5000,
      spawnPlayer: (_args, env) => proc(env.AC_AGENT_PROFILE),
      runCli: async () => ({ code: 0, out: '' }),
      daemonStatus: async () => ({ ready: true, attached: false }),
      vitals: async () => vitals(),
      inventory: async (p) => inv[p] ?? null,
      characterSheet: async (p) => sheets[p] ?? null,
      spells: async (p) => known[p] ?? null,
      spellTable: async () => TABLE,
      scrollShops: async (ids) => { asked.push(ids); return shopsFixture(); },
      callAgent: async (_p, m) => (m === 'status' ? { screen: 'character-select' } : { ok: true }),
      journal: () => '',
      brief: () => 'Brief',
      chatLines: () => [],
      stopRequested: () => false,
      feed: new FeedWriter(join(dir, 'feed.jsonl'), () => now),
      segments: { read: () => [], append: () => {} },
      saveReport: () => null,
      rawLine: () => {},
      log: () => {},
    };
    try {
      await new StreamSupervisor(cfg, deps).run();
      expect(opened.mage).toContain('\n- your own buffs: Aura of Defender is at Self I, though you can learn up to Self VI (your Item Enchantment 256); Coordination, Impregnability, Quickness and Strength are at Self I');
      expect(opened.mage).toMatch(/\n- Self VI scrolls: [^\n]*the nearest, 112\.9 W of you/);
      expect(opened.mage).toContain('\n- fellowship money: you 11,150 (1,150 in coins + 10,000 in notes), Claude Bulwark 407,350 (2,350 in coins + 405,000 in notes)');
      expect(opened.soldier).toContain('\n- your own buffs: no magic school trained or specialized, so you cast none on yourself');
      expect(opened.soldier).toContain('\n- fellowship money: you 407,350 (2,350 in coins + 405,000 in notes), Claude Arcanist 11,150 (1,150 in coins + 10,000 in notes)');
      // Only the mage had Self scrolls to look up, by spell id.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toEqual(expect.arrayContaining([1332, 1605]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
