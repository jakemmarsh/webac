/**
 * The macro's combat planner (packages/renderer/src/agent/macro/combatPlan.ts):
 * VirindiTank's Monsters tab as a pure decision (docs/vtank-macro-behavior.md §4).
 * Synthetic spell tables use the real anchor spell ids so buildCombatFamilies
 * runs as shipped; the DAT block checks the families against the real
 * SpellTable of each era we have locally.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VT_DAMAGE, VT_DEFAULT_MONSTER, VT_PET_AUTO, type PlanItem, type PlanSkill, type PlanSpell, type VtMonsterRow } from '@ac/shared';
import {
  ammoFor, buildCombatFamilies, matchMonsterRow, petDeviceElement, petUnusable, pickTarget, planCombat, planPet,
  type CombatElement, type CombatFamilies, type CombatInput, type CombatMonster, type CombatSpellTableEntry,
} from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { openDat } from './_harness/dat.js';

const SCHOOL_NAME: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };

// A small spell table in end-of-retail shape (ids, categories, schools, bitfield, power from the EoL DAT).
const TABLE: Array<[number, CombatSpellTableEntry]> = [
  [25, { name: 'Imperil Other I', category: 116, school: 2, bitfield: 0x13, power: 25 }],
  [26, { name: 'Imperil Self I', category: 116, school: 2, bitfield: 0x1a, power: 25 }],
  [1326, { name: 'Imperil Other V', category: 116, school: 2, bitfield: 0x13, power: 225 }],
  [1327, { name: 'Imperil Other VI', category: 116, school: 2, bitfield: 0x13, power: 275 }],
  [262, { name: 'Defenselessness Other I', category: 40, school: 4, bitfield: 0x13, power: 1 }],
  [15, { name: 'Vulnerability Other I', category: 38, school: 4, bitfield: 0x13, power: 1 }],
  [21, { name: 'Fire Vulnerability Other I', category: 110, school: 2, bitfield: 0x13, power: 25 }],
  [521, { name: 'Acid Vulnerability Other I', category: 102, school: 2, bitfield: 0x13, power: 25 }],
  [27, { name: 'Flame Bolt I', category: 121, school: 1, bitfield: 0x3, power: 1 }],
  [84, { name: 'Flame Bolt V', category: 121, school: 1, bitfield: 0x3, power: 200 }],
  [85, { name: 'Flame Bolt VI', category: 121, school: 1, bitfield: 0x3, power: 250 }],
  [2739, { name: 'Flame Arc I', category: 121, school: 1, bitfield: 0x1003, power: 1 }],
  [2743, { name: 'Flame Arc V', category: 121, school: 1, bitfield: 0x1003, power: 200 }],
  [1796, { name: 'Flame Streak I', category: 247, school: 1, bitfield: 0x4003, power: 1 }],
  [1800, { name: 'Flame Streak V', category: 247, school: 1, bitfield: 0x4003, power: 200 }],
  [1785, { name: "Cassius' Ring of Fire", category: 226, school: 1, bitfield: 0x3, power: 200 }],
  [5395, { name: 'Corruption I', category: 638, school: 5, bitfield: 0x10003, power: 1 }],
  // The non-elemental modes (EoL DAT rows): Harm Other shares category 80 with Harm Self and Martyr's Hecatomb,
  // Drain Health Other shares 87 with Health to Stamina Other, Tusker Fists shares 230 with creature walls.
  [7, { name: 'Harm Other I', category: 80, school: 2, bitfield: 0x13, power: 1 }],
  [8, { name: 'Harm Self I', category: 80, school: 2, bitfield: 0x1a, power: 15 }],
  [1176, { name: 'Harm Other VI', category: 80, school: 2, bitfield: 0x13, power: 275 }],
  [2766, { name: "Martyr's Hecatomb VII", category: 80, school: 2, bitfield: 0x3, power: 300 }],
  [1237, { name: 'Drain Health Other I', category: 87, school: 2, bitfield: 0x13, power: 38 }],
  [1242, { name: 'Drain Health Other VI', category: 87, school: 2, bitfield: 0x13, power: 288 }],
  [1266, { name: 'Health to Stamina Other I', category: 87, school: 2, bitfield: 0x82, power: 1 }],
  [2934, { name: 'Tusker Fists', category: 230, school: 1, bitfield: 0x83, power: 325 }],
  [1845, { name: 'Hammering Crawler', category: 230, school: 1, bitfield: 0x3, power: 200 }],
  [58, { name: 'Acid Stream I', category: 117, school: 1, bitfield: 0x3, power: 1 }],
];
const FAMILIES: CombatFamilies = buildCombatFamilies({ spells: new Map(TABLE) });
const spell = (id: number): PlanSpell => {
  const s = new Map(TABLE).get(id)!;
  return { id, name: s.name, school: SCHOOL_NAME[s.school], category: s.category, power: s.power, self: (s.bitfield & 0x8) !== 0, buff: false, duration: s.category === 121 ? 0 : 60 };
};
const skill = (id: number, name: string, buffed: number, training: PlanSkill['training'] = 'specialized'): PlanSkill => ({ id, name, training, base: buffed, buffed });
const SKILLS = [skill(33, 'Life Magic', 400), skill(31, 'Creature Enchantment', 400), skill(34, 'War Magic', 400), skill(43, 'Void Magic', 400)];
const WAND: PlanItem = { guid: 900, name: 'Fire Wand', itemType: 0x8000, ints: { 45: 0x10 } };
const SWORD: PlanItem = { guid: 901, name: 'Iron Sword', itemType: 0x1, ints: { 45: 0x1 } };
const row = (name: string, extra: Partial<VtMonsterRow> = {}): VtMonsterRow => ({ ...structuredClone(VT_DEFAULT_MONSTER), name, ...extra });
const mon = (guid: number, name: string, dist: number, relBearing = 0, extra: Partial<CombatMonster> = {}): CombatMonster => ({ guid, name, dist, relBearing, ...extra });

function input(over: Partial<CombatInput> = {}): CombatInput {
  return {
    monsters: [mon(1, 'Drudge Skulker', 3)],
    rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Fire })],
    spells: [spell(84), spell(85), spell(27)],
    skills: SKILLS,
    items: [{ ...WAND, equipped: true }],
    itemNames: ['Fire Wand'],
    wielded: { weapon: 'Fire Wand' },
    stance: 'magic',
    settings: { AttackDistance: 30 },
    castLog: [],
    now: 100_000,
    selectedGuid: null,
    families: FAMILIES,
    ...over,
  };
}

describe('matchMonsterRow (Monster List Matching)', () => {
  const rows = [
    row('<DEFAULT>'),
    row('Drudge Skulker', { priority: 3 }),
    row('range<5 && name#^mosswart', { expr: true, priority: 4 }),
    row('setting_TargetLock==1', { expr: true, priority: 2 }),
    row('maxhp>100', { expr: true, priority: 0 }),
  ];
  it('falls back to <DEFAULT>, matches names case-insensitively, top-down after DEFAULT', () => {
    expect(matchMonsterRow(rows, mon(1, 'Banderling Scout', 10)).name).toBe('<DEFAULT>');
    expect(matchMonsterRow(rows, mon(1, 'drudge skulker', 10)).priority).toBe(3);
  });
  it('evaluates expressions over range, name (regex) and settings', () => {
    expect(matchMonsterRow(rows, mon(1, 'Mosswart Worshipper', 4)).priority).toBe(4);
    expect(matchMonsterRow(rows, mon(1, 'Mosswart Worshipper', 6)).name).toBe('<DEFAULT>');
    expect(matchMonsterRow(rows, mon(1, 'Golem', 6), { settings: { TargetLock: true } }).priority).toBe(2);
  });
  it('an unknown variable or a broken expression does not match', () => {
    expect(matchMonsterRow([row('<DEFAULT>'), row('maxhp>100', { expr: true, priority: 0 })], mon(1, 'Golem', 6)).name).toBe('<DEFAULT>');
    expect(matchMonsterRow([row('<DEFAULT>'), row('(range<5', { expr: true, priority: 0 })], mon(1, 'Golem', 1)).name).toBe('<DEFAULT>');
    expect(matchMonsterRow([row('<DEFAULT>'), row('(range+1)*2==6', { expr: true, priority: 0 })], mon(1, 'Golem', 2)).priority).toBe(0);
  });
});

describe('pickTarget', () => {
  it('stays within AttackDistance, ignores priority -1, higher priority first', () => {
    const rows = [row('<DEFAULT>'), row('Ignored', { priority: -1 }), row('Boss', { priority: 4 })];
    const i = input({ rows, monsters: [mon(1, 'Ignored', 1), mon(2, 'Rat', 2), mon(3, 'Boss', 20), mon(4, 'Boss', 40)] });
    expect(pickTarget(i)?.guid).toBe(3);
    expect(pickTarget({ ...i, monsters: [mon(1, 'Ignored', 1), mon(4, 'Boss', 40)] })).toBeNull();
  });
  it('TargetSelectMethod: by range, by angle, and Both (near by angle, far by range)', () => {
    const ms = [mon(1, 'A', 10, 5), mon(2, 'B', 4, 90), mon(3, 'C', 3, 120), mon(4, 'D', 12, 1)];
    expect(pickTarget(input({ monsters: ms, settings: { AttackDistance: 30, TargetSelectMethod: 1 } }))?.guid).toBe(3);
    expect(pickTarget(input({ monsters: ms, settings: { AttackDistance: 30, TargetSelectMethod: 2 } }))?.guid).toBe(4);
    // Both, angle range 5: B and C are near; B needs the smaller turn.
    expect(pickTarget(input({ monsters: ms, settings: { AttackDistance: 30, TargetSelectMethod: 3 } }))?.guid).toBe(2);
    // Nothing near: farther ones go by distance.
    expect(pickTarget(input({ monsters: [ms[0], ms[3]], settings: { AttackDistance: 30 } }))?.guid).toBe(1);
  });
  it('TargetLock keeps the selected monster unless a higher priority one is present', () => {
    const rows = [row('<DEFAULT>'), row('Boss', { priority: 4 })];
    const ms = [mon(1, 'Rat', 2), mon(2, 'Rat', 9)];
    expect(pickTarget(input({ rows, monsters: ms, selectedGuid: 2, settings: { AttackDistance: 30 } }))?.guid).toBe(1);
    expect(pickTarget(input({ rows, monsters: ms, selectedGuid: 2, settings: { AttackDistance: 30, TargetLock: true } }))?.guid).toBe(2);
    expect(pickTarget(input({ rows, monsters: [...ms, mon(3, 'Boss', 20)], selectedGuid: 2, settings: { AttackDistance: 30, TargetLock: true } }))?.guid).toBe(3);
  });
});

describe('target tie-breaks (VTank, MOSS CombatTargetSelection)', () => {
  const rows = [row('<DEFAULT>', { on: ['I', 'A'], damage: VT_DAMAGE.Fire })];
  const spells = [spell(1327), spell(21), spell(84)];
  // A sword in hand: Imperil is the weapon's debuff (with a wand it would be Magic Yield).
  const sword = { items: [{ ...SWORD, equipped: true }], itemNames: ['Iron Sword'], wielded: { weapon: 'Iron Sword' }, stance: 'melee' as const };
  it('urgency: one already Imperiled (+2) beats a nearer one; the attack element\'s vuln adds 1', () => {
    const ms = [mon(1, 'Rat', 2), mon(2, 'Rat', 8), mon(3, 'Rat', 9)];
    const base = input({ rows, monsters: ms, spells, ...sword, settings: { AttackDistance: 30, TargetSelectMethod: 1 } });
    expect(pickTarget(base)?.guid).toBe(1);
    const imperiled = { ...base, castLog: [{ guid: 2, category: 116, at: base.now, duration: 60 }] };
    expect(pickTarget(imperiled)?.guid).toBe(2);
    // Imperil (+2) on 2, Imperil and the fire vuln (+3) on 3: 3.
    expect(pickTarget({ ...imperiled, castLog: [...imperiled.castLog, { guid: 3, category: 116, at: base.now, duration: 60 }, { guid: 3, category: 110, at: base.now, duration: 60 }] })?.guid).toBe(3);
    // Magic (a wand): Magic Yield counts, not Imperil. This table has no Yield, so Imperil adds nothing and the nearest wins.
    expect(pickTarget({ ...imperiled, items: [{ ...WAND, equipped: true }], itemNames: ['Fire Wand'], wielded: { weapon: 'Fire Wand' } })?.guid).toBe(1);
  });
  it('the sticky last target: among equals, the one the last combat action went to', () => {
    const ms = [mon(1, 'Rat', 2), mon(2, 'Rat', 8)];
    const base = input({ rows, monsters: ms, spells, ...sword, settings: { AttackDistance: 30, TargetSelectMethod: 1 } });
    expect(pickTarget({ ...base, lastTarget: 2 })?.guid).toBe(2);
    // Urgency and TargetLock come before it.
    expect(pickTarget({ ...base, lastTarget: 2, castLog: [{ guid: 1, category: 116, at: base.now, duration: 60 }] })?.guid).toBe(1);
    expect(pickTarget({ ...base, lastTarget: 2, selectedGuid: 1, settings: { ...base.settings, TargetLock: true } })?.guid).toBe(1);
  });
  it('DebuffEachFirst Priority: within a priority, one that needs a debuff first; One: no such tie-break', () => {
    const ms = [mon(1, 'Rat', 2), mon(2, 'Rat', 8)];
    const base = input({ rows, monsters: ms, spells, ...sword, castLog: [{ guid: 1, category: 116, at: 100_000, duration: 60 }], settings: { AttackDistance: 30, TargetSelectMethod: 1, DebuffEachFirst: 2 } });
    // Rat 1 has Imperil (urgency 2) but Rat 2 needs it: the debuff tie-break comes before urgency.
    expect(pickTarget(base)?.guid).toBe(2);
    expect(pickTarget({ ...base, settings: { ...base.settings, DebuffEachFirst: 1 } })?.guid).toBe(1);
  });
  it('fewer weapon swaps, but only with Both and both within TargetSelectAngleRange', () => {
    const swordRow = row('Rat', { on: ['A'], weapon: 'Iron Sword' });
    const items = [{ ...WAND, equipped: true }, SWORD];
    const ms = [mon(1, 'Rat', 2, 10), mon(2, 'Drudge', 3, 40)];
    const base = input({ rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Fire }), swordRow], monsters: ms, items, itemNames: ['Fire Wand', 'Iron Sword'] });
    // Both (default), both within 5 m: the Drudge (keeps the wand) beats the Rat (needs the sword) despite the bigger turn.
    expect(pickTarget(base)?.guid).toBe(2);
    // By Angle: no swap rule, the smaller turn wins.
    expect(pickTarget({ ...base, settings: { AttackDistance: 30, TargetSelectMethod: 2 } })?.guid).toBe(1);
  });
  it('By Range breaks a distance tie by the smaller turn; By Angle a turn tie by distance', () => {
    const ms = [mon(1, 'A', 6, 50), mon(2, 'B', 6, 10), mon(3, 'C', 9, 10)];
    expect(pickTarget(input({ monsters: ms, settings: { AttackDistance: 30, TargetSelectMethod: 1 } }))?.guid).toBe(2);
    expect(pickTarget(input({ monsters: ms, settings: { AttackDistance: 30, TargetSelectMethod: 2 } }))?.guid).toBe(2);
  });
  it('a debuff-only monster with its debuffs on is no target: the next monster\'s debuffs go out', () => {
    const debuffOnly = [row('<DEFAULT>', { on: ['I'] })];
    const ms = [mon(1, 'Rat', 2), mon(2, 'Rat', 8)];
    const i = input({ rows: debuffOnly, monsters: ms, spells, castLog: [{ guid: 1, category: 116, at: 100_000, duration: 60 }] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 1327 }, target: 2 });
    expect(planCombat({ ...i, castLog: [...i.castLog, { guid: 2, category: 116, at: 100_000, duration: 60 }] })).toBeNull();
  });
});

describe('debuffs within spell range minus SpellRangeFudge', () => {
  const rows = [row('<DEFAULT>', { on: ['I', 'A'], damage: VT_DAMAGE.Fire })];
  const ranged = (id: number, range: number): PlanSpell => ({ ...spell(id), range });
  it('a debuff that doesn\'t reach (range − fudge < distance) is skipped; the attack goes out', () => {
    const i = input({ rows, monsters: [mon(1, 'Rat', 19.5)], spells: [ranged(1327, 20), spell(84)] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 84 } }); // 20 − 1 < 19.5
    expect(planCombat({ ...i, settings: { AttackDistance: 30, SpellRangeFudge: 0 } })).toMatchObject({ kind: 'cast', spell: { id: 1327 } });
    expect(planCombat({ ...i, monsters: [mon(1, 'Rat', 19)] })).toMatchObject({ kind: 'cast', spell: { id: 1327 } });
  });
  it('a lower level that reaches is cast instead; a range not known is not held back; attacks never check it', () => {
    const i = input({ rows, monsters: [mon(1, 'Rat', 15)], spells: [ranged(1327, 10), ranged(1326, 30), { ...spell(84), range: 5 }] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 1326 } });
    expect(planCombat({ ...i, spells: [spell(1327), spell(84)] })).toMatchObject({ kind: 'cast', spell: { id: 1327 } });
    const on = { ...i, castLog: [{ guid: 1, category: 116, at: i.now, duration: 60 }] };
    expect(planCombat(on)).toMatchObject({ kind: 'cast', spell: { id: 84 } });
  });
});

describe('planCombat: debuffs', () => {
  const debuffRows = [row('<DEFAULT>', { on: ['I', 'B', 'V', 'A'], damage: VT_DAMAGE.Fire })];
  const known = [spell(25), spell(1326), spell(1327), spell(262), spell(21), spell(84)];
  it('casts the row\'s debuffs in column order (B before I before V), then attacks', () => {
    let i = input({ rows: debuffRows, spells: known });
    const a1 = planCombat(i);
    expect(a1).toMatchObject({ kind: 'cast', target: 1 });
    expect(a1?.kind === 'cast' && a1.spell.id).toBe(262);
    i = { ...i, castLog: [{ guid: 1, category: 40, at: i.now, duration: 60 }] };
    const a2 = planCombat(i);
    expect(a2?.kind === 'cast' && a2.spell.id).toBe(1327);
    i = { ...i, castLog: [...i.castLog, { guid: 1, category: 116, at: i.now, duration: 60 }] };
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 21 } });
    i = { ...i, castLog: [...i.castLog, { guid: 1, category: 110, at: i.now, duration: 60 }] };
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 84 }, why: expect.stringContaining('bolt') });
  });
  it('recasts a debuff with ≤ DebuffPrecastSeconds left; a DoT only once it has run out', () => {
    const rows = [row('<DEFAULT>', { on: ['I', 'Cp'] })];
    const spells = [spell(1327), spell(5395)];
    const at = (secsAgo: number) => 100_000 - secsAgo * 1000;
    const i = input({ rows, spells });
    // Imperil with 6 s left: fine (precast 5). Corruption still ticking: fine.
    const ok = { ...i, castLog: [{ guid: 1, category: 116, at: at(54), duration: 60 }, { guid: 1, category: 638, at: at(58), duration: 60 }] };
    expect(planCombat(ok)).toBeNull(); // A off: debuff only
    // Imperil with 4 s left: recast.
    const low = { ...i, castLog: [{ guid: 1, category: 116, at: at(56), duration: 60 }, { guid: 1, category: 638, at: at(59), duration: 60 }] };
    expect(planCombat(low)).toMatchObject({ kind: 'cast', spell: { id: 1327 } });
    // The DoT expired: recast.
    const gone = { ...i, castLog: [{ guid: 1, category: 116, at: at(10), duration: 60 }, { guid: 1, category: 638, at: at(61), duration: 60 }] };
    expect(planCombat(gone)).toMatchObject({ kind: 'cast', spell: { id: 5395 } });
  });
  it('DebuffEachFirst: One debuffs the target then attacks; Priority every same-priority monster; All everything', () => {
    const rows = [row('<DEFAULT>', { on: ['I', 'A'], damage: VT_DAMAGE.Fire }), row('Boss', { on: ['I', 'A'], damage: VT_DAMAGE.Fire, priority: 3 })];
    const monsters = [mon(1, 'Rat', 2), mon(2, 'Rat', 5), mon(3, 'Boss', 10)];
    const base = input({ rows, monsters, spells: [spell(1327), spell(84)], castLog: [{ guid: 3, category: 116, at: 100_000, duration: 60 }] });
    expect(planCombat({ ...base, settings: { AttackDistance: 30, DebuffEachFirst: 1 } })).toMatchObject({ kind: 'cast', spell: { id: 84 }, target: 3 });
    expect(planCombat({ ...base, settings: { AttackDistance: 30, DebuffEachFirst: 2 } })).toMatchObject({ kind: 'cast', spell: { id: 84 }, target: 3 });
    expect(planCombat({ ...base, settings: { AttackDistance: 30, DebuffEachFirst: 3 } })).toMatchObject({ kind: 'cast', spell: { id: 1327 }, target: 1 });
    const twoBosses = { ...base, monsters: [...monsters, mon(4, 'Boss', 12)] };
    expect(planCombat({ ...twoBosses, settings: { AttackDistance: 30, DebuffEachFirst: 2 } })).toMatchObject({ kind: 'cast', spell: { id: 1327 }, target: 4 });
  });
  it('Ex. Vuln adds an element vuln; Auto damage takes the weapon\'s element', () => {
    const rows = [row('<DEFAULT>', { on: ['V'], damage: VT_DAMAGE.Auto, exVuln: VT_DAMAGE.Acid })];
    const i = input({ rows, spells: [spell(21), spell(521)] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 21 } }); // wand DamageType fire
    expect(planCombat({ ...i, castLog: [{ guid: 1, category: 110, at: i.now, duration: 60 }] })).toMatchObject({ kind: 'cast', spell: { id: 521 }, why: expect.stringContaining('Ex. Vuln') });
  });
  it('a column whose family the era lacks casts nothing', () => {
    const fams = buildCombatFamilies({ spells: new Map(TABLE.filter(([id]) => id < 1000)) }); // no streaks, rings, arcs, void
    expect(fams.debuff.Cp).toBeUndefined();
    expect(fams.attack.fire?.streak).toBeUndefined();
    const i = input({ families: fams, rows: [row('<DEFAULT>', { on: ['Cp', 'A', 'S'], damage: VT_DAMAGE.Fire })], spells: [spell(5395), spell(84), spell(1800)] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 84 } });
  });
  it('asks for magic stance before casting', () => {
    const i = input({ rows: [row('<DEFAULT>', { on: ['I'] })], spells: [spell(1327)], stance: 'melee' });
    expect(planCombat(i)).toMatchObject({ kind: 'stance', to: 'magic' });
  });
});

describe('planCombat: spell level by buffed skill + SpellDiffExcessThreshold-Hunt', () => {
  const at = (warBuffed: number, threshold?: number) => planCombat(input({
    skills: [skill(34, 'War Magic', warBuffed)],
    settings: threshold === undefined ? { AttackDistance: 30 } : { AttackDistance: 30, 'SpellDiffExcessThreshold-Hunt': threshold },
  }));
  it('casts the highest level whose difficulty + threshold ≤ buffed skill', () => {
    expect(at(275)).toMatchObject({ spell: { id: 85 } }); // 250 + 25
    expect(at(274)).toMatchObject({ spell: { id: 84 } }); // 200 + 25 ≤ 274 < 275
    expect(at(274, 0)).toMatchObject({ spell: { id: 85 } });
    expect(at(30)).toMatchObject({ spell: { id: 27 } }); // 1 + 25
  });
  it('untrained magic casts nothing; a caster with nothing castable does nothing', () => {
    expect(planCombat(input({ skills: [skill(34, 'War Magic', 400, 'untrained')] }))).toBeNull();
  });
});

describe('planCombat: DebuffSelectionMethod (1 Spell Level, 2 Skill = default)', () => {
  const rows = [row('<DEFAULT>', { on: ['I'] })];
  const spells = [spell(25), spell(1326), spell(1327)];
  const at = (method?: number) => planCombat(input({ rows, spells, skills: [skill(33, 'Life Magic', 200)], settings: method === undefined ? { AttackDistance: 30 } : { AttackDistance: 30, DebuffSelectionMethod: method } }));
  it('Skill (default): the level your buffed skill casts (difficulty + SpellDiffExcessThreshold-Hunt ≤ skill)', () => {
    expect(at()).toMatchObject({ spell: { id: 25 } }); // V needs 225 + 25 > 200
    expect(at(2)).toMatchObject({ spell: { id: 25 } });
  });
  it('Spell Level: the highest level you know, whatever your skill; untrained schools still cast nothing', () => {
    expect(at(1)).toMatchObject({ spell: { id: 1327 } });
    expect(planCombat(input({ rows, spells, skills: [skill(33, 'Life Magic', 400, 'untrained')], settings: { AttackDistance: 30, DebuffSelectionMethod: 1 } }))).toBeNull();
  });
  it('attacks keep the skill rule under Spell Level', () => {
    expect(planCombat(input({ skills: [skill(34, 'War Magic', 230)], settings: { AttackDistance: 30, DebuffSelectionMethod: 1 } }))).toMatchObject({ spell: { id: 84 } });
  });
});

describe('planCombat: Harm, Drain Auto, Random, Fists', () => {
  it('builds the Harm / Drain / Fists families from the table, leaving out Martyr\'s, self and vital-moving spells', () => {
    expect([...FAMILIES.harm!.ids].sort((a, b) => a - b)).toEqual([7, 1176]);
    expect([...FAMILIES.drain!.ids].sort((a, b) => a - b)).toEqual([1237, 1242]);
    expect([...FAMILIES.fists!.ids]).toEqual([2934]);
    expect(buildCombatFamilies({ spells: new Map(TABLE.filter(([id]) => id !== 2934)) }).fists).toBeUndefined();
  });
  it('Harm casts the best Harm Other; V casts no element vuln for it', () => {
    const rows = [row('<DEFAULT>', { on: ['V', 'A'], damage: VT_DAMAGE.Harm })];
    expect(planCombat(input({ rows, spells: [spell(7), spell(1176), spell(2766), spell(21)] }))).toMatchObject({ kind: 'cast', spell: { id: 1176 }, why: expect.stringContaining('harm') });
    // Without Life Magic: nothing to cast with a wand.
    expect(planCombat(input({ rows, spells: [spell(1176)], skills: [skill(34, 'War Magic', 400)] }))).toBeNull();
  });
  it('Drain Auto never casts Harm (VTank\'s plan is drains and martyrs); before the era\'s drain table loads, the best drain', () => {
    const rows = [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.DrainAuto })];
    const spells = [spell(1176), spell(1242), spell(1266)];
    expect(planCombat(input({ rows, spells }))).toMatchObject({ spell: { id: 1242 } });
    // Before 2026-10-11 a target below half health got Harm Other (our guess): VTank's Drain Auto has no Harm.
    expect(planCombat(input({ rows, spells, monsters: [mon(1, 'Rat', 3, 0, { health: 0.3 })] }))).toMatchObject({ spell: { id: 1242 } });
    // A monster immune to drains (the era's table) is not drained.
    expect(planCombat(input({ rows, spells, monsterFacts: () => ({ weak: [], maxHealth: 100, drainImmune: true }) }))).toBeNull();
  });
  it('Auto with neither War nor Void Magic trained is Drain Auto (FAQ)', () => {
    const rows = [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Auto })];
    const lifeOnly = [skill(33, 'Life Magic', 400), skill(34, 'War Magic', 0, 'untrained')];
    expect(planCombat(input({ rows, spells: [spell(1242), spell(85)], skills: lifeOnly }))).toMatchObject({ spell: { id: 1242 } });
    // War trained: Auto stays a war bolt.
    expect(planCombat(input({ rows, spells: [spell(1242), spell(85)] }))).toMatchObject({ spell: { id: 85 } });
  });
  it('Random picks one element per decision among the bolts you can cast; V and the attack agree', () => {
    const rows = [row('<DEFAULT>', { on: ['V', 'A'], damage: VT_DAMAGE.Random })];
    const spells = [spell(58), spell(85), spell(21), spell(521)];
    expect(planCombat(input({ rows, spells, random: () => 0 }))).toMatchObject({ spell: { id: 521 } }); // acid vuln
    expect(planCombat(input({ rows, spells, random: () => 0.99 }))).toMatchObject({ spell: { id: 21 } }); // fire vuln
    const vulned = (cat: number) => [{ guid: 1, category: cat, at: 100_000, duration: 60 }];
    expect(planCombat(input({ rows, spells, random: () => 0, castLog: vulned(102) }))).toMatchObject({ spell: { id: 58 } });
    expect(planCombat(input({ rows, spells, random: () => 0.99, castLog: vulned(110) }))).toMatchObject({ spell: { id: 85 } });
  });
  it('Fists casts Tusker Fists at the target; an era without it (1999) casts nothing', () => {
    const rows = [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Fists })];
    expect(planCombat(input({ rows, spells: [spell(2934), spell(85)] }))).toMatchObject({ kind: 'cast', spell: { id: 2934 }, target: 1 });
    const no = buildCombatFamilies({ spells: new Map(TABLE.filter(([id]) => id !== 2934)) });
    expect(planCombat(input({ rows, families: no, spells: [spell(85)] }))).toBeNull();
  });
});

describe('planPet: Summon Pets and the PetDmg column', () => {
  const ess = (guid: number, name: string, uiEffects: number): PlanItem => ({ guid, name, uiEffects, ints: { 266: 49052 } });
  const ACID = ess(700, 'Acid Grievver Essence (50)', 0x100);
  const FIRE = ess(701, 'Fire Grievver Essence (50)', 0x20);
  const GOLEM = ess(702, 'Mud Golem Essence', 0x1);
  const devices = [GOLEM, ACID, FIRE];
  const pet = (over: Partial<CombatInput>, range = 30, min = 1, d = devices) => planPet(input(over), { range, minMonsters: min, devices: d });
  it('reads an essence\'s element from its UiEffects (the golem shows only Magical)', () => {
    expect([petDeviceElement(ACID), petDeviceElement(FIRE), petDeviceElement(GOLEM)]).toEqual(['acid', 'fire', null]);
  });
  // Ranking (MOSS PetAutomation.Rank): a named PetDmg element, then your attack's element, then the monster's weak
  // elements in order; PAuto: your attack's element, then its weak elements; Auto: its weak elements. Any usable
  // essence can win; a tie goes to the first on the tab unless a later one needs a higher level.
  const weakFireFirst = () => ({ weak: ['fire', 'acid'] as CombatElement[], maxHealth: 50 });
  it('PAuto: the element your own Dmg type resolves to first, then the monster\'s weak elements', () => {
    expect(pet({ rows: [row('<DEFAULT>', { damage: VT_DAMAGE.Fire })] })?.device.name).toBe(FIRE.name);
    expect(pet({ rows: [row('<DEFAULT>', { damage: VT_DAMAGE.Acid })] })?.device.name).toBe(ACID.name);
    // Slash has no essence: the monster's weak elements decide (fire first); with nothing known, the first on the tab.
    expect(pet({ rows: [row('<DEFAULT>', { damage: VT_DAMAGE.Slash })], monsterFacts: weakFireFirst })?.device.name).toBe(FIRE.name);
    expect(pet({ rows: [row('<DEFAULT>', { damage: VT_DAMAGE.Slash })] })?.device.name).toBe(GOLEM.name);
  });
  it('Auto ranks by the monster\'s weak elements; a named element first, else any usable one; None monsters don\'t count', () => {
    expect(pet({ rows: [row('<DEFAULT>', { damage: VT_DAMAGE.Acid, petDamage: VT_DAMAGE.Auto })], monsterFacts: weakFireFirst })?.device.name).toBe(FIRE.name);
    expect(pet({ rows: [row('<DEFAULT>', { petDamage: VT_DAMAGE.Acid })] })?.device.name).toBe(ACID.name);
    // No cold essence: the one matching your attack's element (the fire wand) comes next. Before 2026-10-11: no pet.
    expect(pet({ rows: [row('<DEFAULT>', { petDamage: VT_DAMAGE.Cold })] })?.device.name).toBe(FIRE.name);
    expect(pet({ rows: [row('<DEFAULT>', { petDamage: VT_DAMAGE.None })] })).toBeNull();
  });
  it('the pet is for the nearest monster that also outranks every nearer one; Pet Min. Monsters counts only those in range', () => {
    const rows = [row('<DEFAULT>', { petDamage: VT_DAMAGE.Fire }), row('Boss', { priority: 3, petDamage: VT_DAMAGE.Acid })];
    // The nearer Rat holds the pick; the Boss is farther, so it can't take it (MOSS: "nearer AND ranked higher").
    expect(pet({ rows, monsters: [mon(1, 'Rat', 3), mon(2, 'Boss', 20), mon(3, 'Rat', 45)] }, 30)?.device.name).toBe(FIRE.name);
    // Seen in the other order, the nearer Boss outranks the Rat that held it.
    expect(pet({ rows, monsters: [mon(1, 'Rat', 20), mon(2, 'Boss', 3)] }, 30)?.device.name).toBe(ACID.name);
    const monsters = [mon(1, 'Rat', 3), mon(2, 'Boss', 20), mon(3, 'Rat', 45)];
    expect(pet({ rows, monsters }, 30, 3)).toBeNull();
    // A Custom Pet Range past Monster Range (AttackDistance 30) sees the far one too.
    expect(pet({ rows, monsters }, 50, 3)?.count).toBe(3);
  });
  it('only a usable essence: level and Summoning requirements, charges left, your Summoning Mastery (MOSS IsUsable)', () => {
    const rows = [row('<DEFAULT>', { damage: VT_DAMAGE.Fire })];
    const needs = (extra: Record<number, number>): PlanItem => ({ ...FIRE, ints: { ...FIRE.ints, ...extra } });
    // UseRequiresLevel 369 above yours, Structure 92 at 0, SummoningMastery 362 not yours: the acid one instead.
    for (const bad of [needs({ 369: 50 }), needs({ 92: 0 }), needs({ 362: 2 })]) {
      expect(planPet(input({ rows }), { range: 30, minMonsters: 1, devices: [bad, ACID], level: 20, mastery: 1 })?.device.name).toBe(ACID.name);
    }
    // UseRequiresSkillLevel 367 of UseRequiresSkill 366 (Summoning 54) beyond yours.
    const skilled = needs({ 366: 54, 367: 300 });
    expect(petUnusable(skilled, [...SKILLS, skill(54, 'Summoning', 250)])).toMatch(/needs 300 Summoning/);
    expect(petUnusable(skilled, [...SKILLS, skill(54, 'Summoning', 300)])).toBeNull();
    // A tie goes to the essence that needs the higher level.
    const low = { ...FIRE, guid: 710, ints: { 266: 1, 369: 50 } }, high = { ...FIRE, guid: 711, ints: { 266: 1, 369: 180 } };
    expect(planPet(input({ rows }), { range: 30, minMonsters: 1, devices: [low, high], level: 200 })?.device.guid).toBe(711);
  });
  it('no pet device, no summon; the default row is PAuto', () => {
    expect(VT_DEFAULT_MONSTER.petDamage).toBe(VT_PET_AUTO);
    expect(pet({}, 30, 1, [])).toBeNull();
  });
});

describe('planCombat: ring vs bolt vs streak vs arc', () => {
  const spells = [spell(85), spell(2743), spell(1800), spell(1785)];
  const many = [mon(1, 'Rat', 2), mon(2, 'Rat', 3), mon(3, 'Rat', 4), mon(4, 'Rat', 4.5), mon(5, 'Rat', 20)];
  it('A+R rings when ≥ MinimumRingTargets are within RingDistance, else bolts', () => {
    const rows = [row('<DEFAULT>', { on: ['A', 'R'], damage: VT_DAMAGE.Fire })];
    expect(planCombat(input({ rows, spells, monsters: many }))).toMatchObject({ spell: { id: 1785 } });
    expect(planCombat(input({ rows, spells, monsters: many.slice(1) }))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(input({ rows, spells, monsters: many.slice(1), settings: { AttackDistance: 30, MinimumRingTargets: 3 } }))).toMatchObject({ spell: { id: 1785 } });
  });
  it('R only rings when any R monster is in ring range, else wars on a target outside it', () => {
    const rows = [row('<DEFAULT>', { on: ['R'], damage: VT_DAMAGE.Fire })];
    expect(planCombat(input({ rows, spells, monsters: [mon(1, 'Rat', 3)] }))).toMatchObject({ spell: { id: 1785 } });
    expect(planCombat(input({ rows, spells, monsters: [mon(1, 'Rat', 12)] }))).toMatchObject({ spell: { id: 85 } });
  });
  it('S alone streaks (A with S streaks only to finish: verify-macro-monster-table.ts); UseArcs Yes / At Range picks the arc when it is at the best level', () => {
    expect(planCombat(input({ rows: [row('<DEFAULT>', { on: ['S'], damage: VT_DAMAGE.Fire })], spells }))).toMatchObject({ spell: { id: 1800 } });
    // A with S on a monster nothing is known about: no finisher, so the bolt (before 2026-10-11 it streaked every time).
    expect(planCombat(input({ rows: [row('<DEFAULT>', { on: ['A', 'S'], damage: VT_DAMAGE.Fire })], spells }))).toMatchObject({ spell: { id: 85 } });
    const rows = [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Fire })];
    // Bolt VI (250) beats Arc V (200): bolt even with UseArcs Yes.
    expect(planCombat(input({ rows, spells, settings: { AttackDistance: 30, UseArcs: 3 } }))).toMatchObject({ spell: { id: 85 } });
    const arcsLevel = [spell(84), spell(2743)];
    expect(planCombat(input({ rows, spells: arcsLevel, settings: { AttackDistance: 30, UseArcs: 3 } }))).toMatchObject({ spell: { id: 2743 } });
    expect(planCombat(input({ rows, spells: arcsLevel, settings: { AttackDistance: 30, UseArcs: 2, ArcRange: 5 } }))).toMatchObject({ spell: { id: 84 } }); // target at 3 m
    expect(planCombat(input({ rows, spells: arcsLevel, monsters: [mon(1, 'Rat', 8)], settings: { AttackDistance: 30, UseArcs: 2, ArcRange: 5 } }))).toMatchObject({ spell: { id: 2743 } });
    expect(planCombat(input({ rows, spells: arcsLevel }))).toMatchObject({ spell: { id: 84 } }); // UseArcs default No
  });
});

describe('planCombat: weapons', () => {
  it('equips the row\'s weapon, then takes its stance and attacks', () => {
    const rows = [row('<DEFAULT>', { on: ['A'], weapon: 'Iron Sword' })];
    const items = [{ ...WAND, equipped: true }, SWORD];
    const i = input({ rows, items, itemNames: ['Fire Wand', 'Iron Sword'] });
    expect(planCombat(i)).toMatchObject({ kind: 'equip', item: { name: 'Iron Sword' } });
    const armed = { ...i, items: [WAND, { ...SWORD, equipped: true }], wielded: { weapon: 'Iron Sword' } };
    expect(planCombat(armed)).toMatchObject({ kind: 'stance', to: 'melee' });
    expect(planCombat({ ...armed, stance: 'melee' })).toMatchObject({ kind: 'attack', target: 1 });
  });
  it('does not switch to the wand for debuffs unless SwitchWandsToDebuff', () => {
    const rows = [row('<DEFAULT>', { on: ['I', 'A'], weapon: 'Fire Wand', damage: VT_DAMAGE.Fire })];
    const i = input({ rows, items: [WAND, { ...SWORD, equipped: true }], wielded: { weapon: 'Iron Sword' }, spells: [spell(1327), spell(85)] });
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 1327 } });
    expect(planCombat({ ...i, settings: { AttackDistance: 30, SwitchWandsToDebuff: true } })).toMatchObject({ kind: 'equip', item: { name: 'Fire Wand' } });
    expect(planCombat({ ...i, castLog: [{ guid: 1, category: 116, at: i.now, duration: 60 }] })).toMatchObject({ kind: 'equip', item: { name: 'Fire Wand' } });
  });
});

// ─── The real spell tables ──────────────────────────────────────────────────

const REPO = resolve(__dirname, '..');
const EOL = resolve(REPO, 'dat/client_portal.dat');
const DM = resolve(REPO, 'dat/sets/classic-dereth/client_portal.dat');
const Y1999 = resolve(REPO, 'dat/sets/ac1999-retail/portal.dat');

async function familiesOf(path: string, ac1999 = false) {
  const { DatReader } = await import('../packages/dat-parser/src/DatReader');
  const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable');
  let raw = openDat(path).getFileData(0x0e00000e)!;
  if (ac1999) raw = (await import('../packages/dat-parser/src/era1999/Tables1999')).transcodeSpellTable1999(raw);
  const table = new SpellTable(new DatReader(raw));
  return { table, fams: buildCombatFamilies(table) };
}

describe.skipIf(!existsSync(EOL))('buildCombatFamilies on the end-of-retail SpellTable 0x0E00000E', () => {
  let eol: Awaited<ReturnType<typeof familiesOf>>;
  beforeAll(async () => { eol = await familiesOf(EOL); });
  it('anchors debuff columns on their spell categories (I = Imperil Other, cat 116; B 40; G 38; Y 42; F 94)', () => {
    const { fams, table } = eol;
    expect(fams.debuff.I?.category).toBe(116);
    expect(fams.debuff.I?.ids.has(25)).toBe(true); // Imperil Other I
    expect(fams.debuff.I?.ids.has(4312)).toBe(true); // Incantation of Imperil Other
    expect(fams.debuff.I?.ids.has(2074)).toBe(true); // Gossamer Flesh (VII)
    expect(fams.debuff.I?.ids.has(26)).toBe(false); // Imperil Self I: self-targeted
    expect(table.spells.get(2074)?.name).toBe('Gossamer Flesh');
    expect([fams.debuff.B?.category, fams.debuff.G?.category, fams.debuff.Y?.category, fams.debuff.F?.category]).toEqual([40, 38, 42, 94]);
    expect(fams.vuln.fire?.category).toBe(110);
  });
  it('splits Flame Bolt from Flame Arc in category 121, and finds Flame Streak (247) and the fire ring (226)', () => {
    const fire = eol.fams.attack.fire!;
    expect(fire.bolt?.category).toBe(121);
    expect(fire.arc?.category).toBe(121);
    expect(fire.bolt?.ids.has(4439)).toBe(true); // Incantation of Flame Bolt
    expect(fire.bolt?.ids.has(2745)).toBe(false); // Flame Arc VII is an arc
    expect(fire.arc?.ids.has(2745)).toBe(true);
    expect(fire.streak?.category).toBe(247);
    expect(fire.streak?.ids.has(4440)).toBe(true); // Incantation of Flame Streak
    expect(fire.ring?.category).toBe(226);
    expect(eol.table.spells.get(1785)?.name).toBe("Cassius' Ring of Fire");
  });
  it('has the void columns, with Corruption / Corrosion / Destructive Curse as DoTs and the curses not', () => {
    const d = eol.fams.debuff;
    expect([d.WC?.category, d.FC?.category, d.Cp?.category, d.DC?.category, d.Cs?.category]).toEqual([642, 643, 638, 636, 637]);
    expect([d.Cp?.dot, d.DC?.dot, d.Cs?.dot, d.WC?.dot, d.FC?.dot]).toEqual([true, true, true, false, false]);
    expect(eol.fams.attack.nether?.bolt?.category).toBe(640);
    expect(eol.fams.attack.nether?.streak?.category).toBe(639);
  });
  it('Harm Other (80), Drain Health Other (87) and Tusker Fists: no Martyr\'s, self or Health-to-vital spells', () => {
    const { fams, table } = eol;
    expect(fams.harm?.category).toBe(80);
    expect(fams.harm?.ids.has(4308)).toBe(true); // Incantation of Harm Other
    expect(fams.harm?.ids.has(2766)).toBe(false); // Martyr's Hecatomb VII
    expect(fams.harm?.ids.has(8)).toBe(false); // Harm Self I
    expect(fams.drain?.category).toBe(87);
    expect(fams.drain?.ids.has(4643)).toBe(true); // Incantation of Drain Health Other
    for (const id of fams.drain!.ids) expect(table.spells.get(id)!.name).not.toMatch(/Health to|Regeneration/);
    expect([...fams.fists!.ids]).toEqual([2934]);
  });
});

describe.skipIf(!existsSync(DM) || !existsSync(Y1999))('buildCombatFamilies follows each era\'s own table', () => {
  let dm: Awaited<ReturnType<typeof familiesOf>>;
  let y1999: Awaited<ReturnType<typeof familiesOf>>;
  beforeAll(async () => { dm = await familiesOf(DM); y1999 = await familiesOf(Y1999, true); });
  it('AC1999: Imperil Other is category 110 there, and it has no streaks, arcs, rings or void', () => {
    expect(y1999.fams.debuff.I?.category).toBe(110);
    expect(y1999.fams.debuff.I?.ids.has(1327)).toBe(true);
    expect(y1999.fams.attack.fire?.bolt?.category).toBe(115);
    expect(y1999.fams.attack.fire?.streak).toBeUndefined();
    expect(y1999.fams.attack.fire?.arc).toBeUndefined();
    expect(y1999.fams.attack.fire?.ring).toBeUndefined();
    expect(y1999.fams.debuff.WC).toBeUndefined();
  });
  it('Dark Majesty (classic Dereth): Flame Bolt and Imperil families present', () => {
    expect(dm.fams.debuff.I?.ids.has(25)).toBe(true);
    expect(dm.fams.attack.fire?.bolt?.ids.has(27)).toBe(true);
  });
  it('Harm / Drain / Fists follow each era: 1999 has Harm (76) and Drain (81) but no Tusker Fists; Dark Majesty has all three', () => {
    expect(y1999.fams.harm?.category).toBe(76);
    expect(y1999.fams.harm?.ids.has(7)).toBe(true);
    expect(y1999.fams.drain?.category).toBe(81);
    expect(y1999.fams.drain?.ids.has(1237)).toBe(true);
    expect(y1999.fams.fists).toBeUndefined();
    expect(dm.fams.harm?.ids.has(1176)).toBe(true);
    expect(dm.fams.drain?.ids.has(1242)).toBe(true);
    expect(dm.fams.fists?.ids.has(2934)).toBe(true);
  });
  it('the planner plans sensibly on each era\'s table: Harm, Drain Auto and Imperil under both debuff methods', () => {
    for (const era of [dm, y1999]) {
      const sp = (id: number): PlanSpell => { const s = era.table.spells.get(id)!; return { id, name: s.name, school: SCHOOL_NAME[s.school], category: s.category, power: s.power, self: false, buff: false, duration: s.duration ?? 0 }; };
      const base = { families: era.fams, items: [], itemNames: [], wielded: {}, skills: [skill(33, 'Life Magic', 120)] };
      expect(planCombat(input({ ...base, rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Harm })], spells: [sp(7), sp(1172), sp(1176)] }))).toMatchObject({ spell: { id: 1172 } });
      expect(planCombat(input({ ...base, rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.DrainAuto })], spells: [sp(1237), sp(1242)] }))).toMatchObject({ spell: { id: 1237 } });
      const imp = { ...base, rows: [row('<DEFAULT>', { on: ['I'] })], spells: [sp(25), sp(1327)] };
      expect(planCombat(input(imp))).toMatchObject({ spell: { id: 25 } });
      expect(planCombat(input({ ...imp, settings: { AttackDistance: 30, DebuffSelectionMethod: 1 } }))).toMatchObject({ spell: { id: 1327 } });
    }
  });
});

describe('ammunition (VTank: AmmoType, the row\'s element, prismatic per Dmg type)', () => {
  const BOW: PlanItem = { guid: 950, name: 'Yew Longbow', itemType: 0x100, ints: { 50: 1 }, equipped: true, slot: 'MissileWeapon' };
  const ammo = (guid: number, name: string, ints: Record<number, number>, extra: Partial<PlanItem> = {}): PlanItem => ({ guid, name, fits: 'MissileAmmo', stack: 50, ints: { 50: 1, ...ints }, ...extra });
  const FIRE = ammo(951, 'Fire Arrow', { 44: 9, 45: 0x10 });
  const GREATER_FIRE = ammo(952, 'Greater Fire Arrow', { 44: 12, 45: 0x10 });
  const ACID = ammo(953, 'Acid Arrow', { 44: 9, 45: 0x20 });
  const PRISM = ammo(954, 'Prismatic Arrow', { 44: 10 });
  const QUARREL = ammo(955, 'Fire Quarrel', { 44: 20, 45: 0x10, 50: 2 });
  const archer = (damage: number, items: PlanItem[], extra: Partial<CombatInput> = {}) => input({ rows: [row('<DEFAULT>', { on: ['A'], damage })], items: [BOW, ...items], itemNames: [], wielded: { weapon: 'Yew Longbow' }, stance: 'missile', spells: [], ...extra });

  it('a named element: the strongest arrow of it the bow takes (a quarrel never), prismatic only when none of the element is carried', () => {
    expect(ammoFor(archer(VT_DAMAGE.Fire, [FIRE, GREATER_FIRE, ACID, PRISM, QUARREL]), row('x', { damage: VT_DAMAGE.Fire }), BOW)?.name).toBe('Greater Fire Arrow');
    expect(ammoFor(archer(VT_DAMAGE.Cold, [FIRE, PRISM]), row('x', { damage: VT_DAMAGE.Cold }), BOW)?.name).toBe('Prismatic Arrow');
    expect(ammoFor(archer(VT_DAMAGE.Cold, [FIRE]), row('x', { damage: VT_DAMAGE.Cold }), BOW)).toBeNull();
  });

  it('Prismatic (11) shoots prismatic ammo first; Auto with nothing to aim at takes the best of any element', () => {
    expect(ammoFor(archer(VT_DAMAGE.Prismatic, [GREATER_FIRE, PRISM]), row('x', { damage: VT_DAMAGE.Prismatic }), BOW)?.name).toBe('Prismatic Arrow');
    expect(ammoFor(archer(VT_DAMAGE.Prismatic, [GREATER_FIRE]), row('x', { damage: VT_DAMAGE.Prismatic }), BOW)?.name).toBe('Greater Fire Arrow');
    expect(ammoFor(archer(VT_DAMAGE.Auto, [FIRE, GREATER_FIRE, ACID]), row('x', { damage: VT_DAMAGE.Auto }), BOW)?.name).toBe('Greater Fire Arrow');
  });

  it('an unexamined launcher picks nothing yet; a wield requirement you miss is skipped; the element can come from UiEffects', () => {
    expect(ammoFor(archer(VT_DAMAGE.Fire, [FIRE]), row('x', { damage: VT_DAMAGE.Fire }), { ...BOW, ints: {} })).toBeNull();
    const gated = ammo(956, 'Deadly Fire Arrow', { 44: 30, 45: 0x10, 158: 1, 159: 47, 160: 400 });
    const lowBow = archer(VT_DAMAGE.Fire, [FIRE, gated], { skills: [skill(47, 'Missile Weapons', 200)] });
    expect(ammoFor(lowBow, row('x', { damage: VT_DAMAGE.Fire }), BOW)?.name).toBe('Fire Arrow');
    // AmmoType from the public description, before any examination (CreateObject carries it).
    const unexamined = ammo(958, 'Fire Arrow', { 44: 9, 45: 0x10 }, { ints: { 44: 9, 45: 0x10 }, ammoType: 1 });
    expect(ammoFor(archer(VT_DAMAGE.Fire, [unexamined]), row('x', { damage: VT_DAMAGE.Fire }), { ...BOW, ints: {}, ammoType: 1 })?.guid).toBe(958);
    const glow = ammo(957, 'Fire Arrow', { 44: 9 }, { uiEffects: 0x20 });
    expect(ammoFor(archer(VT_DAMAGE.Fire, [glow]), row('x', { damage: VT_DAMAGE.Fire }), BOW)?.guid).toBe(957);
  });

  it('UseSpecialAmmo: special ammunition (the era\'s table: Raider 1, SCurrency 2) is shot only when its kind is allowed', () => {
    const raider = ammo(960, 'Raider Lightning Arrow', { 44: 60, 45: 0x40 });
    const chill = ammo(961, 'Spectral Chill Arrow', { 44: 60, 45: 0x8 });
    const table = new Map([['raider lightning arrow', 1], ['spectral chill arrow', 2]]);
    const specialAmmo = (n: string) => table.get(n.toLowerCase()) ?? 0;
    const lightning = ammo(962, 'Lightning Arrow', { 44: 9, 45: 0x40 });
    const pick = (use: number) => ammoFor(archer(VT_DAMAGE.Lightning, [raider, lightning], { specialAmmo, settings: { UseSpecialAmmo: use } }), row('x', { damage: VT_DAMAGE.Lightning }), BOW)?.name;
    expect(pick(0)).toBe('Lightning Arrow');
    expect(pick(1)).toBe('Raider Lightning Arrow');
    expect(pick(2)).toBe('Lightning Arrow');
    expect(pick(3)).toBe('Raider Lightning Arrow');
    expect(ammoFor(archer(VT_DAMAGE.Cold, [chill], { specialAmmo, settings: { UseSpecialAmmo: 2 } }), row('x', { damage: VT_DAMAGE.Cold }), BOW)?.name).toBe('Spectral Chill Arrow');
    // Without a table (an era with none) every arrow is ordinary.
    expect(ammoFor(archer(VT_DAMAGE.Lightning, [raider], { settings: { UseSpecialAmmo: 0 } }), row('x', { damage: VT_DAMAGE.Lightning }), BOW)?.name).toBe('Raider Lightning Arrow');
  });

  it('planCombat equips the row\'s ammunition before shooting, then attacks', () => {
    const p = planCombat(archer(VT_DAMAGE.Fire, [ACID, GREATER_FIRE]));
    expect(p).toMatchObject({ kind: 'equip', item: { name: 'Greater Fire Arrow' } });
    const loaded = planCombat(archer(VT_DAMAGE.Fire, [ACID, { ...GREATER_FIRE, equipped: true, slot: 'MissileAmmo' }]));
    expect(loaded).toMatchObject({ kind: 'attack', target: 1 });
  });
});

describe.skipIf(!existsSync(EOL) || !existsSync(DM) || !existsSync(Y1999))('RandomHelperBuffs\' spells in every era\'s SpellTable', () => {
  it('all eleven level-I helper spells exist by name at end of retail, in Dark Majesty and in 1999', async () => {
    const { HELPER_SPELLS } = await import('../packages/renderer/src/agent/macro/vtMacro.ts');
    for (const [path, y] of [[EOL, false], [DM, false], [Y1999, true]] as const) {
      const { table } = await familiesOf(path, y);
      const names = new Set([...table.spells.values()].map((s) => s.name));
      expect(HELPER_SPELLS.filter((n) => !names.has(n)), path).toEqual([]);
    }
  });
});
