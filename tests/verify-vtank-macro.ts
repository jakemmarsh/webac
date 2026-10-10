/**
 * AGENT.vtank-window — VirindiTank's macro from its tabs (agent/macro/
 * vtMacro.ts): the routine engine, the real agent API and the planners over
 * a fake host carrying the real end-of-retail spell table: it heals when
 * hurt (Vitals), debuffs and attacks what the Monsters tab says, and keeps
 * VTank's automatic buffs up when nothing is near.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };

describe.skipIf(!existsSync(PORTAL))('VirindiTank\'s macro over the real spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const known = ['Heal Self I', 'Strength Self I', 'Imperil Other I', 'Flame Bolt I'].map(id);
    host.spells = () => known.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 31, name: 'Creature Enchantment', training: 'trained', base: 100, buffed: 100 },
    ];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { EnableBuffing: false, AttackDistance: 30 }, vtank: emptyVtankData(), ...over,
  });

  it('Vitals: hurt below Heal at, it casts the heal it knows on itself', async () => {
    host.me.health.current = Math.round(host.me.health.max * 0.3);
    api.routine.start(vt());
    await step(1500);
    expect(host.sent).toContain(`cast ${id('Heal Self I')} self`);
  });

  it('Monsters: the <DEFAULT> row with I on debuffs the monster with Imperil, then attacks with a bolt', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['I', 'A'];
    api.routine.start(vt({ vtank: data }));
    await step(3000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts[0]).toBe(`cast ${id('Imperil Other I')} 80005001`);
    expect(casts).toContain(`cast ${id('Flame Bolt I')} 80005001`);
  });

  it('Buffs: with nothing near and buffing on, it keeps VTank\'s automatic buffs up (Strength Self)', async () => {
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent).toContain(`cast ${id('Strength Self I')} self`);
    // Up already: nothing more to cast.
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    host.sent.length = 0;
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
  });

  it('a Monsters row with priority -1 is left alone, by the macro and by a rule\'s attack-nearest alike', async () => {
    host.add({ guid: 0x80005003, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    const data = emptyVtankData();
    data.monsters.push({ ...data.monsters[0], name: 'Pumpkin Buffer', priority: -1 });
    api.routine.start(vt({ vtank: data, states: [{ name: 'Default', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 30 }], do: [{ kind: 'attack-nearest', meters: 30 }] }] }] }));
    await step(2000);
    expect(host.sent.filter((x) => /^(attack|cast) /.test(x) && x.includes('80005003'))).toEqual([]);
  });

  it('a monster the macro fought and killed is its kill: the corpse is looted', async () => {
    host.add({ guid: 0x80005004, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    const data = emptyVtankData();
    api.routine.start(vt({ vtank: data, settings: { AttackDistance: 30, EnableLooting: true } }));
    await step(2000);
    expect(host.sent.some((x) => x.startsWith('cast ') && x.endsWith('80005004'))).toBe(true);
    host.dying.add(0x80005004);
    await step(600);
    host.objs.delete(0x80005004);
    await step(8000);
    expect(api.routine.statsNow().kills).toBe(1);
    const log = api.routine.history().join('\n');
    // One loot try for the kill, then the macro is idle and buffs again.
    expect(log, log).toMatch(/loot-nearby[\s\S]*buff: /);
    expect(log.match(/loot-nearby/g)).toHaveLength(1);
  });

  it('a dying monster is shown as dying and is no target: the macro takes the next one', async () => {
    host.add({ guid: 0x80005005, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: 0x80005006, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
    host.dying.add(0x80005005);
    expect(api.snapshot({ radius: 30 }).nearby.find((o) => o.guid === 0x80005005)?.dying).toBe(true);
    expect(api.snapshot({ radius: 30 }).nearby.find((o) => o.guid === 0x80005006)?.dying).toBeUndefined();
    api.routine.start(vt({ settings: { AttackDistance: 30 } }));
    await step(2500);
    const hits = host.sent.filter((x) => /^(attack|cast) /.test(x));
    expect(hits.some((x) => x.includes('80005005'))).toBe(false);
    expect(hits.some((x) => x.includes('80005006'))).toBe(true);
  });

  it('Monster Priority Count Within Distance counts monsters whose row has exactly that priority', () => {
    host.add({ guid: 0x80005007, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    host.add({ guid: 0x80005008, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 27 });
    const data = emptyVtankData();
    data.monsters.push({ ...data.monsters[0], name: 'Drudge Slinker', priority: 3 });
    api.routine.start(vt({ vtank: data, states: [{ name: 'Default', rules: [
      { when: [{ kind: 'monster-priority-count', priority: 3, count: 1, meters: 20 }], do: [] },
      { when: [{ kind: 'monster-priority-count', priority: 1, count: 2, meters: 20 }], do: [] },
      { when: [{ kind: 'monster-priority-count', priority: 1, count: 1, meters: 20 }], do: [] },
    ] }] }));
    expect(api.routine.dryRun().map((r) => r.fires)).toEqual([true, false, true]);
  });

  it('Force Buff recasts every buff once, whatever time is left; Cancel stops the round', async () => {
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
    expect(api.routine.forceBuff().ok).toBe(true);
    expect(api.routine.status().forcingBuffs).toBe(true);
    await step(4000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(1);
    await step(4000);
    expect(api.routine.status().forcingBuffs).toBe(false);
    api.routine.forceBuff();
    api.routine.cancelForceBuff();
    expect(api.routine.status().forcingBuffs).toBe(false);
  });

  it('Cast Dispel Self / Use Dispel Items: a level-7 vuln on you is dispelled; a level-6 one is not', async () => {
    const eradicate = id('Eradicate Life Magic Self');
    const known = host.spells();
    const er = table.spells.get(eradicate)!;
    host.spells = () => [...known, { id: eradicate, name: er.name, school: 'Life Magic', level: 7, category: er.category, power: er.power, duration: 0, self: true }];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 33, name: 'Life Magic', training: 'trained', base: 400, buffed: 400 }];
    // The fire vuln family, levels by power: VI and VII.
    const fireVuln = [...table.spells].filter(([, s]) => s.category === table.spells.get(id('Fire Vulnerability Other I'))!.category && s.school === 2 && !(s.bitfield & 0x4)).sort((a, b) => a[1].power - b[1].power);
    const powers = [...new Set(fireVuln.map(([, s]) => s.power))];
    const at = (lvl: number) => fireVuln.find(([, s]) => s.power === powers[lvl - 1])!;
    host.buffs = [{ spellId: at(6)[0], name: at(6)[1].name, remaining: 60 }] as never;
    api.routine.start(vt({ settings: { CastDispelSelf: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${eradicate}`))).toEqual([]);
    host.buffs = [{ spellId: at(7)[0], name: at(7)[1].name, remaining: 60 }] as never;
    await step(1500);
    expect(host.sent).toContain(`cast ${eradicate} self`);
    // Use Dispel Items: a carried item whose spell (DID 28) is a dispel.
    api.routine.stop();
    host.sent.length = 0;
    host.inv = [{ guid: 0x50000071, name: 'Gem of Stillness', where: 'main pack', type: 'Gem' }] as never;
    host.appraised.push(0x50000071);
    host.appraisalDatas.set(0x50000071, { int: {}, float: {}, string: {}, bool: {}, did: { 28: eradicate }, spells: [] });
    api.routine.start(vt({ settings: { UseDispelItems: true } }));
    await step(1500);
    expect(host.sent).toContain('usewith 50000071 50000001');
  });

  it('Loot Only Rare Corpses: a kill is looted only after the server says you discovered a rare', async () => {
    host.add({ guid: 0x80005009, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    api.routine.start(vt({ settings: { AttackDistance: 30, EnableLooting: true, LootOnlyRareCorpses: true } }));
    await step(2000);
    host.dying.add(0x80005009);
    await step(600);
    host.objs.delete(0x80005009);
    await step(4000);
    expect(api.routine.statsNow().kills).toBe(1);
    expect(api.routine.history().join('\n')).not.toMatch(/loot-nearby/);
    api.pushChat(`${api.snapshot({ max: 0 }).me!.name} has discovered the Pearl of Blood Drinking!`, 0);
    await step(9000);
    expect(api.routine.history().join('\n'), api.routine.history().join('\n')).toMatch(/loot-nearby/);
  });

  it('Excluded Scarab Types: a spell that needs an excluded scarab is not cast', async () => {
    (host as unknown as { spellComponents: (id: number) => string[] }).spellComponents = (sid) => (sid === id('Strength Self I') ? ['Lead Scarab', 'Prismatic Taper'] : ['Iron Scarab']);
    const data = emptyVtankData();
    data.excludedScarabs = ['lead scarab'];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${id('Strength Self I')}`))).toEqual([]);
  });

  it('weapon auras go on the wielded weapon, unless the Items tab lists it Add (no buffs)', async () => {
    // The melee damage aura (end of retail: an Aura on yourself).
    const bd = id('Aura of Blood Drinker Self I');
    const s = table.spells.get(bd)!;
    host.spells = () => [{ id: bd, name: s.name, school: 'Item Enchantment', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), buff: true }];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 32, name: 'Item Enchantment', training: 'trained', base: 150, buffed: 150 }];
    host.inv = [{ guid: 0x50000091, name: 'Practice Sword', where: 'equipped', type: 'Melee Weapon', slot: 'MeleeWeapon' }] as never;
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.some((x) => x.startsWith(`cast ${bd} `))).toBe(true);
    api.routine.stop();
    host.sent.length = 0;
    const data = emptyVtankData();
    data.items = [{ name: 'Practice Sword', noBuffs: true }];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${bd} `))).toEqual([]);
  });

  it('a profile without VirindiTank data keeps the plain macro (attack nearest)', async () => {
    host.add({ guid: 0x80005002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(vt({ vtank: undefined, settings: { AttackDistance: 30 } }));
    await step(1500);
    expect(host.sent.some((x) => x.startsWith('attack 80005002'))).toBe(true);
  });
});
