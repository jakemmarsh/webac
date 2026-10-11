/**
 * VirindiTank parity §2 (docs/vtank-parity-gaps.md): buff gems, food and potions (use requirements,
 * the shared cooldown PropertyInt 280, fellowship-only spells), BuffCastRecast, FastCastBuffs,
 * caster-item recharges, UseHealersHeart and JumpOutWandCasting. Planner tests import the real
 * planners; the macro tests run the routine engine and the real agent API over the fake host with a
 * small spell table in the DAT's wording (no DAT needed).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_MODULES_OFF, PropertyDataId, PropertyFloat, PropertyInt, SkillId, emptyVtankData, type PlanItem, type PlanSkill, type RoutineProfile } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { isQuickBuff, itemCooldown, planBuffItem, rebuffThreshold, VT_GEM_FOOD_ITEMS, type BuffItemInput } from '../packages/renderer/src/agent/macro/buffItems.ts';
import { mustWield, useRequirementProblem } from '../packages/renderer/src/agent/macro/itemUse.ts';
import { buildBuffFamilies, planBuffs } from '../packages/renderer/src/agent/macro/buffPlan.ts';
import { buildRechargeFamilies, planRecharge, type RechargeInput } from '../packages/renderer/src/agent/macro/rechargePlan.ts';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');

type Row = { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number };
const SELF_BUFF = 0xc; // Beneficial | SelfTargeted
const TABLE = new Map<number, Row>([
  [1, { name: 'Strength Self I', desc: "Increases the caster's Strength by 10 points.", category: 1, school: 4, bitfield: SELF_BUFF, power: 1, duration: 1800 }],
  [2, { name: 'Endurance Self I', desc: "Increases the caster's Endurance by 10 points.", category: 2, school: 4, bitfield: SELF_BUFF, power: 1, duration: 1800 }],
  [3, { name: 'Strength Self VI', desc: "Increases the caster's Strength by 35 points.", category: 1, school: 4, bitfield: SELF_BUFF, power: 250, duration: 3600 }],
  [10, { name: 'Heal Self I', desc: "Restores 10-20 points of the caster's Health.", category: 67, school: 2, bitfield: SELF_BUFF, power: 1 }],
  [11, { name: 'Heal Self VI', desc: "Restores 50-100 points of the caster's Health.", category: 67, school: 2, bitfield: SELF_BUFF, power: 250 }],
  [12, { name: 'Heal Other VI', desc: "Restores 50-100 points of the target's Health.", category: 68, school: 2, bitfield: 0x4, power: 250 }],
  [13, { name: "Adja's Gift", desc: "Restores 80-150 points of the target's Health.", category: 68, school: 2, bitfield: 0x4, power: 400 }],
  // The gems' spells as the end-of-retail table has them: beneficial, not self-targeted, a day long.
  [3810, { name: 'Asheron’s Benediction', desc: 'Raises health by 10% for 24 hours.', category: 520, school: 4, bitfield: 0x84, power: 100, duration: 86400 }],
  [3811, { name: 'Blackmoor’s Favor', desc: 'Increases Natural Armor by 50 points for 24 hours.', category: 519, school: 2, bitfield: 0x84, power: 100, duration: 86400 }],
  [9000, { name: 'Fellowship Blessing', desc: 'A fellowship-only blessing.', category: 600, school: 4, bitfield: 0x2004, power: 100, duration: 3600 }],
]);
const SKILLS: PlanSkill[] = [
  { id: SkillId.CreatureEnchantment, name: 'Creature Enchantment', training: 'trained', base: 100, buffed: 100 },
  { id: SkillId.LifeMagic, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
  { id: 14, name: 'Arcane Lore', training: 'trained', base: 120, buffed: 120 },
];

/** An examined gem: ItemUseable Contained, its Spell data id, SharedCooldown and CooldownDuration as the world DB has them. */
const gem = (guid: number, name: string, spellId: number, extra: Record<number, number> = {}): PlanItem => ({
  guid, name, ints: { [PropertyInt.ItemUseable]: 8, [PropertyInt.SharedCooldown]: 2, ...extra }, floats: { [PropertyFloat.CooldownDuration]: 30 }, dids: { [PropertyDataId.Spell]: spellId },
});

describe('use requirements (ACE CheckUseRequirements, from the item)', () => {
  it('Arcane Lore, the item skill limit, trained / specialized skills, level, and wield requirements only for a wielded-use item', () => {
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.ItemDifficulty]: 105 } }, SKILLS)).toBeNull();
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.ItemDifficulty]: 130 } }, SKILLS)).toMatch(/Arcane Lore/);
    // The Healer's Heart: Life Magic 245 (ItemSkillLimit 37 / ItemSkillLevelLimit 115).
    const heart = { name: "The Healer's Heart", ints: { [PropertyInt.ItemSkillLevelLimit]: 245, [PropertyInt.ItemUseable]: 0x600004 }, dids: { [PropertyDataId.ItemSkillLimit]: SkillId.LifeMagic } };
    expect(useRequirementProblem(heart, SKILLS)).toMatch(/245 Life Magic/);
    expect(useRequirementProblem(heart, SKILLS.map((s) => (s.id === SkillId.LifeMagic ? { ...s, buffed: 300 } : s)))).toBeNull();
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.UseRequiresSkill]: SkillId.LifeMagic, [PropertyInt.UseRequiresSkillLevel]: 150 } }, SKILLS)).toMatch(/150 Life Magic/);
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.UseRequiresSkillSpec]: SkillId.LifeMagic } }, SKILLS)).toMatch(/specialized/);
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.UseRequiresSkill]: 999 } }, SKILLS)).toMatch(/trained/);
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.UseRequiresLevel]: 50 } }, SKILLS, 20)).toMatch(/level 50/);
    expect(useRequirementProblem({ name: 'X', ints: { [PropertyInt.UseRequiresLevel]: 50 } }, SKILLS, 60)).toBeNull();
    // Wield requirement Training (8) at Specialized (3): checked only when the item must be wielded to be used.
    const wield = { [PropertyInt.WieldRequirements]: 8, [PropertyInt.WieldSkillType]: SkillId.CreatureEnchantment, [PropertyInt.WieldDifficulty]: 3 };
    expect(useRequirementProblem({ name: 'Drum', ints: { ...wield, [PropertyInt.ItemUseable]: 0x600008 } }, SKILLS)).toBeNull();
    expect(useRequirementProblem({ name: 'Orb', ints: { ...wield, [PropertyInt.ItemUseable]: 0x600004 } }, SKILLS)).toMatch(/wield requirement/);
    expect(mustWield({ ints: { [PropertyInt.ItemUseable]: 0x600004 } })).toBe(true);
    expect(mustWield({ ints: { [PropertyInt.ItemUseable]: 0x600008 } })).toBe(false);
  });
});

describe('planBuffItem', () => {
  const base = (over: Partial<BuffItemInput> = {}): BuffItemInput => ({
    items: [gem(0x70, "Asheron's Benediction", 3810)], listed: VT_GEM_FOOD_ITEMS, spellTable: { spells: TABLE }, active: [], threshold: 300,
    skills: SKILLS, level: 100, inFellowship: false, cooldownLeft: () => 0, ...over,
  });

  it('VTank\'s default GemFoodItems: Asheron\'s Benediction is used when its spell is not on you; not while it has the rebuff time left', () => {
    expect(planBuffItem(base())?.item.guid).toBe(0x70);
    expect(planBuffItem(base({ active: [{ name: 'Asheron’s Benediction', spellId: 3810, category: 520, power: 100, remaining: 80000 }] }))).toBeNull();
    expect(planBuffItem(base({ active: [{ name: 'Asheron’s Benediction', spellId: 3810, category: 520, power: 100, remaining: 200 }] }))?.item.guid).toBe(0x70);
  });

  it('the shared cooldown (PropertyInt 280) holds every item of that cooldown; a refused item and its family wait', () => {
    expect(planBuffItem(base({ cooldownLeft: (id) => (id === 2 ? 12 : 0) }))).toBeNull();
    expect(planBuffItem(base({ heldBack: (g) => g === 0x70 }))).toBeNull();
    expect(planBuffItem(base({ heldBack: (_g, c) => c === 520 }))).toBeNull();
    expect(itemCooldown(gem(1, 'x', 3810))).toEqual({ id: 2, seconds: 30 });
  });

  it('a fellowship-only spell needs a fellowship; an unmet use requirement or an unlisted / unexamined item is skipped', () => {
    const fellow = base({ items: [gem(0x71, 'Fellow Gem', 9000)], listed: ['Fellow Gem'] });
    expect(planBuffItem(fellow)).toBeNull();
    expect(planBuffItem({ ...fellow, inFellowship: true })?.item.guid).toBe(0x71);
    expect(planBuffItem(base({ items: [gem(0x70, "Asheron's Benediction", 3810, { [PropertyInt.UseRequiresLevel]: 150 })] }))).toBeNull();
    expect(planBuffItem(base({ listed: [] }))).toBeNull();
    expect(planBuffItem(base({ items: [{ guid: 0x70, name: "Asheron's Benediction" }] }))).toBeNull();
  });

  it('a Consumables-tab potion whose spell is a buff counts; one whose spell is not a buff (a heal) does not', () => {
    expect(planBuffItem(base({ items: [gem(0x72, 'Potion of Strength', 3)], listed: ['Potion of Strength'] }))?.spellId).toBe(3);
    expect(planBuffItem(base({ items: [gem(0x73, 'Healing Elixir', 11)], listed: ['Healing Elixir'] }))).toBeNull();
  });
});

describe('BuffCastRecast and FastCastBuffs (pure parts)', () => {
  const fam = buildBuffFamilies({ spells: TABLE }, SKILLS.map((s) => [s.id, s.name] as [number, string]));
  const spells = [1, 2].map((id) => { const s = TABLE.get(id)!; return { id, name: s.name, school: 'Creature Enchantment', category: s.category, power: s.power, self: true, buff: true, duration: s.duration! }; });
  const plan = (recastExtra: number, settings: Record<string, string | number | boolean> = {}) => planBuffs({
    spells, skills: SKILLS, settings: { EnableBuffing: true, ...settings }, extraBuffs: [], blacklistedBuffs: [], idle: false, families: fam, level: 50, recastExtra,
    active: [{ name: 'Strength Self I', spellId: 1, category: 1, power: 1, remaining: 320 }, { name: 'Endurance Self I', spellId: 2, category: 2, power: 1, remaining: 1000 }],
  }).due.map((b) => b.spell.name);

  it('a buff with 320 s left is not due at 300 s; with BuffCastRecast\'s 30 s added it is', () => {
    expect(plan(0)).toEqual([]);
    expect(plan(30)).toEqual(['Strength Self I']);
  });

  it('the threshold never goes below 10 s (VTank\'s floor)', () => {
    expect(rebuffThreshold(0, false, 30)).toBe(10);
    expect(rebuffThreshold(300, true, 30)).toBe(330);
    expect(plan(0, { RebuffTimeRemainingSeconds: 0 })).toEqual([]);
  });

  it('quick buffs: difficulty under 50, a Creature or Life self buff of a minute or more, or a FastCast spell; not an item spell or a fellowship one', () => {
    expect(isQuickBuff(TABLE.get(1)!)).toBe(true);
    expect(isQuickBuff(TABLE.get(3)!)).toBe(true);
    expect(isQuickBuff({ ...TABLE.get(3)!, school: 3 })).toBe(false);
    expect(isQuickBuff({ ...TABLE.get(3)!, bitfield: SELF_BUFF | 0x2000 })).toBe(false);
    expect(isQuickBuff({ ...TABLE.get(3)!, school: 3, bitfield: 0x4004 })).toBe(true);
  });
});

describe('caster items in the recharge planner', () => {
  const FAM = buildRechargeFamilies({ spells: TABLE });
  const known = [10].map((id) => { const s = TABLE.get(id)!; return { id, name: s.name, school: 'Life Magic', category: s.category, power: s.power, self: true, buff: false, duration: 0 }; });
  const wand = (guid: number, name: string, spellId: number, useable: number, extra: Partial<PlanItem> = {}): PlanItem => ({ guid, name, itemType: 0x8000, ints: { [PropertyInt.ItemUseable]: useable }, dids: { [PropertyDataId.Spell]: spellId }, ...extra });
  const input = (over: Partial<RechargeInput> = {}): RechargeInput => ({
    vitals: { health: { cur: 20, max: 200 }, stamina: { cur: 200, max: 200 }, mana: { cur: 200, max: 200 } },
    stance: 'magic', hasTarget: true, settings: {}, spells: known, skills: SKILLS, consumables: [], rechargeFamilies: FAM, level: 100, ...over,
  });

  it('an Items-tab caster whose spell is a better heal is used on you; a known spell of the same level wins the tie', () => {
    const big = wand(0x80, 'Healing Wand', 11, 0x200008, { equipped: true });
    const r = planRecharge(input({ casterItems: [big] }));
    expect(r).toMatchObject({ kind: 'item', item: { guid: 0x80 }, wield: false });
    expect(r && 'target' in r ? r.target : undefined).toBeUndefined();
    const same = wand(0x81, 'Small Wand', 10, 0x200008, { equipped: true });
    expect(planRecharge(input({ casterItems: [same] }))).toMatchObject({ kind: 'cast', spell: { id: 10 } });
  });

  it('a caster that must be wielded is wielded first; out of magic mode the switch comes before the use; no mana or an unmet requirement: the spell', () => {
    const held = wand(0x82, 'Orb of Healing', 11, 0x200004);
    expect(planRecharge(input({ casterItems: [held] }))).toMatchObject({ kind: 'item', wield: true });
    expect(planRecharge(input({ casterItems: [{ ...held, equipped: true }], stance: 'melee' }))).toMatchObject({ kind: 'stance', to: 'magic' });
    expect(planRecharge(input({ casterItems: [{ ...held, equipped: true, ints: { ...held.ints, [PropertyInt.ItemCurMana]: 0 } }] }))).toMatchObject({ kind: 'cast', spell: { id: 10 } });
    expect(planRecharge(input({ casterItems: [{ ...held, equipped: true, ints: { ...held.ints, [PropertyInt.ItemDifficulty]: 500 } }] }))).toMatchObject({ kind: 'cast', spell: { id: 10 } });
  });

  it('UseHealersHeart: the Helper heals a hurt fellow with the best Items-tab heal-other caster first; off, it uses a spell', () => {
    const fellows = [{ guid: 0x500000aa, name: 'Bob', distance: 10, health: { cur: 10, max: 200 }, stamina: { cur: 200, max: 200 }, mana: { cur: 200, max: 200 } }];
    const heart = wand(0x90, "The Healer's Heart", 12, 0x600004, { equipped: true });
    const seed = wand(0x91, 'Legendary Seed of Mornings', 13, 0x600008);
    const full = { health: { cur: 200, max: 200 }, stamina: { cur: 200, max: 200 }, mana: { cur: 200, max: 200 } };
    const healOther = { id: 12, name: 'Heal Other VI', school: 'Life Magic', category: 68, power: 50, self: false, buff: false, duration: 0 };
    const r = planRecharge(input({ vitals: full, fellows, casterItems: [heart, seed] }));
    expect(r).toMatchObject({ kind: 'item', item: { guid: 0x91 }, target: 0x500000aa, wield: false });
    expect(planRecharge(input({ vitals: full, fellows, casterItems: [{ ...heart, equipped: false }] }))).toMatchObject({ kind: 'item', item: { guid: 0x90 }, wield: true });
    expect(planRecharge(input({ vitals: full, fellows, casterItems: [seed], spells: [...known, healOther], settings: { UseHealersHeart: false } }))).toMatchObject({ kind: 'cast', spell: { id: 12 }, target: 0x500000aa });
  });
});

describe('the macro: buff items, BuffCastRecast, FastCastBuffs, caster items and JumpOutWandCasting', () => {
  let host: FakeHost;
  let api: AgentApi;
  let keyLog: string[];
  const knownBuffs = (ids: number[]) => () => ids.map((id) => {
    const s = TABLE.get(id)!;
    return { id, name: s.name, school: s.school === 2 ? 'Life' : 'Creature', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) > 0 ? { buff: true } : {}) };
  });
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.spells = knownBuffs([10]);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: TABLE });
    (host as unknown as { skillList: () => PlanSkill[] }).skillList = () => SKILLS;
    keyLog = [];
    const key = host.key;
    host.key = (c, d) => { keyLog.push(`${c}${d ? '+' : '-'}`); key(c, d); };
    // The server's answer to a self cast (a buff then shows in the effects list).
    const cast = host.cast;
    host.cast = (sid, t) => {
      const r = cast(sid, t);
      const s = TABLE.get(sid);
      if (s && t === null) {
        api.pushChat(`You cast ${s.name} on yourself`, 7);
        if ((s.duration ?? 0) > 0) host.buffs = [...host.buffs.filter((b) => (b as { spellId?: number }).spellId !== sid), { spellId: sid, name: s.name, remaining: s.duration! } as never];
      }
      return r;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (settings: Record<string, string | number | boolean> = {}, data = emptyVtankData()): RoutineProfile => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { EnableBuffing: true, AttackDistance: 30, AutoStack: false, ...settings }, vtank: data,
  });
  const carry = (items: PlanItem[], extra: Record<number, Partial<{ where: string; itemType: number }>> = {}) => {
    host.inv = items.map((i) => ({ guid: i.guid, name: i.name, where: 'main pack', ...(i.itemType ? { itemType: i.itemType } : {}), ...(extra[i.guid] ?? {}) })) as never;
    for (const i of items) {
      host.appraisalDatas.set(i.guid, { int: i.ints ?? {}, float: i.floats ?? {}, string: {}, bool: {}, did: i.dids ?? {}, spells: [] });
      host.appraised.push(i.guid);
    }
  };

  it('uses Asheron\'s Benediction from the pack; its shared cooldown holds Blackmoor\'s Favor until it runs out', async () => {
    carry([gem(0x70000001, "Asheron's Benediction", 3810), gem(0x70000002, "Blackmoor's Favor", 3811)]);
    api.routine.start(vt());
    await step(3000);
    expect(host.sent).toContain('use 70000001');
    host.buffs = [{ spellId: 3810, name: 'Asheron’s Benediction', remaining: 86400 } as never];
    await step(20_000);
    expect(host.sent).not.toContain('use 70000002');
    await step(20_000);
    expect(host.sent).toContain('use 70000002');
    expect(host.sent.filter((x) => x === 'use 70000001')).toHaveLength(1);
  });

  it('the client\'s own cooldown (the cooldown enchantment) holds a gem; a fellowship gem waits for a fellowship; EnableBuffing off: no gems', async () => {
    (host as unknown as { cooldownRemaining: (id: number) => number }).cooldownRemaining = (id) => (id === 2 ? 600 : 0);
    carry([gem(0x70000001, "Asheron's Benediction", 3810)]);
    api.routine.start(vt());
    await step(3000);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]);
    api.routine.stop();
    (host as unknown as { cooldownRemaining: (id: number) => number }).cooldownRemaining = () => 0;
    const data = emptyVtankData();
    data.consumables = ['Fellow Gem'];
    carry([gem(0x70000003, 'Fellow Gem', 9000)]);
    api.routine.start(vt({}, data));
    await step(3000);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]);
    host.fellowInfo = { leader: false, open: true, count: 2, members: ['Claude Test', 'Bob'], handOff: true };
    await step(3000);
    expect(host.sent).toContain('use 70000003');
    api.routine.stop();
    host.sent.length = 0;
    carry([gem(0x70000001, "Asheron's Benediction", 3810)]);
    api.routine.start(vt({ EnableBuffing: false }));
    await step(3000);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]);
  });

  it('BuffCastRecast: after one buff goes out, a buff within 330 s of running out goes with it; with BuffCastRecast_Seconds 0 it waits', async () => {
    host.spells = knownBuffs([1, 2, 10]);
    host.me.combatMode = 'magic';
    host.buffs = [{ spellId: 2, name: 'Endurance Self I', remaining: 320 } as never];
    api.routine.start(vt());
    await step(4000);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual(['cast 1 self', 'cast 2 self']);
    api.routine.stop();
    host.sent.length = 0;
    host.buffs = [{ spellId: 2, name: 'Endurance Self I', remaining: 320 } as never];
    api.routine.start(vt({ BuffCastRecast_Seconds: 0 }));
    await step(4000);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual(['cast 1 self']);
  });

  it('FastCastBuffs: the character walks backwards while a quick buff is cast, and stops after; off, it stands still', async () => {
    host.spells = knownBuffs([1, 10]);
    host.me.combatMode = 'magic';
    api.routine.start(vt({ FastCastBuffs: true }));
    await step(2000);
    expect(host.sent).toContain('cast 1 self');
    expect(keyLog.slice(0, 2)).toEqual(['KeyS+', 'KeyS-']);
    expect(host.keys.has('KeyS')).toBe(false);
    api.routine.stop();
    keyLog.length = 0;
    host.buffs = [];
    host.sent.length = 0;
    api.routine.start(vt({}));
    await step(2000);
    expect(host.sent).toContain('cast 1 self');
    expect(keyLog.filter((k) => k.startsWith('KeyS'))).toEqual([]);
  });

  it('a wielded Items-tab wand with a better heal is used on you when hurt; JumpOutWandCasting jumps 0.2 s after', async () => {
    host.me.combatMode = 'magic';
    host.me.health.current = 10;
    const data = emptyVtankData();
    data.items = [{ name: 'Healing Wand' }];
    const w: PlanItem = { guid: 0x70000010, name: 'Healing Wand', itemType: 0x8000, ints: { [PropertyInt.ItemUseable]: 0x200004 }, dids: { [PropertyDataId.Spell]: 11 } };
    carry([w], { 0x70000010: { where: 'equipped' } });
    api.routine.start(vt({ EnableBuffing: false, JumpOutWandCasting: true }, data));
    await step(1500);
    expect(host.sent).toContain(`usewith 70000010 ${host.me.guid.toString(16)}`);
    expect(host.sent.some((x) => x.startsWith('cast 10'))).toBe(false);
    expect(keyLog).toContain('Space+');
  });
});

describe.skipIf(!existsSync(PORTAL))('the end-of-retail spell table (needs DAT files)', () => {
  let table: { spells: Map<number, Row> };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as { spells: Map<number, Row> };
  });

  it('the default GemFoodItems spells (3810, 3811) are day-long buffs a gem can give', () => {
    for (const id of [3810, 3811]) {
      const pick = planBuffItem({
        items: [gem(1, "Asheron's Benediction", id)], listed: VT_GEM_FOOD_ITEMS, spellTable: table, active: [], threshold: 300, skills: SKILLS, level: 100, inFellowship: false, cooldownLeft: () => 0,
      });
      expect(pick?.spell.duration).toBe(86400);
    }
  });

  it('The Healer\'s Heart\'s spell (Heal Other VI, 1166) and the Seed of Mornings\' (Adja\'s Gift, 2072) are heal-other families, Adja\'s Gift the stronger', () => {
    const fam = buildRechargeFamilies(table);
    expect(fam.bySpell.get(1166)).toMatchObject({ kind: 'heal', self: false, dest: 'health' });
    expect(fam.bySpell.get(2072)).toMatchObject({ kind: 'heal', self: false, dest: 'health' });
    expect(fam.bySpell.get(2072)!.power!).toBeGreaterThan(fam.bySpell.get(1166)!.power!);
  });
});
