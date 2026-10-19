/**
 * The stream players' 2026-10-18 21:32Z segment reports (Claude Arcanist / mage, Claude Bulwark / soldier; build
 * 193ff718d; Aerbax Haven 0x029F, Aerbax Laboratory 0x029E and a Tufa trip):
 *
 *   1. `raise` with no stat= answers with what can be raised and each raise's cost (train_skill alike), not "missing
 *      stat"; the surface passes raise's kind word on (raiseKindNote never ran over the surface).
 *   2. A room in a building is walked to by its cell id from outside: world-query's footnote said "when you're in that
 *      dungeon or building", so Arcanist walked at the Archmage by name from 1.4 km and was refused.
 *   3. Walks no longer stop for two monsters asleep near your level, or a chaser 10+ levels under you whose kind did
 *      nothing that hurt (routine or not), and a nick walks on with your routine running; the stop texts are short.
 *   4. ac_cast spells="A, B, C": one call casts a list on one target, Stamina to Mana Self first when mana is short.
 *   5. A potion that restored less than it can says its full amount (its 25 clamped at full health: checked, retail).
 *   6. A heal of 0 on you says you were already full, and what filled you just before.
 *   7. "You're too busy!" after an attack request is the attack refused, not the kit; a use ends an idle attack order
 *      first so its loop sends no request while the use runs.
 *   8. A monster that cast a harmful spell at you is marked CASTING AT YOU from its distance; "X cast S on you" (ACE's
 *      enchantment line) is a cast at you when X is a monster and S is no buff.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { ALL_MODULES_OFF } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObject } from '../packages/renderer/src/agent/format.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, TOOL_CALLER, castListArg, missingRequired, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { hexCellColumns, roomInfo } from '../tools/stream/world-query.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { AUTO_ENTER_DELAY_MS, createHostAttack } from '../packages/renderer/src/agent/hostAttack.ts';
import { DAT_PATHS } from './_harness/dat.ts';

const SHEET = [
  'Claude Arcanist  level 53  Aluvian Male  Non-Player Killer',
  'XP 74,705,577 total, 258,805 unassigned, 4,729,593 to next level; 4 skill credits',
  'Attributes: Strength 147 (base 137; Strength Self I +10, 1793s left) [+1: 93,132 xp], Endurance 156 (base 136; Endurance Self III +20, 1794s left) [+1: 187,081 xp], Focus 232 (base 202; Focus Self V +30, 1641s left) [+1: 299,567 xp]',
  'Vitals: health 186/186 [+1: 317,532 xp], stamina 211/254 [+1: 144,395 xp]',
  'Specialized skills: War Magic 318 (base 271; War Magic Mastery Self V +30, 969s left) [+1: 890,658 xp, then 979,213]',
  'Trained skills: Jump 145 (base 130) [+1: 396 xp], Loyalty 10 (base 5) [+1: 178 xp]',
  '[+1: N xp] is what one more raise costs, what ac_raise spends (the panels\' raise buttons show the same).',
  'Untrained skills (credits to train): Alchemy [6 cr], Healing 5 [6 cr]',
].join('\n');

/** A caller over the page's surface, as the hosted connector and the CLI daemon call it. */
function callerOver(api: AgentApi): ToolCaller {
  const surface = api.surface() as Record<string, (...a: unknown[]) => unknown>;
  return {
    notice: null, maxWaitMs: 20_000,
    connection: () => ({ account: 'a', characters: 'any', tab: 'on', character: 'Claude Arcanist', screen: 'world' }),
    call: async <T>(m: string, args: unknown[] = []) => (await surface[m](...args)) as T,
  };
}

describe('1. raise and train_skill with nothing named list what they can do, with the costs', () => {
  it('the menu: cheapest first, split by what the unassigned XP covers', () => {
    expect(AgentApi.raiseMenu(SHEET)).toBe([
      'raise takes stat= (an attribute, vital or skill; times= for several). 258,805 XP unassigned; one raise costs:',
      '  you can pay: Loyalty 178, Jump 396, Strength 93,132, Stamina 144,395, Endurance 187,081',
      '  more than you have: Focus 299,567, Health 317,532, War Magic 890,658',
    ].join('\n'));
    expect(AgentApi.trainMenu(SHEET)).toBe('train_skill takes skill= (an untrained skill). You have 4 skill credits. Untrained (credits to train): Alchemy [6 cr], Healing 5 [6 cr]');
    expect(AgentApi.raiseMenu('sheet')).toMatch(/ac_character lists what one raise of each costs/);
  });

  it('`./ac raise` and `./ac train_skill` alone reach the page and answer the menu (was "missing stat", Arcanist 20:59:16Z)', async () => {
    const host = new FakeHost();
    host.characterSheet = () => SHEET;
    const api = new AgentApi(host);
    const c = callerOver(api);
    const raise = TOOL_BY_NAME.get('ac_raise')!, train = TOOL_BY_NAME.get('ac_train_skill')!;
    expect(missingRequired(raise, {})).toBeNull();
    expect(missingRequired(train, {})).toBeNull();
    const r = await TOOL_CALLER.run(c, () => raise.run({}));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^raise takes stat=.*\n {2}you can pay: Loyalty 178, Jump 396/);
    const t = await TOOL_CALLER.run(c, () => train.run({}));
    expect(t.text).toMatch(/^train_skill takes skill=.*Alchemy \[6 cr\]/);
    expect(host.trained).toEqual([]);
  });

  it('the kind word reaches the page over the surface: raise vital="Endurance" says Endurance is an attribute', async () => {
    const host = new FakeHost();
    host.stats.set('Endurance', 136);
    host.xp = 1000;
    const api = new AgentApi(host);
    const c = callerOver(api);
    const r = await TOOL_CALLER.run(c, () => TOOL_BY_NAME.get('ac_raise')!.run({ vital: 'Endurance' }));
    expect(r.text).toMatch(/raised Endurance: an attribute, not a vital/);
  });
});

describe('2. a building\'s room by its cell id from outside: world-query says so, with the map coordinates', () => {
  const table = [
    '+-----------------------------+------------+',
    '| value                       | cell       |',
    '+-----------------------------+------------+',
    "| Archmage Dakila bint Ma'liz | 866C0106   |",
    '+-----------------------------+------------+',
  ].join('\n');
  const sql = "SELECT s.value, HEX(l.obj_Cell_Id) cell FROM landblock_instance l JOIN weenie_properties_string s ON s.object_Id=l.weenie_Class_Id";

  it('a building room (EnvCell SeenOutside) gets its map coordinates and "from outside too"', () => {
    const out = hexCellColumns(table, sql, (c) => (c === 0x866c0106 ? { building: true, x: 36, y: 60 } : null));
    expect(out.split('\n').at(-1)).toBe('(cell ids in hex: 0x866C0106 is a room in a building at about 15.3S, 5.4E: `walk_to target=0x866C0106` walks there from outside too (the landscape, then the doorways) from up to about 1.5 km; farther, walk to those coordinates first)');
  });

  it('a dungeon room says it walks there once you are in that dungeon; unknown says both', () => {
    expect(hexCellColumns(table, sql, () => ({ building: false, x: 50, y: -80 }))).toMatch(/0x866C0106 is a dungeon room \(landblock 0x866C\): `walk_to target=0x866C0106` walks to it once you are in that dungeon/);
    expect(hexCellColumns(table, sql)).toMatch(/walks to that room: a building's from outside too \(from up to about 1\.5 km\), a dungeon's once you are in it \(landblock 0x866C\)/);
  });

  describe.skipIf(!existsSync(DAT_PATHS.cell))('the cell DAT', () => {
    let tufa: ReturnType<typeof roomInfo>, daiklos: ReturnType<typeof roomInfo>;
    beforeAll(() => { tufa = roomInfo(0x866c0106); daiklos = roomInfo(0x01850148); });
    it('Tufa\'s Archmage room 0x866C0106 is a building\'s (SeenOutside); Daiklos 0x01850148 is a dungeon\'s', () => {
      expect(tufa).toEqual({ building: true, x: 36, y: 60 });
      expect(daiklos?.building).toBe(false);
    });
  });

  it('walk_to by a name out of view names the cell-id way too', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    const r = await api.walkTo("Archmage Dakila bint Ma'liz");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/or to the cell id of the room it stands in \(walk_to target=0xXXYYCCCC: a world-DB obj_Cell_Id\)/);
  });
});

/** Run the page and the fake world until `p` answers (at most `ms`). */
async function settleRun<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('3. walks stop for what comes at you near your level, not for sleepers or mild chasers far below', () => {
  const ME = 0x50000001;
  let host: FakeHost;
  let api: AgentApi;
  const fight = (): RoutineProfile => ({
    name: 'Arcanist fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 5 }], do: [{ kind: 'attack-nearest', meters: 5 }] }] }],
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.cell = 0xa9b40105; host.cellSealed = () => true;
    host.me.level = 53; host.me.name = 'Claude Arcanist'; host.me.health = { current: 186, max: 186 };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('two Innocent Dolls L50 asleep 22 m off, no routine: walked on past and named (was "stopped 169.4 m short", 21:03:45Z)', async () => {
    host.add({ guid: 0x80007a00, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 100, y: 40, z: 94, level: 50 });
    host.add({ guid: 0x80007a01, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 100.2, y: 40.2, z: 94, level: 50 });
    const r = await settleRun(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('40m north', { within: 1 }), 40_000);
    expect(r!.message).toMatch(/^arrived/);
    expect(r!.message).toMatch(/; on the way you passed 2 asleep \(Innocent Doll ×2: no pack \(under 3 near your level\)\)$/);
  });

  it('a Dark Marionette L35 running at you, no routine (Arcanist L53): walked on past (was a stop at 3 m, 21:05:01Z)', async () => {
    host.me.cell = 0xa9b40019; host.cellSealed = undefined as unknown as FakeHost['cellSealed'];
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
    host.add({ guid: 0x8000cdb5, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 100, y: 20, level: 35, seeks: { guid: ME, kind: 'move' } });
    const chase = () => { const o = host.objs.get(0x8000cdb5)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } };
    const r = await settleRun(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}), 40_000, chase);
    expect(r?.message).toMatch(/^arrived/);
    expect(r?.message).toMatch(/passed a mild chaser \(Dark Marionette: well below you, nothing that hurt\)/);
  });

  it('…but once its kind\'s Frost Bolt took 56 it stops the walk, saying why', async () => {
    host.me.cell = 0xa9b40019; host.cellSealed = undefined as unknown as FakeHost['cellSealed'];
    api.pushChat('Dark Marionette frosts you for 56 points with Frost Bolt III.', 0x15);
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
    host.add({ guid: 0x8000cdb5, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 100, y: 20, level: 35, seeks: { guid: ME, kind: 'move' } });
    const chase = () => { const o = host.objs.get(0x8000cdb5)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } };
    const r = await settleRun(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}), 15_000, chase);
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Dark Marionette #8000cdb5 \(level 35\) is coming at you, \d+ m E \(running at you\) \(its kind's Frost Bolt III took 56 of your 186 health\)\. Fight it, get away/);
  });

  it('a 1-point scratch with your routine running walks on (was "stopped 2.5 m short: you\'re under attack")', async () => {
    host.me.cell = 0xa9b40019; host.cellSealed = undefined as unknown as FakeHost['cellSealed'];
    api.routine.start(fight());
    host.add({ guid: 0x80007f00, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21, level: 50 });
    let hit = false;
    const r = await settleRun(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('20m north', {}), 40_000, () => {
      if (!hit && host.t > 1500) { hit = true; const o = host.objs.get(0x80007f00)!; o.x = host.me.x + 1; o.y = host.me.y; api.pushChat('Reckless! Innocent Doll scratches your chest for 1 point of slashing damage!', 0x15); }
    });
    expect(r?.message).not.toMatch(/under attack/);
    expect(r?.message).toMatch(/walked through a hit for 1 damage \(Innocent Doll\)/);
  });
});

/** Run the fake clock until `p` answers (at most `ms`). */
async function settle(p: Promise<AgentResult>, ms = 120_000): Promise<AgentResult> {
  let out: AgentResult | undefined;
  void p.then((r) => { out = r; });
  for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
  if (!out) throw new Error('never answered');
  return out;
}

describe('4. ac_cast spells= casts a list on one target, restoring mana between as the routine does', () => {
  const BUL = 0x500000a4;
  let host: FakeHost;
  let api: AgentApi;
  const SPELLS: Array<AgentSpell & { mana: number; bitfield: number }> = [
    { id: 1001, name: 'Armor Other V', school: 'Life', level: 5, targetType: 0x10, mana: 50, bitfield: 0x4 },
    { id: 1002, name: 'Blade Protection Other V', school: 'Life', level: 5, targetType: 0x10, mana: 50, bitfield: 0x4 },
    { id: 1003, name: 'Strength Other V', school: 'Creature', level: 5, targetType: 0x10, mana: 50, bitfield: 0x4 },
    { id: 2001, name: 'Stamina to Mana Self V', school: 'Life', level: 5, targetType: 0x8000, mana: 0, bitfield: 0x4 },
  ];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    host.me.mana = { current: 120, max: 332 };
    host.me.stamina = { current: 250, max: 254 };
    host.spells = () => SPELLS.map(({ mana: _m, bitfield: _b, ...s }) => s);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map(SPELLS.map((s) => [s.id, { name: s.name, desc: '', category: 0, school: 0, bitfield: s.bitfield, power: 200, baseMana: s.mana }])) });
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const s = SPELLS.find((x) => x.id === id)!;
      setTimeout(() => {
        if (id === 2001) { host.me.mana.current += 43; host.me.stamina.current -= 32; api.pushChat(`You cast ${s.name} on yourself and lose 32 points of stamina and also gain 43 points of mana`, 0x11); return; }
        host.me.mana.current -= s.mana;
        api.pushChat(`You cast ${s.name} on Claude Bulwark${id === 1002 ? ', refreshing Blade Protection Other V' : ''}`, 0x11);
      }, 1500);
      return true;
    };
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('castListArg reads a comma list (ids as numbers) or an array', () => {
    expect(castListArg('Armor Other, Blade Protection Other ,1003')).toEqual(['Armor Other', 'Blade Protection Other', 1003]);
    expect(castListArg(['Armor Other', ' Strength Other '])).toEqual(['Armor Other', 'Strength Other']);
  });

  it('three buffs on Bulwark in order, Stamina to Mana Self first when 120 mana won\'t pay for the third', async () => {
    const c = callerOver(api);
    const p = TOOL_CALLER.run(c, () => TOOL_BY_NAME.get('ac_cast')!.run({ spells: 'Armor Other, Blade Protection Other, Strength Other', target: 'Claude Bulwark' }));
    let out: { text: string } | undefined;
    void p.then((x) => { out = x; });
    for (let t = 0; t < 60_000 && !out; t += 200) await vi.advanceTimersByTimeAsync(200);
    const casts = host.sent.filter((s) => s.startsWith('cast '));
    expect(casts).toEqual(['cast 1001 500000a4', 'cast 1002 500000a4', 'cast 2001 self', 'cast 1003 500000a4']);
    expect(out!.text).toMatch(/^cast 3 of 3 on Claude Bulwark: 3 landed\n {2}landed: Armor Other V, Blade Protection Other V \(refreshed\), Strength Other V\n {2}mana: Stamina to Mana Self \+43\n {2}you: health/);
  });

  it('stops when something starts attacking you, naming what was not cast', async () => {
    host.add({ guid: 0x8000aa01, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 21, level: 26 });
    const p = api.castList(['Armor Other', 'Blade Protection Other', 'Strength Other'], 'Claude Bulwark');
    setTimeout(() => api.pushChat('Marionette scratches your chest for 3 points of slashing damage!', 0x15), 1000);
    const r = await settle(p);
    expect(r.message).toMatch(/^cast 1 of 3 on Claude Bulwark: 1 landed; stopped: Marionette #8000aa01 started attacking you \(2 not cast: Blade Protection Other, Strength Other\)/);
  });

  it('no spells: a usage answer; a single spell= still casts once as before', async () => {
    expect(await (api.surface() as { cast: (...a: unknown[]) => Promise<AgentResult> }).cast('', null, null)).toEqual({ ok: false, message: 'cast takes spell= (one spell) or spells= (a comma-separated list, cast in order on one target)' });
    const r = await settle(api.cast('Armor Other', 'Claude Bulwark'));
    expect(r.message).toMatch(/^casting Armor Other V at Claude Bulwark/);
  });
});

describe('5–7. restorations on you and busy refusals, said as what they are', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    host = new FakeHost();
    host.me.health = { current: 184, max: 184 };
    api = new AgentApi(host);
  });
  const lastChat = (): string => api.eventsSince(0).filter((e) => e.type === 'chat').at(-1)!.text;

  it('5. a Potion of Healing (BoostValue 25, wcid 377) that restored 15 at full says it restores up to 25; restoreOptions says it first', () => {
    host.inv = [{ guid: 0x80000dce, name: 'Potion of Healing', stack: 5, wcid: 377 } as never];
    host.appraisalDatas.set(0x80000dce, { int: { 89: 2, 90: 25 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    (host as unknown as { appraisalData: (g: number) => unknown }).appraisalData = (g: number) => host.appraisalDatas.get(g) ?? null;
    api.pushChat('The Potion of Healing restores 15 points of your Health.', 0x0);
    expect(lastChat()).toBe('(system) The Potion of Healing restores 15 points of your Health. (it restores up to 25: you were only 15 short of full)');
    host.me.health = { current: 80, max: 184 };
    expect(api.restoreOptions('health').drink).toMatch(/^ac_use item="Potion of Healing" \(restores up to 25; you carry 5\)/);
  });

  it('6. Heal Other V restoring 0 on you says you were full, and what filled you a moment before (21:31:24–29Z)', () => {
    api.pushChat('You heal yourself for 51 Health points. Your Adept Healing Kit has 18 uses left.', 0x0);
    api.pushChat('Claude Arcanist casts Heal Other V and restores 51 points of your health.', 0x11);
    api.pushChat('Claude Arcanist casts Heal Other V and restores 0 points of your health.', 0x11);
    expect(lastChat()).toMatch(/restores 0 points of your health\. \(0: your health was already full when it landed; Claude Arcanist's Heal Other V restored 51 0 s before\)$/);
    // A fellow's heal is no cast at you.
    expect(api.eventsSince(0).some((e) => e.type === 'cast-at-you')).toBe(false);
  });

  it('7. "You\'re too busy!" right after an attack request says it was the attack refused; a use stops an idle attack order first', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      host.me.combatMode = 'melee';
      host.add({ guid: 0x8000ec15, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.5, level: 26 });
      api.attack(0x8000ec15);
      run(api, host, 200);
      expect(host.sent.some((s) => s.startsWith('attack 8000ec15'))).toBe(true);
      api.pushChat("You're too busy!", 0x0);
      expect(lastChat()).toBe("(system) You're too busy! (an attack request, refused while a use or cast of yours ran: that use goes on)");
      // The swing over, the order still on: the routine's kit use ends it first, so no request goes out mid-bandaging.
      host.pending = false;
      host.attacking = () => false;
      host.inv = [{ guid: 0x80001111, name: 'Adept Healing Kit', stack: 1 } as never];
      let r: AgentResult | undefined;
      void api.useCarried(0x80001111, 'self').then((x) => { r = x; });
      for (let i = 0; i < 100 && !r; i++) { host.t += 100; await vi.advanceTimersByTimeAsync(100); }
      expect(r!.message).toMatch(/^using Adept Healing Kit on yourself \(stopped your attack on Marionette for it, so no attack request goes out while the use runs: the server would refuse it "You're too busy!"\)$/);
      const before = host.sent.filter((s) => s.startsWith('attack ')).length;
      run(api, host, 3000);
      expect(host.sent.filter((s) => s.startsWith('attack ')).length).toBe(before);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});

describe('8. a caster at range is marked CASTING AT YOU', () => {
  it('"Marionette cast Feeblemind Other II on you" marks it from its distance; a fellow\'s buff marks nothing', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    expect(AgentApi.castAtYou('Marionette cast Feeblemind Other II on you, refreshing Feeblemind Other II')).toEqual({ caster: 'Marionette', spell: 'Feeblemind Other II', landed: true });
    host.add({ guid: 0x8000f47d, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80 + 14.6, y: 20, level: 26 });
    host.add({ guid: 0x500000a3, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 21 });
    api.pushChat('Marionette cast Feeblemind Other II on you', 0x11);
    api.pushChat('Claude Arcanist cast Strength Other V on you', 0x11);
    const casts = api.eventsSince(0).filter((e) => e.type === 'cast-at-you');
    expect(casts.map((e) => e.text)).toEqual(['Marionette cast Feeblemind Other II on you']);
    const o = api.playerObserve({}).nearby.find((x) => x.guid === 0x8000f47d)!;
    expect(o.castingAtYou).toMatch(/^Feeblemind Other II \d+ s ago$/);
    expect(formatObject(o)).toMatch(/CASTING AT YOU from 14\.\d m \(Feeblemind Other II \d+ s ago\)/);
    expect(api.playerObserve({}).nearby.find((x) => x.guid === 0x500000a3)?.castingAtYou).toBeUndefined();
  });
});

describe('7b. the stance switch\'s delayed swing waits while a use of yours runs, as the attack loop does', () => {
  it('busy at the delayed swing: none goes out, the attack is no longer pending, and the loop sends it once free', () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      let stance = 'peace';
      let busy = false;
      let swings = 0;
      const hostAttack = createHostAttack({
        inAttackStance: () => stance === 'melee',
        autoEnterPlan: () => ({ sendAttack: true, mode: 2 }),
        changeCombatMode: () => { setTimeout(() => { stance = 'melee'; }, 400); },
        swing: (g) => { swings++; host.sent.push(`swing ${g.toString(16)}`); },
        requestPending: () => false,
        now: () => host.t,
        schedule: (fn, ms) => { setTimeout(fn, ms); },
        busy: () => busy,
      });
      host.attack = (g, p, h) => hostAttack.attack(g, p, h as 'high' | 'medium' | 'low');
      host.attackPending = () => hostAttack.pending();
      host.busy = () => busy;
      const api = new AgentApi(host);
      host.add({ guid: 0x8000ec15, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21, level: 26 });
      expect(api.attack('Marionette').ok).toBe(true);
      run(api, host, 100);
      // A kit goes on before the stance switch ends: the delayed swing must not go out into it.
      busy = true;
      run(api, host, AUTO_ENTER_DELAY_MS);
      expect(swings).toBe(0);
      expect(hostAttack.pending()).toBe(false);
      run(api, host, 2000);
      expect(swings).toBe(0);
      // Free again: the attack loop sends the swing itself (now in melee stance).
      busy = false;
      run(api, host, 2000);
      expect(swings).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('8b. a monster casting at a fellow is marked CASTING AT THEM on the fellows line', () => {
  it('turned to face Bulwark and heard speaking spell words: CASTING AT THEM; turned without words: no such mark', () => {
    const BUL = 0x500000a4;
    const host = new FakeHost();
    const api = new AgentApi(host);
    const v = { cur: 150, max: 194 };
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: v, stamina: v, mana: v }];
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 85, y: 20 });
    host.add({ guid: 0x8000f47d, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 85 + 14.6, y: 20, level: 26, seeks: { guid: BUL, kind: 'turn' } });
    api.tick();
    const line = (): string => (api.playerObserve({}).fellows ?? []).find((f) => f.name === 'Claude Bulwark')?.threats ?? '';
    expect(line()).not.toMatch(/CASTING AT THEM/);
    api.pushChat('Marionette says, "Zojak Quaguz"', 0x11);
    expect(line()).toMatch(/^Marionette L26 #8000f47d CASTING AT THEM \(turned to face them, spell words 0 s ago\), 15 m from them/);
    // Words 11 s old: no longer taken as casting at them.
    host.t += 11_000;
    expect(line()).not.toMatch(/CASTING AT THEM/);
  });
});
