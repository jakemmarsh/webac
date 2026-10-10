/**
 * The VTank recharge planner (packages/renderer/src/agent/macro/rechargePlan.ts):
 * the RechargeHandlerSet order per vital and stance, the 15 % tier, kit choice
 * by ACE's Healer skill check (MinimumHealKitSuccessChance floor, fewest
 * charges on a tie), the Stamina/Mana to Health multipliers, Top-off vs combat
 * levels, spell level by the Hunt threshold, the Helper; plus families built
 * from the real EoL and 1999 SpellTables (0x0E00000E).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyFloat, PropertyInt, SkillId, type PlanItem, type PlanSkill, type PlanSpell, type Stance } from '@ac/shared';
import {
  buildRechargeFamilies,
  kitSuccessChance,
  planRecharge,
  skillChance,
  RECHARGE_HANDLER_SET,
  type RechargeFamilies,
  type RechargeInput,
} from '../packages/renderer/src/agent/macro/rechargePlan.js';
import { openDat } from './_harness/dat.js';

// ── a synthetic spell table (descs in the DAT's wording) ──
type Row = { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc: string };
const SELF = 0xc;
const OTHER = 0x4;
const TABLE: Map<number, Row> = new Map([
  [1, { name: 'Heal Self', category: 67, school: 2, bitfield: SELF, power: 100, desc: "Restores 20-45 points of the caster's Health." }],
  [2, { name: 'Revitalize Self', category: 81, school: 2, bitfield: SELF, power: 100, desc: "Restores 30-60 points of the caster's Stamina." }],
  [3, { name: 'Stamina to Health Self', category: 89, school: 2, bitfield: SELF, power: 100, desc: "Drains one-half of the caster's Stamina and gives 110% of that to his/her Health (maximum of 150)." }],
  [4, { name: 'Mana to Health Self', category: 91, school: 2, bitfield: SELF, power: 100, desc: "Drains one-half of the caster's Mana and gives 110% of that to his/her Health (maximum of 150)." }],
  [5, { name: 'Stamina to Mana Self', category: 89, school: 2, bitfield: SELF, power: 100, desc: "Drains one-half of the caster's Stamina and gives 110% of that to his/her Mana (maximum of 150)." }],
  [6, { name: 'Heal Other', category: 79, school: 2, bitfield: OTHER, power: 100, desc: "Restores 20-45 points of the target's Health." }],
  [7, { name: 'Heal Self Big', category: 67, school: 2, bitfield: SELF, power: 300, desc: "Restores 80-150 points of the caster's Health." }],
  [8, { name: 'Healing Mastery Self', category: 67, school: 2, bitfield: SELF, power: 100, duration: 1800, desc: "Increases the caster's Healing skill by 20 points." }],
]);
const FAM: RechargeFamilies = buildRechargeFamilies({ spells: TABLE });
const spell = (id: number): PlanSpell => {
  const s = TABLE.get(id)!;
  return { id, name: s.name, school: 'Life Magic', category: s.category, power: s.power, self: (s.bitfield & 8) !== 0, buff: !!s.duration, duration: s.duration ?? 0 };
};
const ALL_SPELLS = [...TABLE.keys()].map(spell);

const skill = (id: number, buffed: number, training: PlanSkill['training'] = 'specialized'): PlanSkill => ({ id, name: String(id), training, base: buffed, buffed });
const SKILLS = (life = 150, healing = 200): PlanSkill[] => [skill(SkillId.LifeMagic, life), skill(SkillId.Healing, healing)];

const kit = (guid: number, name: string, vital: 2 | 4 | 6, boost: number, healkitMod: number, uses?: number): PlanItem => ({
  guid, name,
  ints: { [PropertyInt.BoosterEnum]: vital, [PropertyInt.BoostValue]: boost, [PropertyInt.ItemUseable]: 2228232, ...(uses !== undefined ? { [PropertyInt.Structure]: uses } : {}) } as Record<number, number>,
  floats: { [PropertyFloat.HealkitMod]: healkitMod },
});
const food = (guid: number, name: string, vital: 2 | 4 | 6, boost: number): PlanItem => ({
  guid, name, stack: 5, ints: { [PropertyInt.BoosterEnum]: vital, [PropertyInt.BoostValue]: boost, [PropertyInt.ItemUseable]: 8 },
});

function input(over: Partial<RechargeInput> & { hp?: number; st?: number; mn?: number; max?: number } = {}): RechargeInput {
  const max = over.max ?? 400;
  return {
    vitals: { health: { cur: over.hp ?? max, max }, stamina: { cur: over.st ?? max, max }, mana: { cur: over.mn ?? max, max } },
    stance: 'magic' as Stance,
    hasTarget: true,
    settings: {},
    spells: ALL_SPELLS,
    skills: SKILLS(),
    consumables: [],
    rechargeFamilies: FAM,
    ...over,
  };
}
const castName = (a: ReturnType<typeof planRecharge>): string | undefined => (a?.kind === 'cast' ? a.spell.name : undefined);

describe('buildRechargeFamilies (synthetic table)', () => {
  it('reads kind, self, amounts from the description; skips enchantments', () => {
    expect(FAM.bySpell.get(1)).toMatchObject({ kind: 'heal', self: true, dest: 'health', boost: { min: 20, max: 45 } });
    expect(FAM.bySpell.get(3)).toMatchObject({ kind: 'stam-to-health', self: true, source: 'stamina', dest: 'health', transfer: { proportion: 0.5, give: 1.1, cap: 150 } });
    expect(FAM.bySpell.get(5)).toMatchObject({ kind: 'stam-to-mana', dest: 'mana' });
    expect(FAM.bySpell.get(6)).toMatchObject({ kind: 'heal', self: false });
    expect(FAM.bySpell.has(8)).toBe(false);
  });
});

describe('ACE kit success chance', () => {
  it('matches Healer.DoSkillCheck + SkillCheck.GetSkillChance', () => {
    expect(skillChance(100, 100)).toBeCloseTo(0.5, 10);
    // spec 200 + kit 100 → round(450); missing 120 in a combat stance → round(264)
    const spec = skill(SkillId.Healing, 200);
    expect(kitSuccessChance(spec, 100, 120, 'magic')).toBeCloseTo(1 - 1 / (1 + Math.exp(0.03 * (450 - 264))), 12);
    // peace: difficulty 240; trained ×1.1: round(330)
    expect(kitSuccessChance(skill(SkillId.Healing, 200, 'trained'), 100, 120, 'peace')).toBeCloseTo(1 - 1 / (1 + Math.exp(0.03 * (330 - 240))), 12);
    expect(kitSuccessChance(skill(SkillId.Healing, 200, 'untrained'), 100, 10, 'peace')).toBe(0);
  });
});

describe('planRecharge', () => {
  it('has 26 handler rows, as VTank stores', () => expect(RECHARGE_HANDLER_SET).toHaveLength(26));

  it('does nothing when every vital is fine', () => {
    expect(planRecharge(input())).toBeNull();
    expect(planRecharge(input({ hp: 320, st: 220, mn: 220 }))).toBeNull(); // 80 / 55 / 55 % vs 75 / 50 / 50
  });

  it('health, magic, 15 % tier: Stamina to Health when it beats heal × 1.9, before any kit', () => {
    const kits = [kit(10, 'Kit', 2, 100, 1.6, 50)];
    // stamina 400: src 200 → capped 150 → 165 → cap 150 ≥ 32.5 × 1.9
    const a = planRecharge(input({ hp: 40, consumables: kits }));
    expect(castName(a)).toBe('Stamina to Health Self');
    expect(a!.why).toContain('Stamina to Health');
  });

  it('health, magic, 15 % tier: Mana to Health needs heal × 2.8; else Heal Self', () => {
    const kits = [kit(10, 'Kit', 2, 100, 1.6, 50)];
    // stamina 100 → 50 → 55 < 61.75; mana 200 → 100 → 110 < 91? no: 110 ≥ 91 → Mana to Health
    expect(castName(planRecharge(input({ hp: 40, st: 100, mn: 200, consumables: kits })))).toBe('Mana to Health Self');
    // mana 120 → 60 → 66 < 91 → Heal Self (the kit waits below 15 %)
    expect(castName(planRecharge(input({ hp: 40, st: 100, mn: 120, consumables: kits })))).toBe('Heal Self');
    // a lower multiplier lets the weak transfer through
    expect(castName(planRecharge(input({ hp: 40, st: 100, mn: 120, settings: { StaminaToHealthMultiplier: 1.5 } })))).toBe('Stamina to Health Self');
  });

  it('health, magic, above 15 %: a favourable kit first; UseKitsInMagicMode off skips it', () => {
    const kits = [kit(10, 'Kit', 2, 100, 1.6, 50)];
    const a = planRecharge(input({ hp: 280, st: 100, mn: 100, consumables: kits }));
    expect(a).toMatchObject({ kind: 'use', item: { guid: 10 } });
    expect(castName(planRecharge(input({ hp: 280, st: 100, mn: 100, consumables: kits, settings: { UseKitsInMagicMode: 'false' } })))).toBe('Heal Self');
  });

  it('kits: the success floor, then highest HealkitMod, then fewest charges', () => {
    const kits = [
      kit(10, 'A', 2, 100, 1.6, 50),
      kit(11, 'B', 2, 100, 1.6, 10),
      kit(12, 'C', 2, 0, 2.0, 5), // round(300) vs 264: ~75 %, under 95 %
      food(13, 'Not a kit', 2, 500),
    ];
    const at = { hp: 280, st: 100, mn: 100, consumables: kits };
    expect(planRecharge(input(at))).toMatchObject({ kind: 'use', item: { guid: 11 } });
    expect(planRecharge(input({ ...at, settings: { MinimumHealKitSuccessChance: 70 } }))).toMatchObject({ kind: 'use', item: { guid: 12 } });
    // an untrained healer has no favourable kit: the next row
    expect(castName(planRecharge(input({ ...at, consumables: kits.slice(0, 3), skills: [skill(SkillId.LifeMagic, 150), skill(SkillId.Healing, 200, 'untrained')] })))).toBe('Heal Self');
  });

  it('GoToPeaceModeToUseKits: change to peace first, then use the kit', () => {
    const kits = [kit(10, 'Kit', 2, 100, 1.6, 50)];
    const s = { GoToPeaceModeToUseKits: true };
    expect(planRecharge(input({ hp: 280, stance: 'melee', consumables: kits, settings: s }))).toMatchObject({ kind: 'stance', to: 'peace' });
    expect(planRecharge(input({ hp: 280, stance: 'peace', consumables: kits, settings: s }))).toMatchObject({ kind: 'use', item: { guid: 10 } });
  });

  it('health, peace/melee/missile: food below 15 %, then kit, food, Stamina to Health at ≤10 %, Heal Self (stance change)', () => {
    const kits = [kit(10, 'Kit', 2, 100, 1.6, 50)];
    const apple = food(20, 'Apple', 2, 30);
    expect(planRecharge(input({ hp: 40, stance: 'melee', consumables: [...kits, apple] }))).toMatchObject({ kind: 'use', item: { guid: 20 } });
    expect(planRecharge(input({ hp: 280, stance: 'melee', consumables: [...kits, apple] }))).toMatchObject({ kind: 'use', item: { guid: 10 } });
    expect(planRecharge(input({ hp: 280, stance: 'missile', consumables: [apple] }))).toMatchObject({ kind: 'use', item: { guid: 20 } });
    const low = planRecharge(input({ hp: 36, stance: 'peace' })); // 9 %
    expect(low).toMatchObject({ kind: 'stance', to: 'magic' });
    expect(low!.why).toContain('Stamina to Health');
    const mid = planRecharge(input({ hp: 48, stance: 'peace' })); // 12 %: the ≤10 % row is out
    expect(mid).toMatchObject({ kind: 'stance', to: 'magic' });
    expect(mid!.why).toContain('Regular Spell (Heal Self)');
  });

  it('food: the smallest that covers the missing amount, else the largest', () => {
    const foods = [food(20, 'Small', 2, 30), food(21, 'Mid', 2, 150), food(22, 'Big', 2, 300)];
    expect(planRecharge(input({ hp: 280, stance: 'melee', consumables: foods }))).toMatchObject({ item: { guid: 21 } }); // missing 120
    expect(planRecharge(input({ hp: 20, stance: 'melee', consumables: foods }))).toMatchObject({ item: { guid: 22 } }); // missing 380
  });

  it('stamina: magic = kit, Revitalize, food; other stances = kit, food, spell', () => {
    const stKit = kit(30, 'Stamina Kit', 4, 100, 1.6, 20);
    const stFood = food(31, 'Stamina Elixir', 4, 100);
    // missing 250 → difficulty 550: Healing 400 + 100 spec → 750
    expect(planRecharge(input({ st: 150, skills: SKILLS(150, 400), consumables: [stKit, stFood] }))).toMatchObject({ kind: 'use', item: { guid: 30 } });
    expect(castName(planRecharge(input({ st: 150, consumables: [stFood] })))).toBe('Revitalize Self');
    expect(planRecharge(input({ st: 150, stance: 'melee', consumables: [stFood] }))).toMatchObject({ kind: 'use', item: { guid: 31 } });
    expect(planRecharge(input({ st: 150, stance: 'melee' }))).toMatchObject({ kind: 'stance', to: 'magic' });
  });

  it('mana: kit, food, then Stamina to Mana', () => {
    const mnFood = food(40, 'Mana Potion', 6, 100);
    expect(planRecharge(input({ mn: 150, consumables: [mnFood] }))).toMatchObject({ kind: 'use', item: { guid: 40 } });
    expect(castName(planRecharge(input({ mn: 150 })))).toBe('Stamina to Mana Self');
  });

  it('with a target: Heal at; with none: the higher of Heal at and Top-off (top-off raises the bar)', () => {
    expect(planRecharge(input({ hp: 320, hasTarget: false }))).toBeNull(); // 80 % vs Heal at 75 / Top-off 1
    expect(planRecharge(input({ hp: 120, st: 100, mn: 100, hasTarget: false }))).not.toBeNull(); // 30 %: below Heal at, nothing near
    expect(planRecharge(input({ hp: 300, hasTarget: false, settings: { 'Recharge-Norm-HitP': 75, 'Recharge-NoTarg-HitP': 1 } }))).toBeNull(); // 75 %
    expect(planRecharge(input({ hp: 320, hasTarget: false, settings: { 'recharge-notarg-hitp': 90 } }))).not.toBeNull();
    expect(planRecharge(input({ hp: 320 }))).toBeNull(); // 80 % vs 75 %
    expect(planRecharge(input({ hp: 280, st: 100, mn: 100 }))).not.toBeNull(); // 70 %
  });

  it('spell level: highest power with power + SpellDiffExcessThreshold-Hunt ≤ buffed Life Magic', () => {
    const at = { hp: 280, st: 100, mn: 100 };
    expect(castName(planRecharge(input({ ...at, skills: SKILLS(150) })))).toBe('Heal Self');
    expect(castName(planRecharge(input({ ...at, skills: SKILLS(325) })))).toBe('Heal Self Big');
    expect(castName(planRecharge(input({ ...at, skills: SKILLS(324) })))).toBe('Heal Self');
    expect(castName(planRecharge(input({ ...at, skills: SKILLS(325), settings: { 'SpellDiffExcessThreshold-Hunt': 30 } })))).toBe('Heal Self');
    expect(planRecharge(input({ ...at, skills: SKILLS(100) }))).toBeNull(); // 100 + 25 > 100
  });

  it('only listed, examined consumables count', () => {
    const unexamined: PlanItem = { guid: 50, name: 'Healing Kit' };
    expect(planRecharge(input({ hp: 280, stance: 'melee', consumables: [unexamined], spells: [] }))).toBeNull();
  });

  it('Helper: heals a fellow below Recharge-Helper-HitP within range', () => {
    const fellow = { guid: 77, name: 'Pal', distance: 20, health: { cur: 30, max: 300 }, stamina: { cur: 300, max: 300 }, mana: { cur: 300, max: 300 } };
    const a = planRecharge(input({ fellows: [fellow] }));
    expect(a).toMatchObject({ kind: 'cast', target: 77, spell: { name: 'Heal Other' } });
    expect(planRecharge(input({ fellows: [{ ...fellow, distance: 200 }] }))).toBeNull();
    expect(planRecharge(input({ fellows: [fellow], settings: { DoHelp: false } }))).toBeNull();
  });
});

// ── the real spell tables ──
const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const PORTAL_1999 = resolve(__dirname, '../dat/sets/ac1999-retail/portal.dat');

describe.skipIf(!existsSync(PORTAL))('families from the EoL SpellTable 0x0E00000E (needs DAT files)', () => {
  let fam: RechargeFamilies;
  let table: { spells: Map<number, { name: string; desc: string; category: number; power: number; bitfield: number }> };
  const id = (name: string): number => [...table.spells].find(([, s]) => s.name === name)![0];
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!));
    fam = buildRechargeFamilies(table as never);
  });

  it('classifies the self recharge lines', () => {
    expect(fam.bySpell.get(id('Heal Self I'))).toMatchObject({ kind: 'heal', self: true, boost: { min: 10, max: 25 } });
    expect(fam.bySpell.get(id('Revitalize Self I'))).toMatchObject({ kind: 'revitalize', self: true });
    expect(fam.bySpell.get(id('Mana Boost Self I'))).toMatchObject({ kind: 'mana', self: true });
    // ACE spell 1664: proportion 0.5, loss 0.1, cap 50
    expect(fam.bySpell.get(id('Stamina to Health Self I'))).toMatchObject({ kind: 'stam-to-health', self: true, transfer: { proportion: 0.5, give: 0.9, cap: 50 } });
    expect(fam.bySpell.get(id('Mana to Health Self I'))).toMatchObject({ kind: 'mana-to-health', self: true });
    expect(fam.bySpell.get(id('Stamina to Mana Self I'))).toMatchObject({ kind: 'stam-to-mana', self: true });
    expect(fam.bySpell.get(id('Health to Mana Self I'))).toMatchObject({ kind: 'health-to-mana' });
    expect(fam.bySpell.has(id('Healing Mastery Self I'))).toBe(false);
    expect(fam.bySpell.get(id('Heal Other I'))).toMatchObject({ kind: 'heal', self: false });
    expect(fam.bySpell.get(id('Stamina to Health Other I'))).toMatchObject({ kind: 'stam-to-health', self: false });
    expect(fam.bySpell.get(id('Infuse Mana Other I'))).toMatchObject({ kind: 'infuse', dest: 'mana', self: false });
    expect(fam.bySpell.get(id('Drain Health Other I'))).toMatchObject({ kind: 'drain' });
  });

  it('one category holds Stamina to Health and Stamina to Mana, so families are per spell', () => {
    const a = table.spells.get(id('Stamina to Health Self I'))!;
    const b = table.spells.get(id('Stamina to Mana Self I'))!;
    expect(a.category).toBe(b.category);
  });

  it('every self heal line climbs in power, and the planner casts the right level', () => {
    const heals = [...fam.bySpell].filter(([, f]) => f.kind === 'heal' && f.self).map(([i]) => table.spells.get(i)!);
    expect(heals.length).toBeGreaterThanOrEqual(7);
    const spells: PlanSpell[] = heals.map((s) => ({ id: id(s.name), name: s.name, school: 'Life Magic', category: s.category, power: s.power, self: true, buff: false, duration: 0 }));
    const a = planRecharge(input({ hp: 280, st: 50, mn: 50, spells, rechargeFamilies: fam, skills: SKILLS(275) }));
    expect(castName(a)).toBe('Heal Self VI'); // power 250 + 25 ≤ 275 < 300 + 25
  });
});

describe.skipIf(!existsSync(PORTAL_1999))('families from the 1999 SpellTable (needs the AC1999 DAT set)', () => {
  let fam: RechargeFamilies;
  let table: { spells: Map<number, { name: string; category: number }> };
  const id = (name: string): number => [...table.spells].find(([, s]) => s.name === name)![0];
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { transcodeSpellTable1999 } = await import('../packages/dat-parser/src/era1999/Tables1999.js');
    table = new SpellTable(new DatReader(transcodeSpellTable1999(openDat(PORTAL_1999).getFileData(0x0e00000e)!)));
    fam = buildRechargeFamilies(table as never);
  });

  it('Revitalize Self and Mana Boost Self share a 1999 category but not a family', () => {
    expect(table.spells.get(id('Revitalize Self I'))!.category).toBe(table.spells.get(id('Mana Boost Self I'))!.category);
    expect(fam.bySpell.get(id('Revitalize Self I'))).toMatchObject({ kind: 'revitalize', self: true, boost: { min: 11, max: 20 } });
    expect(fam.bySpell.get(id('Mana Boost Self I'))).toMatchObject({ kind: 'mana', self: true });
    expect(fam.bySpell.get(id('Heal Self I'))).toMatchObject({ kind: 'heal', self: true, boost: { min: 8, max: 15 } });
    // 1999 transfers: 75 %, no cap
    expect(fam.bySpell.get(id('Stamina to Health Self I'))).toMatchObject({ kind: 'stam-to-health', transfer: { proportion: 0.5, give: 0.75, cap: 0 } });
  });
});
