/**
 * The in-game meta expression host (agent/VtankExprHost.ts) over the real
 * agent API and a fake game (main.ts's MetaGame): the functions community
 * metas use most (getcharintprop, getcharquadprop, getcharskill_*,
 * wobjectfindininventorybytemplatetype, wobjectgetintprop,
 * actiontryapplyitem, delayexec …) answered "unsupported function" in the
 * game before 2026-10-11, because the host left their parts out. Also: Decal's
 * object classes, UB's item moves (metaItemMove.ts), login switching
 * (nextLogin.ts), spell checks (metaSpellCheck.ts) and the XP meter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { vtankExprHost, type MetaGame, type MetaGameObject } from '../packages/renderer/src/agent/VtankExprHost.ts';
import { decalObjectClass } from '../packages/renderer/src/agent/decalObjectClass.ts';
import { metaMovePlan } from '../packages/renderer/src/agent/metaItemMove.ts';
import { NextLogin } from '../packages/renderer/src/agent/nextLogin.ts';
import { checkSpell, spellCheckText } from '../packages/renderer/src/agent/metaSpellCheck.ts';
import { XpMeter, runExpr, type ExprHost } from '../packages/shared/src/routines/index.ts';
import { FakeHost } from './_harness/agentFake.ts';

const ME = 0x50000001;

function setup(extra: Partial<MetaGame> = {}) {
  const host = new FakeHost();
  const h = host as unknown as Record<string, unknown>;
  h.skillList = () => [
    { id: 34, name: 'War Magic', training: 'specialized', base: 200, buffed: 260 },
    { id: 33, name: 'Life Magic', training: 'untrained', base: 10, buffed: 10 },
    { id: 22, name: 'Jump', training: 'trained', base: 150, buffed: 150 },
  ];
  h.spells = () => [
    { id: 27, name: 'Flame Bolt I', school: 'War Magic', level: 1, power: 1 },
    { id: 2128, name: 'Flame Bolt VII', school: 'War Magic', level: 7, power: 300 },
    { id: 6, name: 'Heal Self I', school: 'Life Magic', level: 1, power: 1 },
  ];
  h.spellComponents = (id: number) => (id === 27 ? ['Lead Scarab', 'Copper Scarab'] : []);
  // The client's own pack list holds what the meta's carried() does (an item used by id must be in it: AgentApi.need).
  host.inv = [{ guid: 0x8000_0100, name: 'Lead Scarab', where: 'pack', stack: 3 }, { guid: 0x8000_0101, name: 'Mana Stone', where: 'pack' }];
  const items: MetaGameObject[] = [
    { id: 0x8000_0100, name: 'Lead Scarab', itemType: 0x1000, flags: 0, wcid: 691, containerId: ME, stack: 3 },
    { id: 0x8000_0101, name: 'Mana Stone', itemType: 0x80000, flags: 0, wcid: 2434, containerId: ME },
    { id: 0x8000_0102, name: 'Pack', itemType: 0x200, flags: 0x1, wcid: 136, containerId: ME },
    { id: 0x8000_0103, name: 'Long Sword', itemType: 0x1, flags: 0, wcid: 351, equipMask: 0x00100000 },
    { id: 0x8000_0104, name: 'Focus of Strength', itemType: 0x80, flags: 0x800000, wcid: 15268, containerId: ME },
  ];
  const game: MetaGame = {
    object: (id) => items.find((i) => i.id === id) ?? null,
    carried: () => items,
    charProp: (kind, id) => (kind === 'int' ? ({ 25: 275, 243: 1 } as Record<number, number>)[id] : kind === 'quad' ? ({ 1: 5_000_000, 6: 1000 } as Record<number, number>)[id] : undefined),
    containerCapacity: (id) => (id === ME ? { items: 102, containers: 7 } : null),
    ...extra,
  };
  const api = new AgentApi(host);
  const printed: string[] = [];
  const expr = vtankExprHost(api, api.routine, (t) => printed.push(t), game);
  return { host, api, expr, items, printed, run: (src: string) => runExpr(src, expr) };
}

describe('the game host answers what community metas ask', () => {
  it('character properties: getcharintprop / getcharquadprop (45 and 20 uses in the corpus)', () => {
    const { run } = setup();
    expect(run('getcharintprop[25]')).toBe(275);
    expect(run('getcharintprop[999]')).toBe(0);
    expect(run('getcharquadprop[6]')).toBe(1000);
  });
  it('skills: training levels 1 untrained … 3 specialized, base and buffed', () => {
    const { run } = setup();
    expect([run('getcharskill_traininglevel[34]'), run('getcharskill_traininglevel[33]'), run('getcharskill_traininglevel[22]'), run('getcharskill_traininglevel[99]')]).toEqual([3, 1, 2, 0]);
    expect(run('getcharskill_buffed[34]')).toBe(260);
  });
  it('inventory: template types, Decal object classes, worn things and pack slots', () => {
    const { run } = setup();
    expect(run('wobjectgetname[wobjectfindininventorybytemplatetype[2434]]')).toBe('Mana Stone');
    expect(run('getinventorycountbytemplatetype[691]')).toBe(3);
    expect(run('wobjectgetobjectclass[wobjectfindininventorybyname[Mana Stone]]')).toBe(16);
    expect(run('wobjectgetobjectclass[wobjectfindininventorybyname[Focus of Strength]]')).toBe(38);
    expect(run('getequippedweapontype[]')).toBe('Melee');
    // 102 slots; the scarab and the stone use two (the pack and the focus take pack slots, the sword is worn).
    expect(run('getfreeitemslots[]')).toBe(100);
    expect(run('getfreecontainerslots[]')).toBe(5);
    expect(run('wobjectgetinternaltype[wobjectfindininventorybyname[Long Sword]]')).toBe(1);
  });
  it('actions: actiontryapplyitem uses one thing on another; delayexec runs later; clearexec cancels', async () => {
    vi.useFakeTimers();
    try {
      const { run, host } = setup();
      host.add({ guid: 0x7000_0001, name: 'Door', itemType: 0x80, objectDescFlags: 0x1000, x: 82, y: 20 });
      expect(run('actiontryapplyitem[wobjectfindininventorybyname[Mana Stone],wobjectfindnearestdoor[]]')).toBe(1);
      expect(host.sent.at(-1)).toBe('usewith 80000101 70000001');
      run('delayexec[100,`setvar[a,1]`]');
      const id = run('delayexec[100,`setvar[b,1]`]');
      run(`clearexec[${String(id)}]`);
      await vi.advanceTimersByTimeAsync(150);
      expect([run('testvar[a]'), run('testvar[b]')]).toEqual([1, 0]);
    } finally { vi.useRealTimers(); }
  });
  it('spells: getcancastspell_hunt checks the book, the skill against the threshold, and the components', () => {
    const { run, host } = setup();
    expect(run('getcancastspell_hunt[2128]')).toBe(0); // 300 + 25 > 260
    expect(run('getcancastspell_hunt[27]')).toBe(0); // no Copper Scarab
    host.inv.push({ guid: 0x8000_0105, name: 'Copper Scarab', where: 'pack', stack: 1 });
    expect(run('getcancastspell_hunt[27]')).toBe(1);
    expect(run('getcancastspell_buff[6]')).toBe(0); // Life Magic untrained
    expect(run('getcancastspell_hunt[9999]')).toBe(0);
  });
  it('meta state, macro and meta name; dumpmetavars sees every scope', () => {
    const { run, expr } = setup();
    expect(run('vtgetmeta[]')).toBe('');
    expect(run('vtmacroenabled[]')).toBe(0);
    run('setvar[x,1];setgvar[g,`two`]');
    expect(expr.listVars!('var')).toEqual([['x', 1]]);
    expect(expr.listVars!('gvar')).toContainEqual(['g', 'two']);
  });
  it('objects: the player id reads character properties; another object reads its appraisal', () => {
    const { run, host } = setup();
    host.appraised.push(0x8000_0101);
    host.appraisalDatas.set(0x8000_0101, { int: { 19: 500 }, float: {}, string: { 1: 'Mana Stone' }, bool: { 22: true }, did: {}, spells: [] });
    expect(run('wobjectgetintprop[wobjectgetplayer[],25]')).toBe(275);
    expect(run('wobjectgetintprop[wobjectfindininventorybyname[Mana Stone],19]')).toBe(500);
    expect(run('wobjectgetboolprop[wobjectfindininventorybyname[Mana Stone],22]')).toBe(1);
    expect(run('wobjecthasdata[wobjectfindininventorybyname[Mana Stone]]')).toBe(1);
  });
  it('the XP meter counts from the first read; xpreset starts it again', () => {
    let xp = 5_000_000;
    const { run } = setup({ charProp: (kind, id) => (kind === 'quad' && id === 1 ? xp : kind === 'quad' && id === 6 ? 0 : undefined) });
    expect(run('xptotal[]')).toBe(0);
    xp += 1500;
    expect(run('xptotal[]')).toBe(1500);
    expect(run('xpreset[]')).toBe(1);
    expect(run('xptotal[]')).toBe(0);
  });
  it('without the game part a function still says it is unsupported', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    const bare: ExprHost = vtankExprHost(api, api.routine, () => {});
    expect(() => runExpr('getcharintprop[25]', bare)).toThrow(/unsupported function getcharintprop/);
  });
});

describe('XpMeter', () => {
  it('total XP only grows; luminance counts only rises (spending it is not a loss)', () => {
    let r: { xp: number; lum: number } | null = null;
    let t = 0;
    const m = new XpMeter(() => r, () => t);
    expect(m.reading()).toEqual({ xp: 0, lum: 0, seconds: 0 });
    r = { xp: 100, lum: 50 };
    m.sample();
    t = 60_000;
    r = { xp: 400, lum: 20 }; // 30 luminance spent
    m.sample();
    r = { xp: 400, lum: 70 };
    expect(m.reading()).toEqual({ xp: 300, lum: 50, seconds: 60 });
  });
});

describe('decalObjectClass', () => {
  it('flags first (player, corpse, door, vendor, kits), then creatures, foci and ItemType', () => {
    expect(decalObjectClass(0x10, 0x8 | 0x10)).toBe(24);
    expect(decalObjectClass(0x200, 0x2000)).toBe(27);
    expect(decalObjectClass(0x80, 0x1000)).toBe(26);
    expect(decalObjectClass(0x10, 0x200)).toBe(25);
    expect(decalObjectClass(0x80, 0x10000)).toBe(29);
    expect(decalObjectClass(0x10, 0x10)).toBe(5);
    expect(decalObjectClass(0x10, 0)).toBe(37);
    expect(decalObjectClass(0x80, 0x800000)).toBe(38);
    expect(decalObjectClass(0x200, 0x800000)).toBe(10);
    expect(decalObjectClass(0x8000, 0)).toBe(31);
    expect(decalObjectClass(0x40000000, 0)).toBe(39);
    expect(decalObjectClass(0x20000000, 0)).toBe(40);
    expect(decalObjectClass(0, 0)).toBe(0);
  });
});

describe('metaMovePlan (actiontrymove / actiontrysplit)', () => {
  const taper = { id: 1, wcid: 20631, stack: 40, maxStack: 100 };
  it('joins a stack with room, as much as fits; else puts the whole item or splits', () => {
    expect(metaMovePlan(taper, 9, 0, null, true, [{ id: 2, wcid: 20631, stack: 90, maxStack: 100 }])).toEqual({ kind: 'merge', targetId: 2, amount: 10 });
    expect(metaMovePlan(taper, 9, 3, null, false, [{ id: 2, wcid: 20631, stack: 90, maxStack: 100 }])).toEqual({ kind: 'put', containerId: 9, placement: 3 });
    expect(metaMovePlan(taper, 9, 0, 5, false, [])).toEqual({ kind: 'split', containerId: 9, placement: 0, amount: 5 });
    expect(metaMovePlan(taper, 9, 0, 5, true, [{ id: 2, wcid: 20631, stack: 10, maxStack: 100 }])).toEqual({ kind: 'merge', targetId: 2, amount: 5 });
    expect(metaMovePlan(taper, 9, 0, 40, false, [])).toEqual({ kind: 'put', containerId: 9, placement: 0 });
    expect(metaMovePlan(taper, 9, 0, 0, false, [])).toEqual({ kind: 'refused' });
  });
});

describe('NextLogin (setnextlogin)', () => {
  it('enters the named character once, case-insensitively; never one pending deletion', () => {
    const n = new NextLogin();
    const slots = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta', deleteTime: 99 }];
    expect(n.take(slots)).toBeNull();
    n.set('alpha');
    expect(n.take(slots)).toEqual(slots[0]);
    expect(n.take(slots)).toBeNull();
    n.set('Beta');
    expect(n.take(slots)).toBeNull();
    n.set('Alpha');
    n.set(null);
    expect(n.take(slots)).toBeNull();
  });
});

describe('checkSpell (/vt testspell)', () => {
  let api: AgentApi;
  beforeEach(() => { api = setup().api; });
  afterEach(() => { vi.useRealTimers(); });
  it('says why a spell can or cannot be cast', () => {
    const setting = (n: string) => ({ 'SpellDiffExcessThreshold-Hunt': 25 } as Record<string, number>)[n];
    expect(spellCheckText(checkSpell(api, setting, 9999, 'hunt'))).toBe('Spell 9999: not in your spellbook.');
    expect(spellCheckText(checkSpell(api, setting, 2128, 'hunt'))).toBe('Flame Bolt VII (2128, War Magic, difficulty 300): not castable (skill 260 vs 300 + 25 threshold: too low).');
    expect(spellCheckText(checkSpell(api, setting, 27, 'hunt'))).toBe('Flame Bolt I (27, War Magic, difficulty 1): not castable (skill 260 vs 1 + 25 threshold; missing Copper Scarab).');
    expect(spellCheckText(checkSpell(api, setting, 6, 'hunt'))).toBe('Heal Self I (6, Life Magic, difficulty 1): not castable (you have no Life Magic skill).');
  });
});

describe('quests, motions, equipanywand and spell ids in the game host (§0.10)', () => {
  it('the quest functions and isrefreshingquests read the game quest list; without one they stay unsupported', () => {
    let refreshing = true;
    const { run } = setup({
      quest: (n) => (n === 'killtaskx' ? { solves: 3, maxSolves: 10, ready: true } : null),
      refreshingQuests: () => refreshing,
    });
    expect([run('getquestktprogress[killtaskx]'), run('getquestktrequired[killtaskx]'), run('testquestflag[killtaskx]'), run('getqueststatus[other]')]).toEqual([3, 10, 1, 1]);
    expect(run('isrefreshingquests[]')).toBe(1);
    refreshing = false;
    expect(run('isrefreshingquests[]')).toBe(0);
    expect(() => setup().run('getqueststatus[x]')).toThrow(/unsupported function getqueststatus/);
  });
  it("setmotion holds UB's motions on the movement keys; getmotion and clearmotion follow", () => {
    const { run, host } = setup();
    expect(run('setmotion[Forward,1]')).toBe(1);
    run('setmotion[StrafeLeft,1]');
    expect([...host.keys].sort()).toEqual(['KeyW', 'KeyZ']);
    expect([run('getmotion[forward]'), run('getmotion[Backward]')]).toEqual([1, 0]);
    run('setmotion[Forward,0]');
    expect([...host.keys]).toEqual(['KeyZ']);
    run('setmotion[Sideways,1]'); // not a UB motion: nothing held
    expect(run('getmotion[Sideways]')).toBe(0);
    run('clearmotion[]');
    expect(host.keys.size).toBe(0);
  });
  it("actiontryequipanywand: true with an Items-tab wand wielded, else it wields one and answers false", () => {
    const { run, host, api } = setup();
    (api.routine as unknown as { current: () => unknown }).current = () => ({ vtank: { items: [{ name: 'Wand of Frost' }] } });
    host.inv.push({ guid: 0x8000_0200, name: 'Wand of Frost', where: 'pack', itemType: 0x8000 } as (typeof host.inv)[number]);
    host.inv.push({ guid: 0x8000_0201, name: 'Unlisted Orb', where: 'pack', itemType: 0x8000 } as (typeof host.inv)[number]);
    expect(run('actiontryequipanywand[]')).toBe(0);
    expect(host.sent).toContain('wield 80000200');
    host.inv.find((i) => i.guid === 0x8000_0200)!.where = 'equipped';
    expect(run('actiontryequipanywand[]')).toBe(1);
  });
  it('wobjectgetspellids / wobjectgetactivespellids read the appraisal', () => {
    const { run } = setup({ objectSpellIds: (id, active) => (id === 0x8000_0103 ? (active ? [2] : [1, 2]) : []) });
    expect(run('listcount[wobjectgetspellids[wobjectfindininventorybyname[Long Sword]]]')).toBe(2);
    expect(run('listgetitem[wobjectgetactivespellids[wobjectfindininventorybyname[Long Sword]],0]')).toBe(2);
  });
});
