/**
 * The tool bugs the stream players (Claude Arcanist / Claude Bulwark, end-of-retail local ACE) reported from the
 * Hollow Lair and Daiklos, 2026-10-16 06:28–07:29 UTC (reports …/stream/reports/*2026-10-16T07-29*.md; progress.md
 * 2026-10-16):
 *  1. a wait woke on "vitals-low: health 93/156 (60%)" with Arcanist at 156/156: the fall was queued during a cast and
 *     two Heal Selfs came before the wait (06:48:19).
 *  2. `inventory filter=junk` found nothing with undead arms, legs and a thighbone in the pack (07:28:09).
 *  3. a loot answered "Claude Bulwark is completely full!" per item at 60% burden: the main pack's 102 slots were
 *     taken, and nothing said so before.
 *  4. `raise target="Magic Defense"` answered `unknown argument "target" (have: stat, times, profile)`.
 *  5. a give bounced on "too busy to accept gifts" / "one item at a time" and had to be sent again by hand (07:24).
 * Each drives the shipped AgentApi / format / tools code against the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { filterInventory, formatInventoryFiltered, formatObservation, isJunk, isSellable, packSlotsText } from '../packages/renderer/src/agent/format.ts';
import type { AgentEvent, AgentItem } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, closestArg, unknownArgMessage, unknownArgs, withArgAliases } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { handle } from '../tools/ac-agent/mcp-server.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const BULWARK = 0x500000a4;

async function waitFor(api: AgentApi, types: AgentEvent['type'][]): Promise<AgentEvent[]> {
  const p = api.wait({ types }, 500);
  await vi.advanceTimersByTimeAsync(600);
  return p;
}

describe('1. a vitals-low queued while low is not handed back after a heal', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.health = { current: 156, max: 156 };
    run(api, host, 300, { physics: false });
  });
  afterEach(() => vi.useRealTimers());

  it('the fall during a cast, two heals, then the wait: nothing (06:48:19); still low: delivered', async () => {
    host.me.health.current = 120; // two hits, neither a quarter of it
    run(api, host, 300, { physics: false });
    host.me.health.current = 93; // 60% → under the 60% mark
    run(api, host, 300, { physics: false });
    expect(api.eventsSince(0).filter((e) => e.type === 'vitals-low').map((e) => e.text)).toEqual(['health 93/156 (60%): below 60%']);
    host.me.health.current = 156;
    run(api, host, 300, { physics: false });
    expect(await waitFor(api, ['vitals-low'])).toEqual([]);
    // A fall that is still a fall when the wait comes is delivered; the old one about 93 is history.
    host.me.health.current = 120;
    run(api, host, 300, { physics: false });
    host.me.health.current = 80;
    run(api, host, 300, { physics: false });
    // One fall, one event (2026-10-18 stream: one Frost Bolt crit raised "below 60%" and "fell … at once" as two).
    expect((await waitFor(api, ['vitals-low'])).map((e) => e.text)).toEqual(['health fell 120 → 80 of 156 at once (−26% of your health in one hit): 80/156 (51%), below 60%']);
  });

  it('a big single hit stays news until you are back where it found you', async () => {
    host.me.health.current = 100; // −36%: one big hit, still above 60%
    run(api, host, 300, { physics: false });
    host.me.health.current = 120; // partly healed: still under the 156 the hit found
    run(api, host, 300, { physics: false });
    expect((await waitFor(api, ['vitals-low'])).map((e) => e.text)).toEqual(['health fell 156 → 100 of 156 at once (−36% of your health in one hit)']);
    host.me.health.current = 100;
    run(api, host, 300, { physics: false });
    host.me.health.current = 156;
    run(api, host, 300, { physics: false });
    expect(await waitFor(api, ['vitals-low'])).toEqual([]);
  });

  it('a wait\'s own mana mark: stale once mana is back over it', async () => {
    host.me.mana = { current: 30, max: 30 };
    const p = api.wait({ types: ['vitals-low'], manaBelow: 0.5 }, 400);
    host.me.mana.current = 10;
    run(api, host, 300, { physics: false });
    expect((await p).map((e) => e.text)).toEqual(['mana 10/30 (33%): below your 50% mark']);
    const seq = api.currentSeq();
    host.me.mana.current = 30;
    const again = api.waitFor({ types: ['vitals-low'], sinceSeq: seq - 1 }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(await again).toEqual([]);
  });

  it('a fellow healed back over the mark: their fellow-low is dropped too', async () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20 });
    const bulwark = { guid: BULWARK, name: 'Claude Bulwark', health: { cur: 200, max: 200 }, stamina: { cur: 100, max: 100 }, mana: { cur: 50, max: 50 } };
    host.fellows = () => [bulwark];
    run(api, host, 600, { physics: false });
    bulwark.health.cur = 100;
    run(api, host, 600, { physics: false });
    expect(api.eventsSince(0).filter((e) => e.type === 'fellow-low').length).toBe(1);
    bulwark.health.cur = 200;
    run(api, host, 600, { physics: false });
    expect(await waitFor(api, ['fellow-low'])).toEqual([]);
  });
});

/** Bulwark's pack at 07:28 (ac_inventory), in the shape the page hands back. */
const PACK: AgentItem[] = [
  { guid: 0x8000de8d, name: 'Undead Arm', where: 'main pack', itemType: 0x80, type: 'Misc', burden: 250 },
  { guid: 0x80000be1, name: 'Skeletal Torso', where: 'main pack', itemType: 0x80, type: 'Misc', burden: 400 },
  { guid: 0x80002f19, name: 'Undead Thighbone', where: 'main pack', itemType: 0x80, type: 'Misc', burden: 10 },
  { guid: 0x8000119d, name: 'Dinner Plate', where: 'main pack', itemType: 0x100, type: 'Missile Weapon', value: 142, burden: 50 },
  { guid: 0x80001341, name: 'Chainmail Hauberk', where: 'main pack', itemType: 0x2, type: 'Armor', value: 22451, burden: 1500 },
  { guid: 0x80003542, name: 'Facility Hub Portal Gem', where: 'main pack', itemType: 0x800, type: 'Gem' },
  { guid: 0x8000376f, name: 'Academy Library Key', where: 'main pack', itemType: 0x4000, type: 'Key' },
  { guid: 0x800034d7, name: 'Letter From Home', where: 'main pack', itemType: 0x2000, type: 'Writable', value: 10 },
  { guid: 0x800108a5, name: 'Trade Note (10,000)', where: 'main pack', itemType: 0x40000, type: 'Promissory Note', stack: 5, value: 50000 },
  { guid: 0x80010626, name: 'Pyreal', where: 'Sack', inside: 0x8000338e, itemType: 0x40, type: 'Money', stack: 6239, value: 6239 },
  { guid: 0x8000338e, name: 'Sack', where: 'pack slots', itemType: 0x200, type: 'Container', value: 1201 },
  { guid: 0x80001c7a, name: 'Lugian Hammer', where: 'equipped', itemType: 0x1, slot: 'MeleeWeapon', value: 3000 },
  { guid: 0x80009999, name: 'Retained Sword', where: 'main pack', itemType: 0x1, value: 5000, objectDescFlags: 0x01000000 },
];

describe('2. inventory filter=junk and filter=sell', () => {
  it('junk is what no vendor buys and players don\'t keep anyway: the undead parts, not the gem, key, letter or money', () => {
    expect(filterInventory(PACK, 'junk').items.map((i) => i.name)).toEqual(['Undead Arm', 'Skeletal Torso', 'Undead Thighbone']);
    expect(isJunk({ guid: 1, name: 'Broken Thing', where: 'main pack', itemType: 0x400, value: 5 })).toBe(true); // ItemType Useless
    expect(isJunk({ guid: 2, name: 'Mystery', where: 'main pack' })).toBe(false); // type not known yet: not called junk
    const text = formatInventoryFiltered(PACK, 'junk');
    expect(text.split('\n').slice(0, 4)).toEqual([
      '3 junk items:',
      '  #8000de8d Undead Arm  (in main pack, Misc, no value, burden 250)',
      '  #80000be1 Skeletal Torso  (in main pack, Misc, no value, burden 400)',
      '  #80002f19 Undead Thighbone  (in main pack, Misc, no value, burden 10)',
    ]);
    expect(text).toContain('has no value and cannot be sold');
    expect(filterInventory(PACK, 'trash').kind).toBe('junk');
  });

  it('sell is what a vendor pays for, most valuable first with the total: no money, notes, packs, worn or Retained items', () => {
    expect(filterInventory(PACK, 'sell').items.map((i) => i.name).sort()).toEqual(['Chainmail Hauberk', 'Dinner Plate', 'Letter From Home']);
    expect(isSellable(PACK.find((i) => i.name === 'Retained Sword')!)).toBe(false);
    const lines = formatInventoryFiltered(PACK, 'sell').split('\n');
    expect(lines[0]).toBe('3 sell items, worth 22,603 in all:');
    expect(lines[1]).toBe('  #80001341 Chainmail Hauberk  (in main pack, Armor, value 22,451, burden 1,500)');
    expect(lines[3]).toBe('  #800034d7 Letter From Home  (in main pack, Writable, value 10)');
  });

  it('the tool and its usage name both kinds', () => {
    const d = String(TOOL_BY_NAME.get('ac_inventory')!.props.filter.description);
    expect(d).toContain('junk = carried items no vendor buys');
    expect(d).toContain('sell = what a vendor pays for');
  });
});

describe('3. pack slots in observe and inventory, and a loot that runs out of them', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('counts the main pack and each side pack; LOW at 5 free or fewer', () => {
    host.inv = PACK.map((i) => ({ ...i }));
    host.packs = () => [{ slot: 0, guid: host.me.guid, capacity: 102, count: 102 }, { slot: 1, guid: 0x8000338e, capacity: 24, count: 20 }];
    const slots = api.packSlots()!;
    expect(slots).toEqual({ packs: [{ name: 'main pack', used: 102, capacity: 102, main: true }, { name: 'Sack', used: 20, capacity: 24, main: false }], free: 4 });
    expect(packSlotsText(slots)).toBe('pack slots: main pack 102/102 FULL, Sack 20/24 (4 free)  main pack FULL: ac_move_item moves items into your Sack (filter=junk, filter=salvage or item=…)  LOW: an item with no slot left is refused ("… is completely full!") whatever your burden; drop or sell some first (ac_inventory filter=junk lists what no vendor buys, filter=sell what they do)');
    expect(packSlotsText({ packs: [{ name: 'main pack', used: 80, capacity: 102, main: true }], free: 22 })).toBe('pack slots: main pack 80/102 (22 free)');
    run(api, host, 200, { physics: false });
    expect(formatObservation(api.snapshot())).toContain('\npack slots: main pack 102/102 FULL, Sack 20/24 (4 free)  main pack FULL: ac_move_item');
  });

  it('a host without side-pack counts still says the main pack\'s free slots', () => {
    host.freeSlots = 40;
    expect(api.packSlots()).toEqual({ packs: [], free: 40 });
    expect(packSlotsText(api.packSlots()!)).toBe('pack slots: 40 free in the main pack');
  });

  it('a loot that hits "completely full" ends naming junk to drop and the cheapest things to sell', async () => {
    host.inv = PACK.map((i) => ({ ...i }));
    host.packs = () => [{ slot: 0, guid: host.me.guid, capacity: 102, count: 101 }];
    const CORPSE = 0x80000a10;
    host.add({ guid: CORPSE, name: 'Corpse of Drudge Lurker', objectDescFlags: 0x2000, x: 81, y: 21 });
    const content = [{ guid: 0x80000a11, name: 'Smoky Quartz' }, { guid: 0x80000a12, name: 'Undead Leg' }];
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); if (g === CORPSE) host.container = { guid: CORPSE, items: content.map((i) => ({ ...i })) }; return true; };
    let taken = 0;
    host.pickUp = (g: number) => {
      host.sent.push(`pickup ${g.toString(16)}`);
      if (taken >= 1) { api.pushChat('Claude Test is completely full!'); return true; }
      taken++;
      const it = content.find((i) => i.guid === g)!;
      host.inv.push({ guid: g, name: it.name, where: 'main pack', itemType: 0x800, value: 40 });
      content.splice(content.indexOf(it), 1);
      host.container = { guid: CORPSE, items: content.map((i) => ({ ...i })) };
      return true;
    };
    const p = api.loot('Corpse of Drudge Lurker', null);
    run(api, host, 30_000);
    const r = await p;
    expect(r.message.split('\n')[0]).toBe('took 1: Smoky Quartz; could not take 1: Undead Leg (Claude Test is completely full!)');
    expect(r.message.split('\n')[1]).toBe('  pack: out of pack slots: an item with nowhere to go is refused ("… is completely full!") whatever your burden (1 free item slot). To make room: junk no vendor buys (drop it: ac_drop): Undead Arm #8000de8d, Skeletal Torso #80000be1, Undead Thighbone #80002f19; cheapest to sell: Letter From Home #800034d7 (10), Smoky Quartz #80000a11 (40), Dinner Plate #8000119d (142), Chainmail Hauberk #80001341 (22,451) (ac_inventory filter=sell)');
  });

  it('a loot with plenty of room says nothing about slots', async () => {
    host.freeSlots = 50;
    const CORPSE = 0x80000a20;
    host.add({ guid: CORPSE, name: 'Corpse of Lich', objectDescFlags: 0x2000, x: 81, y: 21 });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = { guid: CORPSE, items: [{ guid: 0x80000a21, name: 'Amber' }] }; return true; };
    host.pickUp = (g: number) => { host.inv.push({ guid: g, name: 'Amber', where: 'main pack' }); host.container = { guid: CORPSE, items: [] }; return true; };
    const p = api.loot('Corpse of Lich', null);
    run(api, host, 10_000);
    expect((await p).message).toBe('took 1: Amber');
  });
});

describe('4. an argument a tool doesn\'t take names the one it meant', () => {
  it('raise target= is stat= on the CLI and over MCP (it was refused, 78 times across 2026-10-16/17; raise has one name argument)', async () => {
    const raise = TOOL_BY_NAME.get('ac_raise')!;
    for (const k of ['target', 'name', 'attribute', 'vital', 'what']) {
      expect(withArgAliases(raise, { [k]: 'Magic Defense' }), k).toEqual({ stat: 'Magic Defense' });
      expect(unknownArgs(raise, { [k]: 'Magic Defense' }), k).toBeNull();
    }
    expect(withArgAliases(raise, { stat: 'Strength', target: 'Healing' })).toEqual({ stat: 'Strength' });
    const r = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ac_raise', arguments: { target: 'mana' } } }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(r.result.content[0].text).not.toMatch(/unknown argument/);
  });

  it('generic over every tool: misspellings, synonyms, and nothing invented when nothing fits', () => {
    const cast = TOOL_BY_NAME.get('ac_cast')!;
    expect(closestArg(cast, 'spel')).toBe('spell');
    expect(closestArg(TOOL_BY_NAME.get('ac_say')!, 'message')).toBe('text');
    expect(closestArg(TOOL_BY_NAME.get('ac_wait')!, 'timeout')).toBe('timeout_s');
    expect(closestArg(TOOL_BY_NAME.get('ac_give')!, 'recipient', { item: 'Necklace' })).toBe('target');
    expect(unknownArgMessage(TOOL_BY_NAME.get('ac_raise')!, 'zebra')).toBe('ac_raise: unknown argument "zebra" (usage: raise [stat=…] [times=…])');
    // Every tool's own arguments (and aliases, and the hosted account) pass.
    for (const t of TOOL_BY_NAME.values()) expect(unknownArgs(t, Object.fromEntries(Object.keys(t.props).map((k) => [k, 'x'])), ['account'])).toBeNull();
    expect(unknownArgs(cast, { spell: 'Flame Bolt IV', account: 'a' }, ['account'])).toBeNull();
  });
});

describe('5. a give bounced because one of you was busy is tried once more', () => {
  let host: FakeHost;
  let api: AgentApi;
  const ARCANIST = 0x500000a3;
  const SCROLL = 0x8000ee55;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [{ guid: SCROLL, name: 'Scroll of Armor Self VI', where: 'main pack', itemType: 0x2000 }];
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80.8, y: 20 });
  });
  afterEach(() => vi.useRealTimers());
  async function settle<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let out: T | null = null;
    let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  }

  it('"too busy to accept gifts" (reading a scroll, 07:24:48): a second try 3 s later goes, and the reply says so', async () => {
    let sends = 0;
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      if (++sends === 1) {
        setTimeout(() => { api.pushChat('Claude Arcanist is too busy to accept gifts right now.', 0x1a); api.pushChat('The Scroll of Armor Self VI can\'t be given', 0x1a); }, 300);
      } else {
        setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Scroll of Armor Self VI.', 0x0); }, 300);
      }
      return true;
    };
    const r = await settle(api.give('Scroll of Armor Self VI', 'Claude Arcanist', null), 30_000);
    expect(host.sent.filter((x) => x.startsWith('give'))).toHaveLength(2);
    expect(r).toEqual({ ok: true, message: 'gave 1 Scroll of Armor Self VI to Claude Arcanist\n  You give Claude Arcanist Scroll of Armor Self VI.\n  (the first try was refused: Claude Arcanist is too busy to accept gifts right now.; gave again after 3 s)' });
  });

  it('busy twice: one retry only, and the refusal says it was the second try', async () => {
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      setTimeout(() => api.pushChat('You can only move or use one item at a time', 0x1a), 300);
      return true;
    };
    const r = await settle(api.give('Scroll of Armor Self VI', 'Claude Arcanist', null), 40_000);
    expect(host.sent.filter((x) => x.startsWith('give'))).toHaveLength(2);
    expect(r?.ok).toBe(false);
    expect(r?.message.split('\n')[0]).toBe('Claude Arcanist did not get your Scroll of Armor Self VI on the second try either; the server said:');
    expect(r?.message).toContain('(the first try was refused: You can only move or use one item at a time; gave again after 3 s)');
  });

  it('any other refusal is not retried', async () => {
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      setTimeout(() => api.pushChat('Claude Arcanist is not accepting gifts right now.', 0x1a), 300);
      return true;
    };
    const r = await settle(api.give('Scroll of Armor Self VI', 'Claude Arcanist', null), 30_000);
    expect(host.sent.filter((x) => x.startsWith('give'))).toHaveLength(1);
    expect(r?.ok).toBe(false);
  });
});

describe('3b. ac_inventory leads with the pack slots line when the page has them', () => {
  it('the line first, then the listing; an older page without packSlots: the listing alone', async () => {
    const { TOOL_CALLER } = await import('../tools/ac-agent/tools.ts');
    const tool = TOOL_BY_NAME.get('ac_inventory')!;
    const slots = { packs: [{ name: 'main pack', used: 101, capacity: 102, main: true }], free: 1 };
    const withSlots = { notice: null, call: async <T,>(m: string) => (m === 'packSlots' ? slots : PACK) as T };
    const r = await TOOL_CALLER.run(withSlots, () => tool.run(parseCliArgs(tool, ['filter=junk'])));
    expect(r.text.split('\n')[0]).toBe(packSlotsText(slots));
    expect(r.text.split('\n')[1]).toBe('3 junk items:');
    const old = { notice: null, call: async <T,>(m: string) => { if (m === 'packSlots') throw new Error('unknown agent method: packSlots'); return PACK as T; } };
    const o = await TOOL_CALLER.run(old, () => tool.run(parseCliArgs(tool, ['filter=junk'])));
    expect(o.text.split('\n')[0]).toBe('3 junk items:');
  });
});
