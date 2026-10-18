/**
 * Stream reports 2026-10-18 19:28Z (Claude Arcanist / Claude Bulwark farming Aerbax Haven, landblock 0x029F):
 *  1. observe was too long to read at a glance: the 40-buff list, two corpses' contents and the money and vitae notes
 *     on every look. The player's own look (AgentApi.playerObserve) prints a long section in full once, then short while
 *     it says the same (for OBSERVE_REFULL_MS); what matters stays: a missing protection, what ends soon, what landed,
 *     what dropped. `full=true` prints everything.
 *  2. Bulwark's max health 205 → 198 at 19:22:40Z: a Marionette's Frailty Other II (−15 Endurance), named by observe's
 *     debuff and lowered-vitals lines, but he read it from a wait's NOW head ("health 198/198 (100%)") and a walk stop
 *     ("took 22 of your 196 health": 196 was his health then, of 205). Both say it now.
 *  3. "Claude Bulwark is 213 m away now (was 5 m): they fell behind" when Arcanist took the Aerbax Haven portal first:
 *     the client's last spot of Bulwark in the Laboratory (0x029E, the next landblock on the grid) read as a distance.
 *     A creature in another landblock with a dungeon cell on either side is no longer "nearby"; the fellows line says
 *     where the client last placed them; the walk says you went through a portal and they are where you left.
 *  4. Arcanist's Pathwarden Helm ran out of mana three times in a day, warned only two minutes ahead by the server.
 *     Worn items' mana is read by quiet appraisals and said when under 15 minutes are left, with what refills it.
 *
 * Driven through the shipped code: AgentApi on the fake host (its surface's observe, wait, walkTo), format.ts
 * formatObservation / formatBuffsBrief / protectionsLine, and the ac_observe tool's arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatBuffsBrief, formatObservation, protectionsLine } from '../packages/renderer/src/agent/format.ts';
import type { AgentObservation } from '../packages/renderer/src/agent/types.ts';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

type Buff = { name: string; remaining: number; beneficial: boolean; statModType?: number; statModKey?: number; statModValue?: number };
const PROT: Record<string, number> = { Blade: 64, Piercing: 65, Bludgeoning: 66, Fire: 67, Cold: 68, Acid: 69, Lightning: 70 };
const incant = (what: string, remaining: number): Buff => ({ name: `Incantation of ${what} Other`, remaining, beneficial: true, statModType: 0x2000000 });
const prot = (kind: string, remaining: number): Buff => ({ name: `Incantation of ${kind} Protection Other`, remaining, beneficial: true, statModType: 0x2004008, statModKey: PROT[kind], statModValue: 0.32 });

/** Bulwark's 19:22:06Z list, shortened: 26 Incantations (seven protections), four auras. */
function bulwarkBuffs(): Buff[] {
  const skills = ['Invulnerability', 'Leadership Mastery', 'Life Magic Mastery', 'Item Tinkering Expertise', 'Person Attunement', 'Missile Weapon Mastery', 'Healing Mastery', 'Item Enchantment Mastery', 'Impregnability', 'Arcane Enlightenment', 'Light Weapon Mastery', 'Deception Mastery', 'Lockpick Mastery', 'Fealty', 'Focus', 'Creature Enchantment Mastery', 'Armor Tinkering Expertise', 'Finesse Weapon Mastery', 'Mana Renewal'];
  return [
    ...skills.map((s, i) => incant(s, 366 + i * 50)),
    ...['Blade', 'Piercing', 'Bludgeoning', 'Fire', 'Cold', 'Acid', 'Lightning'].map((k, i) => prot(k, 1200 + i * 60)),
    ...['Blood Drinker', 'Swift Killer', 'Heart Seeker', 'Defender'].map((a, i) => ({ name: `Aura of ${a} Other V`, remaining: 503 + i * 4, beneficial: true })),
    { name: 'Aura of Blood Drinker Self I', remaining: -1, beneficial: true },
  ];
}

const look = (api: AgentApi, o: Record<string, unknown> = {}): AgentObservation => (api.surface() as { observe: (o?: unknown) => AgentObservation }).observe(o);
const buffLine = (text: string): string => text.split('\n').find((l) => /^buffs/.test(l))!;

describe('1. a compact observe: long sections in full once, then short while they say the same', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 50;
    host.me.pyreals = 50702;
    host.buffs = bulwarkBuffs();
    host.inv = [
      { guid: 0x80000101, name: 'Pyreal', where: 'pack', stack: 50702, value: 50702, itemType: 0x40 },
      { guid: 0x80000102, name: 'Trade Note (5000)', where: 'pack', stack: 71, value: 355000, itemType: 0x40000 },
    ];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('the first look names every buff; the next says the count, the four soonest, when the rest end, and how to list all', () => {
    const first = formatObservation(look(api));
    expect(buffLine(first)).toMatch(/^buffs \(31\): /);
    expect(buffLine(first)).toContain('Mana Renewal');
    run(api, host, 30_000, { physics: false });
    const second = formatObservation(look(api));
    const line = buffLine(second);
    expect(line).toMatch(/^buffs \(31; every one: ac_observe full=true\): soonest to end: Incantation of … Other: Invulnerability 6m6s, Leadership Mastery 6m56s, Life Magic Mastery 7m46s; Aura of Blood Drinker Other V 8m23s; /);
    expect(line).toMatch(/the other 2\d end in \d+m\d*s? to \d+m/);
    expect(line).toContain('1 with no end time (Aura of Blood Drinker Self I)');
    expect(line).not.toContain('Mana Renewal');
    expect(line.length).toBeLessThan(buffLine(first).length / 2);
    // The protections line is said every look, all seven at one multiplier in a few words.
    expect(second).toMatch(/\n {2}protections on you \(damage of that kind taken ×\): all seven up, ×0\.32 each \(banes on your armour count apart\)/);
    // The money facts once; the sums every look.
    expect(first).toMatch(/money: 50,702 in coins \+ 355,000 in trade notes \(71 notes\) = 405,702 \(half your coins are lost if you die/);
    expect(second).toMatch(/money: 50,702 in coins \+ 355,000 in trade notes \(71 notes\) = 405,702$/m);
    expect(look(api).brief).toEqual(expect.arrayContaining(['buffs', 'money']));
  });

  it('nothing that matters goes short: a missing protection, a buff running low, one gone, one just landed', () => {
    look(api);
    run(api, host, 5_000, { physics: false });
    // Fire Protection drops (dispelled), Invulnerability runs down to 90 s, a new Strength lands.
    host.buffs = host.buffs.filter((b) => b.name !== 'Incantation of Fire Protection Other');
    host.buffs.find((b) => b.name === 'Incantation of Invulnerability Other')!.remaining = 90;
    host.buffs.push(incant('Strength', 3600));
    run(api, host, 2_000, { physics: false });
    const text = formatObservation(look(api));
    const line = buffLine(text);
    expect(line).toMatch(/^buffs \(31; every one: ac_observe full=true\): just landed \d+s ago: Incantation of Strength Other 60m; soonest to end: Incantation of … Other: Invulnerability 1m30s, /);
    expect(line).toMatch(/; GONE since your last look: Incantation of Fire Protection Other$/);
    expect(text).toMatch(/protections on you .*NOT on you: Fire/);
    expect(text).toMatch(/BUFFS RUNNING LOW \(2 min or less left\): Incantation of Invulnerability Other 1m30s/);
  });

  it('full=true (and the ac_observe tool\'s full argument) prints everything; so does a look 15 min after the full one', async () => {
    look(api);
    expect(look(api, { full: true }).brief).toBeUndefined();
    expect(look(api).brief).toContain('buffs');
    run(api, host, AgentApi.OBSERVE_REFULL_MS + 1000, { physics: false });
    expect(look(api).brief).toBeUndefined();
    const seen: unknown[][] = [];
    const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return look(api, a?.[0] as Record<string, unknown>) as T; } };
    const tool = TOOLS.find((t) => t.name === 'ac_observe')!;
    expect(tool.props.full.type).toBe('boolean');
    await TOOL_CALLER.run(caller, () => tool.run({ full: true }));
    expect(seen[0]).toEqual(['observe', { radius: undefined, max: undefined, filter: undefined, full: true }]);
  });

  it('a routine\'s snapshot neither counts as the player\'s look nor spends it', () => {
    api.snapshot();
    expect(look(api).brief).toBeUndefined();
    api.snapshot();
    expect(look(api).brief).toContain('buffs');
  });

  it('the short buff line on its own: none left, with what dropped', () => {
    expect(formatBuffsBrief([], ['Incantation of Armor Other'])).toBe('buffs: none; GONE since your last look: Incantation of Armor Other');
  });

  it('protections at mixed multipliers are listed one by one, as before', () => {
    const mixed = bulwarkBuffs().filter((b) => b.name !== 'Incantation of Fire Protection Other');
    mixed.push({ name: 'Fire Protection Other V', remaining: 900, beneficial: true, statModType: 0x2004008, statModKey: 67, statModValue: 0.5 });
    expect(protectionsLine(mixed)).toMatch(/: Blade ×0\.32, .*Fire ×0\.5, .*; all seven up/);
  });
});

describe('1b. the corpses and vitae lines go short too', () => {
  const T_DEATH = Date.parse('2026-10-18T17:13:00Z');
  let store: Map<string, string>;
  let host: FakeHost;
  let wall = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    host = new FakeHost();
    host.me.name = 'Claude Bulwark';
    host.me.level = 50;
    host.me.health = { current: 205, max: 205 };
    host.me.cell = 0x5861014a;
    wall = T_DEATH;
    host.wallClock = () => wall + host.t;
    host.inv = [
      { guid: 0x80000379, name: 'Scalemail Shirt', where: 'equipped', mask: 0x200 },
      { guid: 0x80000380, name: 'Slippers', where: 'main pack', validLocations: 0x100 },
    ];
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('the same corpse in the same state: where and its state, not what is on it; a change prints it in full again', () => {
    const api = new AgentApi(host);
    api.pushChat('You are utterly destroyed by Char Golem\'s Scorching Flame!', 0x15);
    host.me.dead = true;
    run(api, host, 200, { physics: false });
    host.inv = [];
    api.pushChat("You've lost 1,000 Pyreals, your Scalemail Shirt, and your Slippers!", 0);
    run(api, host, 2000, { physics: false });
    host.me.dead = false;
    run(api, host, 200, { physics: false });
    const first = look(api).corpses!;
    expect(first).toMatch(/^your corpses: from your death 1 min ago inside landblock 0x5861, cell 0x5861014A: Scalemail Shirt, Slippers \(worn when you died: Scalemail Shirt; the rest from your pack\); rots in about/);
    wall += 10 * 60_000;
    run(api, host, 1000, { physics: false });
    const second = look(api).corpses!;
    expect(second).toMatch(/^your corpses: from your death 10 min ago in cell 0x5861014A \(2 items\): rots in about 4 h \(what is on each: ac_observe full=true\)$/);
    expect(look(api, { full: true }).corpses).toMatch(/Scalemail Shirt, Slippers/);
  });

  it('the vitae line: the cost and the XP that clears it, after the first look', () => {
    host.vitae = () => ({ multiplier: 0.99, xpToNext: 1796, deathLevel: 50, maxWithout: { health: 205, stamina: 306, mana: 149 } } as never);
    host.me.health = { current: 203, max: 203 };
    const api = new AgentApi(host);
    const first = look(api).vitae;
    expect(first).toMatch(/each death adds 5% more/);
    const second = look(api).vitae!;
    expect(second).toMatch(/^VITAE −1%: max health, stamina, mana and every skill 1% lower .*clears it all .*\(the rest: ac_observe full=true\)$/);
    expect(second).not.toMatch(/each death adds/);
  });
});

/** A spell table with the one debuff (the DAT's description wording). */
const FRAILTY_II = 1200;
const spellTable = { spells: new Map([[FRAILTY_II, { name: 'Frailty Other II', desc: "Decreases the target's Endurance by 15 points.", category: 0, power: 50 }]]) };

describe('2. a lowered maximum is said where Bulwark read it: the wait\'s NOW head, a walk stop\'s "of your … health"', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', level: 50, health: { current: 198, max: 198 }, stamina: { current: 178, max: 291 }, mana: { current: 149, max: 149 } };
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => spellTable;
    host.vitalAttributes = () => ({ health: [2], stamina: [2], mana: [6] });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('19:23:08Z: the NOW head says health 198/198 and that Frailty Other II lowers it', async () => {
    host.buffs = [{ spellId: FRAILTY_II, name: 'Frailty Other II', remaining: 60, beneficial: false } as never];
    api.push('aggro', 'Marionette #8000baed (level 26) is coming at you, 23 m SW (turned to face you)');
    run(api, host, 30_000, { physics: false });
    const p = api.wait({ types: ['task-done', 'aggro'] }, 10);
    vi.advanceTimersByTime(20);
    const evs = await p;
    expect(evs[0].type).toBe('now');
    expect(evs[0].text).toMatch(/you: health 198\/198 \(100%\), mana 149\/149 \(100%\) \(max health 198 and stamina 291 lowered by Frailty Other II \(−15 Endurance, which Maximum Health and Stamina are drawn from, 1m left\): back up when it ends, or a dispel takes it off\)/);
  });

  it('no lowering debuff: the NOW head as before', async () => {
    api.push('aggro', 'Marionette #8000baed (level 26) is coming at you');
    run(api, host, 30_000, { physics: false });
    const p = api.wait({ types: ['aggro'] }, 10);
    vi.advanceTimersByTime(20);
    expect((await p)[0].text).toMatch(/you: health 198\/198 \(100%\), mana 149\/149 \(100%\)(; fellows|$)/);
  });

  it('19:25:29Z: "22 of the 196 health you have (of 205)", not "of your 196 health"; at full health as before', () => {
    const hurt = (api as unknown as { spellHurt: (s: { spells: Map<string, number> }, base: number, max?: number) => string | null }).spellHurt.bind(api);
    const seen = { spells: new Map([['Drain Mana Other III', 22]]) };
    expect(hurt(seen, 196, 205)).toBe("its kind's Drain Mana Other III took 22 of the 196 health you have (of 205)");
    expect(hurt(seen, 205, 205)).toBe("its kind's Drain Mana Other III took 22 of your 205 health");
  });
});

describe('3. a fellow the client last placed in another dungeon is no distance away', () => {
  const LAB = 0x029e0119;
  const HAVEN = 0x029f017e;
  const BULWARK = 0x50000004;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', cell: LAB, x: 60, y: 60, z: 0 };
    // Every interior cell here is a sealed dungeon cell (no SeenOutside); outdoors is not.
    host.cellSealed = (c: number) => (c & 0xffff) >= 0x100;
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: LAB, x: 63, y: 60, z: 0 });
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 186, max: 205 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('18:56:29Z: through the Haven portal, Bulwark still in the Lab: "not here: … another dungeon (landblock 0x029E)", not "213 m S"', () => {
    expect(formatObservation(look(api))).toMatch(/fellows: Claude Bulwark 91% HP, 3 m /);
    host.me = { ...host.me, cell: HAVEN, x: 60, y: -150 };
    run(api, host, 40_000, { physics: false });
    const obs = look(api);
    expect(obs.nearby.some((o) => o.guid === BULWARK)).toBe(false);
    const text = formatObservation(obs);
    expect(text).toMatch(/fellows: Claude Bulwark 91% HP, not here: the client last placed them in another dungeon \(landblock 0x029E\), where nothing of theirs reaches you; they may be on their way \(ask in \/f\)/);
    expect(text).not.toMatch(/Claude Bulwark 91% HP, \d+ m/);
  });

  it('a fellow in the next landblock on the landscape is still placed (the landscape has adjacent landblocks)', () => {
    host.me = { ...host.me, cell: 0xa9b40039, x: 180, y: 20 };
    host.objs.get(BULWARK)!.cell = 0xaab40001;
    host.objs.get(BULWARK)!.x = 4;
    expect(formatObservation(look(api))).toMatch(/fellows: Claude Bulwark 91% HP, 43 m N/);
  });

  it('18:56:20Z: a walk that went through a portal says the fellow is where you left, not that they fell behind', async () => {
    const p = api.walkTo('20m north', { within: 1 });
    run(api, host, 1500);
    // The portal: the body is in the Haven at once.
    host.me = { ...host.me, cell: HAVEN, x: 60, y: -150 };
    run(api, host, 20_000);
    const r = await p;
    expect(r.message).toMatch(/Claude Bulwark is still in the place you left \(3 m from you when this walk set off; you went through a portal and they haven't come through yet\): wait for them at the arrival, or tell them in \/f/);
    expect(r.message).not.toMatch(/fell behind/);
  });
});

describe('4. worn gear running out of mana is said ahead, with what refills it', () => {
  const HELM = 0x80003a11;
  const STONE = 0x80003b22;
  let host: FakeHost;
  let api: AgentApi;
  const helmData = (cur: number) => ({ int: { 107: cur, 108: 1500 }, float: { 5: -0.04 }, string: {}, bool: {}, did: {}, spells: [] });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.inv = [{ guid: HELM, name: 'Pathwarden Helm', where: 'equipped', mask: 0x1 }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a worn item is appraised quietly for its mana; 30 mana at 0.04 a second is 12m30s: said, with where charges are sold', () => {
    host.appraisalDatas.set(HELM, helmData(30));
    expect(look(api).gearManaLow).toBeUndefined();
    expect(host.appraiseCalls).toContainEqual({ guid: HELM, quiet: true });
    // The answer (a new appraisal object) is a read dated now.
    host.appraisalDatas.set(HELM, helmData(30));
    const obs = look(api);
    expect(obs.gearManaLow?.items).toEqual([{ guid: HELM, name: 'Pathwarden Helm', leftS: 750, mana: { cur: 30, max: 1500 } }]);
    expect(formatObservation(obs)).toMatch(/\ngear running out of mana \(its spells go off when it does\): Pathwarden Helm #80003a11 \(about 12m30s of mana left, 30\/1500 when last read\); you carry no charged mana stone or Mana Charge; a mage's shop \(an Archmage's or Magus's\) is where mana stones and Mana Charges are sold/);
    // Reckoned on: five minutes later 7m30s.
    run(api, host, 300_000, { physics: false });
    expect(look(api).gearManaLow?.items[0].leftS).toBe(450);
  });

  it('plenty of mana: nothing said, and read again only after GEAR_MANA_REREAD_MS', () => {
    host.appraisalDatas.set(HELM, helmData(1400));
    look(api);
    host.appraisalDatas.set(HELM, helmData(1400));
    expect(look(api).gearManaLow).toBeUndefined();
    const asks = (): number => host.appraiseCalls.filter((c) => c.guid === HELM).length;
    const n = asks();
    run(api, host, 60_000, { physics: false });
    look(api);
    expect(asks()).toBe(n);
    run(api, host, AgentApi.GEAR_MANA_REREAD_MS, { physics: false });
    look(api);
    expect(asks()).toBe(n + 1);
  });

  it('the server\'s "is low on Mana." line is said until the out line; a charged stone you carry is named', () => {
    host.inv.push({ guid: STONE, name: 'Mana Charge', where: 'main pack', itemType: 0x80000 });
    host.appraised.push(STONE);
    host.appraisalDatas.set(STONE, { int: { 107: 350 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    api.pushChat('Your Pathwarden Helm is low on Mana.', 0x07);
    const text = formatObservation(look(api));
    expect(text).toMatch(/gear running out of mana .*: Pathwarden Helm #80003a11 \(the server says it is low on mana: under 2 min left\); refill: ac_use_on a charged stone on it \(target= the item; target=self fills every worn piece\): Mana Charge #80003b22 \(350 mana\)/);
    api.pushChat('Your Pathwarden Helm is out of Mana.', 0x07);
    const after = formatObservation(look(api));
    expect(after).not.toMatch(/gear running out of mana/);
    expect(after).toMatch(/gear out of mana \(its spells are off\): Pathwarden Helm/);
  });
});
