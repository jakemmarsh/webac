/**
 * AGENT.vtank-window — VirindiTank's Enable Autostack / Enable Autocram
 * (agent/macro/inventoryPlan.ts), and the engine doing them one move at a
 * time through the inventory's drop path when nothing else is to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planInventory, type InvItem } from '../packages/renderer/src/agent/macro/inventoryPlan.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF, emptyVtankData } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const item = (o: Partial<InvItem> & { guid: number }): InvItem => ({ name: 'Thing', packSlot: 0, stack: 1, maxStack: 1, wcid: 0, isPack: false, equipped: false, ...o });
const packs = [{ slot: 0, guid: 1, capacity: 102, count: 5 }, { slot: 1, guid: 2, capacity: 24, count: 24 }, { slot: 2, guid: 3, capacity: 24, count: 3 }];

describe('planInventory', () => {
  it('Autostack merges the smallest partial stack of a kind onto the largest; full stacks and other kinds stay', () => {
    const items = [
      item({ guid: 10, name: 'Prismatic Taper', stack: 40, maxStack: 100, wcid: 20631 }),
      item({ guid: 11, name: 'Prismatic Taper', stack: 5, maxStack: 100, wcid: 20631, packSlot: 2 }),
      item({ guid: 12, name: 'Prismatic Taper', stack: 100, maxStack: 100, wcid: 20631 }),
      item({ guid: 13, name: 'Pyreal', stack: 9, maxStack: 25000, wcid: 273 }),
    ];
    expect(planInventory({ items, packs, autostack: true, autocram: false })).toMatchObject({ kind: 'merge', from: 11, onto: 10 });
    expect(planInventory({ items: items.filter((i) => i.guid !== 11), packs, autostack: true, autocram: false })).toBeNull();
  });

  it('Autocram moves a main-pack item into the first side pack with room; packs and worn things stay', () => {
    const items = [item({ guid: 20, name: 'Side Pack', isPack: true }), item({ guid: 21, name: 'Sword', equipped: true }), item({ guid: 22, name: 'Rusty Key' }), item({ guid: 23, name: 'Gem', packSlot: 1 })];
    expect(planInventory({ items, packs, autostack: true, autocram: true })).toMatchObject({ kind: 'move', guid: 22, packSlot: 2 });
    expect(planInventory({ items, packs, autostack: true, autocram: false })).toBeNull();
    expect(planInventory({ items, packs: packs.map((p) => ({ ...p, count: p.capacity })), autostack: false, autocram: true })).toBeNull();
  });
});

describe('the macro tidies the packs when idle', () => {
  let host: FakeHost;
  let api: AgentApi;
  const moves: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    moves.length = 0;
    const h = host as unknown as Record<string, unknown>;
    h.itemSlots = () => [item({ guid: 30, name: 'Taper', stack: 3, maxStack: 100, wcid: 5 }), item({ guid: 31, name: 'Taper', stack: 7, maxStack: 100, wcid: 5, packSlot: 1 }), item({ guid: 32, name: 'Key' })];
    h.packs = () => [{ slot: 0, guid: 1, capacity: 102, count: 2 }, { slot: 1, guid: 2, capacity: 24, count: 1 }];
    h.placeItem = (g: number, to: { packSlot: number } | { onto: number }) => { moves.push(`${g} → ${JSON.stringify(to)}`); return true; };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (settings: Record<string, boolean>) => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, inventory: true, buffs: true, vitals: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, vtank: emptyVtankData(), settings: { EnableBuffing: false, ...settings },
  });

  it('Autostack (on by default) merges; with Autocram on it then crams; a move waits for the server between steps', async () => {
    api.routine.start(vt({}));
    await step(1200);
    expect(moves).toEqual(['30 → {"onto":31}']);
    await step(1000);
    expect(moves).toHaveLength(1);
    api.routine.stop();
    moves.length = 0;
    api.routine.start(vt({ AutoStack: false, AutoCram: true }));
    await step(1200);
    expect(moves[0]).toBe('30 → {"packSlot":1}');
  });

  it('neither option: nothing moves', async () => {
    api.routine.start(vt({ AutoStack: false }));
    await step(3000);
    expect(moves).toEqual([]);
  });
});

describe('Auto Fellow Mgmt (VirindiTank\'s fellowship commands)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (settings: Record<string, boolean> = {}) => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, inventory: true, buffs: true, vitals: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, vtank: emptyVtankData(), settings: { EnableBuffing: false, AutoStack: false, ...settings },
  });

  it('as leader, a /tell "xp" from a player in reach recruits them; "help" answers; not leader: nothing', async () => {
    host.add({ guid: 0x50000077, name: 'Asker', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 22 });
    let info: { leader: boolean; open: boolean; count: number } | null = { leader: true, open: false, count: 2 };
    (host as unknown as Record<string, unknown>).fellowshipInfo = () => info;
    api.routine.start(vt());
    api.pushChat('Asker tells you, "xp"', 3);
    await step(1500);
    expect(host.sent).toContain('fellowship recruit Asker 50000077');
    api.pushChat('Asker tells you, "help"', 3);
    await step(1500);
    expect(host.chats.some((c) => /^\/tell Asker, Tell me "xp"/.test(c))).toBe(true);
    info = { leader: false, open: false, count: 2 };
    host.sent.length = 0;
    api.pushChat('Asker tells you, "xp"', 3);
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('fellowship recruit'))).toEqual([]);
  });

  it('off: tells are ignored', async () => {
    host.add({ guid: 0x50000078, name: 'Asker', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 22 });
    (host as unknown as Record<string, unknown>).fellowshipInfo = () => ({ leader: true, open: false, count: 2 });
    api.routine.start(vt({ AutoFellowManagement: false }));
    api.pushChat('Asker tells you, "xp"', 3);
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('fellowship recruit'))).toEqual([]);
  });
});

describe('worn mana (RefillWornMana, M. Charges When Off) and pets (Summon Pets)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const data = (i: Record<number, number>) => ({ int: i, float: {}, string: {}, bool: {}, did: {}, spells: [] });

  function setup(over: { consumables?: string[]; items?: string[]; settings?: Record<string, unknown> } = {}) {
    host.inv = [
      { guid: 0x50000081, name: 'Amulet', where: 'equipped' },
      { guid: 0x50000082, name: 'Mana Stone', where: 'main pack' },
      { guid: 0x50000083, name: 'Wasp Essence', where: 'main pack' },
    ] as never;
    host.appraised.push(0x50000081, 0x50000082, 0x50000083);
    host.appraisalDatas.set(0x50000081, data({ 107: 100, 108: 1000 }));
    host.appraisalDatas.set(0x50000082, data({ 107: 5000 }));
    host.appraisalDatas.set(0x50000083, data({ 266: 1 }));
    const v = emptyVtankData();
    v.consumables = over.consumables ?? ['Mana Stone'];
    v.items = (over.items ?? []).map((name) => ({ name }));
    return {
      name: 'VT', modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, inventory: true, buffs: true, vitals: true },
      initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, vtank: v,
      settings: { EnableBuffing: false, AutoStack: false, AutoFellowManagement: false, ...(over.settings ?? {}) },
    };
  }

  it('a worn item under 33 % mana gets a charged stone from the Consumables tab used on you', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    api.routine.start(setup() as never);
    await step(1500);
    expect(host.sent).toContain('usewith 50000082 50000001');
  });

  it('M. Charges When Off: still while the macro is paused; off: not', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    api.routine.start(setup() as never);
    api.routine.pause();
    await step(1500);
    expect(host.sent).toContain('usewith 50000082 50000001');
    api.routine.stop();
    host.sent.length = 0;
    api.routine.start(setup({ settings: { ManaChargesWhenOff: false } }) as never);
    api.routine.pause();
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('usewith 50000082'))).toEqual([]);
  });

  it('Summon Pets: with enough monsters in pet range, the Items tab\'s pet device is used, once per 45 s', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    host.add({ guid: 0x80007001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    api.routine.start(setup({ consumables: [], items: ['Wasp Essence'], settings: { AttackDistance: 10, PetMonsterDensity: 1 } }) as never);
    await step(1500);
    expect(host.sent.filter((x) => x === 'use 50000083')).toHaveLength(1);
    await step(5000);
    expect(host.sent.filter((x) => x === 'use 50000083')).toHaveLength(1);
  });
});
