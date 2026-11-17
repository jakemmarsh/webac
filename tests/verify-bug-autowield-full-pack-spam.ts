/**
 * BUG.autowield-full-pack-spam — prod 2026-11-17 03:13Z (end of retail, ACE, one player, build e33f47b67e13): the
 * client printed "Moving <X> to your backpack - cannot unwield the <X>" and "<pack> is completely full!" in lockstep,
 * ~105 times a minute for 7+ minutes. main.ts attemptAutoWield's blocked branch: the blocker's placement into the full
 * main pack was refused on the client (runPlacement sent nothing), each pair one double-click's worth (acclient.exe
 * 0x3ccd38 / 0x3ccd04, CPlayerSystem::AutoWield @ 00560a60 writes them once per gesture).
 *
 * The repeating caller: the routine engine's VirindiTank macro. Its step runs every STEP_MS (500 ms) on the agent tick
 * (main.ts: every >= 100 ms of frames, so ~117 ms at 60 Hz and a step every 5th tick, ~583 ms: ~103 a minute).
 * combatPlan returned { kind: 'equip' } for the row's weapon (or ammunition), AgentApi.equip ran the double-click
 * (host.wield = attemptAutoWield), the refusal lines came back at once, nothing changed, and the next step planned the
 * same equip. Now AgentApi.equip remembers a wield the client refused for the state of the packs or gear
 * (equipHeld) and the macro's planners leave that item out until the packs or gear change; the fight goes on with
 * what is in hand. A pack slot freed lets the wield go out again.
 *
 * The routine and the agent API are shared by all three eras (end of retail, Dark Majesty, AC1999): the refusal lines
 * are the same in each (main.ts: "Both clients say so"), and so is this test's path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const CLUB = 0x80000a01;
const SWORD = 0x80000a02;
const SKULKER = 0x80005001;

/** main.ts attemptAutoWield with the main pack full: the blocker's placement is refused on the client, and both lines print. */
function fullPackWield(host: FakeHost, api: AgentApi): void {
  host.wield = (g: number) => {
    host.sent.push(`wield ${g.toString(16)}`);
    if (host.freeSlots > 0) {
      setTimeout(() => {
        host.inv = host.inv.map((i) => (i.guid === g ? { ...i, where: 'equipped', mask: 0x100000, slot: 'MeleeWeapon' }
          : i.guid === CLUB ? { ...i, where: 'main pack', mask: undefined, slot: undefined } : i));
      }, 200);
      return true;
    }
    api.pushChat('Claude Test is completely full!', 0x1a);
    api.pushChat('Moving Club to your backpack - cannot unwield the Club', 0x1a);
    return true; // attemptAutoWield's blocked branch consumed the gesture
  };
}

const club = (): AgentItem => ({ guid: CLUB, name: 'Club', where: 'equipped', mask: 0x100000, slot: 'MeleeWeapon', itemType: 0x1, validLocations: 0x100000 });
const sword = (): AgentItem => ({ guid: SWORD, name: 'Sword', where: 'main pack', itemType: 0x1, validLocations: 0x100000 });

describe('BUG.autowield-full-pack-spam — AgentApi.equip after a client refusal for a full pack', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.inv = [club(), sword()];
    host.freeSlots = 0;
    api = new AgentApi(host);
    fullPackWield(host, api);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  const equip = async (g: number) => {
    let out: Awaited<ReturnType<AgentApi['equip']>> | null = null;
    void api.equip(g).then((x) => { out = x; });
    for (let t = 0; t < 6000 && !out; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    return out as unknown as Awaited<ReturnType<AgentApi['equip']>>;
  };
  const wields = () => host.sent.filter((s) => s.startsWith('wield ')).length;

  it('the first ask goes out and reports the client\'s refusal; the same ask again sends nothing and says why', async () => {
    const first = await equip(SWORD);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/cannot unwield the Club/);
    expect(wields()).toBe(1);
    const again = await equip(SWORD);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/cannot unwield the Club .*nothing in your packs or gear has changed since.*free a pack slot first/);
    expect(wields()).toBe(1);
    expect(api.equipHeld(SWORD)).not.toBeNull();
  });

  it('a freed pack slot lets the wield go out again, and it lands', async () => {
    await equip(SWORD);
    host.freeSlots = 1;
    expect(api.equipHeld(SWORD)).toBeNull();
    const r = await equip(SWORD);
    expect(wields()).toBe(2);
    expect(r.ok, r.message).toBe(true);
  });

  it('a change to what is carried or worn also lets it go out again', async () => {
    await equip(SWORD);
    host.inv = [...host.inv, { guid: 0x80000a03, name: 'Pyreal', where: 'main pack' }];
    expect(api.equipHeld(SWORD)).toBeNull();
  });

  it('with nothing seen changing, it is asked again once EQUIP_REFUSED_HOLD_MS has passed', async () => {
    await equip(SWORD);
    host.t += AgentApi.EQUIP_REFUSED_HOLD_MS - 1000;
    expect(api.equipHeld(SWORD)).not.toBeNull();
    host.t += 1000;
    expect(api.equipHeld(SWORD)).toBeNull();
  });

  it('a transient refusal (busy) is not held: the next ask goes out', async () => {
    host.wield = (g: number) => { host.sent.push(`wield ${g.toString(16)}`); api.pushChat('You can only move or use one item at a time', 0x1a); return true; };
    await equip(SWORD);
    expect(api.equipHeld(SWORD)).toBeNull();
    await equip(SWORD);
    expect(wields()).toBe(2);
  });
});

describe('BUG.autowield-full-pack-spam — the VirindiTank macro does not ask for the same refused wield every step', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.inv = [club(), sword()];
    host.freeSlots = 0;
    host.add({ guid: SKULKER, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    // The era's spell table (the macro plans nothing before it is loaded); a melee row needs no spells from it.
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map() });
    api = new AgentApi(host);
    fullPackWield(host, api);
  });
  afterEach(() => { api.routine.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function profile(): RoutineProfile {
    const data = emptyVtankData();
    data.items = [{ name: 'Sword' }, { name: 'Club' }] as typeof data.items;
    data.monsters[0].on = ['A'];
    data.monsters[0].weapon = 'Sword';
    return {
      name: 'VT', modules: { ...ALL_MODULES_OFF, combat: true }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [],
      macro: true, ruleFiring: 'once', settings: { EnableBuffing: false, AttackDistance: 30 }, vtank: data,
    } as RoutineProfile;
  }

  it('a minute of routine with the main pack full: one wield ask, one refusal pair, and the fight goes on with the Club', async () => {
    api.routine.start(profile());
    for (let t = 0; t < 60_000; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    const asks = host.sent.filter((s) => s === `wield ${SWORD.toString(16)}`);
    // Pre-fix: one ask (and one refusal pair) every macro step, ~110 in this minute.
    expect(asks.length).toBeGreaterThanOrEqual(1);
    expect(asks.length).toBeLessThanOrEqual(2);
    // The fight carried on with the weapon in hand.
    expect(host.sent.some((s) => s.startsWith(`attack ${SKULKER.toString(16)} `))).toBe(true);
  });

  it('room in the pack: the routine wields the row\'s weapon again', async () => {
    api.routine.start(profile());
    for (let t = 0; t < 5000; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((s) => s === `wield ${SWORD.toString(16)}`)).toHaveLength(1);
    host.freeSlots = 5;
    for (let t = 0; t < 5000; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((s) => s === `wield ${SWORD.toString(16)}`)).toHaveLength(2);
    expect(host.inv.find((i) => i.guid === SWORD)?.where).toBe('equipped');
  });
});

/**
 * The sweep: other automation loops that asked again, unchanged, after a refusal that would come again. Each now waits
 * for the state to change (or a long hold), and each still goes ahead once it can.
 */
describe('BUG.autowield-full-pack-spam sweep — loops that re-asked after a deterministic refusal', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map() });
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

  it('loot (CorpseLootItemMaxAttempts 20): an item the client refuses for a full pack is picked once, not 20 times', async () => {
    host.add({ guid: 0x80005111, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
    host.add({ guid: 0x80005112, name: 'Sword', itemType: 0x1, cell: 0 });
    host.add({ guid: 0x80005113, name: 'Sticky Sword', itemType: 0x1, cell: 0 });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = { guid: g, items: [{ guid: 0x80005112, name: 'Sword' }, { guid: 0x80005113, name: 'Sticky Sword' }] }; return true; };
    // main.ts placeInBackpack with the packs full: the client's own notice, nothing sent.
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); if (g === 0x80005112) { api.pushChat('Claude Test is completely full!', 0x1a); return false; } return true; };
    let done = false;
    const p = api.loot(0x80005111, null, undefined, { itemTries: 20 });
    void p.then(() => { done = true; });
    for (let t = 0; t < 120_000 && !done; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x === 'pickup 80005112')).toHaveLength(1);
    // A pick the server didn't answer (not the full pack) is still tried up to CorpseLootItemMaxAttempts.
    expect(host.sent.filter((x) => x === 'pickup 80005113')).toHaveLength(20);
  });

  it('craft: no split with no free pack slot; a refused split waits the 3 s craft gate; with room it splits', async () => {
    (host as unknown as { craftTable: () => Promise<unknown[]> }).craftTable = async () => [['Lump of Clay', 'Lump of Clay', 'Arrow', 1, 0, 0, 902]];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 37, name: 'Fletching', training: 'trained', base: 120, buffed: 120 }];
    host.inv = [{ guid: 0x50000a20, name: 'Lump of Clay', where: 'main pack', stack: 5 }];
    let accept = false;
    const splits: number[] = [];
    (host as unknown as { splitStack: (g: number, n: number) => boolean }).splitStack = () => {
      splits.push(host.t);
      if (!accept) return false;
      host.inv = [{ ...host.inv[0]!, stack: 4 }, { guid: 0x50000a21, name: 'Lump of Clay', where: 'main pack', stack: 1 }];
      return true;
    };
    const data = emptyVtankData();
    data.consumables = ['Arrow'];
    api.routine.start({ name: 'Craft', modules: { ...ALL_MODULES_OFF, combat: true, buffs: true, vitals: true }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, settings: { EnableBuffing: false }, vtank: data } as RoutineProfile);
    host.freeSlots = 0;
    await step(10_000);
    expect(splits).toEqual([]);
    host.freeSlots = 5; // room, but the client still refuses (another reason): every 3 s at most, not every second
    await step(10_000);
    expect(splits.length).toBeGreaterThanOrEqual(2);
    expect(splits.length).toBeLessThanOrEqual(4);
    accept = true;
    await step(5000);
    expect(host.sent).toContain('usewith 50000a20 50000a21');
  });

  it('Use Dispel Items: a refused dispel item waits REFUSED_RETRY_MS, not the next step', async () => {
    // An acid vuln family of seven levels (the anchor, 521, is end of retail's Acid Vulnerability Other I) and a gem
    // whose spell dispels negative Life Magic.
    const spells = new Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number }>();
    [521, 9522, 9523, 9524, 9525, 9526, 9527].forEach((id, i) => spells.set(id, { name: `Acid Vulnerability Other ${i + 1}`, desc: '', category: 102, school: 2, bitfield: 0x13, power: 1 + i * 50 }));
    spells.set(9900, { name: 'Dispel Gem', desc: 'Dispels all negative Life Magic enchantments of level 7 or lower from the caster.', category: 900, school: 2, bitfield: 0x5, power: 300 });
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells });
    host.buffs = [{ spellId: 9527, name: 'Acid Vulnerability Other 7', remaining: 60 }];
    host.inv = [{ guid: 0x50000071, name: 'Gem of Stillness', where: 'main pack', type: 'Gem' }];
    host.appraised.push(0x50000071);
    host.appraisalDatas.set(0x50000071, { int: {}, float: {}, string: {}, bool: {}, did: { 28: 9900 }, spells: [] });
    host.useWithTarget = (a: number, b: number) => { host.sent.push(`usewith ${a.toString(16)} ${b.toString(16)}`); return false; };
    api.routine.start({ name: 'VT', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once', settings: { EnableBuffing: false, UseDispelItems: true }, vtank: emptyVtankData() } as RoutineProfile);
    await step(20_000);
    const uses = () => host.sent.filter((x) => x.startsWith('usewith 50000071')).length;
    expect(uses()).toBe(1);
    await step(15_000);
    expect(uses()).toBe(2);
  });
});
