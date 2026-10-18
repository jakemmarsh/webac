/**
 * AGENT.stream-reports-2026-10-18-0238: the AI stream pair's 01:35–02:41Z segment in Mountain Keep (0x01D2), 2026-10-18
 * (reports stream/reports/{mage-2026-10-18T02-37-45-838Z,soldier-2026-10-18T02-40-52-881Z}-seg3.md; transcripts
 * stream/sessions/{mage,soldier}-2026-10-17-seg3.jsonl; page logs mage.log / soldier.log):
 * 1. "Arcanist fights" cast Impenetrability V on all ten pieces, each "surpassed by Impenetrability VI" (her hand cast of
 *    4 min before, 40 min left: the macro's item timers knew only its own casts), and Acid Protection Self III over her
 *    VI's last seconds (her Life Magic under VI's 300 + 5: VTank's rule, now said in the log).
 * 2. "Bulwark fights" drank Stamina Elixirs between fights (its 50% top-off), and twice a second when a use didn't land.
 * 3. A walk to an out-of-sight monster's last spot ran 55 s through 13 doorways of side rooms, away from Bulwark.
 * 4. attack's "walk_to #800042a2 goes to where it was" for a spot whose only way was a locked door.
 * 5. "Dread Mu-miyah #80002b8b is on you (17× in 10 s)": three Dreads' swings on the nearest.
 * 6. A Dread stuck behind a wall stopped walk after walk: it went in and out of his sight, and came back "new".
 * 7. "No way on foot" from the SE part of the dungeon said nothing of how he got there or how to get out.
 *
 * Drives the real AgentApi / RoutineEngine / VtMacro on the fake host with the stream's real profiles and the real
 * end-of-retail spell table, and the real Mountain Keep cell DAT where routing matters.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { buildBuffFamilies, planBuffs } from '../packages/renderer/src/agent/macro/buffPlan.ts';
import { planRecharge } from '../packages/renderer/src/agent/macro/rechargePlan.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const MU = (n: number): number => (0x80000000 + n) >>> 0;

describe.skipIf(!existsSync(DAT_PATHS.portal))('1. Arcanist\'s buffs on the real end-of-retail spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  const power = (name: string): number => table.spells.get(id(name))!.power;
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  const ARMOR = ['Pathwarden Helm', 'Platemail Breastplate', 'Platemail Leggings', 'Leather Boots'];
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
  };
  const skills = (item: number, life: number) => [
    { id: 33, name: 'Life Magic', training: 'specialized', base: life, buffed: life },
    { id: 34, name: 'War Magic', training: 'specialized', base: 267, buffed: 267 },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 250, buffed: 250 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: item, buffed: item },
  ];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 50;
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    host.me.combatMode = 'magic';
    host.me.health = { current: 183, max: 183 };
    host.me.mana = { current: 329, max: 329 };
    host.inv = [
      { guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 },
      ...ARMOR.map((n, i) => ({ guid: 0x50000100 + i, name: n, where: 'equipped', type: 'Armor', slot: 'Worn', itemType: 0x2 })),
    ] as never;
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('Impenetrability VI cast by hand on every worn piece is up for the macro: it casts no Impenetrability V over it (each was "surpassed")', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    // Item Enchantment under VI's power + SpellDiffExcessThreshold-Buff 5: the macro's best level is V.
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills(power('Impenetrability VI') + 2, 300);
    const V = `cast ${id('Impenetrability V')} self`;
    // Without the hand cast: V is due (nothing seen on the armor), and the log says why not VI.
    api.routine.start(ready('mage'));
    await step(api, host, 3000);
    expect(host.sent, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toContain(V);
    expect(api.routine.history().join('\n')).toMatch(/Impenetrability V: the best you land reliably; Impenetrability VI needs Item Enchantment \d+ \(its \d+ \+ SpellDiffExcessThreshold-Buff 5\) and yours is \d+/);
    api.routine.stop();

    // Her hand cast landing on each piece (the server's lines), then the macro: V is not cast.
    host = Object.assign(host, { sent: [] as string[] });
    api = new AgentApi(host);
    for (const n of ARMOR) api.pushChat(`You cast Impenetrability VI on ${n}`, 0x07);
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    expect(host.sent.filter((s) => s === V), `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toEqual([]);
    expect(api.gearSpellLeftOn(ARMOR, table.spells.get(id('Impenetrability V'))!.category, power('Impenetrability V'))).toBeGreaterThan(30 * 60);
    // A weaker one on the armor doesn't stand in for the planned level.
    expect(api.gearSpellLeftOn(ARMOR, table.spells.get(id('Impenetrability V'))!.category, power('Impenetrability VI') + 1)).toBeNull();
  });

  it('Acid Protection Self III over VI\'s last seconds is VTank\'s level rule, said in the log; with VI\'s 300 + 5 in reach VI is cast', async () => {
    know(['Acid Protection Self III', 'Acid Protection Self VI']);
    const six = id('Acid Protection Self VI');
    host.buffs = [{ spellId: six, name: 'Acid Protection Self VI', remaining: 28, beneficial: true }];
    const vitae = { multiplier: 0.9, cpPool: 0, deathLevel: 50 };
    (host as unknown as { vitae: () => typeof vitae }).vitae = () => vitae;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills(260, 254);
    api.routine.start(ready('mage'));
    await step(api, host, 3000);
    expect(host.sent).toContain(`cast ${id('Acid Protection Self III')} self`);
    expect(api.routine.history().join('\n')).toMatch(/Acid Protection Self III: the best you land reliably; Acid Protection Self VI needs Life Magic \d+ \(its \d+ \+ SpellDiffExcessThreshold-Buff 5\) and yours is 254, with vitae \(−10%\) on you; what you have on of it now ends in 2\d s, and this one takes over then/);
    // The pure plan: VI with 20 min left is not due at any level (a stronger one counts as up).
    const spells = host.spells().map((s) => ({ id: s.id, name: s.name, school: 'Life Magic', category: s.category!, power: s.power!, self: !!s.self, buff: !!s.buff, duration: s.duration ?? 0 }));
    const plan = (life: number, left: number) => planBuffs({ spells, skills: skills(260, life) as never, settings: ready('mage').settings!, extraBuffs: [], blacklistedBuffs: [], idle: false, families: buildBuffFamilies(table), active: [{ spellId: six, name: 'Acid Protection Self VI', remaining: left }] });
    expect(plan(254, 20 * 60).due).toEqual([]);
    const late = plan(254, 28).due[0];
    expect(late.spell.name).toBe('Acid Protection Self III');
    expect(late.stronger?.spell.name).toBe('Acid Protection Self VI');
    const able = plan(power('Acid Protection Self VI') + 5, 28).due[0];
    expect(able.spell.name).toBe('Acid Protection Self VI');
    expect(able.stronger).toBeUndefined();
  });
});

describe('2. stamina between fights: no top-off from consumables, and no drink twice a second', () => {
  const ELIXIR = { guid: 0x50000201, name: 'Stamina Elixir', stack: 5, ints: { 89: 4, 90: 65 } };
  const vit = (st: number) => ({ health: { cur: 187, max: 187 }, stamina: { cur: st, max: 277 }, mana: { cur: 97, max: 97 } });
  const plan = (profile: 'soldier' | 'mage', st: number, hasTarget: boolean) => planRecharge({
    vitals: vit(st), stance: profile === 'mage' ? 'magic' : 'melee', hasTarget, settings: ready(profile).settings!, spells: [], skills: [],
    consumables: [ELIXIR], rechargeFamilies: { bySpell: new Map() },
  });

  it('the stream profiles top stamina off with nothing out of a fight; in one, and under the Restam mark, the elixir still goes', () => {
    // 27% with no target: the old 50% top-off drank an elixir (01:45:15Z); now regeneration does it.
    expect(plan('soldier', 75, false)).toBeNull();
    expect(plan('soldier', 140, false)).toBeNull();
    expect(plan('mage', 100, false)).toBeNull();
    // Below Restam at (20%, the mage's 25%): the elixir, in a fight or out.
    expect(plan('soldier', 40, true)).toMatchObject({ kind: 'use', item: { name: 'Stamina Elixir' } });
    expect(plan('soldier', 40, false)).toMatchObject({ kind: 'use' });
    expect(plan('mage', 50, true)).toMatchObject({ kind: 'use' });
    for (const p of ['soldier', 'mage'] as const) {
      const s = ready(p).settings!;
      expect(Number(s['Recharge-NoTarg-Stam'])).toBeLessThanOrEqual(Number(s['Recharge-Norm-Stam']));
    }
  });

  describe('the macro', () => {
    let host: FakeHost;
    let api: AgentApi;
    let lands = false;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      host = new FakeHost();
      host.me.name = 'Claude Bulwark';
      (host as unknown as { spellTableData: () => Table }).spellTableData = () => ({ spells: new Map() });
      (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 286, buffed: 286 }];
      host.me.health = { current: 187, max: 187 };
      host.me.stamina = { current: 30, max: 277 };
      host.me.combatMode = 'melee';
      lands = false;
      const use = host.use;
      host.use = (g) => { if (lands && g === ELIXIR.guid) host.me.stamina.current += 65; return use(g); };
      host.inv = [
        { guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 },
        { guid: ELIXIR.guid, name: 'Stamina Elixir', where: 'main pack', type: 'Food', itemType: 0x20, stack: 5 },
      ] as never;
      host.add({ guid: ELIXIR.guid, name: 'Stamina Elixir', itemType: 0x20, useability: 0x8, cell: null as never });
      host.appraisalDatas.set(ELIXIR.guid, { int: { 89: 4, 90: 65, 16: 8 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
      host.appraised.push(ELIXIR.guid);
      api = new AgentApi(host);
    });
    afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
    const drinks = () => host.sent.filter((s) => s === `use ${ELIXIR.guid.toString(16)}`).length;

    it('an elixir that doesn\'t raise stamina (the use didn\'t land) is not sent again for 5 s, and the hold is said once', async () => {
      api.routine.start(ready('soldier'));
      await step(api, host, 4000);
      expect(drinks(), `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toBe(1);
      expect(api.routine.history().join('\n')).toMatch(/Stamina Elixir again so soon: the last one didn't raise your stamina \(30 then, 30 now\), so it waits 5 s/);
      await step(api, host, 3000);
      expect(drinks()).toBe(2);
    });

    it('one that lands is drunk once: stamina past the mark, no second', async () => {
      lands = true;
      api.routine.start(ready('soldier'));
      await step(api, host, 6000);
      expect(drinks(), api.routine.history().join('\n')).toBe(1);
      expect(host.me.stamina.current).toBe(95);
    });
  });
});

describe('fake host: walks, attacks and swings (no DAT needed)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 47;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('3. a walk after a monster out of sight is bounded', () => {
    const DREAD = MU(0x3063), BUL = 0x50000088;
    const lose = (x: number, y: number): void => {
      host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x, y, z: 94, level: 60 });
      run(api, host, 500); // seen (monsterSeen) while in view
      host.objs.get(DREAD)!.lost = true; // the client lets it go
    };

    it('gives up after 15 s when the spot is still far (was: on through 13 doorways for 55 s)', async () => {
      host.me.x = 20; host.me.y = 20;
      lose(20, 120);
      const r = await settle(api, host, api.walkTo(`#${DREAD.toString(16)}`), 30_000);
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/going to where it was last seen/);
      expect(r?.message).toMatch(/stopped [\d.]+ m short: gave up on Dread Mu-miyah #80003063 after 15 s: it is out of your sight/);
      expect(host.me.y).toBeLessThan(90);
    });

    it('gives up once it takes you 25 m from your fellow (Bulwark stood where she set off)', async () => {
      host.me.x = 20; host.me.y = 20;
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, x: 20, y: 18, z: 94 });
      host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 187, max: 187 }, stamina: { cur: 200, max: 277 }, mana: { cur: 97, max: 97 } }];
      lose(20, 100);
      const r = await settle(api, host, api.walkTo(`#${DREAD.toString(16)}`), 30_000);
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/gave up on Dread Mu-miyah #80003063: going after it out of sight has taken you 2\d m from Claude Bulwark \(2 m when you set off\)/);
    });

    it('a near spot is still reached (the bound only ends a long chase)', async () => {
      host.me.x = 20; host.me.y = 20;
      lose(20, 35);
      const r = await settle(api, host, api.walkTo(`#${DREAD.toString(16)}`), 30_000);
      expect(r?.ok, r?.message).toBe(true);
      expect(r?.message).toMatch(/isn't in sight from here: it moved on \(or died\)/);
    });
  });

  describe('4. attack\'s walk_to hint is checked against the route first (indoors)', () => {
    const UPPER = 0xa9b40150, OTHER = 0xa9b40152, DOOR = 0x701d2021, DREAD = MU(0x42a2);
    beforeEach(() => {
      host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = 0;
      host.cellSealed = () => true;
      host.add({ guid: DOOR, name: 'Door', itemType: 0x80, objectDescFlags: 0x1000, cell: UPPER, x: 80, y: 30, z: 0, physicsState: 0 });
      host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: OTHER, x: 80, y: 40, z: 0, level: 60 });
      run(api, host, 500);
      host.objs.get(DREAD)!.lost = true;
    });
    /** The doorway route to the far room runs through the door's doorway only. */
    const throughDoor = (): void => {
      const route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number }> }) =>
        ((opts?.closed ?? []).some((c) => Math.hypot(c.x - 80, c.y - 30) < 2.5) ? null : [{ x: 80, y: 30, z: 0 }, to]);
      (host as unknown as { route: typeof route }).route = route;
    };

    it('the only way is a door found locked: the refusal names it and points at no walk (was "walk_to #800042a2 goes to where it was")', () => {
      throughDoor();
      const was = { x: host.me.x, y: host.me.y };
      host.me.x = 80; host.me.y = 28;
      api.pushChat('The door is locked!');
      api.pushChat("The key doesn't fit this lock.");
      host.me.x = was.x; host.me.y = was.y;
      const r = api.attack(DREAD, { far: true }) as { ok: boolean; message: string };
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/No walk gets there from here: the only doorway route goes through Door #701d2021 \(10 m N; locked: the key doesn't fit this lock\), found locked this session: let it come to you/);
      expect(r.message).not.toMatch(/walk_to #/);
    });

    it('no doorway route at all: says so; with one, the walk_to hint stays', () => {
      (host as unknown as { route: () => null }).route = () => null;
      expect((api.attack(DREAD, { far: true }) as { message: string }).message).toMatch(/No walk gets there from here \(no doorway, stair or ramp leads to that room from yours\)/);
      throughDoor();
      expect((api.attack(DREAD, { far: true }) as { message: string }).message).toMatch(/walk_to #800042a2 goes to where it was/);
    });

    it('seen too long ago for walk_to #id: the room it was in, by cell, when a walk gets there', () => {
      throughDoor();
      run(api, host, 61_000);
      const m = (api.attack(DREAD, { far: true }) as { message: string }).message;
      expect(m).toMatch(/in cell 0xA9B40152 \(too long ago for walk_to #800042a2 to go by\)\. walk_to 0xA9B40152 goes to that room/);
      expect(m).not.toMatch(/Go back there and look again/);
    });
  });

  describe('5. swings from several of one name are shared, not all put on the nearest', () => {
    it('two Dreads at you and one at your fellow: ten lines split between the two at you, none on the third', () => {
      const ARC = 0x50000077;
      host.add({ guid: MU(0x2b8b), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, z: 94, seeks: { guid: host.me.guid, kind: 'stick' } });
      host.add({ guid: MU(0x39ea), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22, z: 94, seeks: { guid: host.me.guid, kind: 'stick' } });
      host.add({ guid: MU(0x3b1d), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80.5, y: 20.5, z: 94, seeks: { guid: ARC, kind: 'stick' } });
      for (let i = 0; i < 10; i++) api.pushChat(i % 3 ? 'Dread Mu-miyah grazes your foot for 2 points of bludgeoning damage!' : 'You evaded Dread Mu-miyah!', 0x15);
      const on = api.attackersOfMe();
      expect(on.get(MU(0x2b8b))).toBe(5);
      expect(on.get(MU(0x39ea))).toBe(5);
      expect(on.has(MU(0x3b1d))).toBe(false);
    });

    it('one of the name beside you and one still coming 6 m off: the one at your body takes them', () => {
      host.add({ guid: MU(0x1), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, z: 94, seeks: { guid: host.me.guid, kind: 'stick' } });
      host.add({ guid: MU(0x2), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 26, z: 94, seeks: { guid: host.me.guid, kind: 'move' } });
      for (let i = 0; i < 4; i++) api.pushChat('Dread Mu-miyah grazes your foot for 2 points of bludgeoning damage!', 0x15);
      expect([...api.attackersOfMe()]).toEqual([[MU(0x1), 4]]);
    });
  });

  describe('6. a chase stuck behind a wall that drifts in and out of sight stops no walk', () => {
    const DREAD = MU(0x42a2);
    beforeEach(() => {
      host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, z: 94, level: 60, seeks: { guid: host.me.guid, kind: 'move' } });
      host.wall = (_x, y) => y > 30; // between you: it can't come on
      run(api, host, 22_000); // held: no closer in 20 s
    });

    it('out of sight at the walk\'s start and back in view on the way: not "is coming at you"', async () => {
      host.objs.get(DREAD)!.lost = true;
      run(api, host, 3000);
      let ticks = 0;
      // Back in view half a second into the walk.
      const r = await settle(api, host, api.walkTo('20m south', { stopOnAggro: true }), 4000, () => { if (++ticks === 5) host.objs.get(DREAD)!.lost = false; });
      expect(ticks).toBeGreaterThan(5);
      expect(r === null || !(r as { aggro?: boolean }).aggro, r?.message).toBe(true);
    });

    it('out of sight a few seconds since it was held and back: still held for the next walk', async () => {
      host.objs.get(DREAD)!.lost = true;
      run(api, host, 3000);
      host.objs.get(DREAD)!.lost = false;
      run(api, host, 500);
      const r = await settle(api, host, api.walkTo('20m south', { stopOnAggro: true }), 3000);
      expect(r === null || !(r as { aggro?: boolean }).aggro, r?.message).toBe(true);
    });

    it('a new chaser coming at you still stops the walk', async () => {
      host.add({ guid: MU(0x9999), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 10, z: 94, level: 60 });
      const p = api.walkTo('20m south', { stopOnAggro: true });
      run(api, host, 300);
      host.objs.get(MU(0x9999))!.seeks = { guid: host.me.guid, kind: 'move' };
      const r = await settle(api, host, p, 4000);
      expect((r as { aggro?: boolean } | null)?.aggro, r?.message).toBe(true);
      expect(r?.message).toMatch(/Dread Mu-miyah #80009999/);
    });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('7. the real Mountain Keep (0x01D2): the SE part, reached one way', () => {
  const LB = 0x01d20000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191 });
  }, 120_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('walk_to 0x01D20371 from 0x01D20383 says the part is reached one way from where the Surface portal stands, and to look in 0x01D203A5 or recall', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me.health = { current: 187, max: 187 };
    host.me.name = 'Claude Bulwark';
    // ACE-World 16PY 01D2.sql: the entrance's Surface portal and the Holtburg portal, both seen on the way in.
    host.add({ guid: 0x701d206d, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x2f4), x: 47.7805, y: -60.2174, z: 12 });
    host.add({ guid: 0x701d2027, name: 'Holtburg', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x1f7), x: 80.13, y: -57.476, z: -5.995 });
    try {
      const r = await host.run(C(0x383), { x: 64.75, y: 0, z: 30 }, (api) => api.walkTo('0x01D20371'), { maxMs: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/this part of the dungeon is reached one way only: from where (Surface #701d206d|Holtburg #701d2027) stands a walk gets here by (a [\d.]+ m drop|\d drops \()/);
      expect(r.message).toMatch(/no doorway, stair or ramp climbs back out/);
      expect(r.message).toMatch(/To get out: walk_to 0x01D203A5, the highest room on your side \(about \d+ m up\), and look there for a portal out .*, or recall \(a lifestone or portal recall spell, \/lifestone\)/);
    } finally { host.dispose(); }
  }, 120_000);
});
