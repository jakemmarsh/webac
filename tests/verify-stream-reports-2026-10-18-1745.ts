/**
 * Stream reports 2026-10-18 ~17:45Z (Claude Arcanist / Claude Bulwark in the Crystal Core, landblock 0x5861):
 *  1. `use item="Health Potion"` drank a Health Draught (10 HP) as "the strongest you carry" beside an unappraised
 *     Potion of Healing (25 HP): an appraisal's boost outranked any price, so mixed knowledge picked the weaker one.
 *  2. observe's buffs line cut 51 Incantations after ~30 and hid that Fire Protection was missing (Arcanist died to
 *     Char Golems' Flame Volley at 17:46Z): every buff is named now, compactly, with a protections line.
 *  3. every Incantation said "just landed, 0s ago" every look: two casters' layers of one spell (ACE keeps a layer per
 *     caster) were compared one by one against one remembered time.
 *  5. "Heal Other V restores 0 points" while hurt: ACE's own line (the target was full when it landed); the answer now
 *     says when a heal of yours landed on them just before.
 *  6. the corpse lines say what the world DB places in the corpse's dungeon (levels, XP) beside the character's level.
 *
 * Driven through the shipped code: AgentApi on the fake host, format.ts formatBuffs / protectionsLine /
 * formatObservation, tools/stream/corpses.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatBuffs, formatObservation, protectionsLine } from '../packages/renderer/src/agent/format.ts';
import { areaCreatureSql, areaCreaturesText, corpseBlock, corpseFacts, parseAreaCreatures, type AreaCreature } from '../tools/stream/corpses.ts';
import type { FeedEvent } from '../tools/stream/feed-types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100, { physics: false }); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

const DRAUGHT = 0x800014e2;
const POTION = 0x8000fc6e;
const data = (boost: number, vital = 2) => ({ int: { 89: vital, 90: boost }, float: {}, string: {}, bool: {}, did: {}, spells: [] });

describe('1. the strongest restorative: one basis for every candidate', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [
      { guid: DRAUGHT, name: 'Health Draught', where: 'pack', stack: 2, value: 170, wcid: 2457 },
      { guid: POTION, name: 'Potion of Healing', where: 'pack', stack: 1, value: 170, wcid: 377 },
    ];
    host.me.health = { current: 19, max: 50 };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('the Draught appraised (10), the Potion not yet: the Potion is appraised before the pick, and its 25 wins (17:45Z)', async () => {
    host.appraised.push(DRAUGHT);
    host.appraisalDatas.set(DRAUGHT, data(10));
    // The server's answer to the appraisal (the fake answers at once).
    host.appraisalDatas.set(POTION, data(25));
    const r = (await settle(api, host, api.use('Health Potion'), 20_000))!;
    expect(host.appraiseCalls.some((c) => c.guid === POTION && c.quiet)).toBe(true);
    expect(host.sent).toContain(`use ${POTION.toString(16)}`);
    expect(host.sent).not.toContain(`use ${DRAUGHT.toString(16)}`);
    expect(r.message).toMatch(/used Potion of Healing, the strongest you carry \(restores 25 health\)/);
  });

  it('the heal hint (restoreOptions) ranks on the same basis: both appraised, the Potion\'s 25 is named before the Draught\'s 10', () => {
    host.appraised.push(DRAUGHT, POTION);
    host.appraisalDatas.set(DRAUGHT, data(10));
    host.appraisalDatas.set(POTION, data(25));
    expect(api.restoreOptions('health').drink).toBe('ac_use item="Potion of Healing" (restores up to 25; you carry 1; also Health Draught ×2)');
  });

  it('no appraisal answers: all by price per unit, said so (the Draught\'s known 10 does not outrank an unknown)', async () => {
    host.appraised.push(DRAUGHT);
    host.appraisalDatas.set(DRAUGHT, data(10));
    const r = (await settle(api, host, api.use('Health Potion'), 20_000))!;
    expect(host.sent).toContain(`use ${POTION.toString(16)}`);
    expect(r.message).toMatch(/used Potion of Healing, the strongest you carry \(170 pyreals each, unappraised\)/);
  });

  it('another stack of the same weenie that was appraised says what this one restores', async () => {
    const OTHER = 0x800062a4;
    host.inv.push({ guid: OTHER, name: 'Potions of Healing', where: 'pack', stack: 3, value: 510, wcid: 377 });
    host.appraised.push(DRAUGHT, OTHER);
    host.appraisalDatas.set(DRAUGHT, data(10));
    host.appraisalDatas.set(OTHER, data(25));
    const r = (await settle(api, host, api.use('Health Potion'), 20_000))!;
    expect(r.message).toMatch(/the strongest you carry \(restores 25 health\)/);
    expect(host.sent.some((s) => s === `use ${POTION.toString(16)}` || s === `use ${OTHER.toString(16)}`)).toBe(true);
  });

  it('at full health it asks, both appraised now (quietly) so the next ask ranks by what they restore', async () => {
    host.me.health = { current: 50, max: 50 };
    const r = await api.use('Health Potion');
    expect(r.ok).toBe(false);
    expect(host.appraiseCalls.filter((c) => c.quiet).map((c) => c.guid).sort()).toEqual([DRAUGHT, POTION].sort());
    host.appraisalDatas.set(DRAUGHT, data(10));
    host.appraisalDatas.set(POTION, data(25));
    const again = await api.use('Health Potion');
    expect(again.message).toBe(`"Health Potion" could be Potion of Healing #${POTION.toString(16)} (restores 25 health), Health Draught #${DRAUGHT.toString(16)} (restores 10 health): name one (or its #id)`);
  });
});

// Arcanist's Incantations at 17:4xZ: every elemental protection but fire, two casters' layers of several.
const PROT: Record<string, number> = { Blade: 64, Piercing: 65, Bludgeoning: 66, Fire: 67, Cold: 68, Acid: 69, Lightning: 70 };
type Buff = { name: string; remaining: number; beneficial: boolean; statModType?: number; statModKey?: number; statModValue?: number };
const incant = (what: string, remaining: number, extra: Partial<Buff> = {}): Buff => ({ name: `Incantation of ${what} Other`, remaining, beneficial: true, ...extra });
const prot = (kind: string, remaining: number): Buff => incant(`${kind} Protection`, remaining, { statModType: 0x2004008, statModKey: PROT[kind], statModValue: 0.32 });

describe('2. the buffs line names every buff, and the protections line says which are not up', () => {
  const skills = ['Strength', 'Endurance', 'Coordination', 'Focus', 'Armor', 'Mana Renewal', 'Regeneration', 'Invulnerability', 'Impregnability', 'Light Weapon Mastery', 'Missile Weapon Mastery', 'Finesse Weapon Mastery', 'Creature Enchantment Mastery', 'Life Magic Mastery', 'Item Enchantment Mastery', 'Healing Mastery', 'Leadership Mastery', 'Person Attunement', 'Armor Tinkering Expertise', 'Item Tinkering Expertise', 'Arcane Enlightenment', 'Mana Conversion Mastery'];
  const buffs: Buff[] = [
    ...skills.map((s, i) => incant(s, 4000 + i * 10, { statModType: 0x2000000 })),
    ...['Blade', 'Piercing', 'Bludgeoning', 'Cold', 'Acid', 'Lightning'].map((k, i) => prot(k, 4300 + i * 5)),
    // A second caster's layer of two of them (ACE EnchantmentManager.Add: a layer per caster).
    incant('Strength', 4620, { statModType: 0x2000000 }), prot('Blade', 4630),
    { name: 'Fire Protection Other V', remaining: 900, beneficial: true, statModType: 0x2004008, statModKey: 67, statModValue: 0.5 },
  ];

  it('one entry per name, every name there (no "+N more"), one wording written once', () => {
    const line = formatBuffs(buffs);
    expect(line).toMatch(/^buffs \(29\): /);
    expect(line).not.toMatch(/more/);
    for (const s of skills) expect(line).toContain(`${s} `);
    expect(line).toContain('Incantation of … Other: ');
    expect(line.match(/Incantation of/g)).toHaveLength(1);
    // The longer of the two Blade layers.
    expect(line).toContain('Blade Protection 77m');
    expect(line.length).toBeLessThan(1500);
  });

  it('protections: the six up with their multipliers, fire NOT on you when nothing covers it', () => {
    const noFire = buffs.filter((b) => b.name !== 'Fire Protection Other V');
    expect(protectionsLine(noFire)).toBe('protections on you (damage of that kind taken ×): Blade ×0.32, Piercing ×0.32, Bludgeoning ×0.32, Cold ×0.32, Acid ×0.32, Lightning ×0.32; NOT on you: Fire (banes on your armour count apart)');
    // Fire Protection Other V (×0.5) covers it.
    expect(protectionsLine(buffs)).toMatch(/Fire ×0\.5.*; all seven up/);
    // A vulnerability is said as one; no stat mods known (an older host): no claim.
    expect(protectionsLine([{ statModType: 0x4008, statModKey: 67, statModValue: 2.5 }])).toBe('protections on you (damage of that kind taken ×): none; NOT on you: Blade, Piercing, Bludgeoning, Fire, Cold, Acid, Lightning; vulnerabilities on you: Fire ×2.5 (banes on your armour count apart)');
    expect(protectionsLine([{ name: 'x' } as never])).toBeNull();
  });

  it('observe carries it under the buffs line', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.buffs = buffs.filter((b) => b.name !== 'Fire Protection Other V');
    const text = formatObservation(api.observe());
    expect(text).toMatch(/^ {2}protections on you \(damage of that kind taken ×\): .*NOT on you: Fire /m);
    vi.restoreAllMocks();
  });
});

describe('3. two casters\' layers of one spell are not "just landed" every look', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('Bulwark\'s doubled Incantations, minutes after they landed: no "just landed"; a third layer added is', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.buffs = [{ name: 'Heritage Bonus', remaining: -1, beneficial: true }];
    run(api, host, 1000, { physics: false });
    // Both casters' Incantations land.
    host.buffs.push(incant('Armor', 4000), incant('Armor', 4600), incant('Strength', 4100), incant('Strength', 4620));
    run(api, host, 1000, { physics: false });
    expect(formatObservation(api.observe())).toMatch(/just landed/);
    // Five minutes on, counting down: nothing just landed, look after look.
    const tick = (s: number): void => { for (const b of host.buffs) if (b.remaining > 0) b.remaining -= s; run(api, host, s * 1000, { physics: false }); };
    tick(300);
    expect(formatObservation(api.observe())).not.toMatch(/just landed/);
    tick(2);
    expect(formatObservation(api.observe())).not.toMatch(/just landed/);
    // A third caster's layer of Armor: that one did land.
    host.buffs.push(incant('Armor', 4500));
    tick(1);
    expect(formatObservation(api.observe())).toMatch(/^buffs \(3\): just landed \d+s ago: Incantation of Armor Other 7\dm; /m);
  });
});

describe('5. a heal that restores 0 says the heal of yours that landed just before', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('the routine\'s Heal Other V for 80, then the agent\'s own for 0, 2 s later (17:3xZ)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    const api = new AgentApi(host);
    const BULWARK = 0x500000a4;
    host.spells = () => [{ id: 1165, name: 'Heal Other V', school: 'Life', level: 5, targetType: 0x10 }];
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    api.pushChat('With Heal Other V you restore 80 points of health to Claude Bulwark.', 0x11);
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      setTimeout(() => api.pushChat('With Heal Other V you restore 0 points of health to Claude Bulwark.', 0x11), 1500);
      return true;
    };
    const r = (await settle(api, host, api.cast('Heal Other V', 'Claude Bulwark'), 10_000))!;
    expect(r.message).toMatch(/Claude Bulwark was already at full health when it landed \(your Heal Other V restored 80 health to them [12]s before\): nothing to restore/);
  });
});

describe('6. corpse lines: the monsters the world DB places in the corpse\'s dungeon, and your level', () => {
  const T = Date.parse('2026-10-18T16:58:00Z');
  const ev = (e: object): FeedEvent => ({ v: 1, char: 'soldier', ...e } as FeedEvent);
  const death = (): FeedEvent[] => [
    ev({ t: T - 4000, type: 'status', name: 'Claude Bulwark', level: 50, health: { cur: 20, max: 185 }, stamina: { cur: 1, max: 200 }, mana: { cur: 50, max: 80 }, xp: { total: 1, toNext: 1 }, location: 'indoors (0x5861014A)', goal: null }),
    ev({ t: T, type: 'chat', channel: 'system', text: 'You are incinerated by Scorching Flame\'s attack!' }),
    ev({ t: T, type: 'death', text: 'You are incinerated by Scorching Flame\'s attack!', killer: 'Scorching Flame' }),
    ev({ t: T + 2000, type: 'chat', channel: 'system', text: 'You\'ve lost your Scalemail Shirt, your Platemail Vambraces, and your Gorget!' }),
  ];
  // The rows `areaCreatureSql(0x5861)` returns from the end-of-retail world DB (checked 2026-10-18 on ace-db).
  const rows = '48715\tPrism Shard\t60\t50000\n48712\tChar Golem\t80\tNULL\n48711\tScorching Flame\t80\tNULL\n48713\tBlazing Crystal\t100\t80000\n';

  it('the SQL follows placements and generator chains in the landblock; the rows parse with NULL XP as 0', () => {
    const sql = areaCreatureSql(0x5861);
    expect(sql).toContain('(obj_Cell_Id >> 16) = 22625');
    expect(sql).toMatch(/^WITH RECURSIVE/);
    expect(parseAreaCreatures(rows)).toEqual([
      { name: 'Prism Shard', level: 60, xp: 50000 }, { name: 'Char Golem', level: 80, xp: 0 }, { name: 'Scorching Flame', level: 80, xp: 0 }, { name: 'Blazing Crystal', level: 100, xp: 80000 },
    ]);
  });

  it('Bulwark\'s Crystal Core corpse: the golems L80 and 0 XP beside his L50, from the line itself', () => {
    const facts = corpseFacts(death(), 'Claude Bulwark', T + 600_000);
    const asked: number[] = [];
    const block = corpseBlock(facts, T + 600_000, (lb) => { asked.push(lb); return parseAreaCreatures(rows); })!;
    expect(asked).toEqual([0x5861]);
    expect(block).toContain('; the world DB places these monsters in landblock 0x5861: Prism Shard L60 (50,000 XP), Char Golem L80 (0 XP), Scorching Flame L80 (0 XP), Blazing Crystal L100 (80,000 XP); you were L50 when you died there');
    // No DB (or it failed): the line is as before.
    expect(corpseBlock(facts, T + 600_000, () => null)).not.toMatch(/world DB places/);
    expect(corpseBlock(facts, T + 600_000, () => { throw new Error('no docker'); })).not.toMatch(/world DB places/);
  });

  it('an outdoor corpse asks nothing (the landscape is encounters, not placements); a long list keeps the highest levels', () => {
    const out: FeedEvent[] = [...death().slice(0, 3), ev({ t: T + 2000, type: 'chat', channel: 'system', text: 'You\'ve lost your Gorget!' }), ev({ t: T + 2500, type: 'chat', channel: 'system', text: 'Your corpse is located at (42.1N, 33.6E).' })];
    const asked: number[] = [];
    corpseBlock(corpseFacts(out, 'Claude Bulwark', T + 600_000), T + 600_000, (lb) => { asked.push(lb); return []; });
    expect(asked).toEqual([]);
    const many: AreaCreature[] = Array.from({ length: 12 }, (_, i) => ({ name: `Mob ${i}`, level: 10 + i, xp: 100 }));
    const t = areaCreaturesText(0x5861, many, 50)!;
    expect(t).toMatch(/: Mob 4 L14 \(100 XP\), .*Mob 11 L21 \(100 XP\) and 4 lower; you were L50/);
  });
});
