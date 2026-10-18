/**
 * ROUTINE.live-fixes-2026-10-18: what Claude Arcanist and Claude Bulwark hit in their first live hour fighting under the
 * stream's ready routines (tools/stream/routines/mage.json "Arcanist fights", soldier.json "Bulwark fights") in Mountain
 * Keep 0x01D2 against Dread Mu-miyahs (L60), 2026-10-17 23:33Z to 2026-10-18 00:34Z:
 * 1. Acid Stream I (16-31) at the Dreads while Flame Bolt V (68-136) was known: VTank's Auto takes the first element of
 *    the damage list it can bolt (a Dread takes acid and fire alike, ×1, acid first), whatever the bolt's level.
 * 2. "Bludgeoning, Acid and Piercing Protection Self ran out and were never recast", "0 rebuffs": the Pumpkin Buffer's
 *    90-minute Incantations of those protections were on her (the buff plan rightly cast nothing), but observe's "buffs
 *    you know that aren't up" listed them by name, and the run's rebuff count counted only a rules profile's buff sets.
 * 3. "Follow: Claude Bulwark is out of sight; standing still" whenever he changed floors: the routine's Follow never
 *    asked where the server last placed him (fellowLastSeen), which plain follow and walk_to go to.
 * 4. "Bulwark fights" tried its Stamina Elixir dozens of times mid-swing: "You cannot move or use an item while
 *    attacking" (the client's gate) and "Cannot use the Stamina Elixir with the Claude Bulwark" (a use-with-target of an
 *    item that takes none). The elixir never landed.
 * 5. stay_with climbed 6 m and left Arcanist 12 m below: the leash measured her straight distance, ~6 m.
 *
 * Drives the real RoutineEngine / VtMacro / AgentApi on the fake host, with the end-of-retail spell table and monster
 * table, the stream's real profiles, and the real Mountain Keep cell DAT where a walk needs it.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { buildCombatFamilies, indexMonsterTable, spellDamage, type MonsterTableRow } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { buildBuffFamilies, planBuffs } from '../packages/renderer/src/agent/macro/buffPlan.ts';
import { buildMonsterRows, weakMultipliers } from '../tools/build-monster-tables.ts';
import EOL from '../packages/renderer/src/agent/macro/monsters/eol.ts';
import DM from '../packages/renderer/src/agent/macro/monsters/dm.ts';
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
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const DM_PORTAL = resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_portal.dat');
const loadTable = async (path: string): Promise<Table> => {
  const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
  const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
  return new SpellTable(new DatReader(openDat(path).getFileData(0x0e00000e)!)) as unknown as Table;
};

describe('the monster tables carry what each element does (tools/build-monster-tables.ts)', () => {
  it('a row has the weak letters\' Resist* multipliers in their order; a Dread Mu-miyah takes acid and fire alike in both ACE eras', () => {
    expect(weakMultipliers('afbsplc', [0.58, 0.75, 0.75, 1, 0.46, 0.25, 1])).toBe('1,1,0.75,0.75,0.58,0.46,0.25');
    expect(weakMultipliers('', [1, 1, 1, 1, 1, 1, 1])).toBe('');
    const c = { name: 'Rat', resist: [1, 1, 1, 1, 1, 1, 2], maxHealth: 10, species: 9, magicImmune: false, drainImmune: false };
    expect(buildMonsterRows([c])).toEqual([['Rat', 'fpbsalc', 10, 9, '', '2,1,1,1,1,1,1']]);
    for (const t of [EOL, DM]) {
      const dread = indexMonsterTable(JSON.parse(t) as MonsterTableRow[])('Dread Mu-miyah')!;
      // ACE weenie 9255: ResistAcid 1, ResistFire 1, ResistSlash / Bludgeon 0.75, Pierce 0.58, Electric 0.46, Cold 0.25.
      expect(dread.weak.slice(0, 2)).toEqual(['acid', 'fire']);
      expect(dread.resist).toMatchObject({ acid: 1, fire: 1, slash: 0.75, bludgeon: 0.75, pierce: 0.58, lightning: 0.46, cold: 0.25 });
    }
    // A table without the multipliers (an older one) still reads, with no resist.
    expect(indexMonsterTable([['Wisp', 'fp', 40]])('Wisp')).toEqual({ weak: ['fire', 'pierce'], maxHealth: 40 });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('Arcanist on the real end-of-retail spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => { table = await loadTable(DAT_PATHS.portal); });

  let host: FakeHost;
  let api: AgentApi;
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
  };
  // Arcanist at level 49 with vitae: War and Life Magic about 216 buffed (her spell list, 2026-10-17 12:03Z).
  const skills = (war = 216) => [
    { id: 33, name: 'Life Magic', training: 'specialized', base: 216, buffed: 216 },
    { id: 34, name: 'War Magic', training: 'specialized', base: war, buffed: war },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 200, buffed: 200 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: 200, buffed: 200 },
  ];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills();
    (host as unknown as { monsterTable: () => Promise<MonsterTableRow[]> }).monsterTable = async () => JSON.parse(EOL) as MonsterTableRow[];
    host.me.combatMode = 'magic';
    host.me.health = { current: 173, max: 173 };
    host.me.mana = { current: 300, max: 311 };
    host.inv = [{ guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 }] as never;
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const DREAD = 0x80004266;
  const dreadComing = () => host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 32, seeks: { guid: host.me.guid, kind: 'move' } });

  it('the spell table\'s own descriptions give each bolt\'s damage, in each era', async () => {
    expect(spellDamage(table.spells.get(id('Flame Bolt V'))!.desc)).toBe(102);
    expect(spellDamage(table.spells.get(id('Acid Stream I'))!.desc)).toBe(23.5);
    expect(spellDamage('Increases the caster\'s Strength by 10 points.')).toBeNull();
    const fam = buildCombatFamilies(table);
    expect(fam.attack.fire?.bolt?.damage?.get(id('Flame Bolt V'))).toBe(102);
    expect(fam.attack.acid?.bolt?.damage?.get(id('Acid Stream I'))).toBe(23.5);
    if (existsSync(DM_PORTAL)) {
      // Dark Majesty's own table says its own numbers (Flame Bolt V 65-130).
      const dm = buildCombatFamilies(await loadTable(DM_PORTAL));
      expect(dm.attack.fire?.bolt?.damage?.get(id('Flame Bolt V'))).toBe(97.5);
    }
  });

  it('"Arcanist fights" bolts a fire-weak Dread with Flame Bolt V, not Acid Stream I; VTank\'s first-deliverable rule (WeighBoltsByDamage off) cast the Acid Stream', async () => {
    // Her War bolts (her spell list, 2026-10-17 12:03Z), with War Magic buffed past Flame Bolt V's 200 + 25.
    know(['Flame Bolt I', 'Flame Bolt III', 'Flame Bolt IV', 'Flame Bolt V', 'Acid Stream I', 'Force Bolt I', 'Force Bolt III', 'Frost Bolt I', 'Frost Bolt III', 'Frost Bolt IV', 'Frost Bolt V', 'Shock Wave I', 'Lightning Bolt I', 'Whirling Blade I', 'Whirling Blade IV']);
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills(230);
    dreadComing();
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    const casts = host.sent.filter((s) => s.startsWith('cast ') && s.endsWith(DREAD.toString(16)));
    expect(casts.length, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toBeGreaterThan(0);
    expect(casts.every((s) => s === `cast ${id('Flame Bolt V')} ${DREAD.toString(16)}`), casts.join('\n')).toBe(true);
    api.routine.stop();
    host.sent.length = 0;
    const p = ready('mage');
    api.routine.start({ ...p, settings: { ...p.settings, WeighBoltsByDamage: false } });
    await step(api, host, 4000);
    expect(host.sent.filter((s) => s.startsWith('cast '))).toContain(`cast ${id('Acid Stream I')} ${DREAD.toString(16)}`);
  });

  it('the highest level it can land: with her vitae\'d War Magic (216) short of Flame Bolt V it takes Flame Bolt IV over Acid Stream I; at equal levels, the damage list\'s order (acid)', async () => {
    // At 216 (vitae, no War Magic Mastery up), Flame Bolt V's 200 + SpellDiffExcessThreshold-Hunt 25 is out of reach:
    // the live hour's case. VTank's rule took acid (first of acid / fire) and so Acid Stream I, the only acid bolt she knows.
    know(['Acid Stream I', 'Flame Bolt I', 'Flame Bolt III', 'Flame Bolt IV', 'Flame Bolt V']);
    dreadComing();
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    const casts = host.sent.filter((s) => s.startsWith('cast '));
    expect(casts).toContain(`cast ${id('Flame Bolt IV')} ${DREAD.toString(16)}`);
    expect(casts.some((s) => s.startsWith(`cast ${id('Acid Stream I')} `) || s.startsWith(`cast ${id('Flame Bolt V')} `))).toBe(false);
    api.routine.stop();
    host.sent.length = 0;
    know(['Acid Stream V', 'Flame Bolt V']);
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills(230);
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    expect(host.sent.filter((s) => s.startsWith('cast '))).toContain(`cast ${id('Acid Stream V')} ${DREAD.toString(16)}`);
  });

  it('a protection under a stronger Incantation of its family is not due, and comes due under 120 s of it; observe doesn\'t list it as not up', () => {
    know(['Acid Protection Self III', 'Bludgeoning Protection Self III']);
    const families = buildBuffFamilies(table);
    const incantation = id('Incantation of Acid Protection Other');
    expect(table.spells.get(incantation)!.category).toBe(table.spells.get(id('Acid Protection Self III'))!.category);
    const plan = (left: number) => planBuffs({
      spells: host.spells().map((s) => ({ id: s.id, name: s.name, school: { War: 'War Magic', Life: 'Life Magic', Item: 'Item Enchantment', Creature: 'Creature Enchantment' }[s.school]!, category: s.category!, power: s.power!, self: !!s.self, buff: !!s.buff, duration: s.duration ?? 0 })),
      skills: skills() as never, settings: ready('mage').settings!, extraBuffs: [], blacklistedBuffs: [], idle: false, families,
      active: [{ spellId: incantation, name: 'Incantation of Acid Protection Other', category: table.spells.get(incantation)!.category, power: table.spells.get(incantation)!.power, remaining: left }],
    }).due.map((d) => d.spell.name);
    // 80 min of the Pumpkin Buffer's Incantation left: Acid Protection is up; Bludgeoning (nothing on) is due.
    expect(plan(80 * 60)).toEqual(['Bludgeoning Protection Self III']);
    // Under the profile's 120 s: due again.
    expect(plan(100)).toEqual(['Acid Protection Self III', 'Bludgeoning Protection Self III']);
    host.buffs = [{ spellId: incantation, name: 'Incantation of Acid Protection Other', remaining: 80 * 60, beneficial: true }];
    const missing = api.observe().buffsMissing ?? [];
    expect(missing.some((n) => /^Acid Protection Self/.test(n)), missing.join(', ')).toBe(false);
    expect(missing.some((n) => /^Bludgeoning Protection Self/.test(n))).toBe(true);
  });

  it('the macro\'s own rebuffs count in the run\'s stats (it said "0 rebuffs" for an hour of rebuffing)', async () => {
    know(['Acid Protection Self III']);
    const send = host.cast;
    host.cast = (sid, t) => { const r = send(sid, t); const n = table.spells.get(sid)?.name; if (n) api.pushChat(t === null ? `You cast ${n} on yourself` : `You cast ${n} on ${host.objs.get(t)?.name ?? '?'}`, 7); return r; };
    expect(api.routine.statsNow().rebuffs).toBe(0);
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    expect(host.sent).toContain(`cast ${id('Acid Protection Self III')} self`);
    expect(api.routine.statsNow().rebuffs, api.routine.history().join('\n')).toBeGreaterThanOrEqual(1);
  });
});

describe('Bulwark\'s recharge mid-swing (no DAT needed)', () => {
  let host: FakeHost;
  let api: AgentApi;
  /** The client's attackInProgress: from the attack order until 1.2 s after a cancel (the swing's AttackDone). */
  let swingEndsAt = Infinity;
  let swinging = false;
  /** The server's busy while a drink or a bandaging runs (UseDone 1.5 s after the use). */
  let busyUntil = 0;
  const LIB = 0x80005001, ELIXIR = 0x50000201, KIT = 0x50000202;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Bulwark';
    // No magic: an empty spell table is all the macro's planners need from it.
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => ({ spells: new Map() });
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 300, buffed: 300 }, { id: 21, name: 'Healing', training: 'trained', base: 200, buffed: 200 }];
    host.me.health = { current: 197, max: 197 };
    host.me.stamina = { current: 200, max: 297 };
    host.me.combatMode = 'melee';
    swinging = false; swingEndsAt = Infinity; busyUntil = 0;
    const attack = host.attack;
    host.attack = (g, p, h) => { swinging = true; swingEndsAt = Infinity; attack(g, p, h); };
    const cancel = host.cancelAttack;
    host.cancelAttack = () => { swingEndsAt = host.t + 1200; cancel(); };
    host.attacking = () => { if (swinging && host.t >= swingEndsAt) { swinging = false; host.pending = false; } return swinging; };
    host.busy = () => host.t < busyUntil;
    // The client's gate (IsPlayerReadyToMakeInventoryRequest): no use while a swing is in progress.
    const refuse = (what: string): boolean => { if (host.attacking!()) { api.pushChat('You cannot move or use an item while attacking', 0x1a); host.sent.push(`refused ${what}`); return false; } return true; };
    const use = host.use;
    host.use = (g) => {
      if (!refuse(`use ${g.toString(16)}`)) return false;
      busyUntil = host.t + 1500;
      if (g === ELIXIR) host.me.stamina.current = Math.min(host.me.stamina.max, host.me.stamina.current + 100);
      return use(g);
    };
    const useWith = host.useWithTarget;
    host.useWithTarget = (i, t) => {
      if (!refuse(`usewith ${i.toString(16)}`)) return false;
      // ACE: an item with no TargetType can't be used with anything.
      if (i === ELIXIR) { api.pushChat('Cannot use the Stamina Elixir with the Claude Bulwark', 0x1a); return useWith(i, t); }
      busyUntil = host.t + 1500;
      if (i === KIT) host.me.health.current = Math.min(host.me.health.max, host.me.health.current + 60);
      return useWith(i, t);
    };
    host.inv = [
      { guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 },
      { guid: ELIXIR, name: 'Stamina Elixir', where: 'main pack', type: 'Food', itemType: 0x20, stack: 3 },
      { guid: KIT, name: 'Healing Kit', where: 'main pack', type: 'Healer', itemType: 0x80, stack: 10 },
    ] as never;
    // What the client knows of them: the elixir is used on its own (Usable 0x8 Contained), the kit on a target
    // (0x80008: SourceContainedTargetRemoteOrSelf, ACE Usable.cs).
    host.add({ guid: ELIXIR, name: 'Stamina Elixir', itemType: 0x20, useability: 0x8, cell: null as never });
    host.add({ guid: KIT, name: 'Healing Kit', itemType: 0x80, useability: 0x80008, cell: null as never });
    host.appraisalDatas.set(ELIXIR, { int: { 89: 4, 90: 100, 16: 8 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraisalDatas.set(KIT, { int: { 16: 0x80008, 89: 2, 90: 10, 92: 10 }, float: { 100: 1.0 }, string: {}, bool: {}, did: {}, spells: [] });
    host.appraised.push(ELIXIR, KIT);
    host.add({ guid: LIB, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, seeks: { guid: host.me.guid, kind: 'stick' } });
    api = new AgentApi(host);
    api.pushChat('Tusker Liberator hits your chest for 3 points of bludgeoning damage!', 0x15);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('exhausted mid-swing: the attack is broken off, the swing waited out, the elixir drunk by a plain use, and the attack sent afresh', async () => {
    api.routine.start(ready('soldier'));
    await step(api, host, 3000);
    expect(host.sent.some((s) => s.startsWith(`attack ${LIB.toString(16)}`)), `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toBe(true);
    expect(swinging).toBe(true);
    host.me.stamina.current = 0;
    const at = host.sent.length;
    await step(api, host, 6000);
    const after = host.sent.slice(at);
    const cancel = after.indexOf('cancel'), drink = after.indexOf(`use ${ELIXIR.toString(16)}`);
    expect(drink, `${after.join('\n')}\n${api.routine.history().join('\n')}`).toBeGreaterThan(cancel);
    expect(cancel).toBeGreaterThanOrEqual(0);
    // Never refused, never used "with" Bulwark, one elixir, and swinging again after it.
    expect(after.filter((s) => s.startsWith('refused') || s.startsWith(`usewith ${ELIXIR.toString(16)}`))).toEqual([]);
    expect(after.filter((s) => s === `use ${ELIXIR.toString(16)}`)).toHaveLength(1);
    expect(after.slice(drink).some((s) => s.startsWith(`attack ${LIB.toString(16)}`)), after.join('\n')).toBe(true);
    expect(host.me.stamina.current).toBe(100);
  });

  it('a healing kit at 55% health mid-swing goes on him with a use-with-target, after the swing is broken off', async () => {
    api.routine.start(ready('soldier'));
    await step(api, host, 3000);
    host.me.health.current = 100; // 51%
    const at = host.sent.length;
    await step(api, host, 6000);
    const after = host.sent.slice(at);
    const kit = after.indexOf(`usewith ${KIT.toString(16)} ${host.me.guid.toString(16)}`);
    expect(kit, `${after.join('\n')}\n${api.routine.history().join('\n')}`).toBeGreaterThan(after.indexOf('cancel'));
    expect(after.indexOf('cancel')).toBeGreaterThanOrEqual(0);
    expect(after.filter((s) => s.startsWith('refused'))).toEqual([]);
    expect(after.slice(kit).some((s) => s.startsWith(`attack ${LIB.toString(16)}`))).toBe(true);
  });

  it('a rules profile\'s "use Stamina Elixir on self" is a plain use too, after breaking the swing off', async () => {
    const p: RoutineProfile = {
      name: 'Rules', modules: { ...ALL_MODULES_OFF, vitals: true, combat: true }, initialState: 'Hunt', loot: [], buffSets: [], routes: [],
      states: [{ name: 'Hunt', rules: [
        { label: 'Tired', when: [{ kind: 'vital-below', vital: 'stamina', percent: 20 }], do: [{ kind: 'use-item', item: 'Stamina Elixir', on: 'self' }] },
        { label: 'Fight', when: [{ kind: 'monster-within', meters: 30 }], do: [{ kind: 'attack-nearest', meters: 30 }] },
      ] }],
    };
    api.routine.start(p);
    await step(api, host, 2000);
    expect(swinging).toBe(true);
    host.me.stamina.current = 10;
    const at = host.sent.length;
    await step(api, host, 4000);
    const after = host.sent.slice(at);
    expect(after, after.join('\n')).toContain(`use ${ELIXIR.toString(16)}`);
    expect(after.filter((s) => s.startsWith('refused') || s.startsWith(`usewith ${ELIXIR.toString(16)}`))).toEqual([]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('in the real Mountain Keep (0x01D2)', () => {
  const LB = 0x01d20000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 120_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the routine\'s Follow goes after Bulwark when he drops to the −6 deck out of her sight (the server last placing him there), not "standing still"', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me.health = { current: 173, max: 173 };
    host.me.name = 'Claude Arcanist';
    const BUL = 0x50000088;
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, cell: C(0x2a6), x: 89, y: -61, z: 0, heardAt: 0 });
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 197, max: 197 }, stamina: { cur: 200, max: 297 }, mana: { cur: 97, max: 97 } }];
    try {
      await host.run(C(0x2a6), { x: 90, y: -60, z: 0 }, async (api) => { api.routine.start(ready('mage')); return { ok: true, message: 'started' }; }, { maxMs: 1000 });
      const api = (host as unknown as { api: AgentApi }).api;
      let t = 0, moved = false;
      const near = () => { const b = host.objs.get(BUL)!; return Math.hypot(b.x - host.me.x, b.y - host.me.y) <= 9 && Math.abs(b.z - host.me.z) < 2; };
      await host.run(C(0x2a6), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), {
        maxMs: 150_000, sameApi: true,
        each: () => {
          t += 100;
          // He drops to the deck; the client lets him go (his room isn't in sight of hers) and the server's last
          // placement is 8 s old by the time her routine looks: out of `nearby`, but fellowLastSeen knows where.
          if (!moved && t >= 2000) { Object.assign(host.objs.get(BUL)!, { cell: C(0x127), x: 86.3, y: -67.8, z: -6, lost: true, heardAt: host.t - 8000 }); moved = true; }
          if (moved && t > 4000 && near()) throw new Error('arrived');
        },
      }).catch((e: Error) => { if (e.message !== 'arrived') throw e; });
      const hist = api.routine.history().join('\n');
      expect(near(), `${host.me.x.toFixed(1)}, ${host.me.y.toFixed(1)}, z ${host.me.z.toFixed(1)}\n${hist}`).toBe(true);
      expect(host.me.z).toBeCloseTo(-6, 0);
      expect(hist).not.toMatch(/out of sight; standing still/);
      expect(hist).toMatch(/Follow: Claude Bulwark is out of sight in another room; going to where they were last placed/);
      api.routine.stop();
    } finally { host.dispose(); }
  }, 300_000);

  it('stay_with waits for a fellow left on the floor the walk set off from, though she is only a few metres off straight (the way climbs 12 m)', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me.health = { current: 197, max: 197 };
    host.me.name = 'Claude Bulwark';
    const ARC = 0x50000077;
    // Arcanist stands on the −12 floor (0x01D20122), beside where he sets off; the room he walks to (0x01D202A6) is
    // about 5 m from her across but 12 m up, by a ramp loop of some 60 m.
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, cell: C(0x122), x: 94.7, y: -59.7, z: -12, heardAt: 0 });
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 173, max: 173 }, stamina: { cur: 200, max: 231 }, mana: { cur: 300, max: 311 } }];
    try {
      let comeUp = false;
      let waitedAtZ = NaN;
      const r = await host.run(C(0x122), { x: 94, y: -58.5, z: -12 }, (api) => api.walkTo('0x01D202A6', { stayWith: 'Claude Arcanist', timeoutMs: 120_000 }), {
        maxMs: 130_000,
        each: () => {
          const a = host.objs.get(ARC)!;
          a.heardAt = host.t;
          // Once he is waiting, she comes up and joins him.
          if (!comeUp && host.traces.some((l) => /waiting for Claude Arcanist/.test(l))) { comeUp = true; waitedAtZ = host.me.z; Object.assign(a, { cell: host.me.cell, x: host.me.x + 1, y: host.me.y, z: host.me.z }); }
        },
      });
      const waited = host.traces.find((l) => /waiting for Claude Arcanist/.test(l));
      expect(waited, `${JSON.stringify(r)}\n${host.traces.slice(-40).join('\n')}`).toBeDefined();
      // He waited once the way had left her floor (up the ramp), not on it, and arrived with her once she came up.
      expect(waitedAtZ, host.traces.join('\n')).toBeGreaterThan(-12 + 2.5);
      expect(comeUp).toBe(true);
      expect(r.ok, r.message).toBe(true);
      expect(host.me.cell).toBe(C(0x2a6));
    } finally { host.dispose(); }
  }, 300_000);
});
