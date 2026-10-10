/**
 * VirindiTank's automatic buff list (packages/renderer/src/agent/macro/buffPlan.ts;
 * docs/vtank-macro-behavior.md §7, §10): families from the spell table,
 * best castable level by buffed school skill + SpellDiffExcessThreshold-Buff,
 * trained skills only, Extra / Blacklisted families, prot and bane profiles,
 * and the rebuff / idle top-off thresholds. The DAT-backed part builds the
 * families from each era's real SpellTable (0x0E00000E) and checks them
 * against ACE's world-DB stat mods.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { PlanSkill, PlanSpell } from '@ac/shared';
import {
  buildBuffFamilies, describeBuffTarget, planBuffs,
  type BuffFamilies, type BuffPlanInput,
} from '../packages/renderer/src/agent/macro/buffPlan.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { SkillTable } from '../packages/dat-parser/src/file-types/SkillTable.js';
import { transcodeSpellTable1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { openDat } from './_harness/dat.js';

// ── a small synthetic spell table (names invented; descriptions in the tables' own phrasing) ──

const CREATURE = 4, LIFE = 2, ITEM = 3;
const BENEFICIAL = 0x4, SELF = 0x8;
type Row = { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc?: string };
const rows: Array<[number, Row]> = [];
let nextId = 1;
const add = (name: string, category: number, school: number, power: number, desc: string, self = true, bitfield = BENEFICIAL | (self ? SELF : 0), duration = 1800): number => {
  const id = nextId++;
  rows.push([id, { name, category, school, bitfield, power, duration, desc }]);
  return id;
};
const LEVELS = [1, 50, 100, 150, 200, 250, 300, 400];
const family = (base: string, category: number, school: number, desc: (n: number) => string): number[] =>
  LEVELS.map((p, i) => add(`${base} ${i + 1}`, category, school, p, desc((i + 1) * 10)));

const STR = family('Might Self', 1, CREATURE, (n) => `Increases the caster's Strength by ${n} points.`);
const QUICK = family('Haste Self', 5, CREATURE, (n) => `Increases the caster's Quickness by ${n} points.`);
const HEAVY = family('Smiting Self', 31, CREATURE, (n) => `Increases the caster's Heavy Weapons skill by ${n} points.`);
const LEAD = family('Command Self', 71, CREATURE, (n) => `Increases the caster's Leadership skill by ${n} points.`);
const ASSESS = family('Beastsense Self', 63, CREATURE, (n) => `Increases the caster's Assess Monster skill by ${n} points.`);
const ACID_P = family('Etchward Self', 101, LIFE, (n) => `Reduces damage the caster takes from Acid by ${n}%`);
const FIRE_P = family('Emberward Self', 109, LIFE, (n) => `Reduces damage the caster takes from fire by ${n}%`);
const BLUD_P = family('Thudward Self', 103, LIFE, (n) => `Reduces damage the caster takes from Bludgeoning by ${n}%`);
const ACID_B = family('Etchbane', 162, ITEM, (n) => `Increases a shield or piece of armor's resistance to acid damage by ${n}%. Target yourself to cast this spell on all of your equipped armor.`);
const ELEC_B = family('Sparkbane', 168, ITEM, (n) => `Increases a shield or piece of armor's resistance to electric damage by ${n}%.`);
const PIERCE_B = family('Pinbane', 172, ITEM, (n) => `Increases a shield or piece of armor's resistance to piercing damage by ${n}%.`);
const BLOOD = family('Aura of Thirst Self', 154, ITEM, (n) => `Increases a weapon's damage value by ${n} points.`);
const HERM = family('Aura of Focus Self', 195, ITEM, (n) => `Increases a magic casting implement's mana conversion bonus by ${n}%.`);
// A quest spell filed in the Strength category whose text names another target: never chosen for it.
const ODD = add('Odd Boon', 1, CREATURE, 10, "Increases the caster's Quickness by 99 points.");
// A flavour-text member of the Strength family: kept (its text names nothing).
const FLAVOUR = add('Giant Grip', 1, CREATURE, 260, 'You feel strong.');
// A harmful spell and a boost (no duration) are never families.
add('Weakness Other 1', 2, CREATURE, 1, "Decreases the target's Strength by 10 points.", false, 0);
add('Heal Self 1', 67, LIFE, 1, "Restores 10-20 points of the caster's Health.", true, BENEFICIAL | SELF, 0);
// A category with no majority (end of retail's Weave category holds every skill): not one family.
add('Weave A', 659, CREATURE, 2, "Increases the target's Alchemy skill by 2 points.");
add('Weave B', 659, CREATURE, 2, "Increases the target's Cooking skill by 2 points.");
add('Weave C', 659, CREATURE, 2, "Increases the target's Healing skill by 2 points.");

const TABLE = { spells: new Map(rows) };
const SKILL_NAMES: Array<[number, string]> = [[44, 'Heavy Weapons'], [35, 'Leadership'], [27, 'Assess Creature'], [31, 'Creature Enchantment'], [33, 'Life Magic'], [32, 'Item Enchantment']];

const SCHOOL_NAME: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };
const plan = (id: number): PlanSpell => {
  const r = TABLE.spells.get(id)!;
  return { id, name: r.name, school: SCHOOL_NAME[r.school], category: r.category, power: r.power, self: !!(r.bitfield & SELF), buff: !!(r.bitfield & BENEFICIAL) && (r.duration ?? 0) > 0, duration: r.duration ?? 0 };
};
const knowAll = (): PlanSpell[] => [...TABLE.spells.keys()].map(plan);
const sk = (id: number, name: string, training: PlanSkill['training'], buffed: number): PlanSkill => ({ id, name, training, base: buffed, buffed });

let families: BuffFamilies;
beforeAll(() => { families = buildBuffFamilies(TABLE, SKILL_NAMES); });

const baseInput = (over: Partial<BuffPlanInput> = {}): BuffPlanInput => ({
  spells: knowAll(),
  skills: [
    sk(31, 'Creature Enchantment', 'specialized', 305),
    sk(33, 'Life Magic', 'trained', 205),
    sk(32, 'Item Enchantment', 'trained', 155),
    sk(44, 'Heavy Weapons', 'specialized', 300),
    sk(35, 'Leadership', 'untrained', 20),
    sk(27, 'Assess Creature', 'trained', 100),
  ],
  active: [],
  settings: {},
  extraBuffs: [],
  blacklistedBuffs: [],
  idle: false,
  families,
  ...over,
});
const names = (l: { spell: PlanSpell }[]): string[] => l.map((b) => b.spell.name);
const pick = <T extends { spell: PlanSpell }>(l: T[], prefix: string): T | undefined => l.find((b) => b.spell.name.startsWith(prefix));

describe('describeBuffTarget: what a description says a spell raises', () => {
  it('reads attributes, skills, prots, banes, armor, vitals and weapon auras in every phrasing the tables use', () => {
    expect(describeBuffTarget("Increases the caster's Strength by 10 points.")).toEqual({ kind: 'attribute', attribute: 'Strength' });
    expect(describeBuffTarget("Increases the target's Self by 35 points. Additional spells can be layered over this.")).toEqual({ kind: 'attribute', attribute: 'Self' });
    expect(describeBuffTarget("Increases the caster's Heavy Weapons skill by 45 points.")).toEqual({ kind: 'skill', skill: 'Heavy Weapons' });
    expect(describeBuffTarget('Boosts casters jump skill by 100 for a short time.')).toEqual({ kind: 'skill', skill: 'jump' });
    expect(describeBuffTarget('The energies imbued upon this ring surge through you, increasing your run skill by 40.')).toEqual({ kind: 'other' });
    expect(describeBuffTarget('Reduces damage the target takes from Lightning by 70%.')).toEqual({ kind: 'protection', element: 'L' });
    expect(describeBuffTarget("Increases a shield or piece of armor's resistance to electric damage by 200%.")).toEqual({ kind: 'bane', element: 'L' });
    expect(describeBuffTarget("Increases a shield or piece of armor's resistance to cold damage by 10%.")).toEqual({ kind: 'bane', element: 'C' });
    expect(describeBuffTarget("Improves a shield or piece of armor's armor value by 20 points.")).toEqual({ kind: 'armorValue' });
    expect(describeBuffTarget("Increases the caster's natural armor by 20 points.")).toEqual({ kind: 'naturalArmor' });
    expect(describeBuffTarget('Increases the rate at which the caster regains Stamina by 10%.')).toEqual({ kind: 'vitalRegen', vital: 'stamina' });
    expect(describeBuffTarget("Increase caster's natural healing rate by 10%.")).toEqual({ kind: 'vitalRegen', vital: 'health' });
    expect(describeBuffTarget('Increases maximum mana by 30 points.')).toEqual({ kind: 'vitalMax', vital: 'mana' });
    // Flavour first, the effect in a later sentence.
    expect(describeBuffTarget('My movements shall become as the wind. Decrease the base speed of a weapon by 30.')).toEqual({ kind: 'weapon', aura: 'speed' });
    expect(describeBuffTarget("Increases a weapon's Defense Skill modifier by 2.5 percentage points.")).toEqual({ kind: 'weapon', aura: 'defense' });
    expect(describeBuffTarget('Your damage rating is increased by 2.')).toEqual({ kind: 'other' });
  });
});

describe('buildBuffFamilies: one family per category, its target by majority of member descriptions', () => {
  it('maps categories to targets and resolves skills to the era skill table ids (with the Assess Monster alias)', () => {
    expect(families.byCategory.get(1)!.target).toEqual({ kind: 'attribute', attribute: 'Strength' });
    expect(families.byCategory.get(31)!.target).toEqual({ kind: 'skill', skill: 'Heavy Weapons', skillId: 44 });
    expect(families.byCategory.get(63)!.target).toMatchObject({ kind: 'skill', skillId: 27 });
    expect(families.byCategory.get(101)!.target).toEqual({ kind: 'protection', element: 'A' });
    expect(families.byCategory.get(168)!.target).toEqual({ kind: 'bane', element: 'L' });
    expect(families.byCategory.get(154)!.target).toEqual({ kind: 'weapon', aura: 'damage' });
    expect(families.byCategory.get(1)!.school).toBe(CREATURE);
  });
  it('excludes members naming another target, keeps flavour-text members, skips harmful spells, boosts and mixed categories', () => {
    const str = families.byCategory.get(1)!;
    expect(str.exclude.has(ODD)).toBe(true);
    expect(str.exclude.has(FLAVOUR)).toBe(false);
    expect(families.byCategory.has(2)).toBe(false);
    expect(families.byCategory.has(67)).toBe(false);
    expect(families.byCategory.get(659)!.target.kind).toBe('other');
    expect(families.byName.get('might self 3')).toBe(1);
  });
  it('without skill names, a skill family keeps its name and planBuffs matches it by name', () => {
    const f = buildBuffFamilies(TABLE);
    expect(f.byCategory.get(31)!.target).toEqual({ kind: 'skill', skill: 'Heavy Weapons' });
    const { wanted } = planBuffs(baseInput({ families: f }));
    expect(pick(wanted, 'Smiting Self')).toBeDefined();
  });
});

describe('planBuffs: which spell of each family', () => {
  it('buffs every attribute, trained skills only, prots, banes; the best level by buffed school skill and the Buff threshold', () => {
    const { wanted } = planBuffs(baseInput());
    // Creature 305: power + 5 <= 305 → 300 (level 7); Strength's flavour member (260) is weaker.
    expect(pick(wanted, 'Might Self')!.spell.name).toBe('Might Self 7');
    expect(pick(wanted, 'Haste Self')!.spell.name).toBe('Haste Self 7');
    expect(pick(wanted, 'Smiting Self')!.spell.name).toBe('Smiting Self 7');
    expect(pick(wanted, 'Beastsense Self')).toBeDefined(); // Assess Creature trained, via the alias
    expect(pick(wanted, 'Command Self')).toBeUndefined();  // Leadership untrained
    // Life 205 → 200 (level 5); Item 155 → 150 (level 4).
    expect(pick(wanted, 'Etchward Self')!.spell.name).toBe('Etchward Self 5');
    expect(pick(wanted, 'Etchbane')!.spell.name).toBe('Etchbane 4');
    expect(pick(wanted, 'Etchbane')!.target).toBe('armor');
    expect(pick(wanted, 'Might Self')!.target).toBe('self');
    // No weapon auras without a wielded weapon kind.
    expect(pick(wanted, 'Aura of')).toBeUndefined();
    // Order: creature attributes, skills, then prots, then banes.
    const order = names(wanted).map((n) => n.replace(/ \d+$/, ''));
    expect(order.indexOf('Might Self')).toBeLessThan(order.indexOf('Smiting Self'));
    expect(order.indexOf('Smiting Self')).toBeLessThan(order.indexOf('Etchward Self'));
    expect(order.indexOf('Etchward Self')).toBeLessThan(order.indexOf('Etchbane'));
  });

  it('the threshold is a setting; exactly power + threshold = skill is castable, one over is not', () => {
    const at = (buffed: number, threshold?: number) => {
      const skills = baseInput().skills.map((s) => (s.id === 31 ? { ...s, buffed } : s));
      const settings: BuffPlanInput['settings'] = threshold === undefined ? {} : { 'SpellDiffExcessThreshold-Buff': threshold };
      return planBuffs(baseInput({ skills, settings })).wanted.find((b) => b.spell.category === 1)?.spell.name;
    };
    expect(at(255)).toBe('Might Self 6');        // 250 + 5 = 255
    expect(at(254)).toBe('Might Self 5');        // 250 + 5 > 254; Giant Grip (260) also out
    expect(at(270)).toBe('Giant Grip');          // the flavour member at 260 is the best castable
    expect(at(254, 4)).toBe('Might Self 6');
    expect(at(5)).toBeUndefined();               // nothing castable: 1 + 5 > 5
  });

  it('never picks an excluded member and only uses spells you know', () => {
    const spells = knowAll().filter((s) => s.category !== 1 || s.id === ODD || s.id === STR[0]);
    const skills = baseInput().skills.map((s) => (s.id === 31 ? { ...s, buffed: 20 } : s));
    const { wanted } = planBuffs(baseInput({ spells, skills }));
    expect(pick(wanted, 'Might Self')!.spell.id).toBe(STR[0]);
    expect(names(wanted)).not.toContain('Odd Boon');
  });

  it('an untrained school buffs only up to BuffWithUntrained-* levels', () => {
    const skills = baseInput().skills.map((s) => (s.id === 32 ? { ...s, training: 'untrained' as const } : s));
    expect(pick(planBuffs(baseInput({ skills, level: 80 })).wanted, 'Etchbane')).toBeDefined();
    expect(pick(planBuffs(baseInput({ skills, level: 81 })).wanted, 'Etchbane')).toBeUndefined();
    expect(pick(planBuffs(baseInput({ skills, level: 120, settings: { 'BuffWithUntrained-Item': 150 } })).wanted, 'Etchbane')).toBeDefined();
    expect(pick(planBuffs(baseInput({ skills })).wanted, 'Etchbane')).toBeDefined(); // level unknown
  });

  it('Extra Buff Spells add a family (best similar), Blacklisted Buff Families remove one', () => {
    // An untrained skill via Extra: you name level 1, the best castable is used (Creature 305 → level 7).
    const extra = planBuffs(baseInput({ extraBuffs: ['Command Self 1'] })).wanted;
    expect(pick(extra, 'Command Self')!.spell.name).toBe('Command Self 7');
    expect(pick(extra, 'Command Self')!.why).toBe('Extra Buff Spells');
    // A name of a level you don't know still finds its family.
    const spells = knowAll().filter((s) => s.name !== 'Command Self 1');
    expect(pick(planBuffs(baseInput({ spells, extraBuffs: ['command self 1'] })).wanted, 'Command Self')).toBeDefined();
    const black = planBuffs(baseInput({ blacklistedBuffs: ['Haste Self 2', 'Etchbane 1'] })).wanted;
    expect(pick(black, 'Haste Self')).toBeUndefined();
    expect(pick(black, 'Etchbane')).toBeUndefined();
    expect(pick(black, 'Might Self')).toBeDefined();
    // Blacklist beats Extra.
    expect(pick(planBuffs(baseInput({ extraBuffs: ['Command Self 1'], blacklistedBuffs: ['Command Self 3'] })).wanted, 'Command Self')).toBeUndefined();
  });

  it('BuffProfile_Prots / _Banes enums pick the elements, Custom reads the letter strings', () => {
    const fams = (settings: BuffPlanInput['settings']) => {
      const w = planBuffs(baseInput({ settings })).wanted;
      return { p: ['Etchward', 'Emberward', 'Thudward'].filter((n) => pick(w, n)), b: ['Etchbane', 'Sparkbane', 'Pinbane'].filter((n) => pick(w, n)) };
    };
    expect(fams({})).toEqual({ p: ['Etchward', 'Emberward', 'Thudward'], b: ['Etchbane', 'Sparkbane', 'Pinbane'] }); // 2 All
    expect(fams({ BuffProfile_Prots: 3, BuffProfile_Banes: 3 })).toEqual({ p: [], b: [] });                            // None
    expect(fams({ BuffProfile_Prots: 4, BuffProfile_Banes: 5 })).toEqual({ p: ['Thudward'], b: ['Pinbane'] });          // B / BPS
    expect(fams({ BuffProfile_Prots: 7, BuffProfile_Banes: 8 })).toEqual({ p: ['Etchward', 'Emberward'], b: ['Etchbane', 'Sparkbane'] }); // ALFC both
    expect(fams({ BuffProfile_Prots: 8, BuffProfile_Banes: 7 })).toEqual({ p: ['Etchward', 'Thudward'], b: ['Etchbane', 'Pinbane'] });    // BPSAC both
    expect(fams({ BuffProfile_Prots: 1, 'BuffProfile-Prots': 'fb', BuffProfile_Banes: 1, 'BuffProfile-Banes': 'L' })).toEqual({ p: ['Emberward', 'Thudward'], b: ['Sparkbane'] });
    // Custom with the default letters (ALFCBPS) is everything; names are case-insensitive.
    expect(fams({ buffprofile_prots: '1' })).toEqual({ p: ['Etchward', 'Emberward', 'Thudward'], b: ['Etchbane', 'Sparkbane', 'Pinbane'] });
  });

  it('weapon auras follow the wielded weapon kind', () => {
    const melee = planBuffs(baseInput({ wielded: 'melee' })).wanted;
    expect(pick(melee, 'Aura of Thirst')!.target).toBe('weapon');
    expect(pick(melee, 'Aura of Focus')).toBeUndefined();
    const caster = planBuffs(baseInput({ wielded: 'caster' })).wanted;
    expect(pick(caster, 'Aura of Focus')).toBeDefined();
    expect(pick(caster, 'Aura of Thirst')).toBeUndefined();
    expect(BLOOD.length + HERM.length).toBe(16);
  });
});

describe('planBuffs: what is due', () => {
  const up = (prefix: string, remaining: number, by: 'category' | 'id' | 'name' = 'category') => {
    const s = planBuffs(baseInput()).wanted.find((b) => b.spell.name.startsWith(prefix))!.spell;
    return by === 'category' ? { name: s.name, category: s.category, power: s.power, remaining }
      : by === 'id' ? { spellId: s.id, name: '', remaining } : { name: s.name, remaining };
  };

  it('missing buffs are due; one with less than RebuffTimeRemainingSeconds (300) left is due, more is not', () => {
    const active = [up('Might Self', 299), up('Haste Self', 300, 'id'), up('Smiting Self', 3000, 'name')];
    const { wanted, due } = planBuffs(baseInput({ active }));
    expect(pick(wanted, 'Might Self')!.remaining).toBe(299);
    expect(pick(due, 'Might Self')).toBeDefined();
    expect(pick(due, 'Haste Self')).toBeUndefined();
    expect(pick(due, 'Smiting Self')).toBeUndefined();
    expect(pick(due, 'Etchward Self')!.remaining).toBeNull();
    expect(pick(planBuffs(baseInput({ active, settings: { RebuffTimeRemainingSeconds: 400 } })).due, 'Haste Self')).toBeDefined();
  });

  it('when idle with IdleBuffTopoff on, less than IdleBuffTopoffTimeSeconds (1200) is due', () => {
    const active = [up('Might Self', 1199), up('Haste Self', 1200)];
    expect(pick(planBuffs(baseInput({ active, idle: true })).due, 'Might Self')).toBeUndefined(); // top-off off
    const on = planBuffs(baseInput({ active, idle: true, settings: { IdleBuffTopoff: true } })).due;
    expect(pick(on, 'Might Self')).toBeDefined();
    expect(pick(on, 'Haste Self')).toBeUndefined();
    expect(pick(planBuffs(baseInput({ active, idle: false, settings: { IdleBuffTopoff: true } })).due, 'Might Self')).toBeUndefined();
    expect(pick(planBuffs(baseInput({ active, idle: true, settings: { IdleBuffTopoff: true, IdleBuffTopoffTimeSeconds: 1300 } })).due, 'Haste Self')).toBeDefined();
  });

  it('a weaker enchantment of the family does not count; a stronger one does', () => {
    const weak = { name: 'Might Self 2', category: 1, power: 50, remaining: 5000 };
    expect(pick(planBuffs(baseInput({ active: [weak] })).due, 'Might Self')).toBeDefined();
    const strong = { name: 'Someone\'s Might', category: 1, power: 400, remaining: 5000 };
    expect(pick(planBuffs(baseInput({ active: [strong] })).due, 'Might Self')).toBeUndefined();
  });

  it('with Enable Buffing off nothing is due', () => {
    const r = planBuffs(baseInput({ settings: { EnableBuffing: false } }));
    expect(r.wanted.length).toBeGreaterThan(0);
    expect(r.due).toEqual([]);
  });
});

// ── the real tables ──

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const DM_PORTAL = resolve(REPO, 'dat/sets/classic-dereth/client_portal.dat');
const AC1999_PORTAL = resolve(REPO, 'dat/sets/ac1999-retail/portal.dat');
const WORLD_DB = resolve(REPO, 'dat/world.sqlite');

const readTables = (path: string, era1999 = false) => {
  const db = openDat(path);
  const raw = db.getFileData(0x0e00000e)!;
  const spells = new SpellTable(new DatReader(era1999 ? transcodeSpellTable1999(raw) : raw));
  let skills: Array<[number, string]> = [];
  try { skills = [...new SkillTable(new DatReader(db.getFileData(0x0e000004)!)).skills].map(([id, s]) => [id, s.name]); } catch { /* the 1999 SkillTable is another format */ }
  return { spells, skills };
};
const categoryOf = (t: SpellTable, name: string): number => {
  const hit = [...t.spells.values()].find((s) => s.name === name);
  if (!hit) throw new Error(`no spell ${name}`);
  return hit.category;
};

describe.skipIf(!existsSync(PORTAL))('end-of-retail SpellTable families', () => {
  let t: SpellTable;
  let f: BuffFamilies;
  beforeAll(() => {
    const r = readTables(PORTAL);
    t = r.spells;
    f = buildBuffFamilies(t, r.skills);
  });

  it('Strength Self → Strength, Heavy Weapon Mastery Self → skill 44, Acid Protection Self → A, Acid Bane → A, Blood Drinker aura → weapon damage', () => {
    expect(f.byCategory.get(categoryOf(t, 'Strength Self I'))!.target).toEqual({ kind: 'attribute', attribute: 'Strength' });
    expect(f.byCategory.get(categoryOf(t, 'Willpower Self I'))!.target).toEqual({ kind: 'attribute', attribute: 'Self' });
    expect(f.byCategory.get(categoryOf(t, 'Heavy Weapon Mastery Self I'))!.target).toEqual({ kind: 'skill', skill: 'Heavy Weapons', skillId: 44 });
    expect(f.byCategory.get(categoryOf(t, 'Monster Attunement Self I'))!.target).toMatchObject({ kind: 'skill', skillId: 27 });
    expect(f.byCategory.get(categoryOf(t, 'Acid Protection Self I'))!.target).toEqual({ kind: 'protection', element: 'A' });
    expect(f.byCategory.get(categoryOf(t, 'Blade Protection Self I'))!.target).toEqual({ kind: 'protection', element: 'S' });
    expect(f.byCategory.get(categoryOf(t, 'Acid Bane I'))!.target).toEqual({ kind: 'bane', element: 'A' });
    expect(f.byCategory.get(categoryOf(t, 'Impenetrability I'))!.target).toEqual({ kind: 'armorValue' });
    expect(f.byCategory.get(categoryOf(t, 'Aura of Blood Drinker Self I'))!.target).toEqual({ kind: 'weapon', aura: 'damage' });
    expect(f.byCategory.get(categoryOf(t, 'Weave of Alchemy I'))!.target.kind).toBe('other');
    // Every one of the 7 prot and 7 bane elements has a family.
    const els = (kind: string) => new Set([...f.byCategory.values()].flatMap((x) => (x.target.kind === kind && 'element' in x.target ? [x.target.element] : [])));
    expect([...els('protection')].sort().join('')).toBe('ABCFLPS');
    expect([...els('bane')].sort().join('')).toBe('ABCFLPS');
  });

  it('a level-200-ish creature/item mage with Heavy Weapons gets each family at its best castable level', () => {
    const known = [...t.spells].filter(([, s]) => /^(Strength Self [IV]+|Might of the Lugians|Incantation of Strength Self|Heavy Weapon Mastery Self [IV]+|Acid Bane [IV]+|Leadership Mastery Self [IV]+)$/.test(s.name));
    const school: Record<number, string> = { 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment' };
    const spells: PlanSpell[] = known.map(([id, s]) => ({ id, name: s.name, school: school[s.school], category: s.category, power: s.power, self: !!(s.bitfield & 8), buff: true, duration: s.duration ?? 0 }));
    const run = (creature: number) => planBuffs({
      spells, active: [], settings: {}, extraBuffs: [], blacklistedBuffs: [], idle: false, families: f,
      skills: [sk(31, 'Creature Enchantment', 'specialized', creature), sk(32, 'Item Enchantment', 'trained', 260), sk(44, 'Heavy Weapons', 'trained', 200), sk(35, 'Leadership', 'untrained', 10)],
    }).wanted;
    // The table's own powers: VI 250, VII (Might of the Lugians) 300, VIII (Incantation) 400.
    const power = (n: string) => [...t.spells.values()].find((s) => s.name === n)!.power;
    expect([power('Strength Self VI'), power('Might of the Lugians'), power('Incantation of Strength Self')]).toEqual([250, 300, 400]);
    expect(names(run(300))).toEqual(['Strength Self VI', 'Heavy Weapon Mastery Self VI', 'Acid Bane VI']); // 300 + 5 > 300
    expect(names(run(305))).toEqual(['Might of the Lugians', 'Heavy Weapon Mastery Self VII', 'Acid Bane VI']); // the EoL table names this VII "Self VII"
    expect(names(run(405))[0]).toBe('Incantation of Strength Self');
  });
});

describe.skipIf(!existsSync(PORTAL) || !existsSync(WORLD_DB))('families agree with ACE world-DB stat mods', () => {
  // ACE PropertyAttribute; PropertyFloat Resist* (prots) and ArmorModVs* (banes).
  const ATTR: Record<string, number> = { Strength: 1, Endurance: 2, Quickness: 3, Coordination: 4, Focus: 5, Self: 6 };
  const PROT: Record<string, number> = { S: 64, P: 65, B: 66, F: 67, C: 68, A: 69, L: 70 };
  const BANE: Record<string, number> = { S: 13, P: 14, B: 15, C: 16, F: 17, A: 18, L: 19 };
  let t: SpellTable;
  let f: BuffFamilies;
  let modKey: (id: number) => { type: number; key: number } | undefined;
  beforeAll(() => {
    t = readTables(PORTAL).spells;
    f = buildBuffFamilies(t);
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const w = new Database(WORLD_DB, { readonly: true });
    const q = w.prepare('select stat_Mod_Type t, stat_Mod_Key k from spell where id = ?');
    modKey = (id) => { const r = q.get(id) as { t: number | null; k: number | null } | undefined; return r && r.t ? { type: r.t >>> 0, key: r.k ?? 0 } : undefined; };
  });

  it('every attribute, protection and bane family names the key most of its spells modify', () => {
    let checked = 0;
    for (const fam of f.byCategory.values()) {
      const tg = fam.target;
      const want = tg.kind === 'attribute' ? ATTR[tg.attribute] : tg.kind === 'protection' ? PROT[tg.element] : tg.kind === 'bane' ? BANE[tg.element] : undefined;
      if (want === undefined) continue;
      const counts = new Map<number, number>();
      for (const [id, s] of t.spells) {
        if (s.category !== fam.category || fam.exclude.has(id)) continue;
        const m = modKey(id);
        // Attribute (0x1), Float (0x8) stat types; skip spells the world DB lacks.
        if (!m) continue;
        const ok = tg.kind === 'attribute' ? m.type & 0x1 : m.type & 0x8;
        if (ok) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (!top) continue; // no world-DB rows for this category (e.g. a one-spell quest family)
      expect(top?.[0], `category ${fam.category} ${JSON.stringify(tg)}`).toBe(want);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(50); // 53 in the end-of-retail table
  });
});

describe.skipIf(!existsSync(DM_PORTAL))('Dark Majesty-era SpellTable families', () => {
  it('weapon masteries are the classic skills: Sword Mastery Self → skill 11 (Sword)', () => {
    const r = readTables(DM_PORTAL);
    const f = buildBuffFamilies(r.spells, r.skills);
    expect(f.byCategory.get(categoryOf(r.spells, 'Sword Mastery Self I'))!.target).toEqual({ kind: 'skill', skill: 'Sword', skillId: 11 });
    expect(f.byCategory.get(categoryOf(r.spells, 'Strength Self I'))!.target).toEqual({ kind: 'attribute', attribute: 'Strength' });
  });
});

describe.skipIf(!existsSync(AC1999_PORTAL))('AC1999 SpellTable families', () => {
  it('builds from the 1999 table: Sword Mastery Self → Sword, prots and banes by element, Defender → weapon defense', () => {
    const r = readTables(AC1999_PORTAL, true);
    const f = buildBuffFamilies(r.spells, r.skills);
    expect(f.byCategory.get(categoryOf(r.spells, 'Sword Mastery Self I'))!.target).toMatchObject({ kind: 'skill', skill: 'Sword' });
    expect(f.byCategory.get(categoryOf(r.spells, 'Fire Protection Self I'))!.target).toEqual({ kind: 'protection', element: 'F' });
    expect(f.byCategory.get(categoryOf(r.spells, 'Frost Bane I'))!.target).toEqual({ kind: 'bane', element: 'C' });
    expect(f.byCategory.get(categoryOf(r.spells, 'Defender I'))!.target).toEqual({ kind: 'weapon', aura: 'defense' });
    // Matched by name when the era's skill table gives no ids.
    const known = [...r.spells.spells].filter(([, s]) => /^Sword Mastery Self [IV]+$/.test(s.name))
      .map(([id, s]): PlanSpell => ({ id, name: s.name, school: 'Creature Enchantment', category: s.category, power: s.power, self: true, buff: true, duration: s.duration ?? 0 }));
    const w = planBuffs({ spells: known, skills: [sk(31, 'Creature Enchantment', 'trained', 160), sk(11, 'Sword', 'trained', 100)], active: [], settings: {}, extraBuffs: [], blacklistedBuffs: [], idle: false, families: f }).wanted;
    expect(names(w)).toEqual(['Sword Mastery Self IV']);
  });
});

// Keep the synthetic family lists referenced (each is a whole family at the eight powers).
it('the synthetic families span the eight FAQ powers', () => {
  for (const fam of [STR, QUICK, HEAVY, LEAD, ASSESS, ACID_P, FIRE_P, BLUD_P, ACID_B, ELEC_B, PIERCE_B]) expect(fam.length).toBe(LEVELS.length);
});
