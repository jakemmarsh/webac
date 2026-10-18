/**
 * Stream reports, 2026-10-18 11:23–12:24Z (build 02056268; the stream runs e2860914): Claude Bulwark and Claude Arcanist
 * restocking at the Tufa Archmage (0x7C730119) between Aerbax Haven runs. Each block is one report item, its cause
 * proven first from the transcripts and page logs:
 *
 * 1. Opening the Archmage "timed out from 1.8 m": the use's walk (approach) took the doorway route into his cell,
 *    0x7C73011B, and he stands 1 m past that doorway's point (world DB: 113.984, 59.767, z 18.005; the player's floor is
 *    z 18.0 too, so no platform height). Every search for the doorway found none ("something stands in it"), the body
 *    stood 45 s at 6.7 m and the use gave up; a walk_to stood 71 s the same way before its last-resort wide search
 *    found the counter edge in 4 points. The straight line stops 1.6 m from him, inside his UseRadius 3. The window
 *    itself opened 0.3 s after a use from there: VENDOR_WINDOW_MS was not short. Reproduced on the real cells.
 * 2. `sell items=` (14) with no window open: every item's sell opened the window again (vendorReady per item), each
 *    walk replaced the one before, and past 30 s the call went to the background still looping. Now the window is
 *    opened once and every whole stack goes in one sale (one GameAction Sell, one ACE payout).
 * 3. "main pack 108/102 FULL, Pack 0/24": the main-pack count took every WORN item for a pack item (Bulwark's 91/102 at
 *    12:11:35Z was his 72 pack rows and 19 worn), and each of the 24 one-item sales paid a new coin stack (ACE
 *    CreatePayoutCoinStacks per HandleActionSellItem), which purchases and the trade-note merges then used up.
 * 4. "gone from your pack: Tiny Mana Charge (and 5 more in 5 other stacks…)": fixed by e2860914's stackable-only rule.
 *    Tiny Mana Charge (weenie 4612) has no MaxStackSize, so the client's slot row says maxStack 1 and no other "stacks"
 *    are named.
 * 5. Self buffs ~15 s from running out with "Arcanist fights" running weren't recast: her own `follow` held the routine
 *    (RoutineEngine.handOver) for the whole follow, up to 10 minutes. The routine's buffing now goes on between the
 *    steps of your own walk or follow.
 * 6. The "~900 m" stay_with walks were 2,503 m and 2,478 m (the walk's own goal distances, 12:03:21 and 12:19:26Z), at
 *    8.1–8.2 m/s against Bulwark's 10.3 m/s run: Arcanist runs slower, so he stopped every ~14 s for ~1.2 s
 *    (15–17 m behind, outside the 15 m leash: none inside it), plus two aggro stops for L20 chasers with no routine
 *    running (~12 s each) and 25 s while she cast six banes. No avoidable wait: no change.
 * 7. The Archmage's Lesser Mana Stone / Mana Stone / Greater Mana Stone (weenies 2434/2435/2436) carry no
 *    ItemCurMana: they are sold empty, as retail; only the Tiny Mana Charge (4612, ItemCurMana 100) holds mana. The
 *    prices are value × 1.55 (500, 1,000, 5,000; the charge 350 → 543). No change.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi, type AgentHost } from '../packages/renderer/src/agent/AgentApi.ts';
import { packSlotCounts } from '../packages/renderer/src/agent/packCounts.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, TOOL_CALLER, routineFromFile, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.js';
import type { Ac1999Fixture } from './_harness/ac1999Fixtures.js';

const REPO = resolve(__dirname, '..');
const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
  return out;
}

/** The real tool table over a caller that records each page call (`answer` may throw, as a page without the method does). */
function recorder(answer: (method: string, args: unknown[]) => { ok: boolean; message: string }) {
  const calls: Array<[string, unknown[]]> = [];
  const caller: ToolCaller = { notice: null, call: async <T,>(method: string, args?: unknown[]) => { calls.push([method, args ?? []]); return answer(method, args ?? []) as T; } };
  const tool = async (name: string, cli: string[]): Promise<{ text: string; isError?: boolean }> => {
    const t = TOOL_BY_NAME.get(name)!;
    return TOOL_CALLER.run(caller, () => t.run(parseCliArgs(t, cli)));
  };
  return { calls, tool };
}

// ── 1. The Tufa Archmage behind the doorway into his cell ──

const TUFA = 0x7c730000;
const ARCHMAGE = 0x77c73000;
// ACE-World landblock_instance for weenie 1370 in 0x7C73: 0x7C73011B (113.984, 59.7668, 18.005), angles W -0.684406 Z
// -0.729101; Setup 0x02000001 (the human), UseRadius 3.
const ARCHMAGE_FIXTURE: Ac1999Fixture = {
  guid: ARCHMAGE, wcid: 1370, name: 'Archmage', cell: 0x7c73011b, x: 113.984, y: 59.7668, z: 18.005,
  quat: { w: -0.684406, x: 0, y: 0, z: -0.729101 }, setupId: 0x02000001, itemType: 0x10, physicsState: 0x200418, locked: false, door: false,
};
// Where Bulwark stood when his `vendor target=#77c73000` set off (12:08:34Z): 6.7 m W of him in 0x7C730119.
const START = { x: 107.3, y: 60.0, z: 18.0 };

describe.skipIf(!haveDat)('1. the Tufa Archmage 1 m past the doorway into his cell (real cells, 0x7C73)', () => {
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(TUFA, { statics: true });
  }, 120_000);
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const host = async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const dh = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, TUFA, { fixtures: [ARCHMAGE_FIXTURE], creatures: true });
    dh.objectReach = (g) => ((dh.object(g)?.itemType ?? 0) & 0x10 ? 0.48 : 0);
    dh.objs.get(ARCHMAGE)!.objectDescFlags = 0x200; // a vendor (ObjectDescriptionFlag.Vendor)
    return dh;
  };

  for (const within of [2, 2.5]) {
    it(`walk_to him (within ${within}): straight to his reach, no search for the doorway his body fills`, async () => {
      const dh = await host();
      try {
        const t0 = dh.t;
        const r = await dh.walkTarget(0x7c730119, START, ARCHMAGE, { within, maxMs: 60_000, timeoutMs: 50_000 });
        const traces = dh.traces.join('\n');
        expect(r, traces).toMatchObject({ ok: true });
        expect(r.message).toMatch(/^arrived \(\d\.\d m from Archmage\)/);
        expect(dh.traces.some((l) => /something stands in it|walk search/.test(l)), traces).toBe(false);
        expect(dh.traces.some((l) => /to the goal's reach .* leaving out the 2 doorway\(s\)/.test(l)), traces).toBe(true);
        // A few seconds of running, not 45–71 s of searching.
        expect(dh.t - t0).toBeLessThan(5000);
        const d = Math.hypot(dh.me.x - ARCHMAGE_FIXTURE.x, dh.me.y - ARCHMAGE_FIXTURE.y);
        expect(d).toBeLessThan(3);
      } finally { dh.dispose(); }
    }, 300_000);
  }

  it('use opens his window from where the walk stops (the server\'s UseRadius 3 takes the rest)', async () => {
    const dh = await host();
    // ACE Vendor.ActOnUse once within UseRadius (3 m, plus the bodies): the window.
    dh.use = (g: number) => {
      dh.sent.push(`use ${g.toString(16)}`);
      const d = Math.hypot(dh.me.x - ARCHMAGE_FIXTURE.x, dh.me.y - ARCHMAGE_FIXTURE.y);
      if (g === ARCHMAGE && d <= 3 + 0.96) setTimeout(() => { dh.vendorOpen = { name: 'Archmage', guid: ARCHMAGE, currency: 'Pyreals', items: [] }; }, 300);
      return true;
    };
    try {
      const t0 = dh.t;
      const r = await dh.run(0x7c730119, START, (a) => a.use(ARCHMAGE), { maxMs: 60_000 });
      expect(r.message, dh.traces.join('\n')).toMatch(/vendor window open/);
      expect(dh.vendorOpen?.guid).toBe(ARCHMAGE);
      expect(dh.t - t0).toBeLessThan(10_000);
      expect(dh.sent.filter((s) => s === `use ${ARCHMAGE.toString(16)}`)).toHaveLength(1);
    } finally { dh.dispose(); }
  }, 300_000);
});

// ── 2. A list sold in one trip and one sale ──

describe('2. sell items= with no window open: one walk, one window, one sale', () => {
  let host: FakeHost;
  let api: AgentApi;
  const STONES = [0x80003859, 0x800034f4, 0x800041bd, 0x800040fd];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.pyreals = 1665;
    host.inv = [
      ...STONES.map((guid, i) => ({ guid, name: i === 0 ? 'Moderate Mana Stone' : 'Mana Stone', where: 'main pack', itemType: 0x80000, value: 1000 } as AgentItem)),
      { guid: 0x80003126, name: 'Pathwarden Helm', where: 'equipped', slot: 'HeadWear', itemType: 0x2 } as AgentItem,
    ];
    host.add({ guid: ARCHMAGE, name: 'Archmage', itemType: 0x10, objectDescFlags: 0x200, x: 86, y: 20, z: 94 });
    const use0 = host.use;
    host.use = (g) => { if (g === ARCHMAGE) setTimeout(() => { host.vendorOpen = { name: 'Archmage', guid: ARCHMAGE, currency: 'Pyreals', items: [] }; }, 600); return use0(g); };
    host.vendorSell = (g, n) => { host.sent.push(`sell ${g.toString(16)} x${n}`); return true; };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** ACE HandleActionSellItem: the list's items leave together and ONE payout comes. */
  const sellMany = (pay: number) => (guids: number[]): number[] => {
    host.sent.push(`sellmany ${guids.map((g) => g.toString(16)).join(' ')}`);
    setTimeout(() => { host.inv = host.inv.filter((i) => !guids.includes(i.guid)); host.me.pyreals! += pay; }, 400);
    return guids;
  };

  it('the page: the window opened once, then all four in one sale', async () => {
    (host as unknown as { vendorSellMany: AgentHost['vendorSellMany'] }).vendorSellMany = sellMany(4950);
    const surface = api.surface() as unknown as { sellList: (i: unknown[], n?: unknown, v?: unknown) => Promise<AgentResult> };
    const r = (await settle(api, host, surface.sellList(STONES, null, ARCHMAGE), 30_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(r.message.split('\n')[0]).toBe('(used Archmage to open its window)');
    expect(r.message.split('\n')[1]).toBe('sold 4 of 4 (4 in one sale for 4950 pyreals):');
    expect(r.message).toContain('  #80003859: sold Moderate Mana Stone');
    expect(host.sent.filter((s) => s.startsWith('use '))).toEqual([`use ${ARCHMAGE.toString(16)}`]);
    expect(host.sent.filter((s) => s.startsWith('sellmany '))).toEqual([`sellmany ${STONES.map((g) => g.toString(16)).join(' ')}`]);
    expect(host.sent.some((s) => s.startsWith('sell '))).toBe(false);
  });

  it('a host without the list sale: still one walk, then each from the open window', async () => {
    host.vendorSell = (g, n) => { host.sent.push(`sell ${g.toString(16)} x${n}`); setTimeout(() => { host.inv = host.inv.filter((i) => i.guid !== g); host.me.pyreals! += 900; }, 300); return true; };
    const r = (await settle(api, host, api.sellListAt(STONES, null, ARCHMAGE), 60_000))!;
    expect(r.message).toMatch(/^\(used Archmage to open its window\)\nsold 4 of 4:/);
    expect(host.sent.filter((s) => s.startsWith('use '))).toHaveLength(1);
    expect(host.sent.filter((s) => s.startsWith('sell '))).toHaveLength(4);
  });

  it('a name listed twice is two of that name; an id twice is one', async () => {
    (host as unknown as { vendorSellMany: AgentHost['vendorSellMany'] }).vendorSellMany = sellMany(1800);
    host.vendorOpen = { name: 'Archmage', guid: ARCHMAGE, currency: 'Pyreals', items: [] };
    const r = (await settle(api, host, api.sellListAt(['Mana Stone', 'Mana Stone', STONES[1]], null), 30_000))!;
    const sent = host.sent.find((s) => s.startsWith('sellmany '))!.split(' ').slice(1);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(r.message).toMatch(/listed twice \(sold once\)/);
  });

  it('a vendor that won\'t open: nothing is sold and nothing walks again', async () => {
    host.use = (g) => { host.sent.push(`use ${g.toString(16)}`); return true; };
    const r = (await settle(api, host, api.sellListAt(STONES, null, ARCHMAGE), 60_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^sold 0 of 4: Archmage's vendor window did not open/);
    // The one opening (its use and the use's own second try), not one per item; and no sale sent.
    expect(host.sent.filter((s) => s.startsWith('use ')).length).toBeLessThanOrEqual(2);
    expect(host.sent.some((s) => s.startsWith('sell'))).toBe(false);
  });

  it('the tool: ac_sell items= is one page call (sellList) carrying every item and the vendor', async () => {
    const { calls, tool } = recorder((m) => ({ ok: true, message: `${m} done` }));
    const out = await tool('ac_sell', ['vendor=#77c73000', 'items=#80003859, #800034f4, #800041bd']);
    expect(out.text).toBe('sellList done');
    expect(calls).toEqual([['sellList', [[0x80003859, 0x800034f4, 0x800041bd], null, ARCHMAGE]]]);
  });

  it('the tool on a page from before sellList: the window opened once (vendorReady), then sell by sell', async () => {
    const { calls, tool } = recorder((m) => {
      if (m === 'sellList') throw new Error('unknown agent method: sellList');
      return { ok: true, message: m === 'vendorReady' ? '(used Archmage to open its window)' : 'sold' };
    });
    const out = await tool('ac_sell', ['vendor=#77c73000', 'items=#80003859, #800034f4']);
    expect(calls.map(([m]) => m)).toEqual(['sellList', 'vendorReady', 'sell', 'sell']);
    expect(out.text).toBe('(used Archmage to open its window)\nsold 2 of 2:\n  #80003859: sold\n  #800034f4: sold');
  });

  it('the tool: ac_buy items= opens the window once (vendorReady) before the buys; a refusal ends it there', async () => {
    const ok = recorder((m) => ({ ok: true, message: m === 'vendorReady' ? '(used Archmage to open its window)' : 'bought' }));
    const out = await ok.tool('ac_buy', ['vendor=#77c73000', 'items=Tiny Mana Charge, Lead Scarab']);
    expect(ok.calls.map(([m]) => m)).toEqual(['vendorReady', 'buy', 'buy']);
    expect(out.text).toBe('(used Archmage to open its window)\nbought 2 of 2:\n  Tiny Mana Charge: bought\n  Lead Scarab: bought');
    const no = recorder((m) => (m === 'vendorReady' ? { ok: false, message: "Archmage's vendor window did not open" } : { ok: true, message: 'bought' }));
    const refused = await no.tool('ac_buy', ['vendor=#77c73000', 'items=Tiny Mana Charge, Lead Scarab']);
    expect(refused).toMatchObject({ isError: true, text: "bought 0 of 2: Archmage's vendor window did not open" });
    expect(no.calls.map(([m]) => m)).toEqual(['vendorReady']);
  });

  it('one item still goes by sell (no list call)', async () => {
    const { calls, tool } = recorder(() => ({ ok: true, message: 'sold' }));
    await tool('ac_sell', ['vendor=#77c73000', 'items=#80003859']);
    expect(calls.map(([m]) => m)).toEqual(['sell']);
  });
});

// ── 3. The main pack's count leaves worn items out ──

describe('3. pack slots count what is IN each pack: worn items are in none', () => {
  const ME = 0x500000a4, PACK = 0x800070e5, SACK = 0x8000338e;
  const ctx = (worn: number[]) => ({
    playerGuid: ME, sidePackGuids: [ME, PACK, SACK], worn: new Set(worn),
    isPack: (i: { id: number }) => i.id === PACK || i.id === SACK,
    capacityOf: (slot: number) => (slot === 0 ? 102 : 24),
  });

  it('Bulwark at 12:11:35Z: 72 pack items, 19 worn (container 0 or the player, as the records keep it): 72/102, not 91/102', () => {
    const main = Array.from({ length: 72 }, (_, i) => ({ id: 0x80020000 + i, containerId: ME }));
    // Worn from login (container 0) and re-worn after an unequip (the record kept the player as its container).
    const worn = Array.from({ length: 19 }, (_, i) => ({ id: 0x80030000 + i, containerId: i < 12 ? 0 : ME }));
    const inPack = Array.from({ length: 20 }, (_, i) => ({ id: 0x80040000 + i, containerId: PACK }));
    const inSack = Array.from({ length: 3 }, (_, i) => ({ id: 0x80050000 + i, containerId: SACK }));
    const packs = [{ id: PACK, containerId: ME }, { id: SACK, containerId: ME }];
    const counts = packSlotCounts([...main, ...worn, ...inPack, ...inSack, ...packs], ctx(worn.map((w) => w.id)));
    expect(counts).toEqual([
      { slot: 0, guid: ME, capacity: 102, count: 72 },
      { slot: 1, guid: PACK, capacity: 24, count: 20 },
      { slot: 2, guid: SACK, capacity: 24, count: 3 },
    ]);
  });

  it('a worn item in a side pack\'s record is not counted there either', () => {
    expect(packSlotCounts([{ id: 1, containerId: PACK }, { id: 2, containerId: PACK }], ctx([2]))[1].count).toBe(1);
  });

  it('observe\'s line from those counts: no FULL', () => {
    const host = new FakeHost();
    (host as unknown as { packs: AgentHost['packs'] }).packs = () => [{ slot: 0, guid: ME, capacity: 102, count: 89 }, { slot: 1, guid: PACK, capacity: 24, count: 0 }];
    const api = new AgentApi(host);
    const slots = api.packSlots()!;
    expect(slots.packs.map((p) => `${p.name} ${p.used}/${p.capacity}`)).toEqual(['main pack 89/102', 'side pack 1 0/24']);
    expect(slots.free).toBe(13 + 24);
  });
});

// ── 4. A Tiny Mana Charge used: the five others are not "stacks" of it ──

describe('4. use_on one of six Tiny Mana Charges: only that one is gone, no "other stacks" (e2860914)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const CHARGES = [0x80009800, 0x8000a18f, 0x8000a0f6, 0x8000a178, 0x8000a5e8, 0x8000a39e];
  const HELM = 0x80003126;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.inv = [
      ...CHARGES.map((guid) => ({ guid, name: 'Tiny Mana Charge', where: 'main pack', itemType: 0x80000, value: 350, burden: 50 } as AgentItem)),
      { guid: HELM, name: 'Pathwarden Helm', where: 'equipped', slot: 'HeadWear', itemType: 0x2 } as AgentItem,
    ];
    for (const i of host.inv) host.add({ guid: i.guid, name: i.name, cell: null as unknown as number, x: 0, y: 0 });
    // The client's slot rows: weenie 4612 has no MaxStackSize, so each charge is maxStack 1.
    (host as unknown as { itemSlots: AgentHost['itemSlots'] }).itemSlots = () => host.inv.map((i, n) => ({ guid: i.guid, name: i.name, packSlot: 0, stack: 1, maxStack: 1, wcid: i.name === 'Tiny Mana Charge' ? 4612 : 1, isPack: false, equipped: i.where === 'equipped' }));
    host.useWithTarget = (s, t) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => {
        // ACE ManaStone.HandleActionUseOnTarget: the mana given, then the stone destroyed.
        api.pushChat('The Mana Stone gives 100 points of mana to the Pathwarden Helm.\nThe Mana Stone is destroyed.', 0x00);
        host.inv = host.inv.filter((i) => i.guid !== s);
      }, 400);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the gone line names the one used; the five still carried are not listed as gone', async () => {
    const r = (await settle(api, host, api.useOnReported(CHARGES[0], HELM), 12_000))!;
    expect(r.message, r.message).toMatch(/gone from your pack: Tiny Mana Charge #80009800$/m);
    expect(r.message).not.toMatch(/other stacks?|5 more/);
    for (const g of CHARGES.slice(1)) expect(r.message).not.toContain(`#${g.toString(16)}`);
  });
});

// ── 5. The routine's buffing goes on while you follow ──

type Table = { spells: Map<number, { name: string; school: number; category: number; power: number; duration?: number; bitfield: number; nonComponentTargetType?: number; desc?: string }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

describe.skipIf(!existsSync(DAT_PATHS.portal))('5. "Arcanist fights" recasts a buff about to run out while your own follow / walk holds it (end-of-retail spell table)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  const SKILLS = [
    { id: 33, name: 'Life Magic', training: 'trained', base: 217, buffed: 255 },
    { id: 34, name: 'War Magic', training: 'specialized', base: 268, buffed: 316 },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 217, buffed: 255 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: 217, buffed: 255 },
    { id: 15, name: 'Magic Defense', training: 'trained', base: 200, buffed: 230 },
  ];
  const HELD = 0x01000000;
  const WAND: AgentItem = { guid: 0x8000b535, name: 'Wand', where: 'equipped', slot: 'Held', mask: HELD, validLocations: HELD, itemType: 0x8000 };
  const mage = (): RoutineProfile => {
    const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', 'mage.json'));
    if ('text' in r) throw new Error(r.text);
    return r.profile;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 51;
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => SKILLS;
    for (const s of SKILLS) host.skills.set(s.id, { base: s.base, buffed: s.buffed });
    host.me.combatMode = 'magic';
    host.me.health = { current: 184, max: 184 };
    host.me.mana = { current: 313, max: 330 };
    host.inv = [WAND, { guid: 0x80001100, name: 'Platemail Breastplate', where: 'equipped', slot: 'ChestArmor', mask: 0x200, itemType: 0x2 }];
    const ids = ['Focus Self V'].map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 5, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
    // 12:22:34Z: Focus Self V 1m32s left, her RebuffTimeRemainingSeconds 120.
    host.buffs = [{ spellId: id('Focus Self V'), name: 'Focus Self V', remaining: 92, beneficial: true }];
    host.cast = (spell: number, t: number | null) => {
      host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
      const s = table.spells.get(spell)!;
      setTimeout(() => { api.pushChat(`You cast ${s.name} on yourself, refreshing ${s.name}`, 0x07); host.buffs = host.buffs.map((b) => (b.spellId === spell ? { ...b, remaining: 1800 } : b)); }, 1500);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('during your own walk_to (150 m, still going) the buff under 2 min is cast, and your walk goes on', async () => {
    api.routine.start(mage());
    const surface = api.surface() as unknown as { walkTo: (t: string, o?: object) => Promise<AgentResult> };
    let done: AgentResult | null = null;
    void surface.walkTo('150m north').then((r) => { done = r; });
    for (let t = 0; t < 12_000; t += 100) { run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    const casts = host.sent.filter((s) => s.startsWith('cast '));
    expect(casts, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toEqual([`cast ${id('Focus Self V')} self`]);
    expect(api.routine.history().join('\n')).toMatch(/buff: .*\(while you walk\)/);
    // The walk wasn't stopped by it.
    expect(done).toBeNull();
  });

  it('not while your own attack holds it: only walks and follows let the buffing through', async () => {
    api.routine.start(mage());
    api.routine.handOver('attack', new Promise(() => {}));
    for (let t = 0; t < 8000; t += 100) { run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    expect(host.sent.filter((s) => s.startsWith('cast '))).toEqual([]);
  });
});
