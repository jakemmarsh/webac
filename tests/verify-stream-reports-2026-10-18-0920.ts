/**
 * AGENT.stream-reports-2026-10-18-0920: the AI stream pair's 08:20–09:21Z segment in Aerbax Haven (0x029F), 2026-10-18,
 * build a2366cf6 (reports stream/reports/{mage-2026-10-18T09-20-52-562Z,soldier-2026-10-18T09-20-54-839Z}-seg1.md;
 * transcripts stream/sessions/{mage,soldier}-2026-10-18-seg1.jsonl; page and chat logs mage.log / soldier.log /
 * *.chat.log). The causes, each proven from those logs:
 * 1. Bulwark's `use item="Excellent Healing Kit" target="Claude Bulwark"` (08:52:26Z) answered "can't use #500000a4 (not
 *    known to the client)": #500000a4 is Bulwark himself. ac_use's item= is an alias of target=, and with both given the
 *    alias rule kept target= and dropped item=, so it double-clicked HIM. Not a2366cf6's kit change (that path was never
 *    reached); the alias rule is older.
 * 2. "Arcanist fights" cast Impenetrability V at 08:04, 08:22 and 08:49Z, each "surpassed by Impenetrability VI" (her hand
 *    cast). The macro's item timers took only its own casts, and the VI was known only from a cast seen landing on this page
 *    (the 08:20 reload emptied it), never from the server's own "surpassed by" line or her hand cast's lines.
 * 3. "Flame Bane V twice in a row" (09:17:52 and 09:17:56): the first FIZZLED ("Your spell fizzled.", WeenieError 0x402 at
 *    09:17:55.140Z); the log kept only the reply's head line, so the recast read as a duplicate.
 * 4. Bulwark's stay_with walk to 0x029F0123 stopped "they are going elsewhere: now 7 m NW of you, 10 m farther from where
 *    you're going" (09:16:13Z) while Arcanist's routine Follow brought her from 16 m to 7 m behind him by the doorways.
 * 5. His walks stopped 33 times for two or three Innocent / Pristine Dolls asleep 15–22 m off, "Bulwark fights" running.
 * 6. Arcanist's `use_on target="Worn Goggles"` (08:33:35Z): her goggles are "Goggles"; "Worn" was her word for which.
 * 7. The kill note inviting a hand attack while a routine fights for you: reworded by 161577067 (not changed here).
 *
 * Drives the real AgentApi / RoutineEngine / VtMacro and the real tool table on the fake host, with the stream's real
 * profiles and the real end-of-retail spell table (DAT-gated).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { ALL_MODULES_OFF } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { routineFromFile, TOOLS, TOOL_CALLER, useArgsAsUseOn, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
  return out;
}
/** A tool caller onto the page's own surface (what the daemon does), recording each method called. */
const surfaceCaller = (api: AgentApi, calls: string[]): ToolCaller => ({
  notice: null,
  async call<T>(method: string, args: unknown[] = []): Promise<T> {
    calls.push(method);
    const fn = (api.surface() as Record<string, (...a: unknown[]) => unknown>)[method];
    return (await fn(...args)) as T;
  },
});
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

describe('1. use with item= and target= is use_on; a use of yourself says so', () => {
  const ME = 0x500000a4, KIT = 0x80007476, MARIONETTE = 0x80007618;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, guid: ME, name: 'Claude Bulwark', level: 48, combatMode: 'melee', health: { current: 104, max: 192 } };
    host.inv = [{ guid: KIT, name: 'Excellent Healing Kit', where: 'main pack', itemType: 0x80, objectDescFlags: 0x10000 }];
    host.add({ guid: KIT, name: 'Excellent Healing Kit', itemType: 0x80, objectDescFlags: 0x10000, useability: 0x002c0008, containerId: ME, cell: null });
    host.add({ guid: MARIONETTE, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30, level: 26 });
    host.useWithTarget = (s: number, t: number) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => api.pushChat('You heal yourself for 81 Health points. Your Excellent Healing Kit has 5 uses left.', 0x1a), 1000);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('08:52:26Z: `use item="Excellent Healing Kit" target="Claude Bulwark"` heals him (was: used HIMSELF, "not known to the client")', async () => {
    const calls: string[] = [];
    const p = TOOL_CALLER.run(surfaceCaller(api, calls), () => tool('ac_use').run({ item: 'Excellent Healing Kit', target: 'Claude Bulwark' }));
    const out = await settle(api, host, p, 15_000);
    expect(calls).toEqual(['useOn']);
    expect(host.sent).toContain(`usewith ${KIT.toString(16)} ${ME.toString(16)}`);
    expect(host.sent.filter((s) => s.startsWith('use '))).toEqual([]);
    expect(out!.isError).toBe(false);
    expect(out!.text).toMatch(/^used Excellent Healing Kit on yourself:\n {2}You heal yourself for 81 Health points/);
    expect(out!.text).toMatch(/\(use with item= and target= is use_on: used Excellent Healing Kit on Claude Bulwark\)$/);
  });

  it('the plain forms are unchanged: item= alone or target= alone is a use (a kit goes on you)', async () => {
    const calls: string[] = [];
    const out = await settle(api, host, TOOL_CALLER.run(surfaceCaller(api, calls), () => tool('ac_use').run({ item: 'Excellent Healing Kit' })), 15_000);
    expect(calls).toEqual(['use']);
    expect(out!.text).toMatch(/^used Excellent Healing Kit on yourself:/);
    expect(useArgsAsUseOn({ target: 'Excellent Healing Kit' })).toBeNull();
    expect(useArgsAsUseOn({ item: 'Kit', target: 'kit' })).toBeNull();
    expect(useArgsAsUseOn({ item: 'Mana Stone', target: 'self' })).toEqual({ item: 'Mana Stone', target: 'self' });
  });

  it('sweep: a use of yourself (by name or self) says it is you and how to use an item on you, sending nothing', async () => {
    for (const who of ['Claude Bulwark', 'self']) {
      const r = await settle(api, host, api.use(who), 5_000);
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/^Claude Bulwark is you: there is nothing to use\. To use an item on yourself .*ac_use_on item=<the item> target=self/);
    }
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
  });
});

describe('6. an item of yours named with which one ("Worn Goggles") resolves among your own', () => {
  const STONE = 0x80003859, GOGGLES = 0x8000e43f, SPARE = 0x8000e440;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', level: 51 };
    host.inv = [
      { guid: STONE, name: 'Moderate Mana Stone', where: 'main pack', itemType: 0x80000 },
      { guid: GOGGLES, name: 'Goggles', where: 'equipped', slot: 'Trinket', itemType: 0x8 },
    ] as never;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('08:33:35Z: use_on item=<stone> target="Worn Goggles" goes on her worn Goggles (was: "no target matching")', async () => {
    const r = await settle(api, host, (api.surface() as { useOn: (i: unknown, t: unknown) => Promise<AgentResult> }).useOn(STONE, 'Worn Goggles'), 15_000);
    expect(host.sent).toContain(`usewith ${STONE.toString(16)} ${GOGGLES.toString(16)}`);
    expect(r!.message).toMatch(/^used Moderate Mana Stone on Goggles/);
  });

  it('sweep: "spare Goggles" is one in the pack, never the worn pair; "my Goggles" either; an unqualified miss still says what you carry', async () => {
    expect(api.resolve('spare Goggles', 'any')).toBeNull();
    host.inv = [...host.inv, { guid: SPARE, name: 'Goggles', where: 'main pack', itemType: 0x8 }] as never;
    expect(api.resolve('spare Goggles', 'any')).toBe(SPARE);
    expect(api.resolve('worn Goggles', 'inventory')).toBe(GOGGLES);
    expect(api.resolve('my wielded Goggles', 'any')).toBe(GOGGLES);
    expect(api.resolve('my Goggles', 'any')).not.toBeNull();
    // Not of yours: the world is not searched with your words for which.
    expect(api.resolve('worn Goggles', 'world')).toBeNull();
    const r = await settle(api, host, (api.surface() as { useOn: (i: unknown, t: unknown) => Promise<AgentResult> }).useOn(STONE, 'Shiny Goggles'), 5_000);
    expect(r!.message).toMatch(/no target matching "Shiny Goggles" nearby or in your inventory; you carry .*Goggles/);
  });
});

describe('4. stay_with: a fellow coming to you is never "going elsewhere"', () => {
  const ARC = 0x50000093;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', level: 48 };
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 183, max: 183 }, stamina: { cur: 200, max: 200 }, mana: { cur: 300, max: 329 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  /** Moves her `m` metres toward (x, y) per 100 ms tick. */
  const toward = (x: number, y: number, m: number): void => {
    const o = host.objs.get(ARC)!;
    const dx = x - o.x, dy = y - o.y, d = Math.hypot(dx, dy);
    if (d > m) { o.x += (dx / d) * m; o.y += (dy / d) * m; } else { o.x = x; o.y = y; }
  };

  it('09:16:13Z: she comes round to him away from the goal (16 m → 11 m behind, 13 m farther from it): waited for, then on together', async () => {
    // His goal 60 m east; she 16 m behind and abeam (NNE), her follow's way to him round by the west (as the doorways went).
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 84, y: 35.5 });
    let leg = 0;
    const r = await settle(api, host, api.walkTo('60m east', { within: 1, stayWith: 'Claude Arcanist' }), 60_000, () => {
      const me = host.me, o = host.objs.get(ARC)!;
      if (leg === 0) { toward(me.x - 11, me.y + 3, 0.3); if (Math.hypot(o.x - (me.x - 11), o.y - (me.y + 3)) < 0.1) leg = 1; }
      else if (leg === 1) { if (host.t > 9000) leg = 2; }
      else toward(me.x - 1, me.y, 0.3);
    });
    expect(r).not.toBeNull();
    expect(r!.message).not.toMatch(/going elsewhere/);
    expect(r!.ok, r!.message).toBe(true);
  });

  it('one walking off away from both you and the goal is still named as going elsewhere', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 2 });
    const r = await settle(api, host, api.walkTo('60m north', { within: 1, stayWith: 'Claude Arcanist' }), 60_000, () => {
      if (host.t > 4000) host.objs.get(ARC)!.y -= 0.4;
    });
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/to wait for Claude Arcanist, but they are going elsewhere: now \d+ m S of you/);
  });
});

describe('5. sleepers by your way: your routine covering the walk, or all well below you, walks on and names them', () => {
  let host: FakeHost;
  let api: AgentApi;
  const fightProfile = (): RoutineProfile => ({
    name: 'Bulwark fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 5 }], do: [{ kind: 'attack-nearest', meters: 5 }] }] }],
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.cell = 0xa9b40105; host.cellSealed = () => true;
    host.me.level = 48; host.me.name = 'Claude Bulwark'; host.me.health = { current: 192, max: 192 };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const sleepers = (list: Array<[string, number | undefined]>): void => list.forEach(([name, level], i) => {
    host.add({ guid: 0x80007a00 + i, name, itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 100 + i * 0.2, y: 40 + i * 0.2, z: 94, ...(level !== undefined ? { level } : {}) });
  });
  const walk = (): Promise<AgentResult> => (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('40m north', { within: 1 }) as Promise<AgentResult>;

  it('Innocent Dolls L50 asleep 20 m E with "Bulwark fights" running: walked on, named (was: "stopped … not awake yet", 33 times an hour)', async () => {
    sleepers([['Innocent Doll', 50], ['Innocent Doll', 50], ['Innocent Doll', undefined]]);
    api.routine.start(fightProfile());
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.message).toMatch(/^arrived/);
    expect(r!.message).toMatch(/passed 3 asleep \(Innocent Doll ×3: your routine takes them as they wake\)/);
  });

  // 2026-10-18 21:32Z segment: two near your level asleep are no pack (they aren't coming at you, and the walk keeps
  // clear of them); three are, and one far above you (15+) stops it alone.
  it('no routine: two Dolls at your level asleep are walked on past; three stop it, as do two with one 15+ above you', async () => {
    sleepers([['Innocent Doll', 50], ['Innocent Doll', 50]]);
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.message).toMatch(/^arrived/);
    expect(r!.message).toMatch(/passed 2 asleep \(Innocent Doll ×2: no pack \(under 3 near your level\)\)/);
  });
  it('no routine: three Dolls at your level asleep still stop it', async () => {
    sleepers([['Innocent Doll', 50], ['Innocent Doll', 50], ['Innocent Doll', 50]]);
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/going on brings you within 18 m of 3 monsters not awake yet: Innocent Doll L50/);
  });
  it('no routine: two asleep, one of them 15+ levels above you, still stop it', async () => {
    sleepers([['Pristine Doll', 63], ['Innocent Doll', 50]]);
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/going on brings you within 18 m of 2 monsters not awake yet: Pristine Doll L63/);
  });

  it('no routine: Marionettes L26 asleep (22 under a L48) are walked on past and named', async () => {
    sleepers([['Marionette', 26], ['Marionette', 26]]);
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.message).toMatch(/^arrived/);
    expect(r!.message).toMatch(/passed 2 asleep \(Marionette ×2: all 10\+ levels under yours\)/);
  });

  it('with your routine, six Pristine Dolls L60 asleep (a crowd) still stop it', async () => {
    sleepers(Array.from({ length: 6 }, () => ['Pristine Doll', 60] as [string, number]));
    api.routine.start(fightProfile());
    const r = await settle(api, host, walk(), 40_000);
    expect(r!.ok, r!.message).toBe(false);
    expect(r!.message).toMatch(/of 6 monsters not awake yet: Pristine Doll L60/);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('2–3. "Arcanist fights" item buffs on the real end-of-retail spell table (needs DAT files)', () => {
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
  const ARMOR = ['Leather Bracers', 'Leather Gauntlets', 'Leather Boots', 'Baggy Shirt', 'Platemail Pauldrons', 'Platemail Breastplate'];
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
  };
  // Item Enchantment 255 against Impenetrability VI's 250: VI is 59% to land, under the 75% bar, so the macro's level is V.
  const skills = [
    { id: 33, name: 'Life Magic', training: 'trained', base: 217, buffed: 255 },
    { id: 34, name: 'War Magic', training: 'specialized', base: 270, buffed: 316 },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 217, buffed: 255 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: 217, buffed: 255 },
  ];
  /** The macro's casts: `answer` gives the server's lines for each (none: it lands, "refreshing", on every piece). */
  let answer: (spell: string, n: number) => string[] | null;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 51;
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => skills;
    for (const s of skills) host.skills.set(s.id, { base: s.base, buffed: s.buffed });
    host.me.combatMode = 'magic';
    host.me.health = { current: 183, max: 183 };
    host.me.mana = { current: 329, max: 329 };
    host.inv = [
      { guid: 0x8000b535, name: 'Wand', where: 'equipped', slot: 'Held', mask: 0x01000000, validLocations: 0x01000000, itemType: 0x8000 },
      ...ARMOR.map((n, i) => ({ guid: 0x80008300 + i, name: n, where: 'equipped', slot: 'Worn', itemType: 0x2 })),
    ] as never;
    answer = () => null;
    const n = new Map<string, number>();
    host.cast = (spell: number, t: number | null) => {
      host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
      const s = table.spells.get(spell)!;
      const k = (n.get(s.name) ?? 0) + 1;
      n.set(s.name, k);
      setTimeout(() => {
        api.pushChat(`Casting ${s.name}`, 0x11);
        for (const l of answer(s.name, k) ?? ARMOR.map((a) => `You cast ${s.name} on ${a}, refreshing ${s.name}`)) api.pushChat(l, 0x07);
      }, 2400);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const casts = (name: string): string[] => host.sent.filter((s) => s === `cast ${id(name)} self`);

  it('the plan, without any word of the armor: Impenetrability V is due (VI is under the landing bar)', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    expect(power('Impenetrability VI')).toBe(250);
    api.routine.start(ready('mage'));
    await step(api, host, 4000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toHaveLength(1);
    expect(casts('Impenetrability VI')).toEqual([]);
  });

  it('2. 08:22Z after the reload: the server\'s "surpassed by Impenetrability VI" lines on her armor count VI as up: no V cast over it', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    // The page's chat since the reload: a hand cast of V answered by the server (her armor's own enchantments).
    for (const a of ARMOR) api.pushChat(`You cast Impenetrability V on ${a}, but it is surpassed by Impenetrability VI`, 0x07);
    api.routine.start(ready('mage'));
    await step(api, host, 6000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toEqual([]);
  });

  it('2. V\'s own timer running out under VI (the 08:49Z shape): no V recast while the server last said VI is on', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    const vDur = table.spells.get(id('Impenetrability V'))!.duration!;
    const viDur = table.spells.get(id('Impenetrability VI'))!.duration!;
    expect(viDur).toBeGreaterThan(vDur);
    // VI seen on the armor at the same moment as V was cast under it; V's timer then runs to its last 100 s.
    for (const a of ARMOR) api.pushChat(`You cast Impenetrability V on ${a}, but it is surpassed by Impenetrability VI`, 0x07);
    api.routine.start(ready('mage'));
    await step(api, host, 1000);
    api.routine.stop();
    host.t += (vDur - 100) * 1000;
    vi.setSystemTime(Date.now() + (vDur - 100) * 1000);
    api.routine.start(ready('mage'));
    await step(api, host, 6000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toEqual([]);
  });

  it('2. once VI wears off ("The spell … has expired.") V, kept under it, still covers; when V wears off too, V is cast', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    for (const a of ARMOR) api.pushChat(`You cast Impenetrability V on ${a}, but it is surpassed by Impenetrability VI`, 0x07);
    api.routine.start(ready('mage'));
    await step(api, host, 2000);
    for (const a of ARMOR) api.pushChat(`The spell Impenetrability VI on ${a} has expired.`, 0x07);
    await step(api, host, 4000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toEqual([]);
    for (const a of ARMOR) api.pushChat(`The spell Impenetrability V on ${a} has expired.`, 0x07);
    await step(api, host, 6000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toHaveLength(1);
  });

  it('2. her hand cast of VI landing on each piece (its "refreshing" lines) goes in the routine\'s item timers too', async () => {
    know(['Impenetrability V', 'Impenetrability VI']);
    for (const a of ARMOR) api.pushChat(`You cast Impenetrability VI on ${a}, refreshing Impenetrability VI`, 0x07);
    // The agent's own reckoning (gearCasts) is not what keeps it: a fresh page's macro reads the lines itself.
    api.routine.start(ready('mage'));
    await step(api, host, 6000);
    expect(casts('Impenetrability V'), api.routine.history().join('\n')).toEqual([]);
  });

  it('3. 09:17:52 / 09:17:56Z: the first Flame Bane V fizzled; the log says so, so the recast doesn\'t read as a double', async () => {
    know(['Flame Bane V']);
    answer = (spell, k) => (spell === 'Flame Bane V' && k === 1 ? ['Your spell fizzled.'] : null);
    api.routine.start(ready('mage'));
    await step(api, host, 12_000);
    expect(casts('Flame Bane V'), api.routine.history().join('\n')).toHaveLength(2);
    const lines = api.routine.history().filter((l) => /casting Flame Bane V/.test(l));
    expect(lines[0]).toMatch(/casting Flame Bane V on yourself: did not take \(Your spell fizzled\)/);
    expect(lines[1]).not.toMatch(/did not take/);
  });
});
