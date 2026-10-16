/**
 * Agent-tool fixes from the stream players' 2026-10-16 08:03Z reports (Daiklos Dungeon 0x0185, end-of-retail local ACE;
 * progress.md 2026-10-16, "08:03Z reports"):
 *  1. `cast spell="Heal Self V"` answered "Heal Other V needs a target": a Self / Other the name states is kept, and a
 *     book with only the other one says so.
 *  2. Two Flame Bolts at a Drudge Lurker 1.6 m away did nothing (cast, no damage line); from 4 m back they hit. ACE has
 *     no minimum bolt range, so the no-hit says what a close miss means, and a third bolt from the same spots is refused.
 *  3. A fellow standing a few metres away in a cell your stab list misses stays in sight (ACE sends no updates for a
 *     player who stands still), and the walk's "out of sight" note says the distance was when the walk set off.
 *  4. After an attack target died, the client's Auto Target selected another attacker and the tool didn't say so (and
 *     no swing went at it): the target-died event and the task say who is on you and that you aren't attacking it.
 * Each drives the shipped AgentApi code (fake host: tests/_harness/agentFake.ts); spell names are the spell table's.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { AgentApi, matchSpell, otherSideSpell } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100, { physics: false }); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

// The end-of-retail spell table's names (ids from 0x0E00000E; checked against the DAT below).
const S = (id: number, name: string, school: string, extra: Partial<AgentSpell> = {}): AgentSpell => ({ id, name, school, level: ROMAN[name.split(' ').pop()!] ?? 1, ...extra });
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };

describe('1. a Self or Other in the spell name is honoured', () => {
  const book: AgentSpell[] = [
    S(1, 'Heal Self I', 'Life', { self: true }),
    S(2, 'Heal Other V', 'Life'),
    S(3, 'Armor Other VI', 'Life'),
    S(4, 'Impenetrability V', 'Item', { buff: true, targetType: 0x6 }),
    S(5, 'Blade Bane VI', 'Item', { buff: true, targetType: 0x6 }),
    S(6, 'Aura of Swift Killer Other V', 'Item', { buff: true, targetType: 0x10 }),
    S(7, 'Strength Self V', 'Creature', { self: true }),
    S(8, 'Strength Other V', 'Creature'),
  ];

  it('"Heal Self V" with only Heal Other V known is not Heal Other V, and the refusal names the one you know', () => {
    expect(matchSpell(book, 'Heal Self V', null)).toBeNull();
    expect(matchSpell(book, 'Heal Self V', 'self')).toBeNull();
    expect(otherSideSpell(book, 'Heal Self V')).toMatchObject({ name: 'Heal Other V' });
    // The same shape: Armor Self VI and "Swift Killer Self V" with only the Other ones known.
    expect(matchSpell(book, 'Armor Self VI', null)).toBeNull();
    expect(matchSpell(book, 'Swift Killer Self V', null)).toBeNull();
    expect(matchSpell(book, 'Aura of Swift Killer Self V', 'other')).toBeNull();
  });

  it('a name with no side still infers it from the target; a stated side picks it among both', () => {
    expect(matchSpell(book, 'Heal V', null)).toMatchObject({ name: 'Heal Other V' }); // the only Heal V
    expect(matchSpell(book, 'Strength V', 'other')).toMatchObject({ name: 'Strength Other V' });
    expect(matchSpell(book, 'Strength V', null)).toMatchObject({ name: 'Strength Self V' });
    expect(matchSpell(book, 'Strength Other V', null)).toMatchObject({ name: 'Strength Other V' });
    expect(matchSpell(book, 'Strength Self V', 'other')).toMatchObject({ name: 'Strength Self V' });
    expect(matchSpell(book, 'Heal Other V', 'self')).toMatchObject({ name: 'Heal Other V' });
    expect(matchSpell(book, 'Swift Killer V', 'other')).toMatchObject({ name: 'Aura of Swift Killer Other V' });
  });

  it('Impenetrability and the Banes have no side: either word still finds them', () => {
    expect(matchSpell(book, 'Impenetrability V', null)).toMatchObject({ id: 4 });
    expect(matchSpell(book, 'Impenetrability Self V', null)).toMatchObject({ id: 4 });
    expect(matchSpell(book, 'Blade Bane Other VI', 'other')).toMatchObject({ id: 5 });
    expect(otherSideSpell(book, 'Impenetrability Self V')).toBeNull();
  });

  describe('the cast tool', () => {
    let host: FakeHost;
    let api: AgentApi;
    beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); host.spells = () => book; });
    afterEach(() => vi.useRealTimers());

    it('cast spell="Heal Self V" says you know Heal Other V and casts nothing', async () => {
      const r = await api.cast('Heal Self V', null);
      expect(r).toEqual({ ok: false, message: "you don't know Heal Self V; you know Heal Other V (target=self casts it on you)" });
      expect(host.sent.some((x) => x.startsWith('cast'))).toBe(false);
    });

    it('a Self spell aimed at someone else is refused (ACE IsInvalidTarget drops a SelfTargeted spell on another)', async () => {
      host.add({ guid: 0x50000003, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
      const r = await api.cast('Strength Self V', 'Claude Bulwark');
      expect(r).toEqual({ ok: false, message: 'Strength Self V goes on you only (the Other spell of its family reaches someone else)' });
      expect(host.sent.some((x) => x.startsWith('cast'))).toBe(false);
    });
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('with the end-of-retail spell table\'s own names and flags', () => {
    let real: AgentSpell[];
    beforeAll(() => {
      const st = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
      const want = ['Heal Self I', 'Heal Other V', 'Armor Self VI', 'Armor Other VI', 'Impenetrability V', 'Blade Bane VI', 'Aura of Swift Killer Self V', 'Aura of Swift Killer Other V'];
      real = want.map((name) => {
        const [id, b] = [...st.spells.entries()].find(([, x]) => x.name === name) ?? [0, null];
        expect(b, name).not.toBeNull();
        return { id, name, school: 'x', ...((b!.bitfield & 0x8) ? { self: true } : {}), ...(b!.nonComponentTargetType ? { targetType: b!.nonComponentTargetType >>> 0 } : {}) };
      });
    });
    it('Heal Self V is never Heal Other V; Armor and Swift Killer keep their stated side; Impenetrability and Banes fit either', () => {
      const without = (n: string) => real.filter((s) => s.name !== n);
      expect(matchSpell(real, 'Heal Self V', null)).toBeNull();
      expect(otherSideSpell(real, 'Heal Self V')?.name).toBe('Heal Other V');
      expect(matchSpell(real, 'Armor Self VI', 'other')).toMatchObject({ name: 'Armor Self VI' });
      expect(matchSpell(without('Armor Self VI'), 'Armor Self VI', null)).toBeNull();
      expect(matchSpell(real, 'Armor VI', 'other')).toMatchObject({ name: 'Armor Other VI' });
      expect(matchSpell(real, 'Swift Killer Self V', 'other')).toMatchObject({ name: 'Aura of Swift Killer Self V' });
      expect(matchSpell(without('Aura of Swift Killer Self V'), 'Swift Killer Self V', null)).toBeNull();
      expect(matchSpell(real, 'Impenetrability Self V', null)).toMatchObject({ name: 'Impenetrability V' });
      expect(matchSpell(real, 'Blade Bane Self VI', null)).toMatchObject({ name: 'Blade Bane VI' });
    });
  });
});

describe('2. point-blank bolts that do nothing', () => {
  const LURKER = 0x80001144;
  let host: FakeHost;
  let api: AgentApi;
  let castsSent: number;
  let reply: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.spells = () => [{ id: 30, name: 'Flame Bolt IV', school: 'War', level: 4, projectile: true, range: 30 }];
    host.me.mana = { current: 300, max: 300 };
    host.add({ guid: LURKER, name: 'Drudge Lurker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.6 });
    castsSent = 0;
    reply = () => { api.pushChat('Casting Flame Bolt IV', 0x11); api.pushChat('You say, "Zojak Quaguz"', 0x11); };
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      castsSent++;
      setTimeout(() => reply(), 300);
      return true;
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const cast = async (p: Promise<AgentResult>): Promise<AgentResult> => (await settle(api, host, p, 20_000))!;

  it('a close no-hit says the server has something between you, and to step back (away from it)', async () => {
    const r = await cast(api.cast('Flame Bolt IV', LURKER));
    expect(r.message.split('\n')[1]).toMatch(/^ {2}no hit seen: no damage line came for it \(Drudge Lurker is 1\.6 m away\): it is close enough to claw you, but the server has a wall or door between you .* Step back about 3 m \(walk_to "3m south"\)/);
  });

  it('two from the same spots and the third is refused before it goes; a step resets it; a hit clears it', async () => {
    await cast(api.cast('Flame Bolt IV', LURKER));
    const r2 = await cast(api.cast('Flame Bolt IV', LURKER));
    expect(r2.message).toMatch(/2 from here now: the next cast at it from this spot is refused until you or it move/);
    expect(castsSent).toBe(2);
    const r3 = await cast(api.cast('Flame Bolt IV', LURKER));
    expect(r3.ok).toBe(false);
    expect(r3.message).toMatch(/^Flame Bolt IV not cast: 2 bolts from here at Drudge Lurker \(1\.6 m away\) did no damage you were told of, and you and it haven't moved: another would go the same way\. It is close enough to claw you.*walk_to "3m south"/);
    expect(castsSent).toBe(2);
    // Stepped back 3 m: cast again, and it lands.
    host.me = { ...host.me, y: 17 };
    reply = () => { api.pushChat('Casting Flame Bolt IV', 0x11); api.pushChat('You incinerate Drudge Lurker for 103 points with Flame Bolt IV.', 0x16); };
    const r4 = await cast(api.cast('Flame Bolt IV', LURKER));
    expect(castsSent).toBe(3);
    expect(r4.message).toContain('You incinerate Drudge Lurker for 103 points');
    // Back where the misses were: nothing is held against it after a hit.
    host.me = { ...host.me, y: 20 };
    await cast(api.cast('Flame Bolt IV', LURKER));
    expect(castsSent).toBe(4);
  });

  it('a repeat that stops on two close no-hits gives the same advice', async () => {
    const r = await cast(api.cast('Flame Bolt IV', LURKER, { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/stopped: 2 bolts running did no damage you were told of \(Drudge Lurker 1\.6 m away\): it is close enough to claw you.*walk_to "3m south"/);
  });

  it('a far no-hit with nothing in the way keeps the old wording', async () => {
    host.objs.get(LURKER)!.y = 30;
    const r = await cast(api.cast('Flame Bolt IV', LURKER));
    expect(r.message).toMatch(/no hit seen: no damage line came for it \(Drudge Lurker is 10\.0 m away\); the bolt flew past or into something/);
  });
});

describe('3. a fellow a few metres away stays in sight', () => {
  const BULWARK = 0x50000003;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const v = { cur: 150, max: 169 };
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: v, stamina: v, mana: v }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('released by the client but last placed 2 m away 20 s ago: still in sight, 2 m off', () => {
    host.t = 100_000;
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20, lost: true, heardAt: 80_000 });
    const o = api.observe();
    expect(o.fellows?.[0]).toMatchObject({ name: 'Claude Bulwark', dist: 2 });
  });

  it('a fellow released far off, or not heard of for over a minute, is out of sight; so is a non-fellow beside you', () => {
    host.t = 200_000;
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20, lost: true, heardAt: 130_000 });
    expect(api.observe().fellows?.[0].dist).toBeUndefined();
    host.objs.get(BULWARK)!.heardAt = 190_000;
    host.objs.get(BULWARK)!.x = 92; // 12 m
    expect(api.observe().fellows?.[0].dist).toBeUndefined();
    host.add({ guid: 0x50000009, name: 'Stranger', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 20, lost: true, heardAt: 190_000 });
    expect(api.observe().nearby.some((n) => n.guid === 0x50000009)).toBe(false);
  });
});

describe('4. after an attack target dies, who is on you and that you aren\'t attacking it', () => {
  const A = 0x800011e2, B = 0x8000be07;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.combatMode = 'melee';
    host.add({ guid: A, name: 'Drudge Lurker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21 });
    host.add({ guid: B, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 79, y: 21 });
    host.attackPending = () => false;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the target-died event and the task name the attacker Auto Target selected, and say no swing goes at it', () => {
    const since = api.observe().seq;
    expect(api.attack(A).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    api.pushChat('Lich scratches your hand for 1 point of slashing damage!', 0x15);
    api.pushChat('Lich scratches your foot for 1 point of slashing damage!', 0x15);
    host.dying.add(A);
    host.target = B; // the client's Auto Target (AttackRequest.autoTarget: select, never attack)
    run(api, host, 1000, { physics: false });
    const evs = api.eventsSince(since);
    const died = evs.find((e) => e.type === 'target-died');
    expect(died?.text).toBe('Drudge Lurker #800011e2 died; Lich #8000be07 is on you (2× in 10 s) and is your selection now (Auto Target picked it), but you are not attacking it: ac_attack target=#8000be07 to fight it');
    expect(evs.find((e) => e.type === 'task-done')?.text).toMatch(/Drudge Lurker is dead; Lich #8000be07 is on you/);
    expect(host.sent.filter((x) => x.startsWith(`attack ${B.toString(16)}`))).toEqual([]);
  });

  it('nothing else on you: just "died"', () => {
    const since = api.observe().seq;
    api.attack(A);
    run(api, host, 1000, { physics: false });
    host.dying.add(A);
    run(api, host, 1000, { physics: false });
    expect(api.eventsSince(since).find((e) => e.type === 'target-died')?.text).toBe('Drudge Lurker #800011e2 died');
  });
});
