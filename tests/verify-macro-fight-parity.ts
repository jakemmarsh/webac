/**
 * VirindiTank parity §1.3, §1.5–§1.8 (docs/vtank-parity-gaps.md): the automatic weapon ladder,
 * projectile awareness, debuffs from caster items / cast-on-strike weapons / grenades, Drain Auto's
 * drain and martyr plan, and pet refills, as pure planners (agent/macro/weaponLadder.ts,
 * itemDebuffs.ts, drainPlan.ts, petRefill.ts, combatPlan.ts), plus the per-era drain table
 * generator (tools/build-drain-tables.ts) and its shipped tables. Facts from openac-mosstank's
 * reading of VTank (no code copied) and ACE / the AC1999 server for the numbers and the words.
 */
import { describe, expect, it } from 'vitest';
import { VT_DAMAGE, VT_DEFAULT_MONSTER, vtOption, type PlanItem, type PlanSkill, type PlanSpell, type VtMonsterRow } from '@ac/shared';
import { buildCombatFamilies, planCombat, type CombatInput, type CombatMonster, type CombatSpellTableEntry, type MonsterFacts } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { pickLadderWeapon, weaponElement, weaponRating, type LadderInput } from '../packages/renderer/src/agent/macro/weaponLadder.ts';
import { debuffSources, itemCastLine } from '../packages/renderer/src/agent/macro/itemDebuffs.ts';
import { planDrain, type DrainRow } from '../packages/renderer/src/agent/macro/drainPlan.ts';
import { planPetRefill } from '../packages/renderer/src/agent/macro/petRefill.ts';
import { drainRow, parseSpellSql } from '../tools/build-drain-tables.ts';
import EOL_DRAINS from '../packages/renderer/src/agent/macro/drains/eol.ts';
import DM_DRAINS from '../packages/renderer/src/agent/macro/drains/dm.ts';
import AC1999_DRAINS from '../packages/renderer/src/agent/macro/drains/ac1999.ts';

const SCHOOL: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };
// End-of-retail spell rows (ids, categories, schools, bitfields and powers from the EoL DAT).
const TABLE: Array<[number, CombatSpellTableEntry & { duration?: number }]> = [
  [25, { name: 'Imperil Other I', category: 116, school: 2, bitfield: 0x13, power: 25, duration: 60 }],
  [1326, { name: 'Imperil Other V', category: 116, school: 2, bitfield: 0x13, power: 225, duration: 240 }],
  [1327, { name: 'Imperil Other VI', category: 116, school: 2, bitfield: 0x13, power: 275, duration: 300 }],
  [21, { name: 'Fire Vulnerability Other I', category: 110, school: 2, bitfield: 0x13, power: 25, duration: 60 }],
  [1127, { name: 'Blade Vulnerability Other I', category: 108, school: 2, bitfield: 0x13, power: 25, duration: 60 }],
  [27, { name: 'Flame Bolt I', category: 121, school: 1, bitfield: 0x3, power: 1 }],
  [85, { name: 'Flame Bolt VI', category: 121, school: 1, bitfield: 0x3, power: 250 }],
  [1237, { name: 'Drain Health Other I', category: 87, school: 2, bitfield: 0x13, power: 38 }],
  [1242, { name: 'Drain Health Other VI', category: 87, school: 2, bitfield: 0x13, power: 288 }],
  [7, { name: 'Harm Other I', category: 80, school: 2, bitfield: 0x13, power: 1 }],
  [2766, { name: "Martyr's Hecatomb VII", category: 80, school: 2, bitfield: 0x3, power: 300 }],
];
const SPELLS = new Map(TABLE);
const FAMILIES = buildCombatFamilies({ spells: SPELLS });
const spell = (id: number): PlanSpell => {
  const s = SPELLS.get(id)!;
  return { id, name: s.name, school: SCHOOL[s.school], category: s.category, power: s.power, self: false, buff: false, duration: s.duration ?? 0 };
};
const skill = (id: number, name: string, buffed: number, training: PlanSkill['training'] = 'specialized'): PlanSkill => ({ id, name, training, base: buffed, buffed });
const SKILLS = [skill(33, 'Life Magic', 400), skill(34, 'War Magic', 400), skill(31, 'Creature Enchantment', 400), skill(38, 'Alchemy', 200)];
const row = (name: string, extra: Partial<VtMonsterRow> = {}): VtMonsterRow => ({ ...structuredClone(VT_DEFAULT_MONSTER), name, ...extra });
const mon = (guid: number, name: string, dist: number, extra: Partial<CombatMonster> = {}): CombatMonster => ({ guid, name, dist, relBearing: 0, ...extra });
const WAND: PlanItem = { guid: 900, name: 'Fire Wand', itemType: 0x8000, ints: { 45: 0x10 }, equipped: true };

function input(over: Partial<CombatInput> = {}): CombatInput {
  return {
    monsters: [mon(1, 'Drudge Skulker', 3)], rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Fire })],
    spells: [spell(27), spell(85)], skills: SKILLS, items: [WAND], itemNames: ['Fire Wand'], wielded: { weapon: 'Fire Wand' },
    stance: 'magic', settings: { AttackDistance: 30 }, castLog: [], now: 100_000, selectedGuid: null, families: FAMILIES,
    spellInfo: (id) => SPELLS.get(id), ...over,
  };
}

describe('the weapon ladder (§1.3; MOSS VtankWeaponLadder, VtankWeaponElement)', () => {
  it('a weapon\'s element: one rend imbue, else the resistance it cleaves, else its DamageType (acid, bludgeon, cold, fire, lightning, slash, pierce, nether)', () => {
    expect(weaponElement({ ints: { 179: 0x200, 45: 0x1 } })).toBe('fire'); // Fire Rend on a sword
    expect(weaponElement({ ints: { 179: 0x200 | 0x1, 45: 0x1 } })).toBe('slash'); // a rend with a critical imbue names no single element
    expect(weaponElement({ ints: { 263: 0x8, 45: 0x1 } })).toBe('cold'); // Resistance Cleaving: Cold
    expect(weaponElement({ ints: { 45: 0x1 | 0x2 } })).toBe('slash');
    expect(weaponElement({ ints: { 45: 0x400 } })).toBe('nether');
    expect(weaponElement({ ints: { 45: 0x1 } }, false)).toBeNull();
    expect(weaponElement({})).toBeNull();
  });
  it('rating: Armor Rend 4000, Critical Strike 2000, Crippling Blow 1000, Armor Cleaving 400, Crushing Blow 200, Biting Strike 100', () => {
    expect(weaponRating({ ints: { 179: 0x4 | 0x1 | 0x2 } })).toBe(7000);
    expect(weaponRating({ floats: { 155: 0.8, 136: 2, 147: 0.15 } })).toBe(700);
    expect(weaponRating({})).toBe(0);
  });
  const sword = (guid: number, ints: Record<number, number>, floats: Record<number, number> = {}): PlanItem => ({ guid, name: `Sword ${guid}`, itemType: 0x1, ints: { 45: 0x1, ...ints }, floats });
  const base = (items: PlanItem[], over: Partial<LadderInput> = {}): LadderInput => ({ items, wanted: ['fire', 'cold', 'slash'], canDeliver: () => true, vulnerable: () => false, warTrained: true, voidTrained: false, ...over });
  it('a slayer for the species wins outright; then the best rated of an element the monster is already vulned to', () => {
    const plain = sword(1, {}), slayer = sword(2, { 166: 3 }), crit = sword(3, { 179: 0x1 }), rend = sword(4, { 179: 0x200 });
    expect(pickLadderWeapon(base([plain, slayer, rend], { species: 3 }))?.guid).toBe(2);
    expect(pickLadderWeapon(base([plain, slayer, rend], { species: 4 }))?.guid).toBe(4); // no Olthoi slayer: the fire rend (an imbue)
    // Already vulned to slash: the rated slash sword beats the fire rend (CHG .168).
    expect(pickLadderWeapon(base([rend, crit], { vulnerable: (el) => el === 'slash' }))?.guid).toBe(3);
    expect(pickLadderWeapon(base([rend, crit]))?.guid).toBe(4);
  });
  it('then a rated weapon of a wanted element, a rated caster with none, any weapon of a wanted element, any launcher, the last on the tab', () => {
    const crit = sword(3, { 179: 0x1 }), plain = sword(1, {});
    expect(pickLadderWeapon(base([plain, crit]))?.guid).toBe(3);
    const ratedWand: PlanItem = { guid: 5, name: 'Staff', itemType: 0x8000, ints: { 179: 0x1 } };
    expect(pickLadderWeapon(base([plain, ratedWand], { wanted: ['cold'] }))?.guid).toBe(5);
    expect(pickLadderWeapon(base([plain, { ...sword(6, {}), ints: { 45: 0x8 } }], { wanted: ['cold'] }))?.guid).toBe(6);
    const bow: PlanItem = { guid: 7, name: 'Bow', itemType: 0x100 };
    expect(pickLadderWeapon(base([plain, bow], { wanted: ['cold'] }))?.guid).toBe(7);
    expect(pickLadderWeapon(base([plain, sword(8, {})], { wanted: ['cold'] }))?.guid).toBe(8);
  });
  it('a wand of a school you lack is no weapon (unless nothing else is listed); the offhand pick is spoken for; a launcher needs the ammunition', () => {
    const voidWand: PlanItem = { guid: 9, name: 'Void Staff', itemType: 0x8000, ints: { 45: 0x400 } };
    const plain = sword(1, {});
    expect(pickLadderWeapon(base([voidWand, plain], { wanted: ['nether'] }))?.guid).toBe(1);
    expect(pickLadderWeapon(base([voidWand], { wanted: ['nether'] }))?.guid).toBe(9);
    expect(pickLadderWeapon(base([voidWand, plain], { wanted: ['nether'], voidTrained: true }))?.guid).toBe(9);
    expect(pickLadderWeapon(base([plain, sword(2, { 166: 3 })], { species: 3, exclude: 2 }))?.guid).toBe(1);
    const bow: PlanItem = { guid: 7, name: 'Bow', itemType: 0x100, ints: { 45: 0x10 } };
    expect(pickLadderWeapon(base([bow, { ...sword(6, {}), ints: { 45: 0x10 } }], { wanted: ['fire'], canDeliver: (i) => i.guid !== 7 }))?.guid).toBe(6);
    expect(pickLadderWeapon(base([]))).toBeUndefined();
  });
  it('in the planner: an <AUTO> row fights each monster with the ladder\'s pick from the Items tab (a slayer for Drudges)', () => {
    const flaming: PlanItem = { guid: 801, name: 'Flaming Sword', itemType: 0x1, ints: { 45: 0x10 }, equipped: true };
    const slayer: PlanItem = { guid: 802, name: 'Drudge Slayer Axe', itemType: 0x1, ints: { 45: 0x1, 166: 3 } };
    const facts = (name: string): MonsterFacts | undefined => (name === 'Drudge Skulker' ? { weak: ['fire', 'slash'], maxHealth: 42, species: 3 } : { weak: ['fire', 'slash'], maxHealth: 20, species: 9 });
    const i = input({ items: [flaming, slayer], itemNames: ['Flaming Sword', 'Drudge Slayer Axe'], wielded: { weapon: 'Flaming Sword' }, stance: 'melee', monsterFacts: facts, rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Auto })] });
    expect(planCombat(i)).toMatchObject({ kind: 'equip', item: { guid: 802 } });
    // A rat: no slayer, and its weakest element is fire: the flaming sword in hand.
    expect(planCombat({ ...i, monsters: [mon(2, 'Rat', 3)] })).toMatchObject({ kind: 'attack', target: 2, element: 'fire' });
    // A named weapon row keeps its weapon.
    expect(planCombat({ ...i, rows: [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.Auto, weapon: 'Flaming Sword' })] })).toMatchObject({ kind: 'attack', target: 1 });
  });
  it('Auto\'s element and the V column follow a cleaving weapon (before 2026-10-11 only its DamageType counted)', () => {
    const cleaver: PlanItem = { guid: 803, name: 'Frost Cleaver', itemType: 0x1, ints: { 45: 0x1, 263: 0x10 }, equipped: true };
    const i = input({ items: [cleaver], itemNames: ['Frost Cleaver'], wielded: { weapon: 'Frost Cleaver' }, stance: 'melee', spells: [spell(21), spell(1127)], rows: [row('<DEFAULT>', { on: ['V', 'A'], damage: VT_DAMAGE.Auto })] });
    expect(planCombat(i)).toMatchObject({ kind: 'stance', to: 'magic', why: 'to cast Fire Vulnerability Other I' });
  });
});

describe('projectile awareness (§1.5; UseProjectileAwareness, AllowDebuffFallback, UseBreakableTurnTo)', () => {
  const two = [mon(1, 'Drudge Skulker', 3, { blocked: true }), mon(2, 'Drudge Slinker', 8)];
  it('a monster whose bolt would hit a wall is left for this pass: the bolt goes to the next one (on by default)', () => {
    expect(planCombat(input({ monsters: two }))).toMatchObject({ kind: 'cast', target: 2, spell: { id: 85 }, projectile: true });
    // Off: nothing is tested here.
    expect(planCombat(input({ monsters: two, settings: { AttackDistance: 30, UseProjectileAwareness: false } }))).toMatchObject({ kind: 'cast', target: 1 });
    // Every monster blocked: nothing to do.
    expect(planCombat(input({ monsters: [two[0]] }))).toBeNull();
  });
  it('melee has no flight to test; a launcher does', () => {
    const sword: PlanItem = { guid: 810, name: 'Iron Sword', itemType: 0x1, ints: { 45: 0x1 }, equipped: true };
    expect(planCombat(input({ monsters: two, items: [sword], itemNames: ['Iron Sword'], wielded: { weapon: 'Iron Sword' }, stance: 'melee' }))).toMatchObject({ kind: 'attack', target: 1 });
    const bow: PlanItem = { guid: 811, name: 'Yumi', itemType: 0x100, ammoType: 1, equipped: true };
    const arrows: PlanItem = { guid: 812, name: 'Arrow', itemType: 0x100, ammoType: 1, fits: 'MissileAmmo', slot: 'MissileAmmo', equipped: true, stack: 50 };
    expect(planCombat(input({ monsters: two, items: [bow, arrows], itemNames: ['Yumi'], wielded: { weapon: 'Yumi' }, stance: 'missile' }))).toMatchObject({ kind: 'attack', target: 2 });
  });
  it('a debuff that flies (a grenade) waits while blocked; with AllowDebuffFallback your own spell goes instead', () => {
    const phial: PlanItem = { guid: 820, name: 'Platinum Phial of Imperil', itemType: 0x100, ints: { 106: 400, 158: 2, 159: 38, 160: 75 }, spells: [1327], stack: 10 };
    const rows = [row('<DEFAULT>', { on: ['I', 'A'], damage: VT_DAMAGE.Fire })];
    const base = { rows, items: [WAND, phial], consumableNames: ['Platinum Phial of Imperil'], spells: [spell(27), spell(85), spell(25)], skills: [...SKILLS.filter((s) => s.id !== 33), skill(33, 'Life Magic', 100)] };
    // Clear: the phial (Spellcraft 400 beats your Life Magic 100) is wielded to be thrown.
    expect(planCombat(input({ ...base, monsters: [mon(1, 'Drudge Skulker', 3)] }))).toMatchObject({ kind: 'equip', item: { guid: 820 } });
    // Blocked, no fallback: the I column waits on it; the bolt is blocked too, so nothing.
    expect(planCombat(input({ ...base, monsters: [mon(1, 'Drudge Skulker', 3, { blocked: true })] }))).toBeNull();
    // Blocked, fallback: Imperil Other I from your own book (no flight).
    expect(planCombat(input({ ...base, monsters: [mon(1, 'Drudge Skulker', 3, { blocked: true })], settings: { AttackDistance: 30, AllowDebuffFallback: true } }))).toMatchObject({ kind: 'cast', spell: { id: 25 }, target: 1 });
  });
});

describe('debuffs from items (§1.6; MOSS CombatItemDebuffPlanner)', () => {
  const rows = [row('<DEFAULT>', { on: ['I', 'A'], damage: VT_DAMAGE.Fire })];
  const imperilWand: PlanItem = { guid: 830, name: 'Imperil Wand', itemType: 0x8000, ints: { 106: 300 }, dids: { 28: 1326 } };
  it('DebuffSelectionMethod Skill (default): the higher skill (yours, or the item\'s Spellcraft); Spell Level: the higher level', () => {
    const i = input({ rows, spells: [spell(27), spell(85), spell(25)], items: [WAND, imperilWand], itemNames: ['Fire Wand', 'Imperil Wand'] });
    // Your Life Magic 400 beats the wand's Spellcraft 300: your Imperil Other I.
    expect(planCombat(i)).toMatchObject({ kind: 'cast', spell: { id: 25 } });
    // Spell Level: the wand's Imperil Other V (225) beats your I (25): wield the wand, then use it on the monster.
    const byLevel = { ...i, settings: { AttackDistance: 30, DebuffSelectionMethod: 1 } };
    expect(planCombat(byLevel)).toMatchObject({ kind: 'equip', item: { guid: 830 } });
    expect(planCombat({ ...byLevel, items: [{ ...WAND, equipped: false }, { ...imperilWand, equipped: true }], wielded: { weapon: 'Imperil Wand' } })).toMatchObject({ kind: 'use-item', item: { guid: 830 }, spell: { id: 1326 }, target: 1 });
    // A wand out of mana, or one whose Arcane Lore you lack, is no source.
    expect(planCombat({ ...byLevel, items: [WAND, { ...imperilWand, ints: { 106: 300, 107: 0 } }] })).toMatchObject({ kind: 'cast', spell: { id: 25 } });
    expect(planCombat({ ...byLevel, items: [WAND, { ...imperilWand, ints: { 106: 300, 109: 999 } }] })).toMatchObject({ kind: 'cast', spell: { id: 25 } });
  });
  it('a cast-on-strike weapon on the Items tab is wielded and swung until its debuff lands; the swing carries it', () => {
    const procSword: PlanItem = { guid: 831, name: 'Imperiling Sword', itemType: 0x1, ints: { 45: 0x1, 106: 350 }, spells: [1326], equipped: true };
    const i = input({ rows, spells: [spell(27), spell(85)], items: [WAND, procSword], itemNames: ['Fire Wand', 'Imperiling Sword'], wielded: { weapon: 'Imperiling Sword' }, stance: 'melee' });
    expect(planCombat(i)).toMatchObject({ kind: 'attack', target: 1, debuff: { spell: { id: 1326 }, item: { guid: 831 } } });
    // A War spell on strike is no debuff source.
    expect(debuffSources({ ids: FAMILIES.debuff.I!.ids, learned: null, learnedSkill: 0, items: [{ ...procSword, spells: [85] }], consumables: [], skills: SKILLS, spellInfo: (id) => SPELLS.get(id), canWield: () => true, method: 2 })).toEqual([]);
  });
  it('a grenade on the Consumables tab is wielded, then thrown in missile mode; its wield requirement must be met', () => {
    const phial: PlanItem = { guid: 832, name: 'Iron Phial of Imperil', itemType: 0x100, ints: { 106: 500, 158: 2, 159: 38, 160: 75 }, spells: [1326], equipped: true };
    const i = input({ rows, spells: [spell(27), spell(85)], items: [WAND, phial], consumableNames: ['Iron Phial of Imperil'], wielded: { weapon: 'Iron Phial of Imperil' }, stance: 'melee' });
    expect(planCombat(i)).toMatchObject({ kind: 'stance', to: 'missile' });
    expect(planCombat({ ...i, stance: 'missile' })).toMatchObject({ kind: 'attack', debuff: { spell: { id: 1326 } } });
    // Alchemy 50 (base) under its 75: not a grenade you can throw; the I column has no source, so the bolt.
    expect(planCombat({ ...i, stance: 'magic', skills: [...SKILLS.filter((s) => s.id !== 38), skill(38, 'Alchemy', 50)] })).toMatchObject({ kind: 'cast', spell: { id: 85 } });
  });
  it('a monster immune to non-projectile magic gets no debuffs (the era\'s table, or the server\'s "You fail to affect"): it is attacked', () => {
    const i = input({ rows, spells: [spell(27), spell(85), spell(25)] });
    expect(planCombat(i)).toMatchObject({ spell: { id: 25 } });
    expect(planCombat({ ...i, monsterFacts: () => ({ weak: [], maxHealth: 100, magicImmune: true }) })).toMatchObject({ spell: { id: 85 } });
    expect(planCombat({ ...i, monsters: [mon(1, 'Drudge Skulker', 3, { magicImmune: true })] })).toMatchObject({ spell: { id: 85 } });
  });
  it('reads "<item> cast <spell> on <monster>", the words on ACE, the AC1999 server and ClassicACE', () => {
    expect(itemCastLine('Imperiling Sword cast Imperil Other V on Drudge Skulker')).toEqual({ caster: 'Imperiling Sword', spell: 'Imperil Other V', target: 'Drudge Skulker' });
    expect(itemCastLine('Imperil Wand cast Imperil Other V on Drudge Skulker, refreshing Imperil Other V')).toMatchObject({ target: 'Drudge Skulker' });
    expect(itemCastLine('You hit Drudge Skulker for 12 points of slashing damage!')).toBeNull();
    // ClassicACE: "casts", a full stop, and a metaspell's adjectives.
    expect(itemCastLine('Imperiling Sword casts Imperil Other V on Drudge Skulker.')).toEqual({ caster: 'Imperiling Sword', spell: 'Imperil Other V', target: 'Drudge Skulker' });
    expect(itemCastLine('Imperil Wand quickcasts extended Imperil Other V on Drudge Skulker.')).toMatchObject({ spell: 'Imperil Other V' });
  });
});

const EOL: DrainRow[] = JSON.parse(EOL_DRAINS);
describe('Drain Auto\'s plan (§1.7; MOSS CorpseDrainPlan, numbers from each era\'s spell data)', () => {
  const STANDARD = new Set([1237, 1238, 1239, 1240, 1241, 1242, 2760, 2761, 2762, 2763, 2764, 2765, 2766]);
  const plan = (o: Partial<Parameters<typeof planDrain>[0]>) => planDrain({ health: 900, maxHealth: 1000, floor: 749, target: 400, canDrain: true, ring: false, rows: EOL, castable: (id) => STANDARD.has(id), ...o });
  it('hurt, with the floor in the way of a martyr: the drain that takes the most per second (Drain Health Other VI)', () => {
    expect(plan({ health: 800 })).toBe(1242);
    expect(plan({ health: 800, castable: (id) => id !== 1242 && STANDARD.has(id) })).toBe(1241);
    // Already under the floor, nothing keeps you above it: the floor is dropped and the best rate wins (a martyr's head start).
    expect(plan({ health: 500 })).toBe(2766);
  });
  it('at full health there is nothing to drain into: a martyr; the first one that finishes it', () => {
    expect(plan({ health: 1000 })).toBe(2765); // 25% of 1000 × 1.75 = 438 ≥ 400; VII ties it at the same cost
    expect(plan({ health: 1000, castable: (id) => id <= 2764 })).toBe(2764);
  });
  it('a nearly dead monster (under 300) gets the search: under 25 left no drain, a martyr finishes it', () => {
    expect(plan({ target: 20, floor: 0 })).toBe(2760);
  });
  it('nothing better than healing: null (the recharge rules heal); a ring plan takes only ring martyrs; an undrainable monster is never drained', () => {
    expect(plan({ castable: () => false })).toBeNull();
    expect(plan({ health: 1000, ring: true })).toBeNull(); // Curse of Raven Fury (3818) not known
    // The era's data marks it as a ring (more than one projectile): a ring plan may use it, a plain one may not.
    expect(EOL.find((r) => r[0] === 3818)?.[1]).toBe('r');
    expect(plan({ health: 1000, ring: true, castable: (id) => id === 3818 || STANDARD.has(id) })).toBe(3818);
    expect(plan({ health: 1000, castable: (id) => id === 3818 })).toBeNull();
    expect(plan({ health: 800, canDrain: false })).not.toBe(1242);
    // Health unknown and every martyr under the floor: heal first.
    expect(plan({ target: Infinity, canDrain: false })).toBeNull();
  });
  it('in the planner: Drain Auto plans from your health, the monster\'s health left (the era\'s max health) and Heal at', () => {
    const rows = [row('<DEFAULT>', { on: ['A'], damage: VT_DAMAGE.DrainAuto })];
    const facts = (): MonsterFacts => ({ weak: [], maxHealth: 400 });
    const i = input({ rows, spells: [spell(1242), spell(2766)], drainTable: EOL, monsterFacts: facts, settings: { AttackDistance: 30, 'Recharge-Norm-HitP': 75 } });
    expect(planCombat({ ...i, vitals: { health: 800, maxHealth: 1000 } })).toMatchObject({ kind: 'cast', spell: { id: 1242 } });
    // Full health: the martyr (a Life projectile: projectile awareness and the turn apply to it).
    expect(planCombat({ ...i, vitals: { health: 1000, maxHealth: 1000 } })).toMatchObject({ kind: 'cast', spell: { id: 2766 }, projectile: true });
    expect(planCombat({ ...i, vitals: { health: 1000, maxHealth: 1000 }, monsters: [mon(1, 'Drudge Skulker', 3, { blocked: true })] })).toBeNull();
    // A drain-immune monster (ResistHealthDrain 0 in the era's table) is never drained.
    expect(planCombat({ ...i, vitals: { health: 800, maxHealth: 1000 }, monsterFacts: () => ({ weak: [], maxHealth: 400, drainImmune: true }) })).toBeNull();
  });
});

describe('the drain tables (tools/build-drain-tables.ts): each era\'s own numbers', () => {
  it('parses ACE spell rows: a health drain (proportion, cap, 1 - loss) and a martyr (drain percentage, damage ratio)', () => {
    const drain = "INSERT INTO `spell` (`id`, `name`, `source`, `destination`, `proportion`, `loss_Percent`, `source_Loss`, `transfer_Cap`, `max_Boost_Allowed`, `transfer_Bitfield`, `last_Modified`)\nVALUES (1237, 'Drain Health Other I', 2 /* Health */, 2 /* Health */, 0.25, -1, 0, 60, 0, 6 /* TargetSource, CasterDestination */, '2005-02-09 10:00:00');";
    expect(drainRow(parseSpellSql(drain)!)).toEqual([1237, 'd', 0.25, 60, 2]);
    // Health to Stamina (destination Stamina) is no drain.
    expect(drainRow(parseSpellSql(drain.replace('2 /* Health */, 0.25', '3 /* Stamina */, 0.25'))!)).toBeNull();
    const martyr = "INSERT INTO `spell` (`id`, `name`, `e_Type`, `num_Projectiles`, `drain_Percentage`, `damage_Ratio`, `last_Modified`)\nVALUES (2760, 'Martyr''s Hecatomb I', 128 /* Health */, 1, 0.25, 0.75, '2005-02-09 10:00:00');";
    expect(parseSpellSql(martyr)?.name).toBe("Martyr's Hecatomb I");
    expect(drainRow(parseSpellSql(martyr)!)).toEqual([2760, 'm', 0.25, 0, 0.75]);
    expect(drainRow(parseSpellSql(martyr.replace(', 1, 0.25', ', 8, 0.25'))!)?.[1]).toBe('r');
  });
  it('the shipped tables differ by era: 1999\'s drains lose a quarter on the way and cap at 100; it has no martyrs', () => {
    const get = (t: string, id: number) => (JSON.parse(t) as DrainRow[]).find((r) => r[0] === id);
    expect(get(EOL_DRAINS, 1237)).toEqual([1237, 'd', 0.25, 60, 2]);
    expect(get(AC1999_DRAINS, 1237)).toEqual([1237, 'd', 0.25, 100, 0.75]);
    expect(get(DM_DRAINS, 2766)?.[1]).toBe('m');
    expect((JSON.parse(AC1999_DRAINS) as DrainRow[]).some((r) => r[1] !== 'd')).toBe(false);
  });
});

describe('pet refills (§1.8; PetRefillCount-Normal / -Idle, MOSS TrySelectRefill)', () => {
  const ess = (guid: number, left: number | undefined, max = 50): PlanItem => {
    const ints: Record<number, number> = { 266: 1, 91: max };
    if (left !== undefined) ints[92] = left;
    return { guid, name: `Essence ${guid}`, ints };
  };
  const spirit = (guid: number, stack: number): PlanItem => ({ guid, name: 'Encapsulated Spirit', stack });
  it('the first essence down to the count and short of full gets the smallest stack of spirits', () => {
    const r = planPetRefill([ess(1, 10), ess(2, 1), ess(3, 0)], [spirit(9, 20), spirit(8, 3)], 1);
    expect(r).toMatchObject({ device: { guid: 2 }, spirit: { guid: 8 } });
    expect(planPetRefill([ess(1, 3)], [spirit(9, 20)], 3)?.device.guid).toBe(1);
  });
  it('not examined, full, above the count, or no spirit: nothing', () => {
    expect(planPetRefill([ess(1, undefined)], [spirit(9, 1)], 3)).toBeNull();
    expect(planPetRefill([ess(1, 1, 1)], [spirit(9, 1)], 3)).toBeNull();
    expect(planPetRefill([ess(1, 10)], [spirit(9, 1)], 3)).toBeNull();
    expect(planPetRefill([ess(1, 1)], [], 3)).toBeNull();
  });
});

describe('the options the engine now honours (§1.5, §1.8)', () => {
  it('UseProjectileAwareness, UseBreakableTurnTo, AllowDebuffFallback and the two pet refill counts are engine options with VTank\'s defaults', () => {
    const want: Record<string, boolean | number> = { UseProjectileAwareness: true, UseBreakableTurnTo: true, AllowDebuffFallback: false, 'PetRefillCount-Normal': 1, 'PetRefillCount-Idle': 3 };
    for (const [n, d] of Object.entries(want)) {
      expect(vtOption(n)?.engine, n).toBe(true);
      expect(vtOption(n)?.default, n).toBe(d);
    }
    // The collision tuning stays VTank's own: our line-of-fire test is the client's missile sweep.
    expect(vtOption('CollisionProjectileRadius')?.engine).toBeUndefined();
  });
});
