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

  const VT = (s: string) => `[VT Fellow Manager] ${s} -v-`;
  const tells = (to: string) => host.chats.filter((c) => c.startsWith(`/tell ${to}, `)).map((c) => c.slice(`/tell ${to}, `.length));
  const fchat = () => host.chats.filter((c) => c.startsWith('/f ')).map((c) => c.slice(3));
  const recruits = () => host.sent.filter((x) => x.startsWith('fellowship recruit'));
  const leaders = () => host.sent.filter((x) => x.startsWith('fellowship leader'));
  const player = (guid: number, name: string) => host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 22 });
  const tell = (from: string, text: string) => api.pushChat(`${from} tells you, "${text}"`, 3);
  const lead = (members: string[], handOff = true) => { host.fellowInfo = { leader: true, open: false, count: members.length, members, handOff }; };

  it('as leader, a /tell "xp" from a player in reach recruits them; "help" and "leader" answer; not leader: nothing', async () => {
    player(0x50000077, 'Asker');
    lead(['Claude Test']);
    api.routine.start(vt());
    tell('Asker', 'XP');
    await step(1500);
    expect(tells('Asker')).toEqual([VT('I will recruit you in a moment. Please stand close to me.')]);
    expect(recruits()).toEqual(['fellowship recruit Asker 50000077']);
    await step(5000); // the Recruit waits up to 5 s for the pane to change
    tell('Asker', 'help');
    await step(1500);
    expect(tells('Asker').at(-1)).toBe(VT('Available commands: xp, line, remove, leader, startvote, vote, help'));
    tell('Asker', 'leader');
    await step(1000);
    expect(tells('Asker').at(-1)).toBe(VT('The fellowship leader is Claude Test.'));
    host.fellowInfo = { leader: false, open: false, count: 2, members: ['Other', 'Claude Test'], handOff: true };
    host.sent.length = 0;
    host.chats.length = 0;
    tell('Asker', 'xp');
    await step(1500);
    expect(recruits()).toEqual([]);
    expect(host.chats).toEqual([]);
  });

  it('too far: told so, one more chance 20 s later; still away then, dropped', async () => {
    lead(['Claude Test']);
    api.routine.start(vt());
    tell('Faraway', 'xp');
    await step(1500);
    expect(tells('Faraway')).toEqual([VT('I will recruit you in a moment. Please stand close to me.'), VT('You are too far away. I will wait 20 seconds and give you one more chance.')]);
    expect(recruits()).toEqual([]);
    await step(15000);
    player(0x50000079, 'Faraway');
    await step(6000);
    expect(recruits()).toEqual(['fellowship recruit Faraway 50000079']);
    tell('Gone', 'xp');
    await step(22000);
    expect(recruits()).toHaveLength(1);
    expect(tells('Gone')).toHaveLength(2);
  });

  it('full: a waiting line (line, remove); when a fellow leaves, the next in line is recruited', async () => {
    const nine = ['Claude Test', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    lead(nine);
    player(0x50000081, 'First');
    player(0x50000082, 'Second');
    api.routine.start(vt());
    tell('First', 'xp');
    tell('Second', 'xp');
    await step(1500);
    expect(tells('First')).toEqual([VT('The fellowship is full. You are number 1 in line.')]);
    expect(tells('Second')).toEqual([VT('The fellowship is full. You are number 2 in line.')]);
    tell('Second', 'line');
    await step(1000);
    expect(tells('Second').at(-1)).toBe(VT('Fellowship: 9/9. Waiting list: First, Second. You are number 2.'));
    tell('Second', 'remove');
    await step(1000);
    expect(tells('Second').at(-1)).toBe(VT('You have been removed from the waiting list.'));
    tell('Second', 'remove');
    await step(1000);
    expect(tells('Second').at(-1)).toBe(VT('You are not on the waiting list.'));
    expect(recruits()).toEqual([]);
    lead(nine.filter((n) => n !== 'C')); // C left
    await step(1500);
    expect(tells('First').at(-1)).toBe(VT('I will recruit you in a moment. Please stand close to me.'));
    expect(recruits()).toEqual(['fellowship recruit First 50000081']);
    // The offer holds the slot: another asker queues until First joins or the offer lapses.
    await step(5000);
    tell('Second', 'xp');
    await step(1000);
    expect(tells('Second').at(-1)).toBe(VT('The fellowship is full. You are number 1 in line.'));
  });

  it('at most 8 commands per player in 3 minutes; other players are still answered', async () => {
    lead(['Claude Test']);
    api.routine.start(vt());
    for (let i = 0; i < 10; i++) tell('Spammer', 'help');
    tell('Polite', 'help');
    await step(3000);
    expect(tells('Spammer')).toHaveLength(8);
    expect(tells('Polite')).toHaveLength(1);
    host.t += 180_000;
    tell('Spammer', 'help');
    await step(1000);
    expect(tells('Spammer')).toHaveLength(9);
  });

  it('startvote giveleader: announced in fellowship chat, 2 minutes, a majority passes leadership through the Leader action', async () => {
    lead(['Claude Test', 'Bob', 'Cid', 'Dee']);
    api.routine.start(vt());
    tell('Bob', 'startvote giveleader cid');
    await step(1000);
    expect(fchat()).toEqual([VT("Bob has called a new vote: giveleader Cid! To vote either tell me 'vote 1 yes' or 'vote 1 no'. You have 2 minutes.")]);
    tell('Bob', 'vote 1 yes');
    tell('Cid', 'vote 1 yes');
    tell('Dee', 'vote 1 no');
    tell('Outsider', 'vote 1 yes'); // not a fellow: not counted
    await step(1000);
    expect(leaders()).toEqual([]);
    host.t += 120_000;
    await step(2000);
    expect(fchat().at(-1)).toBe(VT("Vote total for 'giveleader Cid' (1): 2/3"));
    expect(leaders()).toEqual(['fellowship leader Cid']);
  });

  it('a vote without a majority hands nothing over; a startvote for a non-fellow gets the usage', async () => {
    lead(['Claude Test', 'Bob', 'Cid', 'Dee']);
    api.routine.start(vt());
    tell('Bob', 'startvote giveleader Nobody');
    await step(1000);
    expect(tells('Bob')).toEqual([VT('Usage: startvote giveleader <fellow>')]);
    tell('Bob', 'startvote giveleader Dee');
    await step(1000);
    tell('Dee', 'vote 1 yes');
    await step(1000);
    host.t += 120_000;
    await step(2000);
    expect(fchat().at(-1)).toBe(VT("Vote total for 'giveleader Dee' (1): 1/3"));
    expect(leaders()).toEqual([]);
  });

  it('an era whose client has no Leader hand-off (1999): help leaves out startvote and vote, and they are ignored', async () => {
    lead(['Claude Test', 'Bob', 'Cid'], false);
    api.routine.start(vt());
    tell('Bob', 'help');
    tell('Bob', 'startvote giveleader Cid');
    await step(2000);
    expect(tells('Bob')).toEqual([VT('Available commands: xp, line, remove, leader, help')]);
    expect(fchat()).toEqual([]);
  });

  it('startvote names a fellow whose name has spaces (AC names do)', async () => {
    lead(['Claude Test', 'Bob Stone', 'Cid Vale']);
    api.routine.start(vt({}));
    tell('Bob Stone', 'startvote giveleader Cid Vale');
    await step(1500);
    expect(fchat()).toEqual([VT("Bob Stone has called a new vote: giveleader Cid Vale! To vote either tell me 'vote 1 yes' or 'vote 1 no'. You have 2 minutes.")]);
  });

  it('off: tells are ignored', async () => {
    player(0x50000078, 'Asker');
    lead(['Claude Test']);
    api.routine.start(vt({ AutoFellowManagement: false }));
    tell('Asker', 'xp');
    await step(1500);
    expect(recruits()).toEqual([]);
    expect(host.chats).toEqual([]);
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

  it('M. Charges When Off with the macro stopped or never started: the stand-by profile (the window\'s selection) keeps worn items topped up', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    let standby = setup() as never;
    api.routine.standby = () => standby;
    await step(1500);
    expect(api.routine.status().running).toBe(false);
    expect(host.sent).toContain('usewith 50000082 50000001');
    // Off in the profile: nothing while stopped.
    host.sent.length = 0;
    const fresh = new AgentApi(host);
    standby = setup({ settings: { ManaChargesWhenOff: false } }) as never;
    fresh.routine.standby = () => standby;
    for (let t = 0; t < 1500; t += 100) { run(fresh, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
    // Dead: no stones (the server refuses them).
    standby = setup() as never;
    host.me.dead = true;
    for (let t = 0; t < 1500; t += 100) { run(fresh, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
    host.me.dead = false;
    // No stand-by profile (nothing loaded): nothing.
    fresh.routine.standby = () => null;
    for (let t = 0; t < 1500; t += 100) { run(fresh, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
  });

  it('RefillWornMana-Item-ManaPercent is "at or below": an item at exactly 33 % gets a stone; above it does not', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    const p = setup();
    host.appraisalDatas.set(0x50000081, data({ 107: 330, 108: 1000 }));
    api.routine.start(p as never);
    await step(1500);
    expect(host.sent).toContain('usewith 50000082 50000001');
    api.routine.stop();
    host.sent.length = 0;
    const other = new AgentApi(host);
    const q = setup();
    host.appraisalDatas.set(0x50000081, data({ 107: 331, 108: 1000 }));
    other.routine.start(q as never);
    for (let t = 0; t < 1500; t += 100) { run(other, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
    other.routine.stop();
  });

  it('a used stone waits for a fresh examination (re-asked 2 s after the use); spent, it is skipped and another stone is used, always on you', async () => {
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    api.routine.start(setup({ consumables: ['Mana Stone', 'Small Mana Stone'] }) as never);
    host.inv.push({ guid: 0x50000084, name: 'Small Mana Stone', where: 'main pack' });
    host.appraised.push(0x50000084);
    host.appraisalDatas.set(0x50000084, data({ 107: 2000 }));
    const asksBefore = host.appraised.filter((g) => g === 0x50000082).length;
    await step(3000);
    // One use, then a wait for the re-examinations: the worn item's, and the stone's 2 s after the use.
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual(['usewith 50000082 50000001']);
    expect(host.appraised.filter((g) => g === 0x50000082).length).toBeGreaterThan(asksBefore);
    // Every look the macro takes is quiet: no Examine window pops up over the player's game.
    expect(host.appraiseCalls.length).toBeGreaterThan(0);
    expect(host.appraiseCalls.filter((c) => !c.quiet)).toEqual([]);
    // The worn item still reads low; the stone's examination is the same reply as before the use: not used again.
    await step(3000);
    expect(host.sent.filter((x) => x === 'usewith 50000082 50000001')).toHaveLength(1);
    expect(host.sent).toContain('usewith 50000084 50000001');
    // Its examination comes back without ItemCurMana (ACE: a drained stone): it stays skipped.
    host.appraisalDatas.set(0x50000082, data({}));
    host.appraisalDatas.set(0x50000084, data({}));
    await step(6000);
    expect(host.sent.filter((x) => x === 'usewith 50000082 50000001')).toHaveLength(1);
    expect(host.sent).toContain('usewith 50000084 50000001');
    expect(host.sent.every((x) => !x.startsWith('usewith') || x.endsWith(' 50000001'))).toBe(true);
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
