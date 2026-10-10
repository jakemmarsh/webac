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
import { VT_DAMAGE, VT_DEFAULT_MONSTER, type PlanItem, type PlanSkill, type PlanSpell, type VtMonsterRow } from '@ac/shared';
import {
  buildCombatFamilies, matchMonsterRow, pickTarget, planCombat,
  type CombatFamilies, type CombatInput, type CombatMonster, type CombatSpellTableEntry,
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
  it('S streaks; UseArcs Yes / At Range picks the arc when it is at the best level', () => {
    expect(planCombat(input({ rows: [row('<DEFAULT>', { on: ['A', 'S'], damage: VT_DAMAGE.Fire })], spells }))).toMatchObject({ spell: { id: 1800 } });
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
});
