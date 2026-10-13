/**
 * A caster's attack casts (2026-10-13). A mage with a Training Wand ran a custom routine whose rule pulled a Sparring
 * Golem: "Sparring Golem: no swing or shot landed in 25 s; not pulled", nothing cast, while the VirindiTank macro profile
 * bolted the same golem fine. AgentApi.attack (ac_attack, and a routine's pull and attack-nearest) only ever sent the
 * attack key's swing, and magic mode has no attack event (retail ExecuteAttack; getAutoEnterAttackPlan sends none).
 * Now a wand wielder's attack enters magic mode and casts the attack spell the macro would pick (combatPlan's
 * casterAttackSpell → planCombat, its <DEFAULT> row), again and again until the target dies, through ac_cast repeat's
 * path. Each test drives the real AgentApi / RoutineEngine on the FakeHost. Melee and missile attacks are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { mapCoordsText } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { buildCombatFamilies, casterAttackSpell, type CombatSpellTableEntry } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { ALL_MODULES_OFF, type RoutineAction, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentEvent } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, HOLTBURG } from './_harness/agentFake.ts';

const GOLEM = 0x80003001;
const WAND = 0x70000001;
const OX = ((HOLTBURG >>> 24) & 0xff) * 192;
const OY = ((HOLTBURG >>> 16) & 0xff) * 192;
const at = (x: number, y: number): string => mapCoordsText({ x: OX + x, y: OY + y });

/**
 * The end-of-retail ids (ACE SpellId) with made-up categories: the planner reads every category from the table, so a
 * table whose numbers differ (the 1999 one does) picks the same spells. Force Bolt is the pierce bolt (VTank's first
 * element for a monster its table doesn't list), Flame Bolt the fire one.
 */
const table = (pierceCat: number, fireCat: number): { spells: Map<number, CombatSpellTableEntry & { desc: string; baseMana: number }> } => ({
  spells: new Map([
    [86, { name: 'Force Bolt I', desc: '', category: pierceCat, school: 1, bitfield: 0, power: 1, baseMana: 10 }],
    [87, { name: 'Force Bolt II', desc: '', category: pierceCat, school: 1, bitfield: 0, power: 50, baseMana: 15 }],
    [27, { name: 'Flame Bolt I', desc: '', category: fireCat, school: 1, bitfield: 0, power: 1, baseMana: 10 }],
    [6, { name: 'Heal Self I', desc: '', category: 900, school: 2, bitfield: 0x8 | 0x4, power: 1, baseMana: 10 }],
  ]),
});

type Act = { act(a: RoutineAction, p: RoutineProfile): Promise<{ ok: boolean; message: string; idle?: boolean } | null> };
const engine = (api: AgentApi): Act => api.routine as unknown as Act;
const profile = (): RoutineProfile => ({
  name: 'Mage', modules: { ...ALL_MODULES_OFF, combat: true, navigation: true }, initialState: 'Default', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Default', rules: [] }],
});

describe('a caster attacks with spells', () => {
  let host: FakeHost;
  let api: AgentApi;
  let warBuffed: number;
  /** What the server answers each cast with (by cast number, from 1). */
  let reply: (n: number, id: number) => void;
  let casts: number;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    warBuffed = 40;
    const t = table(122, 120);
    const known = (ids: number[]) => ids.map((id) => {
      const s = t.spells.get(id)!;
      return { id, name: s.name, school: s.school === 1 ? 'War' : 'Life', level: 1, category: s.category, power: s.power, projectile: s.school === 1, range: 30, ...(s.bitfield & 0x8 ? { self: true } : {}) };
    });
    host.spells = () => known([86, 87, 27, 6]);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => t;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 34, name: 'War Magic', training: 'trained', base: warBuffed, buffed: warBuffed },
      { id: 33, name: 'Life Magic', training: 'trained', base: 40, buffed: 40 },
    ];
    (host as unknown as { lineOfFire: () => unknown }).lineOfFire = () => ({ dist: 10, blockedAt: null });
    host.inv = [{ guid: WAND, name: 'Training Wand', where: 'equipped', slot: 'Held', type: 'Caster', itemType: 0x8000 }];
    host.me.mana = { current: 100, max: 100 };
    host.add({ guid: GOLEM, name: 'Sparring Golem', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    casts = 0;
    reply = (n) => {
      host.me.mana.current -= 10;
      if (n < 3) { api.pushChat(`You pierce Sparring Golem for ${10 + n} points with Force Bolt I.`, 0x16); return; }
      host.dying.add(GOLEM);
      api.pushChat("Your bolt pierces Sparring Golem's mortal remains!", 0x16);
    };
    host.cast = (id: number, tg: number | null) => {
      host.sent.push(`cast ${id} ${tg === null ? 'self' : tg.toString(16)}`);
      const n = ++casts;
      setTimeout(() => reply(n, id), 600);
      return true;
    };
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });

  const make = () => { api = new AgentApi(host); return api; };
  async function step(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); api.tick(); }
  }
  async function settle<T>(p: Promise<T>, ms = 60_000): Promise<T> {
    let out: { v: T } | undefined;
    void p.then((v) => { out = { v }; });
    for (let t = 0; t < ms && !out; t += 100) await step(100);
    if (!out) throw new Error('never answered');
    return out.v;
  }
  const events = (type: AgentEvent['type']) => api.eventsSince(0).filter((e) => e.type === type);

  it('ac_attack: enters magic mode, casts the best castable bolt until the target dies, and says so as target-died', async () => {
    make();
    const r = api.attack('Sparring Golem');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^casting Force Bolt I at Sparring Golem \(#80003001\): bolt at Sparring Golem/);
    await step(15_000);
    expect(host.sent).toContain('mode magic');
    // Force Bolt II (difficulty 50) is beyond War Magic 40 + the 25 VTank allows: the level-I bolt, three times.
    expect(host.sent.filter((s) => s.startsWith('cast '))).toEqual(['cast 86 80003001', 'cast 86 80003001', 'cast 86 80003001']);
    // No melee swing and no repeated stance requests.
    expect(host.sent.some((s) => s.startsWith('attack '))).toBe(false);
    expect(host.sent.filter((s) => s === 'mode magic')).toHaveLength(1);
    expect(events('target-died').map((e) => e.guid)).toEqual([GOLEM]);
  });

  it('a higher War Magic skill picks the higher bolt the macro would', async () => {
    warBuffed = 100;
    make();
    expect(api.attack('Sparring Golem').message).toMatch(/^casting Force Bolt II /);
  });

  it('a caster with no attack spell it can cast is told so at once, with nothing sent', () => {
    host.spells = () => [{ id: 6, name: 'Heal Self I', school: 'Life', level: 1, category: 900, power: 1, self: true }];
    make();
    const r = api.attack('Sparring Golem');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/you wield a caster \(Training Wand\), so an attack is a spell, and you know no attack spell you can cast at Sparring Golem/);
    expect(host.sent).toEqual([]);
  });

  it('closes in first when the target is beyond the spell\'s range, then casts', async () => {
    host.spells = () => [{ id: 86, name: 'Force Bolt I', school: 'War', level: 1, category: 122, power: 1, projectile: true, range: 5 }];
    make();
    const walk = vi.spyOn(api, 'walkTo').mockImplementation(async () => { host.me.y = 27; return { ok: true, message: 'arrived' }; });
    expect(api.attack('Sparring Golem').ok).toBe(true);
    await step(10_000);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(walk.mock.calls[0][0]).toBe(GOLEM);
    expect(host.sent.filter((s) => s.startsWith('cast 86 80003001')).length).toBeGreaterThan(0);
  });

  it('a routine pull casts at the monster, breaks off when the bolt lands, and runs back', async () => {
    reply = () => { host.me.mana.current -= 10; api.pushChat('You pierce Sparring Golem for 11 points with Force Bolt I.', 0x16); };
    make();
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const p = profile();
    api.routine.start(p);
    const r = await settle(engine(api).act({ kind: 'pull', pattern: 'Sparring Golem', back: at(80, 5), meters: 25 }, p));
    expect(r?.message).toMatch(/^pulled Sparring Golem \(You pierce Sparring Golem for 11 points with Force Bolt I\.\); back to /);
    expect(host.sent).toContain('cast 86 80003001');
    expect(host.sent.some((s) => s.startsWith('attack '))).toBe(false);
    expect(walk).toHaveBeenCalledWith(at(80, 5), expect.objectContaining({ flee: true }));
    // Broken off: no more bolts once the pull landed.
    const n = host.sent.filter((s) => s.startsWith('cast ')).length;
    await step(5_000);
    expect(host.sent.filter((s) => s.startsWith('cast ')).length).toBe(n);
  });

  it('a routine attack-nearest casts until the kill', async () => {
    make();
    const p = profile();
    api.routine.start(p);
    const r = await settle(engine(api).act({ kind: 'attack-nearest', meters: 60 }, p));
    expect(r).toMatchObject({ ok: true, message: 'killed Sparring Golem' });
    expect(host.sent.filter((s) => s.startsWith('cast 86 '))).toHaveLength(3);
  });

  it('melee is unchanged: no wand, the attack swings and nothing is cast', async () => {
    host.inv = [{ guid: 0x70000002, name: 'Club', where: 'equipped', slot: 'MeleeWeapon', type: 'MeleeWeapon', itemType: 0x1 }];
    make();
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const p = profile();
    api.routine.start(p);
    const pulled = engine(api).act({ kind: 'pull', pattern: 'Sparring Golem', back: at(80, 5) }, p);
    await step(300);
    expect(host.sent.some((s) => s.startsWith('attack 80003001'))).toBe(true);
    api.pushChat('You hit Sparring Golem for 6 points of bludgeoning damage!', 0x16);
    const r = await settle(pulled);
    expect(r?.message).toMatch(/^pulled Sparring Golem \(You hit Sparring Golem/);
    expect(host.sent.some((s) => s.startsWith('cast ') || s === 'mode magic')).toBe(false);
    expect(walk).toHaveBeenCalled();
  });

  it('bare-handed in magic mode (a server that casts without a wand) casts; a club wielder left in magic mode swings', async () => {
    host.inv = [];
    host.me.combatMode = 'magic';
    make();
    expect(api.attack('Sparring Golem').message).toMatch(/^casting Force Bolt I at Sparring Golem/);
    await step(2000);
    expect(host.sent).toContain('cast 86 80003001');
    expect(host.sent).not.toContain('mode magic'); // already there
    api.stopAttacking();

    host.sent.length = 0;
    host.inv = [{ guid: 0x70000002, name: 'Club', where: 'equipped', slot: 'MeleeWeapon', type: 'MeleeWeapon', itemType: 0x1 }];
    host.dying.clear();
    expect(api.attack('Sparring Golem').message).toMatch(/^attacking Sparring Golem/);
    await step(300);
    expect(host.sent.some((s) => s.startsWith('attack 80003001'))).toBe(true);
    expect(host.sent.some((s) => s.startsWith('cast '))).toBe(false);
  });
});

describe('casterAttackSpell: the macro\'s attack spell choice, from the era\'s table', () => {
  const skills = [{ id: 34, name: 'War Magic', training: 'trained' as const, base: 40, buffed: 40 }];
  const spellsOf = (t: ReturnType<typeof table>) => [...t.spells].filter(([, s]) => s.school === 1).map(([id, s]) => ({
    id, name: s.name, school: 'War Magic', category: s.category, power: s.power, self: false, buff: false, duration: 0,
  }));
  const pick = (t: ReturnType<typeof table>, facts?: (n: string) => { weak: Array<'fire'>; maxHealth: number } | undefined) => casterAttackSpell({
    spells: spellsOf(t), skills, items: [{ guid: WAND, name: 'Training Wand', equipped: true, itemType: 0x8000 }], itemNames: [],
    wielded: { weapon: 'Training Wand' }, settings: {}, families: buildCombatFamilies(t), ...(facts ? { monsterFacts: facts } : {}),
  }, { guid: GOLEM, name: 'Sparring Golem', dist: 70, relBearing: 0 });

  it('end-of-retail and a table with other category numbers (as 1999\'s) pick the same bolt, at any distance', () => {
    expect(pick(table(122, 120))).toMatchObject({ spell: { id: 86 }, projectile: true });
    expect(pick(table(41, 43))).toMatchObject({ spell: { id: 86 }, projectile: true });
  });
  it('the era\'s monster table steers the element, as in the macro', () => {
    expect(pick(table(122, 120), () => ({ weak: ['fire'], maxHealth: 100 }))).toMatchObject({ spell: { id: 27 } });
  });
  it('an era without the bolt family casts nothing', () => {
    const t = table(122, 120);
    t.spells.delete(86); t.spells.delete(87); t.spells.delete(27);
    expect(pick(t)).toBeNull();
  });
});
