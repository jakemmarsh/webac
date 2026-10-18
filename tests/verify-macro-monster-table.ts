/**
 * VTank parity bugs §0 #1 and #7 (docs/vtank-parity-gaps.md): Auto damage takes
 * the element the monster is weakest to, from the era's monster table, and the
 * V column vulns that element; the streak (A with S) is a finisher, cast once
 * the monster is hurt enough (facts from openac-mosstank's reading of VTank:
 * CombatController.ResolveAttackElementCore / IsFinishingBlow, MonsterHealthTracker,
 * VtankDamageDatabase). Also the per-era table generator (tools/build-monster-tables.ts),
 * the shipped tables, and the macro reading the table through the agent API.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VT_DAMAGE, VT_DEFAULT_MONSTER, type PlanItem, type PlanSkill, type PlanSpell, type VtMonsterRow } from '@ac/shared';
import {
  ammoFor, blowPoints, buildCombatFamilies, indexMonsterTable, isFinishingBlow, planCombat,
  type CombatInput, type CombatMonster, type CombatSpellTableEntry,
} from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { buildMonsterRows, overlayFiles, parseCreatureSql, weakOrder, type CreatureFacts } from '../tools/build-monster-tables.ts';
import EOL from '../packages/renderer/src/agent/macro/monsters/eol.ts';
import DM from '../packages/renderer/src/agent/macro/monsters/dm.ts';
import AC1999 from '../packages/renderer/src/agent/macro/monsters/ac1999.ts';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { openDat } from './_harness/dat.js';

type Row = [string, string, number, number?, string?];
const SCHOOL_NAME: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 4: 'Creature Enchantment', 5: 'Void Magic' };
// End-of-retail rows (real anchor ids, categories and powers).
const TABLE: Array<[number, CombatSpellTableEntry]> = [
  [21, { name: 'Fire Vulnerability Other I', category: 110, school: 2, bitfield: 0x13, power: 25 }],
  [521, { name: 'Acid Vulnerability Other I', category: 102, school: 2, bitfield: 0x13, power: 25 }],
  [27, { name: 'Flame Bolt I', category: 121, school: 1, bitfield: 0x3, power: 1 }],
  [85, { name: 'Flame Bolt VI', category: 121, school: 1, bitfield: 0x3, power: 250 }],
  [1796, { name: 'Flame Streak I', category: 247, school: 1, bitfield: 0x4003, power: 1 }],
  [1800, { name: 'Flame Streak V', category: 247, school: 1, bitfield: 0x4003, power: 200 }],
  [58, { name: 'Acid Stream I', category: 117, school: 1, bitfield: 0x3, power: 1 }],
];
const FAMILIES = buildCombatFamilies({ spells: new Map(TABLE) });
const spell = (id: number): PlanSpell => {
  const s = new Map(TABLE).get(id)!;
  return { id, name: s.name, school: SCHOOL_NAME[s.school], category: s.category, power: s.power, self: false, buff: false, duration: s.school === 1 ? 0 : 60 };
};
const skill = (id: number, name: string): PlanSkill => ({ id, name, training: 'specialized', base: 400, buffed: 400 });
const SKILLS = [skill(33, 'Life Magic'), skill(31, 'Creature Enchantment'), skill(34, 'War Magic')];
const PLAIN_WAND: PlanItem = { guid: 900, name: 'Wand', itemType: 0x8000, equipped: true };
const row = (extra: Partial<VtMonsterRow> = {}): VtMonsterRow => ({ ...structuredClone(VT_DEFAULT_MONSTER), name: '<DEFAULT>', ...extra });
const mon = (name: string, extra: Partial<CombatMonster> = {}): CombatMonster => ({ guid: 1, name, dist: 3, relBearing: 0, ...extra });
// A fixture table: the Skulker takes most from fire then acid; the Golem from acid; the Wisp is listed with nothing to prefer.
const FACTS = indexMonsterTable([['Drudge Skulker', 'fapbslc', 100], ['Mud Golem', 'apbslcf', 300], ['Wisp', '', 40]]);

function input(over: Partial<CombatInput> = {}): CombatInput {
  return {
    monsters: [mon('Drudge Skulker')], rows: [row({ on: ['A'], damage: VT_DAMAGE.Auto })],
    spells: [spell(27), spell(58), spell(85)], skills: SKILLS, items: [PLAIN_WAND], itemNames: ['Wand'], wielded: { weapon: 'Wand' },
    stance: 'magic', settings: { AttackDistance: 30 }, castLog: [], now: 100_000, selectedGuid: null, families: FAMILIES, monsterFacts: FACTS, ...over,
  };
}

describe('Auto damage: the monster\'s weak element (bug #1)', () => {
  it('a mage bolts with the element the monster is weakest to among the bolts it can cast', () => {
    expect(planCombat(input())).toMatchObject({ kind: 'cast', spell: { id: 85 } }); // fire first for the Skulker
    expect(planCombat(input({ monsters: [mon('mud golem')] }))).toMatchObject({ spell: { id: 58 } }); // acid; names match case-insensitively
    // Fire not castable: the next weak element it can cast.
    expect(planCombat(input({ spells: [spell(58)] }))).toMatchObject({ spell: { id: 58 } });
  });

  it('an unlisted monster (or no table) keeps the old fallback: the first castable bolt in VTank\'s unlisted order (acid before fire)', () => {
    // VTank's rule exactly (WeighBoltsByDamage off).
    const vt = { settings: { AttackDistance: 30, WeighBoltsByDamage: false } };
    expect(planCombat(input({ ...vt, monsters: [mon('Banderling Scout')] }))).toMatchObject({ spell: { id: 58 } });
    expect(planCombat(input({ ...vt, monsterFacts: undefined }))).toMatchObject({ spell: { id: 58 } });
    expect(planCombat(input({ ...vt, monsters: [mon('Wisp')] }))).toMatchObject({ spell: { id: 58 } }); // listed, nothing to prefer
    // Beyond VTank (on by default, 2026-10-18): nothing to prefer between elements, so the strongest bolt you can cast
    // (Flame Bolt VI over Acid Stream I); a level tie still goes to the unlisted order.
    expect(planCombat(input({ monsters: [mon('Banderling Scout')] }))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(input({ monsterFacts: undefined }))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(input({ monsters: [mon('Wisp')] }))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(input({ monsters: [mon('Wisp')], spells: [spell(27), spell(58)] }))).toMatchObject({ spell: { id: 58 } });
  });

  it('the V column vulns the same element Auto attacks with; Prismatic means Auto', () => {
    const vulns = [spell(21), spell(521), spell(27), spell(58)];
    expect(planCombat(input({ rows: [row({ on: ['V', 'A'], damage: VT_DAMAGE.Auto })], spells: vulns }))).toMatchObject({ kind: 'cast', spell: { id: 21 }, why: expect.stringContaining('V on Drudge Skulker') });
    expect(planCombat(input({ rows: [row({ on: ['V', 'A'], damage: VT_DAMAGE.Prismatic })], spells: vulns }))).toMatchObject({ spell: { id: 21 } });
    expect(planCombat(input({ rows: [row({ on: ['V', 'A'], damage: VT_DAMAGE.Auto })], spells: vulns, monsters: [mon('Mud Golem')] }))).toMatchObject({ spell: { id: 521 } });
    // Before the fix every unexamined-wand mage vulned and bolted in enum order whatever the monster.
    expect(planCombat(input({ rows: [row({ on: ['V', 'A'], damage: VT_DAMAGE.Auto })], spells: vulns, monsters: [mon('Banderling Scout')] }))).toMatchObject({ spell: { id: 521 } });
  });

  it('the weapon\'s own element still wins (VTank: the weapon\'s element first); an unexamined melee weapon vulns the weak element', () => {
    const fireWand: PlanItem = { ...PLAIN_WAND, name: 'Fire Wand', ints: { 45: 0x20 } }; // an acid wand, in fact
    expect(planCombat(input({ items: [fireWand], itemNames: ['Fire Wand'], wielded: { weapon: 'Fire Wand' } }))).toMatchObject({ spell: { id: 58 } });
    const sword: PlanItem = { guid: 901, name: 'Sword', itemType: 0x1, equipped: true };
    const melee = input({ rows: [row({ on: ['V', 'A'], damage: VT_DAMAGE.Auto })], spells: [spell(21), spell(521)], items: [sword], itemNames: ['Sword'], wielded: { weapon: 'Sword' }, stance: 'magic' });
    expect(planCombat(melee)).toMatchObject({ kind: 'cast', spell: { id: 21 } });
  });

  it('a bow on Auto loads arrows of the monster\'s weak element it carries, over stronger arrows of another', () => {
    const BOW: PlanItem = { guid: 950, name: 'Bow', itemType: 0x100, ints: { 50: 1 }, equipped: true, slot: 'MissileWeapon' };
    const arrow = (guid: number, name: string, dmg: number, bits: number): PlanItem => ({ guid, name, fits: 'MissileAmmo', stack: 50, ints: { 50: 1, 44: dmg, 45: bits } });
    const items = [BOW, arrow(951, 'Greater Fire Arrow', 12, 0x10), arrow(952, 'Acid Arrow', 9, 0x20)];
    const archer = input({ items, itemNames: [], wielded: { weapon: 'Bow' }, stance: 'missile', spells: [] });
    expect(ammoFor(archer, row({ damage: VT_DAMAGE.Auto }), BOW, mon('Mud Golem'))?.name).toBe('Acid Arrow');
    expect(ammoFor(archer, row({ damage: VT_DAMAGE.Auto }), BOW, mon('Drudge Skulker'))?.name).toBe('Greater Fire Arrow');
    // Unlisted: the best of any element, as before.
    expect(ammoFor(archer, row({ damage: VT_DAMAGE.Auto }), BOW, mon('Banderling Scout'))?.name).toBe('Greater Fire Arrow');
    expect(planCombat({ ...archer, monsters: [mon('Mud Golem')] })).toMatchObject({ kind: 'equip', item: { name: 'Acid Arrow' } });
  });
});

describe('the streak finisher (bug #7)', () => {
  const streaky = (m: CombatMonster, on: VtMonsterRow['on'] = ['A', 'S']) => input({ rows: [row({ on, damage: VT_DAMAGE.Fire })], spells: [spell(85), spell(1800)], monsters: [m] });

  it('A with S: the bolt while the monster is healthy, the streak once its health left is under a seventh of the streak\'s difficulty', () => {
    // Max health 100; Flame Streak V's difficulty 200 → under 28 points.
    expect(planCombat(streaky(mon('Drudge Skulker')))).toMatchObject({ spell: { id: 85 } }); // no report yet: full health
    expect(planCombat(streaky(mon('Drudge Skulker', { health: 0.5 })))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(streaky(mon('Drudge Skulker', { health: 0.2 })))).toMatchObject({ spell: { id: 1800 }, why: expect.stringContaining('finish') });
  });

  it('after a blow lands, the bar is a seventh of that blow instead', () => {
    expect(planCombat(streaky(mon('Drudge Skulker', { health: 0.2, lastDamage: 70 })))).toMatchObject({ spell: { id: 85 } }); // 20 ≥ 10
    expect(planCombat(streaky(mon('Drudge Skulker', { health: 0.2, lastDamage: 210 })))).toMatchObject({ spell: { id: 1800 } }); // 20 < 30
  });

  it('a monster the table doesn\'t list is never finished with a streak; S alone streaks every time', () => {
    expect(planCombat(streaky(mon('Banderling Scout', { health: 0.01 })))).toMatchObject({ spell: { id: 85 } });
    expect(planCombat(streaky(mon('Banderling Scout'), ['S']))).toMatchObject({ spell: { id: 1800 } });
  });

  it('isFinishingBlow: a dead monster (0 left) is not a finisher', () => {
    const i = streaky(mon('Drudge Skulker'));
    expect(isFinishingBlow(i, mon('Drudge Skulker', { health: 0 }), spell(1800))).toBe(false);
    expect(isFinishingBlow(i, mon('Drudge Skulker', { health: 0.05 }), spell(1800))).toBe(true);
  });

  it('reads the blow you landed from the combat line, melee or war magic', () => {
    expect(blowPoints('(combat) You hit Drudge Skulker for 12 points of slashing damage!', 'Drudge Skulker')).toBe(12);
    expect(blowPoints('Critical hit!  You scorch drudge skulker for 1 point with Flame Bolt VI.', 'Drudge Skulker')).toBe(1);
    expect(blowPoints('Drudge Skulker hits you for 12 points of slashing damage!', 'Drudge Skulker')).toBeNull();
    expect(blowPoints('You hit Drudge Slinker for 12 points of slashing damage!', 'Drudge Skulker')).toBeNull();
  });
});

describe('the monster tables (tools/build-monster-tables.ts)', () => {
  const SQL = "INSERT INTO `weenie` (`class_Id`, `class_Name`, `type`, `last_Modified`)\nVALUES (7, 'drudgeskulker', 10, '2005-02-09 10:00:00') /* Creature */;\n\n" +
    "INSERT INTO `weenie_properties_int` (`object_Id`, `type`, `value`)\nVALUES (7,   1,         16) /* ItemType - Creature */\n     , (7,   2,          3) /* CreatureType - Drudge */;\n\n" +
    "INSERT INTO `weenie_properties_bool` (`object_Id`, `type`, `value`)\nVALUES (7,   1, True ) /* Stuck */;\n\n" +
    "INSERT INTO `weenie_properties_float` (`object_Id`, `type`, `value`)\nVALUES (7,  64,    0.86) /* ResistSlash */\n     , (7,  65,    0.75) /* ResistPierce */\n     , (7,  66,    0.66) /* ResistBludgeon */\n     , (7,  67,    1.42) /* ResistFire */\n     , (7,  68,    1.42) /* ResistCold */\n     , (7,  69,    0.75) /* ResistAcid */\n     , (7,  70,    1.42) /* ResistElectric */;\n\n" +
    "INSERT INTO `weenie_properties_string` (`object_Id`, `type`, `value`)\nVALUES (7,   1, 'Drudge Skulker') /* Name */;\n\n" +
    "INSERT INTO `weenie_properties_attribute` (`object_Id`, `type`, `init_Level`, `level_From_C_P`, `c_P_Spent`)\nVALUES (7,   2,  30, 0, 0) /* Endurance */;\n\n" +
    "INSERT INTO `weenie_properties_attribute_2nd` (`object_Id`, `type`, `init_Level`, `level_From_C_P`, `c_P_Spent`, `current_Level`)\nVALUES (7,   1,     5, 0, 0, 20) /* MaxHealth */;\n";

  it('parses an ACE creature weenie: name, Resist* multipliers, max health; NPCs and non-creatures are left out', () => {
    expect(parseCreatureSql(SQL)).toEqual({ name: 'Drudge Skulker', resist: [0.75, 0.66, 0.86, 0.75, 1.42, 1.42, 1.42], maxHealth: 20, species: 3, magicImmune: false, drainImmune: false });
    expect(parseCreatureSql(SQL.replace('(7,   1, True ) /* Stuck */', '(7,  19, False) /* Attackable */'))).toBeNull();
    expect(parseCreatureSql(SQL.replace('16) /* ItemType', '1) /* ItemType'))).toBeNull();
    // No current_Level: init + Endurance / 2.
    expect(parseCreatureSql(SQL.replace('0, 0, 20) /* MaxHealth', '0, 0, 0) /* MaxHealth'))?.maxHealth).toBe(20);
    // VTank's MonsterImmunities, from the creature's own properties: NonProjectileMagicImmune (bool 103), ResistHealthDrain (float 125) 0.
    const immune = SQL.replace('(7,   1, True ) /* Stuck */', '(7,   1, True ) /* Stuck */\n     , (7, 103, True ) /* NonProjectileMagicImmune */')
      .replace('(7,  70,    1.42) /* ResistElectric */', '(7,  70,    1.42) /* ResistElectric */\n     , (7, 125,       0) /* ResistHealthDrain */');
    expect(parseCreatureSql(immune)).toMatchObject({ magicImmune: true, drainImmune: true, species: 3 });
  });

  it('end of retail is the base world with ACE-World-16PY-Patches over it: a patch file replaces the base weenie of its class id', () => {
    const files = overlayFiles([['base/Creature/Drudge/00007 Drudge Skulker.sql', 'base/Creature/Drudge/05196 Drudge Skulker.sql'], ['patch/Creature/Drudge/00007 Drudge Skulker.sql', 'patch/Creature/Drudge/35440 Drudge Skulker.sql']]);
    expect(files.sort()).toEqual(['base/Creature/Drudge/05196 Drudge Skulker.sql', 'patch/Creature/Drudge/00007 Drudge Skulker.sql', 'patch/Creature/Drudge/35440 Drudge Skulker.sql']);
  });

  it('orders elements most damaging first, ties in VTank\'s unlisted order; same-named weenies merge by median', () => {
    expect(weakOrder([0.75, 0.66, 0.86, 0.75, 1.42, 1.42, 1.42])).toBe('lcfspab');
    expect(weakOrder([1, 1, 1, 1, 1, 1, 1])).toBe('');
    const c = (resist: number[], maxHealth: number, extra: Partial<CreatureFacts> = {}): CreatureFacts => ({ name: 'Rat', resist, maxHealth, species: 9, magicImmune: false, drainImmune: false, ...extra });
    expect(buildMonsterRows([c([1, 1, 1, 1, 1, 1, 2], 10), c([1, 1, 1, 1, 1, 1, 2], 30), c([3, 1, 1, 1, 1, 1, 1], 500)])).toEqual([['Rat', 'fpbsalc', 30, 9, '', '2,1,1,1,1,1,1']]);
    // The most common species; an immunity only when most of the same-named weenies have it.
    expect(buildMonsterRows([c([1, 1, 1, 1, 1, 1, 1], 10, { species: 4, drainImmune: true }), c([1, 1, 1, 1, 1, 1, 1], 10, { magicImmune: true, drainImmune: true }), c([1, 1, 1, 1, 1, 1, 1], 10)])[0].slice(3)).toEqual([9, 'd', '']);
  });

  it('the shipped tables: a Drudge Skulker is weakest to lightning, cold and fire in every era', () => {
    for (const t of [EOL, DM, AC1999]) {
      const facts = indexMonsterTable(JSON.parse(t) as Row[]);
      expect(facts('Drudge Skulker')?.weak.slice(0, 3)).toEqual(['lightning', 'cold', 'fire']);
      expect(facts('Drudge Skulker')?.species).toBe(3); // CreatureType Drudge
    }
    // End of retail has the patches' Skulker (42 health, ACE-World-16PY-Patches); Dark Majesty and 1999 their own 20.
    // Before 2026-10-11 end of retail was built from the February 2005 base alone (20, and 1387 names, not 2800+).
    expect(indexMonsterTable(JSON.parse(EOL) as Row[])('Drudge Skulker')?.maxHealth).toBe(42);
    expect(indexMonsterTable(JSON.parse(DM) as Row[])('Drudge Skulker')?.maxHealth).toBe(20);
    expect(indexMonsterTable(JSON.parse(AC1999) as Row[])('Drudge Skulker')?.maxHealth).toBe(20);
    expect((JSON.parse(EOL) as Row[]).length).toBeGreaterThan(2500);
    expect((JSON.parse(AC1999) as Row[]).length).toBeGreaterThan(150);
    // 1999 knows only its own monsters (no Olthoi Ripper Hive Warrior etc.): the era's own world.
    expect(indexMonsterTable(JSON.parse(AC1999) as Row[])('Tusker Guard')?.weak[0]).toBe('pierce');
  });
});

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

describe.skipIf(!existsSync(PORTAL))('the macro reads the era\'s monster table through the agent API (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const known = ['Flame Bolt I', 'Force Bolt I', 'Lightning Bolt I', 'Lightning Vulnerability Other I', 'Piercing Vulnerability Other I'].map(id);
    host.spells = () => known.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0 }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
    ];
    (host as unknown as { monsterTable: () => Promise<Row[]> }).monsterTable = async () => JSON.parse(EOL) as Row[];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });

  it('<DEFAULT> (Auto) with V vulns and bolts a Drudge Skulker with lightning, not Force Bolt and a pierce vuln', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['V', 'A'];
    const profile: RoutineProfile = {
      name: 'VT', modules: { ...ALL_MODULES_OFF, combat: true }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [],
      macro: true, ruleFiring: 'once', settings: { EnableBuffing: false, AttackDistance: 30 }, vtank: data,
    } as RoutineProfile;
    // The server answers each cast ("You cast X on Y"): a debuff counts as landed only then (castReply.ts).
    const send = host.cast;
    host.cast = (sid, t) => { const r = send(sid, t); const sp = table.spells.get(sid); if (sp && t !== null) api.pushChat(`You cast ${sp.name} on ${host.objs.get(t)?.name ?? '?'}`, 7); return r; };
    api.routine.start(profile);
    for (let t = 0; t < 3000; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts).toContain(`cast ${id('Lightning Vulnerability Other I')} 80005001`);
    expect(casts).toContain(`cast ${id('Lightning Bolt I')} 80005001`);
    expect(casts.some((x) => x.startsWith(`cast ${id('Force Bolt I')} `) || x.startsWith(`cast ${id('Piercing Vulnerability Other I')} `))).toBe(false);
  });
});
