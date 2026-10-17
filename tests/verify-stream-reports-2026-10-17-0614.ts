/**
 * The stream players' 2026-10-17 06:14Z reports (end-of-retail local ACE, Mountain Keep, segment 05:13–06:14Z;
 * reports …/stream/reports/*2026-10-17T06-1*.md): Bulwark's main pack sat full at 109/102 while his Pack sat 0/24, and
 * nothing could move an item into it. ac_move_item does it through the inventory's own drop path (placeItem →
 * the pack icon's item-list drop → PutItemInContainer) and reports once the server has moved it.
 * Drives the shipped AgentApi / format / tools code against the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { packSlotsText } from '../packages/renderer/src/agent/format.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, unknownArgs } from '../tools/ac-agent/tools.ts';
import { FakeHost } from './_harness/agentFake.ts';

const PACK_GUID = 0x8000338e;

function setup(host: FakeHost, opts: { refuse?: string; silent?: boolean; mainCount?: number } = {}): string[] {
  const sent: string[] = [];
  host.inv = [
    { guid: 0x80000a01, name: 'Undead Arm', where: 'main pack', itemType: 0x80, value: 0 },
    { guid: 0x80000a02, name: 'Skeletal Torso', where: 'main pack', itemType: 0x80, value: 0 },
    { guid: 0x80000a03, name: 'Salvaged Iron', where: 'main pack', itemType: 0x40000000, value: 100 },
    { guid: 0x80000a04, name: 'Plate Armor Hauberk', where: 'equipped', itemType: 0x2, value: 3000, slot: 'ChestArmor' },
    { guid: PACK_GUID, name: 'Pack', where: 'pack slots', itemType: 0x200 },
  ];
  const h = host as unknown as Record<string, unknown>;
  host.packs = () => [
    { slot: 0, guid: host.me.guid, capacity: 102, count: opts.mainCount ?? host.inv.filter((i) => i.where === 'main pack').length },
    { slot: 1, guid: PACK_GUID, capacity: 24, count: host.inv.filter((i) => i.inside === PACK_GUID).length },
  ];
  h.itemSlots = () => host.inv.map((i) => ({ guid: i.guid, name: i.name, packSlot: i.inside === PACK_GUID ? 1 : 0, stack: 1, maxStack: 1, wcid: 0, isPack: i.guid === PACK_GUID, equipped: i.where === 'equipped' }));
  h.placeItem = (guid: number, to: { packSlot: number } | { onto: number }) => {
    sent.push(`place ${guid.toString(16)} → ${'packSlot' in to ? `slot ${to.packSlot}` : `onto ${to.onto.toString(16)}`}`);
    // The server's answer comes later (InventoryPutObjInContainer moves it in the client's inventory), or a refusal.
    setTimeout(() => {
      if (opts.silent) return;
      if (opts.refuse) { (host as unknown as { api: AgentApi }).api.pushChat(opts.refuse); return; }
      const it = host.inv.find((i) => i.guid === guid)!;
      if ('packSlot' in to && to.packSlot === 1) { it.where = 'Pack'; it.inside = PACK_GUID; } else { it.where = 'main pack'; delete it.inside; }
    }, 300);
    return true;
  };
  return sent;
}

describe('ac_move_item: an item into a side pack and back (Bulwark, 06:14Z)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); (host as unknown as { api: AgentApi }).api = api; });
  afterEach(() => vi.useRealTimers());

  it('moves one item into the side pack once the server has moved it, then back to the main pack', async () => {
    const sent = setup(host);
    const p = api.moveItem('Undead Arm', 'side');
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(sent).toEqual(['place 80000a01 → slot 1']);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toBe('moved Undead Arm from your main pack into your Pack');
    expect(host.inv.find((i) => i.guid === 0x80000a01)!.inside).toBe(PACK_GUID);
    // By the pack's name, and back again.
    const back = api.moveItem(0x80000a01, 'main');
    await vi.advanceTimersByTimeAsync(2000);
    expect((await back).message).toBe('moved Undead Arm from your Pack into your main pack');
    expect(sent[1]).toBe('place 80000a01 → slot 0');
  });

  it('names the pack by name, #id or slot; an unknown one lists your packs', () => {
    setup(host);
    // Bulwark's side pack is named "Pack": its own name wins over "pack" meaning the main pack.
    expect(api.packFor('Pack')).toMatchObject({ slot: 1, name: 'Pack' });
    expect(api.packFor('main')).toMatchObject({ slot: 0 });
    expect(api.packFor('main pack')).toMatchObject({ slot: 0 });
    expect(api.packFor('1')).toMatchObject({ slot: 1, name: 'Pack' });
    expect(api.packFor('#8000338e')).toMatchObject({ slot: 1 });
    expect(api.packFor(null)).toMatchObject({ slot: 1 });
    expect(api.packFor('Sack')).toBe('no side pack named "Sack"; your packs: main pack (3/102), Pack #8000338e (0/24)');
  });

  it('says so, without sending, for a worn item, a pack, an item already there, and a full pack', async () => {
    const sent = setup(host);
    expect((await api.moveItem('Plate Armor Hauberk', 'side')).message).toBe('Plate Armor Hauberk is worn: ac_unequip it first (it goes to your main pack)');
    expect((await api.moveItem(PACK_GUID, 'main')).message).toMatch(/is a pack/);
    expect((await api.moveItem('Undead Arm', 'main'))).toEqual({ ok: true, message: 'Undead Arm is already in your main pack' });
    host.packs = () => [{ slot: 0, guid: host.me.guid, capacity: 102, count: 3 }, { slot: 1, guid: PACK_GUID, capacity: 24, count: 24 }];
    expect((await api.moveItem('Undead Arm', 'side'))).toEqual({ ok: false, message: 'not moved: Undead Arm: your Pack is full (24/24)' });
    expect(sent).toEqual([]);
  });

  it('a refusal from the server is reported as one, and no answer is not called a move', async () => {
    setup(host, { refuse: 'You cannot put that there.' });
    const p = api.moveItem('Undead Arm', 'side');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ ok: false, message: 'not moved: Undead Arm: You cannot put that there.' });
    const h2 = new FakeHost(); const a2 = new AgentApi(h2); (h2 as unknown as { api: AgentApi }).api = a2;
    setup(h2, { silent: true });
    const q = a2.moveItem('Undead Arm', 'side');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await q).toMatchObject({ ok: false, message: 'not moved: Undead Arm: no answer from the server in 4 s (ac_inventory in a moment shows whether it went through)' });
  });

  it('filter=junk moves every junk item (not worn gear, not the pack, not salvage) one after another', async () => {
    const sent = setup(host);
    const p = api.moveItems('junk', 'side');
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(sent).toEqual(['place 80000a01 → slot 1', 'place 80000a02 → slot 1']);
    expect(r.ok).toBe(true);
    expect(r.message.split('\n')[0]).toBe('moved 2 of 2 into your Pack (now 2/24)');
    expect(r.message).toContain('Undead Arm #80000a01: moved Undead Arm from your main pack into your Pack');
    const q = api.moveItems('junk', 'side');
    await vi.advanceTimersByTimeAsync(5000);
    const again = await q;
    expect(again.message).toBe('nothing to move: no junk items outside your Pack');
  });

  it('the pack-slots line points at it when the main pack is full beside a side pack with room', () => {
    expect(packSlotsText({ packs: [{ name: 'main pack', used: 109, capacity: 102, main: true }, { name: 'Pack', used: 0, capacity: 24, main: false }], free: 24 }))
      .toBe('pack slots: main pack 109/102 FULL, Pack 0/24 (24 free)  main pack FULL: ac_move_item moves items into your Pack (filter=junk, filter=salvage or item=…)');
  });

  it('the tool takes item=, items=, filter=, to= (and target= / pack=) and calls the page', async () => {
    const t = TOOL_BY_NAME.get('ac_move_item')!;
    expect(t).toBeDefined();
    expect(unknownArgs(t, { item: 'x', to: 'side', pack: 'Sack', target: 'y', filter: 'junk', items: 'a, b', max: 3 })).toBeNull();
    expect((await t.run({})).text).toMatch(/name the item/);
  });
});
